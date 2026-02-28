import { sessionChannel } from 'comms-bus';
import type { AgentRunHandle, AgentRunResult, BridgeEvent } from './types.js';
import type { AuthService } from './auth_service.js';
import { LocalProviderManager } from './local_providers.js';
import { GATEWAY_MODEL_PROVIDERS, getAllModels, isOpenAICompatProvider, toGatewayModel } from 'types';
import { deleteSession, getTokenUsage, listSessions } from './session_queries.js';
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
import { RpcHandlerError } from './rpc_dispatcher.js';
import type { HarnessLike } from './bridge_gateway.js';

const GATEWAY_PROVIDER_ID = 'vercel-gateway';

interface PersistedModelSelection {
  provider: string;
  model: string;
  reasoning?: string;
}

export interface RpcConnectionState {
  sessionKey: string | null;
  lastSessionKey: string | null;
  workingDir: string | null;
  activeRequestId: string | null;
  asyncRun: {
    requestId: string;
    goal: string;
    cancelled: boolean;
    startedAt: number;
  } | null;
}

interface RpcMethodHandlerDeps {
  harness: HarnessLike;
  authService: AuthService | null;
  localProviders: LocalProviderManager | null;
  workingDir: string;
  skillsDir: string;
  hooksDir: string;
  sessionOwners: Map<string, string>;
  getOrCreateConnectionState: (connectionId: string) => RpcConnectionState;
  sendEvent: (connectionId: string, event: BridgeEvent, channel?: string) => void;
  streamRunEvents: (
    requestId: string,
    handle: AgentRunHandle,
    onComplete?: (result?: AgentRunResult) => void,
    sessionKey?: string
  ) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class RpcMethodHandlers {
  private readonly harness: HarnessLike;
  private readonly authService: AuthService | null;
  private readonly localProviders: LocalProviderManager | null;
  private readonly workingDir: string;
  private readonly skillsDir: string;
  private readonly hooksDir: string;
  private readonly sessionOwners: Map<string, string>;
  private readonly getOrCreateConnectionState: (connectionId: string) => RpcConnectionState;
  private readonly emitEvent: (connectionId: string, event: BridgeEvent, channel?: string) => void;
  private readonly streamEvents: (
    requestId: string,
    handle: AgentRunHandle,
    onComplete?: (result?: AgentRunResult) => void,
    sessionKey?: string
  ) => void;

  constructor(deps: RpcMethodHandlerDeps) {
    this.harness = deps.harness;
    this.authService = deps.authService;
    this.localProviders = deps.localProviders;
    this.workingDir = deps.workingDir;
    this.skillsDir = deps.skillsDir;
    this.hooksDir = deps.hooksDir;
    this.sessionOwners = deps.sessionOwners;
    this.getOrCreateConnectionState = deps.getOrCreateConnectionState;
    this.emitEvent = deps.sendEvent;
    this.streamEvents = deps.streamRunEvents;
  }
  private handleGetConfig(state: RpcConnectionState): Record<string, unknown> {
    const config = this.harness.getConfig();
    const defaultAgent = config.agents[config.defaultAgent];

    return {
      success: true,
      llm_provider: defaultAgent?.llm.provider ?? 'unknown',
      model: defaultAgent?.llm.model ?? 'unknown',
      default_agent: config.defaultAgent,
      agent_count: Object.keys(config.agents).length,
      graphd_enabled: config.graphd.enabled,
      skills_enabled: config.skills.enabled,
      hooks_enabled: config.hooks.enabled,
      ...(state.sessionKey ? { session_key: state.sessionKey } : {}),
    };
  }

  private handleGetStatus(): Record<string, unknown> {
    return {
      success: true,
      state: this.harness.isShuttingDown() ? 'error' : 'idle',
      message: 'Ready',
    };
  }

  private handleGetModels(): Record<string, unknown> {
    const config = this.harness.getConfig();
    const graphd = this.harness.getGraphD?.();

    // Get hidden models from user preferences
    const hiddenModels = (graphd?.getUserPreference?.('user_prefs:hidden_models') ?? []) as string[];
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

    return {
      success: true,
      // Only surface models that are currently accessible/configured.
      // Keeps /models UI and Esc+M cycling aligned with configured providers.
      models: availableModels,
      available: availableModels,
      default: config.models.default,
    };
  }

  private handleModelsDelete(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: RpcConnectionState
  ): Record<string, unknown> {
    // TUI sends 'model' (model ID), accept both 'model' and 'model_id' for flexibility
    const modelId = typeof data?.model === 'string' ? data.model : (typeof data?.model_id === 'string' ? data.model_id : '');
    if (!modelId) {
      return {
        success: false,
        error: 'Missing model',
      };
    }

    const graphd = this.harness.getGraphD?.();
    if (!graphd) {
      return {
        success: false,
        error: 'GraphD not available',
      };
    }

    // Get current hidden models and add the new one
    const hiddenModels = (graphd.getUserPreference?.('user_prefs:hidden_models') ?? []) as string[];
    if (!hiddenModels.includes(modelId)) {
      hiddenModels.push(modelId);
      graphd.setUserPreference('user_prefs:hidden_models', hiddenModels);
    }

    const sessionKey = state.sessionKey;
    const normalizedModelId = modelId.trim().toLowerCase();
    const clearedAgentTypes: string[] = [];

    // Clear from model_selections user preference if any agent type matches
    const modelSelections = (
      graphd.getUserPreference?.('user_prefs:model_selections') ?? {}
    ) as Record<string, { provider?: string; model?: string; reasoning?: string }>;
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

    return {
      success: true,
      model: modelId,
      clearedAgentTypes,
    };
  }

  private handleSkillsList(): Record<string, unknown> {
    try {
      const skills = loadSkillDefinitions(this.skillsDir);
      return {
        success: true,
        action: 'list',
        items: skills,
        errors: [],
      };
    } catch (error) {
      return {
        success: true,
        action: 'list',
        items: [],
        errors: [String(error)],
      };
    }
  }

  private handleHooksList(): Record<string, unknown> {
    try {
      const hooks = loadHookDefinitions(this.hooksDir);
      return {
        success: true,
        action: 'list',
        items: hooks,
        errors: [],
      };
    } catch (error) {
      return {
        success: true,
        action: 'list',
        items: [],
        errors: [String(error)],
      };
    }
  }

  // =========================================================================
  // Skills CRUD Handlers
  // =========================================================================

  private handleSkillsGet(data: Record<string, unknown> | undefined): Record<string, unknown> {
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      return { action: 'get', success: false, error: 'Missing skill id' };
    }

    const skill = getSkillDefinition(this.skillsDir, id);
    if (!skill) {
      return { action: 'get', success: false, error: `Skill '${id}' not found` };
    }

    return { action: 'get', success: true, skill };
  }

  private handleSkillsCreate(data: Record<string, unknown> | undefined): Record<string, unknown> {
    const skill = data?.skill as SkillInput | undefined;
    if (!skill?.name || !skill?.instructions) {
      return { action: 'create', success: false, error: 'Missing required fields: name, instructions' };
    }

    const result = createSkill(this.skillsDir, skill);
    return { action: 'create', ...result };
  }

  private handleSkillsUpdate(data: Record<string, unknown> | undefined): Record<string, unknown> {
    const id = typeof data?.id === 'string' ? data.id : '';
    const updates = data?.updates as Partial<SkillInput> | undefined;

    if (!id) {
      return { action: 'update', success: false, error: 'Missing skill id' };
    }

    const result = updateSkill(this.skillsDir, id, updates ?? {});
    return { action: 'update', ...result };
  }

  private handleSkillsDelete(data: Record<string, unknown> | undefined): Record<string, unknown> {
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      return { action: 'delete', success: false, error: 'Missing skill id' };
    }

    const result = deleteSkill(this.skillsDir, id);
    return { action: 'delete', ...result };
  }

  private handleSkillsEnable(data: Record<string, unknown> | undefined, enabled: boolean): Record<string, unknown> {
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      return { action: enabled ? 'enable' : 'disable', success: false, error: 'Missing skill id' };
    }

    const result = setSkillEnabled(this.skillsDir, id, enabled);
    return { action: enabled ? 'enable' : 'disable', ...result };
  }

  // =========================================================================
  // Hooks CRUD Handlers
  // =========================================================================

  private handleHooksGet(data: Record<string, unknown> | undefined): Record<string, unknown> {
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      return { action: 'get', success: false, error: 'Missing hook id' };
    }

    const hook = getHookDefinition(this.hooksDir, id);
    if (!hook) {
      return { action: 'get', success: false, error: `Hook '${id}' not found` };
    }

    return { action: 'get', success: true, hook };
  }

  private handleHooksCreate(data: Record<string, unknown> | undefined): Record<string, unknown> {
    const hook = data?.hook as HookInput | undefined;
    if (!hook?.name || !hook?.trigger || !hook?.hooks) {
      return { action: 'create', success: false, error: 'Missing required fields: name, trigger, hooks' };
    }

    const result = createHook(this.hooksDir, hook);
    return { action: 'create', ...result };
  }

  private handleHooksUpdate(data: Record<string, unknown> | undefined): Record<string, unknown> {
    const id = typeof data?.id === 'string' ? data.id : '';
    const updates = data?.updates as Partial<HookInput> | undefined;

    if (!id) {
      return { action: 'update', success: false, error: 'Missing hook id' };
    }

    const result = updateHook(this.hooksDir, id, updates ?? {});
    return { action: 'update', ...result };
  }

  private handleHooksDelete(data: Record<string, unknown> | undefined): Record<string, unknown> {
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      return { action: 'delete', success: false, error: 'Missing hook id' };
    }

    const result = deleteHook(this.hooksDir, id);
    return { action: 'delete', ...result };
  }

  private handleHooksEnable(data: Record<string, unknown> | undefined, enabled: boolean): Record<string, unknown> {
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      return { action: enabled ? 'enable' : 'disable', success: false, error: 'Missing hook id' };
    }

    const result = setHookEnabled(this.hooksDir, id, enabled);
    return { action: enabled ? 'enable' : 'disable', ...result };
  }

  private handleDeferredResponse(commandType: string): Record<string, unknown> {
    return {
      action: commandType,
      success: true,
    };
  }

  // =========================================================================
  // Auth Handlers
  // =========================================================================

  private handleAuthStart(data: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!this.authService) {
      return {
        success: false,
        error: 'Auth service not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
      };
    }

    const deviceName = typeof data?.device === 'string' ? data.device : undefined;
    const result = this.authService.startAuth(deviceName);

    return {
      success: true,
      authUrl: result.authUrl,
      stateToken: result.stateToken,
    };
  }

  private handleAuthPoll(data: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!this.authService) {
      return { success: false, error: 'Auth not configured' };
    }

    const stateToken = typeof data?.stateToken === 'string' ? data.stateToken : '';
    if (!stateToken) {
      return { success: false, error: 'Missing stateToken' };
    }

    const result = this.authService.pollSession(stateToken);
    return { success: true, ...result };
  }

  private handleAuthVerify(data: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!this.authService) {
      return { success: false, valid: false };
    }

    const sessionToken = typeof data?.sessionToken === 'string' ? data.sessionToken : '';
    if (!sessionToken) {
      return { success: false, valid: false };
    }

    const result = this.authService.verifySession(sessionToken);
    return { success: true, ...result };
  }

  private handleAuthLogout(data: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!this.authService) {
      return { success: false };
    }

    const sessionToken = typeof data?.sessionToken === 'string' ? data.sessionToken : '';
    const loggedOut = sessionToken ? this.authService.logout(sessionToken) : false;
    return { success: loggedOut };
  }

  private handleProvidersList(_data: Record<string, unknown> | undefined): Record<string, unknown> {
    // Use local provider manager (no auth required)
    if (this.localProviders) {
      const result = this.localProviders.listProviders();
      return result;
    }

    // Fallback to auth service if configured
    if (this.authService) {
      const sessionToken = typeof _data?.sessionToken === 'string' ? _data.sessionToken : '';
      if (!sessionToken) {
        return { success: false, error: 'Missing sessionToken' };
      }
      const result = this.authService.listProviders(sessionToken);
      return result;
    }

    return { success: false, error: 'Provider management not configured' };
  }

  private handleProvidersSave(data: Record<string, unknown> | undefined): Record<string, unknown> {
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
      return { success: false, error: 'Missing provider or apiKey' };
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

      return result;
    }

    // Fallback to auth service if configured
    if (this.authService) {
      const sessionToken = typeof data?.sessionToken === 'string' ? data.sessionToken : '';
      if (!sessionToken) {
        return { success: false, error: 'Missing sessionToken' };
      }
      const result = this.authService.saveProviderKey(sessionToken, provider, apiKey);

      // If save succeeded, also update the running LLM adapter
      if (result.success && this.harness.updateApiKey) {
        const canonicalProvider = isOpenAICompatProvider(provider) ? 'openai-compat' : provider;
        this.harness.updateApiKey(canonicalProvider, apiKey);
      }

      return result;
    }

    return { success: false, error: 'Provider management not configured' };
  }

  private handleProvidersDelete(data: Record<string, unknown> | undefined): Record<string, unknown> {
    const provider = typeof data?.provider === 'string' ? data.provider : '';

    if (!provider) {
      return { success: false, error: 'Missing provider' };
    }

    // Use local provider manager (no auth required)
    if (this.localProviders) {
      const result = this.localProviders.deleteProviderKey(provider);
      return result;
    }

    // Fallback to auth service if configured
    if (this.authService) {
      const sessionToken = typeof data?.sessionToken === 'string' ? data.sessionToken : '';
      if (!sessionToken) {
        return { success: false, error: 'Missing sessionToken' };
      }
      const result = this.authService.deleteProviderKey(sessionToken, provider);
      return result;
    }

    return { success: false, error: 'Provider management not configured' };
  }

  private async handleProvidersTest(data: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    const provider = typeof data?.provider === 'string' ? data.provider : '';

    if (!provider) {
      return { success: false, error: 'Missing provider' };
    }

    // Use local provider manager (no auth required)
    if (this.localProviders) {
      const result = await this.localProviders.testProviderKey(provider);
      return result;
    }

    // Fallback to auth service if configured
    if (this.authService) {
      const sessionToken = typeof data?.sessionToken === 'string' ? data.sessionToken : '';
      if (!sessionToken) {
        return { success: false, error: 'Missing sessionToken' };
      }
      const result = await this.authService.testProviderKey(sessionToken, provider);
      return { success: true, ...result };
    }

    return { success: false, error: 'Provider management not configured' };
  }

  private sendMetadataResponse(connectionId: string, kind: string, payload: Record<string, unknown>): void {
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

  private handleSessionFork(state: RpcConnectionState): Record<string, unknown> {
    const sourceSessionKey = state.sessionKey;
    if (!sourceSessionKey) {
      return {
        success: false,
        error: 'No active session to fork',
      };
    }

    if (!this.harness.forkSession) {
      return {
        success: false,
        error: 'Fork not supported by harness',
      };
    }

    const newSessionKey = generateSessionKey();
    const result = this.harness.forkSession(sourceSessionKey, newSessionKey);

    return {
      success: result.success,
      sourceSessionKey,
      newSessionKey: result.success ? newSessionKey : undefined,
      error: result.error,
    };
  }

  // =========================================================================
  // Session Close Handler
  // =========================================================================

  private handleSessionClose(connectionId: string, state: RpcConnectionState): Record<string, unknown> {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      return {
        success: true,
        message: 'No active session to close',
      };
    }

    // Release session ownership
    if (this.sessionOwners.get(sessionKey) === connectionId) {
      this.sessionOwners.delete(sessionKey);
    }

    // closeSession handles persist + marking inactive
    const closeResult = this.harness.closeSession?.(sessionKey);
    if (closeResult && closeResult.success === false) {
      return {
        success: false,
        sessionKey,
        error: closeResult.error ?? 'Failed to close session',
        ...(closeResult.executingRequestId ? { activeRequestId: closeResult.executingRequestId } : {}),
      };
    }

    // Clear the connection's session and async references
    state.sessionKey = null;
    state.asyncRun = null;

    return {
      success: true,
      sessionKey,
      message: 'Session closed and persisted',
    };
  }

  // =========================================================================
  // List Sessions Handler
  // =========================================================================

  private handleListSessions(
    data: Record<string, unknown> | undefined,
    _state: RpcConnectionState
  ): Record<string, unknown> {
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

    return {
      success: result.success,
      sessions: result.sessions,
      error: result.error,
    };
  }

  private handleSessionDelete(data: Record<string, unknown> | undefined): Record<string, unknown> {
    const sessionKey = typeof data?.sessionKey === 'string'
      ? data.sessionKey
      : typeof data?.session_key === 'string'
        ? data.session_key
        : '';
    if (!sessionKey) {
      return {
        success: false,
        deleted: false,
        error: 'sessionKey is required',
      };
    }

    const graphd = this.harness.getGraphD?.() ?? null;
    const result = deleteSession(graphd, sessionKey);
    return {
      success: result.success,
      deleted: result.deleted,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  private handleUsageSummary(data: Record<string, unknown> | undefined): Record<string, unknown> {
    const limit = typeof data?.limit === 'number' ? data.limit : 1000;
    const status = Array.isArray(data?.status)
      ? data.status as string[]
      : typeof data?.status === 'string'
        ? data.status
        : undefined;

    const graphd = this.harness.getGraphD?.() ?? null;
    const result = getTokenUsage(graphd, { limit, status });
    return {
      success: result.success,
      usage: result.usage,
      sessions: result.sessions,
      error: result.error,
    };
  }

  // =========================================================================
  // Context Compaction Handler
  // =========================================================================

  private handleCompactContext(state: RpcConnectionState): Record<string, unknown> {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      return {
        success: false,
        error: 'No active session to compact',
      };
    }

    if (!this.harness.compactContext) {
      return {
        success: false,
        error: 'Context compaction not supported by harness',
      };
    }

    const result = this.harness.compactContext(sessionKey);

    return {
      success: result.success,
      itemsRemoved: result.itemsRemoved,
      bytesRecovered: result.bytesRecovered,
      error: result.error,
    };
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
    const globalSelections = (
      graphd.getUserPreference?.('user_prefs:model_selections') ?? {}
    ) as Record<string, PersistedModelSelection>;
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
    _sessionKey: string,
    _fallbackSelection: PersistedModelSelection
  ): void {
    // No companion agents to configure
  }

  private isSameSelection(
    a: PersistedModelSelection | null | undefined,
    b: PersistedModelSelection | null | undefined
  ): boolean {
    if (!a || !b) {
      return false;
    }
    return (
      a.provider === b.provider
      && a.model === b.model
      && (a.reasoning ?? null) === (b.reasoning ?? null)
    );
  }

  /**
   * Keep companion agent selections aligned with standard when they still track
   * the previous standard selection. This prevents stale seeded companions
   * (for example lmstudio) from diverging silently after the user changes standard.
   */
  private syncCompanionSelectionsForStandard(
    connectionId: string,
    sessionKey: string,
    selectedModel: PersistedModelSelection,
    previousStandard: PersistedModelSelection | null
  ): void {
    const companionAgentTypes = ['explorer', 'coding'];

    for (const companionAgentType of companionAgentTypes) {
      const currentSelection = this.harness.getSessionSelectedModel?.(sessionKey, companionAgentType) as PersistedModelSelection | null | undefined;
      const shouldSync = !currentSelection || this.isSameSelection(currentSelection, previousStandard);
      if (!shouldSync) {
        continue;
      }

      this.harness.setSessionSelectedModel?.(sessionKey, companionAgentType, selectedModel);
      this.persistModelSelection(sessionKey, companionAgentType, selectedModel);
      this.sendEvent(connectionId, {
        type: 'model_changed',
        data: {
          agentType: companionAgentType,
          selectedModel: selectedModel.model,
          selectedProvider: selectedModel.provider,
          provider: selectedModel.provider,
          model: selectedModel.model,
          reasoning: selectedModel.reasoning ?? null,
        },
      });
    }
  }

  private handleSetModel(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: RpcConnectionState
  ): Record<string, unknown> {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      return {
        success: false,
        error: 'No active session',
      };
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
      const responsePayload = {
        success: true,
        selected_model: null,
        message: 'All model selections cleared',
      };
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
      return responsePayload;
    }

    if (!provider) {
      return {
        success: false,
        error: 'Provider is required',
      };
    }

    if (!model) {
      return {
        success: false,
        error: 'Model is required',
      };
    }

    const previousStandardSelection = agentType === 'standard'
      ? (this.harness.getSessionSelectedModel?.(sessionKey, 'standard') as PersistedModelSelection | null | undefined) ?? null
      : null;

    // Store selected model for this agent type
    const selectedModel = reasoning ? { provider, model, reasoning } : { provider, model };
    this.harness.setSessionSelectedModel?.(sessionKey, agentType, selectedModel);
    this.persistModelSelection(sessionKey, agentType, selectedModel);

    if (agentType === 'standard') {
      this.syncCompanionSelectionsForStandard(
        connectionId,
        sessionKey,
        selectedModel,
        previousStandardSelection
      );
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

    return {
      success: true,
      agent_type: agentType,
      selected_model: selectedModel,
      provider_key_required: !hasKey,
    };
  }

  private handleGetModel(
    data: Record<string, unknown> | undefined,
    state: RpcConnectionState
  ): Record<string, unknown> {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      return {
        success: false,
        error: 'No active session',
      };
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

      return {
        success: true,
        model_selections: selectionsObject,
      };
    }

    // Return selection for specific agent type
    let selectedModel = this.harness.getSessionSelectedModel?.(sessionKey, agentType) ?? null;

    return {
      success: true,
      agent_type: agentType,
      selectedModel: selectedModel?.model ?? null,
      selectedProvider: selectedModel?.provider ?? null,
      provider: selectedModel?.provider ?? null,
      model: selectedModel?.model ?? null,
      reasoning: selectedModel?.reasoning ?? null,
    };
  }

  private handleSetDangerousMode(
    connectionId: string,
    data: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    const state = this.getOrCreateConnectionState(connectionId);
    const sessionKey = state.sessionKey;

    if (!sessionKey) {
      throw new RpcHandlerError(400, 'Session not initialized');
    }

    const enabled = data?.enabled === true;

    // Get the session's permission checker - each session has its own dangerous mode
    const sessionChecker = this.harness.getSessionPermissionChecker?.(sessionKey);
    if (!sessionChecker) {
      throw new RpcHandlerError(400, 'Permission checker not available for session');
    }

    // Set dangerous mode for this session only
    sessionChecker.setDangerousMode(enabled);

    return {
      success: true,
      enabled,
      sessionKey,
    };
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
    _connectionId: string,
    data: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    const sessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    const message = typeof data?.message === 'string' ? data.message : '';
    const context = typeof data?.context === 'string' ? data.context : undefined;
    const requestId = typeof data?.request_id === 'string' ? data.request_id : undefined;
    const workingDir = typeof data?.working_dir === 'string' ? data.working_dir : undefined;
    const metadata = isRecord(data?.metadata) ? data.metadata : undefined;

    if (!sessionKey) {
      return { success: false, error: 'Missing session_key' };
    }
    if (!message.trim()) {
      return { success: false, error: 'Missing message' };
    }

    const result = this.dispatchControlPlaneMessage({
      sessionKey,
      message,
      context,
      metadata,
      requestId,
      workingDir,
    });
    return result;
  }

  private async handleControlPlaneStop(
    _connectionId: string,
    data: Record<string, unknown> | undefined
  ): Promise<Record<string, unknown>> {
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
      return { success: false, error: 'Missing session_key' };
    }

    if (!this.harness.controlSessionExecution) {
      return {
        success: false,
        error: 'Runtime control is not supported by this harness',
      };
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
    return result;
  }

  private handleControlPlaneFork(
    _connectionId: string,
    data: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    const sourceSessionKey = typeof data?.source_session_key === 'string'
      ? data.source_session_key.trim()
      : '';
    const targetSessionKey = typeof data?.target_session_key === 'string'
      ? data.target_session_key.trim()
      : '';

    if (!sourceSessionKey) {
      return { success: false, error: 'Missing source_session_key' };
    }
    if (!this.harness.forkSession) {
      return { success: false, error: 'Fork not supported by harness' };
    }

    const target = targetSessionKey || `${sourceSessionKey}-fork-${Date.now().toString(36)}`;
    const result = this.harness.forkSession(sourceSessionKey, target);
    return {
      success: result.success,
      ...(result.success ? { targetSessionKey: target } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  }

  private handleControlPlanePermissionsGet(
    _connectionId: string,
    data: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    const sessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    const workingDir = typeof data?.working_dir === 'string' ? data.working_dir : undefined;
    if (!sessionKey) {
      return { success: false, error: 'Missing session_key' };
    }

    const store = this.harness.ensureSessionHydrated?.(sessionKey, {
      ...(workingDir ? { workingDir } : {}),
      includeUserPreferences: false,
    });
    if (!store || typeof store.getPermissionState !== 'function') {
      return {
        success: false,
        error: 'Permission state not available',
      };
    }
    return {
      success: true,
      state: store.getPermissionState(),
    };
  }

  private handleControlPlanePermissionsUpdate(
    _connectionId: string,
    data: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    const sessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    const workingDir = typeof data?.working_dir === 'string' ? data.working_dir : undefined;
    const update = isRecord(data?.update) ? data.update : {};
    if (!sessionKey) {
      return { success: false, error: 'Missing session_key' };
    }

    const store = this.harness.ensureSessionHydrated?.(sessionKey, {
      ...(workingDir ? { workingDir } : {}),
      includeUserPreferences: false,
    });
    if (!store || typeof store.updatePermissionOptions !== 'function') {
      return {
        success: false,
        error: 'Permission state not available',
      };
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
    return {
      success: true,
      state: nextState,
    };
  }

  private handleControlPlaneMemoryInfo(_connectionId: string): Record<string, unknown> {
    if (!this.harness.getDebugMemoryInfo) {
      return {
        success: false,
        error: 'Debug memory info not available',
      };
    }

    return {
      success: true,
      ...this.harness.getDebugMemoryInfo(),
    };
  }

  private handleControlPlaneModelGet(
    _connectionId: string,
    data: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    const sessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    if (!sessionKey) {
      return { success: false, error: 'Missing session_key' };
    }
    const selections = this.harness.getAllSessionSelectedModels?.(sessionKey) ?? new Map();
    const selectionsObject: Record<string, { provider: string; model: string; reasoning?: string }> = {};
    for (const [type, selection] of selections) {
      selectionsObject[type] = selection;
    }
    return {
      success: true,
      selections: selectionsObject,
    };
  }

  private handleControlPlaneModelSet(
    _connectionId: string,
    data: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    const sessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    const agentType = typeof data?.agent_type === 'string' ? data.agent_type : 'standard';
    const provider = typeof data?.provider === 'string' ? data.provider : null;
    const model = typeof data?.model === 'string' ? data.model : null;
    const reasoning = typeof data?.reasoning === 'string' ? data.reasoning : undefined;
    if (!sessionKey) {
      return { success: false, error: 'Missing session_key' };
    }
    if (!provider || !model) {
      return { success: false, error: 'Provider and model are required' };
    }
    const selectedModel = reasoning ? { provider, model, reasoning } : { provider, model };
    this.harness.setSessionSelectedModel?.(sessionKey, agentType, selectedModel);
    this.persistModelSelection(sessionKey, agentType, selectedModel);

    return {
      success: true,
      agentType,
      selection: selectedModel,
    };
  }

  // =========================================================================
  // Async Session Handler
  // =========================================================================

  private async handleAsyncStart(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: RpcConnectionState
  ): Promise<Record<string, unknown>> {
    const explicitSessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    const sessionKey = explicitSessionKey || state.sessionKey;
    if (!sessionKey) {
      return {
        success: false,
        error: 'Session not initialized. Call init first.',
      };
    }

    const sendFailure = (error: string): Record<string, unknown> => ({ success: false, error });

    // Prevent concurrent async runs (check session-level state, not connection-level)
    const existingAsyncRun = this.harness.getSessionAsyncRun?.(sessionKey);
    if (existingAsyncRun) {
      return sendFailure(`An async session is already running (request: ${existingAsyncRun.requestId}). Wait for it to finish or close the session.`);
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
      return sendFailure(`Async mode is unavailable: ${asyncStatus.issues.join('; ')}`);
    }

    // For connection-scoped async starts we require an explicit valid model selection.
    // Control-plane starts can proceed with defaults, but we still sync companion selections
    // when a standard selection already exists.
    const activeSelection = this.harness.getSessionSelectedModel?.(sessionKey, 'standard');
    if (!explicitSessionKey) {
      if (!activeSelection?.model || !activeSelection?.provider) {
        return sendFailure('No model selected. Use /models to choose one before starting an async session.');
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
        return sendFailure(`No API key configured for provider: ${activeSelection.provider}`);
      }
      this.ensureAsyncCompanionSelections(sessionKey, activeSelection);
    } else if (activeSelection?.model && activeSelection?.provider) {
      this.ensureAsyncCompanionSelections(sessionKey, activeSelection);
    }

    // Extract goal from data
    const goal = typeof data?.goal === 'string' ? data.goal.trim() : '';
    if (!goal) {
      return sendFailure('Async session requires a goal.');
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
        return sendFailure('An async session was started by another connection. Wait for it to finish or close the session.');
      }
      // Track connection-local state when this command is bound to the current session.
      if (!explicitSessionKey) {
        state.asyncRun = asyncRunInfo;
      }

      const handle = this.harness.run({
        requestId,
        inputText: goal,
        tier: 'standard',
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

      return {
        success: true,
        sessionKey,
        requestId,
        goal,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.harness.clearSessionAsyncRun?.(sessionKey);
      if (state.asyncRun?.requestId) {
        state.asyncRun = null;
      }
      this.harness.setSessionAsyncModeEnabled?.(sessionKey, false);
      return sendFailure(`Failed to start async session: ${message}`);
    }
  }

  private async handleAsyncCancel(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: RpcConnectionState
  ): Promise<Record<string, unknown>> {
    const explicitSessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    const sessionKey = explicitSessionKey || state.sessionKey;
    if (!sessionKey) {
      return {
        success: false,
        error: 'Session not initialized. Call init first.',
      };
    }

    // Check session-level state (works across all connections)
    const sessionAsyncRun = this.harness.getSessionAsyncRun?.(sessionKey);
    if (!sessionAsyncRun) {
      return {
        success: false,
        error: 'No async session is currently running.',
      };
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
      return {
        success: false,
        error: controlResult.error ?? 'Failed to cancel active async session',
      };
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

    const responsePayload: Record<string, unknown> = {
      success: true,
      requestId,
      goal,
      quiesced: controlResult.quiesced ?? true,
    };

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

    return responsePayload;
  }

  private handleAsyncStatus(
    data: Record<string, unknown> | undefined,
    state: RpcConnectionState
  ): Record<string, unknown> {
    const explicitSessionKey = typeof data?.session_key === 'string' ? data.session_key.trim() : '';
    const sessionKey = explicitSessionKey || state.sessionKey;
    if (!sessionKey) {
      return {
        success: false,
        running: false,
        error: 'Session not initialized. Call init first.',
      };
    }

    const sessionAsyncRun = this.harness.getSessionAsyncRun?.(sessionKey);
    if (!sessionAsyncRun) {
      return {
        success: true,
        running: false,
      };
    }

    return {
      success: true,
      running: true,
      requestId: sessionAsyncRun.requestId,
      goal: sessionAsyncRun.goal,
      startedAt: sessionAsyncRun.startedAt,
      elapsedMs: Date.now() - sessionAsyncRun.startedAt,
    };
  }

  async invoke(
    connectionId: string,
    state: RpcConnectionState,
    method: string,
    data?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method === 'config.get') {
      return this.handleGetConfig(state);
    }
    if (method === 'status.get') {
      return this.handleGetStatus();
    }
    if (method === 'models.list') {
      return this.handleGetModels();
    }
    if (method === 'session.list') {
      return this.handleListSessions(data, state);
    }
    if (method === 'session.fork') {
      return this.handleSessionFork(state);
    }
    if (method === 'session.close') {
      return this.handleSessionClose(connectionId, state);
    }
    if (method === 'session.delete') {
      return this.handleSessionDelete(data);
    }
    if (method === 'usage.summary') {
      return this.handleUsageSummary(data);
    }
    if (method === 'context.compact') {
      return this.handleCompactContext(state);
    }
    if (method === 'async.status') {
      return this.handleAsyncStatus(data, state);
    }
    if (method === 'dangerous_mode.set') {
      return this.handleSetDangerousMode(connectionId, data);
    }
    if (method === 'auth.start') {
      return this.handleAuthStart(data);
    }
    if (method === 'auth.poll') {
      return this.handleAuthPoll(data);
    }
    if (method === 'auth.verify') {
      return this.handleAuthVerify(data);
    }
    if (method === 'auth.logout') {
      return this.handleAuthLogout(data);
    }
    if (method === 'providers.list') {
      return this.handleProvidersList(data);
    }
    if (method === 'providers.save') {
      return this.handleProvidersSave(data);
    }
    if (method === 'providers.delete') {
      return this.handleProvidersDelete(data);
    }
    if (method === 'providers.test') {
      return await this.handleProvidersTest(data);
    }
    if (method === 'models.delete') {
      return this.handleModelsDelete(connectionId, data, state);
    }
    if (method === 'skills.list') {
      return this.handleSkillsList();
    }
    if (method === 'skills.get') {
      return this.handleSkillsGet(data);
    }
    if (method === 'skills.create') {
      return this.handleSkillsCreate(data);
    }
    if (method === 'skills.update') {
      return this.handleSkillsUpdate(data);
    }
    if (method === 'skills.delete') {
      return this.handleSkillsDelete(data);
    }
    if (method === 'skills.enable') {
      return this.handleSkillsEnable(data, true);
    }
    if (method === 'skills.disable') {
      return this.handleSkillsEnable(data, false);
    }
    if (method === 'skills.run') {
      return this.handleDeferredResponse('skills_run');
    }
    if (method === 'hooks.list') {
      return this.handleHooksList();
    }
    if (method === 'hooks.get') {
      return this.handleHooksGet(data);
    }
    if (method === 'hooks.create') {
      return this.handleHooksCreate(data);
    }
    if (method === 'hooks.update') {
      return this.handleHooksUpdate(data);
    }
    if (method === 'hooks.delete') {
      return this.handleHooksDelete(data);
    }
    if (method === 'hooks.enable') {
      return this.handleHooksEnable(data, true);
    }
    if (method === 'hooks.disable') {
      return this.handleHooksEnable(data, false);
    }
    if (method === 'model.set') {
      return this.handleSetModel(connectionId, data, state);
    }
    if (method === 'model.get') {
      return this.handleGetModel(data, state);
    }
    if (method === 'async.start') {
      return await this.handleAsyncStart(connectionId, data, state);
    }
    if (method === 'async.cancel') {
      return await this.handleAsyncCancel(connectionId, data, state);
    }
    if (method === 'control.dispatch') {
      return this.handleControlPlaneDispatch(connectionId, data);
    }
    if (method === 'control.stop') {
      return await this.handleControlPlaneStop(connectionId, data);
    }
    if (method === 'control.fork') {
      return this.handleControlPlaneFork(connectionId, data);
    }
    if (method === 'control.permissions.get') {
      return this.handleControlPlanePermissionsGet(connectionId, data);
    }
    if (method === 'control.permissions.update') {
      return this.handleControlPlanePermissionsUpdate(connectionId, data);
    }
    if (method === 'control.memory_info') {
      return this.handleControlPlaneMemoryInfo(connectionId);
    }
    if (method === 'control.model.get') {
      return this.handleControlPlaneModelGet(connectionId, data);
    }
    if (method === 'control.model.set') {
      return this.handleControlPlaneModelSet(connectionId, data);
    }
    if (method === 'voice.start' || method === 'voice.stop') {
      throw new RpcHandlerError(400, 'Voice is not yet supported in TypeScript mode');
    }
    throw new RpcHandlerError(404, `Unknown RPC method: ${method}`);
  }

  private sendEvent(connectionId: string, event: BridgeEvent, channel?: string): void {
    this.emitEvent(connectionId, event, channel);
  }

  private streamRunEvents(
    requestId: string,
    handle: AgentRunHandle,
    onComplete?: (result?: AgentRunResult) => void,
    sessionKey?: string
  ): void {
    this.streamEvents(requestId, handle, onComplete, sessionKey);
  }
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateSessionKey(): string {
  return `tui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
