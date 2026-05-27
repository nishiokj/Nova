import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { BusClientMessage, BusServerMessage } from '@nova/protocol';

export interface BusTransportOptions {
  host: string;
  port: number;
  authToken?: string;
}

export class BusTransport extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private readonly authToken: string | null;
  private ws: WebSocket | null = null;
  private connected = false;
  private subscriptions = new Set<string>();

  constructor(options: BusTransportOptions) {
    super();
    this.host = options.host;
    this.port = options.port;
    this.authToken = options.authToken?.trim() || null;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const ws = new WebSocket(`ws://${this.host}:${this.port}`, {
      ...(this.authToken ? { headers: { Authorization: `Bearer ${this.authToken}` } } : {}),
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.once('error', reject);
      ws.once('open', () => resolve());
    });

    this.connected = true;
    ws.on('message', (data: WebSocket.RawData) => this.handleMessage(Buffer.from(data as Buffer).toString('utf-8')));
    ws.on('close', () => this.handleClose());
    ws.on('error', (error) => {
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
    let message: BusServerMessage;
    try {
      message = JSON.parse(data) as BusServerMessage;
    } catch (error) {
      this.emit('error', { message: 'invalid_json', detail: String(error) });
      return;
    }

    switch (message.type) {
      case 'event':
        this.emit('event', message.payload, message.channel);
        return;
      case 'error':
        this.emit('error', { message: message.message, detail: message.detail });
        return;
    }
  }

  private send(message: BusClientMessage): void {
    if (!this.ws || !this.connected) {
      this.emit('error', { message: 'bus_not_connected' });
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      this.emit('error', { message: 'bus_send_failed', detail: String(error) });
    }
  }
}
