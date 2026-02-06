/**
 * BridgeClient - TUI-specific wrapper around HarnessClient.
 *
 * Adds TUI-specific profiling and validation, delegates bus communication to HarnessClient.
 */

import { EventEmitter } from 'events';
import { HarnessClient, type ConnectionState } from 'harness-client';
import { profiler } from 'shared';
import type { BridgeCommand, BridgeEvent, BridgeEventType, ReadyData, ResponseData } from './types.js';

// Valid bridge event types for runtime validation (Set for O(1) lookups)
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

/**
 * Validates an incoming bridge event at the boundary.
 * Bad data dies here, never propagates into handlers.
 */
function validateBridgeEvent(payload: unknown): BridgeEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;

  // Must have a valid type
  if (typeof p.type !== 'string' || !VALID_EVENT_TYPES.has(p.type as BridgeEventType)) {
    return null;
  }

  // data is optional but must be object if present
  if (p.data !== undefined && (typeof p.data !== 'object' || p.data === null)) {
    return null;
  }

  return { type: p.type as BridgeEventType, data: p.data as Record<string, unknown> | undefined };
}

export interface BridgeClientOptions {
  host: string;
  port: number;
}

export type { ConnectionState };

export class BridgeClient extends EventEmitter {
  private readonly client: HarnessClient;

  get connected(): boolean {
    return this.client.connected;
  }

  constructor(options: BridgeClientOptions) {
    super();
    this.client = new HarnessClient(options);

    this.client.on('event', (event: BridgeEvent) => {
      profiler.begin(`bridge.client.validate:${event.type}`, 'tui');
      const validated = validateBridgeEvent(event);
      if (!validated) {
        profiler.end(`bridge.client.validate:${event.type}`, 'tui');
        // Emit error event for UI handling - do NOT use console.error
        // as it breaks Ink's rendering and causes flickering
        const errorMsg = `Malformed event from bridge. Type: ${event?.type ?? 'undefined'}, Data: ${JSON.stringify(event?.data ?? {}).slice(0, 200)}`;
        this.emit('error', { message: errorMsg });
        return;
      }
      profiler.end(`bridge.client.validate:${event.type}`, 'tui');

      profiler.instant(`bridge.client.emit:${event.type}`, 'tui', 'p');
      this.emit('event', validated);
    });

    this.client.on('error', (payload) => {
      this.emit('error', payload);
    });

    this.client.on('close', () => {
      this.emit('close');
    });

    this.client.on('connection_state', (state: ConnectionState) => {
      this.emit('connection_state', state);
    });
  }

  async connect(): Promise<void> {
    return this.client.connect();
  }

  send(command: BridgeCommand): boolean {
    profiler.instant(`tui:send:${command.type}`, 'tui', 'p');
    return this.client.send(command);
  }

  close(): void {
    this.client.close();
  }

  getConnectionState(): ConnectionState {
    return this.client.getConnectionState();
  }

  // =========================================================================
  // Auth Commands (delegated to HarnessClient)
  // =========================================================================

  async authStart(deviceName?: string) {
    return this.client.authStart(deviceName);
  }

  async authPoll(stateToken: string) {
    return this.client.authPoll(stateToken);
  }

  async authVerify(sessionToken: string) {
    return this.client.authVerify(sessionToken);
  }

  async authLogout(sessionToken: string) {
    return this.client.authLogout(sessionToken);
  }

  async providersList(sessionToken?: string) {
    return this.client.providersList(sessionToken);
  }

  async providersSave(provider: string, apiKey: string, sessionToken?: string) {
    return this.client.providersSave(provider, apiKey, sessionToken);
  }

  async providersDelete(provider: string, sessionToken?: string) {
    return this.client.providersDelete(provider, sessionToken);
  }

  async providersTest(provider: string, sessionToken?: string) {
    return this.client.providersTest(provider, sessionToken);
  }

  async sessionFork() {
    return this.client.sessionFork();
  }

  async sessionClose() {
    return this.client.sessionClose();
  }

  async listSessions(options: { workingDir?: string; status?: string | string[]; limit?: number } = {}) {
    return this.client.listSessions(options);
  }

  async deleteSession(sessionKey: string) {
    return this.client.deleteSession(sessionKey);
  }

  async usageSummary(options: { status?: string | string[]; limit?: number } = {}) {
    return this.client.usageSummary(options);
  }

  async setDangerousMode(enabled: boolean) {
    return this.client.setDangerousMode(enabled);
  }

  async asyncStart(goal: string, workingDir?: string) {
    return this.client.asyncStart(goal, workingDir);
  }
}
