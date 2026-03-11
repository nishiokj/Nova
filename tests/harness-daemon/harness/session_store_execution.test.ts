import { existsSync, rmSync } from 'fs';
import path from 'path';
import { ManagedRuntime, Layer, Queue, Effect } from 'effect';
import { SessionStore, type HarnessLogger } from 'harness-daemon/harness/session_store.js';

const logger: HarnessLogger = {
  info: () => {},
  debug: () => {},
  warning: () => {},
  error: () => {},
};

const DISK_TEST_DIR = path.join(import.meta.dirname, '__session_exec_test_tmp__');

/**
 * Create a ManagedRuntime<never, never> from an empty layer — same as production code.
 * dispose() returns a Promise<void>.
 */
function createTestRuntime() {
  return ManagedRuntime.make(Layer.empty);
}

/**
 * Create an unbounded Effect Queue to use as RuntimeControlQueue.
 */
function createTestControlQueue() {
  return Effect.runSync(Queue.unbounded<unknown>());
}

describe('SessionStore execution lifecycle', () => {
  beforeEach(() => {
    if (existsSync(DISK_TEST_DIR)) {
      rmSync(DISK_TEST_DIR, { recursive: true });
    }
  });
  afterEach(() => {
    if (existsSync(DISK_TEST_DIR)) {
      rmSync(DISK_TEST_DIR, { recursive: true });
    }
  });

  function createStore(sessionKey = 'exec-test') {
    return new SessionStore({
      sessionKey,
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });
  }

  describe('close() disposes executionRuntime', () => {
    it('calls dispose() on the execution runtime during close', async () => {
      const store = createStore('close-dispose');
      store.getContext(); // hydrate

      const runtime = createTestRuntime();
      const disposeSpy = vi.spyOn(runtime, 'dispose');
      const controlQueue = createTestControlQueue();

      store.startExecution('req-1', controlQueue as never, runtime);
      expect(store.isExecuting()).toBe(true);

      store.close();

      expect(disposeSpy).toHaveBeenCalledTimes(1);
      // dispose() returns a Promise — await it to verify it resolves
      await disposeSpy.mock.results[0].value;
    });

    it('does not throw when no execution is active', () => {
      const store = createStore('close-no-exec');
      store.getContext();
      expect(() => store.close()).not.toThrow();
    });
  });

  describe('endExecution() disposes executionRuntime', () => {
    it('calls dispose() on the execution runtime', async () => {
      const store = createStore('end-dispose');
      store.getContext();

      const runtime = createTestRuntime();
      const disposeSpy = vi.spyOn(runtime, 'dispose');
      const controlQueue = createTestControlQueue();

      store.startExecution('req-1', controlQueue as never, runtime);
      expect(store.isExecuting()).toBe(true);

      const queued = store.endExecution();
      expect(queued).toEqual([]); // no queued messages
      expect(disposeSpy).toHaveBeenCalledTimes(1);
      await disposeSpy.mock.results[0].value;
    });

    it('clears execution state after endExecution', () => {
      const store = createStore('end-clear');
      store.getContext();

      const runtime = createTestRuntime();
      const controlQueue = createTestControlQueue();

      store.startExecution('req-1', controlQueue as never, runtime);
      store.endExecution();

      expect(store.isExecuting()).toBe(false);
      expect(store.getExecutingRequestId()).toBeNull();
      expect(store.getActiveExecutionHandle()).toBeNull();
    });

    it('allows starting a new execution after endExecution', () => {
      const store = createStore('end-restart');
      store.getContext();

      const runtime1 = createTestRuntime();
      const runtime2 = createTestRuntime();
      const controlQueue = createTestControlQueue();

      store.startExecution('req-1', controlQueue as never, runtime1);
      store.endExecution();

      const started = store.startExecution('req-2', controlQueue as never, runtime2);
      expect(started).toBe(true);
      expect(store.getExecutingRequestId()).toBe('req-2');
    });
  });

  describe('startExecution rejects concurrent executions', () => {
    it('returns false if execution already active', () => {
      const store = createStore('concurrent');
      store.getContext();

      const runtime = createTestRuntime();
      const controlQueue = createTestControlQueue();

      expect(store.startExecution('req-1', controlQueue as never, runtime)).toBe(true);
      expect(store.startExecution('req-2', controlQueue as never, runtime)).toBe(false);
      expect(store.getExecutingRequestId()).toBe('req-1');
    });
  });

  describe('dispose() rejection does not crash', () => {
    it('handles a rejecting dispose gracefully', async () => {
      const store = createStore('dispose-reject');
      store.getContext();

      const runtime = createTestRuntime();
      const controlQueue = createTestControlQueue();

      // Make dispose reject
      vi.spyOn(runtime, 'dispose').mockReturnValue(
        Promise.reject(new Error('dispose failed')) as never
      );

      store.startExecution('req-1', controlQueue as never, runtime);

      // close() should not throw synchronously
      expect(() => store.close()).not.toThrow();

      // Give the microtask queue a tick to process the rejection
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
