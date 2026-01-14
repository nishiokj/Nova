# Event System Changes: Real-Time Artifacts & Progress Checkpointing

## Overview

Two changes to the event system:
1. **Real-time artifact emission** - Agents emit events when artifacts are discovered, Orchestrator subscribes via EventBus and stitches into global context
2. **Progress checkpointing** - Agents auto-emit progress at key milestones, displayed in TUI

**Note:** This plan accounts for recent changes from PATCH_SPEC.md:
- Agent now uses `AgentRuntimeConfig` (2-param constructor)
- WorkItem events consolidated to `workitem_status`
- Orchestrator policy extracted to `OrchestratorConfig`

---

## Progress Tracker

| Step | File | Status |
|------|------|--------|
| 1 | `packages/types/src/events.ts` | ✅ DONE |
| 2 | `packages/context/src/context-window.ts` | ✅ DONE |
| 3 | `packages/agent/src/agent.ts` | ✅ DONE |
| 4 | `packages/harness-daemon/src/harness/event_translator.ts` | ✅ DONE |
| 5 | `packages/orchestrator/src/orchestrator.ts` | ✅ DONE |
| 6 | `packages/harness-daemon/src/harness/harness.ts` | ✅ DONE |
| 7 | Build verification | ✅ DONE |

---

## 1. New Event Types ✅ DONE

**File: `packages/types/src/events.ts`**

Already implemented - types and data interfaces are in place:

```typescript
export type AgentCoreEventType =
  | 'tool_call'
  | 'llm_call'
  | 'llm_error'
  | 'agent_bounds_hit'
  | 'agent_message'
  | 'artifact_discovered'  // ✅ Added
  | 'agent_progress';       // ✅ Added

export interface ArtifactDiscoveredData {
  artifact: {
    id: string;
    sourcePath: string;
    line?: number;
    kind: string;
    name: string;
    signature?: string;
    insight?: string;
    relevance: number;
  };
  agentType: string;
  artifactCount: number;
}

export interface AgentProgressData {
  message: string;
  agentType: string;
  category?: 'search' | 'analysis' | 'discovery' | 'synthesis';
  count?: { current: number; total?: number; label: string };
}
```

---

## 2. ContextWindow Callback Hook ✅ DONE

**File: `packages/context/src/context-window.ts`**

All components implemented:
- ✅ `ArtifactAddedCallback` type export
- ✅ `_onArtifactAdded` private field
- ✅ `setArtifactAddedCallback()` method
- ✅ Callback invocation in `addArtifact()` after pushing to `_items`

---

## 3. Agent Changes ✅ DONE

**File: `packages/agent/src/agent.ts`**

Agent now uses `AgentRuntimeConfig` pattern (config + runtime). The emit callback is accessed via `this.emit` getter.

### 3a. Wire artifact callback in run()

```typescript
async run(params: AgentRunParams): Promise<AgentResult> {
  const { globalContext, workItem, cwd } = params;
  const localContext = new ContextWindow(`${workItem.workId}_local`, this.llmConfig.contextWindow ?? 128_000);

  // Wire artifact callback for real-time emission
  localContext.setArtifactAddedCallback((artifact) => {
    this.emit(createEvent('artifact_discovered', {
      artifact: {
        id: artifact.id,
        sourcePath: artifact.sourcePath,
        line: artifact.line,
        kind: artifact.kind,
        name: artifact.name,
        signature: artifact.signature,
        insight: artifact.insight,
        relevance: artifact.relevance,
      },
      agentType: this.config.type,
      artifactCount: localContext.getArtifacts().length,
    }, workItem.workId));
  });

  // ... rest of run()
}
```

### 3b. Add emitProgress() helper

```typescript
private emitProgress(
  message: string,
  workItemId?: string,
  options?: {
    category?: 'search' | 'analysis' | 'discovery' | 'synthesis';
    count?: { current: number; total?: number; label: string };
  }
): void {
  this.emit(createEvent('agent_progress', {
    message,
    agentType: this.config.type,
    ...options,
  }, workItemId));
}
```

### 3c. Auto-emit at milestones

Add calls in `processToolCalls()`:
- Before parallel tool batch: `emitProgress("Executing N tool calls...", workItemId, { category: 'analysis' })`
- After file read batch: `emitProgress("Read N target files", workItemId, { category: 'search', count: { current: N, label: 'files' } })`
- When artifacts extracted from sub-agent: `emitProgress("Discovered N artifacts", workItemId, { category: 'discovery', count: { current: N, label: 'artifacts' } })`

---

## 4. Event Translator for TUI ✅ DONE

**File: `packages/harness-daemon/src/harness/event_translator.ts`**

Add cases to `translateAgentEvent()`:

```typescript
case 'artifact_discovered': {
  const artData = data as ArtifactDiscoveredData;
  return {
    type: 'progress',
    data: {
      request_id: requestId,
      message: `Found: ${artData.artifact.name} (${artData.artifact.kind})`,
      level: 'info',
      kind: 'thinking',
    } satisfies ProgressEventData,
  };
}

case 'agent_progress': {
  const progressData = data as AgentProgressData;
  let message = progressData.message;
  if (progressData.count) {
    const { current, total, label } = progressData.count;
    message = total
      ? `${message} (${current}/${total} ${label})`
      : `${message} (${current} ${label})`;
  }
  return {
    type: 'progress',
    data: {
      request_id: requestId,
      message,
      level: 'info',
      kind: 'thinking',
    } satisfies ProgressEventData,
  };
}
```

---

## 5. Orchestrator EventBus Subscription ✅ DONE

**File: `packages/orchestrator/src/orchestrator.ts`**

Orchestrator already has `OrchestratorConfig` for policy. Add `eventBus` as a constructor param.

### 5a. Add EventBus to constructor

```typescript
import type { EventBusProtocol } from 'comms-bus';

// Add private field
private eventBus?: EventBusProtocol;

constructor(
  config: Partial<OrchestratorConfig>,
  toolRegistry: ToolRegistry,
  llm: LLMAdapter,
  emit: EventEmitCallback,
  requestId: string,
  logger?: OrchestratorLogger,
  agentRegistry?: AgentRegistry,
  hooks?: AgentHooks,
  planModeOptions?: PlanModeOptions,
  eventBus?: EventBusProtocol  // NEW
) {
  // ... existing assignments ...
  this.eventBus = eventBus;
}
```

### 5b. Subscribe in execute()

```typescript
async execute(context: ContextWindow, goal: string, agentType: string, cwd: string): Promise<OrchestratorResult> {
  // Subscribe to artifact events for real-time stitching
  const unsubscribe = this.eventBus?.subscribe('artifact_discovered', (event) => {
    const data = event.data as ArtifactDiscoveredData;
    // Avoid duplicates
    const existing = context.getArtifactsByPath(data.artifact.sourcePath);
    const isDuplicate = existing.some(e =>
      e.name === data.artifact.name && e.line === data.artifact.line
    );
    if (!isDuplicate) {
      context.addArtifact({
        sourcePath: data.artifact.sourcePath,
        line: data.artifact.line,
        kind: data.artifact.kind as ArtifactKind,
        name: data.artifact.name,
        signature: data.artifact.signature,
        insight: data.artifact.insight,
        relevance: data.artifact.relevance,
        discoveredBy: data.agentType,
      });
    }
  });

  try {
    // ... existing execution loop ...
  } finally {
    unsubscribe?.();
  }
}
```

---

## 6. Update Harness to Pass EventBus ✅ DONE

**File: `packages/harness-daemon/src/harness/harness.ts`**

When creating Orchestrator, pass `this.eventBus`:

```typescript
const orchestrator = new Orchestrator(
  orchestratorConfig,
  this.toolRegistry,
  this.llm,
  emit,
  requestId,
  this.logger,
  this.agentRegistry,
  hooks,
  planModeOptions,
  this.eventBus  // NEW
);
```

---

## Files Modified

| File | Changes | Status |
|------|---------|--------|
| `packages/types/src/events.ts` | `artifact_discovered`, `agent_progress` types | ✅ DONE |
| `packages/context/src/context-window.ts` | Invoke callback in `addArtifact()` | ✅ DONE |
| `packages/agent/src/agent.ts` | Wire callback, add `emitProgress()`, auto-emit | ✅ DONE |
| `packages/orchestrator/src/orchestrator.ts` | Add EventBus param + subscription | ✅ DONE |
| `packages/harness-daemon/src/harness/event_translator.ts` | Translate new events | ✅ DONE |
| `packages/harness-daemon/src/harness/harness.ts` | Pass eventBus to Orchestrator | ✅ DONE |

---

## Implementation Order

1. ~~**types/events.ts**~~ - ✅ Done
2. ~~**context-window.ts**~~ - ✅ Done
3. ~~**agent.ts**~~ - ✅ Done
4. ~~**event_translator.ts**~~ - ✅ Done
5. ~~**orchestrator.ts**~~ - ✅ Done
6. ~~**harness.ts**~~ - ✅ Done
7. ~~**Build verification**~~ - ✅ Done

---

## Verification

1. `pnpm build` - Confirm compilation
2. Run agent with verbose logging - Verify `artifact_discovered` and `agent_progress` events emitted
3. Check TUI displays progress messages with "thinking" styling
4. Multi-agent test: Verify Agent B sees Agent A's artifacts in global context before A completes
