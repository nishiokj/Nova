import { BusClient, BusServer } from 'comms-bus';

type BusEvent = { type?: string; runId?: string; requestId?: string };

class CountingEventBus {
  runSubscribeCalls = 0;
  runUnsubscribeCalls = 0;
  allSubscribeCalls = 0;
  allUnsubscribeCalls = 0;
  streamSubscribeCalls = 0;
  streamUnsubscribeCalls = 0;

  private readonly runHandlers = new Map<string, Set<(event: BusEvent) => void>>();
  private readonly allHandlers = new Set<(event: BusEvent) => void>();
  private readonly typedHandlers = new Map<string, Set<(event: BusEvent) => void>>();

  publish(event: BusEvent): void {
    const typed = this.typedHandlers.get(String(event.type ?? ''));
    if (typed) {
      for (const handler of typed) handler(event);
    }

    for (const handler of this.allHandlers) handler(event);

    const runId = event.runId ?? event.requestId;
    if (!runId) return;
    const runSet = this.runHandlers.get(runId);
    if (!runSet) return;
    for (const handler of runSet) handler(event);
  }

  subscribe(type: string, handler: (event: BusEvent) => void): () => void {
    if (!this.typedHandlers.has(type)) {
      this.typedHandlers.set(type, new Set());
    }
    this.typedHandlers.get(type)!.add(handler);
    if (type === 'agent_message' || type === 'agent_reasoning') {
      this.streamSubscribeCalls++;
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.typedHandlers.get(type)?.delete(handler);
      if (this.typedHandlers.get(type)?.size === 0) {
        this.typedHandlers.delete(type);
      }
      if (type === 'agent_message' || type === 'agent_reasoning') {
        this.streamUnsubscribeCalls++;
      }
    };
  }

  subscribeAll(handler: (event: BusEvent) => void): () => void {
    this.allSubscribeCalls++;
    this.allHandlers.add(handler);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.allHandlers.delete(handler);
      this.allUnsubscribeCalls++;
    };
  }

  subscribeRun(runId: string, handler: (event: BusEvent) => void): () => void {
    this.runSubscribeCalls++;
    if (!this.runHandlers.has(runId)) {
      this.runHandlers.set(runId, new Set());
    }
    this.runHandlers.get(runId)!.add(handler);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.runHandlers.get(runId)?.delete(handler);
      if (this.runHandlers.get(runId)?.size === 0) {
        this.runHandlers.delete(runId);
      }
      this.runUnsubscribeCalls++;
    };
  }

  shutdown(): void {
    this.runHandlers.clear();
    this.allHandlers.clear();
    this.typedHandlers.clear();
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 600): Promise<void> {
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

describe('BusServer resource cleanup', () => {
  it('unsubscribes run listeners when last run subscriber disconnects', async () => {
    const eventBus = new CountingEventBus();
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      eventBus: eventBus as any,
    });
    const address = await server.start();

    const client = new BusClient({ host: address.host, port: address.port });
    await client.connect();
    client.subscribe('run:leak-test');

    await waitFor(() => eventBus.runSubscribeCalls === 1);
    client.close();

    await waitFor(() => server.getConnectionCount() === 0);
    await waitFor(() => eventBus.runUnsubscribeCalls === 1);

    await server.stop();
  });

  it('keeps run subscription alive until final subscriber disconnects', async () => {
    const eventBus = new CountingEventBus();
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      eventBus: eventBus as any,
    });
    const address = await server.start();

    const clientA = new BusClient({ host: address.host, port: address.port });
    const clientB = new BusClient({ host: address.host, port: address.port });
    await clientA.connect();
    await clientB.connect();

    clientA.subscribe('run:shared');
    clientB.subscribe('run:shared');
    await waitFor(() => eventBus.runSubscribeCalls === 1);

    clientA.close();
    await waitFor(() => server.getConnectionCount() === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(eventBus.runUnsubscribeCalls).toBe(0);

    clientB.close();
    await waitFor(() => server.getConnectionCount() === 0);
    await waitFor(() => eventBus.runUnsubscribeCalls === 1);

    await server.stop();
  });

  it('unsubscribes global and stream listeners when last events:all subscriber disconnects', async () => {
    const eventBus = new CountingEventBus();
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      eventBus: eventBus as any,
    });
    const address = await server.start();

    const client = new BusClient({ host: address.host, port: address.port });
    await client.connect();
    client.subscribe('events:all');

    await waitFor(() => eventBus.allSubscribeCalls === 1);
    await waitFor(() => eventBus.streamSubscribeCalls === 2);

    client.close();
    await waitFor(() => server.getConnectionCount() === 0);
    await waitFor(() => eventBus.allUnsubscribeCalls === 1);
    await waitFor(() => eventBus.streamUnsubscribeCalls === 2);

    await server.stop();
  });

  it('cleans EventBus subscriptions during server.stop with active clients', async () => {
    const eventBus = new CountingEventBus();
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      eventBus: eventBus as any,
    });
    const address = await server.start();

    const client = new BusClient({ host: address.host, port: address.port });
    await client.connect();
    client.subscribe('run:shutdown');
    client.subscribe('events:all');

    await waitFor(() => eventBus.runSubscribeCalls === 1);
    await waitFor(() => eventBus.allSubscribeCalls === 1);
    await waitFor(() => eventBus.streamSubscribeCalls === 2);

    await server.stop();
    await waitFor(() => eventBus.runUnsubscribeCalls === 1);
    await waitFor(() => eventBus.allUnsubscribeCalls === 1);
    await waitFor(() => eventBus.streamUnsubscribeCalls === 2);

    client.close();
  });

  it('does not accumulate EventBus subscriptions across repeated connect/close churn', async () => {
    const eventBus = new CountingEventBus();
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      eventBus: eventBus as any,
    });
    const address = await server.start();

    const cycles = 20;
    for (let i = 0; i < cycles; i++) {
      const client = new BusClient({ host: address.host, port: address.port });
      await client.connect();
      client.subscribe(`run:churn-${i}`);
      client.subscribe('events:all');
      await waitFor(() => eventBus.runSubscribeCalls === i + 1);
      await waitFor(() => eventBus.allSubscribeCalls === i + 1);
      client.close();
      await waitFor(() => server.getConnectionCount() === 0);
      await waitFor(() => eventBus.runUnsubscribeCalls === i + 1);
      await waitFor(() => eventBus.allUnsubscribeCalls === i + 1);
    }

    expect(eventBus.runSubscribeCalls).toBe(cycles);
    expect(eventBus.runUnsubscribeCalls).toBe(cycles);
    expect(eventBus.allSubscribeCalls).toBe(cycles);
    expect(eventBus.allUnsubscribeCalls).toBe(cycles);
    expect(eventBus.streamSubscribeCalls).toBe(cycles * 2);
    expect(eventBus.streamUnsubscribeCalls).toBe(cycles * 2);

    await server.stop();
  });
});
