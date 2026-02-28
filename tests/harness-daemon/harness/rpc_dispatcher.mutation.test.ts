import { describe, expect, it, vi } from 'vitest';
import type { BusServer } from 'comms-bus';
import { RpcDispatcher } from 'harness-daemon/harness/rpc_dispatcher.js';

describe('RpcDispatcher mutation guards', () => {
  it('passes emit callback through context for handler side effects', async () => {
    const sendTo = vi.fn();
    const emit = vi.fn();
    const bus = { sendTo } as unknown as BusServer;
    const dispatcher = new RpcDispatcher<Record<string, unknown>>();

    dispatcher.register('test.emit', (_params, ctx) => {
      ctx.emit({ type: 'status', data: { state: 'idle' } }, 'session:test');
      return { success: true };
    });

    await dispatcher.dispatch(
      'conn_emit',
      { rpc: 1, id: 'rpc_emit', method: 'test.emit', params: {} },
      {},
      bus,
      emit,
    );

    expect(emit).toHaveBeenCalledWith({ type: 'status', data: { state: 'idle' } }, 'session:test');
    expect(sendTo).toHaveBeenCalledWith('conn_emit', 'direct', {
      rpc: 1,
      id: 'rpc_emit',
      result: { success: true },
    });
  });

  it('returns success envelope with original rpc id', async () => {
    const sendTo = vi.fn();
    const bus = { sendTo } as unknown as BusServer;
    const dispatcher = new RpcDispatcher<Record<string, unknown>>();

    dispatcher.register('test.id', () => ({ ok: true }));

    await dispatcher.dispatch(
      'conn_id',
      { rpc: 1, id: 'rpc_original', method: 'test.id', params: {} },
      {},
      bus,
      () => undefined,
    );

    expect(sendTo).toHaveBeenCalledWith('conn_id', 'direct', {
      rpc: 1,
      id: 'rpc_original',
      result: { ok: true },
    });
  });

  it('maps generic thrown values to deterministic 500 rpc errors', async () => {
    const sendTo = vi.fn();
    const bus = { sendTo } as unknown as BusServer;
    const dispatcher = new RpcDispatcher<Record<string, unknown>>();

    dispatcher.register('test.throw', () => {
      throw 'boom';
    });

    await dispatcher.dispatch(
      'conn_throw',
      { rpc: 1, id: 'rpc_throw', method: 'test.throw', params: {} },
      {},
      bus,
      () => undefined,
    );

    expect(sendTo).toHaveBeenCalledWith('conn_throw', 'direct', {
      rpc: 1,
      id: 'rpc_throw',
      error: {
        code: 500,
        message: 'boom',
      },
    });
  });

  it('returns only unknown-method error envelope when method is missing', async () => {
    const sendTo = vi.fn();
    const bus = { sendTo } as unknown as BusServer;
    const dispatcher = new RpcDispatcher<Record<string, unknown>>();

    await dispatcher.dispatch(
      'conn_missing',
      { rpc: 1, id: 'rpc_missing', method: 'not.registered', params: {} },
      {},
      bus,
      () => undefined,
    );

    expect(sendTo).toHaveBeenCalledTimes(1);
    expect(sendTo).toHaveBeenCalledWith('conn_missing', 'direct', {
      rpc: 1,
      id: 'rpc_missing',
      error: {
        code: 404,
        message: 'Unknown RPC method: not.registered',
      },
    });
  });
});
