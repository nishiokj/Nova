/**
 * BridgeGateway - Routes bridge commands from the bus to the harness.
 */

import path from 'path';
import { type BusServer, BRIDGE_COMMAND_CHANNEL, runChannel, sessionChannel } from 'comms-bus';
import { profiler } from 'shared';
import type { AgentRunHandle, BridgeEvent } from './types.js';
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
import { createRalphStopHook, type RalphCompletionReason, type RalphLoopState } from 'orchestrator';
import type { PermissionChecker } from './permissions.js';

interface BridgeCommand {
  type: string;
  data?: Record<string, unknown>;
}

interface HarnessLike {
  run(params: {
    requestId: string;
    inputText: string;
    tier?: 'simple' | 'standard' | 'complex';
    sessionKey: string;
    workingDir: string;
    context?: string;
    planMode?: boolean;
    stopHook?: import('orchestrator').StopHookHandler;
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
  getGraphD?(): import('graphd').GraphDManager | null;
  closeSession?(sessionKey: string): void;
  forkSession?(sourceSessionKey: string, targetSessionKey: string): { success: boolean; error?: string };
  compactContext?(sessionKey: string): { success: boolean; itemsRemoved: number; bytesRecovered: number; error?: string };
  getPermissionChecker?(): PermissionChecker;
}

interface RalphLoopInfo {
  requestId: string;
  cancelled: boolean;
}

interface ConnectionState {
  sessionKey: string | null;
  workingDir: string | null;
  activeRequestId: string | null;
  planMode: boolean;
  ralphLoop: RalphLoopInfo | null;
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
    if (state?.sessionKey) {
      // Mark session as inactive (recoverable) on disconnect
      const graphd = this.harness.getGraphD?.();
      if (graphd) {
        graphd.sessionUpdateStatus(state.sessionKey, 'inactive');
      }
      this.harness.closeSession?.(state.sessionKey);
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

    if (!payload || typeof payload !== 'object') {
      this.sendError(connectionId, 'Invalid bridge command payload');
      return;
    }

    const command = payload as BridgeCommand;
    const state = this.getOrCreateConnectionState(connectionId);

    profiler.begin(`cmd:${command.type}`, 'bridge');
    try {
      switch (command.type) {
        case 'init':
          this.handleInit(connectionId, command.data, state);
          return;
        case 'send_text':
          this.handleSendText(connectionId, command.data, state);
          return;
        case 'user_prompt_response':
          this.handleUserPromptResponse(connectionId, command.data, state);
          return;
        case 'get_config':
          this.handleGetConfig(connectionId, state);
          return;
        case 'get_status':
          this.handleGetStatus(connectionId);
          return;
        case 'get_models':
          this.handleGetModels(connectionId);
          return;
        case 'models_delete':
          this.handleModelsDelete(connectionId, command.data, state);
          return;
        case 'skills_list':
          this.handleSkillsList(connectionId);
          return;
        case 'skills_get':
          this.handleSkillsGet(connectionId, command.data);
          return;
        case 'skills_create':
          this.handleSkillsCreate(connectionId, command.data);
          return;
        case 'skills_update':
          this.handleSkillsUpdate(connectionId, command.data);
          return;
        case 'skills_delete':
          this.handleSkillsDelete(connectionId, command.data);
          return;
        case 'skills_enable':
          this.handleSkillsEnable(connectionId, command.data, true);
          return;
        case 'skills_disable':
          this.handleSkillsEnable(connectionId, command.data, false);
          return;
        case 'skills_run':
          // Skills run is deferred - skills are instructions injected into prompts
          this.handleDeferredResponse(connectionId, command.type);
          return;
        case 'voice_start':
        case 'voice_stop':
          this.sendEvent(connectionId, {
            type: 'error',
            data: { message: 'Voice is not yet supported in TypeScript mode', fatal: false },
          });
          return;
        case 'hooks_list':
          this.handleHooksList(connectionId);
          return;
        case 'hooks_get':
          this.handleHooksGet(connectionId, command.data);
          return;
        case 'hooks_create':
          this.handleHooksCreate(connectionId, command.data);
          return;
        case 'hooks_update':
          this.handleHooksUpdate(connectionId, command.data);
          return;
        case 'hooks_delete':
          this.handleHooksDelete(connectionId, command.data);
          return;
        case 'hooks_enable':
          this.handleHooksEnable(connectionId, command.data, true);
          return;
        case 'hooks_disable':
          this.handleHooksEnable(connectionId, command.data, false);
          return;
        // Auth commands
        case 'auth_start':
          this.handleAuthStart(connectionId, command.data);
          return;
        case 'auth_poll':
          this.handleAuthPoll(connectionId, command.data);
          return;
        case 'auth_verify':
          this.handleAuthVerify(connectionId, command.data);
          return;
        case 'auth_logout':
          this.handleAuthLogout(connectionId, command.data);
          return;
        case 'providers_list':
          this.handleProvidersList(connectionId, command.data);
          return;
        case 'providers_save':
          this.handleProvidersSave(connectionId, command.data);
          return;
        case 'providers_delete':
          this.handleProvidersDelete(connectionId, command.data);
          return;
        case 'providers_test':
          void this.handleProvidersTest(connectionId, command.data);
          return;
        case 'session_fork':
          this.handleSessionFork(connectionId, state);
          return;
        case 'session_close':
          this.handleSessionClose(connectionId, state);
          return;
        case 'list_sessions':
          this.handleListSessions(connectionId, command.data, state);
          return;
        case 'compact_context':
          this.handleCompactContext(connectionId, state);
          return;
        case 'set_model':
          this.handleSetModel(connectionId, command.data, state);
          return;
        case 'get_model':
          this.handleGetModel(connectionId, command.data, state);
          return;
        case 'ralph_loop_start':
          this.handleRalphLoopStart(connectionId, command.data, state);
          return;
        case 'ralph_loop_cancel':
          this.handleRalphLoopCancel(connectionId, state);
          return;
        case 'permission_response':
          this.handlePermissionResponse(connectionId, command.data);
          return;
        case 'shutdown':
          this.sendError(connectionId, 'Shutdown is not supported via bridge');
          return;
        default:
          this.sendError(connectionId, `Unknown command type: ${command.type}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendEvent(connectionId, createErrorEvent(message, false));
    } finally {
      profiler.end(`cmd:${command.type}`, 'bridge');
    }
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

    // CRITICAL: Mark old session as inactive BEFORE switching to new one
    // This fixes the bug where switched-from sessions stay "active" forever
    const graphd = this.harness.getGraphD?.();
    if (state.sessionKey && state.sessionKey !== sessionKey) {
      if (graphd) {
        graphd.sessionUpdateStatus(state.sessionKey, 'inactive');
      }
      this.harness.closeSession?.(state.sessionKey);
    }

    state.sessionKey = sessionKey;

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

    const readyEvent = this.harness.createReadyEvent(sessionKey);
    this.sendEvent(connectionId, readyEvent, sessionChannel(sessionKey));

    // Load and emit per-agent-type model selections if available
    if (graphd) {
      this.hydrateSessionModelSelections(sessionKey);

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

  private hydrateSessionModelSelections(sessionKey: string): void {
    const graphd = this.harness.getGraphD?.();
    if (!graphd) {
      return;
    }

    const hiddenModels = graphd.getUserPreference<string[]>('user_prefs:hidden_models') ?? [];
    const modelSelectionsMap = graphd.getUserPreference<Record<string, { provider: string; model: string; reasoning?: string }>>('user_prefs:model_selections');

    if (!modelSelectionsMap) {
      return;
    }

    for (const [agentType, selection] of Object.entries(modelSelectionsMap)) {
      if (selection?.provider && selection?.model) {
        const isHidden = hiddenModels.some((hidden) => hidden.trim().toLowerCase() === selection.model.trim().toLowerCase());
        if (!isHidden) {
          this.harness.setSessionSelectedModel?.(sessionKey, agentType, selection);
        }
      }
    }
    graphd.sessionUpdateMetadata(sessionKey, { model_selections: modelSelectionsMap });
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
    // Check 'standard' agent type selection - this is the main/default that must be set
    const activeSelection = this.harness.getSessionSelectedModel?.(sessionKey, 'standard');
    if (!activeSelection?.model || !activeSelection?.provider) {
      this.sendError(connectionId, 'No model selected. Use /models to choose one before sending a message.');
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

    // Per-request working_dir takes precedence over init-time state, which takes precedence over daemon default
    const requestWorkingDir = typeof data?.working_dir === 'string' && data.working_dir.length > 0
      ? data.working_dir
      : null;
    const workingDir = requestWorkingDir ?? state.workingDir ?? this.workingDir;

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
    const tier = rawTier && rawTier !== 'auto' ? rawTier : undefined;

    // Extract planMode from command data
    const planMode = typeof data?.plan_mode === 'boolean' ? data.plan_mode : state.planMode;
    state.planMode = planMode;

    state.activeRequestId = clientRequestId;

    profiler.instant('harness.run:start', 'harness', 'p', { requestId: clientRequestId, tier });
    const handle = this.harness.run({
      requestId: clientRequestId,
      inputText: text,
      ...(tier ? { tier: tier as 'simple' | 'standard' | 'complex' } : {}),
      sessionKey,
      workingDir,
      planMode,
    });

    this.streamRunEvents(clientRequestId, handle);
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
    const answer = data?.answer;
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
    this.streamRunEvents(requestId, handle);
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

    const graphd = this.harness.getGraphD?.();
    if (graphd) {
      graphd.sessionUpdateStatus(sessionKey, 'inactive');
    }

    this.harness.closeSession?.(sessionKey);

    // Clear the connection's session reference
    state.sessionKey = null;

    this.sendAuthResponse(connectionId, 'session_close', {
      success: true,
      sessionKey,
      message: 'Session marked inactive',
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

    // Use provided workingDir or fall back to connection's workingDir
    const workingDir = typeof data?.workingDir === 'string' ? data.workingDir : state.workingDir;

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

    if (returnAll) {
      const existingSelections = this.harness.getAllSessionSelectedModels?.(sessionKey) ?? new Map();
      if (existingSelections.size === 0) {
        this.hydrateSessionModelSelections(sessionKey);
      }
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
    if (!selectedModel) {
      this.hydrateSessionModelSelections(sessionKey);
      selectedModel = this.harness.getSessionSelectedModel?.(sessionKey, agentType) ?? null;
    }

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

    // Check if already running a Ralph loop
    if (state.ralphLoop) {
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

    // Create Ralph loop tracking state
    state.ralphLoop = {
      requestId,
      cancelled: false,
    };
    state.activeRequestId = requestId;

    // Create Ralph stop hook with callbacks
    const ralphState = state.ralphLoop;
    const stopHook = createRalphStopHook({
      prompt,
      maxIterations,
      completionPromise,
      onIteration: (loopState: RalphLoopState) => {
        // Check if cancelled
        if (ralphState.cancelled) {
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
        // Clear Ralph loop state
        state.ralphLoop = null;

        // Emit completion response
        this.sendEvent(connectionId, {
          type: 'response',
          data: {
            success: reason === 'promise_detected',
            content: '',
            metadata: {
              kind: 'ralph_loop_complete',
              payload: {
                reason,
                iterations: loopState.iteration,
                lastResponse: loopState.lastResponse.slice(0, 500), // Truncate for summary
              },
            },
          },
        }, sessionChannel(sessionKey));
      },
    });

    // Start the harness run with the Ralph stop hook
    const handle = this.harness.run({
      requestId,
      inputText: prompt,
      sessionKey,
      workingDir,
      planMode: state.planMode,
      stopHook,
    });

    this.streamRunEvents(requestId, handle);
  }

  private handleRalphLoopCancel(connectionId: string, state: ConnectionState): void {
    if (!state.ralphLoop) {
      this.sendError(connectionId, 'No Ralph Loop is currently running.');
      return;
    }

    // Mark as cancelled
    state.ralphLoop.cancelled = true;

    // Clear Ralph loop state
    const iterations = 0; // We don't track exact iteration count here
    const sessionKey = state.sessionKey;
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

    const checker = this.harness.getPermissionChecker?.();
    if (!checker) {
      this.sendError(connectionId, 'Permission checker not available');
      return;
    }

    // Handle the response - this resolves the pending promise in harness
    checker.handleResponse({
      requestId,
      decision: decision as 'allow' | 'always_allow' | 'deny',
      pattern,
    });
  }

  private streamRunEvents(requestId: string, handle: AgentRunHandle): void {
    const channel = runChannel(requestId);
    const asyncId = profiler.asyncBegin(`stream:${requestId}`, 'stream');

    void (async () => {
      let eventCount = 0;
      try {
        for await (const event of handle.events) {
          eventCount++;
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
          await handle.result;
        } catch {
          // Errors are already emitted via events.
        }
        profiler.asyncEnd(`stream:${requestId}`, asyncId, 'stream', { eventCount });
      }
    })();
  }

  private getOrCreateConnectionState(connectionId: string): ConnectionState {
    const existing = this.connections.get(connectionId);
    if (existing) return existing;
    const state: ConnectionState = { sessionKey: null, workingDir: null, activeRequestId: null, planMode: false, ralphLoop: null };
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
