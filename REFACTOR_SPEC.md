# Refactoring Patch Specification

## 1. Consolidate Session State (harness.ts)

**Problem**: 8 separate Maps tracking per-session data.

**Patch**:
```typescript
// packages/harness-daemon/src/harness/session_state.ts
interface SessionState {
  store: SessionStore;
  lastAccessMs: number;
  decisionDatabase?: DecisionDatabase;
  watcherEngine?: DecisionEngine;
  workLog?: WorkLog;
  workItemLogs: Map<string, WorkItemLog>;
  workItemsCreated: Set<string>;
  watcherContext?: ContextWindow;
  hookRegistry?: HookRegistry;
}

// Replace in AgentHarness:
- private sessionStores = new Map<string, { store: SessionStore; lastAccessMs: number }>();
- private decisionDatabases = new Map<string, DecisionDatabase>();
- private watcherEngines = new Map<string, DecisionEngine>();
- private sessionWorkLogs = new Map<string, WorkLog>();
- private workItemLogs = new Map<string, WorkItemLog>();
- private workItemCreated = new Set<string>();
- private watcherContexts = new Map<string, ContextWindow>();
- private watcherHookRegistries = new Map<string, HookRegistry>();
+ private sessions = new Map<string, SessionState>();
```

**Files**: `harness.ts`, new `session_state.ts`

---

## 2. Orchestrator Execution State Object

**Problem**: 10+ variables tracked across instance + local scope in `executeInner`.

**Patch**:
```typescript
// packages/orchestrator/src/execution_state.ts
interface ExecutionState {
  iteration: number;
  totalLlmCalls: number;
  totalToolCalls: number;
  startTime: number;
  initialWorkId: string;
  initialWorkCompleted: boolean;
  initialWorkResponse: string;
  initialWorkResult?: AgentResult;
  compactedRecently: boolean;
  lastCadenceAuditMs: number;
  lastCadenceAuditToolCalls: number;
  lastAgentResult?: AgentResult;
  lastAgentWorkId?: string;
  inProgress: Map<string, { item: WorkItem; agent: Agent | null }>;
}

function createExecutionState(initialWorkId: string): ExecutionState { ... }
```

Extract from `executeInner`:
- `checkTerminationConditions` → standalone function taking `ExecutionState`
- `processSingleIteration` → standalone function
- `handleCadenceAudit` → standalone function

**Files**: `orchestrator.ts`, new `execution_state.ts`

---

## 3. Fix ContextItem Discriminated Union (types)

**Problem**: `as any` casts throughout agent.ts due to weak typing.

**Patch**:
```typescript
// packages/types/src/index.ts
export type ContextItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'system' | 'developer'; content: string | ContentBlock[]; timestamp: number }
  | { type: 'function_call'; callId: string; name: string; arguments: Record<string, unknown>; timestamp: number }
  | { type: 'function_call_output'; callId: string; output: string; isError?: boolean; durationMs?: number; timestamp: number }
  | { type: 'file_content'; path: string; content: string; timestamp: number }
  | { type: 'artifact'; sourcePath: string; kind: ArtifactKind; name: string; /* ... */ timestamp: number }
  | { type: 'reasoning'; content: string; timestamp: number };

// Type guards
export function isMessageItem(item: ContextItem): item is ContextItem & { type: 'message' } { ... }
export function isFunctionCallItem(item: ContextItem): item is ContextItem & { type: 'function_call' } { ... }
```

Then replace in agent.ts:
```typescript
- const callId = (item as any).call_id;
+ if (isFunctionCallOutputItem(item)) { const callId = item.callId; }
```

**Files**: `packages/types/src/index.ts`, `packages/agent/src/agent.ts`

---

## 4. Unify Recoverable Error Handling (harness.ts)

**Problem**: 4 near-identical catch blocks (lines 1249-1356).

**Patch**:
```typescript
// packages/harness-daemon/src/harness/error_handlers.ts
interface RecoverableErrorResult {
  userMessage: string;
  logLevel: 'warning' | 'error';
  logMeta: Record<string, unknown>;
}

function classifyRecoverableError(error: unknown, requestId: string): RecoverableErrorResult | null {
  if (RateLimitError.isRateLimitError(error)) {
    return { userMessage: buildRateLimitMessage(error), logLevel: 'warning', logMeta: { ... } };
  }
  if (error instanceof CircuitOpenError) { ... }
  if (error instanceof RetriesExhaustedError) { ... }
  return null; // Not recoverable
}

// In run() catch block:
const recoverable = classifyRecoverableError(error, requestId);
if (recoverable) {
  this.logger[recoverable.logLevel](recoverable.userMessage, recoverable.logMeta);
  store.persistContext();
  eventQueue.push(createErrorEvent(recoverable.userMessage, false));
  eventQueue.push(createStatusEvent('idle'));
  return { requestId, sessionKey, success: false, finalText: recoverable.userMessage, ... };
}
// Fall through to generic error handling
```

**Files**: `harness.ts`, new `error_handlers.ts`

---

## 5. Decision Mapper Registry (orchestrator.ts)

**Problem**: 7 separate `mapXXXDecisionToStopResult` methods + switch dispatch.

**Patch**:
```typescript
// packages/orchestrator/src/decision_mappers.ts
type DecisionMapper<D> = (decision: D) => StopHookResult;

const DECISION_MAPPERS: Record<ControlEventType, DecisionMapper<unknown>> = {
  goal_state_reached: (d: QualityGateDecision) => ({ ... }),
  bounds_exceeded: (d: BoundsDecision) => ({ ... }),
  user_input_required: (d: PromptAnswerDecision) => ({ ... }),
  cadence_audit: (d: CadenceDecision) => ({ ... }),
  agent_error: (d: AgentErrorDecision) => ({ ... }),
  handoff_requested: (d: HandoffDecision) => ({ ... }),
  work_item_completed: (d: WorkItemCompletedDecision) => ({ ... }),
};

// Replace switch in callStopHook:
- switch (event.type) {
-   case 'goal_state_reached': { ... }
-   case 'bounds_exceeded': { ... }
-   // 5 more cases
- }
+ const mapper = DECISION_MAPPERS[event.type];
+ if (!mapper) return null;
+ const hookResult = await this.runControlHooks(event, hookContext, context, runtime);
+ return this.resolveHookDecision(event.type, hookResult, mapper);
```

**Files**: `orchestrator.ts`, new `decision_mappers.ts`

---

## 6. Extract Tool Output Truncation (agent.ts)

**Problem**: Truncation logic duplicated twice.

**Patch**:
```typescript
// packages/agent/src/utils.ts
export function truncateToolOutput(output: string, toolName: string): string {
  const maxLen = getMaxOutputLength(toolName);
  if (output.length <= maxLen) return output;
  return `${output.slice(0, maxLen)}\n... [truncated ${output.length - maxLen} chars]`;
}

// Replace both occurrences in processToolCalls
```

**Files**: `agent.ts`, new `utils.ts` or inline in `constants.ts`

---

## 7. Move StopHookResult to Protocol (circular dep fix)

**Problem**: `import('agent').StopHookResult` dynamic import in orchestrator.

**Patch**:
```typescript
// packages/protocol/src/domain/hooks.ts
export interface StopHookResult {
  decision: 'allow' | 'block';
  reason?: string;
  systemMessage?: string;
  deferredWork?: DeferredWorkItem[];
}

// packages/agent/src/types.ts
- export interface StopHookResult { ... }
+ export type { StopHookResult } from 'protocol';

// packages/orchestrator/src/orchestrator.ts
- ): import('agent').StopHookResult {
+ ): StopHookResult {
```

**Files**: `protocol/src/domain/hooks.ts`, `agent/src/types.ts`, `orchestrator.ts`

---

## Execution Order

1. **#7** (StopHookResult) — unblocks clean imports
2. **#3** (ContextItem union) — unblocks type-safe iteration
3. **#6** (truncateToolOutput) — trivial extraction
4. **#4** (error handlers) — reduces harness.ts by ~100 lines
5. **#5** (decision mappers) — reduces orchestrator.ts by ~150 lines
6. **#2** (ExecutionState) — enables #1
7. **#1** (SessionState) — largest structural change, do last

---

## Non-Goals (Defer)

- Decomposing `executeInner`/`run`/`executeLoop` into smaller methods (requires #2 first)
- Extracting services from AgentHarness (SessionManager, WatcherService, etc.)
- Converting string literal control flow to discriminated unions
- Magic string constants
