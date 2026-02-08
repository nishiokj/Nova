/**
 * Tests for the Hook System.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  registerHook,
  clearHooks,
  getHooks,
  executeHooks,
  loadHooksFromConfig,
  type HookEventType,
  type HookCallback,
  type ShellHook,
  type HooksConfig,
} from './hooks.js';
import type { InternalHookEvent, InternalHookContext } from 'agent';

// --- Test Fixtures ---

function createTestContext(): InternalHookContext {
  return {
    workId: 'test-work-123',
    agentType: 'standard',
    sessionKey: 'test-session',
    requestId: 'req-456',
  };
}

function createTurnCompletedEvent(): InternalHookEvent {
  return {
    type: 'turn_completed',
    iteration: 1,
    toolCallsMade: 5,
    llmCallsMade: 2,
    hasResponse: true,
  };
}

function createFilesModifiedEvent(paths: string[]): InternalHookEvent {
  return {
    type: 'files_modified',
    paths,
  };
}

function createAgentCompletedEvent(): InternalHookEvent {
  return {
    type: 'agent_completed',
    workId: 'work-123',
    success: true,
    terminationReason: 'goal_state_reached',
    filesRead: ['/path/to/file.ts'],
    invalidatedPaths: [],
  };
}

// --- Tests ---

describe('Hook Registry', () => {
  beforeEach(() => {
    // Clear all hooks before each test
    clearHooks('turn_completed');
    clearHooks('tool_batch_completed');
    clearHooks('context_threshold');
    clearHooks('files_modified');
    clearHooks('artifacts_discovered');
    clearHooks('agent_completed');
    clearHooks('stop');
  });

  describe('registerHook', () => {
    it('registers a TypeScript callback hook', () => {
      const callback: HookCallback = async () => {};
      registerHook('turn_completed', callback);

      const hooks = getHooks('turn_completed');
      expect(hooks).toHaveLength(1);
      expect(hooks[0]).toBe(callback);
    });

    it('registers a shell hook', () => {
      const shellHook: ShellHook = { command: 'echo "test"', timeout: 5000 };
      registerHook('files_modified', shellHook);

      const hooks = getHooks('files_modified');
      expect(hooks).toHaveLength(1);
      expect(hooks[0]).toEqual(shellHook);
    });

    it('allows multiple hooks per event type', () => {
      const callback1: HookCallback = async () => {};
      const callback2: HookCallback = async () => {};
      const shellHook: ShellHook = { command: 'echo "test"' };

      registerHook('turn_completed', callback1);
      registerHook('turn_completed', callback2);
      registerHook('turn_completed', shellHook);

      const hooks = getHooks('turn_completed');
      expect(hooks).toHaveLength(3);
    });

    it('keeps hooks for different event types separate', () => {
      const callback1: HookCallback = async () => {};
      const callback2: HookCallback = async () => {};

      registerHook('turn_completed', callback1);
      registerHook('agent_completed', callback2);

      expect(getHooks('turn_completed')).toHaveLength(1);
      expect(getHooks('agent_completed')).toHaveLength(1);
    });

    it('returns an unregister function that removes only that hook instance', () => {
      const callback1: HookCallback = async () => {};
      const callback2: HookCallback = async () => {};

      const unregister1 = registerHook('turn_completed', callback1);
      registerHook('turn_completed', callback2);

      unregister1();

      const hooks = getHooks('turn_completed');
      expect(hooks).toHaveLength(1);
      expect(hooks[0]).toBe(callback2);
    });
  });

  describe('clearHooks', () => {
    it('clears all hooks for an event type', () => {
      registerHook('turn_completed', async () => {});
      registerHook('turn_completed', async () => {});

      clearHooks('turn_completed');

      expect(getHooks('turn_completed')).toHaveLength(0);
    });

    it('does not affect hooks for other event types', () => {
      registerHook('turn_completed', async () => {});
      registerHook('agent_completed', async () => {});

      clearHooks('turn_completed');

      expect(getHooks('turn_completed')).toHaveLength(0);
      expect(getHooks('agent_completed')).toHaveLength(1);
    });
  });

  describe('getHooks', () => {
    it('returns empty array for unregistered event types', () => {
      expect(getHooks('turn_completed')).toEqual([]);
    });
  });
});

describe('Hook Execution', () => {
  beforeEach(() => {
    clearHooks('turn_completed');
    clearHooks('files_modified');
    clearHooks('agent_completed');
  });

  describe('executeHooks with TypeScript callbacks', () => {
    it('executes a single callback with correct arguments', async () => {
      const event = createTurnCompletedEvent();
      const ctx = createTestContext();
      let receivedEvent: InternalHookEvent | null = null;
      let receivedCtx: InternalHookContext | null = null;

      const callback: HookCallback = async (e, c) => {
        receivedEvent = e;
        receivedCtx = c;
      };

      registerHook('turn_completed', callback);
      await executeHooks('turn_completed', event, ctx);

      expect(receivedEvent).toEqual(event);
      expect(receivedCtx).toEqual(ctx);
    });

    it('executes multiple callbacks in parallel', async () => {
      const event = createTurnCompletedEvent();
      const ctx = createTestContext();
      const executionOrder: number[] = [];

      const callback1: HookCallback = async () => {
        await new Promise((r) => setTimeout(r, 50));
        executionOrder.push(1);
      };
      const callback2: HookCallback = async () => {
        await new Promise((r) => setTimeout(r, 10));
        executionOrder.push(2);
      };

      registerHook('turn_completed', callback1);
      registerHook('turn_completed', callback2);

      await executeHooks('turn_completed', event, ctx);

      // Both should have executed (order depends on timing)
      expect(executionOrder).toHaveLength(2);
      expect(executionOrder).toContain(1);
      expect(executionOrder).toContain(2);
    });

    it('continues execution when one callback throws', async () => {
      const event = createTurnCompletedEvent();
      const ctx = createTestContext();
      let secondCallbackExecuted = false;

      const errorCallback: HookCallback = async () => {
        throw new Error('Hook failed');
      };
      const successCallback: HookCallback = async () => {
        secondCallbackExecuted = true;
      };

      registerHook('turn_completed', errorCallback);
      registerHook('turn_completed', successCallback);

      // Should not throw
      await executeHooks('turn_completed', event, ctx);

      // Second callback should still execute
      expect(secondCallbackExecuted).toBe(true);
    });

    it('does nothing when no hooks are registered', async () => {
      const event = createTurnCompletedEvent();
      const ctx = createTestContext();

      // Should not throw
      await executeHooks('turn_completed', event, ctx);
    });
  });

  describe('executeHooks with shell hooks', () => {
    it('executes a shell command that succeeds (exit 0)', async () => {
      const event = createFilesModifiedEvent(['/test/file.ts']);
      const ctx = createTestContext();

      const shellHook: ShellHook = { command: 'exit 0' };
      registerHook('files_modified', shellHook);

      // Should not throw
      await executeHooks('files_modified', event, ctx);
    });

    it('handles shell command that exits with warning (non-zero, non-2)', async () => {
      const event = createFilesModifiedEvent(['/test/file.ts']);
      const ctx = createTestContext();

      // Exit 1 = warning, should not throw
      const shellHook: ShellHook = { command: 'exit 1' };
      registerHook('files_modified', shellHook);

      await executeHooks('files_modified', event, ctx);
    });

    it('logs error but continues when shell hook exits with 2 (blocking error)', async () => {
      const event = createFilesModifiedEvent(['/test/file.ts']);
      const ctx = createTestContext();
      let secondHookExecuted = false;

      // Exit 2 = blocking error
      const blockingHook: ShellHook = { command: 'exit 2' };
      const successHook: HookCallback = async () => {
        secondHookExecuted = true;
      };

      registerHook('files_modified', blockingHook);
      registerHook('files_modified', successHook);

      await executeHooks('files_modified', event, ctx);

      // Other hooks should still execute (error is logged but doesn't propagate)
      expect(secondHookExecuted).toBe(true);
    });

    it('pipes JSON payload to stdin', async () => {
      const event = createFilesModifiedEvent(['/test/file.ts']);
      const ctx = createTestContext();

      // This command reads stdin and exits 0 if it contains expected content
      const shellHook: ShellHook = {
        command: 'read input && echo "$input" | grep -q "files_modified" && exit 0 || exit 1',
      };
      registerHook('files_modified', shellHook);

      // Should succeed because the JSON contains "files_modified"
      await executeHooks('files_modified', event, ctx);
    });

    it('respects timeout for shell commands', async () => {
      const event = createFilesModifiedEvent(['/test/file.ts']);
      const ctx = createTestContext();

      // Command that sleeps longer than timeout
      const shellHook: ShellHook = { command: 'sleep 10', timeout: 100 };
      registerHook('files_modified', shellHook);

      // Should complete (with error logged) within reasonable time
      const start = Date.now();
      await executeHooks('files_modified', event, ctx);
      const elapsed = Date.now() - start;

      // Should have timed out, not waited 10 seconds
      expect(elapsed).toBeLessThan(5000);
    });
  });

  describe('mixed hook types', () => {
    it('executes both TypeScript callbacks and shell hooks', async () => {
      const event = createAgentCompletedEvent();
      const ctx = createTestContext();
      let callbackExecuted = false;

      const callback: HookCallback = async () => {
        callbackExecuted = true;
      };
      const shellHook: ShellHook = { command: 'exit 0' };

      registerHook('agent_completed', callback);
      registerHook('agent_completed', shellHook);

      await executeHooks('agent_completed', event, ctx);

      expect(callbackExecuted).toBe(true);
    });
  });
});

describe('Config Loading', () => {
  beforeEach(() => {
    clearHooks('turn_completed');
    clearHooks('files_modified');
    clearHooks('agent_completed');
  });

  it('loads hooks from JSON config object', () => {
    const config: HooksConfig = {
      files_modified: [{ command: './scripts/on-change.sh', timeout: 5000 }],
      agent_completed: [{ command: 'python3 ./hooks/log.py' }],
    };

    loadHooksFromConfig(config);

    const fileHooks = getHooks('files_modified');
    const agentHooks = getHooks('agent_completed');

    expect(fileHooks).toHaveLength(1);
    expect(agentHooks).toHaveLength(1);
    expect(fileHooks[0]).toEqual({ command: './scripts/on-change.sh', timeout: 5000 });
    expect(agentHooks[0]).toEqual({ command: 'python3 ./hooks/log.py' });
  });

  it('loads multiple hooks for the same event', () => {
    const config: HooksConfig = {
      files_modified: [
        { command: './scripts/lint.sh' },
        { command: './scripts/format.sh' },
        { command: './scripts/notify.sh', timeout: 3000 },
      ],
    };

    loadHooksFromConfig(config);

    const hooks = getHooks('files_modified');
    expect(hooks).toHaveLength(3);
  });

  it('ignores unknown event types with error log', () => {
    const config: HooksConfig = {
      unknown_event: [{ command: 'echo "test"' }],
      files_modified: [{ command: './valid.sh' }],
    };

    // Should not throw, just log error
    loadHooksFromConfig(config);

    // Valid hook should still be registered
    expect(getHooks('files_modified')).toHaveLength(1);
  });

  it('handles empty config', () => {
    const config: HooksConfig = {};
    loadHooksFromConfig(config);

    // Should not throw
    expect(getHooks('files_modified')).toHaveLength(0);
  });

  it('handles config with empty hook arrays', () => {
    const config: HooksConfig = {
      files_modified: [],
    };

    loadHooksFromConfig(config);

    expect(getHooks('files_modified')).toHaveLength(0);
  });
});

describe('Event Type Validation', () => {
  beforeEach(() => {
    clearHooks('turn_completed');
    clearHooks('tool_batch_completed');
    clearHooks('context_threshold');
    clearHooks('files_modified');
    clearHooks('artifacts_discovered');
    clearHooks('agent_completed');
    clearHooks('stop');
  });

  it('accepts all valid event types', () => {
    const validTypes: HookEventType[] = [
      'turn_completed',
      'tool_batch_completed',
      'context_threshold',
      'files_modified',
      'artifacts_discovered',
      'agent_completed',
      'stop',
    ];

    for (const eventType of validTypes) {
      registerHook(eventType, async () => {});
      expect(getHooks(eventType)).toHaveLength(1);
      clearHooks(eventType);
    }
  });
});

describe('Stop Hook', () => {
  beforeEach(() => {
    clearHooks('stop');
  });

  it('registers stop hook type', () => {
    const callback: HookCallback = async () => {};
    registerHook('stop', callback);

    expect(getHooks('stop')).toHaveLength(1);
  });
});
