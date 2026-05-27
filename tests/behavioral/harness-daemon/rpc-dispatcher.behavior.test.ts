import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RpcDispatcher, RpcHandlerError } from 'harness-daemon/harness/rpc_dispatcher.js';
import type { RpcRequest } from '@nova/client/rpc_types.js';

// ---------------------------------------------------------------------------
// Stub for BusServer — true system boundary, only sendTo is used
// ---------------------------------------------------------------------------

function createBusStub() {
  const sent: Array<{ connectionId: string; channel: string; payload: unknown }> = [];
  return {
    sendTo(connectionId: string, channel: string, payload: unknown) {
      sent.push({ connectionId, channel, payload });
    },
    sent,
  };
}

type BusStub = ReturnType<typeof createBusStub>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestState {
  userId: string;
}

function makeRequest(method: string, id: string, params?: unknown): RpcRequest {
  return { rpc: 1, method, id, params };
}

const DEFAULT_STATE: TestState = { userId: 'user-1' };
const CONN_ID = 'conn-abc';
const noopEmit = () => {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RpcDispatcher', () => {
  let dispatcher: RpcDispatcher<TestState>;
  let bus: BusStub;

  beforeEach(() => {
    dispatcher = new RpcDispatcher<TestState>();
    bus = createBusStub();
  });

  // --- unknown method ---

  describe('unknown method', () => {
    it('sends a 404 error response with the method name in the message', async () => {
      const request = makeRequest('ghost.method', 'req-1');
      await dispatcher.dispatch(CONN_ID, request, DEFAULT_STATE, bus as any, noopEmit);

      expect(bus.sent).toHaveLength(1);
      const msg = bus.sent[0];
      expect(msg.connectionId).toBe(CONN_ID);
      expect(msg.channel).toBe('direct');
      const payload = msg.payload as any;
      expect(payload.rpc).toBe(1);
      expect(payload.id).toBe('req-1');
      expect(payload.error.code).toBe(404);
      expect(payload.error.message).toBe('Unknown RPC method: ghost.method');
      expect(payload.result).toBeUndefined();
    });
  });

  // --- successful handler ---

  describe('successful handler', () => {
    it('sends the handler return value as result', async () => {
      dispatcher.register('echo', (params) => ({ echoed: params }));
      const request = makeRequest('echo', 'req-2', { hello: 'world' });
      await dispatcher.dispatch(CONN_ID, request, DEFAULT_STATE, bus as any, noopEmit);

      expect(bus.sent).toHaveLength(1);
      const payload = bus.sent[0].payload as any;
      expect(payload.rpc).toBe(1);
      expect(payload.id).toBe('req-2');
      expect(payload.result).toEqual({ echoed: { hello: 'world' } });
      expect(payload.error).toBeUndefined();
    });

    it('passes state and connectionId to the handler context', async () => {
      let capturedCtx: any = null;
      dispatcher.register('inspect', (_params, ctx) => {
        capturedCtx = ctx;
        return 'ok';
      });

      await dispatcher.dispatch(CONN_ID, makeRequest('inspect', 'req-3'), DEFAULT_STATE, bus as any, noopEmit);

      expect(capturedCtx.connectionId).toBe(CONN_ID);
      expect(capturedCtx.state).toBe(DEFAULT_STATE);
      expect(typeof capturedCtx.emit).toBe('function');
    });

    it('passes the emit function from dispatch args into handler context', async () => {
      const emitSpy = vi.fn();
      let capturedEmit: any;
      dispatcher.register('grab-emit', (_params, ctx) => {
        capturedEmit = ctx.emit;
        return null;
      });

      await dispatcher.dispatch(CONN_ID, makeRequest('grab-emit', 'req-4'), DEFAULT_STATE, bus as any, emitSpy);
      expect(capturedEmit).toBe(emitSpy);
    });

    it('handles async handlers', async () => {
      dispatcher.register('async-op', async (params) => {
        await new Promise((r) => setTimeout(r, 1));
        return { async: true, params };
      });

      await dispatcher.dispatch(CONN_ID, makeRequest('async-op', 'req-5', 42), DEFAULT_STATE, bus as any, noopEmit);

      expect(bus.sent).toHaveLength(1);
      const payload = bus.sent[0].payload as any;
      expect(payload.result).toEqual({ async: true, params: 42 });
      expect(payload.error).toBeUndefined();
    });

    it('sends null result when handler returns undefined', async () => {
      dispatcher.register('void-op', () => undefined);
      await dispatcher.dispatch(CONN_ID, makeRequest('void-op', 'req-6'), DEFAULT_STATE, bus as any, noopEmit);

      const payload = bus.sent[0].payload as any;
      expect(payload.result).toBeUndefined();
      expect(payload.error).toBeUndefined();
    });
  });

  // --- RpcHandlerError ---

  describe('RpcHandlerError', () => {
    it('sends the custom error code from the thrown RpcHandlerError', async () => {
      dispatcher.register('forbidden', () => {
        throw new RpcHandlerError(403, 'Access denied');
      });

      await dispatcher.dispatch(CONN_ID, makeRequest('forbidden', 'req-7'), DEFAULT_STATE, bus as any, noopEmit);

      expect(bus.sent).toHaveLength(1);
      const payload = bus.sent[0].payload as any;
      expect(payload.rpc).toBe(1);
      expect(payload.id).toBe('req-7');
      expect(payload.error.code).toBe(403);
      expect(payload.error.message).toBe('Access denied');
      expect(payload.result).toBeUndefined();
    });

    it('preserves distinct codes for different RpcHandlerErrors', async () => {
      dispatcher.register('conflict', () => {
        throw new RpcHandlerError(409, 'Already exists');
      });

      await dispatcher.dispatch(CONN_ID, makeRequest('conflict', 'req-8'), DEFAULT_STATE, bus as any, noopEmit);
      expect((bus.sent[0].payload as any).error.code).toBe(409);
      expect((bus.sent[0].payload as any).error.message).toBe('Already exists');
    });
  });

  // --- generic Error ---

  describe('generic Error', () => {
    it('sends code 500 with the error message', async () => {
      dispatcher.register('boom', () => {
        throw new Error('Something broke');
      });

      await dispatcher.dispatch(CONN_ID, makeRequest('boom', 'req-9'), DEFAULT_STATE, bus as any, noopEmit);

      expect(bus.sent).toHaveLength(1);
      const payload = bus.sent[0].payload as any;
      expect(payload.error.code).toBe(500);
      expect(payload.error.message).toBe('Something broke');
      expect(payload.result).toBeUndefined();
    });
  });

  // --- non-Error throw ---

  describe('non-Error thrown value', () => {
    it('sends code 500 with stringified value', async () => {
      dispatcher.register('string-throw', () => {
        throw 'raw string error'; // eslint-disable-line no-throw-literal
      });

      await dispatcher.dispatch(CONN_ID, makeRequest('string-throw', 'req-10'), DEFAULT_STATE, bus as any, noopEmit);

      const payload = bus.sent[0].payload as any;
      expect(payload.error.code).toBe(500);
      expect(payload.error.message).toBe('raw string error');
    });

    it('sends code 500 for thrown number', async () => {
      dispatcher.register('number-throw', () => {
        throw 42; // eslint-disable-line no-throw-literal
      });

      await dispatcher.dispatch(CONN_ID, makeRequest('number-throw', 'req-11'), DEFAULT_STATE, bus as any, noopEmit);

      const payload = bus.sent[0].payload as any;
      expect(payload.error.code).toBe(500);
      expect(payload.error.message).toBe('42');
    });
  });

  // --- async error ---

  describe('async handler errors', () => {
    it('catches async RpcHandlerError and returns its code', async () => {
      dispatcher.register('async-fail', async () => {
        await new Promise((r) => setTimeout(r, 1));
        throw new RpcHandlerError(422, 'Invalid input');
      });

      await dispatcher.dispatch(CONN_ID, makeRequest('async-fail', 'req-12'), DEFAULT_STATE, bus as any, noopEmit);

      const payload = bus.sent[0].payload as any;
      expect(payload.error.code).toBe(422);
      expect(payload.error.message).toBe('Invalid input');
    });

    it('catches async generic Error with code 500', async () => {
      dispatcher.register('async-boom', async () => {
        throw new Error('Async failure');
      });

      await dispatcher.dispatch(CONN_ID, makeRequest('async-boom', 'req-13'), DEFAULT_STATE, bus as any, noopEmit);

      const payload = bus.sent[0].payload as any;
      expect(payload.error.code).toBe(500);
      expect(payload.error.message).toBe('Async failure');
    });
  });

  // --- register overwrite ---

  describe('register overwrites', () => {
    it('later registration for the same method replaces the first', async () => {
      dispatcher.register('method', () => 'first');
      dispatcher.register('method', () => 'second');

      await dispatcher.dispatch(CONN_ID, makeRequest('method', 'req-14'), DEFAULT_STATE, bus as any, noopEmit);

      expect((bus.sent[0].payload as any).result).toBe('second');
    });
  });

  // --- response envelope structure ---

  describe('response envelope', () => {
    it('always includes rpc=1 and the request id', async () => {
      dispatcher.register('noop', () => null);
      await dispatcher.dispatch(CONN_ID, makeRequest('noop', 'unique-id-xyz'), DEFAULT_STATE, bus as any, noopEmit);

      const payload = bus.sent[0].payload as any;
      expect(payload.rpc).toBe(1);
      expect(payload.id).toBe('unique-id-xyz');
    });

    it('sends to the correct connectionId on the direct channel', async () => {
      dispatcher.register('noop', () => null);
      const customConn = 'conn-custom-999';
      await dispatcher.dispatch(customConn, makeRequest('noop', 'req-15'), DEFAULT_STATE, bus as any, noopEmit);

      expect(bus.sent[0].connectionId).toBe(customConn);
      expect(bus.sent[0].channel).toBe('direct');
    });
  });
});
