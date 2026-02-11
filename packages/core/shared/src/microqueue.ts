/**
 * Microqueue / cooperative yielding helper.
 *
 * Bun runs single-threaded by default; long synchronous loops (tool-call bursts,
 * message building) can monopolize the event loop.
 *
 * This helper provides periodic yielding without changing semantics.
 */

export interface MicroQueueOptions {
  /** Yield after this many "ops" (calls to yieldIfNeeded). */
  yieldEvery?: number;
  /** Additionally yield if a time slice is exceeded. */
  timeSliceMs?: number;
}

export interface MicroQueue {
  yieldIfNeeded(): Promise<void>;
}

export function createMicroQueue(options: MicroQueueOptions = {}): MicroQueue {
  const yieldEvery = options.yieldEvery ?? 10;
  const timeSliceMs = options.timeSliceMs ?? 8;

  let ops = 0;
  let sliceStart = Date.now();

  return {
    async yieldIfNeeded(): Promise<void> {
      ops++;

      // Cheap op-count check first.
      if (yieldEvery > 0 && ops % yieldEvery === 0) {
        // Also guard against calling Date.now() too often.
        const now = Date.now();
        if (timeSliceMs > 0 && now - sliceStart < timeSliceMs) {
          return;
        }
        sliceStart = now;
        // Microtask yield: allows IO/event handlers to run without timers.
        await Promise.resolve();
      }
    },
  };
}
