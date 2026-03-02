import { BusClient, BusServer } from 'comms-bus';

type WireEvent = {
  type?: string;
  sessionKey?: string;
  data?: { text?: string };
};

function waitFor(predicate: () => boolean, timeoutMs = 1200): Promise<void> {
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

function forceBufferedAmount(target: object, getValue: () => number): void {
  Object.defineProperty(target, 'bufferedAmount', {
    configurable: true,
    get: getValue,
  });
}

describe('comms-bus backpressure integration', () => {
  it('delivers lossless control events while stream events are throttled', async () => {
    let connectionId: string | null = null;
    let syntheticBuffer = 9;
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      onConnect: (id) => {
        connectionId = id;
      },
      backpressure: { softLimitBytes: 8, hardLimitBytes: 1_000_000 },
    });
    const address = await server.start();

    const client = new BusClient({ host: address.host, port: address.port });
    const received: Array<{ channel: string; payload: WireEvent }> = [];
    client.on('event', (payload, channel) => {
      received.push({ channel, payload: payload as WireEvent });
    });
    await client.connect();
    client.subscribe('events:all');
    client.subscribe('direct');

    await waitFor(() => connectionId !== null);
    const internalConnection = (server as unknown as {
      connections: Map<string, { ws: object }>;
    }).connections.get(connectionId!);
    if (!internalConnection) throw new Error('missing server connection');
    forceBufferedAmount(internalConnection.ws, () => syntheticBuffer);
    await waitFor(
      () =>
        (server as unknown as { connections: Map<string, { subscriptions: Set<string> }> })
          .connections
          .get(connectionId!)
          ?.subscriptions.has('events:all') === true
    );
    await waitFor(
      () =>
        (server as unknown as { connections: Map<string, { subscriptions: Set<string> }> })
          .connections
          .get(connectionId!)
          ?.subscriptions.has('direct') === true
    );

    server.publish('events:all', { type: 'agent_message', sessionKey: 's-low', data: { text: 'one' } });
    server.publish('events:all', { type: 'agent_message', sessionKey: 's-low', data: { text: 'two' } });
    server.sendTo(connectionId!, 'direct', { type: 'control', data: { text: 'critical' } });

    await waitFor(() => received.some((event) => event.channel === 'direct'));
    const directPayload = received.find((event) => event.channel === 'direct')?.payload;
    expect(directPayload?.type).toBe('control');

    syntheticBuffer = 0;
    await waitFor(
      () =>
        received.some(
          (event) =>
            event.channel === 'events:all' &&
            event.payload.type === 'agent_message' &&
            event.payload.data?.text === 'two'
        )
    );

    client.close();
    await server.stop();
  });

  it('isolates lagging-client overflow disconnect from healthy subscribers', async () => {
    const connected: string[] = [];
    const disconnected: string[] = [];
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
      onConnect: (id) => connected.push(id),
      onDisconnect: (id) => disconnected.push(id),
      backpressure: { softLimitBytes: 8, hardLimitBytes: 16 },
    });
    const address = await server.start();

    const laggingClient = new BusClient({ host: address.host, port: address.port });
    const healthyClient = new BusClient({ host: address.host, port: address.port });
    const healthyEvents: Array<{ channel: string; payload: WireEvent }> = [];

    healthyClient.on('event', (payload, channel) => {
      healthyEvents.push({ channel, payload: payload as WireEvent });
    });

    await laggingClient.connect();
    await healthyClient.connect();
    laggingClient.subscribe('events:all');
    healthyClient.subscribe('events:all');

    await waitFor(() => connected.length === 2);
    const internal = (server as unknown as {
      connections: Map<string, { ws: object }>;
    }).connections;
    const laggingId = connected[0];
    const laggingConnection = internal.get(laggingId);
    if (!laggingConnection) throw new Error('missing lagging connection');
    forceBufferedAmount(laggingConnection.ws, () => 17);
    await waitFor(() =>
      [...internal.values()].every((connection) => (connection as { subscriptions: Set<string> })
        .subscriptions.has('events:all'))
    );

    server.publish('events:all', { type: 'agent_message', sessionKey: 's-fair', data: { text: 'alive' } });

    await waitFor(() => disconnected.includes(laggingId));
    await waitFor(
      () =>
        healthyEvents.some(
          (event) =>
            event.channel === 'events:all' &&
            event.payload.type === 'agent_message' &&
            event.payload.data?.text === 'alive'
        )
    );

    expect(server.getConnectionCount()).toBe(1);
    healthyClient.close();
    laggingClient.close();
    await server.stop();
  });
});
