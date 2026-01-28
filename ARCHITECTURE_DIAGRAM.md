# System Architecture: Harness, Orchestrator, Agent, and Decision Watcher

## Overview

This system implements a goal-driven agent execution framework with a decision watcher that enables autonomous operation by surfacing uncertainty and maintaining consistency across a project.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                    │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │   TUI       │    │  Telegram   │    │   Other     │         │
│  │   Client    │    │   Client    │    │   Clients   │         │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘         │
│         │                   │                     │                    │
│         └───────────────────┴─────────────────────┘                    │
│                          │                                        │
│                          ▼                                        │
│  ┌──────────────────────────────────────────────────────────┐             │
│  │           HarnessClient (TCP JSONL)               │             │
│  │  - Manages connection state                    │             │
│  │  - Sends commands (send_text, watcher_*)       │             │
│  │  - Receives events (status, response, progress) │             │
│  │  - Auto-reconnection logic                     │             │
│  └──────────────────┬───────────────────────────────┘             │
└─────────────────────────┼──────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           BUS LAYER (comms-bus)                             │
│  ┌──────────────────────────────────────────────────────────┐             │
│  │              BusServer (TCP Socket)                 │             │
│  │  - BRIDGE_COMMAND_CHANNEL (commands)              │             │
│  │  - runChannel(requestId) (run-specific events)      │             │
│  │  - sessionChannel(sessionKey) (session events)       │             │
│  └──────────────────┬───────────────────────────────────┘             │
└───────────────────────┼────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      BRIDGE GATEWAY                                         │
│  ┌──────────────────────────────────────────────────────────┐             │
│  │              BridgeGateway                        │             │
│  │  - Routes bridge commands to harness              │             │
│  │  - Manages per-connection ConnectionState        │             │
│  │  - Streams events back to clients               │             │
│  │  - Handles: init, send_text, watcher_*         │             │
│  └──────────────────┬───────────────────────────────────┘             │
└───────────────────────┼────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                       AGENT HARNESS                                          │
│  ┌──────────────────────────────────────────────────────────┐             │
│  │              AgentHarness                         │             │
│  │  - Main entry point for TUI integration          │             │
│  │  - Session management (SessionStore per session)  │             │
│  │  - AgentRegistry (different agent types)          │             │
│  │  - ToolRegistry (Read, Write, Edit, Bash, etc.)  │             │
│  │  - EventBus (central pub/sub for events)          │             │
│  │  - Decision watcher integration (per-session)         │             │
│  └──────────────────┬───────────────────────────────────┘             │
│                      │                                                       │
│    ┌─────────────────┼─────────────────┐                               │
│    │                 │                 │                               │
│    ▼                 ▼                 ▼                               │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐                          │
│  │ GraphD   │   │ EventBus │   │ Decision │                          │
│  │Manager   │   │          │   │  Watcher │                          │
│  │(persistence)│  │(events)  │   │ Engine   │                          │
│  └──────────┘   └─────┬────┘   └──────────┘                          │
│                       │         │                                         │
│                       │         │ (per session)                           │
│                       ▼         ▼                                         │
│  ┌──────────────────────────────────────┐                                  │
│  │   OrchestratorRunner.execute()     │                                  │
│  │   - Creates Orchestrator instance │                                  │
│  │   - Passes stopHook for watcher  │                                  │
│  └──────────────────┬───────────────┘                                  │
└───────────────────────┼─────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATOR                                          │
│  ┌──────────────────────────────────────────────────────────┐             │
│  │              Orchestrator                        │             │
│  │  Loop Governor - executes agent until goal/bounds  │             │
│  │                                                     │             │
│  │  Main Loop:                                         │             │
│  │  ┌──────────────────────────────────────┐            │             │
│  │  │ while (workQueue or inProgress) {   │            │             │
│  │  │   1. Dequeue ready work items        │            │             │
│  │  │   2. Create Agent instances          │            │             │
│  │  │   3. Run agents in parallel          │            │             │
│  │  │   4. Check termination conditions    │            │             │
│  │  │   5. Evaluate stop hook           │            │             │
│  │  │   6. Manage context compaction    │            │             │
│  │  │ }                                  │            │             │
│  │  └──────────────────────────────────────┘            │             │
│  │                                                     │             │
│  │  Termination Checks:                                │             │
│  │  - Goal reached                                     │             │
│  │  - Max iterations exceeded                         │             │
│  │  - Max tool calls exceeded                          │             │
│  │  - Max duration exceeded                             │             │
│  │  - User input required (PromptUser)                │             │
│  │  - Handoff requested                              │             │
│  │  - Refusal                                         │             │
│  │  - User stopped                                    │             │
│  └──────────────────┬───────────────────────────────────┘             │
└───────────────────────┼────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         AGENT (from agent package)                             │
│  ┌──────────────────────────────────────────────────────────┐             │
│  │              Agent                               │             │
│  │  - Single iteration of goal-driven execution │             │
│  │  - LLM call for decision-making            │             │
│  │  - Tool execution                        │             │
│  │  - Structured output (action, goalState)   │             │
│  └──────────────────┬───────────────────────────┘             │
└───────────────────────┼────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    DECISION WATCHER (decision-watcher package)                     │
│  ┌──────────────────────────────────────────────────────────┐             │
│  │              DecisionWatcher                     │             │
│  │  - Intercepts PromptUser events            │             │
│  │  - Auto-answers using decision database    │             │
│  │  - Escalates uncertain/critical questions │             │
│  └──────────────────┬───────────────────────────┘             │
│                     │                                                 │
│    ┌────────────────┼────────────────┐                             │
│    │                │                │                             │
│    ▼                ▼                ▼                             │
│  ┌─────────┐    ┌──────────┐   ┌──────────┐                 │
│  │Decision │    │ Decision  │   │  Decision │                 │
│  │ Database│    │  Engine   │   │   Log    │                 │
│  │(per    │    │(searches,│   │ (audit)   │                 │
│  │session) │    │answers)  │   │          │                 │
│  └─────────┘    └──────────┘   └──────────┘                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Key Integration Points

### 1. Decision Watcher Integration (The Critical Link)

The Decision Watcher integrates with the orchestrator through **multiple hook mechanisms**:

#### A. Per-Session Setup (AgentHarness)
```typescript
// In AgentHarness constructor
private decisionDatabases = new Map<string, DecisionDatabase>();
private watcherEngines = new Map<string, DecisionEngine>();

// Per-session watcher creation when session initializes
closeSession(sessionKey: string): void {
  this.decisionDatabases.delete(sessionKey);
  this.watcherEngines.delete(sessionKey);
}
```

#### B. Watcher StopHook (Orchestrator)
```typescript
// OrchestratorRuntime interface
interface OrchestratorRuntime {
  stopHook?: StopHookHandler;  // Per-request hook
  onIteration?: (state: IterationState) => void;  // Called each iteration
  checkInterruption?: () => boolean;  // Check for user messages
  checkStopRequest?: () => boolean;  // Check for "stop" command
  onStart?: (context: ContextWindow) => void | (() => void);
}
```

**The watcher injects itself as a `stopHook`** - this is the primary integration point. When the orchestrator considers terminating (goal reached, bounds exceeded, etc.), it calls the watcher's stop hook. The watcher can:
- **Block termination** and provide a new goal to continue (Ralph Loop pattern)
- **Auto-answer** PromptUser questions using its decision database
- **Escalate** to the user if uncertain

#### C. Orchestrator.onIteration Callback
```typescript
// In Orchestrator.executeInner()
// Called fire-and-forget (doesn't block loop)
runtime?.onIteration?.({ 
  iteration, 
  context, 
  totalToolCalls, 
  totalLlmCalls, 
  elapsedMs: elapsed 
});
```

The watcher can use this to:
- Evaluate rules on each iteration
- Update internal state based on execution progress
- Steer the decision engine based on current context

### 2. Watcher Operation Modes

#### Mode 1: PromptUser Interception (Async Mode)
```
Agent executes → PromptUser tool called → Orchestrator pauses
                    ↓
            DecisionWatcher.handlePromptUser()
                    ↓
           DecisionEngine.answerQuestion(context)
                    ↓
              Search decision database
                    ↓
              Confidence check (minConfidenceThreshold)
                    ↓
         ┌────────────┴────────────┐
         │                         │
    Confidence >= 0.6     Confidence < 0.6
    or direct match        or warnings
         │                         │
         ▼                         ▼
    Auto-answer              Escalate to user
         │                         │
    Inject answer            Pause and wait
         │                    for user input
         ▼
   Continue execution
```

#### Mode 2: StopHook Block (Ralph Loop Pattern)
```
Orchestrator: Goal reached → Call stopHook(request)
                          ↓
          Decision Watcher stopHook
                          ↓
    Evaluate: Should we continue?
                          ↓
            ┌─────────────┴─────────────┐
            │                           │
       Decision: block         Decision: allow
            │                           │
            ▼                           ▼
   Inject new goal          Return response
   Create new workItem      Terminate
            │
            ▼
      Continue loop
```

### 3. Decision Database Architecture

Each session gets its own `DecisionDatabase` instance:

```
┌─────────────────────────────────────────────────────┐
│         Session: abc-123-xyz-456             │
│                                                 │
│  DecisionDatabase (InMemory or File)           │
│  ┌───────────────────────────────────────────┐  │
│  │ Decisions (authoritative choices)       │  │
│  │ - id: "dec-typescript-strict-mode"     │  │
│  │ - category: "style"                    │  │
│  │ - priority: "critical"                  │  │
│  │ - decision: "Always enable strict mode..." │  │
│  │ - keywords: ["typescript", "strict"]   │  │
│  │ - rationale: "Catches bugs at compile..."│  │
│  │ - alternatives: [...]                  │  │
│  │ - conflictsWith: [...]                │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  DecisionMemory (session tracking)               │
│  ┌───────────────────────────────────────────┐  │
│  │ - sessionId: "session-1"               │  │
│  │ - decisionsMade: [...]                 │  │
│  │ - patterns: [...]                      │  │
│  │ - consistencyScore: 0.85               │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### 4. Event Flow for a User Request

```
User types: "Implement a user authentication system"
                 ↓
TUI → HarnessClient.send({type: "send_text", data: {text: "..."}})
                 ↓
BusServer → BridgeGateway.handlePublish({type: "send_text"})
                 ↓
BridgeGateway → Harness.run({requestId, inputText, sessionKey})
                 ↓
AgentHarness → OrchestratorRunner.execute({
  context: sessionStore.getContext(),
  goal: "Implement a user authentication system",
  agentType: "standard",
  runtime: {
    stopHook: createWatcherStopHook(sessionKey, goal),  // WATCHER HOOKED IN!
    onIteration: (state) => watcherEngine.onIteration(state),
    checkInterruption: () => sessionStore.hasQueuedMessage()
  }
})
                 ↓
Orchestrator.execute() - MAIN LOOP STARTS
                 ↓
┌─────────────────────────────────────────┐
│ Iteration 1:                          │
│ - Create Agent("standard")             │
│ - Agent.run()                        │
│   - LLM call (decide what to do)    │
│   - Tool: Read("auth.ts")            │
│ - Check goal reached? No              │
│ - call stopHook(watcherevaluates)   │
│ - Continue                           │
└─────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────┐
│ Iteration 2:                          │
│ - Agent.run()                        │
│   - LLM call (decide)               │
│   - Tool: PromptUser({              │ ← AGENT WANTS INPUT
│       question: "Which auth library?" │
│       options: ["NextAuth", "Auth0"]│
│     })                               │
│ - Check termination: user_input_required │
│ - call stopHook: WATCHER DECIDES!   │
│   - Decision engine searches DB        │
│   - Finds: "dec-auth-library"        │
│   - Decision: "Use NextAuth"       │
│   - Confidence: high (0.9)          │
│   - Action: ANSWER                   │
│ - Inject answer: "NextAuth"          │
│ - Continue (don't pause)            │
└─────────────────────────────────────────┘
                 ↓
... more iterations ...
                 ↓
┌─────────────────────────────────────────┐
│ Iteration N:                          │
│ - Agent.run()                        │
│   - Structured output: {             │
│       goalStateReached: true,         │
│       action: "done"                 │
│     }                               │
│ - Check goal reached? YES              │
│ - call stopHook: WATCHER CHECKS    │
│ - Result: allow (no block)           │
│ - Return OrchestratorResult          │
└─────────────────────────────────────────┘
                 ↓
EventBus emits: goal_achieved, response
                 ↓
BridgeGateway streams events to TUI
                 ↓
TUI displays final response
```

## Key Files and Their Roles

### Harness Layer
| File | Purpose |
|------|----------|
| `packages/harness-client/src/index.ts` | Client library for TUI/Telegram - sends commands, receives events |
| `packages/harness-daemon/src/harness/harness.ts` | Main harness - session management, agent registry, tool registry, GraphD integration |
| `packages/harness-daemon/src/harness/bridge_gateway.ts` | Routes bus commands to harness, handles connection state |

### Orchestrator Layer
| File | Purpose |
|------|----------|
| `packages/orchestrator/src/orchestrator.ts` | Loop governor - executes agent until goal/bounds, manages work queue, calls stop hooks |
| `packages/orchestrator/src/orchestrator_runner.ts` | Wrapper for orchestrator execution - creates Orchestrator instances |
| `packages/orchestrator/src/hooks.ts` | Hook system - registerHook, StopHookHandler interface |
| `packages/orchestrator/src/bounds-checker.ts` | Execution bounds checking (iterations, tool calls, duration) |

### Decision Watcher Layer
| File | Purpose |
|------|----------|
| `packages/decision-watcher/src/watcher/index.ts` | Main watcher - intercepts PromptUser, delegates to decision engine |
| `packages/decision-watcher/src/engine/index.ts` | Decision engine - searches database, synthesizes answers, calculates confidence |
| `packages/decision-watcher/src/db/index.ts` | Decision database - InMemoryDecisionDatabase, FileDecisionDatabase |
| `packages/decision-watcher/src/types.ts` | All types for decision watcher (Decision, DecisionEngine, WatcherResponse, etc.) |
| `packages/decision-watcher/src/integration/index.ts` | Integration helpers - DEFAULT_DECISIONS, createWatcherConfig |
| `packages/decision-watcher/src/watcher-agent.ts` | LLM-backed watcher - creates StopHookHandler for orchestrator integration |

### Agent Layer (referenced but not read)
| File | Purpose |
|------|----------|
| `packages/agent/src/index.ts` | Agent - single iteration execution, LLM decision making, tool execution |

## How the Watcher Fits In

### Summary

The **Decision Watcher** is an **orchestrator-level hook** that enables **autonomous agent execution** by:

1. **Intercepting PromptUser events** - When the agent calls PromptUser to ask a question, the watcher decides whether to:
   - **Auto-answer** using its decision database (if confident)
   - **Escalate** to the user (if uncertain or critical)

2. **Providing a StopHook** - The watcher can block termination and inject new goals, enabling patterns like:
   - **Ralph Loop**: Iterative self-referential development where the agent refines its approach
   - **Quality Gates**: Ensure decisions meet project standards before continuing

3. **Per-Session State** - Each session has its own decision database and watcher engine, allowing:
   - Session-specific preferences
   - Decision memory across the session
   - Consistency checking

### Why This Architecture?

- **Separation of Concerns**: Agent focuses on task execution, watcher focuses on project-level decisions
- **Autonomy**: Enables fully async agent execution for routine decisions
- **Consistency**: Maintains decision consistency across a project
- **Auditability**: Decision log tracks all watcher decisions
- **Flexibility**: Watcher can be disabled or operate in different modes (escalate all, auto-answer all, hybrid)

### Key Insight

The watcher's primary integration point is the **stop hook mechanism** in the orchestrator. This is elegant because:

- **Non-invasive**: The orchestrator doesn't need to know about the watcher's internals
- **Composable**: Other stop hooks can be chained (e.g., Ralph Loop + Watcher)
- **Powerful**: Stop hooks can block termination and change execution direction
- **Simple**: Clear contract: `StopHookContext` in → `StopHookResult` out

This allows the watcher to be a **transparent middleware** that sits between the orchestrator's termination logic and the actual termination, making intelligent decisions without disrupting the core loop logic.
