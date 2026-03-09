/**
 * HarnessClient - Shared WebSocket client for the harness bridge bus.
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
  BridgeEvent,
  BridgeEventType,
  ConnectionState,
  ReadyData,
  ResponseData,
} from './types.js';
import { RpcClient } from './rpc_client.js';
import type { ProcedureMethod } from './rpc_types.js';

export type * from './types.js'
export * from './rpc_types.js';
export { RpcClient, RpcCallError } from './rpc_client.js';
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
  private readonly rpcClient: RpcClient;
  private sessionKey: string | null = null;
  private activeRuns = new Set<string>();
  private connectionState: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private reconnectDelay: number;
  private requestTimeout: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  get connected(): boolean {
    return this.connectionState === 'connected';
  }

  constructor(options: HarnessClientOptions) {
    super();
    this.bus = new BusClient({ host: options.host, port: options.port });
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.reconnectDelay = options.reconnectDelay ?? DEFAULT_RECONNECT_DELAY;
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    this.rpcClient = new RpcClient((request) => {
      if (this.connectionState !== 'connected') {
        return false;
      }
      this.bus.publish(BRIDGE_COMMAND_CHANNEL, request);
      return true;
    }, this.requestTimeout);

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
    this.rpc.rejectAll(new Error('Connection closed'));
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

  get rpc(): RpcClient {
    return this.rpcClient;
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

  async request<T extends Record<string, unknown>>(
    method: ProcedureMethod,
    data: Record<string, unknown> = {}
  ): Promise<T> {
    return this.rpc.call(method, data as never) as Promise<T>;
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  private handleBusEvent(payload: unknown, channel: string): void {
    if (this.rpc.handleResponse(payload)) {
      return;
    }

    const event = validateBridgeEvent(payload);
    if (!event) {
      this.emit('error', { message: 'Malformed event from bridge' });
      return;
    }

    // Handle ready event - subscribe to session channel
    if (event.type === 'ready') {
      const data = (event.data ?? {});
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
      const data = (event.data ?? {});
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
    this.rpc.rejectAll(new Error('Connection lost'));
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

}
