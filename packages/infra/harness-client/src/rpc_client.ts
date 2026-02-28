import type { RpcRequest, RpcResponse, ProcedureInput, ProcedureMethod, ProcedureOutput } from './rpc_types.js';
import { isRpcResponse } from './rpc_types.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class RpcCallError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export class RpcClient {
  private readonly send: (request: RpcRequest) => boolean;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(send: (request: RpcRequest) => boolean, timeoutMs: number) {
    this.send = send;
    this.timeoutMs = timeoutMs;
  }

  async call<M extends ProcedureMethod>(method: M, params: ProcedureInput<M>): Promise<ProcedureOutput<M>> {
    return new Promise<ProcedureOutput<M>>((resolve, reject) => {
      const id = generateRpcId();
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout for method ${method}`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeoutId });

      const request: RpcRequest = {
        rpc: 1,
        id,
        method,
        params,
      };

      if (!this.send(request)) {
        clearTimeout(timeoutId);
        this.pending.delete(id);
        reject(new Error('Not connected to bridge'));
      }
    });
  }

  handleResponse(payload: unknown): payload is RpcResponse {
    if (!isRpcResponse(payload)) {
      return false;
    }

    const pending = this.pending.get(payload.id);
    if (!pending) {
      return true;
    }

    clearTimeout(pending.timeoutId);
    this.pending.delete(payload.id);

    if ('error' in payload) {
      pending.reject(new RpcCallError(payload.error.code, payload.error.message));
      return true;
    }

    pending.resolve(payload.result);
    return true;
  }

  rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function generateRpcId(): string {
  return `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
