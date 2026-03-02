import { BusClient } from 'comms-bus/bus_client.js';
import { BusServer } from 'comms-bus/bus_server.js';
import { vi } from 'vitest';

type ClientError = { message: string; detail?: unknown };

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

describe('BusClient mutation guards', () => {
  it('emits bus_not_connected when publishing before connect', async () => {
    const client = new BusClient({ host: '127.0.0.1', port: 65534 });
    const errors: ClientError[] = [];
    client.on('error', (err) => errors.push(err as ClientError));

    client.publish('room:test', { ok: true });
    await waitFor(() => errors.length === 1);
    expect(errors[0].message).toBe('bus_not_connected');
  });

  it('keeps subscribe/unsubscribe idempotent via local subscription set', () => {
    const client = new BusClient({ host: '127.0.0.1', port: 65534 });
    client.on('error', () => undefined);
    const sendSpy = vi.spyOn(client as unknown as { send: (...args: unknown[]) => void }, 'send');

    client.subscribe('room:dup');
    client.subscribe('room:dup');
    client.unsubscribe('room:dup');
    client.unsubscribe('room:dup');

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ type: 'subscribe', channel: 'room:dup' });
    expect(sendSpy.mock.calls[1][0]).toMatchObject({ type: 'unsubscribe', channel: 'room:dup' });
  });

  it('emits bus_not_connected after close when publish is attempted', async () => {
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: () => undefined,
    });
    const address = await server.start();
    const client = new BusClient({ host: address.host, port: address.port });
    const errors: ClientError[] = [];
    client.on('error', (err) => errors.push(err as ClientError));

    await client.connect();
    client.close();
    client.publish('room:after-close', { ok: false });

    await waitFor(() => errors.some((err) => err.message === 'bus_not_connected'));
    await server.stop();
  });

  it('emits invalid_json for malformed message payload', async () => {
    const client = new BusClient({ host: '127.0.0.1', port: 65534 });
    const errors: ClientError[] = [];
    client.on('error', (err) => errors.push(err as ClientError));

    (client as unknown as { handleMessage: (data: string) => void }).handleMessage('{');
    await waitFor(() => errors.length === 1);
    expect(errors[0].message).toBe('invalid_json');
  });

  it('emits unexpected_message when receiving client-side message type', async () => {
    const client = new BusClient({ host: '127.0.0.1', port: 65534 });
    const errors: ClientError[] = [];
    client.on('error', (err) => errors.push(err as ClientError));

    (client as unknown as { handleMessage: (data: string) => void }).handleMessage(
      JSON.stringify({ type: 'subscribe', channel: 'room:invalid' })
    );
    await waitFor(() => errors.length === 1);
    expect(errors[0].message).toBe('unexpected_message');
  });
});
