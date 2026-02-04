/**
 * JSONL-over-TCP bus server for bridge communication.
 *
 * Supports direct EventBus subscription for run channels, eliminating
 * the need for intermediate event forwarding layers.
 */

import net, { type Socket, type Server } from 'net';
import { profiler } from 'shared';
import type { BusClientMessage, BusServerMessage, BusMessage } from './bus_types.js';
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
export type EventTranslator = (event: any) => unknown | null;

export interface BusServerOptions {
  host: string;
  port: number;
  onPublish: BusPublishHandler;
  onConnect?: (connectionId: string) => void;
  onDisconnect?: (connectionId: string) => void;
  /** Optional EventBus for direct subscription to run events */
  eventBus?: EventBusProtocol;
  /** Optional translator for EventBus events before sending over TCP */
  eventTranslator?: EventTranslator;
}

interface ConnectionState {
  id: string;
  socket: Socket;
  buffer: string;
  subscriptions: Set<string>;
}

export class BusServer {
  private server: Server | null = null;
  private nextId = 1;
  private connections = new Map<string, ConnectionState>();
  private readonly host: string;
  private readonly port: number;
  private readonly onPublish: BusPublishHandler;
  private readonly onConnect?: (connectionId: string) => void;
  private readonly onDisconnect?: (connectionId: string) => void;
  private readonly eventBus: EventBusProtocol | null;
  private readonly eventTranslator: EventTranslator | null;
  /** Maps runId → unsubscribe function for EventBus subscriptions */
  private runSubscriptions = new Map<string, () => void>();

  constructor(options: BusServerOptions) {
    this.host = options.host;
    this.port = options.port;
    this.onPublish = options.onPublish;
    this.onConnect = options.onConnect;
    this.onDisconnect = options.onDisconnect;
    this.eventBus = options.eventBus ?? null;
    this.eventTranslator = options.eventTranslator ?? null;
  }

  /**
   * Subscribe to a run's events from EventBus and forward to TCP channel.
   * Called when a client subscribes to a run:* channel.
   */
  private subscribeToRun(runId: string, channel: string): void {
    if (!this.eventBus || this.runSubscriptions.has(runId)) return;

    const unsubscribe = this.eventBus.subscribeRun(runId, (event) => {
      // Translate event if translator provided, otherwise pass through
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
    if (this.server) {
      return this.getAddress();
    }

    this.server = net.createServer((socket) => this.handleConnection(socket));

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => resolve());
    });

    return this.getAddress();
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    // Clean up all EventBus subscriptions
    for (const unsubscribe of this.runSubscriptions.values()) {
      unsubscribe();
    }
    this.runSubscriptions.clear();

    for (const connection of this.connections.values()) {
      connection.socket.destroy();
    }
    this.connections.clear();

    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
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
    if (!this.server) {
      return { host: this.host, port: this.port };
    }

    const address = this.server.address();
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

  private handleConnection(socket: Socket): void {
    const connectionId = `conn_${this.nextId++}`;
    const connection: ConnectionState = {
      id: connectionId,
      socket,
      buffer: '',
      subscriptions: new Set(),
    };
    this.connections.set(connectionId, connection);

    if (this.onConnect) {
      this.onConnect(connectionId);
    }

    socket.setNoDelay(true);  // Disable Nagle algorithm for low-latency streaming
    socket.setKeepAlive(true, 30000);  // Enable TCP keepalive, probe every 30s to detect dead connections
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.handleData(connection, chunk));
    socket.on('close', () => this.handleClose(connection));
    socket.on('error', () => {
      // Connection errors are handled via close event.
    });
  }

  private handleClose(connection: ConnectionState): void {
    // Clean up run subscriptions that this connection was the last subscriber for
    for (const channel of connection.subscriptions) {
      const runMatch = channel.match(/^run:(.+)$/);
      if (runMatch && !this.hasSubscribers(channel)) {
        this.unsubscribeFromRun(runMatch[1]);
      }
    }

    this.connections.delete(connection.id);
    if (this.onDisconnect) {
      this.onDisconnect(connection.id);
    }
  }

  private handleData(connection: ConnectionState, chunk: string): void {
    profiler.begin('bus.server.handleData', 'bus');
    connection.buffer += chunk;
    let newlineIndex = connection.buffer.indexOf('\n');

    while (newlineIndex >= 0) {
      const line = connection.buffer.slice(0, newlineIndex).trim();
      connection.buffer = connection.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleLine(connection, line);
      }
      newlineIndex = connection.buffer.indexOf('\n');
    }
    profiler.end('bus.server.handleData', 'bus');
  }

  private handleLine(connection: ConnectionState, line: string): void {
    profiler.begin('bus.server.parse', 'bus');
    let message: BusMessage;
    try {
      message = JSON.parse(line) as BusMessage;
    } catch (error) {
      profiler.end('bus.server.parse', 'bus');
      this.sendError(connection, 'invalid_json', String(error));
      return;
    }
    profiler.end('bus.server.parse', 'bus');

    if (!message || typeof message !== 'object' || !('type' in message)) {
      this.sendError(connection, 'invalid_message');
      return;
    }

    profiler.begin(`bus.server.dispatch:${message.type}`, 'bus');
    switch (message.type) {
      case 'subscribe': {
        connection.subscriptions.add(message.channel);

        // If subscribing to a run channel, subscribe to EventBus for direct forwarding
        const runMatch = message.channel.match(/^run:(.+)$/);
        if (runMatch && this.eventBus) {
          this.subscribeToRun(runMatch[1], message.channel);
        }
        profiler.end(`bus.server.dispatch:${message.type}`, 'bus');
        return;
      }
      case 'unsubscribe': {
        connection.subscriptions.delete(message.channel);

        // If unsubscribing from a run channel and no other clients need it, unsubscribe from EventBus
        const runMatch = message.channel.match(/^run:(.+)$/);
        if (runMatch && !this.hasSubscribers(message.channel)) {
          this.unsubscribeFromRun(runMatch[1]);
        }
        profiler.end(`bus.server.dispatch:${message.type}`, 'bus');
        return;
      }
      case 'publish':
        try {
          const result = this.onPublish(connection.id, message.channel, message.payload);
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch((error) => {
              this.sendError(connection, 'publish_failed', String(error));
            });
          }
        } catch (error) {
          this.sendError(connection, 'publish_failed', String(error));
        }
        profiler.end(`bus.server.dispatch:${message.type}`, 'bus');
        return;
      default:
        profiler.end(`bus.server.dispatch:${message.type}`, 'bus');
        this.sendError(connection, 'unsupported_message', message);
    }
  }

  private sendEvent(connection: ConnectionState, channel: string, payload: unknown): void {
    profiler.begin('bus.server.sendEvent', 'bus');
    const message: BusServerMessage = {
      type: 'event',
      channel,
      payload,
    };
    this.send(connection, message);
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

  private send(connection: ConnectionState, message: BusServerMessage | BusClientMessage): void {
    profiler.begin('bus.server.serialize', 'bus');
    try {
      const serialized = JSON.stringify(message);
      profiler.end('bus.server.serialize', 'bus');
      profiler.begin('bus.server.write', 'bus');
      connection.socket.write(`${serialized}\n`);
      profiler.end('bus.server.write', 'bus');
    } catch {
      profiler.end('bus.server.serialize', 'bus');
      // Ignore write failures; socket close handler will clean up.
    }
  }
}
