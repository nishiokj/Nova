# Hot Path Systems-Level Analysis

## Executive Summary

The hot path is a **loop-until-goal architecture** with a **single-executor guard pattern** that routes user requests from the TUI through a multi-layer execution system. The flow is:

```
TUI → BridgeGateway → AgentHarness → Orchestrator → Agent → LLM/Tools
```

**Key Architectural Patterns:**
- **Single-executor guard**: Only one orchestrator runs per session at a time
- **Copy-on-write context**: Agents read from global context but write to local context
- **Event-driven streaming**: Events flow through EventBus for real-time TUI updates
- **Hysteresis-based compaction**: Context auto-compacts at 70% usage, resets at 70%
- **Message queuing**: Concurrent messages are queued and added to context immediately
- **Handoff fresh-start**: Planning-to-execution handoffs clear context for clean slate

---

## 1. Entry Point: BridgeGateway.handleSendText()

**Location**: `packages/harness-daemon/src/harness/bridge_gateway.ts:329`

### Function Signature
```typescript
handleSendText(
  connectionId: string,
  data: Record<string, unknown> | undefined,
  state: ConnectionState
): void
```

### Pre-Execution Validation
Before entering the hot path, the gateway performs three critical validations:

1. **Model Selection Check**
   - Retrieves: `activeSelection = harness.getSessionSelectedModel(sessionKey, 'standard')`
   - Validation: Both `model` and `provider` must be non-null
   - Failure: Sends error "No model selected. Use /models before sending."

2. **API Key Check**
   - Calls: `harness.hasApiKey(activeSelection.provider)`
   - Failure: Emits `provider_key_required` event with `{provider, model}`
   - This is non-blocking; user can provide key later

3. **State Preparation**
   - Mutations:
     - `state.activeRequestId = clientRequestId`
     - `state.planMode = data.planMode || state.planMode` (retained across requests)

### Entry to Hot Path
```typescript
const handle = harness.run({
  requestId: clientRequestId,
  inputText: text,
  tier,
  sessionKey,
  workingDir,
  planMode
});

streamRunEvents(clientRequestId, handle);
```

**State Mutations at Gateway Layer:**
- `state.activeRequestId` → set to track current request
- `state.planMode` → set from request or retained from previous
- No other mutations at this layer (pure routing)

---

## 2. Request Routing: AgentHarness.run()

**Location**: `packages/harness-daemon/src/harness/harness.ts:681`

### Function Signature
```typescript
run(params: AgentRunParams): AgentRunHandle
```

Where `AgentRunHandle = { result: Promise<AgentRunResult>, events: AsyncEventQueue }`

### Phase 0: Event Queue Creation
```typescript
const eventQueue = new AsyncEventQueue();
eventQueue.push(createStatusEvent('sending', 'Processing request...'));
```

**Purpose**: AsyncEventQueue provides immediate event streaming to TUI before orchestrator starts. Events are queued and consumed by `streamRunEvents()` in BridgeGateway.

### Phase 1: Session Pruning
```typescript
this.pruneSessionStores('run');
```
**State Mutation**: Removes stale sessions based on last access time. This is a side-effect that can remove other sessions' state.

### Phase 2: Session Store Retrieval/Creation
```typescript
const store = this.getOrCreateSessionStore(sessionKey);
```
**State Creation**: If session doesn't exist, creates new `SessionStore(sessionKey, maxTokens, graphd)`.
**State Retrieval**: If exists, returns existing store with preserved state.

### Phase 3: Execution Lock (Single-Executor Guard)

```typescript
if (!store.startExecution(requestId)) {
  // Another run is active - queue message instead
  store.queueUserMessage(requestId, inputText);
  this.persistUserMessage(sessionKey, requestId, inputText);
  eventQueue.push(createStatusEvent('idle', 'Message queued'));
  return { result: Promise.resolve({ queued: true }), events: eventQueue };
}
```

**This is the critical concurrency control point.**

**SessionStore.startExecution()** (session_store.ts:95):
```typescript
startExecution(requestId: string): boolean {
  if (this.executingRequestId !== null) {
    return false; // Another execution is active
  }
  this.executingRequestId = requestId;
  return true;
}
```

**State Mutations:**
- `store.executingRequestId = requestId` (if no active execution)
- **No mutation** if another execution is active (returns false)

**If Lock Held (Concurrent Request):**

1. **Queue Message**:
   ```typescript
   store.queueUserMessage(requestId, inputText);
   ```
   
   **SessionStore.queueUserMessage()** (session_store.ts:120):
   ```typescript
   queueUserMessage(requestId: string, message: string): void {
     this.queuedUserMessages.push({ requestId, message });
     // Add to context immediately so agent sees it on next turn
     const ctx = this.getContext();
     ctx.addMessage('user', message);
   }
   ```
   
   **Critical Design Decision**: Queued messages are added to context **immediately**, not just stored for later. This ensures the running agent sees the message on its next LLM call, creating a "peek" capability for concurrent users.

   **State Mutations:**
   - `store.queuedUserMessages.push({requestId, message})`
   - `store.context.items.push({role: 'user', content: message})` (via getContext().addMessage())

2. **Persist Message**:
   ```typescript
   this.persistUserMessage(sessionKey, requestId, inputText);
   ```
   Side-effect: Persists to GraphD for durability.

3. **Early Return**:
   ```typescript
   return { result: Promise.resolve({ queued: true }), events: eventQueue };
   ```
   Returns immediately with `queued: true` flag. TUI receives queued status.

### Phase 4: GraphD Session Touch (If Available)
```typescript
if (this.isGraphDReady()) {
  store.touch(workingDir);
  this.graphd.setActive(true);
}
```

**State Mutations:**
- Updates GraphD session last_accessed timestamp
- `this.graphd.active = true`

### Phase 5: Context Setup
```typescript
const contextWindow = store.getContext();
contextWindow.addMessage('user', inputText);
```

**SessionStore.getContext()** (session_store.ts:59):
```typescript
getContext(): ContextWindow {
  if (this.context !== null) {
    return this.context;
  }
  
  // Hydrate from GraphD if available
  const persisted = this.graphd?.contextGet(this.sessionKey);
  if (persisted) {
    this.context = ContextWindow.deserialize(persisted);
  } else {
    this.context = new ContextWindow(this.maxTokens);
  }
  
  return this.context;
}
```

**Critical State Behavior:**
- **First call**: Hydrates from GraphD or creates fresh ContextWindow
- **Subsequent calls**: Returns cached context (no mutation)
- **Hydration**: Restores message history and metrics from previous sessions

**State Mutations:**
- `store.context = ContextWindow.deserialize(persisted)` (on first call, if persisted data exists)
- `store.context.items.push({role: 'user', content: inputText})` (via addMessage)

### Phase 6: Event Subscription
```typescript
const emit = createEventEmitCallback(this.eventBus, requestId, runId, sessionKey);
const unsubscribe = this.eventBus.subscribeRun(runId, translateAgentEvent);
```

**Event Flow Architecture:**
```
Agent.emit() → EventBus → translateAgentEvent() → TUI
```

**EventTranslator** (event_translator.ts:16):
- Translates `AgentEvent` → `BridgeEvent` for TUI consumption
- Returns `null` for internal events (e.g., `llm_call`)
- Handles `tool_call` with two phases: `starting` and `completed`

**No state mutations at this layer** (pure event routing).

### Phase 7: Hook Execution (UserPromptSubmit)
```typescript
if (this.hookExecutor) {
  const hookResult = await this.hookExecutor.execute('UserPromptSubmit', hookContext);
  if (hookResult.action === 'block') {
    return { success: false, finalText: hookResult.message };
  }
}
```

**Pre-execution hook** that can block the request entirely. Used for:
- Rate limiting
- Content moderation
- Custom validation

**No state mutations** (pure side-effect block).

### Phase 8: Model Selection Hydration
```typescript
if (store.getAllModelSelections().size === 0 && this.isGraphDReady()) {
  const session = this.graphd.sessionGet(sessionKey);
  const modelSelections = session?.metadata?.model_selections;
  for (const [agentType, selection] of Object.entries(modelSelections)) {
    store.setModelSelection(agentType, selection);
  }
}
```

**State Mutation**: Populates `store.modelSelections` Map from GraphD session metadata.
**Purpose**: Restores user's model preferences for different agent types.

### Phase 9: Main Orchestrator Execution

```typescript
let result = await this.runOrchestrator(
  contextWindow, inputText, requestId, emit, 
  this.llmAdapter, tier, workingDir, planMode, store, stopHook
);
```

**Orchestrator Execution** detailed in Section 4.

### Phase 10: Queued Message Continuation Loop

```typescript
while (!result.paused) {
  const queuedMessages = store.drainQueuedMessages();
  if (queuedMessages.length === 0) {
    if (store.endExecutionIfIdle()) break;
    const lateQueued = store.drainQueuedMessages();
    if (lateQueued.length === 0) break;
  }
  
  result = await this.runOrchestrator(
    contextWindow, inputText, requestId, emit,
    this.llmAdapter, tier, workingDir, planMode, store, stopHook
  );
}
```

**This loop processes messages that arrived during execution.**

**SessionStore.drainQueuedMessages()**:
```typescript
drainQueuedMessages(): Array<{ requestId: string; message: string }> {
  const messages = [...this.queuedUserMessages];
  this.queuedUserMessages = [];
  return messages;
}
```

**State Mutations:**
- `store.queuedUserMessages = []` (empties queue)

**SessionStore.endExecutionIfIdle()** (inferred):
- Likely checks if orchestrator completed all work
- Returns `true` if idle, `false` if more work pending

**Critical Behavior**: This loop enables "burst" processing. If multiple messages arrive during execution, they're all processed in a single session continuation without releasing the execution lock.

### Phase 11: Handoff Handling

```typescript
if (result.handoffSpec && store) {
  const freshContext = store.clearContext();
  store.clearPausedState();
  
  return this.runOrchestrator(
    freshContext, result.handoffSpec, requestId, emit,
    this.llmAdapter, 'standard', workingDir,
    false, // planMode: false - execution mode
    store, undefined
  );
}
```

**Handoff Scenario**: Planning agent produces `handoffSpec` with execution instructions.

**SessionStore.clearContext()** (session_store.ts:84):
```typescript
clearContext(): ContextWindow {
  this.context = new ContextWindow(this.maxTokens);
  return this.context;
}
```

**Critical Divergence**: Context is **cleared completely** for handoff. This creates a fresh start for the execution phase, preventing planning history from polluting execution.

**State Mutations:**
- `store.context = new ContextWindow(this.maxTokens)` (fresh, empty context)
- `store.pausedState = null` (via clearPausedState)

### Phase 12: Error Handling (Finally Block)

```typescript
try {
  // ... orchestrator execution ...
} catch (error) {
  if (RateLimitError.isRateLimitError(error)) {
    store.persistContext();
    return { success: false, finalText: userMessage };
  }
  if (error instanceof CircuitOpenError) {
    store.persistContext();
    return { success: false, finalText: userMessage };
  }
  // ... other error handling ...
} finally {
  // === CLEANUP ===
  const queuedMessages = store.endExecution();
  unsubscribe();
  store.persistContext();
  this.graphdSubscriber?.flush();
  this.graphd?.setActive(false);
  eventQueue.finish();
}
```

**SessionStore.endExecution()** (session_store.ts:113):
```typescript
endExecution(): Array<{ requestId: string; message: string }> {
  const messages = [...this.queuedUserMessages];
  this.executingRequestId = null;
  this.queuedUserMessages = [];
  return messages;
}
```

**Critical State Mutation**: `store.executingRequestId = null` releases the execution lock, allowing new requests to proceed.

**State Mutations in Finally Block:**
- `store.executingRequestId = null` (release lock)
- `store.queuedUserMessages = []` (clear remaining queue)
- `store.context` → persisted to GraphD (no mutation, side-effect)
- `this.graphd.active = false`
- `eventQueue.finished = true`

**Important**: Messages drained in `endExecution()` are **lost**. They were not processed. This is a data loss scenario if the loop in Phase 10 doesn't catch them.

### Phase 13: Return

```typescript
return { result: resultPromise, events: eventQueue };
```

**AgentRunHandle** structure:
- `result`: Promise resolving to `AgentRunResult`
- `events`: AsyncEventQueue for real-time TUI streaming

---

## 3. State Management: SessionStore

**Location**: `packages/harness-daemon/src/harness/session_store.ts`

### Primary State Container

SessionStore is the **primary state container** for each session. It manages:

1. **Execution State**
   - `executingRequestId: string | null` - Currently active request ID (null = unlocked)
   - `pausedState: PausedState | null` - Paused execution state for resume flow

2. **Message Queue**
   - `queuedUserMessages: Array<{ requestId: string; message: string }>` - Messages that arrived during active execution

3. **Context**
   - `context: ContextWindow | null` - Conversation history and metrics

4. **Configuration**
   - `modelSelections: Map<string, ModelSelection>` - Per-agent-type model preferences

5. **Metadata**
   - `sessionKey: string` - Unique session identifier
   - `maxTokens: number` - Context window size limit
   - `graphd: GraphDManager | null` - GraphD integration for persistence

### Key Methods and State Mutations

#### startExecution(requestId: string): boolean
```typescript
startExecution(requestId: string): boolean {
  if (this.executingRequestId !== null) {
    return false; // Another execution is active
  }
  this.executingRequestId = requestId;
  return true;
}
```
**State Mutation**: `executingRequestId = requestId`
**Purpose**: Acquire execution lock. Prevents concurrent orchestrator execution.

#### queueUserMessage(requestId: string, message: string): void
```typescript
queueUserMessage(requestId: string, message: string): void {
  this.queuedUserMessages.push({ requestId, message });
  // Add to context immediately so agent sees it on next turn
  const ctx = this.getContext();
  ctx.addMessage('user', message);
}
```
**State Mutations**:
- `queuedUserMessages.push({requestId, message})`
- `context.items.push({role: 'user', content: message})` (via getContext().addMessage)

**Critical Design**: Message is added to context **immediately**, enabling the running agent to see it on its next LLM call. This creates a "peek" capability for concurrent users.

#### drainQueuedMessages(): Array<{ requestId: string; message: string }>
```typescript
drainQueuedMessages(): Array<{ requestId: string; message: string }> {
  const messages = [...this.queuedUserMessages];
  this.queuedUserMessages = [];
  return messages;
}
```
**State Mutation**: `queuedUserMessages = []`
**Purpose**: Empty queue for processing. Returns copy of messages.

#### endExecution(): Array<{ requestId: string; message: string }>
```typescript
endExecution(): Array<{ requestId: string; message: string }> {
  const messages = [...this.queuedUserMessages];
  this.executingRequestId = null;
  this.queuedUserMessages = [];
  return messages;
}
```
**State Mutations**:
- `executingRequestId = null` (release lock)
- `queuedUserMessages = []` (clear queue)

**Purpose**: Release execution lock and clear remaining queue. Messages returned were **not processed** (potential data loss).

#### getContext(): ContextWindow
```typescript
getContext(): ContextWindow {
  if (this.context !== null) {
    return this.context;
  }
  
  // Hydrate from GraphD if available
  const persisted = this.graphd?.contextGet(this.sessionKey);
  if (persisted) {
    this.context = ContextWindow.deserialize(persisted);
  } else {
    this.context = new ContextWindow(this.maxTokens);
  }
  
  return this.context;
}
```
**State Mutation**: `context = ContextWindow.deserialize(persisted)` (on first call, if persisted data exists)
**Purpose**: Lazy initialization with GraphD hydration for session resumption.

#### clearContext(): ContextWindow
```typescript
clearContext(): ContextWindow {
  this.context = new ContextWindow(this.maxTokens);
  return this.context;
}
```
**State Mutation**: `context = new ContextWindow(this.maxTokens)`
**Purpose**: Complete context replacement. Used for handoff transitions. Old context is **lost** (not persisted).

#### persistContext(): void
```typescript
persistContext(): void {
  if (this.context && this.graphd) {
    this.graphd.contextSet(this.sessionKey, this.context.serialize());
  }
}
```
**State Mutation**: None (side-effect to GraphD)
**Purpose**: Durability for session resumption across restarts.

---

## 4. Orchestrator Execution: runOrchestrator()

**Location**: `packages/harness-daemon/src/harness/harness.ts:787`

### Function Signature
```typescript
private async runOrchestrator(
  context: ContextWindow,
  goal: string,
  requestId: string,
  emit: EventEmitCallback,
  llm: LLMAdapter,
  agentType: string,
  workingDir?: string,
  planMode?: boolean,
  store?: SessionStore,
  stopHook?: StopHookHandler
): Promise<AgentRunResult>
```

### Wrapper Responsibilities

1. **Agent Hooks Creation**
   - Creates pre/post hooks for agent lifecycle
   - Integrates with hookExecutor for extension points

2. **Model Selection**
   - Retrieves model selection from store for given agentType
   - Falls back to default if not configured

3. **LlmConfig Building**
   - Constructs LLM configuration with model, provider, API key
   - Passes to Orchestrator

4. **Orchestrator Instantiation and Execution**
   ```typescript
   const orchestrator = new Orchestrator({
     agentType,
     workingDir,
     llm,
     eventBus: this.eventBus,
     // ... other config
   });
   
   const result = await orchestrator.execute(
     context, goal, agentType, workingDir
   );
   ```

5. **Handoff State Management**
   - If result includes `handoffSpec`, stores it in `store.pausedState`
   - This is retrieved in harness.run() for handoff execution

**State Mutations**:
- `store.pausedState = result.handoffSpec` (if handoffSpec present)
- `context` mutated by orchestrator.execute() (see Section 5)

---

## 5. Orchestrator: Loop-Until-Goal Engine

**Location**: `packages/orchestrator/src/orchestrator.ts:268`

### Function Signature
```typescript
async execute(
  context: ContextWindow,
  goal: string,
  agentType: string,
  cwd: string
): Promise<OrchestratorResult>
```

### Core Algorithm: Loop-Until-Goal

```typescript
while (true) {
  // 1. Dequeue ready work items
  const readyItems = this.workQueue.dequeueAllReady();
  
  // 2. Process each ready item with agent
  for (const item of readyItems) {
    const agent = this.createAgent(agentType);
    const agentResult = await agent.run({
      context,
      goal: item.description,
      cwd,
      agentType,
      planMode,
      stopHook
    });
    
    // 3. Add agent result to context
    this.addAgentResultContext(context, agentResult);
    
    // 4. Update metrics
    this.updateMetrics(context, agentResult);
  }
  
  // 5. Auto-compact context if near full (hysteresis)
  if (context.isNearFull()) {
    context = this.compactWithLedger(context);
  }
  
  // 6. Check if goal achieved
  if (this.isGoalAchieved()) {
    break;
  }
  
  // 7. If no more work items, break
  if (this.workQueue.isEmpty()) {
    break;
  }
}
```

### State Mutations in Orchestrator

1. **Context Window**
   - `context.items` - Agent results added via `addAgentResultContext()`
   - `context.metrics` - Updated via `updateMetrics()`
   - `context.ledger` - Updated during compaction via `compactWithLedger()`

2. **Work Queue**
   - `this.workQueue` - Dequeued items in `dequeueAllReady()`
   - `this.completedWork` - Marked items moved here after processing
   - `this.inProgress` - Items currently being processed

3. **Metrics**
   - `this.metrics` - Updated with agent execution statistics

### Artifact Stitching

Orchestrator subscribes to `artifact_discovered` events from EventBus:

```typescript
this.eventBus.subscribe('artifact_discovered', (event) => {
  // Stitch artifact into context in real-time
  context.addArtifact(event.artifact);
});
```

**Purpose**: Enables agents to see artifacts discovered by other agents in the same session without waiting for full agent execution to complete.

### Auto-Compaction with Hysteresis

```typescript
if (context.isNearFull()) {  // Typically 70% of maxTokens
  context = this.compactWithLedger(context);
}
```

**Hysteresis Pattern**:
- **Trigger**: Context reaches 70% of maxTokens
- **Reset**: After compaction, context drops to ~30% of maxTokens
- **Prevent**: Avoids constant re-compaction at boundary conditions

**Compaction Strategy**:
- Keeps recent N messages (e.g., last 10)
- Summarizes older messages using ledger
- Preserves critical metadata (tools, artifacts, metrics)

### Stop Hook Execution (Ralph Loop)

Before returning `goal_achieved`, orchestrator executes stop hook:

```typescript
if (stopHook) {
  const stopResult = await stopHook(context);
  if (stopResult.action === 'continue') {
    // Continue execution (not a real stop)
    continue;
  }
}
```

**Purpose**: Validates that execution should truly stop. Used for:
- Safety checks (Ralph Loop)
- Invariant validation
- Custom termination logic

**No state mutations** (pure validation).

---

## 6. Agent Execution: Pure Execution Primitive

**Location**: `packages/agent/src/agent.ts:193`

### Function Signature
```typescript
async run(params: AgentRunParams): Promise<AgentResult>
```

### Copy-on-Write Context Pattern

```typescript
const localContext = new ContextWindow(params.globalContext.maxTokens);
// Copy read state from global context
localContext.items = [...params.globalContext.items];
localContext.metrics = { ...params.globalContext.metrics };
```

**Critical Design**: Agent **never mutates globalContext**. All mutations are to `localContext`, which is returned in `AgentResult.localContext`.

**Purpose**: Isolates agent execution mutations, allowing Orchestrator to decide which changes to commit.

### Execution Loop: executeLoop()

**Location**: `packages/agent/src/agent.ts:247`

```typescript
async executeLoop(
  globalContext: ContextWindow,
  localContext: ContextWindow,
  workItem: WorkItem,
  result: AgentResult,
  metrics: AgentMetrics,
  startTime: number,
  cwd: string
): Promise<void> {
  let iteration = 0;
  const maxIterations = 10; // Safety limit
  
  while (iteration < maxIterations) {
    // 1. Auto-read target files if specified
    await this.autoReadTargetFiles(workItem, globalContext, localContext, cwd);
    
    // 2. Check if near full, auto-compact
    if (localContext.isNearFull()) {
      localContext = this.compactWithLedger(localContext);
    }
    
    // 3. Build system message and messages
    const systemMessage = this.buildSystemMessage(workItem, localContext);
    const messages = this.buildMessages(globalContext, localContext, workItem);
    
    // 4. Stream LLM with resilience (retry logic)
    const llmResponse = await this.streamWithResilience(
      systemMessage,
      messages,
      iteration === maxIterations - 1, // Last iteration: tool_choice=none
      emit
    );
    
    // 5. Add assistant message to context
    this.addAssistantMessage(localContext, llmResponse.content);
    
    // 6. Extract structured outputs
    const action = this.extractStructuredAction(llmResponse.content);
    const response = this.extractStructuredResponse(llmResponse.content);
    const userPrompt = this.extractStructuredUserPrompt(llmResponse.content);
    
    // 7. Process tool calls
    if (action.toolCalls && action.toolCalls.length > 0) {
      await this.processToolCalls(
        action.toolCalls,
        globalContext,
        localContext,
        localReadFiles,
        result,
        metrics,
        workItem,
        cwd
      );
    }
    
    // 8. Handle completion action
    if (action.action === 'complete') {
      this.finalizeIteration(result, localContext, response);
      break;
    }
    
    iteration++;
  }
  
  // Synthesize partial response if max iterations reached
  if (iteration === maxIterations) {
    result.finalText = await this.synthesizePartialResponse(localContext);
  }
}
```

### State Mutations in Agent

1. **Local Context**
   - `localContext.items` - Messages added (user, assistant, tool results)
   - `localContext.metrics` - Updated with execution statistics
   - `localContext.ledger` - Updated during compaction

2. **Agent Result**
   - `result.finalText` - Set from LLM response or synthesis
   - `result.toolCalls` - Array of tool calls executed
   - `result.localContext` - Copy of localContext for upstream consumption

3. **Metrics**
   - `metrics.iterations` - Incremented each loop
   - `metrics.llmCalls` - Incremented each LLM call
   - `metrics.toolCalls` - Incremented each tool call
   - `metrics.tokensUsed` - Summed from LLM responses

4. **Local Read Files**
   - `localReadFiles` - Set of file paths read in this execution
   - **Purpose**: Prevent duplicate reads in same execution

### Tool Call Processing

**Location**: `packages/agent/src/agent.ts:573`

```typescript
async processToolCalls(
  toolCalls: Array<{id: string; name: string; arguments: Record<string, unknown>}>,
  globalContext: ContextWindow,
  localContext: ContextWindow,
  localReadFiles: Set<string>,
  result: AgentResult,
  metrics: AgentMetrics,
  workItem: WorkItem,
  cwd: string,
  workItemId?: string,
  toolRepeatState?: {lastKey: string; lastOutput: string; repeats: number}
): Promise<void>
```

### Parallel Batch Execution

```typescript
// Separate safe (parallel) and unsafe (serial) tool calls
const safeToolCalls = toolCalls.filter(call => this.isParallelSafe(call.name));
const unsafeToolCalls = toolCalls.filter(call => !this.isParallelSafe(call.name));

// Execute safe tools in parallel
const safeResults = await Promise.all(
  safeToolCalls.map(call => this.executeToolCall(call, ...))
);

// Execute unsafe tools serially
for (const call of unsafeToolCalls) {
  const result = await this.executeToolCall(call, ...);
}
```

**Parallel Safe Tools**: Read-only tools that don't mutate state (e.g., `read_file`, `list_files`)
**Parallel Unsafe Tools**: Mutating tools (e.g., `write_file`, `bash`)

### Tool Call Hooks

1. **Pre-Tool-Use Hook**:
   ```typescript
   if (hooks.preToolUse) {
     const hookResult = await hooks.preToolUse(toolCall, context);
     if (hookResult.action === 'block') {
       // Skip tool execution
       continue;
     }
     if (hookResult.modifiedArgs) {
       toolCall.arguments = hookResult.modifiedArgs;
     }
   }
   ```
   
   **Purpose**: Can block tool execution or modify arguments. Used for:
   - Safety checks
   - Rate limiting
   - Argument validation

2. **Post-Tool-Use Hook**:
   ```typescript
   if (hooks.postToolUse) {
     const hookResult = await hooks.postToolUse(toolCall, toolResult, context);
     if (hookResult.modifiedResult) {
       toolResult = hookResult.modifiedResult;
     }
   }
   ```
   
   **Purpose**: Can modify tool result. Used for:
   - Output sanitization
   - Result enrichment
   - Error transformation

### Output Truncation

```typescript
if (toolCall.name === 'read_file' && result.length > 30000) {
  result = result.substring(0, 30000) + '\n\n... [truncated]';
} else if (result.length > 8000) {
  result = result.substring(0, 8000) + '\n\n... [truncated]';
}
```

**Purpose**: Prevents tool results from overwhelming context window.
**Special Case**: `read_file` allows 30KB (larger for code), others limited to 8KB.

### Stagnation Detection

```typescript
if (toolRepeatState) {
  const key = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
  if (key === toolRepeatState.lastKey && result === toolRepeatState.lastOutput) {
    toolRepeatState.repeats++;
    if (toolRepeatState.repeats > 3) {
      // Tool stagnation detected
      emit('stagnation_detected', { toolCall, repeats: toolRepeatState.repeats });
      break;
    }
  } else {
    toolRepeatState = { lastKey: key, lastOutput: result, repeats: 1 };
  }
}
```

**Purpose**: Detects infinite loops where agent repeatedly calls same tool with same arguments and gets same result.

---

## 7. Event Flow Architecture

### Event Types

**Agent Events** (emitted by Agent):
- `llm_call` - LLM request/response (not forwarded to TUI)
- `tool_call_starting` - Tool call started
- `tool_call_completed` - Tool call finished
- `artifact_discovered` - File/code artifact found
- `stagnation_detected` - Tool stagnation detected
- `error` - Error occurred

**Bridge Events** (forwarded to TUI):
- `status` - Status update (e.g., "Processing request...")
- `tool_call` - Tool call with two phases (starting/completed)
- `artifact` - Artifact discovered
- `error` - Error message
- `done` - Execution completed

### Event Translation

**Location**: `packages/harness-daemon/src/harness/event_translator.ts:16`

```typescript
translateAgentEvent(event: AgentEvent): BridgeEvent | null {
  switch (event.type) {
    case 'llm_call':
      return null; // Don't forward LLM calls to TUI
    case 'tool_call_starting':
      return {
        type: 'tool_call',
        phase: 'starting',
        tool: event.tool,
        args: event.args
      };
    case 'tool_call_completed':
      return {
        type: 'tool_call',
        phase: 'completed',
        tool: event.tool,
        result: event.result
      };
    // ... other translations
  }
}
```

**Purpose**: Converts internal agent events to TUI-consumable format, filtering out sensitive/verbose events.

### Event Bus

```typescript
// Subscribe to agent events
const unsubscribe = eventBus.subscribeRun(runId, translateAgentEvent);

// Emit events from agent
emit('tool_call_starting', { tool: 'read_file', args: { path: 'foo.ts' } });
```

**Event Flow**:
```
Agent.emit() → EventBus → translateAgentEvent() → BridgeEvent → TUI via WebSocket
```

**State Mutations**: None (pure event routing).

---

## 8. Critical Divergences and Edge Cases

### Divergence 1: Message Queuing Behavior

**Standard Path**:
```
Message arrives → Execution lock acquired → Orchestrator executes
```

**Concurrent Path**:
```
Message arrives during execution → Queued → Added to context immediately → Processed in continuation loop
```

**Critical**: Queued messages are added to context **before** the running agent sees them. This creates a "peek" capability where the agent can respond to messages that arrived mid-execution.

**Potential Issue**: If the continuation loop doesn't run (e.g., orchestrator completes before loop starts), messages in queue are lost.

### Divergence 2: Handoff Fresh Start

**Standard Path**:
```
Planning → Execution (with planning history)
```

**Handoff Path**:
```
Planning → HandoffSpec → Context cleared → Execution (fresh start, no planning history)
```

**Critical**: Handoff creates a **fresh context**. Planning history is **lost**. This is intentional for clean execution but prevents execution agent from seeing planning reasoning.

**State Mutation**: `store.context = new ContextWindow(maxTokens)` (complete replacement, not mutation).

### Divergence 3: Context Compaction Strategies

**Agent-Level Compaction**:
- Trigger: Local context near full
- Action: Compact local context only
- Scope: Single agent execution

**Orchestrator-Level Compaction**:
- Trigger: Global context near full
- Action: Compact global context with ledger
- Scope: All agents in session

**Critical**: Agent compaction is local and temporary. Orchestrator compaction is global and persisted. This creates a two-tier compaction strategy.

### Divergence 4: Stop Hook Behavior

**Standard Stop**:
```
Goal achieved → Stop hook executes → Return result
```

**Continue Stop**:
```
Goal achieved → Stop hook executes → Hook returns "continue" → Continue execution loop
```

**Critical**: Stop hook can override goal achievement, forcing continued execution. Used for Ralph Loop safety validation.

### Divergence 5: Error Handling Persistence

**Rate Limit Error**:
```
Error → Context persisted → Return failure with user message
```

**Circuit Breaker Error**:
```
Error → Context persisted → Return failure with user message
```

**Other Errors**:
```
Error → Re-throw → Finally block executes context persistence → Terminate
```

**Critical**: Rate limit and circuit breaker errors **persist context** for retry. Other errors also persist (in finally block) but may leave system in inconsistent state.

---

## 9. State Mutation Summary

### SessionStore State Mutations

| Method | State Mutated | Purpose |
|--------|--------------|---------|
| `startExecution()` | `executingRequestId = requestId` | Acquire execution lock |
| `queueUserMessage()` | `queuedUserMessages.push(...)`, `context.items.push(...)` | Queue message and add to context immediately |
| `drainQueuedMessages()` | `queuedUserMessages = []` | Empty queue for processing |
| `endExecution()` | `executingRequestId = null`, `queuedUserMessages = []` | Release lock and clear queue |
| `getContext()` | `context = ContextWindow.deserialize(...)` (first call) | Lazy initialization with GraphD hydration |
| `clearContext()` | `context = new ContextWindow(maxTokens)` | Complete context replacement (handoff) |
| `persistContext()` | None (side-effect to GraphD) | Durability |

### Orchestrator State Mutations

| Component | State Mutated | Purpose |
|-----------|--------------|---------|
| `context` | `items.push(...)` (agent results) | Add agent execution results |
| `context` | `metrics.update(...)` | Update execution statistics |
| `context` | `ledger.update(...)` (during compaction) | Update ledger for compaction |
| `workQueue` | `dequeueAllReady()` | Remove ready items from queue |
| `workQueue` | `completedWork.push(...)` | Mark items as completed |
| `metrics` | Update with agent statistics | Track orchestration metrics |

### Agent State Mutations

| Component | State Mutated | Purpose |
|-----------|--------------|---------|
| `localContext.items` | `push(...)` (user, assistant, tool results) | Add messages to context |
| `localContext.metrics` | Update with execution statistics | Track agent metrics |
| `localContext.ledger` | Update during compaction | Update ledger for compaction |
| `result.finalText` | Set from LLM response or synthesis | Final output text |
| `result.toolCalls` | `push(...)` (executed tool calls) | Track tool calls |
| `result.localContext` | Copy of localContext | Return mutated context |
| `localReadFiles` | `add(...)` (file paths) | Track read files for deduplication |
| `metrics` | Increment counters (iterations, llmCalls, toolCalls, tokensUsed) | Track agent metrics |

### Global State Mutations (None)

**Critical**: Agent **never mutates globalContext**. All mutations are to localContext. GlobalContext is only mutated by Orchestrator (via `addAgentResultContext()`).

---

## 10. Data Flow Diagrams

### Request Flow

```
┌─────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   TUI   │────▶│BridgeGateway │────▶│AgentHarness  │────▶│Orchestrator  │
└─────────┘     └──────────────┘     └──────────────┘     └──────────────┘
                     │                      │                      │
                     ▼                      ▼                      ▼
              Validate Model          SessionStore            Agent(s)
              Validate API Key        startExecution()       execute()
              Set State
```

### State Mutation Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SessionStore                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │
│  │ executingReqId  │  │ queuedMessages  │  │    context      │   │
│  │ (null or id)    │  │   (array)       │  │ (ContextWindow) │   │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘   │
│           │                    │                    │              │
└───────────┼────────────────────┼────────────────────┼──────────────┘
            │                    │                    │
    ┌───────▼───────┐    ┌───────▼───────┐    ┌───────▼───────┐
    │ startExecution│    │queueUserMessage│    │  getContext   │
    └───────────────┘    └───────────────┘    └───────────────┘
            │                    │                    │
    ┌───────▼───────┐    ┌───────▼───────┐    ┌───────▼───────┐
    │ Set executing │    │ Push to queue │    │ Hydrate from  │
    │ RequestId     │    │ Add to context│    │ GraphD or new │
    └───────────────┘    └───────────────┘    └───────────────┘
                                                 │
                                                 ▼
                                    ┌───────────────────────┐
                                    │   ContextWindow        │
                                    │  ┌─────────────────┐  │
                                    │  │     items       │  │
                                    │  │ (message array) │  │
                                    │  └────────┬────────┘  │
                                    │  ┌────────▼────────┐  │
                                    │  │    metrics      │  │
                                    │  └─────────────────┘  │
                                    └───────────────────────┘
```

### Event Flow

```
┌──────────┐     ┌──────────┐     ┌───────────┐     ┌──────────┐
│  Agent   │────▶│ EventBus │────▶│Translator │────▶│   TUI    │
└──────────┘     └──────────┘     └───────────┘     └──────────┘
     │                                 │
     ▼                                 ▼
┌──────────┐                     ┌───────────┐
│llm_call  │                     │  null     │ (filtered)
│tool_call │                     │tool_call  │ (translated)
│artifact  │                     │artifact   │ (translated)
└──────────┘                     └───────────┘
```

---

## 11. Key Performance Characteristics

### Concurrency Control

**Single-Executor Guard**: Only one orchestrator runs per session at a time.
- **Benefit**: Prevents resource contention and state corruption
- **Drawback**: Serializes concurrent requests for same session

**Message Queuing**: Concurrent messages are queued and added to context immediately.
- **Benefit**: Agent can respond to mid-execution messages
- **Drawback**: Potential data loss if continuation loop doesn't run

### Context Management

**Copy-on-Write**: Agents read from global context but write to local context.
- **Benefit**: Isolates mutations, allows selective commit
- **Drawback**: Doubles memory usage during execution

**Auto-Compaction**: Context auto-compacts at 70% usage with hysteresis.
- **Benefit**: Prevents context overflow without manual intervention
- **Drawback**: Loss of historical context (summarized instead)

### Tool Execution

**Parallel Batching**: Safe tools executed in parallel, unsafe tools serial.
- **Benefit**: Reduces latency for read operations
- **Drawback**: Complex parallel/serial mixing logic

**Output Truncation**: Tool results truncated at 30KB (read_file) or 8KB (others).
- **Benefit**: Prevents context overflow from large tool outputs
- **Drawback**: Loss of data from truncated results

---

## 12. Failure Modes and Recovery

### Concurrent Request Loss

**Scenario**: Multiple messages arrive during execution, but continuation loop doesn't run.

**Detection**: `store.endExecution()` returns non-empty message array.

**Impact**: Messages were added to context but never processed by orchestrator.

**Recovery**: None (data loss). Messages are persisted to GraphD but not executed.

### Handoff Context Loss

**Scenario**: Handoff occurs, planning history is lost.

**Detection**: `store.clearContext()` called during handoff.

**Impact**: Execution agent cannot see planning reasoning.

**Recovery**: None (intentional design).

### Compaction Data Loss

**Scenario**: Context auto-compacts, historical messages summarized.

**Detection**: `compactWithLedger()` called.

**Impact**: Loss of fine-grained historical context.

**Recovery**: Summaries preserved in ledger, but original messages lost.

### Tool Result Truncation

**Scenario**: Tool output exceeds truncation limit.

**Detection**: Tool result ends with "... [truncated]".

**Impact**: Loss of truncated data.

**Recovery**: None (intentional design to prevent overflow).

---

## 13. Conclusion

The hot path is a sophisticated multi-layer execution system with careful state management, concurrency control, and event-driven streaming. Key architectural decisions include:

1. **Single-executor guard** prevents concurrent orchestrator execution
2. **Copy-on-write context** isolates agent mutations
3. **Immediate context addition** for queued messages enables peek capability
4. **Handoff fresh start** creates clean execution phase
5. **Hysteresis-based compaction** prevents boundary oscillation
6. **Parallel tool batching** reduces latency for safe operations
7. **Event-driven streaming** provides real-time TUI updates

The system is designed for **correctness over performance** in most cases, with intentional trade-offs (context truncation, handoff context loss) to prevent catastrophic failures (context overflow, state corruption).

**Critical Observations**:
- Message queuing has potential data loss edge case
- Handoff context loss is intentional but may surprise users
- Two-tier compaction (agent + orchestrator) creates complexity
- Stop hook can override goal achievement (powerful but dangerous)

**Potential Improvements**:
- Add warning message for lost queued messages in `endExecution()`
- Consider preserving planning context during handoff (optional flag)
- Simplify compaction strategy to single-tier
- Add safeguards for stop hook override (e.g., max override count)
