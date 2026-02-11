/**
 * Microqueue / cooperative yielding helper.
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

      if (yieldEvery > 0 && ops % yieldEvery === 0) {
        const now = Date.now();
        if (timeSliceMs > 0 && now - sliceStart < timeSliceMs) {
          return;
        }
        sliceStart = now;
        await Promise.resolve();
      }
    },
  };
}
