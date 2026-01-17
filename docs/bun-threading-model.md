# Bun Threading and Parallelism Guide

## Executive Summary

**Yes, for true multi-threaded behavior in Bun, you have two primary options:**

1. **`Worker` API** - Lightweight threads within the same process (shared memory options available)
2. **`spawn()` / `exec()`** - Separate OS processes (full isolation)

Bun's event loop is single-threaded (like Node.js), but it provides both threading and process parallelism primitives.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Bun Runtime                              │
├─────────────────────────────────────────────────────────────────┤
│  Main Thread (Event Loop)                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ I/O Operations│  │ Timers       │  │ Promise Micro│          │
│  │ (non-blocking)│  │ (setTimeout) │  │ Tasks        │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │           CPU-Bound Work Blocks Event Loop               │   │
│  │  → Use Workers or spawn() for parallelism                │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                    │                    │
                    ▼                    ▼
         ┌──────────────────┐   ┌──────────────────┐
         │   Worker Threads  │   │  Child Processes  │
         │  (Shared Memory)  │   │   (Isolated)      │
         └──────────────────┘   └──────────────────┘
```

---

## Option 1: Worker API (Recommended for Most Use Cases)

### Characteristics

| Aspect | Description |
|--------|-------------|
| **Type** | OS Threads (not fibers) |
| **Memory** | Can share memory via `SharedArrayBuffer` |
| **Communication** | `postMessage()` / `onmessage` (structured clone) |
| **Startup Cost** | Low (< 10ms) |
| **Isolation** | Partial (shares same process, separate JS heap) |
| **Best For** | CPU-bound tasks, parallel processing, data transformation |

### Basic Usage

```typescript
import Worker from 'bun:worker';

// Create a worker from a file
const worker = new Worker('./worker.ts', {
  type: 'module',
});

// Send data to worker
worker.postMessage({ taskId: 1, data: [1, 2, 3] });

// Receive results
worker.on('message', (result) => {
  console.log('Worker result:', result);
});

// Handle errors
worker.on('error', (err) => {
  console.error('Worker error:', err);
});

// Clean up
worker.terminate();
```

### Worker Code Example

```typescript
// worker.ts
self.onmessage = async (e) => {
  const { taskId, data } = e.data;

  // CPU-intensive work (runs on separate thread)
  const result = data.map(n => {
    let sum = 0;
    for (let i = 0; i < 100_000; i++) {
      sum += Math.sqrt(n * i);
    }
    return sum;
  });

  // Send result back
  self.postMessage({ taskId, result });
};
```

### Shared Memory (Advanced)

```typescript
import Worker from 'bun:worker';

// Create shared memory buffer
const sharedBuffer = new SharedArrayBuffer(1024);
const sharedArray = new Int32Array(sharedBuffer);

const worker = new Worker('./shared-worker.ts', {
  type: 'module',
});

worker.postMessage({ sharedBuffer });

// Both threads can read/write sharedArray
// Use Atomics for synchronization
```

### Worker Pool Pattern

```typescript
class WorkerPool {
  private workers: Worker[] = [];
  private queue: Array<{ task: any; resolve: (value: any) => void }> = [];
  private available: Set<number> = new Set();

  constructor(
    private workerScript: string,
    private poolSize: number = navigator.hardwareConcurrency || 4
  ) {
    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(workerScript, { type: 'module' });
      worker.on('message', (result) => {
        const next = this.queue.shift();
        if (next) {
          worker.postMessage(next.task);
          next.resolve(result);
        } else {
          this.available.add(i);
        }
      });
      this.workers.push(worker);
      this.available.add(i);
    }
  }

  async execute(task: any): Promise<any> {
    const workerIndex = this.available.values().next().value;
    if (workerIndex === undefined) {
      return new Promise(resolve => this.queue.push({ task, resolve }));
    }
    this.available.delete(workerIndex);
    this.workers[workerIndex].postMessage(task);
    return new Promise(resolve => {
      const handler = (result: any) => {
        this.workers[workerIndex].removeListener('message', handler);
        resolve(result);
      };
      this.workers[workerIndex].on('message', handler);
    });
  }

  terminate() {
    this.workers.forEach(w => w.terminate());
  }
}
```

---

## Option 2: Child Processes (spawn/exec)

### Characteristics

| Aspect | Description |
|--------|-------------|
| **Type** | Separate OS processes |
| **Memory** | Full isolation (no shared memory) |
| **Communication** | Stdin/stdout, IPC, or message passing |
| **Startup Cost** | High (~50-200ms) |
| **Isolation** | Complete (crash isolation) |
| **Best For** | Long-running services, sandboxing, legacy integration |

### Basic Usage

```typescript
import { spawn } from 'bun';

const child = spawn({
  cmd: ['bun', './script.ts'],
  stdout: 'pipe',
  stderr: 'pipe',
});

// Read output
const output = await new Response(child.stdout).text();
const exitCode = await child.exited;

console.log(`Output: ${output}`);
console.log(`Exit code: ${exitCode}`);
```

### Bidirectional Communication

```typescript
import { spawn } from 'bun';

const child = spawn({
  cmd: ['bun', './interactive-worker.ts'],
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'inherit',
});

// Send data
const writer = child.stdin.getWriter();
await writer.write(JSON.stringify({ action: 'process', data: [1, 2, 3] }));

// Read response
const response = await new Response(child.stdout).text();
const result = JSON.parse(response);

console.log('Result:', result);
```

### Process Pool Pattern

```typescript
class ProcessPool {
  private pool: Array<{ process: any; busy: boolean }> = [];

  constructor(
    private script: string,
    private poolSize: number = 2
  ) {
    for (let i = 0; i < poolSize; i++) {
      const process = spawn({
        cmd: ['bun', script],
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'inherit',
      });
      this.pool.push({ process, busy: false });
    }
  }

  async execute(task: any): Promise<any> {
    const available = this.pool.find(p => !p.busy);
    if (!available) {
      throw new Error('No available processes');
    }

    available.busy = true;
    const writer = available.process.stdin.getWriter();
    await writer.write(JSON.stringify(task));

    const response = await new Response(available.process.stdout).text();
    available.busy = false;

    return JSON.parse(response);
  }

  terminate() {
    this.pool.forEach(p => p.process.kill());
  }
}
```

---

## Comparison: Workers vs. Processes

| Factor | Workers | Processes |
|--------|---------|-----------|
| **Startup Time** | ~5-10ms | ~50-200ms |
| **Memory Overhead** | Low (shared heap) | High (separate heap) |
| **Communication** | Fast (structured clone) | Slower (serialization) |
| **Isolation** | Partial | Complete |
| **Shared Memory** | Yes (SharedArrayBuffer) | No |
| **Crash Impact** | Can crash main process | Isolated |
| **Best For** | CPU tasks, short jobs | Long-running services, sandboxing |

---

## When to Use Which

### Use Workers When:

- ✅ CPU-bound computations (image processing, data analysis)
- ✅ Need to process multiple items in parallel
- ✅ Tasks complete in seconds (not hours)
- ✅ Want low communication overhead
- ✅ Need shared memory access
- ✅ Building worker pools for high throughput

### Use Processes When:

- ✅ Running untrusted code (sandboxing)
- ✅ Long-running background services
- ✅ Need complete crash isolation
- ✅ Integrating with existing CLI tools
- ✅ Running different versions of Bun/Node
- ✅ Need separate environment variables/config

---

## Performance Considerations

### Event Loop Blocking

```typescript
// ❌ BAD: Blocks event loop
function heavyComputation() {
  for (let i = 0; i < 1_000_000_000; i++) {
    // CPU work
  }
}

// ✅ GOOD: Offload to worker
async function heavyComputation() {
  const worker = new Worker('./heavy-worker.ts');
  worker.postMessage({ iterations: 1_000_000_000 });
  return new Promise(resolve => {
    worker.on('message', resolve);
  });
}
```

### I/O Operations (No Threading Needed)

```typescript
// ✅ GOOD: I/O is non-blocking on event loop
async function fetchMultiple(urls: string[]) {
  const results = await Promise.all(
    urls.map(url => fetch(url).then(r => r.json()))
  );
  return results;
}

// No need for workers - I/O runs in parallel via event loop
```

### Concurrency Limits

```typescript
// Respect hardware limits for CPU-bound work
const maxWorkers = navigator.hardwareConcurrency || 4;
const workerPool = new WorkerPool('./worker.ts', maxWorkers);
```

---

## Real-World Example: Parallel File Processing

```typescript
import { readdir } from 'node:fs/promises';
import Worker from 'bun:worker';

// Process multiple files in parallel
async function processFilesParallel(dir: string) {
  const files = await readdir(dir);
  const jsFiles = files.filter(f => f.endsWith('.ts') || f.endsWith('.js'));

  // Create worker pool
  const workers = jsFiles.map(() => new Worker('./file-processor.ts', {
    type: 'module',
  }));

  // Process all files in parallel (true CPU parallelism)
  const results = await Promise.all(
    jsFiles.map((file, i) => {
      return new Promise(resolve => {
        workers[i].on('message', resolve);
        workers[i].postMessage({ file, dir });
      });
    })
  );

  // Cleanup
  workers.forEach(w => w.terminate());

  return results;
}
```

---

## Bun vs. Node.js Threading

| Feature | Bun | Node.js |
|---------|-----|---------|
| `Worker` API | ✅ Native | ✅ `worker_threads` |
| `SharedArrayBuffer` | ✅ Native | ✅ Native |
| `spawn()` | ✅ Native (simpler API) | ✅ `child_process` |
| `Atomics` | ✅ Native | ✅ Native |
| Performance | Faster startup | Slower startup |
| API Ergonomics | Cleaner | More verbose |

---

## Summary

| Question | Answer |
|----------|--------|
| Is Bun single-threaded? | Yes, the event loop is single-threaded |
| Can I run code in parallel? | Yes, via Workers (threads) or spawn() (processes) |
| Which should I use? | Workers for CPU tasks, spawn() for isolation |
| Do I need threads for I/O? | No, I/O is already non-blocking on the event loop |
| Can I share memory? | Yes, via `SharedArrayBuffer` with Workers |
| What's the startup cost? | Workers: ~5-10ms, Processes: ~50-200ms |

---

**Key Takeaway**: Bun's event loop is single-threaded, but you can achieve true parallelism through Workers (for CPU-bound work) or child processes (for isolation). Use Workers for most parallel computation needs—they're faster, lighter, and support shared memory.