import { EventEmitter } from 'events';
import { BusServer } from 'comms-bus/bus_server.js';

class MockWebSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  terminated = 0;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  terminate(): void {
    if (this.readyState === 3) return;
    this.terminated++;
    this.readyState = 3;
    this.emit('close');
  }
}

type InternalConnection = {
  id: string;
  subscriptions: Set<string>;
  outboundQueue: Array<{ createdAtMs: number }>;
};

type InternalBusServer = BusServer & {
  handleConnection: (ws: MockWebSocket) => void;
  connections: Map<string, InternalConnection>;
  flushQueue: (connectionId: string) => void;
  send: (connection: InternalConnection, message: unknown, metadata?: unknown) => void;
};

function getLastConnection(server: BusServer): InternalConnection {
  const internal = server as unknown as InternalBusServer;
  const values = [...internal.connections.values()];
  const connection = values[values.length - 1];
  if (!connection) throw new Error('Expected connection');
  return connection;
}

async function tick(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('BusServer backpressure policy', () => {
  it('terminates lagging connection when bufferedAmount exceeds hard limit', async () => {
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      backpressure: { softLimitBytes: 8, hardLimitBytes: 16 },
    });
    const ws = new MockWebSocket();
    ws.bufferedAmount = 17;

    (server as unknown as InternalBusServer).handleConnection(ws);
    const connection = getLastConnection(server);
    connection.subscriptions.add('events:all');

    server.publish('events:all', { type: 'agent_message', sessionKey: 's1', data: { text: 'x' } });
    await tick();

    expect(ws.terminated).toBe(1);
    expect(server.getBackpressureStats().overflowDisconnectCount).toBe(1);
  });

  it('coalesces lossy stream messages under soft pressure and keeps latest payload', async () => {
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      backpressure: { softLimitBytes: 8, hardLimitBytes: 1_000_000 },
    });
    const ws = new MockWebSocket();
    ws.bufferedAmount = 9;

    (server as unknown as InternalBusServer).handleConnection(ws);
    const connection = getLastConnection(server);
    connection.subscriptions.add('events:all');

    server.publish('events:all', { type: 'agent_message', sessionKey: 's1', data: { text: 'one' } });
    server.publish('events:all', { type: 'agent_message', sessionKey: 's1', data: { text: 'two' } });
    server.publish('events:all', { type: 'agent_message', sessionKey: 's1', data: { text: 'three' } });
    await tick();

    ws.bufferedAmount = 0;
    (server as unknown as InternalBusServer).flushQueue(connection.id);
    await tick();

    expect(ws.sent).toHaveLength(1);
    const parsed = JSON.parse(ws.sent[0]) as { payload?: { data?: { text?: string } } };
    expect(parsed.payload?.data?.text).toBe('three');
    expect(server.getBackpressureStats().coalescedLossyCount).toBe(2);
  });

  it('prioritizes queued lossless messages even when lossy head item is throttled', async () => {
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      backpressure: { softLimitBytes: 8, hardLimitBytes: 1_000_000 },
    });
    const ws = new MockWebSocket();
    ws.bufferedAmount = 9;

    (server as unknown as InternalBusServer).handleConnection(ws);
    const connection = getLastConnection(server);
    connection.subscriptions.add('events:all');

    server.publish('events:all', { type: 'agent_message', sessionKey: 's2', data: { text: 'stream' } });
    (server as unknown as InternalBusServer).send(connection, { type: 'error', message: 'critical' });
    await tick();

    const parsed = ws.sent.map((raw) => JSON.parse(raw) as { type?: string; message?: string });
    expect(parsed.some((message) => message.type === 'error' && message.message === 'critical')).toBe(true);
  });

  it('disconnects when queue bounds are exceeded and compaction cannot recover', async () => {
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      backpressure: {
        softLimitBytes: 1_000_000,
        hardLimitBytes: 2_000_000,
        maxQueuedMessages: 2,
      },
    });
    const ws = new MockWebSocket();

    (server as unknown as InternalBusServer).handleConnection(ws);
    const connection = getLastConnection(server);
    connection.subscriptions.add('room:pressure');

    server.publish('room:pressure', { kind: 'a' });
    server.publish('room:pressure', { kind: 'b' });
    server.publish('room:pressure', { kind: 'c' });
    await tick();

    expect(ws.terminated).toBe(1);
    expect(server.getBackpressureStats().overflowDisconnectCount).toBe(1);
  });

  it('drops stale lossy messages by TTL instead of sending them', async () => {
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      backpressure: {
        softLimitBytes: 8,
        hardLimitBytes: 1_000_000,
        lossyTtlMs: 10,
      },
    });
    const ws = new MockWebSocket();
    ws.bufferedAmount = 9;

    (server as unknown as InternalBusServer).handleConnection(ws);
    const connection = getLastConnection(server);
    connection.subscriptions.add('events:all');

    server.publish('events:all', { type: 'agent_message', sessionKey: 's3', data: { text: 'old' } });
    await tick();

    if (connection.outboundQueue[0]) {
      connection.outboundQueue[0].createdAtMs = Date.now() - 5_000;
    }
    ws.bufferedAmount = 0;
    (server as unknown as InternalBusServer).flushQueue(connection.id);
    await tick();

    expect(ws.sent).toHaveLength(0);
    expect(server.getBackpressureStats().droppedLossyCount).toBeGreaterThanOrEqual(1);
  });
});
