import { BusClient, BusServer } from 'comms-bus';

class SpyEventBus {
  runSubscribes = 0;
  runUnsubscribes = 0;
  allSubscribes = 0;
  allUnsubscribes = 0;
  streamSubscribes = 0;
  streamUnsubscribes = 0;

  subscribe(_type: string): () => void {
    this.streamSubscribes++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.streamUnsubscribes++;
    };
  }

  subscribeAll(): () => void {
    this.allSubscribes++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.allUnsubscribes++;
    };
  }

  subscribeRun(): () => void {
    this.runSubscribes++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.runUnsubscribes++;
    };
  }

  publish(): void {
    return;
  }

  shutdown(): void {
    return;
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

describe('BusServer mutation guards', () => {
  it('cleans run subscription on close only after final subscriber disconnects', async () => {
    const eventBus = new SpyEventBus();
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      eventBus: eventBus as any,
    });
    const address = await server.start();

    const a = new BusClient({ host: address.host, port: address.port });
    const b = new BusClient({ host: address.host, port: address.port });
    await a.connect();
    await b.connect();

    a.subscribe('run:mutant');
    b.subscribe('run:mutant');
    await waitFor(() => eventBus.runSubscribes === 1);

    a.close();
    await waitFor(() => server.getConnectionCount() === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(eventBus.runUnsubscribes).toBe(0);

    b.close();
    await waitFor(() => eventBus.runUnsubscribes === 1);
    await server.stop();
  });

  it('removes events:all global and stream subscriptions exactly once on disconnect', async () => {
    const eventBus = new SpyEventBus();
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

    await waitFor(() => eventBus.allSubscribes === 1);
    await waitFor(() => eventBus.streamSubscribes === 2);

    client.close();
    await waitFor(() => eventBus.allUnsubscribes === 1);
    await waitFor(() => eventBus.streamUnsubscribes === 2);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(eventBus.allUnsubscribes).toBe(1);
    expect(eventBus.streamUnsubscribes).toBe(2);
    await server.stop();
  });
});
