import { describe, expect, it } from 'vitest';
import { isRpcRequest, isRpcResponse } from '@nova/client';

describe('rpc_types guards', () => {
  it('validates rpc requests', () => {
    expect(isRpcRequest(null)).toBe(false);
    expect(isRpcRequest('bad')).toBe(false);
    expect(isRpcRequest({ rpc: 2, method: 'status.get', id: 'rpc_1' })).toBe(false);
    expect(isRpcRequest({ rpc: 1, method: '', id: 'rpc_1' })).toBe(false);
    expect(isRpcRequest({ rpc: 1, method: 'status.get', id: '' })).toBe(false);
    expect(isRpcRequest({ rpc: 1, method: 'status.get', id: 'rpc_1', params: {} })).toBe(true);
  });

  it('validates rpc responses', () => {
    expect(isRpcResponse(null)).toBe(false);
    expect(isRpcResponse({ rpc: 2, id: 'rpc_1', result: {} })).toBe(false);
    expect(isRpcResponse({ rpc: 1, id: '', result: {} })).toBe(false);
    expect(isRpcResponse({ rpc: 1, id: 'rpc_1' })).toBe(false);
    expect(isRpcResponse({ rpc: 1, id: 'rpc_1', result: {}, error: { code: 1, message: 'bad' } })).toBe(false);
    expect(isRpcResponse({ rpc: 1, id: 'rpc_1', result: { ok: true } })).toBe(true);
    expect(isRpcResponse({ rpc: 1, id: 'rpc_1', error: 'bad' })).toBe(false);
    expect(isRpcResponse({ rpc: 1, id: 'rpc_1', error: { code: '1', message: 'bad' } })).toBe(false);
    expect(isRpcResponse({ rpc: 1, id: 'rpc_1', error: { code: Infinity, message: 'bad' } })).toBe(false);
    expect(isRpcResponse({ rpc: 1, id: 'rpc_1', error: { code: 403, message: 1 } })).toBe(false);
    expect(isRpcResponse({ rpc: 1, id: 'rpc_1', error: { code: 403, message: 'forbidden' } })).toBe(true);
  });
});
