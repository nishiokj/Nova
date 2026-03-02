import { BusServer } from 'comms-bus/bus_server.js';
import WebSocket from 'ws';

type ServerWireMessage =
  | { type: 'event'; channel: string; payload: unknown }
  | { type: 'error'; message: string; detail?: unknown };

function waitFor(predicate: () => boolean, timeoutMs = 800): Promise<void> {
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

async function openWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

function collect(ws: WebSocket, sink: ServerWireMessage[]): void {
  ws.on('message', (data) => {
    sink.push(JSON.parse(String(data)) as ServerWireMessage);
  });
}

describe('BusServer protocol mutation guards', () => {
  it('returns invalid_json error for malformed wire payload', async () => {
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
    });
    const address = await server.start();
    const ws = await openWs(`ws://${address.host}:${address.port}`);
    const received: ServerWireMessage[] = [];
    collect(ws, received);

    ws.send('{');
    await waitFor(() => received.length === 1);
    expect(received[0]).toMatchObject({ type: 'error', message: 'invalid_json' });

    ws.close();
    await server.stop();
  });

  it('returns unsupported_message for unknown message type', async () => {
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
    });
    const address = await server.start();
    const ws = await openWs(`ws://${address.host}:${address.port}`);
    const received: ServerWireMessage[] = [];
    collect(ws, received);

    ws.send(JSON.stringify({ type: 'bogus', channel: 'x' }));
    await waitFor(() => received.length === 1);
    expect(received[0]).toMatchObject({ type: 'error', message: 'unsupported_message' });

    ws.close();
    await server.stop();
  });

  it('maps async publish rejection to publish_failed error', async () => {
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: async () => {
        throw new Error('async publish failed');
      },
    });
    const address = await server.start();
    const ws = await openWs(`ws://${address.host}:${address.port}`);
    const received: ServerWireMessage[] = [];
    collect(ws, received);

    ws.send(JSON.stringify({ type: 'publish', channel: 'x', payload: { ok: false } }));
    await waitFor(() => received.length === 1);
    expect(received[0]).toMatchObject({ type: 'error', message: 'publish_failed' });
    expect(String((received[0] as { detail?: unknown }).detail ?? '')).toContain('async publish failed');

    ws.close();
    await server.stop();
  });

  it('maps sync publish throw to publish_failed error', async () => {
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => {
        throw new Error('sync publish failed');
      },
    });
    const address = await server.start();
    const ws = await openWs(`ws://${address.host}:${address.port}`);
    const received: ServerWireMessage[] = [];
    collect(ws, received);

    ws.send(JSON.stringify({ type: 'publish', channel: 'x', payload: { ok: false } }));
    await waitFor(() => received.length === 1);
    expect(received[0]).toMatchObject({ type: 'error', message: 'publish_failed' });
    expect(String((received[0] as { detail?: unknown }).detail ?? '')).toContain('sync publish failed');

    ws.close();
    await server.stop();
  });
});
