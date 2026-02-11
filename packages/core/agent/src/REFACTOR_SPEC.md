# agent.ts Refactor Spec

## Goal
Reduce executeLoop from 454 lines to ~150 lines by extracting helpers and eliminating duplication.

---

## Phase 1: Extract Helper Functions (no behavior change)

### 1.1 `checkBounds()`
**Extract from:** lines 508-528
**Signature:**
```typescript
private checkBounds(
  metrics: AgentMetrics,
  workItem: WorkItem,
  elapsedMs: number
): 'bounds:tool_calls' | 'bounds:duration' | null
```
**Emits:** `agent_bounds_hit` event internally
**Returns:** termination reason or null

### 1.2 `compactIfNeeded()`
**Extract from:** lines 478-506
**Signature:**
```typescript
private async compactIfNeeded(
  localContext: ContextWindow,
  localReadFiles: Set<string>,
  workItem: WorkItem
): Promise<void>
```
**Key change:** `localReadFiles.clear()` + rebuild moves INSIDE this function
**Emits:** `context_threshold` hook event internally

### 1.3 `buildIterationRequest()`
**Extract from:** lines 530-548
**Signature:**
```typescript
private buildIterationRequest(
  workItem: WorkItem,
  globalContext: ContextWindow,
  localContext: ContextWindow,
  cwd: string,
  iteration: number,
  maxIterations: number
): { messages: Message[]; tools: ToolDefinition[] | undefined; toolChoice: 'none' | 'auto' | undefined }
```
**Consolidates:** `buildSystemPromptComponents()` + `filterAllowedTools()` + `buildMessages()` + last-iteration logic

### 1.4 `handleHandoff()`
**Extract from:** lines 740-754 (delete duplicate at 780-795)
**Signature:**
```typescript
private handleHandoff(
  structuredOutput: Record<string, unknown> | null,
  result: AgentResult
): boolean  // true = should return, false = continue
```

### 1.5 `resolveAction()`
**New function combining:** `handleAwaitingUserInput()` + `handleCompletionAction()` + action logic
**Signature:**
```typescript
private resolveAction(
  action: AgentAction | null,
  structuredOutput: Record<string, unknown> | null,
  responseText: string | undefined,
  content: string,
  result: AgentResult
): 'done' | 'handoff' | 'user_input' | 'continue' | 'no_action'
```
**Sets:** `result.terminationReason`, `result.success`, `result.response`, `result.needsUserInput` as side effects

---

## Phase 2: Restructure executeLoop

### Delete
- Lines 722-762 (state handling inside `if (toolCalls.length > 0)`)
- Lines 765-828 (duplicate state handling outside the if)
- Lines 508-528 (inline bounds checking - now in `checkBounds()`)
- Lines 478-506 (inline compaction - now in `compactIfNeeded()`)
- Lines 530-548 (inline request building - now in `buildIterationRequest()`)

### New Loop Structure
```typescript
for (let iteration = 0; iteration < maxIterations; iteration++) {
  profiler.instant(...);

  // 1. Pre-checks
  if (this.hooks?.shouldStop?.()) {
    result.terminationReason = 'user_stopped';
    break;
  }
  const boundHit = this.checkBounds(metrics, workItem, Date.now() - startTime);
  if (boundHit) {
    result.terminationReason = boundHit;
    break;
  }

  // 2. Context management
  await this.compactIfNeeded(localContext, localReadFiles, workItem);

  // 3. Build + execute LLM call
  const request = this.buildIterationRequest(workItem, globalContext, localContext, cwd, iteration, maxIterations);
  const { response, buffer } = await this.streamWithResilience({...}, workItem.workId);
  metrics.llmCallsMade++;
  // ... (existing metrics/emit code stays)

  // 4. Parse response
  const content = response.content ?? '';
  const toolCalls = response.toolCalls ?? [];
  const structuredOutput = this.parseStructuredOutput(content);
  const action = this.extractStructuredAction(structuredOutput);
  const responseText = this.combineResponseText(
    extractPreJsonText(content),
    this.extractStructuredResponse(structuredOutput)
  );

  this.addAssistantMessage(localContext, content, toolCalls);

  // 5. Process tools (if any)
  if (toolCalls.length > 0) {
    await this.processToolCalls(...);
    if (result.terminationReason) {
      this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
      return;
    }
  }

  // 6. Handle action (ONE switch)
  const resolved = this.resolveAction(action, structuredOutput, responseText, content, result);

  switch (resolved) {
    case 'done':
    case 'user_input':
      this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
      return;

    case 'handoff':
      if (this.handleHandoff(structuredOutput, result)) {
        this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
        return;
      }
      this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
      continue;

    case 'continue':
      if (responseText?.trim()) result.response = responseText;
      this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
      continue;

    case 'no_action':
      result.terminationReason = 'no_action';
      result.error = `LLM response has no action directive`;
      this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
      break;
  }
}
```

---

## Phase 3: Sub-agent Callbacks (optional, separate PR)

### Add to AgentHooks or new SubAgentCallbacks type
```typescript
interface SubAgentCallbacks {
  [agentType: string]: (result: AgentResult, parentContext: ContextWindow) => void;
}
```

### Usage in executeAgentToolCall
```typescript
// Instead of inline explorer validation:
const callback = this.subAgentCallbacks?.[agentConfig.type];
if (callback) {
  callback(subResult, parentLocalContext);
}
```

### Move explorer validation to callback registration
```typescript
// In orchestrator or harness setup:
subAgentCallbacks: {
  explorer: (result, ctx) => {
    if (result.filesRead.length > 0 && result.artifacts.length === 0) {
      result.success = false;
      result.error = `Explorer read ${result.filesRead.length} files but extracted 0 artifacts`;
    }
  }
}
```

---

## Actual Impact (Phase 1 Complete)

| Metric | Before | After | Notes |
|--------|--------|-------|-------|
| executeLoop lines | 454 | 329 | 27% reduction |
| Duplicate handoff code | 30 lines | 0 | ✅ Eliminated |
| Duplicate state handling | 100+ lines | 0 | ✅ Single switch |
| Total agent.ts lines | 2027 | 2051 | +24 (helpers moved above) |
| Extracted helpers | 0 | 5 | checkBounds, compactIfNeeded, buildIterationRequest, handleHandoff, resolveAction |
| Deleted dead methods | 0 | 2 | handleAwaitingUserInput, handleCompletionAction |

**Note:** Total lines increased slightly because helpers add clarity/reusability. The key win is executeLoop is now readable with clear separation of concerns.

---

## Test Plan

1. ✅ Existing tests pass (2 tests)
2. Manual test: agent completes with action=done
3. Manual test: agent hits tool call bounds
4. Manual test: agent hits duration bounds
5. Manual test: agent handles handoff
6. Manual test: context compaction triggers
7. Manual test: sub-agent (explorer) runs and returns artifacts
