import type { RpcDispatcher } from './rpc_dispatcher.js';

interface RpcHandlerDeps<State> {
  invokeRpcMethod: (
    method: string,
    connectionId: string,
    state: State,
    params?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registerRpcHandlers<State>(
  dispatcher: RpcDispatcher<State>,
  deps: RpcHandlerDeps<State>
): void {
  const register = (method: string) => {
    dispatcher.register(method, async (params, ctx) => {
      return deps.invokeRpcMethod(
        method,
        ctx.connectionId,
        ctx.state,
        isRecord(params) ? params : {},
      );
    });
  };

  register('config.get');
  register('status.get');
  register('service.health');
  register('service.readiness');
  register('models.list');
  register('models.delete');

  register('skills.list');
  register('skills.get');
  register('skills.create');
  register('skills.update');
  register('skills.delete');
  register('skills.enable');
  register('skills.disable');
  register('skills.run');

  register('hooks.list');
  register('hooks.get');
  register('hooks.create');
  register('hooks.update');
  register('hooks.delete');
  register('hooks.enable');
  register('hooks.disable');

  register('auth.start');
  register('auth.poll');
  register('auth.verify');
  register('auth.logout');

  register('providers.list');
  register('providers.save');
  register('providers.delete');
  register('providers.test');

  register('session.fork');
  register('session.close');
  register('session.delete');
  register('session.list');

  register('usage.summary');

  register('context.compact');
  register('model.set');
  register('model.get');

  register('dangerous_mode.set');
  register('async.start');
  register('async.cancel');
  register('async.status');

  register('control.dispatch');
  register('control.stop');
  register('control.fork');
  register('control.permissions.get');
  register('control.permissions.update');
  register('control.memory_info');
  register('control.model.get');
  register('control.model.set');

  register('voice.start');
  register('voice.stop');
}
