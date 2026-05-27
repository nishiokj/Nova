import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { BusServer } from 'comms-bus';

let server: BusServer | null = null;

async function connect(url: string, token?: string): Promise<WebSocket> {
  const ws = new WebSocket(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('connect timeout')), 2_000);
    ws.once('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe('bus service auth', () => {
  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('rejects unauthenticated websocket upgrades when a service token is configured', async () => {
    server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      onPublish: () => undefined,
    });
    const address = await server.start();
    const url = `ws://${address.host}:${address.port}`;

    await expect(connect(url)).rejects.toThrow();

    const ws = await connect(url, 'secret-token');
    expect(server.getConnectionCount()).toBe(1);
    ws.close();
  });
});
