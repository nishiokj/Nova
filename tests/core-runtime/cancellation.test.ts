/**
 * Tests for runtime cancellation primitives.
 *
 * Covers: makeCancellationController, requestCancellation, awaitCancellation,
 * interruptWhenCancelled, and signal propagation semantics.
 */

import { Effect, Fiber } from 'effect';
import {
  makeCancellationController,
  requestCancellation,
  awaitCancellation,
  interruptWhenCancelled,
  RuntimeExecutionError,
} from 'runtime';

describe('makeCancellationController', () => {
  it('creates a controller with an unresolved deferred', async () => {
    const controller = await Effect.runPromise(makeCancellationController());
    expect(controller).toBeDefined();
    expect(controller.cancelled).toBeDefined();
  });
});

describe('requestCancellation', () => {
  it('succeeds the deferred with the signal', async () => {
    const controller = await Effect.runPromise(makeCancellationController());

    const signal = {
      reason: 'test cancel',
      requestedBy: 'user' as const,
      requestedAt: Date.now(),
    };

    const didSet = await Effect.runPromise(requestCancellation(controller, signal));
    expect(didSet).toBe(true);
  });

  it('returns false on second cancellation (already resolved)', async () => {
    const controller = await Effect.runPromise(makeCancellationController());

    const signal = { requestedAt: Date.now() };
    await Effect.runPromise(requestCancellation(controller, signal));

    const second = await Effect.runPromise(requestCancellation(controller, { requestedAt: Date.now(), reason: 'second' }));
    expect(second).toBe(false);
  });
});

describe('awaitCancellation', () => {
  it('resolves when cancellation is requested', async () => {
    const controller = await Effect.runPromise(makeCancellationController());

    const signal = {
      reason: 'stop now',
      requestedBy: 'system' as const,
      requestedAt: 123456,
      runId: 'run-1',
    };

    // Request cancellation and then await it
    await Effect.runPromise(requestCancellation(controller, signal));
    const received = await Effect.runPromise(awaitCancellation(controller));

    expect(received.reason).toBe('stop now');
    expect(received.requestedBy).toBe('system');
    expect(received.requestedAt).toBe(123456);
    expect(received.runId).toBe('run-1');
  });
});

describe('interruptWhenCancelled', () => {
  it('returns the effect result when no cancellation occurs', async () => {
    const controller = await Effect.runPromise(makeCancellationController());

    const result = await Effect.runPromise(
      interruptWhenCancelled(Effect.succeed('hello'), controller),
    );

    expect(result).toBe('hello');
  });

  it('fails with RuntimeExecutionError when cancelled before effect completes', async () => {
    const controller = await Effect.runPromise(makeCancellationController());

    // Resolve the cancellation deferred BEFORE running interruptWhenCancelled,
    // so the race resolves immediately with the cancellation error.
    await Effect.runPromise(requestCancellation(controller, {
      reason: 'cancel test',
      requestedAt: Date.now(),
      runId: 'run-cancel-1',
      workItemId: 'work-1',
    }));

    const longRunning = Effect.sleep('10 seconds').pipe(Effect.as('should not reach'));

    const result = await Effect.runPromise(
      interruptWhenCancelled(longRunning, controller).pipe(
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed({ caught: error }),
          onSuccess: () => Effect.succeed({ caught: null }),
        }),
      ),
    );

    expect(result.caught).toBeInstanceOf(RuntimeExecutionError);
    const runtimeError = result.caught as RuntimeExecutionError;
    expect(runtimeError.code).toBe('cancelled');
    expect(runtimeError.message).toBe('cancel test');
    expect(runtimeError.runId).toBe('run-cancel-1');
    expect(runtimeError.workItemId).toBe('work-1');
  });

  it('uses default message when signal has no reason', async () => {
    const controller = await Effect.runPromise(makeCancellationController());

    await Effect.runPromise(requestCancellation(controller, { requestedAt: Date.now() }));

    const longRunning = Effect.sleep('10 seconds');

    const result = await Effect.runPromise(
      interruptWhenCancelled(longRunning, controller).pipe(
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed({ caught: error }),
          onSuccess: () => Effect.succeed({ caught: null }),
        }),
      ),
    );

    expect(result.caught).toBeInstanceOf(RuntimeExecutionError);
    expect((result.caught as RuntimeExecutionError).message).toBe('Execution cancelled');
  });

  it('propagates metadata from cancellation signal to error', async () => {
    const controller = await Effect.runPromise(makeCancellationController());

    await Effect.runPromise(requestCancellation(controller, {
      requestedAt: Date.now(),
      reason: 'with-metadata',
      metadata: { custom: 'value' },
    }));

    const longRunning = Effect.sleep('10 seconds');

    const result = await Effect.runPromise(
      interruptWhenCancelled(longRunning, controller).pipe(
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed({ caught: error }),
          onSuccess: () => Effect.succeed({ caught: null }),
        }),
      ),
    );

    expect(result.caught).toBeInstanceOf(RuntimeExecutionError);
    const runtimeError = result.caught as RuntimeExecutionError;
    expect(runtimeError.message).toBe('with-metadata');
    expect(runtimeError.metadata).toEqual({ custom: 'value' });
  });
});
