# Internal Async Hook System - Minimum Patch Spec

## Overview

Add an internal async hook system for background housekeeping tasks (context management, artifact persistence, validation, progress review). Hooks are plain functions that run through the existing orchestrator work queue without LLM invocation.

**Two distinct hook systems after this patch:**

| Sync Hooks (existing, unchanged) | Async Hooks (new) |
|----------------------------------|-------------------|
| `preToolUse`, `postToolUse` | `turn_completed`, `context_threshold`, etc. |
| User/domain-oriented | Internal system housekeeping |
| Blocks execution (intentional) | Enqueued via existing work queue |
| Validation, permissions, logging | Context mgmt, persistence, linting |
| Runs inline in agent | Runs as function, no LLM |

---

## Design Principles

1. **Use existing infrastructure** - hooks enqueue into `workQueue`, no separate queue
2. **No LLM for hooks** - handlers are plain async functions in `/hooks` directory
3. **Fire-and-forget from agent** - agent emits event, doesn't await; hook execution must not delay agent iteration or affect termination/context merges
4. **Extensible** - hooks can have dependencies on other work items if needed later
5. **Timeboxed** - handlers should be short-lived; wrap with explicit timeouts to avoid stalling iterations

---

## Files Changed

```
packages/agent/src/types.ts                    # Add InternalHookEvent types
packages/agent/src/agent.ts                    # Add emit points
packages/agent/src/index.ts                    # Export new types
packages/orchestrator/src/hooks/index.ts       # NEW: hook registry
packages/orchestrator/src/hooks/context-threshold.ts   # NEW: handler
packages/orchestrator/src/hooks/turn-completed.ts      # NEW: handler
packages/orchestrator/src/hooks/artifacts-discovered.ts # NEW: handler
packages/orchestrator/src/hooks/files-modified.ts      # NEW: handler
packages/orchestrator/src/hooks/agent-completed.ts     # NEW: handler
packages/orchestrator/src/orchestrator.ts      # Wire up hook execution
packages/work/src/work-item.ts                 # Add isInternalHook param type
packages/types/src/events.ts                   # Add hook_call event type + payload
packages/types/src/event_schemas.ts            # Add hook_call schema
```

---

## 1. Types (`packages/agent/src/types.ts`)

Add after line 181 (after `AgentHooks` interface):

```typescript
// ============================================
// INTERNAL ASYNC HOOKS (best-effort housekeeping)
// ============================================

/**
 * Internal hook event types.
 * Fired by agent, enqueued as work items, executed as plain functions (no LLM).
 */
export type InternalHookEvent =
  | {
      type: 'turn_completed';
      iteration: number;
      toolCallsMade: number;
      llmCallsMade: number;
      hasResponse: boolean;
      terminationReason?: string;
    }
  | {
      type: 'tool_batch_completed';
      toolNames: string[];
      successCount: number;
      failCount: number;
    }
  | {
      type: 'context_threshold';
      usagePercent: number;
      tokenCount: number;
      itemCount: number;
    }
  | {
      type: 'artifacts_discovered';
      artifacts: Array<{ sourcePath: string; name: string; kind: string }>;
      discoveredBy: string;
    }
  | {
      type: 'files_modified';
      paths: string[];
    }
  | {
      type: 'agent_completed';
      workId: string;
      success: boolean;
      terminationReason: string;
      filesRead: string[];
      invalidatedPaths: string[];
    };

/**
 * Context passed to internal hook handlers.
 */
export interface InternalHookContext {
  workId: string;
  agentType: string;
  sessionKey: string;
  requestId: string;
}

/**
 * Internal hook handler function signature.
 * Plain async function - no LLM, no agent.
 */
export type InternalHookHandler<T extends InternalHookEvent = InternalHookEvent> = (
  event: T,
  context: InternalHookContext
) => Promise<void>;

/**
 * Interface for enqueueing internal hook work items.
 * Implemented by orchestrator, passed to agent.
 */
export interface InternalHookQueue {
  /**
   * Enqueue a hook event as a work item.
   * Returns immediately - does not block.
   */
  enqueue(event: InternalHookEvent, context: InternalHookContext): void;
}

/**
 * Noop hook queue for when hooks are disabled.
 */
export const noopHookQueue: InternalHookQueue = {
  enqueue: () => {},
};
```

---

## 2. Hook Handlers (`packages/orchestrator/src/hooks/`)

### `packages/orchestrator/src/hooks/index.ts`

```typescript
/**
 * Internal Hook Registry
 *
 * Maps event types to handler functions.
 * Handlers are plain async functions - no LLM invocation.
 */

import type { InternalHookEvent, InternalHookHandler } from 'agent';

import { handle as handleContextThreshold } from './context-threshold.js';
import { handle as handleTurnCompleted } from './turn-completed.js';
import { handle as handleArtifactsDiscovered } from './artifacts-discovered.js';
import { handle as handleFilesModified } from './files-modified.js';
import { handle as handleAgentCompleted } from './agent-completed.js';
import { handle as handleToolBatchCompleted } from './tool-batch-completed.js';

/**
 * Registry mapping event types to their handlers.
 * Multiple handlers per event type supported.
 */
export const HOOK_REGISTRY: Record<InternalHookEvent['type'], InternalHookHandler[]> = {
  context_threshold: [handleContextThreshold],
  turn_completed: [handleTurnCompleted],
  tool_batch_completed: [handleToolBatchCompleted],
  artifacts_discovered: [handleArtifactsDiscovered],
  files_modified: [handleFilesModified],
  agent_completed: [handleAgentCompleted],
};

/**
 * Register an additional handler for an event type.
 */
export function registerHook(
  eventType: InternalHookEvent['type'],
  handler: InternalHookHandler
): void {
  if (!HOOK_REGISTRY[eventType]) {
    HOOK_REGISTRY[eventType] = [];
  }
  HOOK_REGISTRY[eventType].push(handler);
}

/**
 * Get all handlers for an event type.
 */
export function getHandlers(eventType: InternalHookEvent['type']): InternalHookHandler[] {
  return HOOK_REGISTRY[eventType] ?? [];
}
```

### `packages/orchestrator/src/hooks/context-threshold.ts`

```typescript
/**
 * Context Threshold Hook
 *
 * Fired when context usage exceeds threshold.
 * Use for: checkpointing, memory consolidation, alerting.
 */

import type { InternalHookEvent, InternalHookContext } from 'agent';

type ContextThresholdEvent = Extract<InternalHookEvent, { type: 'context_threshold' }>;

export async function handle(
  event: ContextThresholdEvent,
  ctx: InternalHookContext
): Promise<void> {
  console.error(
    `[HOOK:context_threshold] session=${ctx.sessionKey} ` +
    `usage=${event.usagePercent.toFixed(1)}% tokens=${event.tokenCount} items=${event.itemCount}`
  );

  // TODO: Implement actual handlers
  // - Checkpoint working memory to persistent store
  // - Trigger summarization of older context
  // - Alert if usage critically high
}
```

### `packages/orchestrator/src/hooks/turn-completed.ts`

```typescript
/**
 * Turn Completed Hook
 *
 * Fired after each agent turn (LLM call + tool execution).
 * Use for: progress tracking, metrics, review triggers.
 */

import type { InternalHookEvent, InternalHookContext } from 'agent';

type TurnCompletedEvent = Extract<InternalHookEvent, { type: 'turn_completed' }>;

export async function handle(
  event: TurnCompletedEvent,
  ctx: InternalHookContext
): Promise<void> {
  console.error(
    `[HOOK:turn_completed] agent=${ctx.agentType} iteration=${event.iteration} ` +
    `tools=${event.toolCallsMade} llm=${event.llmCallsMade} hasResponse=${event.hasResponse}`
  );

  // TODO: Implement actual handlers
  // - Update progress metrics
  // - Check for stagnation patterns
  // - Trigger progress review if needed
}
```

### `packages/orchestrator/src/hooks/tool-batch-completed.ts`

```typescript
/**
 * Tool Batch Completed Hook
 *
 * Fired after a batch of tool calls completes.
 * Use for: validation, metrics, error pattern detection.
 */

import type { InternalHookEvent, InternalHookContext } from 'agent';

type ToolBatchCompletedEvent = Extract<InternalHookEvent, { type: 'tool_batch_completed' }>;

export async function handle(
  event: ToolBatchCompletedEvent,
  ctx: InternalHookContext
): Promise<void> {
  const total = event.successCount + event.failCount;
  const successRate = total > 0 ? (event.successCount / total * 100).toFixed(0) : 'N/A';

  console.error(
    `[HOOK:tool_batch_completed] agent=${ctx.agentType} ` +
    `tools=[${event.toolNames.join(',')}] success=${successRate}%`
  );

  // TODO: Implement actual handlers
  // - Detect repeated failures
  // - Validate tool outputs
  // - Update tool usage metrics
}
```

### `packages/orchestrator/src/hooks/artifacts-discovered.ts`

```typescript
/**
 * Artifacts Discovered Hook
 *
 * Fired when agent discovers code artifacts.
 * Use for: persistence to graph store, relevance scoring.
 */
// NOTE: No emit point is defined in this spec yet; register when artifact discovery is wired.

import type { InternalHookEvent, InternalHookContext } from 'agent';

type ArtifactsDiscoveredEvent = Extract<InternalHookEvent, { type: 'artifacts_discovered' }>;

export async function handle(
  event: ArtifactsDiscoveredEvent,
  ctx: InternalHookContext
): Promise<void> {
  console.error(
    `[HOOK:artifacts_discovered] agent=${ctx.agentType} ` +
    `count=${event.artifacts.length} discoveredBy=${event.discoveredBy}`
  );

  // TODO: Implement actual handlers
  // - Persist artifacts to graph store
  // - Update relevance scores
  // - Cross-reference with existing artifacts
}
```

### `packages/orchestrator/src/hooks/files-modified.ts`

```typescript
/**
 * Files Modified Hook
 *
 * Fired when agent writes/edits files.
 * Use for: cache invalidation, lint queueing, change tracking.
 */

import type { InternalHookEvent, InternalHookContext } from 'agent';

type FilesModifiedEvent = Extract<InternalHookEvent, { type: 'files_modified' }>;

export async function handle(
  event: FilesModifiedEvent,
  ctx: InternalHookContext
): Promise<void> {
  console.error(
    `[HOOK:files_modified] agent=${ctx.agentType} paths=[${event.paths.join(',')}]`
  );

  // TODO: Implement actual handlers
  // - Invalidate file cache entries
  // - Queue files for linting/validation
  // - Track changes for rollback capability
}
```

### `packages/orchestrator/src/hooks/agent-completed.ts`

```typescript
/**
 * Agent Completed Hook
 *
 * Fired when agent execution completes (success or failure).
 * Use for: work settlement, finding consolidation, cleanup.
 */

import type { InternalHookEvent, InternalHookContext } from 'agent';

type AgentCompletedEvent = Extract<InternalHookEvent, { type: 'agent_completed' }>;

export async function handle(
  event: AgentCompletedEvent,
  ctx: InternalHookContext
): Promise<void> {
  console.error(
    `[HOOK:agent_completed] workId=${event.workId} success=${event.success} ` +
    `reason=${event.terminationReason} filesRead=${event.filesRead.length} ` +
    `invalidated=${event.invalidatedPaths.length}`
  );

  // TODO: Implement actual handlers
  // - Settle work item in ledger
  // - Consolidate findings
  // - Clean up temporary state
}
```

---

## 3. Work Item Update (`packages/work/src/work-item.ts`)

Add to `WorkItem` interface params type hint (for documentation, runtime uses `params?: Record<string, unknown>`):

```typescript
/**
 * Known param shapes for typed access.
 * The actual params field remains Record<string, unknown> for flexibility.
 */
export interface InternalHookParams {
  isInternalHook: true;
  hookType: string;
  handler: () => Promise<void>;
}
```

---

## 4. Agent Changes (`packages/agent/src/agent.ts`)

### 4.1 Add to imports (line 23)

```diff
 import type {
   AgentConfig,
   AgentRunParams,
   AgentResult,
   AgentMetrics,
   EventEmitCallback,
   UserPromptInfo,
   AgentHooks,
+  InternalHookQueue,
+  InternalHookContext,
 } from './types.js';
-import { noopEmit } from './types.js';
+import { noopEmit, noopHookQueue } from './types.js';
```

### 4.2 Add class property (after line 60)

```diff
 private hooks?: AgentHooks;
+private internalHookQueue: InternalHookQueue;
```

### 4.3 Modify constructor (line 62-79)

```diff
 constructor(config: AgentConfig, runtime: {
   llm: LLMAdapter;
   toolRegistry: ToolRegistry;
   emit?: EventEmitCallback;
   requestId?: string;
   agentRegistry?: AgentRegistry;
   llmConfig?: LLMRequestConfig;
   hooks?: AgentHooks;
+  internalHookQueue?: InternalHookQueue;
 }) {
   this.config = config;
   this.llm = runtime.llm;
   this.toolRegistry = runtime.toolRegistry;
   this.emit = runtime.emit ?? noopEmit;
   this.requestId = runtime.requestId ?? '';
   this.agentRegistry = runtime.agentRegistry;
   this.llmConfig = runtime.llmConfig ?? { model: 'unknown' };
   this.hooks = runtime.hooks;
+  this.internalHookQueue = runtime.internalHookQueue ?? noopHookQueue;
 }
```

### 4.4 Add helper method (after constructor)

```typescript
/**
 * Build internal hook context from current state.
 */
private buildHookContext(workItem: WorkItem): InternalHookContext {
  return {
    workId: workItem.workId,
    agentType: this.config.type,
    sessionKey: this.requestId,
    requestId: this.requestId,
  };
}
```

### 4.5 Emit points in executeLoop

**After context compaction (~line 181):**

```diff
 if (localContext.isNearFull()) {
   const compactResult = localContext.compact({
     deduplicateByPath: true,
     truncateOutputsTo: 4000,
   });
   console.error(`[AGENT DEBUG] Compacted context: ...`);
+
+  this.internalHookQueue.enqueue({
+    type: 'context_threshold',
+    usagePercent: localContext.metrics.percentageUsed,
+    tokenCount: localContext.metrics.inputTokens + localContext.metrics.outputTokens,
+    itemCount: localContext.items.length,
+  }, this.buildHookContext(workItem));
 }
```

**After LLM response and tool processing (~line 298):**

```typescript
// After tool calls processed or response captured
this.internalHookQueue.enqueue({
  type: 'turn_completed',
  iteration,
  toolCallsMade: metrics.toolCallsMade,
  llmCallsMade: metrics.llmCallsMade,
  hasResponse: !!responseText,
  terminationReason: result.terminationReason || undefined,
}, this.buildHookContext(workItem));
```

**After processToolCalls (~line 891):**

```typescript
const toolCallsSucceededBefore = metrics.toolCallsSucceeded;
const toolCallsFailedBefore = metrics.toolCallsFailed;

// ... processToolCalls(toolCalls, ...)

// Fire after tool batch completes (per-batch counts, not cumulative)
if (toolCalls.length > 0) {
  const successCount = metrics.toolCallsSucceeded - toolCallsSucceededBefore;
  const failCount = metrics.toolCallsFailed - toolCallsFailedBefore;
  this.internalHookQueue.enqueue({
    type: 'tool_batch_completed',
    toolNames: toolCalls.map(tc => tc.name),
    successCount,
    failCount,
  }, this.buildHookContext(workItem));
}
```

**When files are modified (accumulate in result, emit at end):**

At end of executeLoop (~line 456), before returning:

```typescript
// Emit files_modified if any paths were invalidated
if (result.invalidatedPaths.length > 0) {
  this.internalHookQueue.enqueue({
    type: 'files_modified',
    paths: result.invalidatedPaths,
  }, this.buildHookContext(workItem));
}

// Emit agent_completed
this.internalHookQueue.enqueue({
  type: 'agent_completed',
  workId: workItem.workId,
  success: result.success,
  terminationReason: result.terminationReason,
  filesRead: result.filesRead,
  invalidatedPaths: result.invalidatedPaths,
}, this.buildHookContext(workItem));
```

### 4.6 Update executeAgentToolCall (~line 1063)

```diff
 const agent = new Agent(agentConfig, {
   llm: this.llm,
   toolRegistry: this.toolRegistry,
   emit: this.emit,
   requestId: this.requestId,
   agentRegistry: this.agentRegistry,
   llmConfig,
   hooks: this.hooks,
+  internalHookQueue: this.internalHookQueue,
 });
```

---

## 5. Orchestrator Integration (`packages/orchestrator/src/orchestrator.ts`)

### 5.0 Add hook timeout config (line 29)

```diff
 export interface OrchestratorConfig {
   /** Maximum iterations in execution loop */
   maxIterations: number;
   /** Maximum total tool calls across all iterations */
   maxToolCalls: number;
   /** Maximum duration in milliseconds */
   maxDurationMs: number;
+  /** Max time for internal hook handler execution */
+  hookTimeoutMs: number;
   /** Percent context usage that triggers compaction (default 0.8) */
   compactTriggerPercent: number;
   /** Percent context usage to reset compaction hysteresis (default 0.7) */
   compactResetPercent: number;
   /** Max file content items to keep during compaction */
   compactMaxFileCount: number;
   /** Max chars per tool output during compaction */
   compactTruncateTo: number;
 }
```

```diff
 export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
   maxIterations: 70,
   maxToolCalls: 250,
   maxDurationMs: 1000_000, // 5 minutes
+  hookTimeoutMs: 5000,
   compactTriggerPercent: 0.70,
   compactResetPercent: 0.7,
   compactMaxFileCount: 20,
   compactTruncateTo: 5000,
 };
```

### 5.1 Add imports (line 13)

```diff
 import type { EventEmitCallback, UserPromptInfo, AgentHooks, AgentResult } from 'agent';
+import type { InternalHookEvent, InternalHookContext, InternalHookQueue } from 'agent';
 import { Agent } from 'agent';
+import { getHandlers } from './hooks/index.js';
```

### 5.2 Implement InternalHookQueue (after class properties ~line 127)

```typescript
/**
 * Creates a hook queue that enqueues events as work items.
 */
  private createHookQueue(): InternalHookQueue {
    return {
      enqueue: (event: InternalHookEvent, context: InternalHookContext) => {
        const handlers = getHandlers(event.type);
        if (handlers.length === 0) return;

      // Create work item with handler closure
      const hookWorkItem = createWorkItem({
        goal: 'internal_hook',
        objective: `hook:${event.type}`,
        agent: 'internal',
        dependencies: [], // Independent - can run anytime
        bounds: {
          maxToolCalls: 0,
          maxDurationMs: 5000,
          maxLlmCalls: 0,
        },
        params: {
          isInternalHook: true,
          hookType: event.type,
          handler: async () => {
            for (const handler of handlers) {
              try {
                // NOTE: actual timeout applied in runHookHandler(), not here.
                await handler(event, context);
              } catch (err) {
                console.error(`[HOOK:${event.type}] Handler error:`, err);
              }
            }
          },
        },
      });

      this.enqueue(hookWorkItem);
    },
    };
  }
```

### 5.3 Add hookQueue property and initialize in constructor

```diff
 private eventBus?: EventBusProtocol;
+private hookQueue: InternalHookQueue;

 // Work queue state for DAG-based execution
 private workQueue: WorkItem[] = [];
```

In constructor, after other initializations:

```diff
 this.eventBus = eventBus;
+this.hookQueue = this.createHookQueue();
```

### 5.4 Add non-blocking hook runner helper (~line 210)

```typescript
/**
 * Run a hook handler without blocking the orchestrator loop.
 */
private runHookHandler(handler: () => Promise<void>, hookType: string, workItemId: string): void {
  const timeoutMs = this.config.hookTimeoutMs;
  void (async () => {
    const start = Date.now();
    this.emit(createEvent('hook_call', {
      hookType,
      phase: 'starting',
    }, workItemId));
    try {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('hook_timeout'));
        }, timeoutMs);
      });
      await Promise.race([handler(), timeout]);
      if (timer) clearTimeout(timer);
      this.emit(createEvent('hook_call', {
        hookType,
        phase: 'completed',
        success: true,
        durationMs: Date.now() - start,
      }, workItemId));
    } catch (err) {
      this.emit(createEvent('hook_call', {
        hookType,
        phase: 'completed',
        success: false,
        error: String(err),
        durationMs: Date.now() - start,
      }, workItemId));
      console.error(`[HOOK:${hookType}] Handler error:`, err);
    }
  })();
}
```

### 5.5 Modify execution loop to handle hook work items (~line 351)

```diff
 // AGENT EXECUTION - run all in-progress items in parallel
 const executions = Array.from(inProgress.entries()).map(async ([workId, { item, agent }]) => {
+  // Internal hook items: execute handler directly, no agent
+  if (item.params?.isInternalHook && typeof item.params.handler === 'function') {
+    this.runHookHandler(item.params.handler, String(item.params.hookType), workId);
+    // Return synthetic success result
+    return {
+      workId,
+      item,
+      result: {
+        success: true,
+        response: '',
+        metrics: { llmCallsMade: 0, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
+        filesRead: [],
+        invalidatedPaths: [],
+        toolErrors: [],
+        terminationReason: 'hook_completed',
+        needsUserInput: false,
+        isRefusal: false,
+        localContext: undefined,
+      } as AgentResult,
+    };
+  }
+
   const result = await agent.run({ globalContext: context, workItem: item, cwd });
   return { workId, item, result };
 });
```

### 5.6 Skip agent creation for hook items (~line 244)

```diff
 // Create agents for new ready items
 for (const item of readyItems) {
+  // Skip agent creation for internal hooks
+  if (item.params?.isInternalHook) {
+    inProgress.set(item.workId, { item, agent: null as unknown as Agent });
+    continue;
+  }
+
   const agent = this.createAgent(item.agent);
```

### 5.7 Skip result merging/termination logic for internal hooks (~line 360)

```diff
 for (const { workId, item, result } of results) {
+  if (item.params?.isInternalHook) {
+    this.completedWork.set(workId, result);
+    inProgress.delete(workId);
+    continue; // Skip metrics/context merge and terminal condition checks
+  }
+
   totalLlmCalls += result.metrics.llmCallsMade;
   totalToolCalls += result.metrics.toolCallsMade;

   // Merge token metrics
   const localMetrics = result.localContext.metrics;
   context.updateMetrics(localMetrics.inputTokens, localMetrics.outputTokens);
```

### 5.8 Pass hookQueue to createAgent (~line 578)

```diff
 return new Agent(config, {
   llm: this.llm,
   toolRegistry: this.toolRegistry,
   emit: this.emit,
   requestId: this.requestId,
   agentRegistry: this.agentRegistry,
   llmConfig: runtime.llm,
   hooks: this.hooks,
+  internalHookQueue: this.hookQueue,
 });
```

### 5.9 Add hook_call event type (`packages/types/src/events.ts`)

```diff
 export type AgentCoreEventType =
   | 'tool_call'
+  | 'hook_call'
   | 'llm_call'
   | 'llm_error'
   | 'rate_limit'
   | 'agent_bounds_hit'
   | 'agent_message'
   | 'artifact_discovered'
   | 'agent_progress';
```

```typescript
/**
 * Phase of a hook call event.
 */
export type HookCallPhase = 'starting' | 'completed';

/**
 * Data for hook_call event.
 */
export interface HookCallData {
  hookType: string;
  phase: HookCallPhase;
  success?: boolean;
  error?: string;
  durationMs?: number;
}
```

### 5.10 Add hook_call schema (`packages/types/src/event_schemas.ts`)

```diff
 export const AgentCoreEventTypeSchema = z.enum([
   'tool_call',
+  'hook_call',
   'llm_call',
   'llm_error',
   'agent_bounds_hit',
 ]);
```

```typescript
/**
 * Hook call phase.
 */
export const HookCallPhaseSchema = z.enum(['starting', 'completed']);

/**
 * Data for hook_call events.
 */
export const HookCallDataSchema = z.object({
  hookType: z.string(),
  phase: HookCallPhaseSchema,
  success: z.boolean().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
});
```

```typescript
/**
 * Hook call event.
 */
export const HookCallEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('hook_call'),
  data: HookCallDataSchema,
});
```

```diff
 export const AgentEventSchema = z.discriminatedUnion('type', [
   ToolCallEventSchema,
+  HookCallEventSchema,
   LLMCallEventSchema,
   LLMErrorEventSchema,
   AgentBoundsHitEventSchema,
   OrchestrationStartedEventSchema,
```

```typescript
export type HookCallPhase = z.infer<typeof HookCallPhaseSchema>;
export type HookCallData = z.infer<typeof HookCallDataSchema>;
export type HookCallEvent = z.infer<typeof HookCallEventSchema>;
```

---

## 6. Export Updates

### `packages/agent/src/index.ts`

```diff
 export type {
   AgentConfig,
   AgentRunParams,
   AgentResult,
   AgentMetrics,
   AgentBudget,
   EventEmitCallback,
   UserPromptInfo,
   AgentHooks,
   ToolHookResult,
   AgentRuntimeConfig,
+  InternalHookEvent,
+  InternalHookContext,
+  InternalHookHandler,
+  InternalHookQueue,
 } from './types.js';
-export { noopEmit, DEFAULT_AGENT_BUDGET } from './types.js';
+export { noopEmit, noopHookQueue, DEFAULT_AGENT_BUDGET } from './types.js';
```

### `packages/orchestrator/src/index.ts`

```diff
 export { Orchestrator } from './orchestrator.js';
 export type { OrchestratorConfig, OrchestratorResult, OrchestratorMetrics, TerminationReason } from './orchestrator.js';
+export { registerHook, getHandlers, HOOK_REGISTRY } from './hooks/index.js';
```

---

## 7. Code to Remove

**None.** This is purely additive. Sync hooks (`AgentHooks`) remain unchanged.

---

## 8. Summary

```
Agent emits event
       ↓
InternalHookQueue.enqueue()
       ↓
Creates WorkItem with handler closure
       ↓
workQueue.push() (existing queue)
       ↓
dequeueAllReady() picks it up
       ↓
Orchestrator checks isInternalHook
       ↓
Executes handler() directly (no LLM)
       ↓
Handler runs (plain async function)
```

**Key properties:**

| Property | Value |
|----------|-------|
| New queues | 0 (uses existing `workQueue`) |
| LLM calls for hooks | 0 (plain functions) |
| Blocking | Best-effort: hook handlers run in background; agent does not await |
| Dependencies | Supported (via existing WorkItem.dependencies) |
| Handler location | `packages/orchestrator/src/hooks/` |
| Hook events | `hook_call` (starting/completed) |
| Registration | Static registry + `registerHook()` for runtime |

**Lines changed**: ~300 new, 0 removed
**Risk**: Medium - needs careful handling to avoid context/metrics duplication and termination interference
