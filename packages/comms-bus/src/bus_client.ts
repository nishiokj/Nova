/**
 * JSONL-over-TCP bus client for bridge communication.
 */

import net from 'net';
import { EventEmitter } from 'events';
import { profiler } from 'shared';
import type { BusClientMessage, BusServerMessage, BusMessage } from './bus_types.js';

export interface BusClientOptions {
  host: string;
  port: number;
}

export class BusClient extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private socket: net.Socket | null = null;
  private buffer = '';
  private connected = false;
  private subscriptions = new Set<string>();

  constructor(options: BusClientOptions) {
    super();
    this.host = options.host;
    this.port = options.port;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.socket = new net.Socket();

    await new Promise<void>((resolve, reject) => {
      this.socket!.once('error', reject);
      this.socket!.connect(this.port, this.host, () => resolve());
    });

    this.connected = true;
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => this.handleData(chunk));
    this.socket.on('close', () => this.handleClose());
    this.socket.on('error', (error) => {
      this.emit('error', { message: 'bus_client_error', detail: String(error) });
    });
  }

  subscribe(channel: string): void {
    if (this.subscriptions.has(channel)) return;
    this.subscriptions.add(channel);
    this.send({ type: 'subscribe', channel });
  }

  unsubscribe(channel: string): void {
    if (!this.subscriptions.has(channel)) return;
    this.subscriptions.delete(channel);
    this.send({ type: 'unsubscribe', channel });
  }

  publish(channel: string, payload: unknown): void {
    this.send({ type: 'publish', channel, payload });
  }

  close(): void {
    if (!this.socket) return;
    this.connected = false;
    this.subscriptions.clear();
    this.socket.end();
    this.socket.destroy();
    this.socket = null;
  }

  private handleClose(): void {
    this.connected = false;
    this.emit('close');
  }

  private handleData(chunk: string): void {
    profiler.begin('bus.client.handleData', 'bus');
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf('\n');

    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
    profiler.end('bus.client.handleData', 'bus');
  }

  private handleLine(line: string): void {
    profiler.begin('bus.client.parse', 'bus');
    let message: BusMessage;
    try {
      message = JSON.parse(line) as BusMessage;
    } catch (error) {
      profiler.end('bus.client.parse', 'bus');
      this.emit('error', { message: 'invalid_json', detail: String(error) });
      return;
    }
    profiler.end('bus.client.parse', 'bus');

    if (!message || typeof message !== 'object' || !('type' in message)) {
      this.emit('error', { message: 'invalid_message', detail: line });
      return;
    }

    profiler.begin(`bus.client.emit:${message.type}`, 'bus');
    switch (message.type) {
      case 'event':
        this.emit('event', message.payload, message.channel);
        profiler.end(`bus.client.emit:${message.type}`, 'bus');
        return;
      case 'error':
        this.emit('error', { message: message.message, detail: message.detail });
        profiler.end(`bus.client.emit:${message.type}`, 'bus');
        return;
      default:
        profiler.end(`bus.client.emit:${message.type}`, 'bus');
        this.emit('error', { message: 'unexpected_message', detail: message });
    }
  }

  private send(message: BusClientMessage | BusServerMessage): void {
    if (!this.socket || !this.connected) {
      this.emit('error', { message: 'bus_not_connected' });
      return;
    }

    profiler.begin('bus.client.serialize', 'bus');
    try {
      const serialized = JSON.stringify(message);
      profiler.end('bus.client.serialize', 'bus');
      profiler.begin('bus.client.write', 'bus');
      this.socket.write(`${serialized}\n`);
      profiler.end('bus.client.write', 'bus');
    } catch (error) {
      profiler.end('bus.client.serialize', 'bus');
      this.emit('error', { message: 'bus_send_failed', detail: String(error) });
    }
  }
}
