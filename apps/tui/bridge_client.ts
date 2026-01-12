/**
 * BridgeClient - TCP JSONL client for the harness bridge bus.
 */

import { EventEmitter } from "events";
import {
  BusClient,
  BRIDGE_COMMAND_CHANNEL,
  runChannel,
  sessionChannel,
} from "comms-bus";
import type { BridgeCommand, BridgeEvent, ReadyData, ResponseData } from "./types.js";

export interface BridgeClientOptions {
  host: string;
  port: number;
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class BridgeClient extends EventEmitter {
  private readonly bus: BusClient;
  private sessionKey: string | null = null;
  private activeRuns = new Set<string>();
  private connected = false;

  constructor(options: BridgeClientOptions) {
    super();
    this.bus = new BusClient(options);

    this.bus.on("event", (payload, _channel) => {
      this.handleBusEvent(payload);
    });
    this.bus.on("error", (payload) => {
      this.emit("error", payload);
    });
    this.bus.on("close", () => {
      this.connected = false;
      this.sessionKey = null;
      this.activeRuns.clear();
      this.emit("close");
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.bus.connect();
    this.connected = true;
  }

  send(command: BridgeCommand): void {
    if (!this.connected) {
      this.emit("error", { message: "Bridge client not connected" });
      return;
    }

    if (command.type === "send_text") {
      const data = { ...(command.data ?? {}) } as Record<string, unknown>;
      const requestId =
        typeof data.client_request_id === "string" && data.client_request_id.length > 0
          ? data.client_request_id
          : generateRequestId();
      data.client_request_id = requestId;
      this.activeRuns.add(requestId);
      this.bus.subscribe(runChannel(requestId));
      command = { ...command, data };
    }

    if (command.type === "user_prompt_response") {
      const data = command.data ?? {};
      const requestId = typeof data.request_id === "string" ? data.request_id : "";
      if (requestId && !this.activeRuns.has(requestId)) {
        this.activeRuns.add(requestId);
        this.bus.subscribe(runChannel(requestId));
      }
    }

    this.bus.publish(BRIDGE_COMMAND_CHANNEL, command);
  }

  close(): void {
    this.sessionKey = null;
    this.activeRuns.clear();
    this.bus.close();
  }

  // =========================================================================
  // Auth Commands
  // =========================================================================

  /**
   * Start OAuth flow. Returns auth URL and state token.
   */
  async authStart(deviceName?: string): Promise<{
    success: boolean;
    authUrl?: string;
    stateToken?: string;
    error?: string;
  }> {
    return this.sendAuthCommand('auth_start', { device: deviceName });
  }

  /**
   * Poll for completed OAuth session.
   */
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

  /**
   * Verify a session token.
   */
  async authVerify(sessionToken: string): Promise<{
    success: boolean;
    valid?: boolean;
    user?: { id: string; email: string; name: string | null };
    error?: string;
  }> {
    return this.sendAuthCommand('auth_verify', { sessionToken });
  }

  /**
   * Logout (revoke session).
   */
  async authLogout(sessionToken: string): Promise<{ success: boolean }> {
    return this.sendAuthCommand('auth_logout', { sessionToken });
  }

  /**
   * List configured providers.
   * @param sessionToken Optional for local providers (no auth required)
   */
  async providersList(sessionToken?: string): Promise<{
    success: boolean;
    providers?: Array<{ provider: string; configured: boolean; updatedAt?: number }>;
    error?: string;
  }> {
    return this.sendAuthCommand('providers_list', sessionToken ? { sessionToken } : {});
  }

  /**
   * Save a provider API key.
   * @param sessionToken Optional for local providers (no auth required)
   */
  async providersSave(provider: string, apiKey: string, sessionToken?: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    const data: Record<string, string> = { provider, apiKey };
    if (sessionToken) data.sessionToken = sessionToken;
    return this.sendAuthCommand('providers_save', data);
  }

  /**
   * Delete a provider API key.
   * @param sessionToken Optional for local providers (no auth required)
   */
  async providersDelete(provider: string, sessionToken?: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    const data: Record<string, string> = { provider };
    if (sessionToken) data.sessionToken = sessionToken;
    return this.sendAuthCommand('providers_delete', data);
  }

  /**
   * Test a provider API key.
   * @param sessionToken Optional for local providers (no auth required)
   */
  async providersTest(provider: string, sessionToken?: string): Promise<{
    success: boolean;
    valid?: boolean;
    error?: string;
  }> {
    const data: Record<string, string> = { provider };
    if (sessionToken) data.sessionToken = sessionToken;
    return this.sendAuthCommand('providers_test', data);
  }

  private sendAuthCommand<T extends Record<string, unknown>>(
    type: string,
    data: Record<string, unknown>
  ): Promise<T> {
    return new Promise((resolve) => {
      const handler = (event: BridgeEvent) => {
        if (event.type === 'response') {
          const responseData = event.data as ResponseData;
          const metadata = responseData?.metadata as { kind?: string; payload?: unknown } | undefined;
          if (metadata?.kind === type) {
            this.off('event', handler);
            resolve((metadata.payload ?? { success: false }) as T);
          }
        }
      };

      this.on('event', handler);

      // Timeout after 30 seconds
      setTimeout(() => {
        this.off('event', handler);
        resolve({ success: false, error: 'Request timeout' } as T);
      }, 30000);

      this.send({ type, data });
    });
  }

  private handleBusEvent(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      return;
    }

    const event = payload as BridgeEvent;
    if (event.type === "ready") {
      const data = (event.data ?? {}) as ReadyData;
      if (data.session_key && data.session_key !== this.sessionKey) {
        if (this.sessionKey) {
          this.bus.unsubscribe(sessionChannel(this.sessionKey));
        }
        this.sessionKey = data.session_key;
        this.bus.subscribe(sessionChannel(data.session_key));
      }
    }

    if (event.type === "response") {
      const data = (event.data ?? {}) as ResponseData;
      const requestId = typeof data.request_id === "string" ? data.request_id : "";
      if (requestId && this.activeRuns.has(requestId)) {
        this.activeRuns.delete(requestId);
        this.bus.unsubscribe(runChannel(requestId));
      }
    }

    this.emit("event", event);
  }
}
