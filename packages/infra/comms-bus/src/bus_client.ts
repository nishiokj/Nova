/**
 * WebSocket bus client for bridge communication.
 */

import WebSocket from 'ws';
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
  private ws: WebSocket | null = null;
  private connected = false;
  private subscriptions = new Set<string>();

  constructor(options: BusClientOptions) {
    super();
    this.host = options.host;
    this.port = options.port;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const url = `ws://${this.host}:${this.port}`;
    this.ws = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
      this.ws!.once('error', reject);
      this.ws!.once('open', () => resolve());
    });

    this.connected = true;
    this.ws.on('message', (data: WebSocket.RawData) => this.handleMessage(String(data)));
    this.ws.on('close', () => this.handleClose());
    this.ws.on('error', (error) => {
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
    if (!this.ws) return;
    this.connected = false;
    this.subscriptions.clear();
    const ws = this.ws;
    this.ws = null;
    ws.close();
  }

  private handleClose(): void {
    this.connected = false;
    this.emit('close');
  }

  private handleMessage(data: string): void {
    profiler.begin('bus.client.parse', 'bus');
    let message: BusMessage;
    try {
      message = JSON.parse(data) as BusMessage;
    } catch (error) {
      profiler.end('bus.client.parse', 'bus');
      this.emit('error', { message: 'invalid_json', detail: String(error) });
      return;
    }
    profiler.end('bus.client.parse', 'bus');

    if (!message || typeof message !== 'object' || !('type' in message)) {
      this.emit('error', { message: 'invalid_message', detail: data });
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
    if (!this.ws || !this.connected) {
      this.emit('error', { message: 'bus_not_connected' });
      return;
    }

    profiler.begin('bus.client.serialize', 'bus');
    try {
      const serialized = JSON.stringify(message);
      profiler.end('bus.client.serialize', 'bus');
      profiler.begin('bus.client.write', 'bus');
      this.ws.send(serialized);
      profiler.end('bus.client.write', 'bus');
    } catch (error) {
      profiler.end('bus.client.serialize', 'bus');
      this.emit('error', { message: 'bus_send_failed', detail: String(error) });
    }
  }
}
