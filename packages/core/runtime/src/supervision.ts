import { Effect, Fiber, Ref, Scope } from 'effect';

export type RuntimeFiber = Fiber.RuntimeFiber<unknown, unknown>;

export interface RuntimeFiberSet {
  readonly fibers: Ref.Ref<Set<RuntimeFiber>>;
}

export function makeRuntimeFiberSet(): Effect.Effect<RuntimeFiberSet> {
  return Ref.make(new Set<RuntimeFiber>()).pipe(
    Effect.map((fibers) => ({ fibers }))
  );
}

export function registerFiber(
  fiberSet: RuntimeFiberSet,
  fiber: RuntimeFiber
): Effect.Effect<void> {
  return Ref.update(fiberSet.fibers, (current) => {
    const next = new Set(current);
    next.add(fiber);
    return next;
  });
}

export function unregisterFiber(
  fiberSet: RuntimeFiberSet,
  fiber: RuntimeFiber
): Effect.Effect<void> {
  return Ref.update(fiberSet.fibers, (current) => {
    const next = new Set(current);
    next.delete(fiber);
    return next;
  });
}

/**
 * Forks an effect in scope and tracks the fiber for coordinated teardown.
 */
export function forkSupervised<A, E, R>(
  fiberSet: RuntimeFiberSet,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<RuntimeFiber, never, R | Scope.Scope> {
  return Effect.gen(function* () {
    const fiber = yield* Effect.forkScoped(effect);
    yield* registerFiber(fiberSet, fiber as RuntimeFiber);
    return fiber as RuntimeFiber;
  });
}

export function joinAllSupervised(
  fiberSet: RuntimeFiberSet
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const current = yield* Ref.get(fiberSet.fibers);
    yield* Effect.forEach(current, (fiber) => Fiber.join(fiber), {
      discard: true,
      concurrency: 'unbounded',
    });
    yield* Ref.set(fiberSet.fibers, new Set<RuntimeFiber>());
  });
}

export function interruptAllSupervised(
  fiberSet: RuntimeFiberSet
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const current = yield* Ref.get(fiberSet.fibers);
    yield* Effect.forEach(current, (fiber) => Fiber.interrupt(fiber), {
      discard: true,
      concurrency: 'unbounded',
    });
    yield* Ref.set(fiberSet.fibers, new Set<RuntimeFiber>());
  });
}
