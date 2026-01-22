# User Interruption Hook Specification

## Overview

This spec defines how user messages sent during agent execution are handled. The goal is to allow users to interrupt, redirect, or provide additional context to a running agent without causing race conditions or double-processing.

## Problem Statement

### Current Behavior
1. User sends message while agent is executing
2. Harness detects `isExecuting() === true`
3. `queueUserMessage()` adds message to context AND queues for follow-up run
4. Agent finishes, orchestrator returns
5. Post-orchestration loop sees queued message, re-runs orchestrator

**Issues:**
- Message is processed twice (injected into context + follow-up run)
- Agent may not see the message if it reaches `goal_state_reached` before iterating again
- Race condition between interruption arrival and goal completion

### Desired Behavior
- User interruption is seen by the agent inline if possible
- If agent already completed, interruption is handled cleanly as follow-up
- No double-processing
- Clean separation of concerns across architectural layers

## Architecture

### Layer Responsibilities

| Layer | Scope | Responsibility |
|-------|-------|----------------|
| Agent | per-iteration | Sees messages in context naturally, no special hook logic |
| Orchestrator | per-request | Checks for pending interruptions before terminating on `goal_state_reached` |
| Harness | per-session | Detects interruption, injects directive into context, provides callback to orchestrator |

### Key Principle
The agent remains unaware of the interruption mechanism. It simply sees messages in context and responds naturally. The orchestrator handles the edge case where the agent finished before seeing the interruption.

## Design

### 1. Interruption Detection (Harness)

When a user message arrives during execution:

```typescript
// In harness.run() when startExecution() returns false
if (!store.startExecution(requestId)) {
  // Build interruption directive
  const directive = buildInterruptionDirective(inputText);

  // Inject into context (agent may see this on next iteration)
  const ctx = store.getContext();
  ctx.addMessage('user', directive);

  // Store for orchestrator to check if agent doesn't see it
  store.setPendingInterruption({
    requestId,
    originalMessage: inputText,
    directive,
  });

  // Return queued status (no follow-up queue needed)
  return createQueuedResult(requestId, sessionKey);
}
```

### 2. Interruption Directive Format

The injected message should guide the agent on how to handle the interruption:

```typescript
function buildInterruptionDirective(userMessage: string): string {
  return `**User Interruption**: "${userMessage}"

Consider if the user is:
- Asking you to stop current work
- Requesting a pivot to different task
- Providing information that invalidates your current action
- Adding context as an addendum

If this is blocking information, use the PromptUser tool to resolve ambiguity.
Otherwise, acknowledge and continue appropriately.`;
}
```

### 3. Orchestrator Config Extension

Add callback to check for pending interruptions:

```typescript
interface OrchestratorConfig {
  // ... existing fields

  /**
   * Check for pending user interruption that arrived during execution.
   * Called before terminating on goal_state_reached.
   * Returns interruption info if pending, null otherwise.
   */
  checkInterruption?: () => PendingInterruption | null;
}

interface PendingInterruption {
  requestId: string;
  originalMessage: string;
  directive: string;
}
```

### 4. Orchestrator Termination Check

Modify the goal completion check to handle pending interruptions:

```typescript
// In orchestrator execute() loop, after processing results
if (initialWorkCompleted && this.workQueue.length === 0 && inProgress.size === 0) {

  // Check for pending user interruption that agent didn't see
  if (this.config.checkInterruption) {
    const interruption = this.config.checkInterruption();
    if (interruption) {
      this.log('info', 'Pending interruption detected, continuing execution', {
        iteration,
        messagePreview: interruption.originalMessage.slice(0, 100),
      });

      // Create new work item to handle the interruption
      // The directive is already in context, so agent will see it
      const newItem = this.createWorkItem(
        `Handle user interruption: ${interruption.originalMessage}`,
        agentType
      );
      this.enqueue(newItem);

      // Reset completion tracking
      initialWorkCompleted = false;
      initialWorkResponse = '';
      this.completedWork.delete(this.initialWorkId);
      this.initialWorkId = newItem.workId;

      continue;
    }
  }

  // Then check per-request stop hook (Ralph Loop etc.)
  if (this.config.stopHook) {
    // ... existing stopHook logic
  }

  // No interruption, no stopHook block - terminate normally
  return this.createResult({ ... });
}
```

### 5. Session Store Changes

Add interruption tracking to SessionStore:

```typescript
interface PendingInterruption {
  requestId: string;
  originalMessage: string;
  directive: string;
  timestamp: number;
}

class SessionStore {
  private pendingInterruption: PendingInterruption | null = null;

  setPendingInterruption(interruption: Omit<PendingInterruption, 'timestamp'>): void {
    this.pendingInterruption = {
      ...interruption,
      timestamp: Date.now(),
    };
  }

  getPendingInterruption(): PendingInterruption | null {
    return this.pendingInterruption;
  }

  clearPendingInterruption(): PendingInterruption | null {
    const interruption = this.pendingInterruption;
    this.pendingInterruption = null;
    return interruption;
  }

  hasPendingInterruption(): boolean {
    return this.pendingInterruption !== null;
  }
}
```

### 6. Harness Orchestrator Integration

Pass the callback when creating the orchestrator:

```typescript
// In harness.runOrchestrator()
const orchestrator = new Orchestrator(
  {
    ...config,
    stopHook,
    checkInterruption: () => {
      const interruption = store.clearPendingInterruption();
      return interruption;
    },
  },
  this.toolRegistry,
  llm,
  emit,
  requestId,
  this.logger,
  // ...
);
```

### 7. Remove Legacy Queue Logic

Remove the post-orchestration loop that re-runs for queued messages:

```typescript
// REMOVE this pattern from harness.run()
while (!result.paused) {
  const queuedMessages = store.drainQueuedMessages();
  if (queuedMessages.length > 0) {
    result = await this.runOrchestrator(...);
    continue;
  }
  // ...
}
```

Also remove from SessionStore:
- `queuedUserMessages` array
- `queueUserMessage()` method
- `drainQueuedMessages()` method
- `getQueuedMessages()` method

## Flow Diagrams

### Normal Case: Agent Sees Interruption

```
User sends "Stop"
       ↓
Harness: isExecuting() === true
       ↓
Inject directive into context
Set pendingInterruption
       ↓
Agent iteration N+1 starts
       ↓
buildMessages() includes directive
       ↓
Agent sees "User Interruption: Stop"
Agent responds appropriately
       ↓
Agent continues or completes
       ↓
Orchestrator: checkInterruption() → null (already handled via context)
       ↓
Normal termination
```

### Edge Case: Agent Already Completed

```
Agent iteration N returns goal_state_reached
       ↓
(Meanwhile) User sends "Stop"
       ↓
Harness: isExecuting() === true
Inject directive into context
Set pendingInterruption
       ↓
Orchestrator receives goal_state_reached
       ↓
Before terminating: checkInterruption() → PendingInterruption
       ↓
Create new work item for interruption
Reset completion tracking
Continue loop
       ↓
Agent iteration N+1 handles interruption
       ↓
Normal completion
```

## Edge Cases

### Multiple Rapid Interruptions
If user sends multiple messages rapidly, only the latest should be stored as `pendingInterruption`. Earlier ones are already in context and will be visible to the agent.

### Interruption During Handoff
If agent requested handoff and user interrupts, the interruption should take precedence. The handoff approval flow should be cancelled and the interruption handled.

### Interruption During PromptUser
If agent is paused waiting for user input via PromptUser, this is not an "interruption" - it's the expected response. Normal resume flow applies.

## Migration

1. Add `PendingInterruption` type and methods to SessionStore
2. Add `checkInterruption` to OrchestratorConfig
3. Update orchestrator termination check
4. Update harness to inject directive and set pending interruption
5. Pass checkInterruption callback to orchestrator
6. Remove legacy `queuedUserMessages` infrastructure
7. Remove post-orchestration re-run loop

## Testing

- Unit test: Interruption during active iteration → agent sees directive
- Unit test: Interruption after goal_state_reached → orchestrator handles
- Integration test: "Stop" command interrupts long-running task
- Integration test: Addendum message is acknowledged and incorporated
- Race condition test: Rapid fire interruptions don't cause duplicates
