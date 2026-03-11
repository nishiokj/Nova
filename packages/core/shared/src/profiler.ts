/**
 * Chrome Trace Event profiler for CPU + async timing.
 * Output can be viewed in:
 *   - chrome://tracing (paste or load JSON)
 *   - https://speedscope.app (drag & drop JSON)
 *   - https://ui.perfetto.dev (drag & drop JSON)
 */

import { writeFileSync } from 'node:fs';

interface TraceEvent {
  name: string;
  cat: string;
  ph: 'B' | 'E' | 'X' | 'i' | 'b' | 'e' | 'n';
  ts: number;
  pid: number;
  tid: number;
  args?: Record<string, unknown>;
  dur?: number;
  id?: string;
  s?: 'g' | 'p' | 't';
}

interface TraceOutput {
  traceEvents: TraceEvent[];
  metadata: {
    process_name: string;
    start_time: string;
  };
}

type AsyncFlowId = string;

const ENABLED = process.env.PROFILE === '1' || process.env.PROFILE === 'true';

class Profiler {
  private events: TraceEvent[] = [];
  private startTime: number;
  private pid: number;
  private processName: string;
  private outputPath: string;
  private asyncIdCounter = 0;
  private shutdownRegistered = false;

  constructor() {
    this.startTime = this.now();
    this.pid = process.pid;
    this.processName = 'unknown';
    this.outputPath = `./profile-${Date.now()}.json`;
  }

  /** Initialize profiler with process name and output path */
  init(processName: string, outputPath?: string): void {
    if (!ENABLED) return;

    this.processName = processName;
    this.outputPath = outputPath ?? `./profile-${processName}-${Date.now()}.json`;
    this.startTime = this.now();
    this.events = [];

    if (!this.shutdownRegistered) {
      this.shutdownRegistered = true;
      process.on('SIGINT', () => this.flushSync());
      process.on('SIGTERM', () => this.flushSync());
      process.on('exit', () => this.flushSync());
    }

    // Record startup event so we always have at least one event
    this.instant('profiler:init', 'profiler', 'g', { processName });

    console.warn(`[profiler] Enabled for ${processName}, output: ${this.outputPath}`);
  }

  /** High-resolution timestamp in microseconds */
  private now(): number {
    const [sec, nsec] = process.hrtime();
    return sec * 1_000_000 + nsec / 1000;
  }

  /** Relative timestamp from start */
  private ts(): number {
    return this.now() - this.startTime;
  }

  /** Generate unique async flow ID */
  private nextAsyncId(): AsyncFlowId {
    return `async_${++this.asyncIdCounter}`;
  }

  /** Begin a duration event (pair with end()) */
  begin(name: string, category = 'function', args?: Record<string, unknown>): void {
    if (!ENABLED) return;
    this.events.push({
      name,
      cat: category,
      ph: 'B',
      ts: this.ts(),
      pid: this.pid,
      tid: 1,
      ...(args && { args }),
    });
  }

  /** End a duration event */
  end(name: string, category = 'function', args?: Record<string, unknown>): void {
    if (!ENABLED) return;
    this.events.push({
      name,
      cat: category,
      ph: 'E',
      ts: this.ts(),
      pid: this.pid,
      tid: 1,
      ...(args && { args }),
    });
  }

  /** Record a complete event with known duration */
  complete(name: string, durationUs: number, category = 'function', args?: Record<string, unknown>): void {
    if (!ENABLED) return;
    this.events.push({
      name,
      cat: category,
      ph: 'X',
      ts: this.ts() - durationUs,
      dur: durationUs,
      pid: this.pid,
      tid: 1,
      ...(args && { args }),
    });
  }

  /** Record an instant event */
  instant(name: string, category = 'event', scope: 'g' | 'p' | 't' = 'p', args?: Record<string, unknown>): void {
    if (!ENABLED) return;
    this.events.push({
      name,
      cat: category,
      ph: 'i',
      ts: this.ts(),
      pid: this.pid,
      tid: 1,
      s: scope,
      ...(args && { args }),
    });
  }

  /** Begin an async flow (returns ID to pass to asyncEnd) */
  asyncBegin(name: string, category = 'async'): AsyncFlowId {
    if (!ENABLED) return '';
    const id = this.nextAsyncId();
    this.events.push({
      name,
      cat: category,
      ph: 'b',
      ts: this.ts(),
      pid: this.pid,
      tid: 1,
      id,
    });
    return id;
  }

  /** End an async flow */
  asyncEnd(name: string, id: AsyncFlowId, category = 'async', args?: Record<string, unknown>): void {
    if (!ENABLED || !id) return;
    this.events.push({
      name,
      cat: category,
      ph: 'e',
      ts: this.ts(),
      pid: this.pid,
      tid: 1,
      id,
      ...(args && { args }),
    });
  }

  /** Wrap a sync function with tracing */
  trace<T>(name: string, fn: () => T, category = 'function'): T {
    if (!ENABLED) return fn();

    this.begin(name, category);
    try {
      return fn();
    } finally {
      this.end(name, category);
    }
  }

  /** Wrap an async function with tracing */
  async traceAsync<T>(name: string, fn: () => Promise<T>, category = 'async'): Promise<T> {
    if (!ENABLED) return fn();

    const id = this.asyncBegin(name, category);
    const startTs = this.ts();
    try {
      const result = await fn();
      this.asyncEnd(name, id, category, { durationMs: (this.ts() - startTs) / 1000 });
      return result;
    } catch (error) {
      this.asyncEnd(name, id, category, {
        durationMs: (this.ts() - startTs) / 1000,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Create a method decorator for tracing */
  traceMethod(category = 'method'): MethodDecorator {
    type AnyFn = (...args: unknown[]) => unknown;

    // Arrow function captures `this` (Profiler instance) via lexical scope
    return (_target, propertyKey, descriptor: PropertyDescriptor) => {
      const original = descriptor.value as AnyFn;
      const name = String(propertyKey);

      if (original.constructor.name === 'AsyncFunction') {
        const traceAsync = this.traceAsync.bind(this);
        descriptor.value = function (this: unknown, ...args: unknown[]) {
          return traceAsync(name, () => original.apply(this, args) as Promise<unknown>, category);
        };
      } else {
        const traceFn = this.trace.bind(this);
        descriptor.value = function (this: unknown, ...args: unknown[]) {
          return traceFn(name, () => original.apply(this, args), category);
        };
      }
      return descriptor;
    };
  }

  /** Get current event count */
  getEventCount(): number {
    return this.events.length;
  }

  /** Build output object */
  private buildOutput(): TraceOutput {
    return {
      traceEvents: this.events,
      metadata: {
        process_name: this.processName,
        start_time: new Date().toISOString(),
      },
    };
  }

  /** Flush events to file asynchronously */
  async flush(): Promise<void> {
    if (!ENABLED || this.events.length === 0) return;

    const output = this.buildOutput();
    const json = JSON.stringify(output, null, 2);

    try {
      const fs = await import('fs/promises');
      await fs.writeFile(this.outputPath, json, 'utf-8');
      console.warn(`[profiler] Wrote ${this.events.length} events to ${this.outputPath}`);
    } catch (error) {
      console.error('[profiler] Failed to write profile:', error);
    }
  }

  /** Flush events to file synchronously (for exit handler) */
  flushSync(): void {
    if (!ENABLED) {
      return;
    }
    if (this.events.length === 0) {
      console.warn(`[profiler] No events to write for ${this.processName}`);
      return;
    }

    const output = this.buildOutput();
    const json = JSON.stringify(output, null, 2);

    try {
      writeFileSync(this.outputPath, json, 'utf-8');
      console.warn(`[profiler] Wrote ${this.events.length} events to ${this.outputPath}`);
    } catch (error) {
      console.error('[profiler] Failed to write profile:', error);
    }
  }
}

/** Global profiler instance */
export const profiler = new Profiler();

/** Check if profiling is enabled */
export const isProfilingEnabled = (): boolean => ENABLED;

/**
 * Convenience function to wrap a function with tracing.
 * Usage: const result = await traced('myOperation', () => doSomething());
 */
export function traced<T>(name: string, fn: () => T, category = 'function'): T {
  return profiler.trace(name, fn, category);
}

/**
 * Convenience function to wrap an async function with tracing.
 * Usage: const result = await tracedAsync('myAsyncOp', () => fetchData());
 */
export function tracedAsync<T>(name: string, fn: () => Promise<T>, category = 'async'): Promise<T> {
  return profiler.traceAsync(name, fn, category);
}
