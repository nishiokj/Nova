import { Effect, Exit, Ref } from 'effect';

export type RuntimeTracePhase =
  | 'started'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'resumed';

export interface RuntimeTraceEvent {
  phase: RuntimeTracePhase;
  unit: string;
  timestamp: number;
  runId?: string;
  workItemId?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeTracer {
  readonly events: Ref.Ref<readonly RuntimeTraceEvent[]>;
}

export function makeRuntimeTracer(): Effect.Effect<RuntimeTracer> {
  return Ref.make<readonly RuntimeTraceEvent[]>([]).pipe(
    Effect.map((events) => ({ events }))
  );
}

export function emitRuntimeTrace(
  tracer: RuntimeTracer,
  event: RuntimeTraceEvent
): Effect.Effect<void> {
  return Ref.update(tracer.events, (events) => [...events, event]);
}

export function readRuntimeTrace(
  tracer: RuntimeTracer
): Effect.Effect<readonly RuntimeTraceEvent[]> {
  return Ref.get(tracer.events);
}

/**
 * Annotates an effect with start/end lifecycle events.
 */
export function traceRuntimeUnit<A, E, R>(
  tracer: RuntimeTracer,
  unit: string,
  effect: Effect.Effect<A, E, R>,
  metadata?: Omit<RuntimeTraceEvent, 'phase' | 'unit' | 'timestamp'>
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const startedAt = Date.now();
    yield* emitRuntimeTrace(tracer, {
      phase: 'started',
      unit,
      timestamp: startedAt,
      runId: metadata?.runId,
      workItemId: metadata?.workItemId,
      metadata: metadata?.metadata,
    });

    const exit: Exit.Exit<A, E> = yield* Effect.exit(effect);
    const completedAt = Date.now();

    yield* emitRuntimeTrace(tracer, {
      phase: Exit.isSuccess(exit) ? 'completed' : 'failed',
      unit,
      timestamp: completedAt,
      runId: metadata?.runId,
      workItemId: metadata?.workItemId,
      metadata: metadata?.metadata,
    });

    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    return yield* Effect.failCause(exit.cause);
  });
}
