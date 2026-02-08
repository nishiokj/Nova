/**
 * WebSocket-to-TCP bridge for browser clients.
 *
 * Provides WebSocket endpoint that bridges to the TCP event bus,
 * allowing browser dashboards to receive live events.
 */

import { createServer, type Server as HttpServer, type IncomingMessage } from 'http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { BusMessage, BusServerMessage, BusClientMessage } from './bus_types.js';
import type { EventBusProtocol } from './event_bus.js';
import type { EventTranslator } from './bus_server.js';

export interface WsBridgeOptions {
  /** HTTP port to listen on for WebSocket connections */
  port: number;
  /** Host to bind to (default: 127.0.0.1) */
  host?: string;
  /** TCP bus host to connect to (reserved for compatibility) */
  busHost?: string;
  /** TCP bus port to connect to (reserved for compatibility) */
  busPort?: number;
  /** Optional CORS origin for browser access (default: *) */
  corsOrigin?: string;
  /** Optional EventBus for direct run channel subscriptions */
  eventBus?: EventBusProtocol;
  /** Optional translator for EventBus events before sending over WebSocket */
  eventTranslator?: EventTranslator;
}

interface WsConnectionState {
  id: string;
  ws: WebSocket;
  subscriptions: Set<string>;
}

export class WsBridgeServer {
  private readonly port: number;
  private readonly host: string;
  private readonly busHost: string;
  private readonly busPort: number;
  private readonly corsOrigin: string;
  private readonly eventBus: EventBusProtocol | null;
  private readonly eventTranslator: EventTranslator | null;

  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private connections = new Map<string, WsConnectionState>();
  private nextId = 1;

  // Global subscription tracking: channel → set of connection IDs
  private channelSubscribers = new Map<string, Set<string>>();
  /** Maps runId → unsubscribe function for EventBus subscriptions */
  private runSubscriptions = new Map<string, () => void>();

  constructor(options: WsBridgeOptions) {
    this.port = options.port;
    this.host = options.host ?? '127.0.0.1';
    this.busHost = options.busHost ?? this.host;
    this.busPort = options.busPort ?? 0;
    this.corsOrigin = options.corsOrigin ?? '*';
    this.eventBus = options.eventBus ?? null;
    this.eventTranslator = options.eventTranslator ?? null;
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.httpServer) {
      return this.getAddress();
    }

    // Create HTTP server for WebSocket upgrade
    this.httpServer = createServer((req, res) => {
      // Handle CORS preflight
      res.setHeader('Access-Control-Allow-Origin', this.corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health check endpoint
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', connections: this.connections.size }));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    // Create WebSocket server
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(this.port, this.host, () => resolve());
    });

    return this.getAddress();
  }

  async stop(): Promise<void> {
    if (!this.httpServer) return;

    for (const unsubscribe of this.runSubscriptions.values()) {
      unsubscribe();
    }
    this.runSubscriptions.clear();

    // Close all WebSocket connections
    for (const connection of this.connections.values()) {
      connection.ws.close(1000, 'Server shutting down');
    }
    this.connections.clear();
    this.channelSubscribers.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Close HTTP server
    await new Promise<void>((resolve) => {
      this.httpServer!.close(() => resolve());
    });
    this.httpServer = null;
  }

  /**
   * Publish an event to all WebSocket clients subscribed to the channel.
   */
  publish(channel: string, payload: unknown): void {
    const subscribers = this.channelSubscribers.get(channel);
    if (!subscribers || subscribers.size === 0) return;

    const message: BusServerMessage = {
      type: 'event',
      channel,
      payload,
    };
    const serialized = JSON.stringify(message);

    for (const connId of subscribers) {
      const connection = this.connections.get(connId);
      if (connection && connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.send(serialized);
      }
    }
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

  getConnectionCount(): number {
    return this.connections.size;
  }

  private handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    const connectionId = `ws_${this.nextId++}`;
    const connection: WsConnectionState = {
      id: connectionId,
      ws,
      subscriptions: new Set(),
    };
    this.connections.set(connectionId, connection);

    ws.on('message', (data) => this.handleMessage(connection, data));
    ws.on('close', () => this.handleClose(connection));
    ws.on('error', () => {
      // Errors are handled via close event
    });
  }

  private handleClose(connection: WsConnectionState): void {
    // Remove from all channel subscriptions
    for (const channel of connection.subscriptions) {
      const subscribers = this.channelSubscribers.get(channel);
      if (subscribers) {
        subscribers.delete(connection.id);
        if (subscribers.size === 0) {
          this.channelSubscribers.delete(channel);
        }
      }
      const runMatch = channel.match(/^run:(.+)$/);
      if (runMatch && !this.hasSubscribers(channel)) {
        this.unsubscribeFromRun(runMatch[1]);
      }
    }

    this.connections.delete(connection.id);
  }

  private handleMessage(connection: WsConnectionState, data: RawData): void {
    let message: BusMessage;
    try {
      message = JSON.parse(data.toString()) as BusMessage;
    } catch {
      this.sendError(connection, 'invalid_json');
      return;
    }

    if (!message || typeof message !== 'object' || !('type' in message)) {
      this.sendError(connection, 'invalid_message');
      return;
    }

    switch (message.type) {
      case 'subscribe':
        this.handleSubscribe(connection, message.channel);
        break;
      case 'unsubscribe':
        this.handleUnsubscribe(connection, message.channel);
        break;
      case 'publish':
        // Browser clients can publish too (for future use)
        this.publish(message.channel, message.payload);
        break;
      default:
        this.sendError(connection, 'unsupported_message', message);
    }
  }

  private handleSubscribe(connection: WsConnectionState, channel: string): void {
    connection.subscriptions.add(channel);

    if (!this.channelSubscribers.has(channel)) {
      this.channelSubscribers.set(channel, new Set());
    }
    this.channelSubscribers.get(channel)!.add(connection.id);

    const runMatch = channel.match(/^run:(.+)$/);
    if (runMatch && this.eventBus) {
      this.subscribeToRun(runMatch[1], channel);
    }
  }

  private handleUnsubscribe(connection: WsConnectionState, channel: string): void {
    connection.subscriptions.delete(channel);

    const subscribers = this.channelSubscribers.get(channel);
    if (subscribers) {
      subscribers.delete(connection.id);
      if (subscribers.size === 0) {
        this.channelSubscribers.delete(channel);
      }
    }

    const runMatch = channel.match(/^run:(.+)$/);
    if (runMatch && !this.hasSubscribers(channel)) {
      this.unsubscribeFromRun(runMatch[1]);
    }
  }

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

  private unsubscribeFromRun(runId: string): void {
    const unsubscribe = this.runSubscriptions.get(runId);
    if (!unsubscribe) return;
    unsubscribe();
    this.runSubscriptions.delete(runId);
  }

  private hasSubscribers(channel: string): boolean {
    const subscribers = this.channelSubscribers.get(channel);
    return !!(subscribers && subscribers.size > 0);
  }

  private sendError(connection: WsConnectionState, message: string, detail?: unknown): void {
    if (connection.ws.readyState !== WebSocket.OPEN) return;

    const errorMessage: BusServerMessage = {
      type: 'error',
      message,
      detail,
    };
    connection.ws.send(JSON.stringify(errorMessage));
  }
}
