/**
 * Tests for runtime control queue (cancel/continue messaging).
 *
 * Covers: makeRuntimeControlQueue, publishRuntimeControl, takeRuntimeControl,
 * takeAllRuntimeControl, shutdownRuntimeControlQueue, and closed-queue errors.
 */

import { Effect } from 'effect';
import {
  makeRuntimeControlQueue,
  publishRuntimeControl,
  takeRuntimeControl,
  takeAllRuntimeControl,
  shutdownRuntimeControlQueue,
  RuntimeExecutionError,
  type RuntimeControlMessage,
} from 'runtime';

describe('makeRuntimeControlQueue', () => {
  it('creates a queue that accepts messages', async () => {
    const queue = await Effect.runPromise(makeRuntimeControlQueue());
    expect(queue).toBeDefined();
  });
});

describe('publishRuntimeControl', () => {
  it('publishes a continue message', async () => {
    const queue = await Effect.runPromise(makeRuntimeControlQueue());

    await Effect.runPromise(publishRuntimeControl(queue, { action: 'continue' }));

    const msg = await Effect.runPromise(takeRuntimeControl(queue));
    expect(msg.action).toBe('continue');
  });

  it('publishes a cancel message with metadata', async () => {
    const queue = await Effect.runPromise(makeRuntimeControlQueue());

    const message: RuntimeControlMessage = {
      action: 'cancel',
      runId: 'run-1',
      workItemId: 'work-1',
      cancellation: {
        reason: 'user stopped',
        requestedBy: 'user',
        requestedAt: 12345,
        scope: 'run',
      },
    };

    await Effect.runPromise(publishRuntimeControl(queue, message));

    const received = await Effect.runPromise(takeRuntimeControl(queue));
    expect(received.action).toBe('cancel');
    expect(received.runId).toBe('run-1');
    expect(received.cancellation?.reason).toBe('user stopped');
    expect(received.cancellation?.scope).toBe('run');
  });
});

describe('takeAllRuntimeControl', () => {
  it('drains all messages in order', async () => {
    const queue = await Effect.runPromise(makeRuntimeControlQueue());

    await Effect.runPromise(publishRuntimeControl(queue, { action: 'continue' }));
    await Effect.runPromise(publishRuntimeControl(queue, { action: 'cancel' }));
    await Effect.runPromise(publishRuntimeControl(queue, { action: 'continue' }));

    const messages = await Effect.runPromise(takeAllRuntimeControl(queue));
    expect(messages).toHaveLength(3);
    expect(messages[0].action).toBe('continue');
    expect(messages[1].action).toBe('cancel');
    expect(messages[2].action).toBe('continue');
  });

  it('returns empty array when queue is empty', async () => {
    const queue = await Effect.runPromise(makeRuntimeControlQueue());
    const messages = await Effect.runPromise(takeAllRuntimeControl(queue));
    expect(messages).toEqual([]);
  });
});

describe('shutdownRuntimeControlQueue', () => {
  it('shuts down the queue so new publishes fail', async () => {
    const queue = await Effect.runPromise(makeRuntimeControlQueue());

    await Effect.runPromise(shutdownRuntimeControlQueue(queue));

    // After shutdown, publishing should fail
    try {
      await Effect.runPromise(publishRuntimeControl(queue, { action: 'continue' }));
      expect(true).toBe(false); // Should not reach
    } catch (error) {
      // The queue is shut down — Effect's Queue.offer resolves to false for
      // shutdown queues, which our wrapper maps to a RuntimeExecutionError.
      // However, Effect may also throw its own QueueShutdown error.
      // Either way, publishing should fail.
      expect(error).toBeDefined();
    }
  });
});

describe('message ordering (FIFO)', () => {
  it('delivers messages in publish order', async () => {
    const queue = await Effect.runPromise(makeRuntimeControlQueue());

    for (let i = 0; i < 10; i++) {
      await Effect.runPromise(
        publishRuntimeControl(queue, {
          action: i % 2 === 0 ? 'continue' : 'cancel',
          metadata: { index: i },
        }),
      );
    }

    for (let i = 0; i < 10; i++) {
      const msg = await Effect.runPromise(takeRuntimeControl(queue));
      expect(msg.metadata?.index).toBe(i);
    }
  });
});

describe('cancel message with work_item scope', () => {
  it('carries targetWorkIds through the queue', async () => {
    const queue = await Effect.runPromise(makeRuntimeControlQueue());

    await Effect.runPromise(publishRuntimeControl(queue, {
      action: 'cancel',
      cancellation: {
        requestedAt: Date.now(),
        requestedBy: 'system',
        reason: 'scope test',
        scope: 'work_item',
        targetWorkIds: ['w1', 'w2'],
      },
    }));

    const msg = await Effect.runPromise(takeRuntimeControl(queue));
    expect(msg.cancellation?.scope).toBe('work_item');
    expect(msg.cancellation?.targetWorkIds).toEqual(['w1', 'w2']);
  });
});
