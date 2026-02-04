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
import { isOpenAICompatProvider } from 'types';
import { getAllModels } from 'types';
import { createHookRegistry, createRalphStopHook, type HookRegistry, type RalphCompletionReason, type RalphLoopState } from 'orchestrator';
import type { StopHookContext, StopHookResult } from 'agent';
import {
  getProtocolId,
  assertNever,
  failed,
  success,
  type AgentErrorDecision,
  type BoundsDecision,
  type CadenceDecision,
  type ControlEvent,
  type HandoffDecision,
  type Hook,
  type HookContext,
  type HookOutcome,
  type PromptAnswerDecision,
  type QualityGateDecision,
  type StatePatch,
  type TerminationReason,
  type WorkItemSpec,
} from 'protocol';
import type { AgentType } from 'agent';
import type { PermissionChecker } from './permissions.js';

interface HarnessLike {
  run(params: {
    requestId: string;
    inputText: string;
    tier?: AgentType;
    sessionKey: string;
    workingDir: string;
    context?: string;
    planMode?: boolean;
    hookRegistry?: HookRegistry;
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
  getSessionHistory?(sessionKey: string): Array<{ role: 'user' | 'agent' | 'system'; content: string; timestamp: number; requestId?: string }>;
  isSessionPaused?(sessionKey: string): boolean;
  getAsyncModeStatus?(): { ok: boolean; issues: string[] };
  ensureSessionHydrated?(sessionKey: string, options?: { workingDir?: string; dangerousMode?: boolean; includeUserPreferences?: boolean }): void;
  getGraphD?(): import('graphd').GraphDManager | null;
  closeSession?(sessionKey: string): void;
  forkSession?(sourceSessionKey: string, targetSessionKey: string): { success: boolean; error?: string };
  compactContext?(sessionKey: string): { success: boolean; itemsRemoved: number; bytesRecovered: number; error?: string };
  getSessionPermissionChecker?(sessionKey: string): PermissionChecker | null;  // Per-session permission checker
  setSessionAsyncModeEnabled?(sessionKey: string, enabled: boolean): void;
  // Session-level exclusive operation management (prevents concurrent ops from multiple connections)
  startSessionAsyncRun?(sessionKey: string, info: { requestId: string; goal: string; cancelled: boolean; startedAt: number }): boolean;
  getSessionAsyncRun?(sessionKey: string): { requestId: string; goal: string; cancelled: boolean; startedAt: number } | null;
  cancelSessionAsyncRun?(sessionKey: string): void;
  clearSessionAsyncRun?(sessionKey: string): void;
  startSessionRalphLoop?(sessionKey: string, info: { requestId: string; cancelled: boolean }): boolean;
  getSessionRalphLoop?(sessionKey: string): { requestId: string; cancelled: boolean } | null;
  cancelSessionRalphLoop?(sessionKey: string): void;
  clearSessionRalphLoop?(sessionKey: string): void;
  // Watcher CLI methods
  watcherStatus?(sessionKey: string): Record<string, unknown>;
  watcherContext?(sessionKey: string): Record<string, unknown>;
  watcherSearch?(sessionKey: string, query: string): Promise<Record<string, unknown>>;
  watcherDecisions?(sessionKey: string): Promise<Record<string, unknown>>;
  watcherInspect?(sessionKey: string, id: string): Promise<Record<string, unknown>>;
  watcherMemory?(sessionKey: string): Record<string, unknown>;
  watcherFocus?(sessionKey: string, topic: string): Record<string, unknown>;
  watcherDefocus?(sessionKey: string): Record<string, unknown>;
  watcherReanchor?(sessionKey: string, goal: string): Record<string, unknown>;
  watcherSummarize?(sessionKey: string): Record<string, unknown>;
  /** Create an LLM-backed watcher hook registry + planning objective for a session. */
  createWatcherHookRegistryForSession?(sessionKey: string, goal: string, workingDir: string, watcherDir?: string): Promise<{ hookRegistry: HookRegistry; planningObjective: string }>;
}

interface RalphLoopInfo {
  requestId: string;
  cancelled: boolean;
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
  planMode: boolean;
  ralphLoop: RalphLoopInfo | null;
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

function createHookRegistryFromStopHook(
  stopHook: (ctx: StopHookContext) => Promise<StopHookResult> | StopHookResult,
  sessionKey: string
): HookRegistry {
  const registry = createHookRegistry();
  const hooks = buildStopHookAdapterHooks(stopHook, sessionKey);
  registry.registerHooks({
    source: `legacy-stop-hook:${sessionKey}`,
    protocolId: getProtocolId(),
    hooks,
  });
  return registry;
}

function buildStopHookAdapterHooks(
  stopHook: (ctx: StopHookContext) => Promise<StopHookResult> | StopHookResult,
  sessionKey: string
): Array<Hook<ControlEvent, unknown>> {
  const base = {
    policy: { kind: 'retry_then_degrade', maxRetries: 1, backoffMs: 500, degradeTo: 'skip' } as const,
    criticality: 'critical' as const,
    idempotency: 'idempotent' as const,
    priority: 50,
    timeoutMs: 90_000,
  };

  const toTerminationReason = (event: ControlEvent): TerminationReason => {
    switch (event.type) {
      case 'goal_state_reached':
        return 'goal_state_reached';
      case 'bounds_exceeded':
        switch (event.boundType) {
          case 'iterations':
            return 'max_iterations_exceeded';
          case 'tool_calls':
            return 'max_tool_calls_exceeded';
          case 'duration':
            return 'max_duration_exceeded';
          default:
            return assertNever(event.boundType);
        }
      case 'user_input_required':
        return 'user_input_required';
      case 'cadence_audit':
        return 'cadence_audit';
      case 'agent_error':
        return event.errorType === 'exception' ? 'agent_error' : event.errorType;
      case 'handoff_requested':
        return 'handoff_requested';
      case 'work_item_completed':
        return 'goal_state_reached';
      case 'user_stopped':
        return 'user_stopped';
      case 'transient_error':
        switch (event.errorType) {
          case 'rate_limit':
            return 'rate_limit';
          case 'circuit_open':
            return 'circuit_open';
          case 'timeout':
            return 'timeout';
        }
      default:
        return assertNever(event);
    }
  };

  const toWorkItemSpecs = (items?: StopHookResult['deferredWork']): WorkItemSpec[] => {
    if (!items || items.length === 0) return [];
    return items.map(item => ({
      id: item.id,
      goal: item.goal,
      objective: item.objective,
      agent: item.agent,
      dependencies: item.dependencies,
      targetPaths: item.targetPaths,
      bounds: item.bounds,
    }));
  };

  const buildStopContext = (event: ControlEvent, ctx: HookContext): StopHookContext => ({
    workId: event.workId,
    response: 'response' in event ? event.response : '',
    terminationReason: toTerminationReason(event),
    iteration: ctx.iteration,
    agentType: ctx.agentType,
    sessionKey: ctx.sessionKey,
    userPrompt: event.type === 'user_input_required' ? {
      question: event.prompt.question,
      options: event.prompt.options?.map(option => ({ label: option.label, description: option.description })),
      context: event.prompt.context,
      multiSelect: event.prompt.multiSelect,
    } : undefined,
    handoffSpec: event.type === 'handoff_requested' ? event.handoffSpec : undefined,
  });

  const injectGuidancePatch = (message?: string): StatePatch[] | undefined => {
    if (!message) return undefined;
    return [{ op: 'inject_guidance', content: message }];
  };

  const runStopHook = async <D>(
    event: ControlEvent,
    ctx: HookContext,
    mapResult: (result: StopHookResult) => { decision: D; patches?: StatePatch[] }
  ): Promise<HookOutcome<D>> => {
    if (event.sessionKey !== sessionKey) {
      return { kind: 'skip', reason: 'session_mismatch' };
    }
    try {
      const stopResult = await stopHook(buildStopContext(event, ctx));
      const mapped = mapResult(stopResult);
      return success(mapped.decision, mapped.patches);
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
  };

  const makeHook = <D>(eventType: ControlEvent['type'], mapResult: (event: ControlEvent, result: StopHookResult) => { decision: D; patches?: StatePatch[] }): Hook<ControlEvent, D> => ({
    ...base,
    id: `legacy:${sessionKey}:${eventType}`,
    event: eventType,
    run: (event: ControlEvent, ctx: HookContext) => runStopHook(event, ctx, (result) => mapResult(event, result)),
  });

  return [
    makeHook<QualityGateDecision>('goal_state_reached', (_event, result) => {
      if (result.decision === 'block') {
        return {
          decision: { verdict: 'failed', issues: [result.reason ?? 'Quality gate blocked'] },
          patches: injectGuidancePatch(result.systemMessage),
        };
      }
      return { decision: { verdict: 'passed' } };
    }),
    makeHook<BoundsDecision>('bounds_exceeded', (_event, result) => {
      const workItems = toWorkItemSpecs(result.deferredWork);
      if (workItems.length > 0) {
        return { decision: { action: 'split', workItems } };
      }
      if (result.decision === 'block' && result.reason) {
        return {
          decision: { action: 'realign', guidance: result.reason },
          patches: injectGuidancePatch(result.systemMessage),
        };
      }
      if (result.systemMessage) {
        return { decision: { action: 'wrap_up', summary: result.systemMessage } };
      }
      return { decision: { action: 'abort', reason: 'Allowed termination' } };
    }),
    makeHook<PromptAnswerDecision>('user_input_required', (_event, result) => {
      if (result.decision === 'block' && result.reason) {
        return {
          decision: { action: 'answer', text: result.reason, confidence: 0.7, contextAddendum: result.systemMessage },
        };
      }
      return { decision: { action: 'defer', to: 'user' } };
    }),
    makeHook<CadenceDecision>('cadence_audit', (_event, result) => {
      const workItems = toWorkItemSpecs(result.deferredWork);
      if (workItems.length > 0) {
        return { decision: { action: 'split', workItems } };
      }
      if (result.decision === 'block' && result.reason) {
        return {
          decision: { action: 'realign', guidance: result.reason },
          patches: injectGuidancePatch(result.systemMessage),
        };
      }
      if (result.systemMessage) {
        return { decision: { action: 'inject_guidance', message: result.systemMessage } };
      }
      return { decision: { action: 'continue' } };
    }),
    makeHook<AgentErrorDecision>('agent_error', (_event, result) => {
      if (result.decision === 'block' && result.reason) {
        return { decision: { action: 'retry', guidance: result.reason } };
      }
      return { decision: { action: 'abort', reason: result.systemMessage ?? 'Allowed termination' } };
    }),
    makeHook<HandoffDecision>('handoff_requested', (_event, result) => {
      if (result.decision === 'block' && result.reason) {
        return { decision: { action: 'reject', feedback: result.reason } };
      }
      return { decision: { action: 'approve' } };
    }),
  ];
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
    register('providers_test', (data, ctx) => {
      void this.handleProvidersTest(ctx.connectionId, data);
    });
    register('session_fork', (_data, ctx) => this.handleSessionFork(ctx.connectionId, ctx.state));
    register('session_close', (_data, ctx) => this.handleSessionClose(ctx.connectionId, ctx.state));
    register('list_sessions', (data, ctx) => this.handleListSessions(ctx.connectionId, data, ctx.state));
    register('compact_context', (_data, ctx) => this.handleCompactContext(ctx.connectionId, ctx.state));
    register('set_model', (data, ctx) => this.handleSetModel(ctx.connectionId, data, ctx.state));
    register('get_model', (data, ctx) => this.handleGetModel(ctx.connectionId, data, ctx.state));
    register('ralph_loop_start', (data, ctx) => this.handleRalphLoopStart(ctx.connectionId, data, ctx.state));
    register('ralph_loop_cancel', (_data, ctx) => this.handleRalphLoopCancel(ctx.connectionId, ctx.state));
    register('permission_response', (data, ctx) => this.handlePermissionResponse(ctx.connectionId, data));
    register('set_dangerous_mode', (data, ctx) => this.handleSetDangerousMode(ctx.connectionId, data));
    register('async_start', (data, ctx) => {
      void this.handleAsyncStart(ctx.connectionId, data, ctx.state);
    });
    register('async_cancel', (_data, ctx) => this.handleAsyncCancel(ctx.connectionId, ctx.state));
    register('async_status', (_data, ctx) => this.handleAsyncStatus(ctx.connectionId, ctx.state));
    register('watcher_status', (_data, ctx) => this.handleWatcherStatus(ctx.connectionId, ctx.state));
    register('watcher_context', (_data, ctx) => this.handleWatcherContext(ctx.connectionId, ctx.state));
    register('watcher_search', (data, ctx) => {
      void this.handleWatcherSearch(ctx.connectionId, data, ctx.state);
    });
    register('watcher_decisions', (_data, ctx) => {
      void this.handleWatcherDecisions(ctx.connectionId, ctx.state);
    });
    register('watcher_inspect', (data, ctx) => {
      void this.handleWatcherInspect(ctx.connectionId, data, ctx.state);
    });
    register('watcher_memory', (_data, ctx) => this.handleWatcherMemory(ctx.connectionId, ctx.state));
    register('watcher_focus', (data, ctx) => this.handleWatcherFocus(ctx.connectionId, data, ctx.state));
    register('watcher_defocus', (_data, ctx) => this.handleWatcherDefocus(ctx.connectionId, ctx.state));
    register('watcher_reanchor', (data, ctx) => this.handleWatcherReanchor(ctx.connectionId, data, ctx.state));
    register('watcher_summarize', (_data, ctx) => this.handleWatcherSummarize(ctx.connectionId, ctx.state));
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

    // Load and emit per-agent-type model selections if available
    if (graphd) {
      // Send persisted selections directly to this connection to avoid session-channel races
      const selections = this.harness.getAllSessionSelectedModels?.(sessionKey) ?? new Map();
      const selectionsObject: Record<string, { provider?: string; model?: string; reasoning?: string }> = {};
      for (const [type, selection] of selections) {
        selectionsObject[type] = selection;
      }
      this.sendAuthResponse(connectionId, 'get_model', {
        success: true,
        model_selections: selectionsObject,
      });

      // Emit model_changed for all agent types with persisted selections
      const allSelections = this.harness.getAllSessionSelectedModels?.(sessionKey) ?? new Map();
      const agentTypes = ['standard', 'explorer', 'coding'];
      for (const agentType of agentTypes) {
        const selection = allSelections.get(agentType) ?? null;
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
    } else {
      // No GraphD - emit null selections for all agent types
      const agentTypes = ['standard', 'explorer', 'coding'];
      for (const agentType of agentTypes) {
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
        }, sessionChannel(sessionKey));
      }
    }
  }

  private handleSendText(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): void {
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

    const text = String(data?.text ?? '');
    if (!text.trim()) {
      this.sendError(connectionId, 'Empty message');
      return;
    }

    const candidateRequestId =
      typeof data?.client_request_id === 'string' ? data.client_request_id : '';
    const clientRequestId = candidateRequestId.length > 0
      ? candidateRequestId
      : generateRequestId();
    const rawTier = typeof data?.tier === 'string' ? data.tier.trim() : '';
    const tier = rawTier && rawTier !== 'auto' ? (rawTier as AgentType) : undefined;

    // Extract planMode from command data
    const planMode = typeof data?.plan_mode === 'boolean' ? data.plan_mode : state.planMode;
    state.planMode = planMode;

    state.activeRequestId = clientRequestId;

    profiler.instant('harness.run:start', 'harness', 'p', { requestId: clientRequestId, tier });
    const handle = this.harness.run({
      requestId: clientRequestId,
      inputText: text,
      ...(tier ? { tier } : {}),
      sessionKey,
      workingDir,
      planMode,
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

    const models = getAllModels()
      .filter((model) => !hiddenModels.includes(model.id))
      .map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        reasoning: model.reasoning,
      }));

    this.sendEvent(connectionId, {
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: {
          kind: 'models',
          payload: models,
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

    // Also clear legacy preferences if they match
    const selectedModel = graphd.getUserPreference<{ provider?: string; model?: string }>('user_prefs:selected_model');
    if (selectedModel?.model && selectedModel.model.trim().toLowerCase() === normalizedModelId) {
      graphd.deleteUserPreference('user_prefs:selected_model');
      graphd.deleteUserPreference('user_prefs:last_model');
    }

    // Clear session selections if they match the deleted model
    if (sessionKey) {
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
    this.harness.closeSession?.(sessionKey);

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
    state: ConnectionState
  ): void {
    const graphd = this.harness.getGraphD?.();
    if (!graphd) {
      this.sendAuthResponse(connectionId, 'list_sessions', {
        success: false,
        sessions: [],
        error: 'GraphD not available',
      });
      return;
    }

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

    const result = graphd.sessionsList({
      workingDir: workingDir ?? undefined,
      status,
      limit,
    });

    this.sendAuthResponse(connectionId, 'list_sessions', {
      success: !result.error,
      sessions: result.sessions ?? [],
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

    const graphd = this.harness.getGraphD?.();

    // Handle reset - clear all model selections
    if (data?.reset === true) {
      if (graphd) {
        graphd.sessionUpdateMetadata(sessionKey, { model_selections: null });
        graphd.deleteUserPreference('user_prefs:model_selections');
        graphd.deleteUserPreference('user_prefs:selected_model');
        graphd.deleteUserPreference('user_prefs:last_model');
      }
      // Note: harness.clearModelSelections would be needed, but we don't have that exposed
      // The store will be cleared on next session init
      this.sendAuthResponse(connectionId, 'set_model', {
        success: true,
        selected_model: null,
        message: 'All model selections cleared',
      });
      this.sendEvent(connectionId, {
        type: 'model_changed',
        data: {
          agentType,
          selectedModel: null,
          provider: null,
          model: null,
          reasoning: null,
        },
      });
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

    // Persist to GraphD as per-agent-type model_selections map
    if (graphd) {
      // Read from GLOBAL user preferences first (source of truth), then merge new selection
      // This ensures selections from other sessions aren't lost
      const globalSelections = graphd.getUserPreference<Record<string, { provider: string; model: string; reasoning?: string }>>('user_prefs:model_selections') ?? {};
      const updatedSelections = { ...globalSelections, [agentType]: selectedModel };

      // Persist to both session metadata and global preferences
      graphd.sessionUpdateMetadata(sessionKey, { model_selections: updatedSelections });
      graphd.setUserPreference('user_prefs:model_selections', updatedSelections);
    }

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
  // Ralph Loop Handlers
  // =========================================================================

  private handleRalphLoopStart(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendError(connectionId, 'Session not initialized. Call init first.');
      return;
    }

    this.harness.ensureSessionHydrated?.(sessionKey, {
      workingDir: state.workingDir ?? this.workingDir,
      includeUserPreferences: true,
    });

    // Check if already running a Ralph loop (check session-level state, not connection-level)
    const existingRalphLoop = this.harness.getSessionRalphLoop?.(sessionKey);
    if (existingRalphLoop) {
      this.sendError(connectionId, 'A Ralph Loop is already running. Cancel it first.');
      return;
    }

    // Check model selection
    const activeSelection = this.harness.getSessionSelectedModel?.(sessionKey, 'standard');
    if (!activeSelection?.model || !activeSelection?.provider) {
      this.sendError(connectionId, 'No model selected. Use /models to choose one before starting a Ralph Loop.');
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
      this.sendError(connectionId, `No API key configured for provider: ${activeSelection.provider}`);
      return;
    }

    // Extract Ralph Loop config from data
    const prompt = typeof data?.prompt === 'string' ? data.prompt : '';
    const maxIterations = typeof data?.maxIterations === 'number' ? data.maxIterations : 20;
    const completionPromise = typeof data?.completionPromise === 'string' ? data.completionPromise : 'TASK COMPLETE';

    if (!prompt.trim()) {
      this.sendError(connectionId, 'Ralph Loop requires a prompt.');
      return;
    }

    // Generate a request ID for this Ralph loop run
    const requestId = generateRequestId();
    // Per-request working_dir takes precedence (same pattern as handleSendText)
    const requestWorkingDir = typeof data?.working_dir === 'string' && data.working_dir.length > 0
      ? data.working_dir
      : null;
    const workingDir = requestWorkingDir ?? state.workingDir ?? this.workingDir;

    // Track at session level (prevents race condition with multiple connections)
    const ralphLoopInfo = { requestId, cancelled: false };
    if (!this.harness.startSessionRalphLoop?.(sessionKey, ralphLoopInfo)) {
      // Another connection started one between our check and now (rare but possible)
      this.sendError(connectionId, 'A Ralph Loop was started by another connection. Cancel it first.');
      return;
    }
    // Also track at connection level for backward compat
    state.ralphLoop = ralphLoopInfo;
    state.activeRequestId = requestId;

    // Create Ralph stop hook with callbacks
    // Use session-level state reference for cancel detection
    const getSessionRalphLoop = () => this.harness.getSessionRalphLoop?.(sessionKey);
    const stopHook = createRalphStopHook({
      prompt,
      maxIterations,
      completionPromise,
      onIteration: (loopState: RalphLoopState) => {
        // Check if cancelled (at session level)
        const currentRalphLoop = getSessionRalphLoop();
        if (currentRalphLoop?.cancelled) {
          return;
        }
        // Emit progress event with Ralph iteration info
        const channel = runChannel(requestId);
        this.bus.publish(channel, {
          type: 'progress',
          data: {
            request_id: requestId,
            message: `🔄 Ralph iteration ${loopState.iteration} of ${loopState.maxIterations}`,
            level: 'info',
            kind: 'work',
            ralph_iteration: {
              type: 'ralph_iteration',
              iteration: loopState.iteration,
              maxIterations: loopState.maxIterations,
              completionPromise: loopState.completionPromise,
            },
          },
        });
      },
      onComplete: (loopState: RalphLoopState, reason: RalphCompletionReason) => {
        // Clear Ralph loop state (both session and connection level)
        this.harness.clearSessionRalphLoop?.(sessionKey);
        state.ralphLoop = null;

        // Emit completion event to the run channel (same as onIteration) so TUI receives it
        const channel = runChannel(requestId);
        this.bus.publish(channel, {
          type: 'response',
          data: {
            request_id: requestId,
            success: reason === 'promise_detected',
            content: '',
            metadata: {
              kind: 'ralph_loop_complete',
              payload: {
                reason,
                iterations: loopState.iteration,
                lastResponse: loopState.lastResponse.slice(0, 500),
              },
            },
          },
        });
      },
    });

    const hookRegistry = createHookRegistryFromStopHook(stopHook, sessionKey);

    // Start the harness run with the Ralph hook registry
    const handle = this.harness.run({
      requestId,
      inputText: prompt,
      sessionKey,
      workingDir,
      planMode: state.planMode,
      hookRegistry,
    });

    this.streamRunEvents(requestId, handle, undefined, sessionKey);
  }

  private handleRalphLoopCancel(connectionId: string, state: ConnectionState): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendError(connectionId, 'Session not initialized. Call init first.');
      return;
    }

    // Check session-level state (works across all connections)
    const sessionRalphLoop = this.harness.getSessionRalphLoop?.(sessionKey);
    if (!sessionRalphLoop) {
      this.sendError(connectionId, 'No Ralph Loop is currently running.');
      return;
    }

    // Mark as cancelled at session level
    this.harness.cancelSessionRalphLoop?.(sessionKey);

    // Clear Ralph loop state (both session and connection level)
    this.harness.clearSessionRalphLoop?.(sessionKey);
    const iterations = 0; // We don't track exact iteration count here
    state.ralphLoop = null;

    // Emit cancellation response
    this.sendEvent(connectionId, {
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: {
          kind: 'ralph_loop_complete',
          payload: {
            reason: 'manual_cancel',
            iterations,
            lastResponse: '',
          },
        },
      },
    }, sessionKey ? sessionChannel(sessionKey) : 'direct');
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
    const decision = typeof data?.decision === 'string' ? data.decision : '';
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

  // =========================================================================
  // Async Session Handler
  // =========================================================================

  private async handleAsyncStart(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): Promise<void> {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendError(connectionId, 'Session not initialized. Call init first.');
      return;
    }

    // Prevent concurrent async runs (check session-level state, not connection-level)
    const existingAsyncRun = this.harness.getSessionAsyncRun?.(sessionKey);
    if (existingAsyncRun) {
      this.sendError(connectionId, `An async session is already running (request: ${existingAsyncRun.requestId}). Wait for it to finish or close the session.`);
      return;
    }

    // Allow per-request working_dir overrides (mirrors send_text behavior)
    const requestWorkingDir =
      typeof data?.working_dir === 'string' && data.working_dir.length > 0 ? data.working_dir : undefined;
    const workingDir = requestWorkingDir ?? state.workingDir ?? this.workingDir;
    if (requestWorkingDir) {
      state.workingDir = requestWorkingDir;
    }

    this.harness.ensureSessionHydrated?.(sessionKey, {
      workingDir,
      includeUserPreferences: true,
    });

    const asyncStatus = this.harness.getAsyncModeStatus?.();
    if (asyncStatus && !asyncStatus.ok) {
      this.sendError(connectionId, `Async mode is unavailable: ${asyncStatus.issues.join('; ')}`);
      return;
    }

    if (this.harness.isSessionPaused?.(sessionKey)) {
      this.sendError(connectionId, 'Session is paused awaiting user input. Resume or close the session before starting async mode.');
      return;
    }

    // Validate model selection
    const activeSelection = this.harness.getSessionSelectedModel?.(sessionKey, 'standard');
    if (!activeSelection?.model || !activeSelection?.provider) {
      this.sendError(connectionId, 'No model selected. Use /models to choose one before starting an async session.');
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
      this.sendError(connectionId, `No API key configured for provider: ${activeSelection.provider}`);
      return;
    }

    // Ensure planner/watcher model selections exist (defaults to standard selection if unset)
    const plannerSelection = this.harness.getSessionSelectedModel?.(sessionKey, 'planner');
    if (!plannerSelection?.model || !plannerSelection?.provider) {
      this.harness.setSessionSelectedModel?.(sessionKey, 'planner', activeSelection);
    }
    const watcherSelection = this.harness.getSessionSelectedModel?.(sessionKey, 'watcher');
    if (!watcherSelection?.model || !watcherSelection?.provider) {
      this.harness.setSessionSelectedModel?.(sessionKey, 'watcher', activeSelection);
    }

    // Extract goal from data
    const goal = typeof data?.goal === 'string' ? data.goal.trim() : '';
    if (!goal) {
      this.sendError(connectionId, 'Async session requires a goal.');
      return;
    }

    // Create watcher hook registry for this session
    if (!this.harness.createWatcherHookRegistryForSession) {
      this.sendError(connectionId, 'Async sessions are not supported by this harness.');
      return;
    }

    try {
      this.harness.setSessionAsyncModeEnabled?.(sessionKey, true);
      // Pass daemon's root as watcherDir for .watcher artifacts, session's workingDir for agent operations
      const { hookRegistry, planningObjective } = await this.harness.createWatcherHookRegistryForSession(sessionKey, goal, workingDir, this.workingDir);

      const requestId = generateRequestId();
      state.activeRequestId = requestId;

      // Track at session level (prevents race condition with multiple connections)
      const asyncRunInfo = { requestId, goal, cancelled: false, startedAt: Date.now() };
      if (!this.harness.startSessionAsyncRun?.(sessionKey, asyncRunInfo)) {
        // Another connection started one between our check and now (rare but possible)
        this.harness.setSessionAsyncModeEnabled?.(sessionKey, false);
        this.sendError(connectionId, 'An async session was started by another connection. Wait for it to finish or close the session.');
        return;
      }
      // Also track at connection level for backward compat and cleanup on disconnect
      state.asyncRun = asyncRunInfo;

      // Start the harness run with the watcher hook registry and planning objective as input
      const handle = this.harness.run({
        requestId,
        inputText: planningObjective,
        tier: 'planner',
        sessionKey,
        workingDir,
        hookRegistry,
      });

      this.streamRunEvents(requestId, handle, (result) => {
        // Only clean up async state when the run actually completes (success or failure),
        // NOT when it pauses for user input. Paused runs should resume with async mode still on.
        if (result?.paused) {
          // Run paused for user input - keep async mode enabled for resume
          return;
        }
        // Clear session-level state
        const currentAsyncRun = this.harness.getSessionAsyncRun?.(sessionKey);
        if (currentAsyncRun?.requestId === requestId) {
          this.harness.clearSessionAsyncRun?.(sessionKey);
        }
        // Clear connection-level state
        if (state.asyncRun?.requestId === requestId) {
          state.asyncRun = null;
        }
        if (state.activeRequestId === requestId) {
          state.activeRequestId = null;
        }
        this.harness.setSessionAsyncModeEnabled?.(sessionKey, false);
      }, sessionKey);

      // Notify client that async session started
      this.sendAuthResponse(connectionId, 'async_start', {
        success: true,
        sessionKey,
        requestId,
        goal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.harness.clearSessionAsyncRun?.(sessionKey);
      state.asyncRun = null;
      this.harness.setSessionAsyncModeEnabled?.(sessionKey, false);
      this.sendError(connectionId, `Failed to start async session: ${message}`);
    }
  }

  private handleAsyncCancel(connectionId: string, state: ConnectionState): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendError(connectionId, 'Session not initialized. Call init first.');
      return;
    }

    // Check session-level state (works across all connections)
    const sessionAsyncRun = this.harness.getSessionAsyncRun?.(sessionKey);
    if (!sessionAsyncRun) {
      this.sendError(connectionId, 'No async session is currently running.');
      return;
    }

    const { requestId, goal } = sessionAsyncRun;

    // Mark as cancelled at session level so the watcher hook can detect it
    this.harness.cancelSessionAsyncRun?.(sessionKey);

    // Clear session-level async state
    this.harness.clearSessionAsyncRun?.(sessionKey);

    // Also clear connection-level state for backward compat
    state.asyncRun = null;
    if (state.activeRequestId === requestId) {
      state.activeRequestId = null;
    }
    this.harness.setSessionAsyncModeEnabled?.(sessionKey, false);

    // Emit cancellation response on the session channel
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
    }, sessionKey ? sessionChannel(sessionKey) : 'direct');
  }

  private handleAsyncStatus(connectionId: string, state: ConnectionState): void {
    const sessionKey = state.sessionKey;
    // Check session-level state (works across all connections)
    const sessionAsyncRun = sessionKey ? this.harness.getSessionAsyncRun?.(sessionKey) : null;
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

  // =========================================================================
  // Watcher Command Handlers
  // =========================================================================

  private handleWatcherStatus(connectionId: string, state: ConnectionState): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'watcher_status', { success: false, error: 'No active session' });
      return;
    }
    const result = this.harness.watcherStatus?.(sessionKey) ?? { error: 'Not supported' };
    this.sendAuthResponse(connectionId, 'watcher_status', { success: true, ...result });
  }

  private handleWatcherContext(connectionId: string, state: ConnectionState): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'watcher_context', { success: false, error: 'No active session' });
      return;
    }
    const result = this.harness.watcherContext?.(sessionKey) ?? { error: 'Not supported' };
    this.sendAuthResponse(connectionId, 'watcher_context', { success: true, ...result });
  }

  private async handleWatcherSearch(connectionId: string, data: Record<string, unknown> | undefined, state: ConnectionState): Promise<void> {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'watcher_search', { success: false, error: 'No active session' });
      return;
    }
    const query = typeof data?.query === 'string' ? data.query : '';
    if (!query) {
      this.sendAuthResponse(connectionId, 'watcher_search', { success: false, error: 'Missing query' });
      return;
    }
    const result = await this.harness.watcherSearch?.(sessionKey, query) ?? { error: 'Not supported' };
    this.sendAuthResponse(connectionId, 'watcher_search', { success: true, ...result });
  }

  private async handleWatcherDecisions(connectionId: string, state: ConnectionState): Promise<void> {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'watcher_decisions', { success: false, error: 'No active session' });
      return;
    }
    const result = await this.harness.watcherDecisions?.(sessionKey) ?? { error: 'Not supported' };
    this.sendAuthResponse(connectionId, 'watcher_decisions', { success: true, ...result });
  }

  private async handleWatcherInspect(connectionId: string, data: Record<string, unknown> | undefined, state: ConnectionState): Promise<void> {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'watcher_inspect', { success: false, error: 'No active session' });
      return;
    }
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      this.sendAuthResponse(connectionId, 'watcher_inspect', { success: false, error: 'Missing decision id' });
      return;
    }
    const result = await this.harness.watcherInspect?.(sessionKey, id) ?? { error: 'Not supported' };
    this.sendAuthResponse(connectionId, 'watcher_inspect', { success: true, ...result });
  }

  private handleWatcherMemory(connectionId: string, state: ConnectionState): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'watcher_memory', { success: false, error: 'No active session' });
      return;
    }
    const result = this.harness.watcherMemory?.(sessionKey) ?? { error: 'Not supported' };
    this.sendAuthResponse(connectionId, 'watcher_memory', { success: true, ...result });
  }

  private handleWatcherFocus(connectionId: string, data: Record<string, unknown> | undefined, state: ConnectionState): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'watcher_focus', { success: false, error: 'No active session' });
      return;
    }
    const topic = typeof data?.topic === 'string' ? data.topic : '';
    if (!topic) {
      this.sendAuthResponse(connectionId, 'watcher_focus', { success: false, error: 'Missing topic' });
      return;
    }
    const result = this.harness.watcherFocus?.(sessionKey, topic) ?? { error: 'Not supported' };
    this.sendAuthResponse(connectionId, 'watcher_focus', { success: true, ...result });
  }

  private handleWatcherDefocus(connectionId: string, state: ConnectionState): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'watcher_defocus', { success: false, error: 'No active session' });
      return;
    }
    const result = this.harness.watcherDefocus?.(sessionKey) ?? { error: 'Not supported' };
    this.sendAuthResponse(connectionId, 'watcher_defocus', { success: true, ...result });
  }

  private handleWatcherReanchor(connectionId: string, data: Record<string, unknown> | undefined, state: ConnectionState): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'watcher_reanchor', { success: false, error: 'No active session' });
      return;
    }
    const goal = typeof data?.goal === 'string' ? data.goal : '';
    if (!goal) {
      this.sendAuthResponse(connectionId, 'watcher_reanchor', { success: false, error: 'Missing goal' });
      return;
    }
    const result = this.harness.watcherReanchor?.(sessionKey, goal) ?? { error: 'Not supported' };
    this.sendAuthResponse(connectionId, 'watcher_reanchor', { success: true, ...result });
  }

  private handleWatcherSummarize(connectionId: string, state: ConnectionState): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendAuthResponse(connectionId, 'watcher_summarize', { success: false, error: 'No active session' });
      return;
    }
    const result = this.harness.watcherSummarize?.(sessionKey) ?? { error: 'Not supported' };
    this.sendAuthResponse(connectionId, 'watcher_summarize', { success: true, ...result });
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
    const state: ConnectionState = { sessionKey: null, lastSessionKey: null, workingDir: null, activeRequestId: null, planMode: false, ralphLoop: null, asyncRun: null };
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
