import type { BusServer } from 'comms-bus';
import type { BridgeEvent } from './types.js';
import type { RpcRequest } from 'harness-client';

export class RpcHandlerError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RpcContext<State> {
  connectionId: string;
  state: State;
  emit: (event: BridgeEvent, channel?: string) => void;
}

type RpcHandler<State> = (params: unknown, ctx: RpcContext<State>) => unknown;

export class RpcDispatcher<State> {
  private readonly handlers = new Map<string, RpcHandler<State>>();

  register(method: string, handler: RpcHandler<State>): void {
    this.handlers.set(method, handler);
  }

  async dispatch(
    connectionId: string,
    request: RpcRequest,
    state: State,
    bus: BusServer,
    emit: (event: BridgeEvent, channel?: string) => void,
  ): Promise<void> {
    const handler = this.handlers.get(request.method);
    if (!handler) {
      bus.sendTo(connectionId, 'direct', {
        rpc: 1,
        id: request.id,
        error: {
          code: 404,
          message: `Unknown RPC method: ${request.method}`,
        },
      });
      return;
    }

    try {
      const result = await handler(request.params, { connectionId, state, emit });
      bus.sendTo(connectionId, 'direct', {
        rpc: 1,
        id: request.id,
        result,
      });
    } catch (error) {
      const code = error instanceof RpcHandlerError ? error.code : 500;
      const message = error instanceof Error ? error.message : String(error);
      bus.sendTo(connectionId, 'direct', {
        rpc: 1,
        id: request.id,
        error: { code, message },
      });
    }
  }
}
