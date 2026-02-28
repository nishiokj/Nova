import { describe, expect, it } from 'vitest';
import { BridgeClient } from 'tui/bridge_client.ts';

describe('BridgeClient RPC cutover surface', () => {
  it('exposes rpc client directly', () => {
    const client = new BridgeClient({ host: '127.0.0.1', port: 7777 });
    const internal = (client as unknown as { client: { rpc: unknown } }).client;
    expect(client.rpc).toBe(internal.rpc);
    client.close();
  });

  it('rejects malformed bridge events before forwarding to consumers', () => {
    const client = new BridgeClient({ host: '127.0.0.1', port: 7778 });
    const internal = (client as unknown as { client: { emit: (event: string, payload: unknown) => void } }).client;

    const errors: Array<{ message?: string }> = [];
    const events: Array<{ type: string }> = [];
    client.on('error', (payload) => errors.push(payload as { message?: string }));
    client.on('event', (event) => events.push(event as { type: string }));

    internal.emit('event', { type: 'not-a-real-event', data: {} });

    expect(errors.length).toBe(1);
    expect(String(errors[0]?.message ?? '')).toContain('Malformed event from bridge');
    expect(events.length).toBe(0);
    client.close();
  });

  it('does not expose legacy unary delegation methods', () => {
    const client = new BridgeClient({ host: '127.0.0.1', port: 7779 }) as Record<string, unknown>;
    expect(client.authStart).toBeUndefined();
    expect(client.providersSave).toBeUndefined();
    expect(client.sessionFork).toBeUndefined();
    expect(client.usageSummary).toBeUndefined();
    (client as unknown as { close: () => void }).close();
  });
});
