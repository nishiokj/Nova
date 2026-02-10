import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { InternalHookContext, InternalHookEvent } from 'agent';
import {
  clearHooks,
  executeHooks,
  getHooks,
  loadHooksFromConfig,
  registerHook,
  type HookCallback,
  type HooksConfig,
} from './legacy_hooks.js';

function createContext(): InternalHookContext {
  return {
    workId: 'work-1',
    agentType: 'standard',
    sessionKey: 'session-1',
    requestId: 'req-1',
  };
}

function createTurnCompletedEvent(): InternalHookEvent {
  return {
    type: 'turn_completed',
    iteration: 1,
    toolCallsMade: 1,
    llmCallsMade: 1,
    hasResponse: true,
  };
}

describe('legacy_hooks registry', () => {
  beforeEach(() => {
    clearHooks('turn_completed');
    clearHooks('files_modified');
    clearHooks('agent_completed');
  });

  it('registers and unregisters hook callbacks', () => {
    const cb: HookCallback = async () => {};
    const unregister = registerHook('turn_completed', cb);
    expect(getHooks('turn_completed')).toHaveLength(1);

    unregister();
    expect(getHooks('turn_completed')).toHaveLength(0);
  });

  it('loads shell hooks from config', () => {
    const config: HooksConfig = {
      files_modified: [{ command: 'echo ok' }],
    };

    loadHooksFromConfig(config);
    expect(getHooks('files_modified')).toHaveLength(1);
  });
});

describe('legacy_hooks execution', () => {
  beforeEach(() => {
    clearHooks('turn_completed');
  });

  it('executes registered callbacks with payload and context', async () => {
    const event = createTurnCompletedEvent();
    const context = createContext();
    const callback = mock(async (receivedEvent: InternalHookEvent, receivedContext: InternalHookContext) => {
      expect(receivedEvent).toEqual(event);
      expect(receivedContext).toEqual(context);
    });

    registerHook('turn_completed', callback);
    await executeHooks('turn_completed', event, context);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('continues executing callbacks when one callback throws', async () => {
    const event = createTurnCompletedEvent();
    const context = createContext();
    const healthy = mock(async () => {});
    const failing: HookCallback = async () => {
      throw new Error('expected');
    };

    registerHook('turn_completed', failing);
    registerHook('turn_completed', healthy);
    await executeHooks('turn_completed', event, context);

    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
