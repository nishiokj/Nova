# Ralph Loop - Minimum Patch Spec

Iterative self-referential agent loop using per-request stop hooks.

## What It Does

Repeats the same prompt until a completion condition is met. Agent sees its previous work in context, enabling iterative refinement toward a goal.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Orchestrator                                                │
│                                                             │
│  1. Run agent with prompt                                   │
│  2. Agent produces response → added to context              │
│  3. Agent signals goal_state_reached                        │
│  4. Check config.stopHook (per-request)                     │
│  5. Hook examines response for completion promise           │
│  6. If not complete: { decision: 'block', reason: prompt }  │
│  7. Create new work item, continue loop                     │
│  8. Agent sees all previous context                         │
│  9. Repeat until promise detected or max iterations         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Files

| File | Purpose |
|------|---------|
| `packages/orchestrator/src/ralph-loop.ts` | RalphLoop class, createRalphStopHook factory |
| `packages/orchestrator/src/hooks/stop-hook.ts` | StopHookHandler and StopHookContext types |
| `packages/orchestrator/src/orchestrator.ts` | OrchestratorConfig.stopHook, hook invocation |
| `packages/agent/src/types.ts` | StopHookResult interface |

## Usage

```typescript
import { Orchestrator, createRalphStopHook } from 'orchestrator';

const orchestrator = new Orchestrator(
  {
    stopHook: createRalphStopHook({
      prompt: 'Build a REST API for user management',
      maxIterations: 20,
      completionPromise: 'TASK COMPLETE',
      onIteration: (state) => console.log(`Iteration ${state.iteration}`),
      onComplete: (state, reason) => console.log(`Done: ${reason}`),
    }),
  },
  toolRegistry,
  llm,
  emit,
  requestId
);

await orchestrator.execute(context, 'Build a REST API', 'standard', cwd);
```

## Completion Detection

Agent outputs a `<promise>` tag to signal completion:

```
I've finished implementing the REST API.

<promise>TASK COMPLETE</promise>
```

Hook extracts and matches:
```typescript
function checkCompletionPromise(response: string, promise: string): boolean {
  const match = response.match(/<promise>([\s\S]*?)<\/promise>/i);
  if (!match) return false;
  return match[1].trim() === promise.trim();
}
```

## Types

```typescript
interface RalphLoopConfig {
  prompt: string;                      // Prompt to repeat
  maxIterations: number;               // Max iterations (0 = unlimited)
  completionPromise: string | null;    // Promise text to detect
  onIteration?: (state) => void;       // Called each iteration
  onComplete?: (state, reason) => void; // Called on completion
}

interface RalphLoopState {
  iteration: number;
  maxIterations: number;
  completionPromise: string | null;
  startedAt: Date;
  lastResponse: string;
}

type RalphCompletionReason =
  | 'promise_detected'
  | 'max_iterations'
  | 'manual_cancel'
  | 'error';

interface StopHookResult {
  decision: 'allow' | 'block';
  reason?: string;         // New prompt if blocking
  systemMessage?: string;  // Prepended to context
}

type StopHookHandler = (context: StopHookContext) => StopHookResult | Promise<StopHookResult>;

interface StopHookContext {
  workId: string;
  response: string;
  terminationReason: string;
  iteration: number;
  agentType: string;
  sessionKey: string;
}
```

## Exports

From `orchestrator` package:

```typescript
// Ralph Loop
export { RalphLoop, runRalphLoop, createRalphStopHook, checkCompletionPromise, createRalphState };
export type { RalphLoopConfig, RalphLoopState, RalphCompletionReason };

// Stop Hook types
export type { StopHookHandler, StopHookContext };
```

From `agent` package:

```typescript
export type { StopHookResult };
```

## Key Design Decisions

1. **Per-request isolation**: Stop hook passed via `OrchestratorConfig.stopHook`, not a global registry. Each orchestrator instance gets isolated closure state.

2. **Synchronous decision**: Hook returns immediately so orchestrator knows whether to terminate or continue.

3. **Context accumulation**: Agent sees all prior work. Auto-compaction at 70% usage preserves recent items.

---

## Known Limitations

### 1. Only `goal_state_reached` Triggers Hook

| Termination Reason | Hook Called? |
|--------------------|--------------|
| `goal_state_reached` | ✅ Yes |
| `max_iterations_exceeded` | ❌ No |
| `max_tool_calls_exceeded` | ❌ No |
| `max_duration_exceeded` | ❌ No |
| `agent_error` | ❌ No |
| `refusal` | ❌ No |

**Impact**: `RalphLoop.recordError()` exists but is unreachable. Loop can't distinguish why it stopped in failure cases.

### 2. No TUI Integration

- No `/ralph start`, `/ralph cancel` commands
- `RalphLoop.cancel()` method exists but not wired to anything
- No status indicator showing current iteration

### 3. No Session Persistence

- Loop state is in-memory only (closure)
- Process crash = lost progress
- Cannot resume from iteration N

### 4. No Rate Limit Handling

- If agent hits rate limits mid-loop, treated as error
- No retry/backoff in loop controller

### 5. Context Exhaustion Unaware

- No Ralph-aware compaction
- Long loops may lose critical early context
