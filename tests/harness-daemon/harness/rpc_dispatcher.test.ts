import { describe, it, expect, vi } from 'vitest';
import type { BusServer } from 'comms-bus';
import { RpcDispatcher, RpcHandlerError } from 'harness-daemon/harness/rpc_dispatcher.js';

describe('RpcDispatcher', () => {
  it('returns unknown-method error envelope', async () => {
    const sendTo = vi.fn();
    const bus = { sendTo } as unknown as BusServer;
    const dispatcher = new RpcDispatcher<Record<string, unknown>>();

    await dispatcher.dispatch(
      'conn_1',
      { rpc: 1, id: 'rpc_1', method: 'missing.method', params: {} },
      {},
      bus,
      () => undefined,
    );

    expect(sendTo).toHaveBeenCalledWith('conn_1', 'direct', {
      rpc: 1,
      id: 'rpc_1',
      error: {
        code: 404,
        message: 'Unknown RPC method: missing.method',
      },
    });
  });

  it('returns successful rpc envelope', async () => {
    const sendTo = vi.fn();
    const bus = { sendTo } as unknown as BusServer;
    const dispatcher = new RpcDispatcher<{ value: number }>();

    dispatcher.register('test.echo', async (params, ctx) => {
      return {
        params,
        value: ctx.state.value,
      };
    });

    await dispatcher.dispatch(
      'conn_2',
      { rpc: 1, id: 'rpc_2', method: 'test.echo', params: { hello: 'world' } },
      { value: 42 },
      bus,
      () => undefined,
    );

    expect(sendTo).toHaveBeenCalledWith('conn_2', 'direct', {
      rpc: 1,
      id: 'rpc_2',
      result: {
        params: { hello: 'world' },
        value: 42,
      },
    });
  });

  it('maps RpcHandlerError to rpc error envelope', async () => {
    const sendTo = vi.fn();
    const bus = { sendTo } as unknown as BusServer;
    const dispatcher = new RpcDispatcher<Record<string, unknown>>();

    dispatcher.register('test.fail', () => {
      throw new RpcHandlerError(422, 'validation failed');
    });

    await dispatcher.dispatch(
      'conn_3',
      { rpc: 1, id: 'rpc_3', method: 'test.fail', params: {} },
      {},
      bus,
      () => undefined,
    );

    expect(sendTo).toHaveBeenCalledWith('conn_3', 'direct', {
      rpc: 1,
      id: 'rpc_3',
      error: {
        code: 422,
        message: 'validation failed',
      },
    });
  });
});
