import { describe, expect, it, vi } from 'vitest';
import { RpcCallError, RpcClient } from '@nova/client';
import type { RpcRequest } from '@nova/client';

function pendingSize(client: RpcClient): number {
  return ((client as unknown as { pending: Map<string, unknown> }).pending).size;
}

describe('RpcClient mutation guards', () => {
  it('does not resolve calls on mismatched response ids', async () => {
    const sent: RpcRequest[] = [];
    const client = new RpcClient((request) => {
      sent.push(request);
      return true;
    }, 1_000);

    const call = client.call('auth.start', {});
    const requestId = sent[0]?.id;
    if (!requestId) {
      throw new Error('Expected request id');
    }

    client.handleResponse({ rpc: 1, id: 'rpc_other', result: { success: true } });
    expect(pendingSize(client)).toBe(1);

    client.handleResponse({ rpc: 1, id: requestId, result: { success: true } });
    await expect(call).resolves.toEqual({ success: true });
    expect(pendingSize(client)).toBe(0);
  });

  it('enforces timeout cleanup exactly at configured boundary', async () => {
    vi.useFakeTimers();
    const client = new RpcClient(() => true, 50);

    const call = client.call('auth.start', {});
    const callResult = call.then(
      () => ({ ok: true as const, error: null }),
      (error) => ({ ok: false as const, error: error as Error }),
    );
    expect(pendingSize(client)).toBe(1);

    await vi.advanceTimersByTimeAsync(49);
    expect(pendingSize(client)).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    const settled = await callResult;
    expect(settled.ok).toBe(false);
    expect(settled.error?.message).toContain('RPC timeout for method auth.start');
    expect(pendingSize(client)).toBe(0);
    vi.useRealTimers();
  });

  it('cleans pending state immediately when send fails', async () => {
    const client = new RpcClient(() => false, 1_000);
    const call = client.call('providers.list', {});
    await expect(call).rejects.toThrow('Not connected to bridge');
    expect(pendingSize(client)).toBe(0);
  });

  it('rejects all pending requests and clears map on disconnect', async () => {
    vi.useFakeTimers();
    const client = new RpcClient(() => true, 1_000);
    const call = client.call('providers.list', {});

    client.rejectAll(new Error('Connection lost'));
    await expect(call).rejects.toThrow('Connection lost');
    expect(pendingSize(client)).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(pendingSize(client)).toBe(0);
    vi.useRealTimers();
  });

  it('maps rpc error envelopes to RpcCallError with stable code/message', async () => {
    const sent: RpcRequest[] = [];
    const client = new RpcClient((request) => {
      sent.push(request);
      return true;
    }, 1_000);

    const call = client.call('providers.list', {});
    const requestId = sent[0]?.id;
    if (!requestId) {
      throw new Error('Expected request id');
    }

    client.handleResponse({
      rpc: 1,
      id: requestId,
      error: { code: 403, message: 'forbidden' },
    });

    await expect(call).rejects.toBeInstanceOf(RpcCallError);
    await call.catch((error) => {
      expect((error as RpcCallError).code).toBe(403);
      expect((error as RpcCallError).message).toBe('forbidden');
    });
  });
});
