/**
 * HarnessClient - Shared WebSocket client for the harness bridge bus.
 *
 * Provides the common bus communication layer used by TUI, Telegram, and other clients.
 */

import { EventEmitter } from 'events';
import {
  BRIDGE_COMMAND_CHANNEL,
  isBridgeEvent,
  runChannel,
  sessionChannel,
} from '@nova/protocol';
import type {
  BridgeCommand,
  BridgeEvent,
  ConnectionState,
  PermissionResponseCommandData,
  ReadyData,
  ResponseData,
  SendMediaCommandData,
  SendTextCommandData,
  UserPromptResponseCommandData,
} from './types.js';
import { RpcClient } from './rpc_client.js';
import type { ProcedureMethod } from './rpc_types.js';
import { BusTransport } from './bus_transport.js';
import type { ProcedureOutput, ServiceHealth, ServiceReadiness } from '@nova/protocol';

export type * from './types.js'
export * from './rpc_types.js';
export { RpcClient, RpcCallError } from './rpc_client.js';
export type { Attachment } from './types.js';

export interface HarnessClientOptions {
  host: string;
  port: number;
  /** Base delay for reconnection attempts (default: 1000ms) */
  reconnectDelay?: number;
  /** Maximum reconnection attempts (default: 5) */
  maxReconnectAttempts?: number;
  /** Request timeout in ms (default: 120000) */
  requestTimeout?: number;
  /** Optional bearer token for private Nova service deployments. */
  authToken?: string;
}

const DEFAULT_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_REQUEST_TIMEOUT = 120000;

export interface InitSessionOptions {
  sessionKey?: string;
  workingDir?: string;
}

export interface SendTextOptions {
  text: string;
  sessionKey?: string;
  workingDir?: string;
  tier?: string;
  attachments?: SendTextCommandData['attachments'];
  requestId?: string;
}

export interface SendMediaOptions {
  text?: string;
  sessionKey?: string;
  workingDir?: string;
  tier?: string;
  attachments: SendMediaCommandData['attachments'];
  requestId?: string;
}

export interface RunToCompletionOptions extends SendTextOptions {
  timeoutMs?: number;
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class HarnessClient extends EventEmitter {
  private readonly bus: BusTransport;
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
    this.bus = new BusTransport({ host: options.host, port: options.port, authToken: options.authToken });
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

    this.bus.on('event', (payload: unknown, channel: string) => {
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

  async initSession(options: InitSessionOptions = {}): Promise<ReadyData> {
    const ready = this.waitForBridgeEvent('ready', undefined, this.requestTimeout);
    if (!this.send({
      type: 'init',
      data: {
        ...(options.sessionKey ? { session_key: options.sessionKey } : {}),
        ...(options.workingDir ? { working_dir: options.workingDir } : {}),
      },
    })) {
      throw new Error('Not connected to bridge');
    }
    return ((await ready) as ReadyData | undefined) ?? {};
  }

  sendText(options: SendTextOptions): string {
    if (options.sessionKey) {
      this.subscribeSession(options.sessionKey);
    }

    const requestId = options.requestId ?? generateRequestId();
    const ok = this.send({
      type: 'send_text',
      data: {
        text: options.text,
        client_request_id: requestId,
        ...(options.tier ? { tier: options.tier } : {}),
        ...(options.workingDir ? { working_dir: options.workingDir } : {}),
        ...(options.attachments ? { attachments: options.attachments } : {}),
      },
    });
    if (!ok) {
      throw new Error('Not connected to bridge');
    }
    return requestId;
  }

  sendMedia(options: SendMediaOptions): string {
    if (options.sessionKey) {
      this.subscribeSession(options.sessionKey);
    }

    const requestId = options.requestId ?? generateRequestId();
    const ok = this.send({
      type: 'send_media',
      data: {
        attachments: options.attachments,
        client_request_id: requestId,
        ...(options.text ? { text: options.text } : {}),
        ...(options.tier ? { tier: options.tier } : {}),
        ...(options.workingDir ? { working_dir: options.workingDir } : {}),
      },
    });
    if (!ok) {
      throw new Error('Not connected to bridge');
    }
    return requestId;
  }

  async runToCompletion(options: RunToCompletionOptions): Promise<ResponseData> {
    const requestId = options.requestId ?? generateRequestId();
    const response = this.waitForBridgeEvent('response', requestId, options.timeoutMs ?? this.requestTimeout);
    this.sendText({ ...options, requestId });
    const data = await response as ResponseData | undefined;
    if (!data) {
      throw new Error(`Response ${requestId} did not include response data`);
    }
    return data;
  }

  respondToPrompt(data: UserPromptResponseCommandData): void {
    if (!this.send({ type: 'user_prompt_response', data })) {
      throw new Error('Not connected to bridge');
    }
  }

  respondToPermission(data: PermissionResponseCommandData): void {
    if (!this.send({ type: 'permission_response', data })) {
      throw new Error('Not connected to bridge');
    }
  }

  async health(): Promise<ServiceHealth> {
    return this.rpc.call('service.health', {});
  }

  async readiness(): Promise<ServiceReadiness> {
    return this.rpc.call('service.readiness', {});
  }

  async listSessions(
    params: { workingDir?: string; status?: string | string[]; limit?: number } = {}
  ): Promise<ProcedureOutput<'session.list'>> {
    return this.rpc.call('session.list', params);
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  private waitForBridgeEvent(
    type: BridgeEvent['type'],
    requestId: string | undefined,
    timeoutMs: number
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('event', onEvent);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);

      const onEvent = (event: BridgeEvent) => {
        if (event.type !== type) {
          return;
        }
        if (requestId) {
          const data = event.data as { request_id?: unknown } | undefined;
          if (data?.request_id !== requestId) {
            return;
          }
        }

        clearTimeout(timeout);
        this.off('event', onEvent);
        resolve(event.data);
      };

      this.on('event', onEvent);
    });
  }

  private handleBusEvent(payload: unknown, channel: string): void {
    if (this.rpc.handleResponse(payload)) {
      return;
    }

    if (!isBridgeEvent(payload)) {
      this.emit('error', { message: 'Malformed event from bridge' });
      return;
    }
    const event = payload as BridgeEvent;

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
