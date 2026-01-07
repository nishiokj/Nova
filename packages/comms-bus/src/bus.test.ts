/**
 * Tests for JSONL bus server/client.
 */

import { describe, it, expect } from 'bun:test';
import { BusServer } from './bus_server.js';
import { BusClient } from './bus_client.js';
import { BRIDGE_COMMAND_CHANNEL } from './bus_channels.js';

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
});
