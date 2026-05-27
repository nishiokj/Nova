import { describe, it, expect } from 'vitest';
import { RpcClient } from '@nova/client';
import type { RpcRequest } from '@nova/client';

describe('RpcClient', () => {
  it('correlates concurrent calls by rpc id', async () => {
    const sent: RpcRequest[] = [];
    const client = new RpcClient((request) => {
      sent.push(request);
      return true;
    }, 500);

    const first = client.call('skills.get', { id: 'a' });
    const second = client.call('skills.get', { id: 'b' });

    expect(sent).toHaveLength(2);
    expect(sent[0]?.id).not.toBe(sent[1]?.id);

    client.handleResponse({ rpc: 1, id: sent[1]!.id, result: { success: true, id: 'b' } });
    client.handleResponse({ rpc: 1, id: sent[0]!.id, result: { success: true, id: 'a' } });

    await expect(first).resolves.toEqual({ success: true, id: 'a' });
    await expect(second).resolves.toEqual({ success: true, id: 'b' });
  });

  it('rejects timed out calls', async () => {
    const client = new RpcClient(() => true, 5);
    const pending = client.call('auth.start', {});
    await expect(pending).rejects.toThrow('RPC timeout');
  });

  it('rejects all pending calls on disconnect', async () => {
    const client = new RpcClient(() => true, 1000);
    const pending = client.call('providers.list', {});
    client.rejectAll(new Error('Connection lost'));
    await expect(pending).rejects.toThrow('Connection lost');
  });

  it('ignores non-rpc payloads in handleResponse', () => {
    const client = new RpcClient(() => true, 1000);
    expect(client.handleResponse({ type: 'status' })).toBe(false);
  });
});
