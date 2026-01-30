# Control Plane Design

## Overview

This document defines the architecture for a unified state management and hook system using discriminated unions. The goal is to make state first-class, compiler-checked, and extensible while eliminating scattered type definitions and uncontrolled hook side effects.

**Key Principles:**
1. **Discriminated unions everywhere** - Exhaustive handling enforced by TypeScript
2. **Single writer** - All state mutations go through patches, applied by orchestrator
3. **Unified hooks** - One hook system with policies, not two separate systems
4. **Explicit effects** - Hooks declare outcomes, orchestrator decides what to do

---

## Package Structure

```
packages/control-plane/
├── protocol/
│   ├── schemas.ts              # Zod schemas for LLM output validation
│   ├── prompts.ts              # Generated prompt snippets from schemas
│   └── version.ts              # Schema version hash for compatibility
│
├── domain/
│   ├── termination.ts          # TerminationReason discriminated union
│   ├── events.ts               # All event types (discriminated union)
│   ├── state.ts                # Core state interfaces
│   └── index.ts                # Re-exports
│
├── control/
│   ├── decisions.ts            # All decision discriminated unions
│   ├── gates.ts                # Quality gates, policy gates
│   ├── reducers.ts             # State reducers (patch application)
│   └── index.ts
│
├── effects/
│   ├── patches.ts              # StatePatch discriminated union
│   ├── commands.ts             # Command types (no IO implementation)
│   └── index.ts
│
├── hooks/
│   ├── outcome.ts              # HookOutcome<D> discriminated union
│   ├── policy.ts               # HookPolicy discriminated union
│   ├── registry.ts             # Hook registration types
│   ├── executor.ts             # Hook execution engine types
│   └── index.ts
│
└── index.ts                    # Package entry point
```

---

## Layer 1: HookOutcome (Execution Status)

Discriminates **how the hook execution went**.

```typescript
// packages/control-plane/hooks/outcome.ts

/**
 * The result of executing a hook.
 *
 * @typeParam D - The domain-specific decision type (must be a discriminated union)
 */
export type HookOutcome<D> =
  | { kind: 'success'; decision: D; patches?: StatePatch[] }
  | { kind: 'skip'; reason: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'retry'; error: string; backoffMs: number }
  | { kind: 'timeout' }
  | { kind: 'failed'; error: string };

/**
 * Type guard for successful outcomes.
 */
export function isSuccess<D>(outcome: HookOutcome<D>): outcome is { kind: 'success'; decision: D; patches?: StatePatch[] } {
  return outcome.kind === 'success';
}

/**
 * Type guard for outcomes that should trigger retry.
 */
export function shouldRetry<D>(outcome: HookOutcome<D>): outcome is { kind: 'retry'; error: string; backoffMs: number } {
  return outcome.kind === 'retry';
}
```

---

## Layer 2: Decision Types (Domain-Specific)

Each hook trigger has its own decision discriminated union.

```typescript
// packages/control-plane/control/decisions.ts

// ============================================
// QUALITY GATE (goal_state_reached)
// ============================================

export type QualityGateDecision =
  | { verdict: 'passed' }
  | { verdict: 'failed'; issues: string[] }
  | { verdict: 'needs_human'; concerns: string[] };

// ============================================
// BOUNDS EXCEEDED (max_iterations, max_tool_calls, max_duration)
// ============================================

export type BoundsDecision =
  | { action: 'realign'; guidance: string }
  | { action: 'split'; workItems: WorkItemSpec[] }
  | { action: 'wrap_up'; summary: string }
  | { action: 'abort'; reason: string };

// ============================================
// PROMPT ANSWER (user_input_required)
// ============================================

export type PromptAnswerDecision =
  | { action: 'answer'; text: string; confidence: number }
  | { action: 'escalate'; reason: string }
  | { action: 'defer'; to: 'user' | 'ops' };

// ============================================
// CADENCE AUDIT (periodic check)
// ============================================

export type CadenceDecision =
  | { action: 'continue' }
  | { action: 'inject_guidance'; message: string }
  | { action: 'realign'; guidance: string; newWork?: WorkItemSpec }
  | { action: 'split'; workItems: WorkItemSpec[] }
  | { action: 'stop'; reason: string };

// ============================================
// AGENT ERROR (exception, error)
// ============================================

export type AgentErrorDecision =
  | { action: 'retry'; guidance: string }
  | { action: 'abort'; reason: string }
  | { action: 'escalate'; to: 'user' | 'ops' };

// ============================================
// HANDOFF APPROVAL (planner handoff)
// ============================================

export type HandoffDecision =
  | { action: 'approve' }
  | { action: 'reject'; feedback: string }
  | { action: 'modify'; changes: string };

// ============================================
// UNION OF ALL DECISIONS
// ============================================

export type AnyDecision =
  | QualityGateDecision
  | BoundsDecision
  | PromptAnswerDecision
  | CadenceDecision
  | AgentErrorDecision
  | HandoffDecision;
```

---

## Layer 3: StatePatch (State Modifications)

Discriminates **what state changes the hook requests**.

```typescript
// packages/control-plane/effects/patches.ts

/**
 * A single state modification request.
 * Hooks return patches; the orchestrator (single writer) applies them.
 */
export type StatePatch =
  // Work queue operations
  | { op: 'enqueue_work'; items: WorkItemSpec[]; position?: 'front' | 'back' }
  | { op: 'cancel_work'; workIds: string[]; reason: string }

  // Context operations
  | { op: 'inject_message'; role: 'system' | 'user'; content: string }
  | { op: 'inject_guidance'; content: string }

  // Counter operations
  | { op: 'reset_counter'; counter: 'realign' | 'iteration' | 'tool_calls' }
  | { op: 'increment_counter'; counter: 'realign' }

  // Termination operations
  | { op: 'set_termination'; reason: TerminationReason }
  | { op: 'clear_termination' }
  | { op: 'force_continue' }

  // Metadata operations
  | { op: 'set_metadata'; key: string; value: unknown }
  | { op: 'append_audit_log'; entry: AuditLogEntry };

/**
 * Validate a patch is well-formed.
 */
export function validatePatch(patch: StatePatch): { valid: boolean; error?: string } {
  switch (patch.op) {
    case 'enqueue_work':
      if (!patch.items.length) return { valid: false, error: 'enqueue_work requires at least one item' };
      return { valid: true };
    case 'inject_message':
      if (!patch.content.trim()) return { valid: false, error: 'inject_message requires non-empty content' };
      return { valid: true };
    // ... exhaustive validation
    default:
      const _exhaustive: never = patch;
      return { valid: false, error: `Unknown patch op: ${(patch as any).op}` };
  }
}
```

---

## Hook Policy

Discriminates **how failures are handled**.

```typescript
// packages/control-plane/hooks/policy.ts

export type HookPolicy =
  | { kind: 'fire_and_forget' }
  | { kind: 'retry_then_degrade'; maxRetries: number; backoffMs: number }
  | { kind: 'retry_then_abort'; maxRetries: number; backoffMs: number }
  | { kind: 'fail_closed' }
  | { kind: 'escalate'; to: 'user' | 'ops'; fallback?: HookPolicy };

/**
 * Default policies by hook category.
 */
export const DEFAULT_POLICIES: Record<string, HookPolicy> = {
  'quality_gate': { kind: 'fail_closed' },
  'bounds_exceeded': { kind: 'retry_then_degrade', maxRetries: 2, backoffMs: 1000 },
  'prompt_answer': { kind: 'escalate', to: 'user' },
  'cadence_audit': { kind: 'fire_and_forget' },
  'agent_error': { kind: 'retry_then_abort', maxRetries: 1, backoffMs: 500 },
  'handoff_approval': { kind: 'fail_closed' },
  'telemetry': { kind: 'fire_and_forget' },
};
```

---

## Hook Registration

```typescript
// packages/control-plane/hooks/registry.ts

/**
 * A registered hook with full type safety.
 */
export interface Hook<Evt extends ControlEvent, D> {
  /** Unique identifier for this hook */
  id: string;

  /** The event type this hook handles */
  event: Evt['type'];

  /** Failure handling policy */
  policy: HookPolicy;

  /** Execution priority (lower = earlier). Hooks with same priority run in parallel. */
  priority: number;

  /** Timeout for this hook in milliseconds */
  timeoutMs: number;

  /** The hook implementation */
  run: (evt: Evt, ctx: Readonly<HookContext>) => Promise<HookOutcome<D>>;
}

/**
 * Context provided to hooks (read-only view of state).
 */
export interface HookContext {
  readonly sessionKey: string;
  readonly workId: string;
  readonly agentType: string;
  readonly iteration: number;
  readonly metrics: Readonly<ExecutionMetrics>;
  readonly recentMessages: ReadonlyArray<Message>;
  readonly filesModified: ReadonlyArray<string>;
}

/**
 * Hook registry for managing registered hooks.
 */
export interface HookRegistry {
  register<Evt extends ControlEvent, D>(hook: Hook<Evt, D>): void;
  unregister(hookId: string): void;
  getHooks<Evt extends ControlEvent>(eventType: Evt['type']): Hook<Evt, unknown>[];
  clear(): void;
}
```

---

## Event Types (Triggers)

```typescript
// packages/control-plane/domain/events.ts

/**
 * Base event interface.
 */
interface BaseEvent {
  type: string;
  timestamp: number;
  sessionKey: string;
  workId: string;
}

/**
 * All control plane events (discriminated union).
 */
export type ControlEvent =
  | GoalReachedEvent
  | BoundsExceededEvent
  | UserInputRequiredEvent
  | CadenceAuditEvent
  | AgentErrorEvent
  | HandoffRequestedEvent
  | UserStoppedEvent
  | TransientErrorEvent;

// ============================================
// EVENT DEFINITIONS
// ============================================

export interface GoalReachedEvent extends BaseEvent {
  type: 'goal_state_reached';
  response: string;
  filesModified: string[];
  metrics: ExecutionMetrics;
  artifacts?: Artifact[];
}

export interface BoundsExceededEvent extends BaseEvent {
  type: 'bounds_exceeded';
  boundType: 'iterations' | 'tool_calls' | 'duration';
  limit: number;
  current: number;
  response: string;
}

export interface UserInputRequiredEvent extends BaseEvent {
  type: 'user_input_required';
  prompt: {
    question: string;
    options?: PromptOption[];
    context?: string;
    multiSelect: boolean;
  };
}

export interface CadenceAuditEvent extends BaseEvent {
  type: 'cadence_audit';
  elapsedMs: number;
  toolCallsSinceLastAudit: number;
  metrics: ExecutionMetrics;
  recentActivity: string;
}

export interface AgentErrorEvent extends BaseEvent {
  type: 'agent_error';
  errorType: 'exception' | 'invalid_action' | 'no_action' | 'stagnation';
  error: string;
  stack?: string;
}

export interface HandoffRequestedEvent extends BaseEvent {
  type: 'handoff_requested';
  handoffSpec: HandoffSpec;
  plannerResponse: string;
}

export interface UserStoppedEvent extends BaseEvent {
  type: 'user_stopped';
}

export interface TransientErrorEvent extends BaseEvent {
  type: 'transient_error';
  errorType: 'rate_limit' | 'circuit_open' | 'timeout';
  retryAfterMs?: number;
}

// ============================================
// TYPE GUARDS
// ============================================

export function isGoalReached(evt: ControlEvent): evt is GoalReachedEvent {
  return evt.type === 'goal_state_reached';
}

export function isBoundsExceeded(evt: ControlEvent): evt is BoundsExceededEvent {
  return evt.type === 'bounds_exceeded';
}

// ... guards for all event types
```

---

## Termination Reasons

```typescript
// packages/control-plane/domain/termination.ts

/**
 * All possible reasons for agent/orchestrator termination.
 * Single source of truth - all other code imports from here.
 */
export type TerminationReason =
  // Success
  | 'goal_state_reached'

  // User interaction
  | 'user_input_required'
  | 'handoff_requested'
  | 'user_stopped'

  // Bounds exceeded
  | 'max_iterations_exceeded'
  | 'max_tool_calls_exceeded'
  | 'max_duration_exceeded'

  // Transient errors
  | 'rate_limit'
  | 'circuit_open'
  | 'timeout'

  // Agent errors
  | 'agent_error'
  | 'invalid_action'
  | 'no_action'
  | 'refusal'

  // Watcher intervention
  | 'watcher_stopped'
  | 'cadence_audit';

/**
 * Categorize termination reasons.
 */
export type TerminationCategory =
  | 'success'
  | 'user_interaction'
  | 'bounds'
  | 'transient'
  | 'agent_error'
  | 'watcher';

export function getTerminationCategory(reason: TerminationReason): TerminationCategory {
  switch (reason) {
    case 'goal_state_reached':
      return 'success';
    case 'user_input_required':
    case 'handoff_requested':
    case 'user_stopped':
      return 'user_interaction';
    case 'max_iterations_exceeded':
    case 'max_tool_calls_exceeded':
    case 'max_duration_exceeded':
      return 'bounds';
    case 'rate_limit':
    case 'circuit_open':
    case 'timeout':
      return 'transient';
    case 'agent_error':
    case 'invalid_action':
    case 'no_action':
    case 'refusal':
      return 'agent_error';
    case 'watcher_stopped':
    case 'cadence_audit':
      return 'watcher';
    default:
      const _exhaustive: never = reason;
      throw new Error(`Unknown termination reason: ${reason}`);
  }
}

/**
 * Is this termination reason blockable by a hook?
 */
export function isBlockable(reason: TerminationReason): boolean {
  switch (reason) {
    case 'goal_state_reached':
    case 'max_iterations_exceeded':
    case 'max_tool_calls_exceeded':
    case 'max_duration_exceeded':
    case 'user_input_required':
    case 'handoff_requested':
    case 'agent_error':
    case 'cadence_audit':
      return true;
    case 'user_stopped':
    case 'rate_limit':
    case 'circuit_open':
    case 'timeout':
    case 'invalid_action':
    case 'no_action':
    case 'refusal':
    case 'watcher_stopped':
      return false;
    default:
      const _exhaustive: never = reason;
      return false;
  }
}
```

---

## Hook Executor

```typescript
// packages/control-plane/hooks/executor.ts

/**
 * Result of executing all hooks for an event.
 */
export interface HookExecutionResult<D> {
  /** The winning decision (from highest priority successful hook) */
  decision: D | null;

  /** All patches to apply (merged from all successful hooks) */
  patches: StatePatch[];

  /** Hooks that failed and how */
  failures: Array<{
    hookId: string;
    outcome: HookOutcome<never>;
  }>;

  /** Whether any critical hook failed */
  hasCriticalFailure: boolean;

  /** Audit trail of all hook executions */
  audit: HookAuditEntry[];
}

export interface HookAuditEntry {
  hookId: string;
  priority: number;
  startedAt: number;
  completedAt: number;
  outcome: HookOutcome<unknown>;
  policyApplied?: string;
}

/**
 * Execute hooks for an event with proper ordering and policy handling.
 */
export interface HookExecutor {
  execute<Evt extends ControlEvent, D>(
    event: Evt,
    ctx: HookContext,
    registry: HookRegistry
  ): Promise<HookExecutionResult<D>>;
}
```

---

## State Reducer (Single Writer)

```typescript
// packages/control-plane/control/reducers.ts

/**
 * The orchestrator state that can be modified via patches.
 */
export interface OrchestratorState {
  workQueue: WorkItem[];
  completedWork: Map<string, WorkResult>;
  context: ContextWindow;
  realignCount: number;
  terminationReason: TerminationReason | null;
  metadata: Map<string, unknown>;
  auditLog: AuditLogEntry[];
}

/**
 * Apply a batch of patches to state.
 * This is the ONLY place state is mutated.
 */
export function applyPatches(
  state: OrchestratorState,
  patches: StatePatch[]
): { state: OrchestratorState; applied: StatePatch[]; rejected: Array<{ patch: StatePatch; reason: string }> } {
  const applied: StatePatch[] = [];
  const rejected: Array<{ patch: StatePatch; reason: string }> = [];

  for (const patch of patches) {
    const validation = validatePatch(patch);
    if (!validation.valid) {
      rejected.push({ patch, reason: validation.error! });
      continue;
    }

    switch (patch.op) {
      case 'enqueue_work':
        if (patch.position === 'front') {
          state.workQueue.unshift(...patch.items.map(createWorkItem));
        } else {
          state.workQueue.push(...patch.items.map(createWorkItem));
        }
        applied.push(patch);
        break;

      case 'cancel_work':
        state.workQueue = state.workQueue.filter(w => !patch.workIds.includes(w.workId));
        applied.push(patch);
        break;

      case 'inject_message':
        state.context.addMessage(patch.role, patch.content);
        applied.push(patch);
        break;

      case 'inject_guidance':
        state.context.addMessage('system', patch.content);
        applied.push(patch);
        break;

      case 'reset_counter':
        switch (patch.counter) {
          case 'realign':
            state.realignCount = 0;
            break;
          // ... other counters
        }
        applied.push(patch);
        break;

      case 'increment_counter':
        switch (patch.counter) {
          case 'realign':
            state.realignCount++;
            break;
        }
        applied.push(patch);
        break;

      case 'set_termination':
        state.terminationReason = patch.reason;
        applied.push(patch);
        break;

      case 'clear_termination':
        state.terminationReason = null;
        applied.push(patch);
        break;

      case 'force_continue':
        state.terminationReason = null;
        applied.push(patch);
        break;

      case 'set_metadata':
        state.metadata.set(patch.key, patch.value);
        applied.push(patch);
        break;

      case 'append_audit_log':
        state.auditLog.push(patch.entry);
        applied.push(patch);
        break;

      default:
        const _exhaustive: never = patch;
        rejected.push({ patch, reason: `Unknown op: ${(patch as any).op}` });
    }
  }

  return { state, applied, rejected };
}
```

---

## Event → Decision → Handler Mapping

```typescript
// packages/control-plane/control/gates.ts

/**
 * Maps event types to their decision types.
 * Used for type-safe hook registration.
 */
export interface EventDecisionMap {
  'goal_state_reached': QualityGateDecision;
  'bounds_exceeded': BoundsDecision;
  'user_input_required': PromptAnswerDecision;
  'cadence_audit': CadenceDecision;
  'agent_error': AgentErrorDecision;
  'handoff_requested': HandoffDecision;
  'user_stopped': never;  // No decision, always allow
  'transient_error': never;  // No decision, always allow
}

/**
 * Type-safe hook registration that ensures decision type matches event type.
 */
export function createHook<E extends keyof EventDecisionMap>(
  event: E,
  config: Omit<Hook<ControlEvent & { type: E }, EventDecisionMap[E]>, 'event'>
): Hook<ControlEvent & { type: E }, EventDecisionMap[E]> {
  return { ...config, event };
}
```

---

## Full Example: Quality Gate Hook

```typescript
// Example implementation

import { createHook } from 'control-plane/control/gates';
import { HookOutcome } from 'control-plane/hooks/outcome';
import { QualityGateDecision } from 'control-plane/control/decisions';
import { GoalReachedEvent } from 'control-plane/domain/events';

const qualityGateHook = createHook('goal_state_reached', {
  id: 'watcher.quality_gate.default',
  policy: { kind: 'fail_closed' },
  priority: 10,
  timeoutMs: 30_000,

  async run(evt: GoalReachedEvent, ctx): Promise<HookOutcome<QualityGateDecision>> {
    // Validation logic
    const issues: string[] = [];

    if (evt.response.includes('TODO')) {
      issues.push('Response contains TODO markers');
    }

    if (evt.filesModified.length === 0 && evt.response.length < 100) {
      issues.push('No files modified and response is suspiciously short');
    }

    if (issues.length > 0) {
      return {
        kind: 'success',
        decision: { verdict: 'failed', issues },
        patches: [
          { op: 'inject_message', role: 'user', content: `Quality issues found:\n${issues.join('\n')}\n\nPlease address these.` },
          { op: 'force_continue' }
        ]
      };
    }

    return {
      kind: 'success',
      decision: { verdict: 'passed' }
    };
  }
});
```

---

## Orchestrator Integration

```typescript
// How the orchestrator uses the hook system

class Orchestrator {
  private hookRegistry: HookRegistry;
  private hookExecutor: HookExecutor;
  private state: OrchestratorState;

  async handleTermination(event: ControlEvent): Promise<boolean> {
    // 1. Execute all hooks for this event
    const result = await this.hookExecutor.execute(
      event,
      this.buildHookContext(),
      this.hookRegistry
    );

    // 2. Check for critical failures
    if (result.hasCriticalFailure) {
      this.log('error', 'Critical hook failure', { failures: result.failures });
      // Apply fail_closed policy - abort
      return false;
    }

    // 3. Apply all patches through single writer
    const { applied, rejected } = applyPatches(this.state, result.patches);

    if (rejected.length > 0) {
      this.log('warning', 'Some patches rejected', { rejected });
    }

    // 4. Handle the decision
    if (result.decision) {
      return this.handleDecision(event.type, result.decision);
    }

    // 5. No decision = allow termination
    return false;
  }

  private handleDecision(eventType: string, decision: AnyDecision): boolean {
    // Exhaustive handling based on event type and decision
    switch (eventType) {
      case 'goal_state_reached':
        return this.handleQualityGateDecision(decision as QualityGateDecision);
      case 'bounds_exceeded':
        return this.handleBoundsDecision(decision as BoundsDecision);
      // ... all event types
    }
  }

  private handleQualityGateDecision(decision: QualityGateDecision): boolean {
    switch (decision.verdict) {
      case 'passed':
        return false; // Allow termination (success)
      case 'failed':
        return true;  // Continue (patches already applied)
      case 'needs_human':
        this.escalateToUser(decision.concerns);
        return false; // Pause for human
      default:
        const _exhaustive: never = decision;
        return false;
    }
  }
}
```

---

## Migration Plan

### Phase 1: Create `packages/control-plane/`
1. Create directory structure
2. Implement all type definitions
3. Implement hook registry and executor
4. Implement state reducer
5. Add comprehensive tests

### Phase 2: Migrate Types
1. Update `packages/shared/src/termination.ts` to re-export from control-plane
2. Update `packages/agent/src/types.ts` to re-export from control-plane
3. Update `packages/decision-watcher/src/types.ts` to use control-plane types
4. Update `config/output_schemas.json` to use generated schemas

### Phase 3: Migrate Hooks
1. Convert existing `registerHook` calls to new system
2. Convert `StopHookHandler` to new `Hook<Evt, D>` pattern
3. Update orchestrator to use hook executor
4. Update harness to use new registration

### Phase 4: Migrate State Mutations
1. Identify all direct state mutations in orchestrator
2. Convert to patch-based mutations
3. Route all mutations through `applyPatches`
4. Add audit logging

### Phase 5: Delete Old Code
1. Remove old hook system in `packages/orchestrator/src/hooks.ts`
2. Remove scattered type definitions
3. Remove duplicate schemas
4. Update all imports

---

## Files to Create

```
packages/control-plane/
├── package.json
├── tsconfig.json
├── src/
│   ├── protocol/
│   │   ├── schemas.ts
│   │   ├── prompts.ts
│   │   └── version.ts
│   ├── domain/
│   │   ├── termination.ts
│   │   ├── events.ts
│   │   ├── state.ts
│   │   └── index.ts
│   ├── control/
│   │   ├── decisions.ts
│   │   ├── gates.ts
│   │   ├── reducers.ts
│   │   └── index.ts
│   ├── effects/
│   │   ├── patches.ts
│   │   ├── commands.ts
│   │   └── index.ts
│   ├── hooks/
│   │   ├── outcome.ts
│   │   ├── policy.ts
│   │   ├── registry.ts
│   │   ├── executor.ts
│   │   └── index.ts
│   └── index.ts
└── tests/
    ├── outcome.test.ts
    ├── patches.test.ts
    ├── reducers.test.ts
    ├── executor.test.ts
    └── integration.test.ts
```

## Files to Modify

| File | Change |
|------|--------|
| `packages/shared/src/termination.ts` | Re-export from control-plane |
| `packages/shared/src/output_schemas.ts` | Import schemas from control-plane |
| `packages/agent/src/types.ts` | Remove StopHookResult, InternalHookEvent; re-export from control-plane |
| `packages/orchestrator/src/orchestrator.ts` | Use hook executor, patch-based mutations |
| `packages/orchestrator/src/hooks.ts` | DELETE (replaced by control-plane) |
| `packages/decision-watcher/src/types.ts` | Use control-plane decisions, remove WatcherAction |
| `packages/decision-watcher/src/watcher-agent.ts` | Convert to new hook pattern |
| `packages/harness-daemon/src/harness/harness.ts` | Use new hook registration |
| `config/output_schemas.json` | Generate from control-plane schemas |

## Files to Delete

| File | Reason |
|------|--------|
| `packages/orchestrator/src/hooks.ts` | Replaced by control-plane/hooks |
| Duplicate type definitions | Consolidated in control-plane |

---

## Compile-Time Guarantees

| Guarantee | How |
|-----------|-----|
| Exhaustive event handling | `ControlEvent` discriminated union + switch exhaustiveness |
| Exhaustive decision handling | Per-event decision unions + switch exhaustiveness |
| Exhaustive patch handling | `StatePatch` discriminated union + switch exhaustiveness |
| Exhaustive outcome handling | `HookOutcome<D>` discriminated union + switch exhaustiveness |
| Type-safe hook registration | `EventDecisionMap` ensures decision type matches event type |
| Required fields by discriminant | Each union variant has required fields |
| Single writer enforcement | All mutations go through `applyPatches` |

## Runtime Guarantees

| Guarantee | How |
|-----------|-----|
| Hook timeout enforcement | Executor wraps with `Promise.race` |
| Policy enforcement | Executor applies policy on failure |
| Patch validation | `validatePatch` before application |
| Audit trail | Every hook execution logged |
| Priority ordering | Executor sorts by priority before execution |

---

## Open Questions

1. **Schema versioning**: How should we version the LLM output schemas? Hash? Semver?
2. **Hook hot-reload**: Should hooks be hot-reloadable at runtime?
3. **Cross-session hooks**: Can hooks be registered globally vs per-session?
4. **Patch conflict resolution**: What if two hooks return conflicting patches?

---

*Last updated: 2026-01-29*
