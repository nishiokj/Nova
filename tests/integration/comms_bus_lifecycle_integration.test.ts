import { EventBus } from 'comms-bus';
import { BusClient } from 'comms-bus/bus_client.js';
import { BusServer } from 'comms-bus/bus_server.js';
import type { EventEmitter } from 'events';

type AnyEvent = {
  type: string;
  requestId?: string;
  runId?: string;
  sessionKey?: string;
  timestamp?: number;
  data?: unknown;
};

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
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

function getRunHandlerCount(eventBus: EventBus): number {
  return ((eventBus as unknown as { runHandlers: Map<string, Set<unknown>> }).runHandlers).size;
}

function getListenerCount(eventBus: EventBus, channel: string): number {
  const emitter = (eventBus as unknown as { emitter: EventEmitter }).emitter;
  return emitter.listenerCount(channel);
}

describe('comms-bus lifecycle integration', () => {
  it('removes run handler from real EventBus after last run subscriber disconnects', async () => {
    const eventBus = new EventBus();
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      eventBus,
    });
    const address = await server.start();

    const client = new BusClient({ host: address.host, port: address.port });
    await client.connect();
    client.subscribe('run:integration-run');

    await waitFor(() => getRunHandlerCount(eventBus) === 1);
    client.close();

    await waitFor(() => server.getConnectionCount() === 0);
    await waitFor(() => getRunHandlerCount(eventBus) === 0);
    await server.stop();
  });

  it('keeps real EventBus run handler while one of two subscribers remains', async () => {
    const eventBus = new EventBus();
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      eventBus,
    });
    const address = await server.start();

    const a = new BusClient({ host: address.host, port: address.port });
    const b = new BusClient({ host: address.host, port: address.port });
    const receivedByB: AnyEvent[] = [];
    b.on('event', (payload) => {
      receivedByB.push(payload as AnyEvent);
    });

    await a.connect();
    await b.connect();
    a.subscribe('run:shared-integration');
    b.subscribe('run:shared-integration');

    await waitFor(() => getRunHandlerCount(eventBus) === 1);
    a.close();
    await waitFor(() => server.getConnectionCount() === 1);
    expect(getRunHandlerCount(eventBus)).toBe(1);

    eventBus.publish({
      type: 'harness_status',
      requestId: 'shared-integration',
      runId: 'shared-integration',
      sessionKey: 'sess-1',
      timestamp: Date.now() / 1000,
      data: { state: 'still-routed' },
    } as any);

    await waitFor(() => receivedByB.length >= 1);
    b.close();

    await waitFor(() => server.getConnectionCount() === 0);
    await waitFor(() => getRunHandlerCount(eventBus) === 0);
    await server.stop();
  });

  it('does not leak events:all listeners on repeated subscribe/disconnect churn', async () => {
    const eventBus = new EventBus();
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      eventBus,
    });
    const address = await server.start();

    const cycles = 15;
    for (let i = 0; i < cycles; i++) {
      const client = new BusClient({ host: address.host, port: address.port });
      await client.connect();
      client.subscribe('events:all');

      await waitFor(() => getListenerCount(eventBus, '__all__') === 1);
      await waitFor(() => getListenerCount(eventBus, 'agent_message') === 1);
      await waitFor(() => getListenerCount(eventBus, 'agent_reasoning') === 1);

      client.close();
      await waitFor(() => server.getConnectionCount() === 0);
      await waitFor(() => getListenerCount(eventBus, '__all__') === 0);
      await waitFor(() => getListenerCount(eventBus, 'agent_message') === 0);
      await waitFor(() => getListenerCount(eventBus, 'agent_reasoning') === 0);
    }

    await server.stop();
  });

  it('cleans all EventBus listeners and run handlers on stop with active subscribers', async () => {
    const eventBus = new EventBus();
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      eventBus,
    });
    const address = await server.start();

    const client = new BusClient({ host: address.host, port: address.port });
    await client.connect();
    client.subscribe('run:stop-cleanup');
    client.subscribe('events:all');

    await waitFor(() => getRunHandlerCount(eventBus) === 1);
    await waitFor(() => getListenerCount(eventBus, '__all__') === 1);
    await waitFor(() => getListenerCount(eventBus, 'agent_message') === 1);
    await waitFor(() => getListenerCount(eventBus, 'agent_reasoning') === 1);

    await server.stop();

    expect(getRunHandlerCount(eventBus)).toBe(0);
    expect(getListenerCount(eventBus, '__all__')).toBe(0);
    expect(getListenerCount(eventBus, 'agent_message')).toBe(0);
    expect(getListenerCount(eventBus, 'agent_reasoning')).toBe(0);
    client.close();
  });
});
