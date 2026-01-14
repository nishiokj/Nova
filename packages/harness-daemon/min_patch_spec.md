# Minimum Patch Spec: Hot Path Optimization (harness-daemon)

This spec describes a **surgical, minimum-net-new-code** patch to optimize the harness-daemon **hot path** (request latency + event throughput). The patch intentionally **breaks backwards compatibility** where doing so removes branching/complexity and lowers steady-state overhead.

## Goal / New System State

In the new state, the daemon prioritizes throughput and latency by:

1. **Batching GraphD event persistence by default** (no more per-event writes).
2. **Removing synchronous `@path` file injection from the request hot path** (or hard-gating it so it is not executed by default).
3. **Removing debug console output from the hot path**.

These changes reduce:
- per-event GraphD write amplification
- synchronous filesystem IO during request handling
- logging/console overhead

## Evidence: Current Hot Path

From code inspection:
- `src/harness/bridge_gateway.ts` handles bridge commands and streams events via:
  - `for await (const event of handle.events) this.bus.publish(channel, event)`
- `src/harness/harness.ts` `run()` currently:
  - extracts `@path` references (`extractAtPaths`) and calls `fs.existsSync` + `fs.readFileSync` inline
  - creates `GraphDSubscriber` (default behavior writes immediately per event)
- `src/subscribers/graphd_subscriber.ts` defaults:
  - `batchMode: false` → calls `graphd.sessionUpdateMetadata` once **per event**

## Patch Overview (Minimal Changes)

### Patch 1 — Make GraphDSubscriber batch by default (hot path win)

**File:** `src/subscribers/graphd_subscriber.ts`

**Current state:**
- `batchMode` defaults to `false`
- `persistEvent()` calls `graphd.sessionUpdateMetadata(... agent_events: [formattedEvent])` for every event

**New state (breaking change):**
- `batchMode` defaults to `true`
- `batchSize` defaults to `50` (keep existing default)
- additionally: flush periodically by microtask already exists; we only change defaults

**Required edits (minimal):**
- In the constructor config normalization:
  - change `batchMode: config.batchMode ?? false` → `batchMode: config.batchMode ?? true`

**Effect:**
- reduces GraphD writes from O(events) to O(events/batchSize)
- preserves event ordering within batches as currently accumulated

**Behavioral impact:**
- dashboard/event consumers will see events arrive in bursts rather than per-event
- in crash scenarios, last batch may be lost (acceptable for perf-first state)

---

### Patch 2 — Remove synchronous @path injection from request hot path

**File:** `src/harness/harness.ts`

**Current state:**
- `run()` extracts `@path` references and performs synchronous filesystem reads:
  - `fs.existsSync(fullPath)`
  - `fs.readFileSync(fullPath, 'utf-8')`

This is a latency trap and couples request performance to disk.

**New state (breaking change):**
- `@path` references are **no longer auto-injected** into context.
- If users want files in context, they must use explicit tools (Read/Glob/Grep) through the agent/tooling.

**Required edits (minimal):**
- Delete (or comment-remove) the entire block:
  - `const atPaths = extractAtPaths(inputText); ... contextWindow.addFileContent(...)`
- Remove `extractAtPaths()` helper if it becomes unused.
  - This reduces net code.

**Effect:**
- eliminates synchronous disk IO from every request
- reduces CPU spent parsing/regex + string slicing

**Behavioral impact:**
- prompts containing `@some/path.ts` will no longer implicitly include file contents.
- this is intentional (no backward compatibility).

---

### Patch 3 — Remove hot-path console debug noise

**File:** `src/harness/harness.ts`

**Current state:**
- `runSingleAgent()` contains:
  - `console.error(`[HARNESS DEBUG] Created workItem: ...`)`

Even if `runSingleAgent()` is not the primary mode (orchestrator is), this is noisy and can impact performance when used.

**New state (breaking change):**
- no console debug emission in agent execution.

**Required edits (minimal):**
- Delete the `console.error(...)` line.

**Effect:**
- less IO overhead and less TUI/daemon console capture overhead

---

## Optional Micro-Patches (Only if Needed)

These are explicitly optional because they add branching or require more validation.

1. **Drop high-volume event types from GraphD persistence**
   - would require filtering rules; likely increases code.
2. **Throttle `GraphDSubscriber` flush by time**
   - would add timers/state; not minimal.
3. **Batch BusServer publishes**
   - likely requires changes in `packages/comms-bus` and protocol expectations.

## Implementation Steps (Single Pass)

1. Edit `src/subscribers/graphd_subscriber.ts`
   - change default `batchMode` to `true`.
2. Edit `src/harness/harness.ts`
   - remove the `@path` extraction + file injection block.
   - remove `extractAtPaths()` if unused after deletion.
   - remove the `console.error([HARNESS DEBUG] ...)` line.
3. Run typecheck / build:
   - `bun test` (if present) or `bun run build` / `bun run typecheck` depending on package scripts.

## Verification Plan (Performance-Oriented)

### Correctness smoke
- Start daemon: `bun run src/index.ts` (or project’s start script)
- Connect via existing bus client/TUI
- Send `init` then `send_text`
- Verify:
  - response events still stream
  - GraphD still records events (batched)

### Performance smoke
- With GraphD enabled, run a request that emits many events.
- Confirm GraphD calls reduced (e.g., by temporary logging or GraphD metrics).

## Expected Outcomes

- Lower median and tail latency for `send_text` requests.
- Dramatically fewer GraphD writes under event-heavy runs.
- Less contention from synchronous disk and console IO.

## Files Touched

- `src/subscribers/graphd_subscriber.ts`
- `src/harness/harness.ts`

