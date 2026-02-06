/**
 * HarnessClient - Shared TCP JSONL client for the harness bridge bus.
 *
 * Provides the common bus communication layer used by TUI, Telegram, and other clients.
 */

import { EventEmitter } from 'events';
import {
  BusClient,
  BRIDGE_COMMAND_CHANNEL,
  runChannel,
  sessionChannel,
} from 'comms-bus';
import type {
  BridgeCommand,
  BridgeCommandType,
  BridgeEvent,
  BridgeEventType,
  ConnectionState,
  ReadyData,
  ResponseData,
} from './types.js';

export * from './types.js'
export type { Attachment } from './types.js';

// Valid bridge event types for runtime validation
const VALID_EVENT_TYPES = new Set<BridgeEventType>([
  'ready',
  'status',
  'progress',
  'stream',
  'response',
  'transcription',
  'user_prompt',
  'error',
  'provider_key_required',
  'model_changed',
  'permission_request',
  'llm_call',
]);

function validateBridgeEvent(payload: unknown): BridgeEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;

  if (typeof p.type !== 'string' || !VALID_EVENT_TYPES.has(p.type as BridgeEventType)) {
    return null;
  }

  if (p.data !== undefined && (typeof p.data !== 'object' || p.data === null)) {
    return null;
  }

  return { type: p.type as BridgeEventType, data: p.data as Record<string, unknown> | undefined } as BridgeEvent;
}

export interface HarnessClientOptions {
  host: string;
  port: number;
  /** Base delay for reconnection attempts (default: 1000ms) */
  reconnectDelay?: number;
  /** Maximum reconnection attempts (default: 5) */
  maxReconnectAttempts?: number;
  /** Request timeout in ms (default: 120000) */
  requestTimeout?: number;
}

const DEFAULT_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_REQUEST_TIMEOUT = 120000;

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class HarnessClient extends EventEmitter {
  private readonly bus: BusClient;
  private sessionKey: string | null = null;
  private activeRuns = new Set<string>();
  private connectionState: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private reconnectDelay: number;
  private requestTimeout: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
  >();

  get connected(): boolean {
    return this.connectionState === 'connected';
  }

  constructor(options: HarnessClientOptions) {
    super();
    this.bus = new BusClient({ host: options.host, port: options.port });
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.reconnectDelay = options.reconnectDelay ?? DEFAULT_RECONNECT_DELAY;
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;

    this.bus.on('event', (payload, channel) => {
      this.handleBusEvent(payload, channel);
    });
    this.bus.on('error', (payload) => {
      this.emit('error', payload);
    });
    this.bus.on('close', () => {
      this.handleDisconnect();
    });
  }

  async connect(): Promise<void> {
    if (this.connectionState === 'connecting' || this.connectionState === 'reconnecting') {
      return;
    }
    if (this.connectionState === 'connected') {
      return;
    }

    this.connectionState = 'connecting';
    this.emit('connection_state', this.connectionState);

    try {
      await this.bus.connect();
      this.connectionState = 'connected';
      this.reconnectAttempts = 0;
      this.reconnectDelay = DEFAULT_RECONNECT_DELAY;
      this.emit('connection_state', this.connectionState);
    } catch (err) {
      this.connectionState = 'disconnected';
      this.emit('connection_state', this.connectionState);
      throw err;
    }
  }

  send(command: BridgeCommand): boolean {
    if (this.connectionState !== 'connected') {
      this.emit('error', { message: 'Not connected to bridge' });
      return false;
    }

    if (command.type === 'send_text' || command.type === 'send_media') {
      const data = { ...(command.data ?? {}) } as Record<string, unknown>;
      const requestId =
        typeof data.client_request_id === 'string' && data.client_request_id.length > 0
          ? data.client_request_id
          : generateRequestId();
      data.client_request_id = requestId;
      this.activeRuns.add(requestId);
      this.bus.subscribe(runChannel(requestId));
      command = { ...command, data };
    }

    if (command.type === 'user_prompt_response') {
      const data = command.data ?? {};
      const requestId = typeof data.request_id === 'string' ? data.request_id : '';
      if (requestId && !this.activeRuns.has(requestId)) {
        this.activeRuns.add(requestId);
        this.bus.subscribe(runChannel(requestId));
      }
    }

    if (command.type === 'permission_response') {
      const data = command.data ?? {};
      const requestId = typeof data.request_id === 'string' ? data.request_id : '';
      if (requestId && !this.activeRuns.has(requestId)) {
        this.activeRuns.add(requestId);
        this.bus.subscribe(runChannel(requestId));
      }
    }

    this.bus.publish(BRIDGE_COMMAND_CHANNEL, command);
    return true;
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectPendingRequests(new Error('Connection closed'));
    this.connectionState = 'disconnected';
    this.sessionKey = null;
    this.activeRuns.clear();
    this.bus.close();
    this.emit('connection_state', this.connectionState);
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  getSessionKey(): string | null {
    return this.sessionKey;
  }

  // =========================================================================
  // Session Management
  // =========================================================================

  /**
   * Subscribe to a session channel to receive session-specific events.
   */
  subscribeSession(sessionKey: string): void {
    this.bus.subscribe(sessionChannel(sessionKey));
    this.sessionKey = sessionKey;
  }

  /**
   * Subscribe to a run channel to receive run-specific events.
   */
  subscribeRun(requestId: string): void {
    this.activeRuns.add(requestId);
    this.bus.subscribe(runChannel(requestId));
  }

  /**
   * Unsubscribe from a run channel.
   */
  unsubscribeRun(requestId: string): void {
    this.activeRuns.delete(requestId);
    this.bus.unsubscribe(runChannel(requestId));
  }

  // =========================================================================
  // Auth Commands
  // =========================================================================

  async authStart(
    deviceName?: string
  ): Promise<{ success: boolean; authUrl?: string; stateToken?: string; error?: string }> {
    return this.sendAuthCommand('auth_start', { device: deviceName });
  }

  async authPoll(stateToken: string): Promise<{
    success: boolean;
    pending?: boolean;
    sessionToken?: string;
    userId?: string;
    email?: string;
    name?: string | null;
    error?: string;
  }> {
    return this.sendAuthCommand('auth_poll', { stateToken });
  }

  async authVerify(sessionToken: string): Promise<{
    success: boolean;
    valid?: boolean;
    user?: { id: string; email: string; name: string | null };
    error?: string;
  }> {
    return this.sendAuthCommand('auth_verify', { sessionToken });
  }

  async authLogout(sessionToken: string): Promise<{ success: boolean }> {
    return this.sendAuthCommand('auth_logout', { sessionToken });
  }

  // =========================================================================
  // Provider Commands
  // =========================================================================

  async providersList(sessionToken?: string): Promise<{
    success: boolean;
    providers?: Array<{ provider: string; configured: boolean; updatedAt?: number }>;
    error?: string;
  }> {
    return this.sendAuthCommand('providers_list', sessionToken ? { sessionToken } : {});
  }

  async providersSave(
    provider: string,
    apiKey: string,
    sessionToken?: string
  ): Promise<{ success: boolean; error?: string }> {
    const data: Record<string, string> = { provider, apiKey };
    if (sessionToken) data.sessionToken = sessionToken;
    return this.sendAuthCommand('providers_save', data);
  }

  async providersDelete(
    provider: string,
    sessionToken?: string
  ): Promise<{ success: boolean; error?: string }> {
    const data: Record<string, string> = { provider };
    if (sessionToken) data.sessionToken = sessionToken;
    return this.sendAuthCommand('providers_delete', data);
  }

  async providersTest(
    provider: string,
    sessionToken?: string
  ): Promise<{ success: boolean; valid?: boolean; error?: string }> {
    const data: Record<string, string> = { provider };
    if (sessionToken) data.sessionToken = sessionToken;
    return this.sendAuthCommand('providers_test', data);
  }

  // =========================================================================
  // Session Commands
  // =========================================================================

  async sessionFork(): Promise<{
    success: boolean;
    newSessionKey?: string;
    sourceSessionKey?: string;
    error?: string;
  }> {
    return this.sendAuthCommand('session_fork', {});
  }

  async sessionClose(): Promise<{
    success: boolean;
    sessionKey?: string;
    message?: string;
    error?: string;
  }> {
    return this.sendAuthCommand('session_close', {});
  }

  async listSessions(
    options: { workingDir?: string; status?: string | string[]; limit?: number } = {}
  ): Promise<{
    success: boolean;
    sessions: Array<{
      sessionKey: string;
      clientType: string;
      createdAt: number;
      lastAccessedAt: number;
      workingDir: string | null;
      status: string;
      lastUserMessagePreview?: string | null;
    }>;
    error?: string;
  }> {
    return this.sendAuthCommand('list_sessions', options);
  }

  async deleteSession(sessionKey: string): Promise<{
    success: boolean;
    deleted: boolean;
    error?: string;
  }> {
    return this.sendAuthCommand('session_delete', { sessionKey });
  }

  async usageSummary(
    options: { status?: string | string[]; limit?: number } = {}
  ): Promise<{
    success: boolean;
    usage?: Array<{ provider: string; model: string; totalTokens: number; sessionCount: number }>;
    sessions?: Array<{
      sessionKey: string;
      clientType: string;
      createdAt: number;
      lastAccessedAt: number;
      workingDir: string | null;
      status: string;
      metadataJson: string | null;
      metadata?: Record<string, unknown>;
      lastUserMessagePreview?: string | null;
      goal?: string | null;
      currentWorkItemId?: string | null;
      currentObjective?: string | null;
    }>;
    error?: string;
  }> {
    return this.sendAuthCommand('usage_summary', options);
  }

  async setDangerousMode(enabled: boolean): Promise<{
    success: boolean;
    enabled?: boolean;
    sessionKey?: string;
    error?: string;
  }> {
    return this.sendAuthCommand('set_dangerous_mode', { enabled });
  }

  // =========================================================================
  // Async Session Commands
  // =========================================================================

  async asyncStart(
    goal: string,
    workingDir?: string
  ): Promise<{ success: boolean; sessionKey?: string; requestId?: string; goal?: string; error?: string }> {
    const data: Record<string, unknown> = { goal };
    if (workingDir) data.working_dir = workingDir;
    return this.sendAuthCommand('async_start', data);
  }

  async asyncCancel(): Promise<{ success: boolean; error?: string }> {
    return this.sendAuthCommand('async_cancel', {});
  }

  async asyncStatus(): Promise<{
    success: boolean;
    running?: boolean;
    requestId?: string;
    goal?: string;
    startedAt?: number;
    elapsedMs?: number;
    error?: string;
  }> {
    return this.sendAuthCommand('async_status', {});
  }

  // =========================================================================
  // Watcher Commands
  // =========================================================================

  async watcherStatus(): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> {
    return this.sendAuthCommand('watcher_status', {});
  }

  async watcherContext(): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> {
    return this.sendAuthCommand('watcher_context', {});
  }

  async watcherSearch(query: string): Promise<{ success: boolean; results?: unknown[]; error?: string }> {
    return this.sendAuthCommand('watcher_search', { query });
  }

  async watcherDecisions(): Promise<{ success: boolean; decisions?: unknown[]; error?: string }> {
    return this.sendAuthCommand('watcher_decisions', {});
  }

  async watcherInspect(id: string): Promise<{ success: boolean; decision?: Record<string, unknown>; error?: string }> {
    return this.sendAuthCommand('watcher_inspect', { id });
  }

  async watcherMemory(): Promise<{ success: boolean; memory?: Record<string, unknown>; error?: string }> {
    return this.sendAuthCommand('watcher_memory', {});
  }

  async watcherFocus(topic: string): Promise<{ success: boolean; topic?: string; error?: string }> {
    return this.sendAuthCommand('watcher_focus', { topic });
  }

  async watcherDefocus(): Promise<{ success: boolean; error?: string }> {
    return this.sendAuthCommand('watcher_defocus', {});
  }

  async watcherReanchor(goal: string): Promise<{ success: boolean; goal?: string; error?: string }> {
    return this.sendAuthCommand('watcher_reanchor', { goal });
  }

  async watcherSummarize(): Promise<{ success: boolean; ledger?: Record<string, unknown>; error?: string }> {
    return this.sendAuthCommand('watcher_summarize', {});
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  private sendAuthCommand<T extends Record<string, unknown>>(
    type: BridgeCommandType,
    data: Record<string, unknown>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.connectionState !== 'connected') {
        reject(new Error('Not connected to bridge'));
        return;
      }

      const requestId = generateRequestId();
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const handler = (event: BridgeEvent) => {
        if (event.type === 'response') {
          const responseData = event.data as ResponseData;
          const metadata = responseData?.metadata as { kind?: string; payload?: unknown } | undefined;
          if (metadata?.kind === type) {
            if (timeoutId) clearTimeout(timeoutId);
            this.off('event', handler);
            this.pendingRequests.delete(requestId);
            resolve((metadata.payload ?? { success: false }) as T);
          }
        }
      };

      this.pendingRequests.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      this.on('event', handler);

      timeoutId = setTimeout(() => {
        this.off('event', handler);
        this.pendingRequests.delete(requestId);
        reject(new Error('Request timeout'));
      }, this.requestTimeout);

      this.send({ type, data });
    });
  }

  private handleBusEvent(payload: unknown, channel: string): void {
    const event = validateBridgeEvent(payload);
    if (!event) {
      this.emit('error', { message: 'Malformed event from bridge' });
      return;
    }

    // Handle ready event - subscribe to session channel
    if (event.type === 'ready') {
      const data = (event.data ?? {}) as ReadyData;
      if (data.session_key && data.session_key !== this.sessionKey) {
        if (this.sessionKey) {
          this.bus.unsubscribe(sessionChannel(this.sessionKey));
        }
        this.sessionKey = data.session_key;
        this.bus.subscribe(sessionChannel(data.session_key));
      }
    }

    // Handle response event - unsubscribe from run channel
    if (event.type === 'response') {
      const data = (event.data ?? {}) as ResponseData;
      const requestId = typeof data.request_id === 'string' ? data.request_id : '';
      if (requestId && this.activeRuns.has(requestId)) {
        this.activeRuns.delete(requestId);
        this.bus.unsubscribe(runChannel(requestId));
      }
    }

    // Emit with channel info for clients that need it
    this.emit('event', event, channel);
  }

  private handleDisconnect(): void {
    if (this.connectionState === 'disconnected') return;

    this.sessionKey = null;
    this.activeRuns.clear();
    this.rejectPendingRequests(new Error('Connection lost'));
    this.connectionState = 'reconnecting';
    this.emit('connection_state', this.connectionState);
    this.emit('close');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.connectionState = 'disconnected';
      this.emit('connection_state', this.connectionState);
      this.emit('error', { message: 'Connection lost. Max reconnect attempts reached.' });
      return;
    }

    const delay = Math.min(this.reconnectDelay, MAX_RECONNECT_DELAY);
    this.reconnectAttempts++;
    this.reconnectDelay *= 2;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        this.connectionState = 'reconnecting';
        this.emit('connection_state', this.connectionState);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private rejectPendingRequests(error: Error): void {
    this.pendingRequests.forEach(({ reject }) => {
      reject(error);
    });
    this.pendingRequests.clear();
  }
}
