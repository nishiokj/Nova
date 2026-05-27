/**
 * WebSocket bus server for bridge communication.
 *
 * Supports direct EventBus subscription for run channels, eliminating
 * the need for intermediate event forwarding layers.
 */

import http from 'http';
import { timingSafeEqual } from 'crypto';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { profiler } from 'shared';
import type { BusClientMessage, BusServerMessage } from './bus_types.js';
import type { EventBusProtocol } from './event_bus.js';

export type BusPublishHandler = (
  connectionId: string,
  channel: string,
  payload: unknown
) => void | Promise<void>;

/**
 * Event translator function type.
 * Translates internal events to wire format. Returns null to filter out events.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventTranslator = (event: any) => unknown;

export interface BusServerOptions {
  host: string;
  port: number;
  onPublish: BusPublishHandler;
  onConnect?: (connectionId: string) => void;
  onDisconnect?: (connectionId: string) => void;
  /** Optional EventBus for direct subscription to run events */
  eventBus?: EventBusProtocol;
  /** Optional translator for EventBus events before sending to clients */
  eventTranslator?: EventTranslator;
  /** Optional outbound pressure controls for WebSocket clients */
  backpressure?: BackpressureOptions;
  /** Optional bearer token required during WebSocket upgrade. */
  authToken?: string;
}

export interface BackpressureOptions {
  enabled?: boolean;
  softLimitBytes?: number;
  hardLimitBytes?: number;
  maxQueuedMessages?: number;
  maxQueuedBytes?: number;
  lossyTtlMs?: number;
}

export interface BackpressureStats {
  sentCount: number;
  droppedLossyCount: number;
  coalescedLossyCount: number;
  overflowDisconnectCount: number;
  notOpenDropCount: number;
  maxBufferedAmountSeen: number;
  maxQueueDepthSeen: number;
}

type MessagePriority = 'lossless' | 'lossy';

interface SendMetadata {
  channel?: string;
  payload?: unknown;
}

interface QueuedMessage {
  serialized: string;
  bytes: number;
  priority: MessagePriority;
  createdAtMs: number;
  coalesceKey?: string;
}

const WS_OPEN = 1;

const DEFAULT_BACKPRESSURE: Required<BackpressureOptions> = {
  enabled: true,
  softLimitBytes: 1_048_576,
  hardLimitBytes: 8_388_608,
  maxQueuedMessages: 500,
  maxQueuedBytes: 2_097_152,
  lossyTtlMs: 2_000,
};

interface ConnectionState {
  id: string;
  ws: WebSocket;
  subscriptions: Set<string>;
  outboundQueue: QueuedMessage[];
  queuedBytes: number;
  flushScheduled: boolean;
  lossyIndex: Map<string, QueuedMessage>;
}

const GLOBAL_EVENTS_CHANNEL = 'events:all';

function normalizeAuthToken(token: string | undefined): string | null {
  const normalized = token?.trim();
  return normalized ? normalized : null;
}

function secureTokenEquals(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length
    && timingSafeEqual(candidateBuffer, expectedBuffer);
}

function decodeRawData(data: RawData): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data as unknown as Uint8Array).toString('utf8');
}

export class BusServer {
  private static readonly FLUSH_RETRY_MS = 10;
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private nextId = 1;
  private connections = new Map<string, ConnectionState>();
  private readonly host: string;
  private readonly port: number;
  private readonly onPublish: BusPublishHandler;
  private readonly onConnect?: (connectionId: string) => void;
  private readonly onDisconnect?: (connectionId: string) => void;
  private readonly eventBus: EventBusProtocol | null;
  private readonly eventTranslator: EventTranslator | null;
  private readonly authToken: string | null;
  private readonly backpressure: Required<BackpressureOptions>;
  private readonly backpressureStats: BackpressureStats = {
    sentCount: 0,
    droppedLossyCount: 0,
    coalescedLossyCount: 0,
    overflowDisconnectCount: 0,
    notOpenDropCount: 0,
    maxBufferedAmountSeen: 0,
    maxQueueDepthSeen: 0,
  };
  /** Maps runId → unsubscribe function for EventBus subscriptions */
  private runSubscriptions = new Map<string, () => void>();
  /** Unsubscribe function for a global EventBus subscription */
  private allEventsUnsubscribe: (() => void) | null = null;
  /** Extra unsubscribers for stream events that are not emitted on subscribeAll. */
  private allEventsStreamUnsubscribes: (() => void)[] = [];

  constructor(options: BusServerOptions) {
    this.host = options.host;
    this.port = options.port;
    this.onPublish = options.onPublish;
    this.onConnect = options.onConnect;
    this.onDisconnect = options.onDisconnect;
    this.eventBus = options.eventBus ?? null;
    this.eventTranslator = options.eventTranslator ?? null;
    this.authToken = normalizeAuthToken(options.authToken);
    this.backpressure = {
      ...DEFAULT_BACKPRESSURE,
      ...(options.backpressure ?? {}),
    };
  }

  getBackpressureStats(): BackpressureStats {
    return { ...this.backpressureStats };
  }

  /**
   * Subscribe to a run's events from EventBus and forward to WebSocket channel.
   * Called when a client subscribes to a run:* channel.
   */
  private subscribeToRun(runId: string, channel: string): void {
    if (!this.eventBus || this.runSubscriptions.has(runId)) return;

    const unsubscribe = this.eventBus.subscribeRun(runId, (event) => {
      const wireEvent = this.eventTranslator ? this.eventTranslator(event) : event;
      if (wireEvent !== null) {
        this.publish(channel, wireEvent);
      }
    });

    this.runSubscriptions.set(runId, unsubscribe);
  }

  /**
   * Unsubscribe from a run's events.
   */
  private unsubscribeFromRun(runId: string): void {
    const unsubscribe = this.runSubscriptions.get(runId);
    if (unsubscribe) {
      unsubscribe();
      this.runSubscriptions.delete(runId);
    }
  }

  private subscribeToAllEvents(channel: string): void {
    if (!this.eventBus || this.allEventsUnsubscribe) return;

    const forward = (event: unknown) => {
      const wireEvent = this.eventTranslator ? this.eventTranslator(event) : event;
      if (wireEvent !== null) {
        this.publish(channel, wireEvent);
      }
    };

    this.allEventsUnsubscribe = this.eventBus.subscribeAll(forward);

    // EventBus optimizes streaming events by bypassing subscribeAll/global fan-out.
    // Mirror those explicitly so events:all remains a complete real-time channel.
    this.allEventsStreamUnsubscribes = [
      this.eventBus.subscribe('agent_message', forward),
      this.eventBus.subscribe('agent_reasoning', forward),
    ];
  }

  private unsubscribeFromAllEvents(): void {
    if (this.allEventsUnsubscribe) {
      this.allEventsUnsubscribe();
      this.allEventsUnsubscribe = null;
    }
    for (const unsubscribe of this.allEventsStreamUnsubscribes) {
      unsubscribe();
    }
    this.allEventsStreamUnsubscribes = [];
  }

  /**
   * Check if any connection is still subscribed to a channel.
   */
  private hasSubscribers(channel: string): boolean {
    for (const connection of this.connections.values()) {
      if (connection.subscriptions.has(channel)) {
        return true;
      }
    }
    return false;
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.wss) {
      return this.getAddress();
    }

    const httpServer = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    this.httpServer = httpServer;
    this.wss = wss;

    httpServer.on('upgrade', (req, socket, head) => {
      if (!this.isAuthorized(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws);
      });
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(this.port, this.host, () => resolve());
    });

    this.wss.on('connection', (ws) => this.handleConnection(ws));

    return this.getAddress();
  }

  async stop(): Promise<void> {
    if (!this.wss) return;

    // Clean up all EventBus subscriptions
    for (const unsubscribe of this.runSubscriptions.values()) {
      unsubscribe();
    }
    this.runSubscriptions.clear();
    this.unsubscribeFromAllEvents();

    for (const connection of this.connections.values()) {
      this.clearQueue(connection);
      connection.ws.terminate();
    }
    this.connections.clear();

    this.wss.close();
    this.wss = null;

    if (this.httpServer) {
      const server = this.httpServer;
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      this.httpServer = null;
    }
  }

  publish(channel: string, payload: unknown): void {
    for (const connection of this.connections.values()) {
      if (connection.subscriptions.has(channel)) {
        this.sendEvent(connection, channel, payload);
      }
    }
  }

  sendTo(connectionId: string, channel: string, payload: unknown): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.sendEvent(connection, channel, payload);
  }

  getAddress(): { host: string; port: number } {
    if (!this.httpServer) {
      return { host: this.host, port: this.port };
    }

    const address = this.httpServer.address();
    if (!address || typeof address === 'string') {
      return { host: this.host, port: this.port };
    }

    return { host: address.address, port: address.port };
  }

  /**
   * Get the current number of connected clients.
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  isAuthRequired(): boolean {
    return this.authToken !== null;
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    if (!this.authToken) {
      return true;
    }

    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const match = /^Bearer\s+(.+)$/i.exec(value ?? '');
    if (!match) {
      return false;
    }

    return secureTokenEquals(match[1], this.authToken);
  }

  private handleConnection(ws: WebSocket): void {
    const connectionId = `conn_${this.nextId++}`;
    const connection: ConnectionState = {
      id: connectionId,
      ws,
      subscriptions: new Set(),
      outboundQueue: [],
      queuedBytes: 0,
      flushScheduled: false,
      lossyIndex: new Map(),
    };
    this.connections.set(connectionId, connection);

    if (this.onConnect) {
      this.onConnect(connectionId);
    }

    ws.on('message', (data: RawData) => this.handleMessage(connection, decodeRawData(data)));
    ws.on('close', () => this.handleClose(connection));
    ws.on('error', () => {
      // Connection errors are handled via close event.
    });
  }

  private handleClose(connection: ConnectionState): void {
    // Remove connection first so hasSubscribers() reflects only active peers.
    this.connections.delete(connection.id);
    this.clearQueue(connection);
    connection.flushScheduled = false;

    // Clean up run subscriptions that this connection was the last subscriber for
    for (const channel of connection.subscriptions) {
      const runMatch = /^run:(.+)$/.exec(channel);
      if (runMatch && !this.hasSubscribers(channel)) {
        this.unsubscribeFromRun(runMatch[1]);
      }
      if (channel === GLOBAL_EVENTS_CHANNEL && !this.hasSubscribers(channel)) {
        this.unsubscribeFromAllEvents();
      }
    }

    if (this.onDisconnect) {
      this.onDisconnect(connection.id);
    }
  }

  private handleMessage(connection: ConnectionState, data: string): void {
    profiler.begin('bus.server.parse', 'bus');
    let message: BusClientMessage;
    try {
      message = JSON.parse(data) as BusClientMessage;
    } catch (error) {
      profiler.end('bus.server.parse', 'bus');
      this.sendError(connection, 'invalid_json', String(error));
      return;
    }
    profiler.end('bus.server.parse', 'bus');

    profiler.begin(`bus.server.dispatch:${message.type}`, 'bus');
    switch (message.type) {
      case 'subscribe': {
        connection.subscriptions.add(message.channel);

        // If subscribing to a run channel, subscribe to EventBus for direct forwarding
        const runMatch = /^run:(.+)$/.exec(message.channel);
        if (runMatch && this.eventBus) {
          this.subscribeToRun(runMatch[1], message.channel);
        }
        if (message.channel === GLOBAL_EVENTS_CHANNEL && this.eventBus) {
          this.subscribeToAllEvents(message.channel);
        }
        profiler.end(`bus.server.dispatch:${message.type}`, 'bus');
        return;
      }
      case 'unsubscribe': {
        connection.subscriptions.delete(message.channel);

        // If unsubscribing from a run channel and no other clients need it, unsubscribe from EventBus
        const runMatch = /^run:(.+)$/.exec(message.channel);
        if (runMatch && !this.hasSubscribers(message.channel)) {
          this.unsubscribeFromRun(runMatch[1]);
        }
        if (message.channel === GLOBAL_EVENTS_CHANNEL && !this.hasSubscribers(message.channel)) {
          this.unsubscribeFromAllEvents();
        }
        profiler.end(`bus.server.dispatch:${message.type}`, 'bus');
        return;
      }
      case 'publish':
        try {
          const result = this.onPublish(connection.id, message.channel, message.payload);
          if (result && typeof (result).catch === 'function') {
            (result).catch((error: unknown) => {
              this.sendError(connection, 'publish_failed', String(error));
            });
          }
        } catch (error) {
          this.sendError(connection, 'publish_failed', String(error));
        }
        profiler.end(`bus.server.dispatch:${message.type}`, 'bus');
        return;
    }
  }

  private sendEvent(connection: ConnectionState, channel: string, payload: unknown): void {
    profiler.begin('bus.server.sendEvent', 'bus');
    const message: BusServerMessage = {
      type: 'event',
      channel,
      payload,
    };
    this.send(connection, message, { channel, payload });
    profiler.end('bus.server.sendEvent', 'bus');
  }

  private sendError(connection: ConnectionState, message: string, detail?: unknown): void {
    const errorMessage: BusServerMessage = {
      type: 'error',
      message,
      detail,
    };
    this.send(connection, errorMessage);
  }

  private send(
    connection: ConnectionState,
    message: BusServerMessage | BusClientMessage,
    metadata?: SendMetadata
  ): void {
    profiler.begin('bus.server.serialize', 'bus');
    try {
      const serialized = JSON.stringify(message);
      profiler.end('bus.server.serialize', 'bus');
      const queuedMessage = this.createQueuedMessage(message, serialized, metadata);
      this.enqueueMessage(connection, queuedMessage);
    } catch {
      profiler.end('bus.server.serialize', 'bus');
      // Ignore write failures; socket close handler will clean up.
    }
  }

  private createQueuedMessage(
    message: BusServerMessage | BusClientMessage,
    serialized: string,
    metadata?: SendMetadata
  ): QueuedMessage {
    const priority = this.classifyPriority(message, metadata);
    return {
      serialized,
      bytes: Buffer.byteLength(serialized),
      priority,
      createdAtMs: Date.now(),
      coalesceKey: priority === 'lossy' ? this.getCoalesceKey(metadata) : undefined,
    };
  }

  private classifyPriority(
    message: BusServerMessage | BusClientMessage,
    metadata?: SendMetadata
  ): MessagePriority {
    if (message.type !== 'event') return 'lossless';
    if (metadata?.channel !== GLOBAL_EVENTS_CHANNEL) return 'lossless';

    const payload = metadata.payload;
    if (!payload || typeof payload !== 'object') return 'lossless';
    const eventType = (payload as { type?: unknown }).type;
    if (eventType === 'agent_message' || eventType === 'agent_reasoning') {
      return 'lossy';
    }
    return 'lossless';
  }

  private getCoalesceKey(metadata?: SendMetadata): string | undefined {
    if (!metadata?.payload || typeof metadata.payload !== 'object') return undefined;
    const payload = metadata.payload as {
      type?: unknown;
      sessionKey?: unknown;
      runId?: unknown;
      requestId?: unknown;
    };
    const streamType = typeof payload.type === 'string' ? payload.type : 'event';
    const streamId = typeof payload.sessionKey === 'string' ? payload.sessionKey
      : typeof payload.runId === 'string' ? payload.runId
      : typeof payload.requestId === 'string' ? payload.requestId : 'default';
    return `${metadata.channel ?? 'unknown'}:${streamType}:${streamId}`;
  }

  private enqueueMessage(connection: ConnectionState, queuedMessage: QueuedMessage): void {
    if (!this.backpressure.enabled) {
      this.writeImmediate(connection, queuedMessage.serialized);
      return;
    }

    profiler.begin('bus.server.enqueue', 'bus');
    if (!this.isConnectionOpen(connection)) {
      profiler.end('bus.server.enqueue', 'bus');
      this.handleNotOpenConnection(connection);
      return;
    }

    this.trackBufferedAmount(connection.ws.bufferedAmount);
    if (connection.ws.bufferedAmount > this.backpressure.hardLimitBytes) {
      profiler.end('bus.server.enqueue', 'bus');
      this.terminateForOverflow(connection);
      return;
    }

    if (queuedMessage.priority === 'lossy' && this.shouldCoalesce(connection)) {
      const existing = queuedMessage.coalesceKey
        ? connection.lossyIndex.get(queuedMessage.coalesceKey)
        : undefined;
      if (existing) {
        connection.queuedBytes -= existing.bytes;
        existing.serialized = queuedMessage.serialized;
        existing.bytes = queuedMessage.bytes;
        existing.createdAtMs = queuedMessage.createdAtMs;
        connection.queuedBytes += existing.bytes;
        this.backpressureStats.coalescedLossyCount++;
        profiler.end('bus.server.enqueue', 'bus');
        this.scheduleFlush(connection);
        return;
      }
    }

    connection.outboundQueue.push(queuedMessage);
    connection.queuedBytes += queuedMessage.bytes;
    if (queuedMessage.coalesceKey) {
      connection.lossyIndex.set(queuedMessage.coalesceKey, queuedMessage);
    }
    this.backpressureStats.maxQueueDepthSeen = Math.max(
      this.backpressureStats.maxQueueDepthSeen,
      connection.outboundQueue.length
    );

    if (this.isQueueOverflow(connection)) {
      this.compactLossyQueue(connection);
      if (this.isQueueOverflow(connection)) {
        profiler.end('bus.server.enqueue', 'bus');
        this.terminateForOverflow(connection);
        return;
      }
    }

    profiler.end('bus.server.enqueue', 'bus');
    this.scheduleFlush(connection);
  }

  private shouldCoalesce(connection: ConnectionState): boolean {
    return (
      connection.ws.bufferedAmount >= this.backpressure.softLimitBytes ||
      connection.outboundQueue.length > 0
    );
  }

  private isQueueOverflow(connection: ConnectionState): boolean {
    return (
      connection.outboundQueue.length > this.backpressure.maxQueuedMessages ||
      connection.queuedBytes > this.backpressure.maxQueuedBytes
    );
  }

  private compactLossyQueue(connection: ConnectionState): void {
    while (this.isQueueOverflow(connection)) {
      const lossyIndex = connection.outboundQueue.findIndex((msg) => msg.priority === 'lossy');
      if (lossyIndex < 0) {
        return;
      }
      this.dropQueuedAt(connection, lossyIndex, 'bus.server.dropLossy.compact');
    }
  }

  private scheduleFlush(connection: ConnectionState, delayMs = 0): void {
    if (connection.flushScheduled) return;
    connection.flushScheduled = true;

    const run = () => this.flushQueue(connection.id);
    if (delayMs > 0) {
      setTimeout(run, delayMs);
      return;
    }
    queueMicrotask(run);
  }

  private flushQueue(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    connection.flushScheduled = false;

    if (!this.backpressure.enabled) return;
    if (!this.isConnectionOpen(connection)) {
      this.handleNotOpenConnection(connection);
      return;
    }

    while (connection.outboundQueue.length > 0) {
      if (!this.isConnectionOpen(connection)) {
        this.handleNotOpenConnection(connection);
        return;
      }

      this.trackBufferedAmount(connection.ws.bufferedAmount);
      if (connection.ws.bufferedAmount > this.backpressure.hardLimitBytes) {
        this.terminateForOverflow(connection);
        return;
      }

      let sendIndex = 0;
      let next = connection.outboundQueue[sendIndex];

      if (next.priority === 'lossy') {
        const ageMs = Date.now() - next.createdAtMs;
        if (ageMs > this.backpressure.lossyTtlMs) {
          this.dropQueuedAt(connection, 0, 'bus.server.dropLossy.ttl');
          continue;
        }
        if (connection.ws.bufferedAmount >= this.backpressure.softLimitBytes) {
          const prioritized = connection.outboundQueue.findIndex(
            (message) => message.priority === 'lossless'
          );
          if (prioritized < 0) {
            this.scheduleFlush(connection, BusServer.FLUSH_RETRY_MS);
            return;
          }
          sendIndex = prioritized;
          next = connection.outboundQueue[sendIndex];
        }
      }

      profiler.begin('bus.server.write', 'bus');
      try {
        connection.ws.send(next.serialized);
        this.backpressureStats.sentCount++;
        this.trackBufferedAmount(connection.ws.bufferedAmount);
      } catch {
        // Ignore write failures; socket close handler will clean up.
      }
      profiler.end('bus.server.write', 'bus');
      this.dropQueuedAt(connection, sendIndex);
    }
  }

  private writeImmediate(connection: ConnectionState, serialized: string): void {
    if (!this.isConnectionOpen(connection)) {
      this.handleNotOpenConnection(connection);
      return;
    }

    profiler.begin('bus.server.write', 'bus');
    try {
      connection.ws.send(serialized);
      this.backpressureStats.sentCount++;
      this.trackBufferedAmount(connection.ws.bufferedAmount);
    } catch {
      // Ignore write failures; socket close handler will clean up.
    }
    profiler.end('bus.server.write', 'bus');
  }

  private dropQueuedAt(connection: ConnectionState, index: number, spanName?: string): void {
    if (spanName) {
      profiler.begin(spanName, 'bus');
    }
    const [dropped] = connection.outboundQueue.splice(index, 1);

    connection.queuedBytes = Math.max(0, connection.queuedBytes - dropped.bytes);
    if (
      dropped.coalesceKey &&
      connection.lossyIndex.get(dropped.coalesceKey) === dropped
    ) {
      connection.lossyIndex.delete(dropped.coalesceKey);
    }
    if (dropped.priority === 'lossy' && spanName) {
      this.backpressureStats.droppedLossyCount++;
    }
    if (spanName) {
      profiler.end(spanName, 'bus');
    }
  }

  private isConnectionOpen(connection: ConnectionState): boolean {
    return connection.ws.readyState === WS_OPEN;
  }

  private handleNotOpenConnection(connection: ConnectionState): void {
    profiler.begin('bus.server.dropNotOpen', 'bus');
    this.backpressureStats.notOpenDropCount++;
    this.clearQueue(connection);
    try {
      connection.ws.terminate();
    } catch {
      // Best-effort cleanup.
    }
    profiler.end('bus.server.dropNotOpen', 'bus');
  }

  private terminateForOverflow(connection: ConnectionState): void {
    profiler.begin('bus.server.terminateOverflow', 'bus');
    this.backpressureStats.overflowDisconnectCount++;
    this.clearQueue(connection);
    try {
      connection.ws.terminate();
    } catch {
      // Best-effort cleanup.
    }
    profiler.end('bus.server.terminateOverflow', 'bus');
  }

  private trackBufferedAmount(bufferedAmount: number): void {
    this.backpressureStats.maxBufferedAmountSeen = Math.max(
      this.backpressureStats.maxBufferedAmountSeen,
      bufferedAmount
    );
  }

  private clearQueue(connection: ConnectionState): void {
    connection.outboundQueue = [];
    connection.queuedBytes = 0;
    connection.lossyIndex.clear();
  }
}
