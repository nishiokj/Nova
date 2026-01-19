# Execution Tracking Fix: Race Condition in Orchestrator Creation

## Problem

When a user sent a message while an orchestrator was already executing for their session, the system would create a **new orchestrator** instead of allowing the running agent to see the message. This caused:

1. Two orchestrators running in parallel for the same session
2. The original orchestrator never seeing the user's follow-up comment
3. Confusing behavior where conversational messages spawned independent executions

### Before (Broken Flow)

```
User: "analyze this file"
  → harness.run() creates Orchestrator A
  → Orchestrator A starts executing (LLM calls, tool calls...)

User: "actually focus on the imports" (during execution)
  → harness.run() creates Orchestrator B (NEW!)
  → Orchestrator B starts its own execution loop
  → Orchestrator A never sees the comment
  → User gets two separate responses
```

## Solution

Track execution state per session. When a message arrives during active execution, queue it into the shared ContextWindow so the running agent sees it on its next turn.

### After (Fixed Flow)

```
User: "analyze this file"
  → harness.run() → startExecution("req_1")
  → Orchestrator starts executing

User: "actually focus on the imports" (during execution)
  → harness.run() → isExecuting()? YES
  → queueUserMessage() adds message to ContextWindow
  → Returns immediately with {queued: true}

Agent's next LLM call:
  → Context now includes: [user: "analyze this file", ..., user: "actually focus on the imports"]
  → Agent sees the new message and can respond accordingly
```

## Changes

### 1. SessionStore (`packages/harness-daemon/src/harness/session_store.ts`)

Added execution tracking state:

```typescript
// Execution tracking: prevents race conditions when user sends messages during agent execution
private executingRequestId: string | null = null;
private queuedUserMessages: Array<{ requestId: string; message: string }> = [];
```

Added methods:

```typescript
/**
 * Mark that an orchestrator is executing for this session.
 * Returns false if there's already an active execution.
 */
startExecution(requestId: string): boolean {
  if (this.executingRequestId !== null) {
    return false;
  }
  this.executingRequestId = requestId;
  return true;
}

/**
 * Check if there's an active orchestrator execution.
 */
isExecuting(): boolean {
  return this.executingRequestId !== null;
}

/**
 * Get the current executing request ID, if any.
 */
getExecutingRequestId(): string | null {
  return this.executingRequestId;
}

/**
 * Mark execution as complete and return any queued user messages.
 */
endExecution(): Array<{ requestId: string; message: string }> {
  this.executingRequestId = null;
  const queued = this.queuedUserMessages;
  this.queuedUserMessages = [];
  return queued;
}

/**
 * Queue a user message to be seen by the running agent on its next turn.
 * The message is added to the context window immediately so the agent sees it.
 */
queueUserMessage(requestId: string, message: string): void {
  this.queuedUserMessages.push({ requestId, message });
  // Add to context immediately so agent sees it on next LLM call
  const ctx = this.getContext();
  ctx.addMessage('user', message);
  this.logger.debug('Queued user message during execution', {
    sessionKey: this.sessionKey,
    executingRequestId: this.executingRequestId,
    queuedRequestId: requestId,
    messagePreview: message.slice(0, 100),
  });
}
```

**Reasoning**: The key insight is that `queueUserMessage()` adds the message directly to the shared ContextWindow. Since this is the same context the orchestrator passes to the agent on each turn, the agent will see the new message on its next LLM call without any additional coordination.

### 2. AgentHarness.run() (`packages/harness-daemon/src/harness/harness.ts`)

Added execution check at the beginning of `run()`:

```typescript
// Check if there's already an orchestrator executing for this session.
// If so, queue the message for the running agent to see on its next turn.
if (store.isExecuting()) {
  this.logger.info('Message received during active execution, queueing for agent', {
    sessionKey,
    requestId,
    executingRequestId: store.getExecutingRequestId(),
    messagePreview: inputText.slice(0, 100),
  });

  // Queue the message - this adds it to context immediately
  store.queueUserMessage(requestId, inputText);

  // Persist to GraphD if available
  this.persistUserMessage(sessionKey, requestId, inputText);

  // Emit a status event indicating the message was queued
  eventQueue.push(createStatusEvent('idle', 'Message queued - agent will see it on next turn'));

  // Return a "queued" result - not an error, but also not a full response
  const resultPromise = Promise.resolve({
    requestId,
    sessionKey,
    success: true,
    finalText: '',
    paused: false,
    toolsUsed: [],
    durationMs: 0,
    metadata: { queued: true, executingRequestId: store.getExecutingRequestId() },
  } as AgentRunResult);

  queueMicrotask(() => eventQueue.finish());
  return { result: resultPromise, events: eventQueue };
}
```

Added `startExecution()` after the check passes:

```typescript
// Mark execution as started - prevents race conditions from concurrent messages
store.startExecution(requestId);
```

Added `endExecution()` in the finally block:

```typescript
} finally {
  // Mark execution as complete - allows new messages to start their own orchestrator
  const queuedMessages = store.endExecution();
  if (queuedMessages.length > 0) {
    this.logger.info('Execution ended with queued messages', {
      sessionKey,
      requestId,
      queuedCount: queuedMessages.length,
    });
  }
  // ... rest of cleanup
}
```

**Reasoning**: The finally block ensures `endExecution()` is always called, even if the orchestrator throws an error. This prevents the session from getting stuck in "executing" state.

### 3. AgentHarness.resume() (`packages/harness-daemon/src/harness/harness.ts`)

Applied the same pattern to `resume()`:

1. Check `isExecuting()` before proceeding
2. Call `startExecution()` before running orchestrator
3. Call `endExecution()` in finally block

**Reasoning**: Resume is also a path that creates orchestrators, so it needs the same protection. While resume typically follows a pause (so there shouldn't be an active execution), handling it defensively prevents edge cases.

## Design Decisions

### Why add to context immediately in queueUserMessage()?

The alternative would be to queue messages and inject them later. But:

1. The ContextWindow is the single source of truth for conversation state
2. Adding immediately means zero coordination needed between SessionStore and Orchestrator
3. The agent's next LLM call naturally includes all messages in context

### Why return {queued: true} instead of waiting?

1. The TUI can show the user their message was received
2. No complex "wait for execution to finish" logic needed
3. The agent will respond to the queued message as part of its normal flow

### Why track queued messages separately if we add to context immediately?

The `queuedUserMessages` array serves as:

1. An audit trail (logged when execution ends)
2. Potential future use for showing "pending messages" in the UI
3. Debugging aid to see what messages came in during execution

## Testing Considerations

To verify this fix:

1. Start a long-running task (e.g., "read all files in src/")
2. While the agent is executing, send a follow-up message
3. Observe that:
   - The follow-up returns immediately with queued status
   - The agent's response acknowledges the follow-up
   - Only one orchestrator runs, not two
