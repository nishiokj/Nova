/**
 * Tests for JSONL bus server/client.
 */

import { describe, it, expect } from 'bun:test';
import { BusServer } from './bus_server.js';
import { BusClient } from './bus_client.js';
import { BRIDGE_COMMAND_CHANNEL } from './bus_channels.js';
import { EventBus } from './event_bus.js';

function waitFor(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timeout'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('BusServer/BusClient', () => {
  it('broadcasts events to subscribed clients', async () => {
    const publishes: Array<{ id: string; channel: string; payload: unknown }> = [];
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: (id, channel, payload) => {
        publishes.push({ id, channel, payload });
      },
    });
    const address = await server.start();

    const client = new BusClient({ host: address.host, port: address.port });
    const events: Array<{ channel: string; payload: unknown }> = [];
    client.on('event', (payload, channel) => {
      events.push({ channel, payload });
    });
    await client.connect();

    client.subscribe('room:alpha');
    await new Promise((resolve) => setTimeout(resolve, 20));

    server.publish('room:alpha', { ok: true });
    await waitFor(() => events.length === 1);

    expect(events[0]).toEqual({ channel: 'room:alpha', payload: { ok: true } });

    client.publish(BRIDGE_COMMAND_CHANNEL, { type: 'ping' });
    await waitFor(() => publishes.length === 1);
    expect(publishes[0].channel).toBe(BRIDGE_COMMAND_CHANNEL);
    expect(publishes[0].payload).toEqual({ type: 'ping' });

    client.close();
    await server.stop();
  });

  it('forwards streaming and non-streaming EventBus events on events:all', async () => {
    const eventBus = new EventBus();
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      eventBus,
    });
    const address = await server.start();

    const client = new BusClient({ host: address.host, port: address.port });
    const events: Array<{ channel: string; payload: unknown }> = [];
    client.on('event', (payload, channel) => {
      events.push({ channel, payload });
    });
    await client.connect();

    client.subscribe('events:all');
    await new Promise((resolve) => setTimeout(resolve, 20));

    eventBus.publish({
      type: 'agent_message',
      requestId: 'req-stream',
      sessionKey: 'session-1',
      timestamp: Date.now() / 1000,
      data: { message: 'chunk' },
    } as any);
    eventBus.publish({
      type: 'harness_status',
      requestId: 'req-status',
      sessionKey: 'session-1',
      timestamp: Date.now() / 1000,
      data: { state: 'sending' },
    } as any);

    await waitFor(() => events.length >= 2, 500);

    const streamed = events.find((event) => (event.payload as { type?: string }).type === 'agent_message');
    const status = events.find((event) => (event.payload as { type?: string }).type === 'harness_status');

    expect(streamed).toBeTruthy();
    expect(streamed?.channel).toBe('events:all');
    expect((streamed?.payload as { data?: { message?: string } })?.data?.message).toBe('chunk');

    expect(status).toBeTruthy();
    expect(status?.channel).toBe('events:all');
    expect((status?.payload as { data?: { state?: string } })?.data?.state).toBe('sending');

    client.close();
    await server.stop();
  });
});
