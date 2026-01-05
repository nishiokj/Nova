# Context Window Analysis

## Current Architecture Overview

The context window system has **three layers** with different responsibilities:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 1: Session Layer (AgentHarness / SessionContext)              │
│   - Persists across multiple requests                               │
│   - Stores: messages[], readFiles: Set<string>                      │
│   - Lives in: Map<sessionKey, SessionContext>                       │
└─────────────────────────────────────────────────────────────────────┘
                              ↓ passed to Agent.run()
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 2: Request Layer (ContextWindow)                              │
│   - Created fresh per Agent.run() call                              │
│   - Stores: systemPrompt, goal, objective, stepNum, messages, readFiles │
│   - Passed to Wizard as read-only baseContext                       │
└─────────────────────────────────────────────────────────────────────┘
                              ↓ passed to Worker.execute()
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 3: Step Layer (ContextDelta)                                  │
│   - Created fresh per Worker execution                              │
│   - Stores: messages[], readFiles: Set<string>                      │
│   - Worker NEVER mutates base context - all changes go to delta     │
│   - Merged back to outcome.contextMessages at end                   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Detailed Flow Analysis

### Single Request Lifecycle

```
1. TUI/Client
   └─→ AgentHarness.run(params)
       ├─ sessionState = getSessionState(sessionKey)  // Get or create
       │   └─→ { messages: [], readFiles: Set<string> }
       │
       └─→ Agent.run(userInput, context, sessionState, tier, budget, onStreamChunk)
           │
           ├─ [Simple Tier] → runSimpleTier()
           │   └─ Build messages array from:
           │      1. System prompt
           │      2. Context (if provided)
           │      3. Session history (sessionState.messages)
           │      4. User input
           │   └─ Single LLM call, no tools
           │
           └─ [Standard/Complex Tier]
               ├─ Planner.createPlan(userInput, context, tier, budget)
               │   └─ Returns WizardPlan: { goal, goalType, steps[] }
               │
               ├─ createContextWindow()  // CREATE REQUEST-LEVEL CONTEXT
               │   └─ ContextWindow {
               │        systemPrompt: config.systemPrompt,
               │        goal: plan.goal,
               │        objective: steps[0].objective,
               │        stepNum: 1,
               │        messages: sessionState.messages,  // ← FROM SESSION
               │        readFiles: sessionState.readFiles  // ← FROM SESSION
               │      }
               │
               └─→ Wizard.execute(plan, baseContext, behavioralRules)
                   │
                   ├─ Initialize state stores:
                   │   - planState = PlanState.fromWizardPlan(plan)
                   │   - ledger = WorkLedger()
                   │   - knowledge = KnowledgeStore()
                   │
                   └─ FOR EACH STEP:
                       ├─ workItem = workItemFromStepState(step)
                       │
                       ├─ stepContext = createContextWindow(...)  // STEP-SPECIFIC
                       │   └─ Uses baseContext.messages + baseContext.readFiles
                       │
                       └─→ Worker.execute(stepContext, workItem, planVersion, ...)
                           │
                           ├─ delta = createContextDelta()  // FRESH PER STEP
                           │   └─ { messages: [], readFiles: Set<string> }
                           │
                           ├─ [Pre-loop] Auto-read target files into delta
                           │
                           └─ EXECUTION LOOP:
                               ├─ systemMessage = buildSystemMessage(goal, objective, ...)
                               │
                               ├─ messages = [
                               │    { role: 'system', content: systemMessage },
                               │    ...mergeMessages(baseContext.messages, delta)
                               │  ]
                               │
                               ├─ LLM.respond({ messages, tools })
                               │
                               └─ Process response:
                                  ├─ Tool calls → execute → add results to delta
                                  ├─ [FINAL] → success, return
                                  ├─ [NEED_CONTEXT] → pause, return
                                  └─ [CONTINUE] → loop
```

### Multi-Turn Session Flow

```
Request 1:
  AgentHarness.run({ sessionKey: "abc", inputText: "Read foo.ts" })
    → Agent produces response
    → sessionState.messages.push(
        { role: 'user', content: "Read foo.ts" },
        { role: 'assistant', content: "Contents of foo.ts: ..." }
      )

Request 2 (same session):
  AgentHarness.run({ sessionKey: "abc", inputText: "Now modify line 10" })
    → sessionState already has messages from Request 1
    → createContextWindow() receives these messages
    → Worker sees prior conversation context
```

---

## Key Observations

### 1. Context Window is NOT a First-Class Primitive

**Current State:**
- `ContextWindow` is a simple struct created via factory function
- No methods for manipulation, compaction, or introspection
- No token counting or budget tracking
- No lifecycle hooks

**Location:** `wizard/context.ts:73-86`
```typescript
export interface ContextWindow {
  systemPrompt: string;
  goal: string;
  objective: string;
  stepNum: number;
  messages: Array<Record<string, unknown>>;  // ← Loose typing
  readFiles: Set<string>;
}
```

### 2. Messages Are Loosely Typed

**Problem:** Messages use `Record<string, unknown>[]` throughout the codebase, despite having well-defined `Message` type in `types/llm.ts`.

**Evidence:**
- `wizard/context.ts:83` - `messages: Array<Record<string, unknown>>`
- `agent/agent.ts:74` - `messages: Array<Record<string, unknown>>`

**Risk:** Content blocks (`tool_use`, `tool_result`, etc.) are being constructed ad-hoc without type safety.

### 3. Delta Merge is Simple Concatenation

**Location:** `wizard/context.ts:47-63`
```typescript
export function mergeMessages(
  baseMessages: Array<Record<string, unknown>>,
  delta: ContextDelta,
  systemSuffix?: string
): Array<Record<string, unknown>> {
  const result = [...baseMessages, ...delta.messages];  // ← Just concat
  // ...
}
```

**Issues:**
- No deduplication
- No compaction when context grows large
- No token budget awareness

### 4. Session State Lives in Memory Only

**Location:** `harness/harness.ts:115`
```typescript
private sessionStates = new Map<string, SessionContext>();
```

**Issues:**
- Lost on process restart
- GraphD persists messages separately but doesn't hydrate SessionContext
- `readFiles` set never persisted

### 5. Worker Context is Reconstructed Each Iteration

**Location:** `wizard/worker.ts:520-551`

Each LLM call within a Worker:
1. Rebuilds system message from scratch
2. Merges base messages with delta
3. Sends entire history to LLM

**No:**
- Sliding window
- Summarization
- Token budgeting

### 6. No Context Compaction

**Config exists but unused:**
```typescript
// wizard/wizard.ts:44
contextBudgetTokens: 100_000,
compactionThreshold: 0.6,
```

No code actually implements compaction when context grows beyond budget.

---

## Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                           DATA OWNERSHIP                             │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  AgentHarness                                                        │
│  ├─ sessionStates: Map<string, SessionContext>  [MUTABLE, IN-MEMORY] │
│  └─ graphd: GraphDManager                       [PERSISTENT]         │
│                                                                      │
│  Agent                                                               │
│  ├─ config: AgentConfig                         [IMMUTABLE]          │
│  └─ (no state)                                                       │
│                                                                      │
│  Wizard                                                              │
│  ├─ planState: PlanState                        [MUTABLE, PER-RUN]   │
│  ├─ ledger: WorkLedger                          [APPEND-ONLY]        │
│  ├─ knowledge: KnowledgeStore                   [MUTABLE]            │
│  └─ (no context window - passed in)                                  │
│                                                                      │
│  Worker                                                              │
│  ├─ (stateless)                                                      │
│  └─ delta: ContextDelta                         [LOCAL TO EXECUTION] │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Gaps and Improvement Opportunities

### 1. Token Budget Management
- Track actual token usage per ContextWindow
- Implement sliding window when approaching budget
- Add compaction strategies (summarization, pruning old messages)

### 2. Type Safety
- Use `Message` type from `types/llm.ts` consistently
- Create proper content block builders

### 3. Session Persistence
- Hydrate SessionContext from GraphD on startup
- Persist `readFiles` set
- Support context continuation across restarts

### 4. Context as First-Class Object
```typescript
class ManagedContextWindow {
  private messages: Message[];
  private readFiles: Set<string>;
  private tokenBudget: number;
  private currentTokens: number;

  addMessage(msg: Message): void;
  compact(): void;
  getForLLM(): Message[];
  getTokenUsage(): { current: number; budget: number };
  fork(objective: string): ManagedContextWindow;  // For step-level contexts
}
```

### 5. Context Lifecycle Events
- Emit events when context grows/compacts
- Track context evolution for debugging
- Enable context inspection in TUI/dashboard

---

## Questions for Planning

1. **Should ContextWindow own token counting?** Or should that remain with LLMAdapter?

2. **What compaction strategy?**
   - Summarization (LLM call)
   - Sliding window (drop old messages)
   - Hybrid (summarize then window)

3. **How to handle cross-request context?**
   - Full message history
   - Summarized history
   - Only last N turns + files read

4. **Should Workers share context?**
   - Currently each step gets fresh context + delta
   - Alternative: progressive enrichment across steps

5. **GraphD integration for context:**
   - Should GraphD be the source of truth for session context?
   - How to handle the `readFiles` set?
