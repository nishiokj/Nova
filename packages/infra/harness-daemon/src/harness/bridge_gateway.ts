/**
 * BridgeGateway - Routes bridge commands from the bus to the harness.
 */

import path from 'path';
import { type BusServer, BRIDGE_COMMAND_CHANNEL, runChannel, sessionChannel } from 'comms-bus';
import { profiler } from 'shared';
import type { BridgeCommand } from 'harness-client';
import type { AgentRunHandle, AgentRunResult, BridgeEvent } from './types.js';
import { createErrorEvent } from './event_translator.js';
import type { FullHarnessConfig } from './config.js';
import {
  loadHookDefinitions,
  loadSkillDefinitions,
  getSkillDefinition,
  getHookDefinition,
  createSkill,
  createHook,
  updateSkill,
  updateHook,
  deleteSkill,
  deleteHook,
  setSkillEnabled,
  setHookEnabled,
  type SkillInput,
  type HookInput,
} from './skills_loader.js';
import type { AuthService } from './auth_service.js';
import { LocalProviderManager } from './local_providers.js';
import { getAllModels, isOpenAICompatProvider, toGatewayModel } from 'types';
import { type UnifiedHookRegistry } from 'orchestrator';
import type { AgentType } from 'agent';
import type { PermissionChecker } from './permissions.js';
import { deleteSession, getTokenUsage, listSessions } from './session_queries.js';

const GATEWAY_PROVIDER_ID = 'vercel-gateway';
const GATEWAY_MODEL_PROVIDERS = new Set<string>([
  'anthropic',
  'openai',
  'cerebras',
  'groq',
  'gemini',
  'z.ai-coder',
  'claude',
]);

type PersistedModelSelection = {
  provider: string;
  model: string;
  reasoning?: string;
};

interface HarnessLike {
  run(params: {
    requestId: string;
    inputText: string;
    tier?: AgentType;
    sessionKey: string;
    workingDir: string;
    context?: string;
    hookRegistry?: UnifiedHookRegistry;
  }): AgentRunHandle;
  createReadyEvent(sessionKey: string): BridgeEvent;
  getConfig(): FullHarnessConfig;
  isShuttingDown(): boolean;
  shutdown(): Promise<void>;
  updateApiKey?(provider: string, apiKey: string): void;
  resetCircuitBreaker?(): void;
  hasApiKey(provider: string): boolean;
  setSessionSelectedModel?(sessionKey: string, agentType: string, selectedModel: import('agent').ModelSelection | null): void;
  getSessionSelectedModel?(sessionKey: string, agentType: string): import('agent').ModelSelection | null;
  getAllSessionSelectedModels?(sessionKey: string): Map<string, import('agent').ModelSelection>;
  clearAllSessionSelectedModels?(sessionKey: string): void;
  getSessionHistory?(sessionKey: string): Array<{ role: 'user' | 'agent' | 'system'; content: string; timestamp: number; requestId?: string }>;
  getAsyncModeStatus?(): { ok: boolean; issues: string[] };
  ensureSessionHydrated?(sessionKey: string, options?: { workingDir?: string; dangerousMode?: boolean; includeUserPreferences?: boolean }): {
    getPermissionState?: () => unknown;
    updatePermissionOptions?: (input: {
      dangerousMode?: boolean;
      allowOutsideRoot?: boolean;
      webSearchEnabled?: boolean;
      writesNoDeletes?: boolean;
      reloadPersistentConfig?: boolean;
    }) => unknown;
  } | void;
  getGraphD?(): import('graphd').GraphDManager | null;
  closeSession?(sessionKey: string): { success: boolean; error?: string; executingRequestId?: string };
  forkSession?(sourceSessionKey: string, targetSessionKey: string): { success: boolean; error?: string };
  compactContext?(sessionKey: string): { success: boolean; itemsRemoved: number; bytesRecovered: number; error?: string };
  getSessionPermissionChecker?(sessionKey: string): PermissionChecker | null;  // Per-session permission checker
  getDebugMemoryInfo?(): {
    sessionCount: number;
    maxSessions: number;
    sessions: Array<{
      sessionKey: string;
      contextItemCount: number;
      contextEstimatedTokens: number;
      workItemsCreatedCount: number;
      lastAccessMs: number;
      isExecuting: boolean;
    }>;
  };
  setSessionAsyncModeEnabled?(sessionKey: string, enabled: boolean): void;
  // Session-level exclusive operation management (prevents concurrent ops from multiple connections)
  startSessionAsyncRun?(sessionKey: string, info: { requestId: string; goal: string; cancelled: boolean; startedAt: number }): boolean;
  getSessionAsyncRun?(sessionKey: string): { requestId: string; goal: string; cancelled: boolean; startedAt: number } | null;
  cancelSessionAsyncRun?(sessionKey: string): void;
  clearSessionAsyncRun?(sessionKey: string): void;
  controlSessionExecution?(params: {
    sessionKey: string;
    action: 'pause' | 'resume' | 'cancel';
    reason?: string;
    requestedBy?: 'user' | 'system' | 'policy';
    scope?: 'run' | 'work_item' | 'tool';
    targetWorkIds?: string[];
    timeoutMs?: number;
  }): Promise<{ success: boolean; requestId?: string; quiesced?: boolean; error?: string }>;
}

interface AsyncRunInfo {
  requestId: string;
  goal: string;
  cancelled: boolean;
  startedAt: number;
}

interface ConnectionState {
  sessionKey: string | null;
  /** Tracks sessionKey even after session_close nulls it, for disconnect cleanup */
  lastSessionKey: string | null;
  workingDir: string | null;
  activeRequestId: string | null;
  asyncRun: AsyncRunInfo | null;
}

type CommandData = Record<string, unknown> | undefined;

interface CommandContext {
  connectionId: string;
  state: ConnectionState;
}

type CommandHandler = (data: CommandData, context: CommandContext) => void | Promise<void>;

interface CommandSpec {
  validate: (data: CommandData) => boolean;
  handle: CommandHandler;
}

const acceptAnyCommandData = (_data: CommandData): boolean => true;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class BridgeGateway {
  private readonly bus: BusServer;
  private readonly harness: HarnessLike;
  private readonly workingDir: string;
  private readonly authService: AuthService | null;
  private readonly localProviders: LocalProviderManager | null;
  private skillsDir: string;
  private hooksDir: string;
  private connections = new Map<string, ConnectionState>();
  // Track session ownership: sessionKey -> connectionId (enforces single client per session)
  private sessionOwners = new Map<string, string>();
  private readonly commandRegistry = this.createCommandRegistry();

  constructor(bus: BusServer, harness: HarnessLike, workingDir: string, authService?: AuthService | null) {
    this.bus = bus;
    this.harness = harness;
    this.workingDir = workingDir;
    this.authService = authService ?? null;

    const config = harness.getConfig();
    this.skillsDir = config.skills.directory
      ? path.resolve(this.workingDir, config.skills.directory)
      : path.resolve(this.workingDir, 'config/skills');
    this.hooksDir = config.hooks.directory
      ? path.resolve(this.workingDir, config.hooks.directory)
      : path.resolve(this.workingDir, 'config/hooks');

    // Initialize local provider manager using GraphD for storage
    if (config.graphd.enabled && config.graphd.dbPath) {
      this.localProviders = new LocalProviderManager(config.graphd.dbPath);
    } else {
      this.localProviders = null;
    }
  }

  handleDisconnect(connectionId: string): void {
    const state = this.connections.get(connectionId);
    if (state) {
      state.asyncRun = null;
    }
    // Use lastSessionKey as fallback - session_close may have nulled sessionKey but we still need cleanup
    const sessionKeyToClose = state?.sessionKey ?? state?.lastSessionKey;
    if (sessionKeyToClose) {
      // Release session ownership
      if (this.sessionOwners.get(sessionKeyToClose) === connectionId) {
        this.sessionOwners.delete(sessionKeyToClose);
      }
      // closeSession handles persist + marking inactive
      this.harness.closeSession?.(sessionKeyToClose);
    }
    this.connections.delete(connectionId);
  }

  async handlePublish(
    connectionId: string,
    channel: string,
    payload: unknown
  ): Promise<void> {
    if (channel !== BRIDGE_COMMAND_CHANNEL) {
      return;
    }

    const command = this.parseBridgeCommand(payload);
    if (!command) {
      this.sendError(connectionId, 'Invalid bridge command payload');
      return;
    }

    const state = this.getOrCreateConnectionState(connectionId);

    profiler.begin(`cmd:${command.type}`, 'bridge');
    try {
      const spec = this.commandRegistry.get(command.type);
      if (!spec) {
        this.sendError(connectionId, `Unknown command type: ${command.type}`);
        return;
      }
      if (!spec.validate(command.data)) {
        this.sendError(connectionId, `Invalid payload for command: ${command.type}`);
        return;
      }
      await spec.handle(command.data, { connectionId, state });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendEvent(connectionId, createErrorEvent(message, false));
    } finally {
      profiler.end(`cmd:${command.type}`, 'bridge');
    }
  }

  private parseBridgeCommand(
    payload: unknown
  ): (BridgeCommand | { type: string; data?: Record<string, unknown> }) | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    const candidate = payload as { type?: unknown; data?: unknown };
    if (typeof candidate.type !== 'string') {
      return null;
    }
    const data = isRecord(candidate.data) ? candidate.data : undefined;
    return { type: candidate.type, data };
  }

  private createCommandRegistry(): Map<string, CommandSpec> {
    const registry = new Map<string, CommandSpec>();
    const register = (type: string, handle: CommandHandler, validate: (data: CommandData) => boolean = acceptAnyCommandData) => {
      registry.set(type, { validate, handle });
    };

    register('init', (data, ctx) => this.handleInit(ctx.connectionId, data, ctx.state));
    register('send_text', (data, ctx) => this.handleSendText(ctx.connectionId, data, ctx.state));
    register('send_media', (data, ctx) => this.handleSendText(ctx.connectionId, data, ctx.state));
    register('user_prompt_response', (data, ctx) => this.handleUserPromptResponse(ctx.connectionId, data, ctx.state));
    register('get_config', (_data, ctx) => this.handleGetConfig(ctx.connectionId, ctx.state));
    register('get_status', (_data, ctx) => this.handleGetStatus(ctx.connectionId));
    register('get_models', (_data, ctx) => this.handleGetModels(ctx.connectionId));
    register('models_delete', (data, ctx) => this.handleModelsDelete(ctx.connectionId, data, ctx.state));
    register('skills_list', (_data, ctx) => this.handleSkillsList(ctx.connectionId));
    register('skills_get', (data, ctx) => this.handleSkillsGet(ctx.connectionId, data));
    register('skills_create', (data, ctx) => this.handleSkillsCreate(ctx.connectionId, data));
    register('skills_update', (data, ctx) => this.handleSkillsUpdate(ctx.connectionId, data));
    register('skills_delete', (data, ctx) => this.handleSkillsDelete(ctx.connectionId, data));
    register('skills_enable', (data, ctx) => this.handleSkillsEnable(ctx.connectionId, data, true));
    register('skills_disable', (data, ctx) => this.handleSkillsEnable(ctx.connectionId, data, false));
    register('skills_run', (_data, ctx) => this.handleDeferredResponse(ctx.connectionId, 'skills_run'));
    register('voice_start', (_data, ctx) => this.handleVoiceUnsupported(ctx.connectionId));
    register('voice_stop', (_data, ctx) => this.handleVoiceUnsupported(ctx.connectionId));
    register('hooks_list', (_data, ctx) => this.handleHooksList(ctx.connectionId));
    register('hooks_get', (data, ctx) => this.handleHooksGet(ctx.connectionId, data));
    register('hooks_create', (data, ctx) => this.handleHooksCreate(ctx.connectionId, data));
    register('hooks_update', (data, ctx) => this.handleHooksUpdate(ctx.connectionId, data));
    register('hooks_delete', (data, ctx) => this.handleHooksDelete(ctx.connectionId, data));
    register('hooks_enable', (data, ctx) => this.handleHooksEnable(ctx.connectionId, data, true));
    register('hooks_disable', (data, ctx) => this.handleHooksEnable(ctx.connectionId, data, false));
    register('auth_start', (data, ctx) => this.handleAuthStart(ctx.connectionId, data));
    register('auth_poll', (data, ctx) => this.handleAuthPoll(ctx.connectionId, data));
    register('auth_verify', (data, ctx) => this.handleAuthVerify(ctx.connectionId, data));
    register('auth_logout', (data, ctx) => this.handleAuthLogout(ctx.connectionId, data));
    register('providers_list', (data, ctx) => this.handleProvidersList(ctx.connectionId, data));
    register('providers_save', (data, ctx) => this.handleProvidersSave(ctx.connectionId, data));
    register('providers_delete', (data, ctx) => this.handleProvidersDelete(ctx.connectionId, data));
    register('providers_test', async (data, ctx) => {
      await this.handleProvidersTest(ctx.connectionId, data);
    });
    register('session_fork', (_data, ctx) => this.handleSessionFork(ctx.connectionId, ctx.state));
    register('session_close', (_data, ctx) => this.handleSessionClose(ctx.connectionId, ctx.state));
    register('list_sessions', (data, ctx) => this.handleListSessions(ctx.connectionId, data, ctx.state));
    register('session_delete', (data, ctx) => this.handleSessionDelete(ctx.connectionId, data));
    register('usage_summary', (data, ctx) => this.handleUsageSummary(ctx.connectionId, data));
    register('compact_context', (_data, ctx) => this.handleCompactContext(ctx.connectionId, ctx.state));
    register('set_model', (data, ctx) => this.handleSetModel(ctx.connectionId, data, ctx.state));
    register('get_model', (data, ctx) => this.handleGetModel(ctx.connectionId, data, ctx.state));
    register('permission_response', (data, ctx) => this.handlePermissionResponse(ctx.connectionId, data));
    register('set_dangerous_mode', (data, ctx) => this.handleSetDangerousMode(ctx.connectionId, data));
    register('async_start', async (data, ctx) => {
      await this.handleAsyncStart(ctx.connectionId, data, ctx.state);
    });
    register('async_cancel', (data, ctx) => this.handleAsyncCancel(ctx.connectionId, data, ctx.state));
    register('async_status', (data, ctx) => this.handleAsyncStatus(ctx.connectionId, data, ctx.state));
    register('control_plane_dispatch', (data, ctx) => this.handleControlPlaneDispatch(ctx.connectionId, data));
    register('control_plane_stop', (data, ctx) => this.handleControlPlaneStop(ctx.connectionId, data));
    register('control_plane_fork', (data, ctx) => this.handleControlPlaneFork(ctx.connectionId, data));
    register('control_plane_permissions_get', (data, ctx) => this.handleControlPlanePermissionsGet(ctx.connectionId, data));
    register('control_plane_permissions_update', (data, ctx) => this.handleControlPlanePermissionsUpdate(ctx.connectionId, data));
    register('control_plane_memory_info', (_data, ctx) => this.handleControlPlaneMemoryInfo(ctx.connectionId));
    register('control_plane_model_get', (data, ctx) => this.handleControlPlaneModelGet(ctx.connectionId, data));
    register('control_plane_model_set', (data, ctx) => this.handleControlPlaneModelSet(ctx.connectionId, data));
    register('shutdown', (_data, ctx) => this.sendError(ctx.connectionId, 'Shutdown is not supported via bridge'));

    return registry;
  }

  private handleVoiceUnsupported(connectionId: string): void {
    this.sendEvent(connectionId, {
      type: 'error',
      data: { message: 'Voice is not yet supported in TypeScript mode', fatal: false },
    });
  }

  private handleInit(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): void {
    const requestedSessionKey = data?.session_key;
    const sessionKey =
      typeof requestedSessionKey === 'string' && requestedSessionKey.length > 0
        ? requestedSessionKey
        : generateSessionKey();

    // Enforce single client per session - reject if session is owned by another connection
    const existingOwner = this.sessionOwners.get(sessionKey);
    if (existingOwner && existingOwner !== connectionId) {
      this.sendError(connectionId, `Session "${sessionKey}" is already in use by another client. Use a different session key or wait for the other client to disconnect.`);
      return;
    }

    // CRITICAL: Mark old session as inactive BEFORE switching to new one
    // This fixes the bug where switched-from sessions stay "active" forever
    const graphd = this.harness.getGraphD?.();
    if (state.sessionKey && state.sessionKey !== sessionKey) {
      // Release ownership of old session
      if (this.sessionOwners.get(state.sessionKey) === connectionId) {
        this.sessionOwners.delete(state.sessionKey);
      }
      if (graphd) {
        graphd.sessionUpdateStatus(state.sessionKey, 'inactive');
      }
      this.harness.closeSession?.(state.sessionKey);
    }

    // Take ownership of the new session
    this.sessionOwners.set(sessionKey, connectionId);

    state.sessionKey = sessionKey;
    state.lastSessionKey = sessionKey;  // Track for disconnect cleanup

    // Store working directory from client (where TUI was launched)
    const requestedWorkingDir = data?.working_dir;
    state.workingDir =
      typeof requestedWorkingDir === 'string' && requestedWorkingDir.length > 0
        ? requestedWorkingDir
        : this.workingDir; // fallback to daemon's working dir

    // Touch session to update last_accessed_at (reactivates inactive sessions)
    // Also sets status to 'active' for the new session
    if (graphd) {
      graphd.sessionTouch(sessionKey, state.workingDir);
      graphd.sessionUpdateStatus(sessionKey, 'active');
    }

    this.harness.ensureSessionHydrated?.(sessionKey, {
      workingDir: state.workingDir ?? this.workingDir,
      includeUserPreferences: true,
    });

    const readyEvent = this.harness.createReadyEvent(sessionKey);
    this.sendEvent(connectionId, readyEvent, sessionChannel(sessionKey));

    // Load and emit per-agent-type model selections from session state.
    // This should work regardless of GraphD availability so TUI does not reset
    // to null selections on reconnect when the daemon is running without GraphD.
    const selections = this.harness.getAllSessionSelectedModels?.(sessionKey) ?? new Map();
    const selectionsObject: Record<string, { provider?: string; model?: string; reasoning?: string }> = {};
    for (const [type, selection] of selections) {
      selectionsObject[type] = selection;
    }
    this.sendAuthResponse(connectionId, 'get_model', {
      success: true,
      model_selections: selectionsObject,
    });

    // Emit model_changed for standard tabs + any additional persisted agent types.
    const agentTypes = new Set<string>(['standard', 'explorer', 'coding', ...selections.keys()]);
    for (const agentType of agentTypes) {
      const selection = selections.get(agentType) ?? null;
      this.sendEvent(connectionId, {
        type: 'model_changed',
        data: {
          agentType,
          selectedModel: selection?.model ?? null,
          selectedProvider: selection?.provider ?? null,
          provider: selection?.provider ?? null,
          model: selection?.model ?? null,
          reasoning: selection?.reasoning ?? null,
        },
      }, sessionChannel(sessionKey));
    }
  }

  private async handleSendText(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): Promise<void> {
    profiler.begin('handleSendText', 'handler');
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendError(connectionId, 'Session not initialized. Call init first.');
      profiler.end('handleSendText', 'handler');
      return;
    }

    // Per-request working_dir takes precedence over init-time state, which takes precedence over daemon default
    const requestWorkingDir = typeof data?.working_dir === 'string' && data.working_dir.length > 0
      ? data.working_dir
      : null;
    const workingDir = requestWorkingDir ?? state.workingDir ?? this.workingDir;

    this.harness.ensureSessionHydrated?.(sessionKey, {
      workingDir,
      includeUserPreferences: true,
    });

    // Check 'standard' agent type selection - this is the main/default that must be set
    let activeSelection = this.harness.getSessionSelectedModel?.(sessionKey, 'standard');
    if (!activeSelection?.model || !activeSelection?.provider) {
      activeSelection = this.harness.getSessionSelectedModel?.(sessionKey, 'standard');
      if (!activeSelection?.model || !activeSelection?.provider) {
        this.sendError(connectionId, 'No model selected. Use /models to choose one before sending a message.');
        return;
      }
    }
    if (!this.harness.hasApiKey(activeSelection.provider)) {
      this.sendEvent(connectionId, {
        type: 'provider_key_required',
        data: {
          provider: activeSelection.provider,
          model: activeSelection.model,
          reasoning: activeSelection.reasoning,
        },
      });
      this.sendError(connectionId, `No API key configured for provider: ${activeSelection.provider}`);
      return;
    }

    let text = String(data?.text ?? '');
    if (!text.trim()) {
      this.sendError(connectionId, 'Empty message');
      return;
    }

    const commandMatch = text.trim().match(/^\/?(fork|stop|pause|resume)\b(?:\s+(.+))?$/i);
    if (commandMatch) {
      const action = commandMatch[1].toLowerCase();
      const commandArg = typeof commandMatch[2] === 'string' ? commandMatch[2].trim() : '';

      if (action === 'fork') {
        if (!this.harness.forkSession) {
          this.sendAuthResponse(connectionId, 'session_fork', {
            success: false,
            error: 'Fork not supported by harness',
          });
          return;
        }
        const explicitTarget = commandArg
          ? (commandArg.startsWith('target=') ? commandArg.slice('target='.length).trim() : commandArg.split(/\s+/, 1)[0])
          : '';
        const newSessionKey = explicitTarget || generateSessionKey();
        const result = this.harness.forkSession(sessionKey, newSessionKey);
        this.sendAuthResponse(connectionId, 'session_fork', {
          success: result.success,
          sourceSessionKey: sessionKey,
          newSessionKey: result.success ? newSessionKey : undefined,
          error: result.error,
        });
        return;
      }

      if (!this.harness.controlSessionExecution) {
        this.sendError(connectionId, 'Runtime control is not supported by this harness');
        return;
      }

      if (action === 'stop') {
        const result = await this.harness.controlSessionExecution({
          sessionKey,
          action: 'cancel',
          reason: commandArg || 'Stop requested from bridge command',
          requestedBy: 'user',
          timeoutMs: 30_000,
        }).catch((error) => {
          this.sendAuthResponse(connectionId, 'control_plane_stop', {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
        if (result) {
          this.sendAuthResponse(connectionId, 'control_plane_stop', result);
        }
        return;
      }

      if (action === 'pause') {
        const result = await this.harness.controlSessionExecution({
          sessionKey,
          action: 'pause',
          reason: commandArg || 'Pause requested from bridge command',
          requestedBy: 'user',
          timeoutMs: 30_000,
        }).catch((error) => {
          this.sendAuthResponse(connectionId, 'control_plane_stop', {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
        if (result) {
          this.sendAuthResponse(connectionId, 'control_plane_stop', result);
        }
        return;
      }

      if (action === 'resume') {
        const result = await this.harness.controlSessionExecution({
          sessionKey,
          action: 'resume',
          reason: commandArg || 'Resume requested from bridge command',
          requestedBy: 'user',
        }).catch((error) => {
          this.sendAuthResponse(connectionId, 'control_plane_stop', {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
        if (result) {
          this.sendAuthResponse(connectionId, 'control_plane_stop', result);
        }
        return;
      }
    }

    // Set goal from first user message (no-op if goal already set)
    const graphd = this.harness.getGraphD?.();
    if (graphd) {
      const goalPreview = text.trim().slice(0, 500);
      graphd.sessionSetGoalIfEmpty(sessionKey, goalPreview);
    }

    const candidateRequestId =
      typeof data?.client_request_id === 'string' ? data.client_request_id : '';
    const clientRequestId = candidateRequestId.length > 0
      ? candidateRequestId
      : generateRequestId();
    const rawTier = typeof data?.tier === 'string' ? data.tier.trim() : '';
    const tier = rawTier && rawTier !== 'auto' ? (rawTier as AgentType) : undefined;

    state.activeRequestId = clientRequestId;

    profiler.instant('harness.run:start', 'harness', 'p', { requestId: clientRequestId, tier });
    const handle = this.harness.run({
      requestId: clientRequestId,
      inputText: text,
      ...(tier ? { tier } : {}),
      sessionKey,
      workingDir,
    });

    this.streamRunEvents(clientRequestId, handle, undefined, sessionKey);
    profiler.end('handleSendText', 'handler');
  }

  private handleUserPromptResponse(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendError(connectionId, 'Session not initialized.');
      return;
    }

    // Per-request working_dir takes precedence (same pattern as handleSendText)
    const requestWorkingDir = typeof data?.working_dir === 'string' && data.working_dir.length > 0
      ? data.working_dir
      : null;
    const workingDir = requestWorkingDir ?? state.workingDir ?? this.workingDir;

    const requestId = String(data?.request_id ?? state.activeRequestId ?? '');
    const answer = data?.answer ?? data?.response;
    if (!requestId) {
      this.sendError(connectionId, 'Missing request_id');
      return;
    }
    if (answer === undefined || answer === null || answer === '') {
      this.sendError(connectionId, 'Empty answer');
      return;
    }

    // Convert answer to string - run() will detect paused state and treat it as a resume
    const answerText = typeof answer === 'string' ? answer : JSON.stringify(answer);
    const handle = this.harness.run({
      requestId,
      inputText: answerText,
      sessionKey,
      workingDir,
    });
    this.streamRunEvents(requestId, handle, undefined, sessionKey);
  }

  private handleGetConfig(connectionId: string, state: ConnectionState): void {
    const config = this.harness.getConfig();
    const defaultAgent = config.agents[config.defaultAgent];

    this.sendEvent(connectionId, {
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: {
          kind: 'config',
          payload: {
            llm_provider: defaultAgent?.llm.provider ?? 'unknown',
            model: defaultAgent?.llm.model ?? 'unknown',
            default_agent: config.defaultAgent,
            agent_count: Object.keys(config.agents).length,
            graphd_enabled: config.graphd.enabled,
            skills_enabled: config.skills.enabled,
            hooks_enabled: config.hooks.enabled,
          },
        },
      },
    }, state.sessionKey ? sessionChannel(state.sessionKey) : 'direct');
  }

  private handleGetStatus(connectionId: string): void {
    this.sendEvent(connectionId, {
      type: 'status',
      data: {
        state: this.harness.isShuttingDown() ? 'error' : 'idle',
        message: 'Ready',
      },
    });
  }

  private handleGetModels(connectionId: string): void {
    const config = this.harness.getConfig();
    const graphd = this.harness.getGraphD?.();

    // Get hidden models from user preferences
    const hiddenModels = graphd?.getUserPreference<string[]>('user_prefs:hidden_models') ?? [];
    const hiddenModelSet = new Set(hiddenModels);
    const accessCache = new Map<string, boolean>();
    const hasAccess = (provider: string) => {
      if (!accessCache.has(provider)) {
        accessCache.set(provider, this.harness.hasApiKey(provider));
      }
      return accessCache.get(provider) ?? false;
    };

    const baseModels = getAllModels()
      .filter((model) => !hiddenModelSet.has(model.id))
      .map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        reasoning: model.reasoning,
      }));

    const models = [...baseModels];
    const availableModels = baseModels.filter((model) => hasAccess(model.provider));

    // If Vercel Gateway is configured, surface gateway variants for supported providers
    if (hasAccess(GATEWAY_PROVIDER_ID)) {
      const seen = new Set(models.map((model) => `${model.provider ?? ''}:${model.id}`));
      const availableSeen = new Set(availableModels.map((model) => `${model.provider ?? ''}:${model.id}`));
      for (const model of baseModels) {
        if (!GATEWAY_MODEL_PROVIDERS.has(model.provider)) continue;

        let gatewayId: string;
        try {
          gatewayId = toGatewayModel(model.id, model.provider);
        } catch {
          continue;
        }

        if (hiddenModelSet.has(gatewayId)) continue;

        const key = `${GATEWAY_PROVIDER_ID}:${gatewayId}`;
        if (!seen.has(key)) {
          models.push({
            id: gatewayId,
            name: `${model.name} (${model.provider})`,
            provider: GATEWAY_PROVIDER_ID,
            reasoning: model.reasoning,
          });
          seen.add(key);
        }
        if (!availableSeen.has(key)) {
          availableModels.push({
            id: gatewayId,
            name: `${model.name} (${model.provider})`,
            provider: GATEWAY_PROVIDER_ID,
            reasoning: model.reasoning,
          });
          availableSeen.add(key);
        }
      }
    }

    this.sendEvent(connectionId, {
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: {
          kind: 'models',
          // Only surface models that are currently accessible/configured.
          // Keeps /models UI and Esc+M cycling aligned with configured providers.
          payload: availableModels,
          available: availableModels,
          default: config.models.default,
        },
      },
    });
  }

  private handleModelsDelete(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): void {
    // TUI sends 'model' (model ID), accept both 'model' and 'model_id' for flexibility
    const modelId = typeof data?.model === 'string' ? data.model : (typeof data?.model_id === 'string' ? data.model_id : '');
    if (!modelId) {
      this.sendAuthResponse(connectionId, 'models_delete', {
        success: false,
        error: 'Missing model',
      });
      return;
    }

    const graphd = this.harness.getGraphD?.();
    if (!graphd) {
      this.sendAuthResponse(connectionId, 'models_delete', {
        success: false,
        error: 'GraphD not available',
      });
      return;
    }

    // Get current hidden models and add the new one
    const hiddenModels = graphd.getUserPreference<string[]>('user_prefs:hidden_models') ?? [];
    if (!hiddenModels.includes(modelId)) {
      hiddenModels.push(modelId);
      graphd.setUserPreference('user_prefs:hidden_models', hiddenModels);
    }

    const sessionKey = state.sessionKey;
    const normalizedModelId = modelId.trim().toLowerCase();
    const clearedAgentTypes: string[] = [];

    // Clear from model_selections user preference if any agent type matches
    const modelSelections = graphd.getUserPreference<Record<string, { provider?: string; model?: string; reasoning?: string }>>('user_prefs:model_selections') ?? {};
    let modelSelectionsUpdated = false;
    for (const [agentType, selection] of Object.entries(modelSelections)) {
      if (selection?.model && selection.model.trim().toLowerCase() === normalizedModelId) {
        delete modelSelections[agentType];
        modelSelectionsUpdated = true;
      }
    }
    if (modelSelectionsUpdated) {
      if (Object.keys(modelSelections).length === 0) {
        graphd.deleteUserPreference('user_prefs:model_selections');
      } else {
        graphd.setUserPreference('user_prefs:model_selections', modelSelections);
      }
    }

    // Clear session selections if they match the deleted model
    if (sessionKey) {
      const inMemorySelections = this.harness.getAllSessionSelectedModels?.(sessionKey) ?? new Map();
      for (const [agentType, selection] of inMemorySelections) {
        const selectionModel = typeof selection?.model === 'string' ? selection.model.trim().toLowerCase() : '';
        if (selectionModel === normalizedModelId && !clearedAgentTypes.includes(agentType)) {
          clearedAgentTypes.push(agentType);
        }
      }

      const session = graphd.sessionGet(sessionKey);
      const metadata = session?.metadata as Record<string, unknown> | undefined;
      const sessionSelections = (metadata?.model_selections as Record<string, { provider?: string; model?: string; reasoning?: string }>) ?? {};
      let sessionSelectionsUpdated = false;
      for (const [agentType, selection] of Object.entries(sessionSelections)) {
        if (selection?.model && selection.model.trim().toLowerCase() === normalizedModelId) {
          delete sessionSelections[agentType];
          sessionSelectionsUpdated = true;
          clearedAgentTypes.push(agentType);
        }
      }
      if (sessionSelectionsUpdated) {
        graphd.sessionUpdateMetadata(sessionKey, { model_selections: sessionSelections });
      }

      for (const clearedAgentType of clearedAgentTypes) {
        this.harness.setSessionSelectedModel?.(sessionKey, clearedAgentType, null);
      }
    }

    // Emit model_changed event for each cleared agent type
    for (const agentType of clearedAgentTypes) {
      this.sendEvent(connectionId, {
        type: 'model_changed',
        data: {
          agentType,
          selectedModel: null,
          selectedProvider: null,
          provider: null,
          model: null,
          reasoning: null,
        },
      });
    }

    this.sendAuthResponse(connectionId, 'models_delete', {
      success: true,
      model: modelId,
      clearedAgentTypes,
    });
  }

  private handleSkillsList(connectionId: string): void {
    try {
      const skills = loadSkillDefinitions(this.skillsDir);
      this.sendEvent(connectionId, {
        type: 'response',
        data: {
          success: true,
          content: '',
          metadata: { kind: 'skills', payload: { action: 'list', items: skills, errors: [] } },
        },
      });
    } catch (error) {
      this.sendEvent(connectionId, {
        type: 'response',
        data: {
          success: true,
          content: '',
          metadata: { kind: 'skills', payload: { action: 'list', items: [], errors: [String(error)] } },
        },
      });
    }
  }

  private handleHooksList(connectionId: string): void {
    try {
      const hooks = loadHookDefinitions(this.hooksDir);
      this.sendEvent(connectionId, {
        type: 'response',
        data: {
          success: true,
          content: '',
          metadata: { kind: 'hooks', payload: { action: 'list', items: hooks, errors: [] } },
        },
      });
    } catch (error) {
      this.sendEvent(connectionId, {
        type: 'response',
        data: {
          success: true,
          content: '',
          metadata: { kind: 'hooks', payload: { action: 'list', items: [], errors: [String(error)] } },
        },
      });
    }
  }

  // =========================================================================
  // Skills CRUD Handlers
  // =========================================================================

  private handleSkillsGet(connectionId: string, data: Record<string, unknown> | undefined): void {
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      this.sendSkillsResponse(connectionId, 'get', { success: false, error: 'Missing skill id' });
      return;
    }

    const skill = getSkillDefinition(this.skillsDir, id);
    if (!skill) {
      this.sendSkillsResponse(connectionId, 'get', { success: false, error: `Skill '${id}' not found` });
      return;
    }

    this.sendSkillsResponse(connectionId, 'get', { success: true, skill });
  }

  private handleSkillsCreate(connectionId: string, data: Record<string, unknown> | undefined): void {
    const skill = data?.skill as SkillInput | undefined;
    if (!skill?.name || !skill?.instructions) {
      this.sendSkillsResponse(connectionId, 'create', { success: false, error: 'Missing required fields: name, instructions' });
      return;
    }

    const result = createSkill(this.skillsDir, skill);
    this.sendSkillsResponse(connectionId, 'create', result);
  }

  private handleSkillsUpdate(connectionId: string, data: Record<string, unknown> | undefined): void {
    const id = typeof data?.id === 'string' ? data.id : '';
    const updates = data?.updates as Partial<SkillInput> | undefined;

    if (!id) {
      this.sendSkillsResponse(connectionId, 'update', { success: false, error: 'Missing skill id' });
      return;
    }

    const result = updateSkill(this.skillsDir, id, updates ?? {});
    this.sendSkillsResponse(connectionId, 'update', result);
  }

  private handleSkillsDelete(connectionId: string, data: Record<string, unknown> | undefined): void {
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      this.sendSkillsResponse(connectionId, 'delete', { success: false, error: 'Missing skill id' });
      return;
    }

    const result = deleteSkill(this.skillsDir, id);
    this.sendSkillsResponse(connectionId, 'delete', result);
  }

  private handleSkillsEnable(connectionId: string, data: Record<string, unknown> | undefined, enabled: boolean): void {
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      this.sendSkillsResponse(connectionId, enabled ? 'enable' : 'disable', { success: false, error: 'Missing skill id' });
      return;
    }

    const result = setSkillEnabled(this.skillsDir, id, enabled);
    this.sendSkillsResponse(connectionId, enabled ? 'enable' : 'disable', result);
  }

  private sendSkillsResponse(connectionId: string, action: string, payload: Record<string, unknown>): void {
    this.sendEvent(connectionId, {
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: { kind: 'skills', payload: { action, ...payload } },
      },
    });
  }

  // =========================================================================
  // Hooks CRUD Handlers
  // =========================================================================

  private handleHooksGet(connectionId: string, data: Record<string, unknown> | undefined): void {
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      this.sendHooksResponse(connectionId, 'get', { success: false, error: 'Missing hook id' });
      return;
    }

    const hook = getHookDefinition(this.hooksDir, id);
    if (!hook) {
      this.sendHooksResponse(connectionId, 'get', { success: false, error: `Hook '${id}' not found` });
      return;
    }

    this.sendHooksResponse(connectionId, 'get', { success: true, hook });
  }

  private handleHooksCreate(connectionId: string, data: Record<string, unknown> | undefined): void {
    const hook = data?.hook as HookInput | undefined;
    if (!hook?.name || !hook?.trigger || !hook?.hooks) {
      this.sendHooksResponse(connectionId, 'create', { success: false, error: 'Missing required fields: name, trigger, hooks' });
      return;
    }

    const result = createHook(this.hooksDir, hook);
    this.sendHooksResponse(connectionId, 'create', result);
  }

  private handleHooksUpdate(connectionId: string, data: Record<string, unknown> | undefined): void {
    const id = typeof data?.id === 'string' ? data.id : '';
    const updates = data?.updates as Partial<HookInput> | undefined;

    if (!id) {
      this.sendHooksResponse(connectionId, 'update', { success: false, error: 'Missing hook id' });
      return;
    }

    const result = updateHook(this.hooksDir, id, updates ?? {});
    this.sendHooksResponse(connectionId, 'update', result);
  }

  private handleHooksDelete(connectionId: string, data: Record<string, unknown> | undefined): void {
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      this.sendHooksResponse(connectionId, 'delete', { success: false, error: 'Missing hook id' });
      return;
    }

    const result = deleteHook(this.hooksDir, id);
    this.sendHooksResponse(connectionId, 'delete', result);
  }

  private handleHooksEnable(connectionId: string, data: Record<string, unknown> | undefined, enabled: boolean): void {
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      this.sendHooksResponse(connectionId, enabled ? 'enable' : 'disable', { success: false, error: 'Missing hook id' });
      return;
    }

    const result = setHookEnabled(this.hooksDir, id, enabled);
    this.sendHooksResponse(connectionId, enabled ? 'enable' : 'disable', result);
  }

  private sendHooksResponse(connectionId: string, action: string, payload: Record<string, unknown>): void {
    this.sendEvent(connectionId, {
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: { kind: 'hooks', payload: { action, ...payload } },
      },
    });
  }

  private handleDeferredResponse(connectionId: string, commandType: string): void {
    this.sendEvent(connectionId, {
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: { kind: commandType, payload: null },
      },
    });
  }

  // =========================================================================
  // Auth Handlers
  // =========================================================================

  private handleAuthStart(connectionId: string, data: Record<string, unknown> | undefined): void {
    if (!this.authService) {
      this.sendAuthResponse(connectionId, 'auth_start', {
        success: false,
        error: 'Auth service not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
      });
      return;
    }

    const deviceName = typeof data?.device === 'string' ? data.device : undefined;
    const result = this.authService.startAuth(deviceName);

    this.sendAuthResponse(connectionId, 'auth_start', {
      success: true,
      authUrl: result.authUrl,
      stateToken: result.stateToken,
    });
  }

  private handleAuthPoll(connectionId: string, data: Record<string, unknown> | undefined): void {
    if (!this.authService) {
      this.sendAuthResponse(connectionId, 'auth_poll', { success: false, error: 'Auth not configured' });
      return;
    }

    const stateToken = typeof data?.stateToken === 'string' ? data.stateToken : '';
    if (!stateToken) {
      this.sendAuthResponse(connectionId, 'auth_poll', { success: false, error: 'Missing stateToken' });
      return;
    }

    const result = this.authService.pollSession(stateToken);
    this.sendAuthResponse(connectionId, 'auth_poll', { success: true, ...result });
  }

  private handleAuthVerify(connectionId: string, data: Record<string, unknown> | undefined): void {
    if (!this.authService) {
      this.sendAuthResponse(connectionId, 'auth_verify', { success: false, valid: false });
      return;
    }

    const sessionToken = typeof data?.sessionToken === 'string' ? data.sessionToken : '';
    if (!sessionToken) {
      this.sendAuthResponse(connectionId, 'auth_verify', { success: false, valid: false });
      return;
    }

    const result = this.authService.verifySession(sessionToken);
    this.sendAuthResponse(connectionId, 'auth_verify', { success: true, ...result });
  }

  private handleAuthLogout(connectionId: string, data: Record<string, unknown> | undefined): void {
    if (!this.authService) {
      this.sendAuthResponse(connectionId, 'auth_logout', { success: false });
      return;
    }

    const sessionToken = typeof data?.sessionToken === 'string' ? data.sessionToken : '';
    const loggedOut = sessionToken ? this.authService.logout(sessionToken) : false;
    this.sendAuthResponse(connectionId, 'auth_logout', { success: loggedOut });
  }

  private handleProvidersList(connectionId: string, _data: Record<string, unknown> | undefined): void {
    // Use local provider manager (no auth required)
    if (this.localProviders) {
      const result = this.localProviders.listProviders();
      this.sendAuthResponse(connectionId, 'providers_list', result);
      return;
    }

    // Fallback to auth service if configured
    if (this.authService) {
      const sessionToken = typeof _data?.sessionToken === 'string' ? _data.sessionToken : '';
      if (!sessionToken) {
        this.sendAuthResponse(connectionId, 'providers_list', { success: false, error: 'Missing sessionToken' });
        return;
      }
      const result = this.authService.listProviders(sessionToken);
      this.sendAuthResponse(connectionId, 'providers_list', result);
      return;
    }

    this.sendAuthResponse(connectionId, 'providers_list', { success: false, error: 'Provider management not configured' });
  }

  private handleProvidersSave(connectionId: string, data: Record<string, unknown> | undefined): void {
    const provider = typeof data?.provider === 'string' ? data.provider : '';
    // Strip bracketed paste markers that may have slipped through from terminal input
    const rawKey = typeof data?.apiKey === 'string' ? data.apiKey : '';
    const apiKey = rawKey
      .replace(/\x1b\[200~/g, '')
      .replace(/\x1b\[201~/g, '')
      .replace(/\[200~/g, '')
      .replace(/\[201~/g, '')
      .trim();

    if (!provider || !apiKey) {
      this.sendAuthResponse(connectionId, 'providers_save', { success: false, error: 'Missing provider or apiKey' });
      return;
    }

    // Use local provider manager (no auth required)
    if (this.localProviders) {
      const result = this.localProviders.saveProviderKey(provider, apiKey);

      // If save succeeded, also update the running LLM adapter
      if (result.success && this.harness.updateApiKey) {
        // Map to canonical provider for adapter (e.g., 'cerebras' -> 'openai-compat')
        const canonicalProvider = isOpenAICompatProvider(provider) ? 'openai-compat' : provider;
        this.harness.updateApiKey(canonicalProvider, apiKey);
      }

      this.sendAuthResponse(connectionId, 'providers_save', result);
      return;
    }

    // Fallback to auth service if configured
    if (this.authService) {
      const sessionToken = typeof data?.sessionToken === 'string' ? data.sessionToken : '';
      if (!sessionToken) {
        this.sendAuthResponse(connectionId, 'providers_save', { success: false, error: 'Missing sessionToken' });
        return;
      }
      const result = this.authService.saveProviderKey(sessionToken, provider, apiKey);

      // If save succeeded, also update the running LLM adapter
      if (result.success && this.harness.updateApiKey) {
        const canonicalProvider = isOpenAICompatProvider(provider) ? 'openai-compat' : provider;
        this.harness.updateApiKey(canonicalProvider, apiKey);
      }

      this.sendAuthResponse(connectionId, 'providers_save', result);
      return;
    }

    this.sendAuthResponse(connectionId, 'providers_save', { success: false, error: 'Provider management not configured' });
  }

  private handleProvidersDelete(connectionId: string, data: Record<string, unknown> | undefined): void {
    const provider = typeof data?.provider === 'string' ? data.provider : '';

    if (!provider) {
      this.sendAuthResponse(connectionId, 'providers_delete', { success: false, error: 'Missing provider' });
      return;
    }

    // Use local provider manager (no auth required)
    if (this.localProviders) {
      const result = this.localProviders.deleteProviderKey(provider);
      this.sendAuthResponse(connectionId, 'providers_delete', result);
      return;
    }

    // Fallback to auth service if configured
    if (this.authService) {
      const sessionToken = typeof data?.sessionToken === 'string' ? data.sessionToken : '';
      if (!sessionToken) {
        this.sendAuthResponse(connectionId, 'providers_delete', { success: false, error: 'Missing sessionToken' });
        return;
      }
      const result = this.authService.deleteProviderKey(sessionToken, provider);
      this.sendAuthResponse(connectionId, 'providers_delete', result);
      return;
    }

    this.sendAuthResponse(connectionId, 'providers_delete', { success: false, error: 'Provider management not configured' });
  }

  private async handleProvidersTest(connectionId: string, data: Record<string, unknown> | undefined): Promise<void> {
    const provider = typeof data?.provider === 'string' ? data.provider : '';

    if (!provider) {
      this.sendAuthResponse(connectionId, 'providers_test', { success: false, error: 'Missing provider' });
      return;
    }

    // Use local provider manager (no auth required)
    if (this.localProviders) {
      const result = await this.localProviders.testProviderKey(provider);
      this.sendAuthResponse(connectionId, 'providers_test', result);
      return;
    }

    // Fallback to auth service if configured
    if (this.authService) {
      const sessionToken = typeof data?.sessionToken === 'string' ? data.sessionToken : '';
      if (!sessionToken) {
        this.sendAuthResponse(connectionId, 'providers_test', { success: false, error: 'Missing sessionToken' });
        return;
      }
      const result = await this.authService.testProviderKey(sessionToken, provider);
      this.sendAuthResponse(connectionId, 'providers_test', { success: true, ...result });
      return;
    }

    this.sendAuthResponse(connectionId, 'providers_test', { success: false, error: 'Provider management not configured' });
  }

  private sendAuthResponse(connectionId: string, kind: string, payload: Record<string, unknown>): void {
    this.sendEvent(connectionId, {
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: { kind, payload },
      },
    });
  }

  // =========================================================================
  // Session Fork Handler
  // =========================================================================

  private handleSessionFork(connectionId: string, state: ConnectionState): void {
    const sourceSessionKey = state.sessionKey;
    if (!sourceSessionKey) {
      this.sendAuthResponse(connectionId, 'session_fork', {
        success: false,
        error: 'No active session to fork',
      });
      return;
    }

    if (!this.harness.forkSession) {
      this.sendAuthResponse(connectionId, 'session_fork', {
        success: false,
        error: 'Fork not supported by harness',
      });
      return;
    }

    const newSessionKey = generateSessionKey();
    const result = this.harness.forkSession(sourceSessionKey, newSessionKey);

    this.sendAuthResponse(connectionId, 'session_fork', {
      success: result.success,
      sourceSessionKey,
      newSessionKey: result.success ? newSessionKey : undefined,
      error: result.error,
    });
  }

  // =========================================================================
  // Session Close Handler
  // =========================================================================

  private handleSessionClose(connectionId: string, state: ConnectionState): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'session_close', {
        success: true,
        message: 'No active session to close',
      });
      return;
    }

    // Release session ownership
    if (this.sessionOwners.get(sessionKey) === connectionId) {
      this.sessionOwners.delete(sessionKey);
    }

    // closeSession handles persist + marking inactive
    const closeResult = this.harness.closeSession?.(sessionKey);
    if (closeResult && closeResult.success === false) {
      this.sendAuthResponse(connectionId, 'session_close', {
        success: false,
        sessionKey,
        error: closeResult.error ?? 'Failed to close session',
        ...(closeResult.executingRequestId ? { activeRequestId: closeResult.executingRequestId } : {}),
      });
      return;
    }

    // Clear the connection's session and async references
    state.sessionKey = null;
    state.asyncRun = null;

    this.sendAuthResponse(connectionId, 'session_close', {
      success: true,
      sessionKey,
      message: 'Session closed and persisted',
    });
  }

  // =========================================================================
  // List Sessions Handler
  // =========================================================================

  private handleListSessions(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    _state: ConnectionState
  ): void {
    // Only filter by workingDir if explicitly provided - otherwise show ALL sessions
    const workingDir = typeof data?.workingDir === 'string' ? data.workingDir : undefined;

    // Default to recoverable sessions (active + inactive)
    const defaultStatuses = ['active', 'inactive'];
    const status = Array.isArray(data?.status)
      ? data.status as string[]
      : typeof data?.status === 'string'
        ? [data.status]
      : defaultStatuses;

    const limit = typeof data?.limit === 'number' ? data.limit : 20;

    const graphd = this.harness.getGraphD?.() ?? null;
    const result = listSessions(graphd, {
      workingDir: workingDir ?? undefined,
      status,
      limit,
      includePreview: true,
    });

    this.sendAuthResponse(connectionId, 'list_sessions', {
      success: result.success,
      sessions: result.sessions,
      error: result.error,
    });
  }

  private handleSessionDelete(connectionId: string, data: Record<string, unknown> | undefined): void {
    const sessionKey = typeof data?.sessionKey === 'string'
      ? data.sessionKey
      : typeof data?.session_key === 'string'
        ? data.session_key
        : '';
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'session_delete', {
        success: false,
        deleted: false,
        error: 'sessionKey is required',
      });
      return;
    }

    const graphd = this.harness.getGraphD?.() ?? null;
    const result = deleteSession(graphd, sessionKey);
    this.sendAuthResponse(connectionId, 'session_delete', {
      success: result.success,
      deleted: result.deleted,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  private handleUsageSummary(connectionId: string, data: Record<string, unknown> | undefined): void {
    const limit = typeof data?.limit === 'number' ? data.limit : 1000;
    const status = Array.isArray(data?.status)
      ? data.status as string[]
      : typeof data?.status === 'string'
        ? data.status
        : undefined;

    const graphd = this.harness.getGraphD?.() ?? null;
    const result = getTokenUsage(graphd, { limit, status });
    this.sendAuthResponse(connectionId, 'usage_summary', {
      success: result.success,
      usage: result.usage,
      sessions: result.sessions,
      error: result.error,
    });
  }

  // =========================================================================
  // Context Compaction Handler
  // =========================================================================

  private handleCompactContext(connectionId: string, state: ConnectionState): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'compact_context', {
        success: false,
        error: 'No active session to compact',
      });
      return;
    }

    if (!this.harness.compactContext) {
      this.sendAuthResponse(connectionId, 'compact_context', {
        success: false,
        error: 'Context compaction not supported by harness',
      });
      return;
    }

    const result = this.harness.compactContext(sessionKey);

    this.sendAuthResponse(connectionId, 'compact_context', {
      success: result.success,
      itemsRemoved: result.itemsRemoved,
      bytesRecovered: result.bytesRecovered,
      error: result.error,
    });
  }

  // =========================================================================
  // Model Selection Handlers
  // =========================================================================

  private persistModelSelection(
    sessionKey: string,
    agentType: string,
    selection: PersistedModelSelection
  ): void {
    const graphd = this.harness.getGraphD?.();
    if (!graphd) {
      return;
    }
    const globalSelections = graphd.getUserPreference<Record<string, PersistedModelSelection>>(
      'user_prefs:model_selections'
    ) ?? {};
    const updatedSelections = { ...globalSelections, [agentType]: selection };
    graphd.sessionUpdateMetadata(sessionKey, { model_selections: updatedSelections });
    graphd.setUserPreference('user_prefs:model_selections', updatedSelections);
  }

  private clearAllModelSelections(sessionKey: string): string[] {
    const existingSelections = this.harness.getAllSessionSelectedModels?.(sessionKey) ?? new Map();
    const clearedAgentTypes = Array.from(existingSelections.keys());

    if (this.harness.clearAllSessionSelectedModels) {
      this.harness.clearAllSessionSelectedModels(sessionKey);
    } else {
      for (const agentType of clearedAgentTypes) {
        this.harness.setSessionSelectedModel?.(sessionKey, agentType, null);
      }
    }

    const graphd = this.harness.getGraphD?.();
    if (graphd) {
      graphd.sessionUpdateMetadata(sessionKey, { model_selections: null });
      graphd.deleteUserPreference('user_prefs:model_selections');
    }

    return clearedAgentTypes;
  }

  private ensureAsyncCompanionSelections(
    sessionKey: string,
    fallbackSelection: PersistedModelSelection
  ): void {
    for (const companionAgentType of ['planner'] as const) {
      const existingSelection = this.harness.getSessionSelectedModel?.(sessionKey, companionAgentType);
      if (!existingSelection?.model || !existingSelection?.provider) {
        this.harness.setSessionSelectedModel?.(sessionKey, companionAgentType, fallbackSelection);
      }
    }
  }

  private handleSetModel(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'set_model', {
        success: false,
        error: 'No active session',
      });
      return;
    }

    // Extract agentType, default to 'standard'
    const agentType = typeof data?.agent_type === 'string' ? data.agent_type : 'standard';
    const provider = typeof data?.provider === 'string' ? data.provider : null;
    const model = typeof data?.model === 'string' ? data.model : null;
    const reasoning = typeof data?.reasoning === 'string' ? data.reasoning : null;

    // Handle reset - clear all model selections
    if (data?.reset === true) {
      const clearedAgentTypes = this.clearAllModelSelections(sessionKey);
      const agentTypesToEmit = clearedAgentTypes.length > 0 ? clearedAgentTypes : [agentType];
      this.sendAuthResponse(connectionId, 'set_model', {
        success: true,
        selected_model: null,
        message: 'All model selections cleared',
      });
      for (const clearedAgentType of agentTypesToEmit) {
        this.sendEvent(connectionId, {
          type: 'model_changed',
          data: {
            agentType: clearedAgentType,
            selectedModel: null,
            provider: null,
            model: null,
            reasoning: null,
          },
        });
      }
      return;
    }

    if (!provider) {
      this.sendAuthResponse(connectionId, 'set_model', {
        success: false,
        error: 'Provider is required',
      });
      return;
    }

    if (!model) {
      this.sendAuthResponse(connectionId, 'set_model', {
        success: false,
        error: 'Model is required',
      });
      return;
    }

    // Store selected model for this agent type
    const selectedModel = reasoning ? { provider, model, reasoning } : { provider, model };
    this.harness.setSessionSelectedModel?.(sessionKey, agentType, selectedModel);
    this.persistModelSelection(sessionKey, agentType, selectedModel);

    // Emit model_changed event with agentType
    this.sendEvent(connectionId, {
      type: 'model_changed',
      data: {
        agentType,
        selectedModel: selectedModel.model,
        selectedProvider: selectedModel.provider,
        provider: selectedModel.provider,
        model: selectedModel.model,
        reasoning,
      },
    });

    // Emit provider_key_required event if missing, but keep selection persisted
    const hasKey = this.harness.hasApiKey(provider);
    if (!hasKey) {
      this.sendEvent(connectionId, {
        type: 'provider_key_required',
        data: {
          provider,
          model,
          reasoning: reasoning ?? undefined,
        },
      });
    }

    this.sendAuthResponse(connectionId, 'set_model', {
      success: true,
      agent_type: agentType,
      selected_model: selectedModel,
      provider_key_required: !hasKey,
    });
  }

  private handleGetModel(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'get_model', {
        success: false,
        error: 'No active session',
      });
      return;
    }

    // Extract agentType from data, default to returning all if not specified
    const agentType = typeof data?.agent_type === 'string' ? data.agent_type : null;
    const returnAll = data?.all === true || !agentType;

    this.harness.ensureSessionHydrated?.(sessionKey, {
      workingDir: state.workingDir ?? this.workingDir,
      includeUserPreferences: true,
    });

    if (returnAll) {
      // Return all model selections
      const allSelections = this.harness.getAllSessionSelectedModels?.(sessionKey) ?? new Map();
      const selectionsObject: Record<string, { provider?: string; model?: string; reasoning?: string }> = {};
      for (const [type, selection] of allSelections) {
        selectionsObject[type] = selection;
      }

      this.sendAuthResponse(connectionId, 'get_model', {
        success: true,
        model_selections: selectionsObject,
      });
      return;
    }

    // Return selection for specific agent type
    let selectedModel = this.harness.getSessionSelectedModel?.(sessionKey, agentType) ?? null;

    this.sendAuthResponse(connectionId, 'get_model', {
      success: true,
      agent_type: agentType,
      selectedModel: selectedModel?.model ?? null,
      selectedProvider: selectedModel?.provider ?? null,
      provider: selectedModel?.provider ?? null,
      model: selectedModel?.model ?? null,
      reasoning: selectedModel?.reasoning ?? null,
    });
  }

  // =========================================================================
  // Permission Response Handler
  // =========================================================================

  private handlePermissionResponse(
    connectionId: string,
    data: Record<string, unknown> | undefined
  ): void {
    const state = this.getOrCreateConnectionState(connectionId);
    const sessionKey = state.sessionKey;

    if (!sessionKey) {
      this.sendError(connectionId, 'Session not initialized');
      return;
    }

    const requestId = typeof data?.request_id === 'string' ? data.request_id : '';
    const decisionFromField = typeof data?.decision === 'string' ? data.decision : '';
    const decisionFromAllowed = typeof data?.allowed === 'boolean'
      ? (data.allowed ? 'allow' : 'deny')
      : '';
    const decision = decisionFromField || decisionFromAllowed;
    const pattern = typeof data?.pattern === 'string' ? data.pattern : undefined;

    if (!requestId) {
      this.sendError(connectionId, 'Missing request_id in permission_response');
      return;
    }

    if (!decision || !['allow', 'always_allow', 'deny'].includes(decision)) {
      this.sendError(connectionId, 'Invalid decision in permission_response');
      return;
    }

    // Get the session's permission checker - not the global harness one
    const sessionChecker = this.harness.getSessionPermissionChecker?.(sessionKey);
    if (!sessionChecker) {
      this.sendError(connectionId, 'Permission checker not available for session');
      return;
    }

    // Handle the response - this resolves the pending promise in harness
    sessionChecker.handleResponse({
      requestId,
      decision: decision as 'allow' | 'always_allow' | 'deny',
      pattern,
    });
  }

  private handleSetDangerousMode(
    connectionId: string,
    data: Record<string, unknown> | undefined
  ): void {
    const state = this.getOrCreateConnectionState(connectionId);
    const sessionKey = state.sessionKey;

    if (!sessionKey) {
      this.sendError(connectionId, 'Session not initialized');
      return;
    }

    const enabled = data?.enabled === true;

    // Get the session's permission checker - each session has its own dangerous mode
    const sessionChecker = this.harness.getSessionPermissionChecker?.(sessionKey);
    if (!sessionChecker) {
      this.sendError(connectionId, 'Permission checker not available for session');
      return;
    }

    // Set dangerous mode for this session only
    sessionChecker.setDangerousMode(enabled);

    this.sendAuthResponse(connectionId, 'set_dangerous_mode', {
      success: true,
      enabled,
      sessionKey,
    });
  }

  private dispatchControlPlaneMessage(input: {
    sessionKey: string;
    message: string;
    context?: string;
    metadata?: Record<string, unknown>;
    requestId?: string;
    workingDir?: string;
  }): {
    success: boolean;
    requestId?: string;
    error?: string;
  } {
    const trimmedMessage = input.message.trim();
    if (!trimmedMessage) {
      return { success: false, error: 'Missing message' };
    }

    const graphd = this.harness.getGraphD?.();
    const sessionResult = graphd?.sessionGet(input.sessionKey) as
      | { session?: { workingDir?: string | null } }
      | undefined;
    const sessionWorkingDir = sessionResult?.session?.workingDir ?? undefined;
    const workingDir = input.workingDir ?? sessionWorkingDir ?? this.workingDir;
    const requestId = input.requestId ?? `control-plane-${generateRequestId()}`;
    const context = typeof input.context === 'string' && input.context.trim().length > 0
      ? input.context.trim()
      : undefined;
    // Browser-originated sessions default to dangerous mode (no permission prompts).
    this.harness.ensureSessionHydrated?.(input.sessionKey, {
      workingDir,
      dangerousMode: true,
      includeUserPreferences: true,
    });
    this.harness.getSessionPermissionChecker?.(input.sessionKey)?.setDangerousMode(true);

    try {
      const runHandle = this.harness.run({
        requestId,
        inputText: trimmedMessage,
        ...(context ? { context } : {}),
        sessionKey: input.sessionKey,
        workingDir,
      });
      void runHandle.result.catch((error) => {
        console.error('[harness-daemon] control-plane dispatch run failed', {
          sessionKey: input.sessionKey,
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return { success: true, requestId };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private handleControlPlaneDispatch(
    connectionId: string,
    data: Record<string, unknown> | undefined
  ): void {
    const sessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    const message = typeof data?.message === 'string' ? data.message : '';
    const context = typeof data?.context === 'string' ? data.context : undefined;
    const requestId = typeof data?.request_id === 'string' ? data.request_id : undefined;
    const workingDir = typeof data?.working_dir === 'string' ? data.working_dir : undefined;
    const metadata = isRecord(data?.metadata) ? data.metadata : undefined;

    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'control_plane_dispatch', { success: false, error: 'Missing session_key' });
      return;
    }
    if (!message.trim()) {
      this.sendAuthResponse(connectionId, 'control_plane_dispatch', { success: false, error: 'Missing message' });
      return;
    }

    const result = this.dispatchControlPlaneMessage({
      sessionKey,
      message,
      context,
      metadata,
      requestId,
      workingDir,
    });
    this.sendAuthResponse(connectionId, 'control_plane_dispatch', result);
  }

  private async handleControlPlaneStop(
    connectionId: string,
    data: Record<string, unknown> | undefined
  ): Promise<void> {
    const sessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    const note = typeof data?.note === 'string' && data.note.trim().length > 0
      ? data.note.trim()
      : undefined;
    const requestedAction = typeof data?.action === 'string' ? data.action.trim().toLowerCase() : 'cancel';
    const action = requestedAction === 'pause' || requestedAction === 'resume' || requestedAction === 'cancel'
      ? requestedAction
      : 'cancel';
    const timeoutMs = typeof data?.timeout_ms === 'number' && Number.isFinite(data.timeout_ms)
      ? Math.max(1000, data.timeout_ms)
      : 30_000;

    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'control_plane_stop', { success: false, error: 'Missing session_key' });
      return;
    }

    if (!this.harness.controlSessionExecution) {
      this.sendAuthResponse(connectionId, 'control_plane_stop', {
        success: false,
        error: 'Runtime control is not supported by this harness',
      });
      return;
    }

    const result = await this.harness.controlSessionExecution({
      sessionKey,
      action,
      reason: note,
      requestedBy: 'system',
      timeoutMs,
    });
    if (result.success && action === 'cancel') {
      this.harness.cancelSessionAsyncRun?.(sessionKey);
    }
    this.sendAuthResponse(connectionId, 'control_plane_stop', result);
  }

  private handleControlPlaneFork(
    connectionId: string,
    data: Record<string, unknown> | undefined
  ): void {
    const sourceSessionKey = typeof data?.source_session_key === 'string'
      ? data.source_session_key.trim()
      : '';
    const targetSessionKey = typeof data?.target_session_key === 'string'
      ? data.target_session_key.trim()
      : '';

    if (!sourceSessionKey) {
      this.sendAuthResponse(connectionId, 'control_plane_fork', { success: false, error: 'Missing source_session_key' });
      return;
    }
    if (!this.harness.forkSession) {
      this.sendAuthResponse(connectionId, 'control_plane_fork', { success: false, error: 'Fork not supported by harness' });
      return;
    }

    const target = targetSessionKey || `${sourceSessionKey}-fork-${Date.now().toString(36)}`;
    const result = this.harness.forkSession(sourceSessionKey, target);
    this.sendAuthResponse(connectionId, 'control_plane_fork', {
      success: result.success,
      ...(result.success ? { targetSessionKey: target } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  }

  private handleControlPlanePermissionsGet(
    connectionId: string,
    data: Record<string, unknown> | undefined
  ): void {
    const sessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    const workingDir = typeof data?.working_dir === 'string' ? data.working_dir : undefined;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'control_plane_permissions_get', { success: false, error: 'Missing session_key' });
      return;
    }

    const store = this.harness.ensureSessionHydrated?.(sessionKey, {
      ...(workingDir ? { workingDir } : {}),
      includeUserPreferences: false,
    });
    if (!store || typeof store.getPermissionState !== 'function') {
      this.sendAuthResponse(connectionId, 'control_plane_permissions_get', {
        success: false,
        error: 'Permission state not available',
      });
      return;
    }
    this.sendAuthResponse(connectionId, 'control_plane_permissions_get', {
      success: true,
      state: store.getPermissionState(),
    });
  }

  private handleControlPlanePermissionsUpdate(
    connectionId: string,
    data: Record<string, unknown> | undefined
  ): void {
    const sessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    const workingDir = typeof data?.working_dir === 'string' ? data.working_dir : undefined;
    const update = isRecord(data?.update) ? data.update : {};
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'control_plane_permissions_update', { success: false, error: 'Missing session_key' });
      return;
    }

    const store = this.harness.ensureSessionHydrated?.(sessionKey, {
      ...(workingDir ? { workingDir } : {}),
      includeUserPreferences: false,
    });
    if (!store || typeof store.updatePermissionOptions !== 'function') {
      this.sendAuthResponse(connectionId, 'control_plane_permissions_update', {
        success: false,
        error: 'Permission state not available',
      });
      return;
    }

    const nextState = store.updatePermissionOptions({
      ...(typeof update.dangerousMode === 'boolean' ? { dangerousMode: update.dangerousMode } : {}),
      ...(typeof update.allowOutsideRoot === 'boolean' ? { allowOutsideRoot: update.allowOutsideRoot } : {}),
      ...(typeof update.webSearchEnabled === 'boolean' ? { webSearchEnabled: update.webSearchEnabled } : {}),
      ...(typeof update.writesNoDeletes === 'boolean' ? { writesNoDeletes: update.writesNoDeletes } : {}),
      ...(Array.isArray(update.restrictWriteToPaths)
        ? {
            restrictWriteToPaths: update.restrictWriteToPaths
              .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
              .map((item) => item.trim()),
          }
        : update.restrictWriteToPaths === null
          ? { restrictWriteToPaths: null }
          : {}),
      ...(update.reloadPersistentConfig === true ? { reloadPersistentConfig: true } : {}),
    });
    this.sendAuthResponse(connectionId, 'control_plane_permissions_update', {
      success: true,
      state: nextState,
    });
  }

  private handleControlPlaneMemoryInfo(connectionId: string): void {
    if (!this.harness.getDebugMemoryInfo) {
      this.sendAuthResponse(connectionId, 'control_plane_memory_info', {
        success: false,
        error: 'Debug memory info not available',
      });
      return;
    }

    this.sendAuthResponse(connectionId, 'control_plane_memory_info', {
      success: true,
      ...this.harness.getDebugMemoryInfo(),
    });
  }

  private handleControlPlaneModelGet(
    connectionId: string,
    data: Record<string, unknown> | undefined
  ): void {
    const sessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'control_plane_model_get', { success: false, error: 'Missing session_key' });
      return;
    }
    const selections = this.harness.getAllSessionSelectedModels?.(sessionKey) ?? new Map();
    const selectionsObject: Record<string, { provider: string; model: string; reasoning?: string }> = {};
    for (const [type, selection] of selections) {
      selectionsObject[type] = selection;
    }
    this.sendAuthResponse(connectionId, 'control_plane_model_get', {
      success: true,
      selections: selectionsObject,
    });
  }

  private handleControlPlaneModelSet(
    connectionId: string,
    data: Record<string, unknown> | undefined
  ): void {
    const sessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    const agentType = typeof data?.agent_type === 'string' ? data.agent_type : 'standard';
    const provider = typeof data?.provider === 'string' ? data.provider : null;
    const model = typeof data?.model === 'string' ? data.model : null;
    const reasoning = typeof data?.reasoning === 'string' ? data.reasoning : undefined;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'control_plane_model_set', { success: false, error: 'Missing session_key' });
      return;
    }
    if (!provider || !model) {
      this.sendAuthResponse(connectionId, 'control_plane_model_set', { success: false, error: 'Provider and model are required' });
      return;
    }
    const selectedModel = reasoning ? { provider, model, reasoning } : { provider, model };
    this.harness.setSessionSelectedModel?.(sessionKey, agentType, selectedModel);
    this.persistModelSelection(sessionKey, agentType, selectedModel);

    this.sendAuthResponse(connectionId, 'control_plane_model_set', {
      success: true,
      agentType,
      selection: selectedModel,
    });
  }

  // =========================================================================
  // Async Session Handler
  // =========================================================================

  private async handleAsyncStart(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): Promise<void> {
    const explicitSessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    const sessionKey = explicitSessionKey || state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'async_start', {
        success: false,
        error: 'Session not initialized. Call init first.',
      });
      return;
    }

    const sendFailure = (error: string) => {
      this.sendAuthResponse(connectionId, 'async_start', { success: false, error });
    };

    // Prevent concurrent async runs (check session-level state, not connection-level)
    const existingAsyncRun = this.harness.getSessionAsyncRun?.(sessionKey);
    if (existingAsyncRun) {
      sendFailure(`An async session is already running (request: ${existingAsyncRun.requestId}). Wait for it to finish or close the session.`);
      return;
    }

    // Allow per-request working_dir overrides (mirrors send_text behavior)
    const requestWorkingDir =
      typeof data?.working_dir === 'string' && data.working_dir.length > 0 ? data.working_dir : undefined;
    let workingDir = requestWorkingDir ?? state.workingDir ?? this.workingDir;
    if (requestWorkingDir) {
      state.workingDir = requestWorkingDir;
    }

    // Control-plane callers can target a session directly and should default to the
    // session's working directory if one exists.
    if (explicitSessionKey && !requestWorkingDir) {
      const graphd = this.harness.getGraphD?.();
      const sessionResult = graphd?.sessionGet(sessionKey) as
        | { session?: { workingDir?: string | null } }
        | undefined;
      workingDir = sessionResult?.session?.workingDir ?? workingDir;
    }

    this.harness.ensureSessionHydrated?.(sessionKey, {
      workingDir,
      includeUserPreferences: true,
      ...(explicitSessionKey ? { dangerousMode: true } : {}),
    });
    if (explicitSessionKey) {
      this.harness.getSessionPermissionChecker?.(sessionKey)?.setDangerousMode(true);
    }

    const asyncStatus = this.harness.getAsyncModeStatus?.();
    if (asyncStatus && !asyncStatus.ok) {
      sendFailure(`Async mode is unavailable: ${asyncStatus.issues.join('; ')}`);
      return;
    }

    // For connection-scoped async starts we require an explicit valid model selection.
    // Control-plane starts can proceed with defaults, but we still sync companion selections
    // when a standard selection already exists.
    const activeSelection = this.harness.getSessionSelectedModel?.(sessionKey, 'standard');
    if (!explicitSessionKey) {
      if (!activeSelection?.model || !activeSelection?.provider) {
        sendFailure('No model selected. Use /models to choose one before starting an async session.');
        return;
      }
      if (!this.harness.hasApiKey(activeSelection.provider)) {
        this.sendEvent(connectionId, {
          type: 'provider_key_required',
          data: {
            provider: activeSelection.provider,
            model: activeSelection.model,
            reasoning: activeSelection.reasoning,
          },
        });
        sendFailure(`No API key configured for provider: ${activeSelection.provider}`);
        return;
      }
      this.ensureAsyncCompanionSelections(sessionKey, activeSelection);
    } else if (activeSelection?.model && activeSelection?.provider) {
      this.ensureAsyncCompanionSelections(sessionKey, activeSelection);
    }

    // Extract goal from data
    const goal = typeof data?.goal === 'string' ? data.goal.trim() : '';
    if (!goal) {
      sendFailure('Async session requires a goal.');
      return;
    }

    // Persist goal to GraphD immediately so the dashboard can show it
    const graphd = this.harness.getGraphD?.();
    if (graphd) {
      graphd.sessionUpdateWorkflow(sessionKey, { goal });
    }

    try {
      this.harness.setSessionAsyncModeEnabled?.(sessionKey, true);

      const requestId = generateRequestId();
      state.activeRequestId = requestId;

      // Track at session level (prevents race condition with multiple connections)
      const asyncRunInfo = { requestId, goal, cancelled: false, startedAt: Date.now() };
      if (!this.harness.startSessionAsyncRun?.(sessionKey, asyncRunInfo)) {
        this.harness.setSessionAsyncModeEnabled?.(sessionKey, false);
        sendFailure('An async session was started by another connection. Wait for it to finish or close the session.');
        return;
      }
      // Track connection-local state when this command is bound to the current session.
      if (!explicitSessionKey) {
        state.asyncRun = asyncRunInfo;
      }

      const handle = this.harness.run({
        requestId,
        inputText: goal,
        tier: 'planner',
        sessionKey,
        workingDir,
      });

      this.streamRunEvents(requestId, handle, (result) => {
        const currentAsyncRun = this.harness.getSessionAsyncRun?.(sessionKey);
        if (currentAsyncRun?.requestId === requestId) {
          this.harness.clearSessionAsyncRun?.(sessionKey);
        }
        if (state.asyncRun?.requestId === requestId) {
          state.asyncRun = null;
        }
        if (state.activeRequestId === requestId) {
          state.activeRequestId = null;
        }
        this.harness.setSessionAsyncModeEnabled?.(sessionKey, false);
      }, sessionKey);

      this.sendAuthResponse(connectionId, 'async_start', {
        success: true,
        sessionKey,
        requestId,
        goal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.harness.clearSessionAsyncRun?.(sessionKey);
      if (state.asyncRun?.requestId) {
        state.asyncRun = null;
      }
      this.harness.setSessionAsyncModeEnabled?.(sessionKey, false);
      sendFailure(`Failed to start async session: ${message}`);
    }
  }

  private async handleAsyncCancel(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): Promise<void> {
    const explicitSessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    const sessionKey = explicitSessionKey || state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'async_cancel', {
        success: false,
        error: 'Session not initialized. Call init first.',
      });
      return;
    }

    // Check session-level state (works across all connections)
    const sessionAsyncRun = this.harness.getSessionAsyncRun?.(sessionKey);
    if (!sessionAsyncRun) {
      this.sendAuthResponse(connectionId, 'async_cancel', {
        success: false,
        error: 'No async session is currently running.',
      });
      return;
    }

    const { requestId, goal } = sessionAsyncRun;

    const controlResult = this.harness.controlSessionExecution
      ? await this.harness.controlSessionExecution({
          sessionKey,
          action: 'cancel',
          reason: 'Async session cancelled by user request',
          requestedBy: 'user',
          timeoutMs: 30_000,
        })
      : { success: false, error: 'Runtime control is not supported by this harness' };
    if (!controlResult.success) {
      this.sendAuthResponse(connectionId, 'async_cancel', {
        success: false,
        error: controlResult.error ?? 'Failed to cancel active async session',
      });
      return;
    }

    if (state.asyncRun?.requestId === requestId) {
      state.asyncRun = null;
    }
    if (state.activeRequestId === requestId) {
      state.activeRequestId = null;
    }
    this.harness.setSessionAsyncModeEnabled?.(sessionKey, false);
    this.harness.cancelSessionAsyncRun?.(sessionKey);
    this.harness.clearSessionAsyncRun?.(sessionKey);

    this.sendAuthResponse(connectionId, 'async_cancel', {
      success: true,
      requestId,
      goal,
      quiesced: controlResult.quiesced ?? true,
    });

    // Emit cancellation response on the session channel.
    this.sendEvent(connectionId, {
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: {
          kind: 'async_complete',
          payload: {
            reason: 'manual_cancel',
            requestId,
            goal,
          },
        },
      },
    }, sessionChannel(sessionKey));
  }

  private handleAsyncStatus(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): void {
    const explicitSessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    const sessionKey = explicitSessionKey || state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'async_status', {
        success: false,
        running: false,
        error: 'Session not initialized. Call init first.',
      });
      return;
    }

    const sessionAsyncRun = this.harness.getSessionAsyncRun?.(sessionKey);
    if (!sessionAsyncRun) {
      this.sendAuthResponse(connectionId, 'async_status', {
        success: true,
        running: false,
      });
      return;
    }

    this.sendAuthResponse(connectionId, 'async_status', {
      success: true,
      running: true,
      requestId: sessionAsyncRun.requestId,
      goal: sessionAsyncRun.goal,
      startedAt: sessionAsyncRun.startedAt,
      elapsedMs: Date.now() - sessionAsyncRun.startedAt,
    });
  }

  private streamRunEvents(
    requestId: string,
    handle: AgentRunHandle,
    onComplete?: (result?: AgentRunResult) => void,
    sessionKey?: string
  ): void {
    const channel = runChannel(requestId);
    const asyncId = profiler.asyncBegin(`stream:${requestId}`, 'stream');

    // Touch session every 60s during long-running streams to prevent stale session cleanup
    const SESSION_TOUCH_INTERVAL_MS = 60_000;

    void (async () => {
      let eventCount = 0;
      let result: AgentRunResult | undefined;
      let lastTouchMs = Date.now();
      try {
        for await (const event of handle.events) {
          eventCount++;

          // Periodically touch session to keep it active during long runs
          if (sessionKey) {
            const now = Date.now();
            if (now - lastTouchMs >= SESSION_TOUCH_INTERVAL_MS) {
              lastTouchMs = now;
              const graphd = this.harness.getGraphD?.();
              if (graphd) {
                try {
                  graphd.sessionTouch(sessionKey);
                } catch {
                  // Ignore touch failures - non-critical
                }
              }
            }
          }

          const eventType = (event as BridgeEvent).type ?? 'unknown';
          profiler.begin(`stream.publish:${eventType}`, 'stream');
          this.bus.publish(channel, event);
          profiler.end(`stream.publish:${eventType}`, 'stream');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.bus.publish(channel, createErrorEvent(message, false));
      } finally {
        try {
          result = await handle.result;
        } catch {
          // Errors are already emitted via events.
        }
        profiler.asyncEnd(`stream:${requestId}`, asyncId, 'stream', { eventCount });
        onComplete?.(result);
      }
    })();
  }

  private getOrCreateConnectionState(connectionId: string): ConnectionState {
    const existing = this.connections.get(connectionId);
    if (existing) return existing;
    const state: ConnectionState = { sessionKey: null, lastSessionKey: null, workingDir: null, activeRequestId: null, asyncRun: null };
    this.connections.set(connectionId, state);
    return state;
  }

  private sendEvent(connectionId: string, event: BridgeEvent, channel?: string): void {
    profiler.begin(`gateway.sendEvent:${event.type}`, 'bridge');
    const targetChannel = channel ?? 'direct';
    this.bus.sendTo(connectionId, targetChannel, event);
    profiler.end(`gateway.sendEvent:${event.type}`, 'bridge');
  }

  private sendError(connectionId: string, message: string): void {
    this.sendEvent(connectionId, createErrorEvent(message, false));
  }
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateSessionKey(): string {
  return `tui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
