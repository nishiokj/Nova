import { Effect, Queue } from 'effect';
import { RuntimeExecutionError } from './errors.js';

export type RuntimeControlAction = 'continue' | 'cancel';

export interface RuntimeCancellationMetadata {
  reason?: string;
  requestedBy?: 'user' | 'system' | 'policy';
  requestedAt: number;
  scope?: 'run' | 'work_item' | 'tool';
  targetWorkIds?: string[];
}

export interface RuntimeControlMessage {
  action: RuntimeControlAction;
  runId?: string;
  workItemId?: string;
  cancellation?: RuntimeCancellationMetadata;
  metadata?: Record<string, unknown>;
}

export type RuntimeControlQueue = Queue.Queue<RuntimeControlMessage>;

/**
 * Create an unbounded control channel for cancel flow.
 */
export function makeRuntimeControlQueue(): Effect.Effect<RuntimeControlQueue> {
  return Queue.unbounded<RuntimeControlMessage>();
}

/**
 * Publish a control message to the runtime channel.
 */
export function publishRuntimeControl(
  queue: RuntimeControlQueue,
  message: RuntimeControlMessage
): Effect.Effect<void, RuntimeExecutionError> {
  return Queue.offer(queue, message).pipe(
    Effect.flatMap((offered) =>
      offered
        ? Effect.void
        : Effect.fail(
            new RuntimeExecutionError({
              code: 'queue_closed',
              message: 'Runtime control queue is closed',
              runId: message.runId,
              workItemId: message.workItemId,
            })
          )
    )
  );
}

export function takeRuntimeControl(
  queue: RuntimeControlQueue
): Effect.Effect<RuntimeControlMessage> {
  return Queue.take(queue);
}

export function takeAllRuntimeControl(
  queue: RuntimeControlQueue
): Effect.Effect<ReadonlyArray<RuntimeControlMessage>> {
  return Queue.takeAll(queue).pipe(
    Effect.map((messages) => Array.from(messages))
  );
}

export function shutdownRuntimeControlQueue(
  queue: RuntimeControlQueue
): Effect.Effect<void> {
  return Queue.shutdown(queue);
}
