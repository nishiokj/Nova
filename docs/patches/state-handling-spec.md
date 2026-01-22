# State Handling Analysis: Minimum Change Spec

## Overview

This document analyzes state handling in `packages/orchestrator/src/orchestrator.ts` and `packages/agent/src/agent.ts` to identify:
1. States not handled properly
2. Unnecessary/redundant states
3. Hidden exceptions not handled

---

## 1. Type Safety Gap (HIGH PRIORITY)

### Issue
`AgentResult.terminationReason` is typed as `string`, allowing arbitrary values that the orchestrator cannot dispatch properly.

### Current Code
```typescript
// packages/agent/src/types.ts
export interface AgentResult {
  terminationReason: string; // ❌ Too permissive
  // ...
}
```

### Orchestrator's Expected States
```typescript
// packages/orchestrator/src/orchestrator.ts
export type TerminationReason =
  | 'goal_state_reached'
  | 'max_iterations_exceeded'
  | 'max_tool_calls_exceeded'
  | 'max_duration_exceeded'
  | 'user_input_required'
  | 'handoff_requested'
  | 'agent_error'
  | 'refusal';
```

### Minimum Fix
Create a shared union type for termination reasons:

```typescript
// packages/shared/src/types.ts (new or existing)
export type AgentTerminationReason =
  | 'goal_state_reached'
  | 'invalid_action'
  | 'refusal'
  | 'rate_limit'
  | 'circuit_open'
  | 'retries_exhausted'
  | 'user_input_required'
  | 'handoff_requested'
  | 'no_action'
  | 'stagnation:tool_repeat'
  | 'iterations_exhausted'
  | 'bounds:tool_calls'
  | 'bounds:duration'
  // For orchestrator-level termination (mapped by orchestrator)
  | 'max_iterations_exceeded'
  | 'max_tool_calls_exceeded'
  | 'max_duration_exceeded'
  | 'agent_error';

// packages/agent/src/types.ts
export interface AgentResult {
  terminationReason: AgentTerminationReason;
  // ...
}
```

---

## 2. Agent States Not Properly Handled by Orchestrator

### 2.1 `invalid_action` State

**Where it occurs:**
```typescript
// packages/agent/src/agent.ts:236-242
if (!goalReached) {
  result.terminationReason = 'invalid_action';
  result.error = 'Action "done" requires goalStateReached: true.';
  return true; // Should break after this
}
```

**Problem:** Orchestrator never checks for this state. Agent returns with `terminationReason: 'invalid_action'` and `success: false`, but orchestrator treats it as generic `agent_error`.

**Impact:** The specific error message is lost in generic error handling.

**Minimum Fix (orchestrator):**
Add explicit check in the terminal conditions loop:

```typescript
// TERMINAL: Invalid action (done without goalStateReached)
if (result.terminationReason === 'invalid_action') {
  this.log('error', 'Invalid action detected', { workId, error: result.error });
  emitGoalNotAchieved('invalid_action', 1);
  await this.notifyStopHook(context, 'agent_error', result.response, iteration, agentType);
  context.addAgentResultContext(result);
  terminalResult = this.createResult({
    success: false,
    response: result.response,
    error: result.error,
    terminationReason: 'agent_error', // Map to known orchestrator state
    metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
  });
  continue;
}
```

---

### 2.2 `stagnation:tool_repeat` State

**Where it occurs:**
```typescript
// packages/agent/src/agent.ts:617-624
if (toolRepeatState.repeats >= TOOL_LIMITS.MAX_IDENTICAL_CALLS) {
  result.terminationReason = 'stagnation:tool_repeat';
  result.error = `Repeated identical tool call without progress: ${call.name}`;
  return true;
}
```

**Problem:** Orchestrator treats this as generic `agent_error`. The specific "stagnation" information is lost.

**Minimum Fix (orchestrator):**
```typescript
// TERMINAL: Stagnation (repeated tool calls)
if (result.terminationReason === 'stagnation:tool_repeat') {
  this.log('warning', 'Agent stuck in tool repeat loop', { workId, error: result.error });
  emitGoalNotAchieved('stagnation', 1);
  await this.notifyStopHook(context, 'agent_error', result.response, iteration, agentType);
  context.addAgentResultContext(result);
  terminalResult = this.createResult({
    success: false,
    response: result.response,
    error: result.error,
    terminationReason: 'agent_error', // Map to known orchestrator state
    metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
  });
  continue;
}
```

---

### 2.3 `no_action` State

**Where it occurs:**
```typescript
// packages/agent/src/agent.ts:487-492
result.terminationReason = 'no_action';
const preview = responseCandidate.trim().slice(0, 1000);
result.error = preview
  ? `LLM response has no tools and no action directive. Response preview: ${preview}`
  : 'LLM response has no tools and no action directive';
```

**Problem:** Agent returns `success: false` with `'no_action'`, but orchestrator treats it as generic `agent_error`.

**Impact:** The specific issue (model confusion about output format) is obscured.

**Minimum Fix (orchestrator):**
```typescript
// TERMINAL: No action (model failed to produce tools or directive)
if (result.terminationReason === 'no_action') {
  this.log('warning', 'Model produced no action directive', { workId, error: result.error });
  emitGoalNotAchieved('no_action', 1);
  await this.notifyStopHook(context, 'agent_error', result.response, iteration, agentType);
  context.addAgentResultContext(result);
  terminalResult = this.createResult({
    success: false,
    response: result.response,
    error: result.error,
    terminationReason: 'agent_error', // Map to known orchestrator state
    metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
  });
  continue;
}
```

---

### 2.4 Transient Error States (rate_limit, circuit_open, retries_exhausted)

**Where they occur:**
```typescript
// packages/agent/src/agent.ts:162-175
if (error instanceof RateLimitError) {
  result.terminationReason = 'rate_limit';
  result.rateLimitInfo = { ... };
} else if (error instanceof CircuitOpenError) {
  result.terminationReason = 'circuit_open';
} else if (error instanceof RetriesExhaustedError) {
  result.terminationReason = 'retries_exhausted';
} else {
  result.terminationReason = `exception:${message}`;
}
```

**Problem:** These transient error states are not handled by orchestrator. They're treated as generic `agent_error`.

**Impact:**
- Rate limits could be retried by the caller if explicitly signaled
- Circuit breaker state is opaque to the orchestrator
- No distinction between transient and permanent errors

**Minimum Fix (orchestrator):**
Add `rate_limit` and `circuit_open` to `TerminationReason` type:

```typescript
export type TerminationReason =
  | 'goal_state_reached'
  | 'max_iterations_exceeded'
  | 'max_tool_calls_exceeded'
  | 'max_duration_exceeded'
  | 'user_input_required'
  | 'handoff_requested'
  | 'agent_error'
  | 'refusal'
  | 'rate_limit'        // NEW
  | 'circuit_open';      // NEW
```

Then add checks:
```typescript
// TERMINAL: Rate limit (transient, caller may retry)
if (result.terminationReason === 'rate_limit' && result.rateLimitInfo) {
  this.log('warning', 'Rate limit hit', { workId, info: result.rateLimitInfo });
  emitGoalNotAchieved('rate_limit', 1);
  context.addAgentResultContext(result);
  terminalResult = this.createResult({
    success: false,
    response: result.response,
    error: `Rate limit: ${result.rateLimitInfo.message}`,
    terminationReason: 'rate_limit',
    metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
  });
  continue;
}

// TERMINAL: Circuit breaker open (transient, caller may retry after delay)
if (result.terminationReason === 'circuit_open') {
  this.log('warning', 'Circuit breaker open', { workId, error: result.error });
  emitGoalNotAchieved('circuit_open', 1);
  context.addAgentResultContext(result);
  terminalResult = this.createResult({
    success: false,
    response: result.response,
    error: result.error,
    terminationReason: 'circuit_open',
    metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
  });
  continue;
}
```

---

## 3. Redundant/Unnecessary States

### 3.1 Agent-Level Bounds (`bounds:tool_calls`, `bounds:duration`)

**Current behavior:**
```typescript
// packages/agent/src/agent.ts:274-285
if (metrics.toolCallsMade >= workItem.bounds.maxToolCalls) {
  result.terminationReason = 'bounds:tool_calls';
  // ...
  break;
}

if (elapsedMs >= workItem.bounds.maxDurationMs) {
  result.terminationReason = 'bounds:duration';
  // ...
  break;
}
```

**Analysis:**
- Orchestrator already has global bounds (`maxIterations`, `maxToolCalls`, `maxDurationMs`)
- Agent-level bounds are defined in `createWorkItem()` using orchestrator config:
  ```typescript
  bounds: {
    maxToolCalls: agentBudget?.maxToolCalls ?? this.config.maxToolCalls,
    maxDurationMs: agentBudget?.maxDurationMs ?? this.config.maxDurationMs,
    maxLlmCalls: agentBudget?.maxIterations ?? this.config.maxIterations,
  }
  ```
- In most cases, agent bounds = orchestrator bounds (unless agent has specific budget config)

**Recommendation:**
Keep agent-level bounds for per-agent budget override (valid feature), but:
1. Remove redundant termination reasons; use orchestrator states instead
2. When agent hits bounds, mark as `iterations_exhausted` and let orchestrator handle the actual termination

**Minimum Fix:**
Change agent termination reasons to unify with orchestrator:

```typescript
// packages/agent/src/agent.ts
// Replace 'bounds:tool_calls' with 'iterations_exhausted'
if (metrics.toolCallsMade >= workItem.bounds.maxToolCalls) {
  result.terminationReason = 'iterations_exhausted'; // Changed from 'bounds:tool_calls'
  this.emit(createEvent('agent_bounds_hit', {
    agentType: this.config.type,
    boundType: 'tool_calls',
    current: metrics.toolCallsMade,
    max: workItem.bounds.maxToolCalls,
  }, workItem.workId));
  break;
}

// Replace 'bounds:duration' with 'iterations_exhausted'
if (elapsedMs >= workItem.bounds.maxDurationMs) {
  result.terminationReason = 'iterations_exhausted'; // Changed from 'bounds:duration'
  this.emit(createEvent('agent_bounds_hit', {
    agentType: this.config.type,
    boundType: 'duration',
    current: elapsedMs,
    max: workItem.bounds.maxDurationMs,
  }, workItem.workId));
  break;
}
```

Orchestrator already handles `iterations_exhausted`:
```typescript
// Existing code in orchestrator (lines 471-478)
const isBoundsTermination =
  result.terminationReason === 'iterations_exhausted' ||
  result.terminationReason === 'bounds:tool_calls' ||
  result.terminationReason === 'bounds:duration';

if (isBoundsTermination) {
  if (result.response) {
    result.success = true;
    result.isIncomplete = true;
  }
}
```

Update the orchestrator check:
```typescript
const isBoundsTermination = result.terminationReason === 'iterations_exhausted';
```

---

### 3.2 `retries_exhausted` State

**Current behavior:**
```typescript
// packages/agent/src/agent.ts:172-174
else if (error instanceof RetriesExhaustedError) {
  result.terminationReason = 'retries_exhausted';
  console.error(`[AGENT] All retries exhausted after ${error.attempts} attempts: ${message}`);
}
```

**Analysis:**
- `RetriesExhaustedError` wraps another error (the last attempt's error)
- The underlying error (e.g., timeout, rate limit) is more informative
- `retries_exhausted` is an implementation detail of the retry mechanism

**Recommendation:**
Use the wrapped error's termination reason instead of creating a new state.

**Minimum Fix:**
```typescript
// packages/agent/src/agent.ts
// Capture the underlying error type instead of creating new state
else if (error instanceof RetriesExhaustedError) {
  // Use the underlying error's classification
  const underlyingError = error.cause; // Assuming RetriesExhaustedError exposes this
  if (underlyingError instanceof RateLimitError) {
    result.terminationReason = 'rate_limit';
    result.rateLimitInfo = underlyingError.info;
  } else if (underlyingError instanceof CircuitOpenError) {
    result.terminationReason = 'circuit_open';
  } else {
    result.terminationReason = `exception:${underlyingError?.message ?? error.message}`;
  }
  console.error(`[AGENT] All retries exhausted after ${error.attempts} attempts: ${message}`);
}
```

If `RetriesExhaustedError` doesn't expose `cause`, add it:

```typescript
// packages/llm/src/resilience.ts (or wherever this is defined)
export class RetriesExhaustedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly cause?: Error // ADD THIS
  ) {
    super(message);
    this.name = 'RetriesExhaustedError';
  }
}
```

---

## 4. Hidden Exceptions Not Handled

### 4.1 Hook Handler Timeout

**Where it occurs:**
```typescript
// packages/orchestrator/src/orchestrator.ts:175-205
private runHookHandler(params: {...}): void {
  const timeoutMs = this.config.hookTimeoutMs;
  void (async () => {
    // ...
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('hook_timeout'));
        }, timeoutMs);
      });
      await Promise.race([params.handler(), timeout]);
      success = true;
    } catch (err) {
      error = String(err);
      console.error(`[HOOK:${params.hookType}] Handler error:`, err);
    } finally {
      // ... always emit completion event
    }
  })();
}
```

**Problem:**
- Hook timeout is logged but doesn't affect orchestrator state
- No mechanism to track how many hooks have timed out
- Could lead to silent degradation if hooks consistently timeout

**Minimum Fix:**
Add hook timeout tracking to metrics:

```typescript
// packages/orchestrator/src/orchestrator.ts
// Add private counter
private hookTimeouts: number = 0;

private runHookHandler(params: {...}): void {
  const timeoutMs = this.config.hookTimeoutMs;
  void (async () => {
    // ...
    try {
      // ... existing code
    } catch (err) {
      error = String(err);
      if (error === 'Error: hook_timeout') {
        this.hookTimeouts++; // Track timeouts
        if (this.hookTimeouts >= 5) {
          this.log('warning', 'Multiple hook timeouts detected', {
            count: this.hookTimeouts,
            hookType: params.hookType
          });
        }
      }
      console.error(`[HOOK:${params.hookType}] Handler error:`, err);
    }
  })();
}
```

---

### 4.2 Compaction Failure Silent Fallback

**Where it occurs:**
```typescript
// packages/orchestrator/src/orchestrator.ts:315-332
if (!compactedRecently && percentUsed >= this.config.compactTriggerPercent) {
  const llmConfig = this.resolveCompactionLlmConfig(agentType);
  let compactResult;
  if (llmConfig) {
    try {
      compactResult = await context.compactWithLedger({...});
    } catch {
      compactResult = context.compact({...}); // Silent fallback
    }
  } else {
    compactResult = context.compact({...});
  }
  compactedRecently = true;
  // ... no tracking of failure vs success
}
```

**Problems:**
- When `compactWithLedger` fails, it silently falls back to basic compaction
- No logging of the original failure
- No tracking of compaction success/failure
- `compactedRecently` is set to `true` even if compaction partially failed
- Could lead to repeated failures and degraded performance

**Minimum Fix:**
```typescript
if (!compactedRecently && percentUsed >= this.config.compactTriggerPercent) {
  const llmConfig = this.resolveCompactionLlmConfig(agentType);
  let compactResult;
  let compactFailed = false;
  let usedLedger = false;

  if (llmConfig) {
    try {
      compactResult = await context.compactWithLedger({
        llm: this.llm,
        llmConfig,
        targetReductionRatio: 0.66,
        preserveRecentItems: 12,
        deduplicateByPath: true,
        maxFileContentCount: this.config.compactMaxFileCount,
        truncateOutputsTo: this.config.compactTruncateTo,
      });
      usedLedger = true;
    } catch (err) {
      this.log('warning', 'Compaction with ledger failed, falling back to basic compaction', {
        error: err instanceof Error ? err.message : String(err)
      });
      compactFailed = true;
      compactResult = context.compact({
        deduplicateByPath: true,
        maxFileContentCount: this.config.compactMaxFileCount,
        truncateOutputsTo: this.config.compactTruncateTo,
      });
    }
  } else {
    compactResult = context.compact({
      deduplicateByPath: true,
      maxFileContentCount: this.config.compactMaxFileCount,
      truncateOutputsTo: this.config.compactTruncateTo,
    });
  }

  compactedRecently = true;
  this.log('info', 'Auto-compacted context', {
    percentUsed,
    itemsRemoved: compactResult.itemsRemoved,
    bytesRecovered: compactResult.bytesRecovered,
    usedLedger,
    failed: compactFailed,
  });
}
```

---

### 4.3 Null/Undefined Structured Output Fields

**Where it occurs:**
```typescript
// packages/agent/src/agent.ts:371-373
const action = this.extractStructuredAction(structuredOutput);
const responseText = this.extractStructuredResponse(structuredOutput);
// ... later checks like:
const handoffSpec = typeof structuredOutput?.handoffSpec === 'string'
  ? structuredOutput.handoffSpec
  : null;
```

**Problem:**
- `structuredOutput` can be `null` or `undefined` if parsing fails
- `extractStructuredAction` and `extractStructuredResponse` methods are not shown in the file, but may not handle null
- Access to nested properties like `structuredOutput.handoffSpec` is guarded, but other accesses may not be

**Minimum Fix:**
Assuming `extractStructuredAction` and `extractStructuredResponse` are defined elsewhere, ensure they handle null:

```typescript
// packages/agent/src/agent.ts (in executeLoop)
// Add explicit null checks after parsing
const structuredOutput = this.parseStructuredOutput(content);
if (structuredOutput) {
  result.structuredOutput = structuredOutput;
}

// Ensure these methods handle null/undefined
const action = this.extractStructuredAction(structuredOutput); // Must handle null
const responseText = this.extractStructuredResponse(structuredOutput); // Must handle null
```

Check that `extractStructuredAction` and `extractStructuredResponse` exist and handle null (these methods are likely defined elsewhere in the file):

```typescript
// Add to Agent class if missing
private extractStructuredAction(structuredOutput: any): string | null {
  if (!structuredOutput || typeof structuredOutput !== 'object') return null;
  return structuredOutput.action ?? null;
}

private extractStructuredResponse(structuredOutput: any): string | null {
  if (!structuredOutput || typeof structuredOutput !== 'object') return null;
  return structuredOutput.response ?? null;
}
```

---

### 4.4 Missing Agent Registry Guard

**Where it occurs:**
```typescript
// packages/orchestrator/src/orchestrator.ts:657-660
private resolveCompactionLlmConfig(agentType: string): LLMRequestConfig | null {
  if (!this.agentRegistry?.has(agentType)) return null;
  // ...
}
```

**Problem:** This method correctly guards, but other places access `this.agentRegistry` without null checks:

```typescript
// Line 518
const allowedTools = [
  ...this.toolRegistry.getDefinitions(),
  ...(this.agentRegistry?.listToolDefinitions() ?? []), // ✅ Has guard
];

// Line 830
agentBudget = this.agentRegistry?.getConfig(agentType)?.budget; // ✅ Has guard
```

Actually, the code is mostly well-guarded. However, in `createAgent()`:

```typescript
// packages/orchestrator/src/orchestrator.ts:788-791
private createAgent(agentType: string): Agent | null {
  if (!this.agentRegistry?.has(agentType)) return null;
  let config = this.agentRegistry.getConfig(agentType); // ❌ Potential unsafe access
```

This is actually safe because the `has()` check is done first, but TypeScript may not infer the narrowing. The code is functionally correct but could be more explicit.

**Minimum Fix (for type safety):**
```typescript
private createAgent(agentType: string): Agent | null {
  // NO FALLBACK: If the requested agent type doesn't exist, fail explicitly
  if (!this.agentRegistry?.has(agentType)) return null;

  // Explicit narrowing for type safety
  const registry = this.agentRegistry; // Capture non-null reference
  let config = registry.getConfig(agentType);

  // Apply plan mode modifications if enabled
  if (this.planModeOptions?.enabled) {
    config = {
      ...config,
      systemPrompt: config.systemPrompt + this.planModeOptions.promptAddendum,
      tools: this.planModeOptions.toolFilter(config.tools),
    };
  }

  const llmConfig = this.buildLlmConfig(config.llmParams, agentType);

  return new Agent(config, {
    llm: this.llm,
    toolRegistry: this.toolRegistry,
    emit: this.emit,
    requestId: this.requestId,
    agentRegistry: this.agentRegistry,
    llmConfig,
    hooks: this.hooks,
    internalHookQueue: this.hookQueue,
    getModelSelection: this.getModelSelection,
  });
}
```

---

### 4.5 Unhandled Exceptions in Sub-Agent Execution

**Where it occurs:**
```typescript
// packages/agent/src/agent.ts:900-950 (executeAgentToolCall)
try {
  let toolResult = isAgentTool
    ? await this.executeAgentToolCall(normalizedCall, workItem, globalContext, localContext, cwd)
    : await this.toolRegistry.execute(canonicalName, effectiveArgs, { cwd });
  // ...
} catch (error) {
  // Catches toolRegistry.execute errors
  const message = error instanceof Error ? error.message : String(error);
  // ...
}
```

But `executeAgentToolCall` itself can throw:

```typescript
// packages/agent/src/agent.ts:949-977
private async executeAgentToolCall(...) {
  // ...
  try {
    agentConfig = this.agentRegistry.getConfig(call.name);
    const modelSelection = this.getModelSelection?.(agentConfig.type);
    if (!modelSelection) {
      return errorResult(...); // Returns, doesn't throw
    }
    // ...
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(call.name, message, 0); // Returns, doesn't throw
  }

  // ...
  const subAgent = new Agent(agentConfig, { ... });

  // ❌ Potential unhandled exception here
  const subResult = await subAgent.run({
    globalContext: mergedContext,
    workItem: subWorkItem,
    cwd,
  });
```

**Problem:**
- `subAgent.run()` is not wrapped in try-catch
- If `subAgent.run()` throws, the exception propagates up to `processToolCalls`
- The exception is then caught and treated as a tool error
- However, the `subResult` variable is never assigned, so `mergeSubAgentResults` is never called
- This means artifacts and file reads from the sub-agent are lost

**Minimum Fix:**
```typescript
// packages/agent/src/agent.ts:949-977
private async executeAgentToolCall(...) {
  // ... (existing config building code) ...

  const subAgent = new Agent(agentConfig, {
    llm: this.llm,
    toolRegistry: this.toolRegistry,
    emit: this.emit,
    requestId: this.requestId,
    agentRegistry: this.agentRegistry,
    llmConfig,
    hooks: this.hooks,
    internalHookQueue: this.internalHookQueue,
    getModelSelection: this.getModelSelection,
  });

  // ADD: Wrap sub-agent execution
  let subResult: AgentResult;
  try {
    subResult = await subAgent.run({
      globalContext: mergedContext,
      workItem: subWorkItem,
      cwd,
    });
  } catch (error) {
    // Convert uncaught exceptions to error result
    const message = error instanceof Error ? error.message : String(error);
    subResult = {
      success: false,
      response: '',
      error: message,
      metrics: {
        llmCallsMade: 0,
        toolCallsMade: 0,
        toolCallsSucceeded: 0,
        toolCallsFailed: 0,
        durationMs: 0,
      },
      filesRead: [],
      invalidatedPaths: [],
      toolErrors: [message],
      terminationReason: 'exception:sub_agent_failed',
      needsUserInput: false,
      isRefusal: false,
      localContext: mergedContext, // Preserve context
    };
  }

  // Merge results regardless of success/failure
  this.mergeSubAgentResults(parentLocalContext, subResult);

  if (subResult.success) {
    return successResult(call.name, subResult.response, subResult.metrics.durationMs);
  } else {
    return errorResult(call.name, subResult.error ?? 'Sub-agent execution failed', 0);
  }
}
```

---

## 5. State Transition Race Conditions

### 5.1 Parallel Execution Terminal State Priority

**Current behavior:**
```typescript
// packages/orchestrator/src/orchestrator.ts:418-521
// Process results and check for terminal conditions
let terminalResult: OrchestratorResult | null = null;

for (const { workId, item, result } of results) {
  // ... (process each result)

  if (!terminalResult) {
    // TERMINAL: User input needed
    if (result.needsUserInput && result.userPrompt) {
      terminalResult = this.createResult({...});
      continue;
    }

    // TERMINAL: Handoff requested
    if (result.needsHandoff && result.handoffSpec) {
      terminalResult = this.createResult({...});
      continue;
    }

    // ... more terminal conditions
  }
}

// Check if initial work completed after processing ALL results
if (initialWorkCompleted && this.workQueue.length === 0 && inProgress.size === 0) {
  // ... return goal_achieved
}

// If we hit a terminal condition, return it
if (terminalResult) {
  return terminalResult;
}
```

**Problem:**
- First work item to trigger a terminal condition wins (`if (!terminalResult)`)
- If two work items in parallel both need user input, only the first one is captured
- Other work items' `needsUserInput` and `userPrompt` are discarded
- This can lead to missing critical user prompts

**Example scenario:**
1. Work item A needs user input for file approval
2. Work item B (running in parallel) also needs user input for different question
3. Work item A finishes first → `terminalResult` is set
4. Work item B's user prompt is ignored

**Minimum Fix:**
Aggregate user prompts from all work items:

```typescript
// packages/orchestrator/src/orchestrator.ts
// In executeInner, before the results loop:

interface AggregatedUserPrompts {
  workId: string;
  userPrompt: UserPromptInfo;
}[] = [];

// Then in the results loop:

for (const { workId, item, result } of results) {
  // ... (existing processing)

  if (!terminalResult) {
    // TERMINAL: User input needed (aggregate all)
    if (result.needsUserInput && result.userPrompt) {
      aggregatedUserPrompts.push({ workId, userPrompt: result.userPrompt });
      // Don't set terminalResult yet - wait for all results
      continue;
    }

    // TERMINAL: Handoff requested (only one can request handoff)
    if (result.needsHandoff && result.handoffSpec) {
      this.log('info', 'Handoff requested', { workId, specLength: result.handoffSpec.length });
      context.addAgentResultContext(result);

      const specPreview = result.handoffSpec.length > 500
        ? result.handoffSpec.slice(0, 500) + '... [truncated]'
        : result.handoffSpec;

      terminalResult = this.createResult({
        success: true,
        response: '',
        paused: true,
        handoffSpec: result.handoffSpec,
        userPrompt: {
          question: 'The agent has completed planning and is ready to handoff to execution mode. Proceed with implementation?',
          options: ['Yes, handoff now', 'No, continue planning'],
          context: `## Handoff Spec Preview\n\n\`\`\`\n${specPreview}\n\`\`\`\n\n**Spec length:** ${result.handoffSpec.length} chars`,
          multiSelect: false,
          questionType: 'handoff_approval',
        },
        terminationReason: 'handoff_requested',
        metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
      });
      continue;
    }

    // ... (other terminal conditions)
  }

  // ... (rest of processing)
}

// After processing all results, check for aggregated user prompts
if (aggregatedUserPrompts.length > 0 && !terminalResult) {
  // Build combined prompt or return first one
  if (aggregatedUserPrompts.length === 1) {
    const { workId, userPrompt } = aggregatedUserPrompts[0];
    this.log('info', 'Pausing for user input', { workId, question: userPrompt.question });
    context.addAgentResultContext(this.completedWork.get(workId)!);
    terminalResult = this.createResult({
      success: false,
      response: '',
      paused: true,
      userPrompt,
      terminationReason: 'user_input_required',
      metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
    });
  } else {
    // Multiple work items need user input
    // For now, return the first one with a note about others
    const first = aggregatedUserPrompts[0];
    this.log('info', 'Multiple work items need user input', {
      count: aggregatedUserPrompts.length,
      firstWorkId: first.workId,
    });

    terminalResult = this.createResult({
      success: false,
      response: '',
      paused: true,
      userPrompt: {
        ...first.userPrompt,
        context: `**Note:** ${aggregatedUserPrompts.length} work items need user input. This is the first. Additional prompts will follow after this is resolved.\n\n${first.userPrompt.context || ''}`,
      },
      terminationReason: 'user_input_required',
      metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
    });
  }
}

// Continue with the rest of the logic
if (initialWorkCompleted && this.workQueue.length === 0 && inProgress.size === 0) {
  // ... (existing goal_achieved logic)
}

if (terminalResult) {
  return terminalResult;
}
```

---

## 6. Summary of Changes

### High Priority (Type Safety)
1. Create shared `AgentTerminationReason` union type
2. Update `AgentResult.terminationReason` to use the union type
3. Add `rate_limit` and `circuit_open` to orchestrator's `TerminationReason`

### Medium Priority (Missing State Handling)
4. Add explicit checks in orchestrator for:
   - `invalid_action`
   - `stagnation:tool_repeat`
   - `no_action`
5. Map these to appropriate orchestrator termination reasons

### Medium Priority (Error Handling)
6. Track hook timeouts
7. Log compaction failures
8. Wrap `subAgent.run()` in try-catch to preserve context

### Low Priority (Redundant State Cleanup)
9. Change `bounds:tool_calls` and `bounds:duration` to `iterations_exhausted`
10. Use underlying error from `RetriesExhaustedError` instead of creating new state

### Low Priority (Race Conditions)
11. Aggregate user prompts from parallel work items

---

## 7. File Change Checklist

### packages/shared/src/types.ts (new or update)
- [ ] Create `AgentTerminationReason` union type

### packages/agent/src/types.ts
- [ ] Update `AgentResult.terminationReason` type to `AgentTerminationReason`

### packages/orchestrator/src/orchestrator.ts
- [ ] Update `TerminationReason` to include `rate_limit` and `circuit_open`
- [ ] Add terminal checks for `invalid_action`, `stagnation:tool_repeat`, `no_action`
- [ ] Add terminal checks for `rate_limit` and `circuit_open`
- [ ] Add hook timeout tracking
- [ ] Add compaction failure logging
- [ ] Aggregate user prompts from parallel work items

### packages/agent/src/agent.ts
- [ ] Change `bounds:tool_calls` to `iterations_exhausted`
- [ ] Change `bounds:duration` to `iterations_exhausted`
- [ ] Update `RetriesExhaustedError` handling to use underlying error
- [ ] Add try-catch around `subAgent.run()` in `executeAgentToolCall`
- [ ] Ensure `extractStructuredAction` and `extractStructuredResponse` handle null

### packages/llm/src/resilience.ts (if applicable)
- [ ] Add `cause` property to `RetriesExhaustedError`

---

## 8. Testing Recommendations

1. Test agent termination with each new state
2. Test parallel execution where multiple work items need user input
3. Test hook timeout scenarios
4. Test compaction failures
5. Test sub-agent exceptions
6. Test rate limit and circuit breaker states
