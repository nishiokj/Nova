# Minimum Patch Spec

## Overview

This spec addresses two approved changes:
1. **WorkItem Event Type Explosion**: Reduce 4 event types to 1 unified event
2. **Reduce Agent Params**: Simplify Agent constructor with a singular config object

---

## Change 1: WorkItem Event Type Explosion

### Problem
Currently 4 separate event types for workitem lifecycle:
- `workitem_started`
- `workitem_completed`
- `workitem_failed`
- `workitem_skipped`

Each has separate Zod schemas, type definitions, and switch-case handling. This is unnecessary complexity.

### Solution
Replace with a single `workitem_status` event type with a `status` field.

### Schema Changes

#### Before (`../types/src/event_schemas.ts`):
```typescript
export const OrchestratorEventTypeSchema = z.enum([
  'orchestration_started',
  'iteration_started',
  'iteration_completed',
  'runtime_script_created',
  'workitem_started',      // ❌ Remove
  'workitem_completed',    // ❌ Remove
  'workitem_failed',       // ❌ Remove
  'workitem_skipped',      // ❌ Remove
  'goal_achieved',
  'goal_not_achieved',
]);

// ❌ Remove these 4 schemas:
export const WorkItemStartedDataSchema = z.object({...});
export const WorkItemCompletedDataSchema = z.object({...});
export const WorkItemFailedDataSchema = z.object({...});
export const WorkItemSkippedDataSchema = z.object({...});
```

#### After:
```typescript
export const OrchestratorEventTypeSchema = z.enum([
  'orchestration_started',
  'iteration_started',
  'iteration_completed',
  'runtime_script_created',
  'workitem_status',        // ✅ Add
  'goal_achieved',
  'goal_not_achieved',
]);

// ✅ Add unified schema:
export const WorkItemStatusSchema = z.enum(['started', 'completed', 'failed', 'skipped']);

export const WorkItemStatusDataSchema = z.object({
  workId: z.string(),
  objective: z.string(),
  delta: z.string().optional(),
  agent: z.string(),
  dependencies: z.array(z.string()),
  status: WorkItemStatusSchema,

  // Fields for 'completed' status
  response: z.string().optional(),
  metrics: WorkItemMetricsSchema.optional(),

  // Fields for 'failed' status
  error: z.string().optional(),
  toolErrors: z.array(z.string()).optional(),
  terminationReason: z.string().optional(),

  // Fields for 'skipped' status
  reason: z.string().optional(),
});

export const WorkItemStatusEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('workitem_status'),
  data: WorkItemStatusDataSchema,
});
```

#### Update Discriminated Union:
```typescript
export const AgentEventSchema = z.discriminatedUnion('type', [
  // ... other events
  WorkItemStatusEventSchema,  // ✅ Replace 4 schemas with 1
  // ...
]);
```

#### Update Type Definitions (`../types/src/events.ts`):
```typescript
export type OrchestratorEventType =
  | 'orchestration_started'
  | 'iteration_started'
  | 'iteration_completed'
  | 'runtime_script_created'
  | 'workitem_status'  // ✅ Replace 4 types
  | 'goal_achieved'
  | 'goal_not_achieved';

// ✅ Replace 4 interfaces with 1:
export interface WorkItemStatusData {
  workId: string;
  objective: string;
  delta?: string;
  agent: string;
  dependencies: string[];
  status: 'started' | 'completed' | 'failed' | 'skipped';

  // Optional fields based on status
  response?: string;
  metrics?: WorkItemMetrics;
  error?: string;
  toolErrors?: string[];
  terminationReason?: string;
  reason?: string;
}
```

### Emit Changes

#### Before (`../harness-daemon/src/harness/harness.ts`):
```typescript
// ❌ 4 separate emit calls
emit(createEvent('workitem_started', {
  workId: workItem.workId,
  objective: workItem.objective,
  delta: workItem.delta,
  agent: workItem.agent,
  dependencies: [...workItem.dependencies],
}, workItem.workId));

emit(createEvent('workitem_completed', {
  workId: workItem.workId,
  objective: workItem.objective,
  response: result.response,
  metrics: {
    llmCallsMade: result.metrics.llmCallsMade,
    toolCallsMade: result.metrics.toolCallsMade,
    durationMs: result.metrics.durationMs,
  },
}, workItem.workId));

emit(createEvent('workitem_failed', {
  workId: workItem.workId,
  objective: workItem.objective,
  error: result.error ?? 'Unknown error',
  toolErrors: result.toolErrors,
  terminationReason: result.terminationReason,
}, workItem.workId));

emit(createEvent('workitem_skipped', {
  workId: workItem.workId,
  objective: workItem.objective,
  reason: 'some reason',
}, workItem.workId));
```

#### After:
```typescript
// ✅ Single emit call with status field
emit(createEvent('workitem_status', {
  workId: workItem.workId,
  objective: workItem.objective,
  delta: workItem.delta,
  agent: workItem.agent,
  dependencies: [...workItem.dependencies],
  status: 'started',
}, workItem.workId));

emit(createEvent('workitem_status', {
  workId: workItem.workId,
  objective: workItem.objective,
  delta: workItem.delta,
  agent: workItem.agent,
  dependencies: [...workItem.dependencies],
  status: 'completed',
  response: result.response,
  metrics: {
    llmCallsMade: result.metrics.llmCallsMade,
    toolCallsMade: result.metrics.toolCallsMade,
    durationMs: result.metrics.durationMs,
  },
}, workItem.workId));

emit(createEvent('workitem_status', {
  workId: workItem.workId,
  objective: workItem.objective,
  delta: workItem.delta,
  agent: workItem.agent,
  dependencies: [...workItem.dependencies],
  status: 'failed',
  error: result.error ?? 'Unknown error',
  toolErrors: result.toolErrors,
  terminationReason: result.terminationReason,
}, workItem.workId));

emit(createEvent('workitem_status', {
  workId: workItem.workId,
  objective: workItem.objective,
  delta: workItem.delta,
  agent: workItem.agent,
  dependencies: [...workItem.dependencies],
  status: 'skipped',
  reason: 'some reason',
}, workItem.workId));
```

### Consumer Changes

#### Before (`../harness-daemon/src/harness/event_translator.ts`):
```typescript
// ❌ 4 separate case statements
case 'workitem_started': {
  const itemData = data as { objective?: string };
  return {
    type: 'progress',
    data: {
      request_id: requestId,
      message: itemData.objective ? `Starting: ${itemData.objective}` : 'Starting work item...',
      level: 'info',
      kind: 'work',
    }
  };
}

case 'workitem_completed': { /* ... */ }
case 'workitem_failed': { /* ... */ }
case 'workitem_skipped': { /* ... */ }
```

#### After:
```typescript
// ✅ Single case statement with status check
case 'workitem_status': {
  const itemData = data as {
    objective?: string;
    status: 'started' | 'completed' | 'failed' | 'skipped';
    response?: string;
    error?: string;
    reason?: string;
    durationMs?: number;
  };

  const { status, objective } = itemData;

  switch (status) {
    case 'started':
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message: objective ? `Starting: ${objective}` : 'Starting work item...',
          level: 'info',
          kind: 'work',
        }
      };

    case 'completed':
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message: objective ? `Completed: ${objective}` : 'Work item completed',
          level: 'success',
          kind: 'work',
          duration_ms: itemData.durationMs,
        }
      };

    case 'failed':
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message: `Failed: ${itemData.error || objective || 'work item failed'}`,
          level: 'error',
          kind: 'work',
        }
      };

    case 'skipped':
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message: `Skipped: ${itemData.reason || objective || 'work item skipped'}`,
          level: 'warning',
          kind: 'work',
        }
      };
  }
}
```

#### Dashboard Mapper (`../dashboard/src/lib/mappers.ts`):
```typescript
// ✅ Similar pattern - merge 4 cases into 1 with status check
case 'workitem_status': {
  const workId = (data.work_id as string) ?? (data.workId as string) ?? (e.work_item_id as string);
  const status = data.status as 'started' | 'completed' | 'failed' | 'skipped';

  if (workId) {
    const existing = workItemMap.get(workId);
    if (existing) {
      existing.status = status;
      existing.objective = (data.objective as string) ?? existing.objective;
      if (data.delta) existing.delta = data.delta as string;

      // Update status-specific fields
      if (status === 'completed') {
        const metrics = data.metrics as Record<string, unknown> | undefined;
        existing.durationMs = (metrics?.durationMs as number) ?? (metrics?.duration_ms as number);
      } else if (status === 'failed') {
        existing.error = (data.error as string) ?? (data.termination_reason as string);
      } else if (status === 'skipped') {
        existing.error = (data.reason as string) ?? (data.error as string);
      }
    } else {
      workItemMap.set(workId, {
        workId,
        goal: goalText || userInputHint || '',
        objective: (data.objective as string) ?? '',
        delta: (data.delta as string) ?? undefined,
        dependencies: (data.dependencies as string[]) ?? [],
        agent: (data.agent as AgentType) ?? 'standard',
        status,
      });
    }
  }

  if (state === 'queued' && status === 'started') {
    state = 'running';
  } else if (status === 'failed') {
    state = 'error';
    errorMessage = (data.error as string) ?? (data.termination_reason as string);
  }

  break;
}
```

### Files to Modify

1. **`../types/src/event_schemas.ts`**
   - Remove `workitem_started`, `workitem_completed`, `workitem_failed`, `workitem_skipped` from enum
   - Add `workitem_status` to enum
   - Remove 4 data schemas
   - Add `WorkItemStatusSchema` and `WorkItemStatusDataSchema`
   - Update discriminated union

2. **`../types/src/events.ts`**
   - Update `OrchestratorEventType` type
   - Remove 4 data interfaces
   - Add `WorkItemStatusData` interface

3. **`../harness-daemon/src/harness/harness.ts`**
   - Update all `createEvent('workitem_*', ...)` calls to use `workitem_status`

4. **`../harness-daemon/src/harness/event_translator.ts`**
   - Merge 4 case statements into 1 with status switch

5. **`../dashboard/src/lib/mappers.ts`**
   - Merge 4 case statements into 1 with status switch

---

## Change 2: Reduce Agent Params - Singular Config Object

### Problem
Agent constructor has 8 parameters:
```typescript
constructor(
  config: AgentConfig,
  llm: LLMAdapter,
  toolRegistry: ToolRegistry,
  emit: EventEmitCallback = noopEmit,
  requestId: string = '',
  agentRegistry?: AgentRegistry,
  llmConfig?: LLMRequestConfig,
  hooks?: AgentHooks
)
```

This is hard to read and error-prone. Linus would call this "API bloat."

### Solution
Create a singular `AgentRuntimeConfig` object that groups runtime dependencies.

### New Type Definition (`../agent/src/types.ts`):
```typescript
/**
 * Runtime configuration for Agent.
 * Groups all runtime dependencies into a single object.
 */
export interface AgentRuntimeConfig {
  /** LLM adapter for inference */
  llm: LLMAdapter;
  /** Tool registry for tool execution */
  toolRegistry: ToolRegistry;
  /** Event emit callback */
  emit: EventEmitCallback;
  /** Request ID for correlation */
  requestId: string;
  /** Optional agent registry for agent-as-tool */
  agentRegistry?: AgentRegistry;
  /** LLM configuration for this agent */
  llmConfig?: LLMRequestConfig;
  /** Optional lifecycle hooks */
  hooks?: AgentHooks;
}

/**
 * Create a default agent runtime config.
 */
export function createAgentRuntimeConfig(
  llm: LLMAdapter,
  toolRegistry: ToolRegistry,
  emit: EventEmitCallback = noopEmit,
  requestId: string = '',
  overrides?: Partial<AgentRuntimeConfig>
): AgentRuntimeConfig {
  return {
    llm,
    toolRegistry,
    emit,
    requestId,
    agentRegistry: overrides?.agentRegistry,
    llmConfig: overrides?.llmConfig,
    hooks: overrides?.hooks,
  };
}
```

### Updated Agent Class (`../agent/src/agent.ts`):

#### Before:
```typescript
export class Agent {
  private config: AgentConfig;
  private llm: LLMAdapter;
  private toolRegistry: ToolRegistry;
  private emit: EventEmitCallback;
  private requestId: string;
  private agentRegistry?: AgentRegistry;
  private llmConfig: LLMRequestConfig;
  private lastRequestConfig: LLMRequestConfig | null = null;
  private hooks?: AgentHooks;

  constructor(
    config: AgentConfig,
    llm: LLMAdapter,
    toolRegistry: ToolRegistry,
    emit: EventEmitCallback = noopEmit,
    requestId: string = '',
    agentRegistry?: AgentRegistry,
    llmConfig?: LLMRequestConfig,
    hooks?: AgentHooks
  ) {
    this.config = config;
    this.llm = llm;
    this.toolRegistry = toolRegistry;
    this.emit = emit;
    this.requestId = requestId;
    this.agentRegistry = agentRegistry;
    this.llmConfig = llmConfig ?? { model: 'unknown' };
    this.hooks = hooks;
  }
}
```

#### After:
```typescript
export class Agent {
  private config: AgentConfig;
  private runtime: AgentRuntimeConfig;
  private lastRequestConfig: LLMRequestConfig | null = null;

  constructor(
    config: AgentConfig,
    runtime: AgentRuntimeConfig
  ) {
    this.config = config;
    this.runtime = {
      ...runtime,
      llmConfig: runtime.llmConfig ?? { model: 'unknown' },
    };
  }

  // ✅ Access via runtime property
  private get llm() { return this.runtime.llm; }
  private get toolRegistry() { return this.runtime.toolRegistry; }
  private get emit() { return this.runtime.emit; }
  private get requestId() { return this.runtime.requestId; }
  private get agentRegistry() { return this.runtime.agentRegistry; }
  private get llmConfig() { return this.runtime.llmConfig; }
  private get hooks() { return this.runtime.hooks; }
}
```

### Call Site Updates

#### 1. Harness (`../harness-daemon/src/harness/harness.ts`):

##### Before:
```typescript
const agent = new Agent(
  config,
  llm,
  this.toolRegistry,
  emit,
  requestId,
  this.agentRegistry,
  llmConfig
);
```

##### After:
```typescript
const agent = new Agent(
  config,
  createAgentRuntimeConfig(
    llm,
    this.toolRegistry,
    emit,
    requestId,
    {
      agentRegistry: this.agentRegistry,
      llmConfig,
    }
  )
);
```

#### 2. Agent (sub-agent creation) (`../agent/src/agent.ts`):

##### Before:
```typescript
const agent = new Agent(
  agentConfig,
  this.llm,
  this.toolRegistry,
  this.emit,
  this.requestId,
  this.agentRegistry,
  llmConfig,
  this.hooks
);
```

##### After:
```typescript
const agent = new Agent(
  agentConfig,
  createAgentRuntimeConfig(
    this.llm,
    this.toolRegistry,
    this.emit,
    this.requestId,
    {
      agentRegistry: this.agentRegistry,
      llmConfig,
      hooks: this.hooks,
    }
  )
);
```

#### 3. Orchestrator (`../orchestrator/src/orchestrator.ts`):

##### Before:
```typescript
return new Agent(
  config,
  this.llm,
  this.toolRegistry,
  this.emit,
  this.requestId,
  this.agentRegistry,
  runtime.llm,
  this.hooks
);
```

##### After:
```typescript
return new Agent(
  config,
  createAgentRuntimeConfig(
    this.llm,
    this.toolRegistry,
    this.emit,
    this.requestId,
    {
      agentRegistry: this.agentRegistry,
      llmConfig: runtime.llm,
      hooks: this.hooks,
    }
  )
);
```

### Files to Modify

1. **`../agent/src/types.ts`**
   - Add `AgentRuntimeConfig` interface
   - Add `createAgentRuntimeConfig` helper function

2. **`../agent/src/agent.ts`**
   - Update constructor signature
   - Update private fields
   - Add getter properties
   - Update internal references to use `runtime` property

3. **`../harness-daemon/src/harness/harness.ts`**
   - Update Agent instantiation to use `createAgentRuntimeConfig`

4. **`../agent/src/agent.ts`** (sub-agent creation)
   - Update sub-agent instantiation to use `createAgentRuntimeConfig`

5. **`../orchestrator/src/orchestrator.ts`**
   - Update Agent instantiation to use `createAgentRuntimeConfig`

---

## Risk Assessment

### Change 1: WorkItem Event Type
- **Risk**: Low
- **Scope**: Well-defined event schema change
- **Migration**: All consumers use switch statements, easy to update
- **Testing**: Verify event flow in harness, TUI, and dashboard

### Change 2: Agent Runtime Config
- **Risk**: Low
- **Scope**: Internal refactoring, no behavior change
- **Migration**: 3 call sites, straightforward
- **Testing**: Verify agent creation and execution still works

---

## Verification Steps

1. **Event Schema Test**: Emit `workitem_status` events and verify Zod validation passes
2. **Event Flow Test**: Verify events flow through EventBus → EventTranslator → Dashboard
3. **Agent Creation Test**: Verify all 3 call sites create agents correctly
4. **Agent Execution Test**: Run a simple task and verify agent executes normally
5. **Integration Test**: Run end-to-end workflow and verify no regressions

---

---

## Change 3: Extract Orchestrator Policy to Config

### Problem
The Orchestrator embeds policy decisions as magic numbers:

```typescript
// Hardcoded policy in execute()
if (percentUsed < 0.7) {
  compactedRecently = false;
}
if (!compactedRecently && percentUsed >= 0.8) {
  const compactResult = context.compact({
    deduplicateByPath: true,
    maxFileContentCount: 20,      // Magic number
    truncateOutputsTo: 5000,       // Magic number
  });
```

This mixes mechanism (when/how to compact) with policy (thresholds and parameters).

### Solution
Lift magic numbers to `OrchestratorConfig`. No new abstractions, just config.

### Config Changes (`../orchestrator/src/orchestrator.ts`)

#### Before:
```typescript
export interface OrchestratorConfig {
  maxIterations: number;
  maxToolCalls: number;
  maxDurationMs: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  maxIterations: 50,
  maxToolCalls: 200,
  maxDurationMs: 300_000,
};
```

#### After:
```typescript
export interface OrchestratorConfig {
  maxIterations: number;
  maxToolCalls: number;
  maxDurationMs: number;
  /** Percent context usage that triggers compaction (default 0.8) */
  compactTriggerPercent: number;
  /** Percent context usage to reset compaction hysteresis (default 0.7) */
  compactResetPercent: number;
  /** Max file content items to keep during compaction */
  compactMaxFileCount: number;
  /** Max chars per tool output during compaction */
  compactTruncateTo: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  maxIterations: 50,
  maxToolCalls: 200,
  maxDurationMs: 300_000,
  compactTriggerPercent: 0.8,
  compactResetPercent: 0.7,
  compactMaxFileCount: 20,
  compactTruncateTo: 5000,
};
```

### Execute() Changes

#### Before:
```typescript
if (percentUsed < 0.7) {
  compactedRecently = false;
}
if (!compactedRecently && percentUsed >= 0.8) {
  const compactResult = context.compact({
    deduplicateByPath: true,
    maxFileContentCount: 20,
    truncateOutputsTo: 5000,
  });
```

#### After:
```typescript
if (percentUsed < this.config.compactResetPercent) {
  compactedRecently = false;
}
if (!compactedRecently && percentUsed >= this.config.compactTriggerPercent) {
  const compactResult = context.compact({
    deduplicateByPath: true,
    maxFileContentCount: this.config.compactMaxFileCount,
    truncateOutputsTo: this.config.compactTruncateTo,
  });
```

### Files to Modify

1. **`../orchestrator/src/orchestrator.ts`**
   - Add 4 new fields to `OrchestratorConfig`
   - Add defaults to `DEFAULT_ORCHESTRATOR_CONFIG`
   - Update `execute()` to use config values instead of magic numbers

---

## Notes

- **Backward Compatibility**: None of these changes are backward compatible. Breaking change for event consumers and Agent instantiation.
- **Rollback**: Git revert if issues arise.
- **Deprecation**: Old event types can be deprecated in a future release if gradual migration is needed.