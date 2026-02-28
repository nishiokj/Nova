/**
 * BridgeGateway - Routes bridge commands from the bus to the harness.
 */

import path from 'path';
import { type BusServer, BRIDGE_COMMAND_CHANNEL, runChannel, sessionChannel } from 'comms-bus';
import { profiler } from 'shared';
import { isRpcRequest } from 'harness-client';
import type { AgentRunHandle, AgentRunResult, BridgeEvent } from './types.js';
import { createErrorEvent } from './event_translator.js';
import type { FullHarnessConfig } from './config.js';
import type { AuthService } from './auth_service.js';
import { LocalProviderManager } from './local_providers.js';
import { type UnifiedHookRegistry } from 'orchestrator';
import type { AgentType } from 'agent';
import type { PermissionChecker } from './permissions.js';
import { RpcDispatcher } from './rpc_dispatcher.js';
import { registerRpcHandlers } from './rpc_handlers.js';
import { RpcMethodHandlers } from './rpc_method_handlers.js';

export interface HarnessLike {
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
  getLocalProviders?(): LocalProviderManager | null;
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
  getGraphD?(): any;
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

const STREAMING_COMMANDS = new Set<string>([
  'init',
  'send_text',
  'send_media',
  'user_prompt_response',
  'permission_response',
]);

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
  private readonly rpcDispatcher = new RpcDispatcher<ConnectionState>();
  private readonly rpcMethods: RpcMethodHandlers;
  private readonly rpcQueue = new Map<string, Promise<void>>();

  constructor(bus: BusServer, harness: HarnessLike, workingDir: string, authService?: AuthService | null) {
    this.bus = bus;
    this.harness = harness;
    this.workingDir = workingDir;
    this.authService = authService ?? null;

    const config = harness.getConfig();
    this.skillsDir = config.skills.directory
      ? path.resolve(this.workingDir, config.skills.directory)
      : path.resolve(this.workingDir, '.agent/skills');
    this.hooksDir = config.hooks.directory
      ? path.resolve(this.workingDir, config.hooks.directory)
      : path.resolve(this.workingDir, 'config/hooks');

    // Share the harness's LocalProviderManager to avoid dual-instance SQLite isolation issues.
    // Previously, BridgeGateway created its own instance — keys saved here were invisible to
    // the harness's HarnessProviderKeyService, causing pruneInaccessibleSessionSelections to
    // clear model selections immediately after set_model.
    this.localProviders = harness.getLocalProviders?.() ?? null;
    this.rpcMethods = new RpcMethodHandlers({
      harness: this.harness,
      authService: this.authService,
      localProviders: this.localProviders,
      workingDir: this.workingDir,
      skillsDir: this.skillsDir,
      hooksDir: this.hooksDir,
      sessionOwners: this.sessionOwners,
      getOrCreateConnectionState: (id) => this.getOrCreateConnectionState(id),
      sendEvent: (id, event, channel) => this.sendEvent(id, event, channel),
      streamRunEvents: (requestId, handle, onComplete, sessionKey) =>
        this.streamRunEvents(requestId, handle, onComplete, sessionKey),
    });

    registerRpcHandlers(this.rpcDispatcher, {
      invokeRpcMethod: async (method, connectionId, state, params) => {
        return this.rpcMethods.invoke(connectionId, state, method, params);
      },
    });
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
    this.rpcQueue.delete(connectionId);
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

    const state = this.getOrCreateConnectionState(connectionId);

    if (isRpcRequest(payload)) {
      const run = async () => {
        profiler.begin(`rpc:${payload.method}`, 'bridge');
        try {
          await this.rpcDispatcher.dispatch(connectionId, payload, state, this.bus, (event, targetChannel) => {
            this.sendEvent(connectionId, event, targetChannel);
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.bus.sendTo(connectionId, 'direct', {
            rpc: 1,
            id: payload.id,
            error: { code: 500, message },
          });
        } finally {
          profiler.end(`rpc:${payload.method}`, 'bridge');
        }
      };

      const previous = this.rpcQueue.get(connectionId) ?? Promise.resolve();
      const queued = previous.catch(() => undefined).then(run);
      this.rpcQueue.set(connectionId, queued);
      await queued.finally(() => {
        if (this.rpcQueue.get(connectionId) === queued) {
          this.rpcQueue.delete(connectionId);
        }
      });
      return;
    }

    if (!isRecord(payload) || typeof payload.type !== 'string') {
      this.sendError(connectionId, 'Invalid bridge command payload');
      return;
    }
    const commandType = payload.type;
    const commandData = isRecord(payload.data) ? payload.data : undefined;

    profiler.begin(`cmd:${commandType}`, 'bridge');
    try {
      if (!STREAMING_COMMANDS.has(commandType)) {
        this.sendError(connectionId, `Legacy unary command removed: ${commandType}. Use RPC.`);
        return;
      }
      switch (commandType) {
        case 'init':
          this.handleInit(connectionId, commandData, state);
          return;
        case 'send_text':
        case 'send_media':
          this.handleSendText(connectionId, commandData, state);
          return;
        case 'user_prompt_response':
          this.handleUserPromptResponse(connectionId, commandData, state);
          return;
        case 'permission_response':
          this.handlePermissionResponse(connectionId, commandData);
          return;
        default:
          this.sendError(connectionId, `Unknown command type: ${commandType}`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendEvent(connectionId, createErrorEvent(message, false));
    } finally {
      profiler.end(`cmd:${commandType}`, 'bridge');
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

    // Emit model_changed for standard tabs + any additional persisted agent types.
    const selections = this.harness.getAllSessionSelectedModels?.(sessionKey) ?? new Map();
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
          this.sendMetadataResponse(connectionId, 'session_fork', {
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
        this.sendMetadataResponse(connectionId, 'session_fork', {
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
          this.sendMetadataResponse(connectionId, 'control_plane_stop', {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
        if (result) {
          this.sendMetadataResponse(connectionId, 'control_plane_stop', result);
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
          this.sendMetadataResponse(connectionId, 'control_plane_stop', {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
        if (result) {
          this.sendMetadataResponse(connectionId, 'control_plane_stop', result);
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
          this.sendMetadataResponse(connectionId, 'control_plane_stop', {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
        if (result) {
          this.sendMetadataResponse(connectionId, 'control_plane_stop', result);
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

    const sessionChecker = this.harness.getSessionPermissionChecker?.(sessionKey);
    if (!sessionChecker) {
      this.sendError(connectionId, 'Permission checker not available for session');
      return;
    }

    sessionChecker.handleResponse({
      requestId,
      decision: decision as 'allow' | 'always_allow' | 'deny',
      pattern,
    });
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
