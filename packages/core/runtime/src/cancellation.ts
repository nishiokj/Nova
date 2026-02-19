import { Deferred, Effect, Exit, Scope } from 'effect';
import { RuntimeExecutionError } from './errors.js';

export interface RuntimeCancellationSignal {
  reason?: string;
  requestedBy?: 'user' | 'system' | 'policy';
  requestedAt: number;
  runId?: string;
  workItemId?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeCancellationController {
  readonly cancelled: Deferred.Deferred<RuntimeCancellationSignal>;
}

export function makeCancellationController(): Effect.Effect<RuntimeCancellationController> {
  return Deferred.make<RuntimeCancellationSignal>().pipe(
    Effect.map((cancelled) => ({ cancelled }))
  );
}

export function requestCancellation(
  controller: RuntimeCancellationController,
  signal: RuntimeCancellationSignal
): Effect.Effect<boolean> {
  return Deferred.succeed(controller.cancelled, signal);
}

export function awaitCancellation(
  controller: RuntimeCancellationController
): Effect.Effect<RuntimeCancellationSignal> {
  return Deferred.await(controller.cancelled);
}

/**
 * Runs an effect while observing a cancellation latch; cancellation fails with a typed error.
 */
export function interruptWhenCancelled<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  controller: RuntimeCancellationController
): Effect.Effect<A, E | RuntimeExecutionError, R> {
  return Effect.raceFirst(
    effect,
    awaitCancellation(controller).pipe(
      Effect.flatMap((signal) =>
        Effect.fail(
          new RuntimeExecutionError({
            code: 'cancelled',
            message: signal.reason ?? 'Execution cancelled',
            runId: signal.runId,
            workItemId: signal.workItemId,
            metadata: signal.metadata,
          })
        )
      )
    )
  );
}

/**
 * Helper for registering interruption-safe finalizers under Effect scope.
 */
export function withScopedFinalizer<A, E, R, X, XR>(
  acquire: Effect.Effect<A, E, R>,
  finalizer: (resource: A, exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void, X, XR>
): Effect.Effect<A, E, R | XR | Scope.Scope> {
  return Effect.acquireRelease(
    acquire,
    (resource, exit) => finalizer(resource, exit).pipe(Effect.orDie)
  );
}
