/**
 * JSONL-over-TCP bus server for bridge communication.
 */

import net, { type Socket, type Server } from 'net';
import type { BusClientMessage, BusServerMessage, BusMessage } from './bus_types.js';

export type BusPublishHandler = (
  connectionId: string,
  channel: string,
  payload: unknown
) => void | Promise<void>;

export interface BusServerOptions {
  host: string;
  port: number;
  onPublish: BusPublishHandler;
  onConnect?: (connectionId: string) => void;
  onDisconnect?: (connectionId: string) => void;
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

  constructor(options: BusServerOptions) {
    this.host = options.host;
    this.port = options.port;
    this.onPublish = options.onPublish;
    this.onConnect = options.onConnect;
    this.onDisconnect = options.onDisconnect;
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

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.handleData(connection, chunk));
    socket.on('close', () => this.handleClose(connection));
    socket.on('error', () => {
      // Connection errors are handled via close event.
    });
  }

  private handleClose(connection: ConnectionState): void {
    this.connections.delete(connection.id);
    if (this.onDisconnect) {
      this.onDisconnect(connection.id);
    }
  }

  private handleData(connection: ConnectionState, chunk: string): void {
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
  }

  private handleLine(connection: ConnectionState, line: string): void {
    let message: BusMessage;
    try {
      message = JSON.parse(line) as BusMessage;
    } catch (error) {
      this.sendError(connection, 'invalid_json', String(error));
      return;
    }

    if (!message || typeof message !== 'object' || !('type' in message)) {
      this.sendError(connection, 'invalid_message');
      return;
    }

    switch (message.type) {
      case 'subscribe':
        connection.subscriptions.add(message.channel);
        return;
      case 'unsubscribe':
        connection.subscriptions.delete(message.channel);
        return;
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
        return;
      default:
        this.sendError(connection, 'unsupported_message', message);
    }
  }

  private sendEvent(connection: ConnectionState, channel: string, payload: unknown): void {
    const message: BusServerMessage = {
      type: 'event',
      channel,
      payload,
    };
    this.send(connection, message);
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
    try {
      connection.socket.write(`${JSON.stringify(message)}\n`);
    } catch {
      // Ignore write failures; socket close handler will clean up.
    }
  }
}
