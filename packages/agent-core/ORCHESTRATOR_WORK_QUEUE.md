# Orchestrator Work Queue Implementation

## Overview

Add a work queue to the Orchestrator to enable:
- DAG-based task execution with dependencies
- Async work items from skills/hooks
- Foundation for parallel execution (future)

The key insight: this is additive. Single-request execution degenerates to a queue with one item.

## Current Architecture

```
Harness.run()
    ↓
Orchestrator.execute(context, goal, agentType, cwd)
    ↓
while (true):
    - check bounds
    - agent.run()
    - check terminal conditions
    - continue or return
```

## New Architecture

```
Harness.run()
    ↓
Orchestrator.execute(context, goal, agentType, cwd)
    ↓
enqueue(initialWorkItem)
    ↓
while (workQueue.length > 0):
    - dequeueNext() (respects dependencies)
    - check bounds
    - agent.run()
    - mark item complete
    - check terminal conditions
    - continue or return
```

## Minimal Implementation

### New State

```typescript
class Orchestrator {
  private workQueue: WorkItem[] = [];
  private completedWork: Map<string, AgentResult> = new Map();
}
```

### New Public Method

```typescript
enqueue(item: WorkItem): string {
  this.workQueue.push(item);
  return item.workId;
}
```

### New Private Method

```typescript
private dequeueNext(): WorkItem | null {
  for (let i = 0; i < this.workQueue.length; i++) {
    const item = this.workQueue[i];
    const ready = item.dependencies.every(d => this.completedWork.has(d));
    if (ready) {
      this.workQueue.splice(i, 1);
      return item;
    }
  }
  return null; // all items blocked on dependencies
}
```

### Modified execute()

```typescript
async execute(context, goal, agentType, cwd): Promise<OrchestratorResult> {
  // Clear state for fresh execution
  this.workQueue = [];
  this.completedWork.clear();

  // Enqueue initial request
  const initialItem = this.createWorkItem(goal, agentType);
  this.enqueue(initialItem);

  const startTime = Date.now();
  let totalLlmCalls = 0;
  let totalToolCalls = 0;

  // Process queue
  while (this.workQueue.length > 0) {
    const item = this.dequeueNext();
    if (!item) {
      // All items blocked on dependencies - deadlock or waiting
      break;
    }

    // Bounds checking (against orchestrator-level limits)
    const elapsed = Date.now() - startTime;
    if (elapsed > this.config.maxDurationMs) { ... }
    if (totalToolCalls >= this.config.maxToolCalls) { ... }

    // Create and run agent for this work item
    const agent = this.createAgent(item.agent);
    if (!agent) {
      // Mark as failed, continue to next item
      this.completedWork.set(item.workId, errorResult);
      continue;
    }

    const result = await agent.run({ globalContext: context, workItem: item, cwd });

    // Track metrics
    totalLlmCalls += result.metrics.llmCallsMade;
    totalToolCalls += result.metrics.toolCallsMade;

    // Mark complete
    this.completedWork.set(item.workId, result);
    context.addAgentResultContext(result);

    // Terminal conditions
    if (result.needsUserInput) {
      return this.createResult({ paused: true, userPrompt: result.userPrompt, ... });
    }

    if (result.isRefusal) {
      return this.createResult({ terminationReason: 'refusal', ... });
    }

    // Note: goal_state_reached only terminates if this was the initial item
    // or if all work is complete
  }

  // Aggregate results from all completed work
  return this.aggregateResults();
}
```

## Usage Patterns

### Standard Request (unchanged behavior)

```typescript
// Harness
const orchestrator = new Orchestrator(...);
const result = await orchestrator.execute(context, goal, agentType, cwd);
// Queue has 1 item, processes it, returns
```

### Skill Generates Plan

```typescript
// Research skill callback
function onResearchPlan(orchestrator, plan) {
  // Enqueue parallel search tasks
  const searchIds = plan.searches.map(query =>
    orchestrator.enqueue(createWorkItem({
      goal: `Search: ${query}`,
      agent: 'web-search',
      dependencies: [],
    }))
  );

  // Enqueue synthesis task (depends on all searches)
  orchestrator.enqueue(createWorkItem({
    goal: 'Synthesize search results',
    agent: 'writer',
    dependencies: searchIds,
  }));
}
```

### Hook Adds Background Work

```typescript
// PostToolUse hook for file writes
async postToolUse(toolName, args, result) {
  if (toolName === 'Write' && result.isSuccess) {
    orchestrator.enqueue(createWorkItem({
      goal: `Index file: ${args.path}`,
      agent: 'indexer',
      dependencies: [],
      priority: 'background', // future: process after main work
    }));
  }
}
```

## Future Extensions

### Parallel Execution

```typescript
private async processParallelBatch(): Promise<void> {
  // Find all items with satisfied dependencies
  const ready = this.workQueue.filter(item =>
    item.dependencies.every(d => this.completedWork.has(d))
  );

  if (ready.length <= 1) {
    return; // No parallelism benefit
  }

  // Remove from queue
  for (const item of ready) {
    const idx = this.workQueue.indexOf(item);
    this.workQueue.splice(idx, 1);
  }

  // Run in parallel
  const results = await Promise.all(
    ready.map(item => this.runSingleItem(item))
  );

  // Mark all complete
  for (let i = 0; i < ready.length; i++) {
    this.completedWork.set(ready[i].workId, results[i]);
  }
}
```

### Priority Queue

```typescript
interface WorkItem {
  // ... existing fields
  priority: 'high' | 'normal' | 'background';
  blocking: boolean; // if false, don't block main result
}

private dequeueNext(): WorkItem | null {
  // Sort by priority, then by insertion order
  const ready = this.workQueue
    .filter(item => item.dependencies.every(d => this.completedWork.has(d)))
    .sort((a, b) => priorityValue(a.priority) - priorityValue(b.priority));

  if (ready.length === 0) return null;

  const item = ready[0];
  this.workQueue.splice(this.workQueue.indexOf(item), 1);
  return item;
}
```

### Result Aggregation

```typescript
private aggregateResults(): OrchestratorResult {
  const results = Array.from(this.completedWork.values());

  // Find the "primary" result (initial work item or last blocking item)
  const primaryResult = results.find(r => r.workId === this.initialWorkId)
    ?? results[results.length - 1];

  // Combine metrics
  const totalMetrics = results.reduce((acc, r) => ({
    llmCallsMade: acc.llmCallsMade + r.metrics.llmCallsMade,
    toolCallsMade: acc.toolCallsMade + r.metrics.toolCallsMade,
    durationMs: Math.max(acc.durationMs, r.metrics.durationMs),
  }), { llmCallsMade: 0, toolCallsMade: 0, durationMs: 0 });

  return this.createResult({
    success: primaryResult.success,
    response: primaryResult.response,
    metrics: totalMetrics,
    // ...
  });
}
```

## WorkItem Dependencies

WorkItem already has a `dependencies: string[]` field (verified in agent.ts line 729).

No changes needed to WorkItem type for minimal implementation.

## Open Questions

1. **How do skills/hooks get orchestrator reference?**
   - Pass via context/params?
   - Callback function?
   - For now: defer until we build a skill that needs it

2. **What happens if queue has items but execute() returns?**
   - Current: remaining items are lost
   - Future: could persist queue, resume later

3. **How to handle partial failure?**
   - If 3/5 work items succeed, what's the overall result?
   - Current: return result of last processed item
   - Future: configurable aggregation strategy
