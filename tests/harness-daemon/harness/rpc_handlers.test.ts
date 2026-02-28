import { describe, it, expect, vi } from 'vitest';
import type { BusServer } from 'comms-bus';
import { RpcDispatcher } from 'harness-daemon/harness/rpc_dispatcher.js';
import { registerRpcHandlers } from 'harness-daemon/harness/rpc_handlers.js';

describe('registerRpcHandlers', () => {
  it('passes rpc method name through and returns payload', async () => {
    const sendTo = vi.fn();
    const bus = { sendTo } as unknown as BusServer;
    const dispatcher = new RpcDispatcher<{ sessionKey: string }>();
    const state = { sessionKey: 'sess_1' };
    const invokeRpcMethod = vi.fn(async () => ({ success: true, list: ['a'] }));

    registerRpcHandlers(dispatcher, { invokeRpcMethod });

    await dispatcher.dispatch(
      'conn_1',
      { rpc: 1, id: 'rpc_1', method: 'skills.list', params: {} },
      state,
      bus,
      () => undefined,
    );

    expect(invokeRpcMethod).toHaveBeenCalledWith(
      'skills.list',
      'conn_1',
      state,
      {},
    );
    expect(sendTo).toHaveBeenCalledWith('conn_1', 'direct', {
      rpc: 1,
      id: 'rpc_1',
      result: { success: true, list: ['a'] },
    });
  });

  it('returns models.list payload unchanged', async () => {
    const sendTo = vi.fn();
    const bus = { sendTo } as unknown as BusServer;
    const dispatcher = new RpcDispatcher<Record<string, unknown>>();
    const invokeRpcMethod = vi.fn(async () => ({
      success: true,
      models: [{ id: 'm1', name: 'Model 1' }],
      available: [{ id: 'm2', name: 'Model 2' }],
      default: 'm1',
    }));
    registerRpcHandlers(dispatcher, { invokeRpcMethod });

    await dispatcher.dispatch(
      'conn_2',
      { rpc: 1, id: 'rpc_2', method: 'models.list', params: {} },
      {},
      bus,
      () => undefined,
    );

    expect(sendTo).toHaveBeenCalledWith('conn_2', 'direct', {
      rpc: 1,
      id: 'rpc_2',
      result: {
        success: true,
        models: [{ id: 'm1', name: 'Model 1' }],
        available: [{ id: 'm2', name: 'Model 2' }],
        default: 'm1',
      },
    });
  });

  it('returns status.get payload unchanged', async () => {
    const sendTo = vi.fn();
    const bus = { sendTo } as unknown as BusServer;
    const dispatcher = new RpcDispatcher<Record<string, unknown>>();
    const invokeRpcMethod = vi.fn(async () => ({ state: 'idle', message: 'ok' }));
    registerRpcHandlers(dispatcher, { invokeRpcMethod });

    await dispatcher.dispatch(
      'conn_3',
      { rpc: 1, id: 'rpc_3', method: 'status.get', params: {} },
      {},
      bus,
      () => undefined,
    );

    expect(sendTo).toHaveBeenCalledWith('conn_3', 'direct', {
      rpc: 1,
      id: 'rpc_3',
      result: { state: 'idle', message: 'ok' },
    });
  });

  it('passes an empty object when RPC params are not records', async () => {
    const sendTo = vi.fn();
    const bus = { sendTo } as unknown as BusServer;
    const dispatcher = new RpcDispatcher<Record<string, unknown>>();
    const invokeRpcMethod = vi.fn(async () => ({ success: true }));
    registerRpcHandlers(dispatcher, { invokeRpcMethod });

    await dispatcher.dispatch(
      'conn_4',
      { rpc: 1, id: 'rpc_4', method: 'skills.get', params: 'bad-params' },
      {},
      bus,
      () => undefined,
    );

    expect(invokeRpcMethod).toHaveBeenCalledWith(
      'skills.get',
      'conn_4',
      {},
      {},
    );
  });
});
