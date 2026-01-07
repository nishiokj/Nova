# Orchestrator Refactor: Loop-Until-Goal Architecture

## Design Spec

### Core Philosophical Shift

**From:** Orchestrator as Task Coordinator (plans upfront, sequences WorkItems, manages DAG state)
**To:** Orchestrator as Loop Governor (provides bounds, manages context, checks terminal condition)

**The Core Question:** Where does intelligence live?

| Aspect | Before | After |
|--------|--------|-------|
| Planning | Forced upfront via RuntimeScriptAgent | Agent-decided, incremental |
| Sequencing | Orchestrator via DAG dependencies | Agent via reasoning |
| Parallelism | Orchestrator dispatches parallel WorkItems | Agent batches tool calls |
| State | WorkItemStateManager | ContextWindow (conversation history) |
| Termination | All WorkItems done | Agent declares GOAL_STATE_REACHED |

### Principles

1. **Goal State is Global** - The agent is not "done" because a tool call succeeded or an iteration completed. Done means the user's original goal has been achieved. The structured output field `goalStateReached` must be explicitly `true`.

2. **Delta Thinking** - Each iteration, the agent compares current state to goal state, identifies the smallest delta, and acts on it. This is enforced via system prompt, not code.

3. **Context is Truth** - No separate state machine. The ContextWindow contains all history: messages, tool calls, results, errors. The agent reads context to understand what's been accomplished.

4. **Agent Decides, Orchestrator Governs** - The agent decides what to do. The orchestrator decides when to stop (bounds exceeded, goal reached, user input needed).

5. **No Legacy, No Compatibility** - Delete obsolete code entirely. The repository reflects only the new architecture.

### Separation of Concerns

```
┌─────────────────────────────────────────────────────────────────┐
│                         HARNESS                                  │
│  - Entry point (TUI integration)                                │
│  - Session/context management                                   │
│  - Config loading                                               │
│  - Wires Orchestrator, Agent, ToolRegistry, AgentRegistry       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       ORCHESTRATOR                               │
│  - Loop governor: call agent, check bounds, check terminal      │
│  - Context management: pass context, handle user input pause    │
│  - Bounds enforcement: maxIterations, maxToolCalls, maxDuration │
│  - Terminal condition: goalStateReached === true                │
│  - Event emission: iteration_started, iteration_completed, etc. │
│  - DOES NOT: plan, sequence, manage WorkItem state              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                          AGENT                                   │
│  - Execution primitive: LLM call → process response → tool calls│
│  - Delta reasoning: compare current state to goal, act          │
│  - Tool dispatch: standard tools + sub-agents                   │
│  - Structured output: { action, response, goalStateReached }    │
│  - DOES NOT: manage loops, enforce bounds (orchestrator does)   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   TOOL REGISTRY + AGENT REGISTRY                 │
│  - Tool execution with caching, timeouts                        │
│  - Agent-as-tool detection and dispatch                         │
│  - Unchanged from current implementation                        │
└─────────────────────────────────────────────────────────────────┘
```

### New Orchestrator Loop (Pseudocode)

```typescript
async execute(context: ContextWindow, goal: string, agentType: string): Promise<OrchestratorResult> {
  const agent = this.createAgent(agentType);
  const workItem = this.createWorkItem(goal);

  let iteration = 0;
  let totalToolCalls = 0;
  let totalLlmCalls = 0;
  const startTime = Date.now();

  while (true) {
    iteration++;

    // BOUND CHECK: Iterations
    if (iteration > this.config.maxIterations) {
      return this.createResult({ success: false, reason: 'max_iterations_exceeded' });
    }

    // BOUND CHECK: Duration
    if (Date.now() - startTime > this.config.maxDurationMs) {
      return this.createResult({ success: false, reason: 'max_duration_exceeded' });
    }

    this.emit('iteration_started', { iteration, goal });

    // AGENT EXECUTION: Single iteration
    const result = await agent.run({ context, workItem });

    totalToolCalls += result.metrics.toolCallsMade;
    totalLlmCalls += result.metrics.llmCallsMade;

    this.emit('iteration_completed', { iteration, result });

    // TERMINAL CHECK: User input needed
    if (result.needsUserInput) {
      // Agent's question already in context from agent.run()
      return this.createResult({
        success: false,
        paused: true,
        userPrompt: result.userPrompt
      });
    }

    // TERMINAL CHECK: Goal state reached
    if (result.structuredOutput?.goalStateReached === true) {
      return this.createResult({
        success: true,
        response: result.response,
        reason: 'goal_state_reached'
      });
    }

    // TERMINAL CHECK: Agent error/refusal
    if (result.isRefusal || result.error) {
      return this.createResult({
        success: false,
        error: result.error,
        reason: result.isRefusal ? 'refusal' : 'agent_error'
      });
    }

    // BOUND CHECK: Tool calls (across all iterations)
    if (totalToolCalls >= this.config.maxToolCalls) {
      return this.createResult({ success: false, reason: 'max_tool_calls_exceeded' });
    }

    // Continue loop - agent will see previous iteration's context
  }
}

async resume(context: ContextWindow, userResponse: string): Promise<OrchestratorResult> {
  // Inject user response into context
  context.addMessage('user', userResponse);
  // Re-enter loop with same goal (stored in context or passed separately)
  return this.execute(context, this.extractGoalFromContext(context), this.agentType);
}
```

### Structured Output Schema Changes

**Current (Agent):**
```typescript
{
  action: 'final' | 'need_context' | 'continue',
  response: string,
  user_prompt?: { question: string, context?: string }
}
```

**New (Agent):**
```typescript
{
  action: 'continue' | 'need_user_input' | 'done',
  response: string | null,           // Final response to user (only when done)
  goalStateReached: boolean | null,  // Explicit: true = goal achieved, null/false = not yet
  userPrompt?: {                     // Only when action = 'need_user_input'
    question: string,
    context?: string
  },
  reasoning?: string                 // Optional: agent's delta analysis (for logging)
}
```

**Key Change:** `goalStateReached` is an explicit boolean field. The agent must set it to `true` only when the user's original goal is fully satisfied. The orchestrator checks `goalStateReached === true` as the terminal condition.

### System Prompt Changes

**Current STANDARD_PROMPT snippets to change:**

Remove:
- References to `[FINAL]`, `[NEED_CONTEXT]`, `[CONTINUE]` markers
- WorkItem-specific language

Add:
```
## Goal-Driven Execution

You are executing toward a user's goal. Each turn:

1. **STATE ASSESSMENT**: Review the conversation history. What has been accomplished? What files have been read/written? What errors occurred?

2. **DELTA IDENTIFICATION**: What is the gap between current state and goal state? What is the smallest action that closes this gap?

3. **ACTION**: Execute that action:
   - Use tools to read files, write code, run commands
   - Call sub-agents for complex subtasks
   - Ask for user input if blocked on missing information
   - Declare done when the goal is fully achieved

## Structured Output

Always respond with:
- `action`: "continue" (more work needed), "need_user_input" (blocked), or "done" (goal achieved)
- `response`: Your message to the user (required when action is "done")
- `goalStateReached`: Set to `true` ONLY when the user's original goal is fully satisfied. Otherwise null.
- `userPrompt`: If action is "need_user_input", include { question, context }
- `reasoning`: Brief summary of your state assessment and delta identification

CRITICAL: `goalStateReached: true` means the ENTIRE user goal is complete, not just this iteration.
```

### Files to Modify

| File | Action | Details |
|------|--------|---------|
| `orchestrator/orchestrator.ts` | PATCH | Gut and replace with loop-until-goal |
| `orchestrator/runtime-script.ts` | MOVE | Extract to `orchestrator/dag-executor.ts` |
| `orchestrator/workitem-state.ts` | DELETE | No longer needed |
| `orchestrator/index.ts` | PATCH | Update exports |
| `agent/agent.ts` | PATCH | Update structured output handling |
| `agent/types.ts` | PATCH | Update AgentResult, add new schema |
| `agent/prompts.ts` | PATCH | Update STANDARD_PROMPT |
| `harness/harness.ts` | PATCH | Replace tier with agentType, update orchestrator calls |
| `harness/config_loader.ts` | PATCH | Remove tier references |
| `shared/structured_output.ts` | PATCH | Update schema if needed |
| `config/harness_config.json` | PATCH | Update standard agent output schema |

### Code to Delete

1. **orchestrator/workitem-state.ts** - Entire file (WorkItemStateManager no longer needed)
2. **orchestrator/orchestrator.ts**:
   - `generateRuntimeScript()` method (~150 lines)
   - `executeDAG()` method (~130 lines)
   - `dispatchAgent()` method (~50 lines)
   - `resolveAgentRuntimeConfig()` - keep, still useful
   - `WorkItemStateManager` usage and initialization
   - `inFlight` Map and parallel dispatch logic
   - DAG-related event emissions
3. **harness/harness.ts**:
   - `tier` parameter handling
   - `runOrchestrator()` tier logic

### Code to Create

1. **orchestrator/dag-executor.ts** - Standalone DAG execution (extracted from orchestrator)
   - `executeDAG(script: RuntimeScript, context: ContextWindow): Promise<DAGResult>`
   - `RuntimeScript` and `WorkItem` types (moved from runtime-script.ts)
   - `parseRuntimeScript()` function
   - Minimal, focused on parallel WorkItem dispatch
   - NOT integrated into main orchestrator flow (for future use)

---

## Implementation Spec

### Phase 1: Update Types and Schemas

#### Step 1.1: Update Agent Structured Output Schema

**File:** `src/agent-ts/agent/types.ts`

**PATCH** `StructuredAgentOutput` interface (or create if not exists):

```typescript
// REPLACE existing StructuredAgentOutput with:
interface StructuredAgentOutput {
  action: 'continue' | 'need_user_input' | 'done';
  response: string | null;
  goalStateReached: boolean | null;
  userPrompt?: {
    question: string;
    context?: string;
  };
  reasoning?: string;
}
```

**PATCH** `AgentResult` interface - ensure it has:
```typescript
interface AgentResult {
  // ... existing fields ...
  structuredOutput?: StructuredAgentOutput;  // Type the generic Record more specifically
}
```

#### Step 1.2: Update Orchestrator Types

**File:** `src/agent-ts/orchestrator/orchestrator.ts`

**PATCH** `OrchestratorConfig`:
```typescript
interface OrchestratorConfig {
  maxIterations: number;      // Per-goal, not per-WorkItem
  maxToolCalls: number;       // Total across all iterations
  maxDurationMs: number;      // Total wall-clock time
  // REMOVE: maxParallelAgents, maxRetriesPerWorkItem (DAG-specific)
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxIterations: 50,
  maxToolCalls: 200,
  maxDurationMs: 300_000,  // 5 minutes
};
```

**PATCH** `OrchestratorResult`:
```typescript
interface OrchestratorResult {
  success: boolean;
  response?: string;           // Final response to user
  error?: string;
  paused: boolean;             // True if waiting for user input
  userPrompt?: UserPromptInfo;
  terminationReason:
    | 'goal_state_reached'
    | 'max_iterations_exceeded'
    | 'max_tool_calls_exceeded'
    | 'max_duration_exceeded'
    | 'user_input_required'
    | 'agent_error'
    | 'refusal';
  metrics: OrchestratorMetrics;
}

interface OrchestratorMetrics {
  iterations: number;
  totalLlmCalls: number;
  totalToolCalls: number;
  durationMs: number;
}
```

### Phase 2: Update System Prompts

#### Step 2.1: Update STANDARD_PROMPT

**File:** `src/agent-ts/agent/prompts.ts`

**PATCH** `STANDARD_PROMPT` - replace the action/response instructions with:

```typescript
const STANDARD_PROMPT = `You are a highly capable AI agent...

## Goal-Driven Execution

You are working toward a user's goal. Each turn:

1. **STATE ASSESSMENT**: Review conversation history. What has been accomplished? What files read/written? What errors occurred?

2. **DELTA IDENTIFICATION**: What is the gap between current state and goal state? What is the smallest action that closes this gap?

3. **ACTION**: Execute that action via tools, sub-agents, or response.

## Structured Output (REQUIRED)

You MUST respond with valid JSON:
{
  "action": "continue" | "need_user_input" | "done",
  "response": "string or null",
  "goalStateReached": true | false | null,
  "userPrompt": { "question": "...", "context": "..." } | null,
  "reasoning": "Brief state assessment and delta identification"
}

### Action Values:
- "continue": More work needed. You will be called again.
- "need_user_input": You are blocked and need information from the user. MUST include userPrompt.
- "done": The goal is FULLY achieved. MUST include response and goalStateReached: true.

### CRITICAL RULES:
- goalStateReached: true means the ENTIRE original user goal is satisfied, not just this iteration.
- Only set goalStateReached: true when you are confident the user's request is complete.
- If unsure, set goalStateReached: null and action: continue.
- The "response" field is your message to the user - required when action is "done".

## Tool Usage
...existing tool guidance...
`;
```

#### Step 2.2: Update other prompts that use action markers

**File:** `src/agent-ts/agent/prompts.ts`

**PATCH** any other prompts (SIMPLE_PROMPT, EXPLORER_PROMPT, etc.) that reference `[FINAL]`, `[NEED_CONTEXT]`, `[CONTINUE]`:
- Replace with structured output instructions
- Or keep simpler prompts for single-iteration agents (routing, simple) that don't need the full loop

### Phase 3: Delete Obsolete Code

#### Step 3.1: Delete WorkItemStateManager

**File:** `src/agent-ts/orchestrator/workitem-state.ts`

**DELETE** entire file.

#### Step 3.2: Update orchestrator/index.ts exports

**File:** `src/agent-ts/orchestrator/index.ts`

**PATCH** - remove exports:
```typescript
// DELETE these exports:
export { WorkItemStateManager, WorkItemState, WorkItemStatus } from './workitem-state';
// Keep RuntimeScript exports for dag-executor (will be moved)
```

### Phase 4: Extract DAG Executor

#### Step 4.1: Create dag-executor.ts

**File:** `src/agent-ts/orchestrator/dag-executor.ts`

**CREATE** new file with extracted DAG execution logic:

```typescript
/**
 * DAG Executor - Standalone module for executing RuntimeScript WorkItem DAGs
 *
 * Extracted from orchestrator for separation of concerns.
 * Not used by main orchestrator loop - available for future parallel execution needs.
 */

import { ContextWindow } from '../wizard/context';
import { Agent } from '../agent/agent';
import { AgentResult } from '../agent/types';
import { WorkItem, WorkBounds, createWorkItem, DEFAULT_WORK_BOUNDS } from '../wizard/work-item';
import { LLMAdapter, LLMRequestConfig } from '../llm/adapter';
import { ToolRegistry } from '../tools/registry';
import { AgentRegistry } from '../agent/agent-registry';
import { EventEmitCallback } from '../communication/event_bus';

// --- Types ---

export interface RuntimeScript {
  goal: string;
  workItems: WorkItem[];
  createdAt: number;
}

export interface RuntimeScriptOutput {
  goal: string;
  workItems: Array<{
    id: string;
    objective: string;
    delta: string;
    agent: string;
    dependencies: string[];
    toolHint?: string;
    targetPaths?: string[];
    params?: Record<string, unknown>;
  }>;
}

export interface DAGExecutorConfig {
  maxParallelAgents: number;
  maxRetriesPerWorkItem: number;
  maxIterations: number;
}

export interface DAGResult {
  success: boolean;
  error?: string;
  completedWorkItems: string[];
  failedWorkItems: string[];
  metrics: {
    totalLlmCalls: number;
    totalToolCalls: number;
    durationMs: number;
  };
}

type WorkItemStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

interface WorkItemState {
  workItem: WorkItem;
  status: WorkItemStatus;
  attemptCount: number;
  result?: AgentResult;
  error?: string;
}

// --- Parser ---

export function parseRuntimeScript(output: RuntimeScriptOutput): RuntimeScript {
  const workItems: WorkItem[] = output.workItems.map((item) =>
    createWorkItem({
      workId: item.id,
      goal: output.goal,
      objective: item.objective,
      delta: item.delta,
      agent: item.agent,
      dependencies: item.dependencies,
      toolHint: item.toolHint,
      targetPaths: item.targetPaths ?? [],
      params: item.params,
    })
  );

  return {
    goal: output.goal,
    workItems,
    createdAt: Date.now(),
  };
}

// --- Executor ---

export class DAGExecutor {
  private config: DAGExecutorConfig;
  private states: Map<string, WorkItemState> = new Map();

  constructor(
    config: Partial<DAGExecutorConfig>,
    private toolRegistry: ToolRegistry,
    private llm: LLMAdapter,
    private emit: EventEmitCallback,
    private agentRegistry?: AgentRegistry
  ) {
    this.config = {
      maxParallelAgents: config.maxParallelAgents ?? 3,
      maxRetriesPerWorkItem: config.maxRetriesPerWorkItem ?? 3,
      maxIterations: config.maxIterations ?? 100,
    };
  }

  async execute(script: RuntimeScript, context: ContextWindow): Promise<DAGResult> {
    const startTime = Date.now();
    let totalLlmCalls = 0;
    let totalToolCalls = 0;

    // Initialize state
    this.states.clear();
    for (const workItem of script.workItems) {
      this.states.set(workItem.workId, {
        workItem,
        status: 'pending',
        attemptCount: 0,
      });
    }

    const inFlight = new Map<string, Promise<{ workId: string; result: AgentResult }>>();
    let iteration = 0;

    while (!this.isAllDone() || inFlight.size > 0) {
      iteration++;
      if (iteration > this.config.maxIterations) break;

      // Dispatch ready WorkItems
      const ready = this.getReady();
      for (const state of ready) {
        if (inFlight.size >= this.config.maxParallelAgents) break;

        const { workItem } = state;
        state.status = 'in_progress';
        state.attemptCount++;

        const promise = this.dispatchWorkItem(workItem, context).then((result) => ({
          workId: workItem.workId,
          result,
        }));
        inFlight.set(workItem.workId, promise);
      }

      if (inFlight.size === 0) {
        if (!this.isAllDone()) break; // Deadlock
        continue;
      }

      // Wait for first completion
      const completed = await Promise.race(inFlight.values());
      inFlight.delete(completed.workId);

      const state = this.states.get(completed.workId)!;
      const { result } = completed;

      totalLlmCalls += result.metrics.llmCallsMade;
      totalToolCalls += result.metrics.toolCallsMade;

      if (result.success) {
        state.status = 'completed';
        state.result = result;
      } else {
        if (state.attemptCount < this.config.maxRetriesPerWorkItem) {
          state.status = 'pending'; // Retry
        } else {
          state.status = 'failed';
          state.error = result.error;
          state.result = result;
        }
      }
    }

    const completed = [...this.states.values()].filter((s) => s.status === 'completed').map((s) => s.workItem.workId);
    const failed = [...this.states.values()].filter((s) => s.status === 'failed').map((s) => s.workItem.workId);

    return {
      success: failed.length === 0 && completed.length > 0,
      completedWorkItems: completed,
      failedWorkItems: failed,
      metrics: {
        totalLlmCalls,
        totalToolCalls,
        durationMs: Date.now() - startTime,
      },
    };
  }

  private async dispatchWorkItem(workItem: WorkItem, context: ContextWindow): Promise<AgentResult> {
    const runtime = this.agentRegistry?.getRuntimeConfig(workItem.agent);
    if (!runtime) {
      return {
        success: false,
        response: '',
        error: `Unknown agent type: ${workItem.agent}`,
        metrics: { llmCallsMade: 0, toolCallsMade: 0, durationMs: 0 },
        filesRead: [],
        invalidatedPaths: [],
        toolErrors: [],
        terminationReason: 'exception',
        needsUserInput: false,
        isRefusal: false,
      };
    }

    const agent = new Agent(
      runtime.config,
      this.llm,
      this.toolRegistry,
      this.emit,
      workItem.workId,
      this.agentRegistry,
      runtime.llm
    );

    return agent.run({ context, workItem });
  }

  private getReady(): WorkItemState[] {
    return [...this.states.values()].filter((state) => {
      if (state.status !== 'pending') return false;
      return state.workItem.dependencies.every((depId) => {
        const dep = this.states.get(depId);
        return dep && dep.status === 'completed';
      });
    });
  }

  private isAllDone(): boolean {
    return [...this.states.values()].every((s) => s.status === 'completed' || s.status === 'failed');
  }
}
```

### Phase 5: Rewrite Orchestrator

#### Step 5.1: Gut and replace orchestrator.ts

**File:** `src/agent-ts/orchestrator/orchestrator.ts`

**DELETE** the following methods entirely:
- `generateRuntimeScript()` (~lines 257-400)
- `executeDAG()` (~lines 405-534)
- `dispatchAgent()` (~lines 536-620)
- Any WorkItemStateManager usage

**DELETE** the following properties:
- `stateManager: WorkItemStateManager`
- `workLedger: WorkLedger` (optional: keep if useful for audit)
- `knowledgeStore: KnowledgeStore` (optional: keep if useful)

**PATCH** - Replace with new loop implementation:

```typescript
import { ContextWindow } from '../wizard/context';
import { Agent } from '../agent/agent';
import { AgentConfig, AgentResult, StructuredAgentOutput } from '../agent/types';
import { WorkItem, createWorkItem, DEFAULT_WORK_BOUNDS } from '../wizard/work-item';
import { LLMAdapter, LLMRequestConfig } from '../llm/adapter';
import { ToolRegistry } from '../tools/registry';
import { AgentRegistry } from '../agent/agent-registry';
import { EventEmitCallback } from '../communication/event_bus';
import { UserPromptInfo } from '../agent/types';

// --- Types ---

export interface OrchestratorConfig {
  maxIterations: number;
  maxToolCalls: number;
  maxDurationMs: number;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxIterations: 50,
  maxToolCalls: 200,
  maxDurationMs: 300_000,
};

export type TerminationReason =
  | 'goal_state_reached'
  | 'max_iterations_exceeded'
  | 'max_tool_calls_exceeded'
  | 'max_duration_exceeded'
  | 'user_input_required'
  | 'agent_error'
  | 'refusal';

export interface OrchestratorMetrics {
  iterations: number;
  totalLlmCalls: number;
  totalToolCalls: number;
  durationMs: number;
}

export interface OrchestratorResult {
  success: boolean;
  response?: string;
  error?: string;
  paused: boolean;
  userPrompt?: UserPromptInfo;
  terminationReason: TerminationReason;
  metrics: OrchestratorMetrics;
}

export interface OrchestratorLogger {
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
}

// --- Orchestrator ---

export class Orchestrator {
  private config: OrchestratorConfig;
  private goal: string = '';
  private agentType: string = 'standard';

  constructor(
    config: Partial<OrchestratorConfig>,
    private toolRegistry: ToolRegistry,
    private llm: LLMAdapter,
    private emit: EventEmitCallback,
    private requestId: string,
    private logger?: OrchestratorLogger,
    private agentRegistry?: AgentRegistry
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Main entry point: Execute until goal is reached or bounds exceeded.
   */
  async execute(
    context: ContextWindow,
    goal: string,
    agentType: string = 'standard'
  ): Promise<OrchestratorResult> {
    this.goal = goal;
    this.agentType = agentType;

    const startTime = Date.now();
    let iteration = 0;
    let totalLlmCalls = 0;
    let totalToolCalls = 0;

    // Create agent for this goal
    const agent = this.createAgent(agentType);
    if (!agent) {
      return this.createResult({
        success: false,
        error: `Unknown agent type: ${agentType}`,
        terminationReason: 'agent_error',
        metrics: { iterations: 0, totalLlmCalls: 0, totalToolCalls: 0, durationMs: 0 },
      });
    }

    // Create work item representing the goal
    const workItem = this.createWorkItem(goal);

    this.log('info', `Starting orchestration`, { goal, agentType });
    this.emit('orchestration_started', { goal, agentType, requestId: this.requestId });

    while (true) {
      iteration++;
      const elapsed = Date.now() - startTime;

      // BOUND CHECK: Iterations
      if (iteration > this.config.maxIterations) {
        this.log('warn', 'Max iterations exceeded', { iteration });
        return this.createResult({
          success: false,
          terminationReason: 'max_iterations_exceeded',
          metrics: { iterations: iteration - 1, totalLlmCalls, totalToolCalls, durationMs: elapsed },
        });
      }

      // BOUND CHECK: Duration
      if (elapsed > this.config.maxDurationMs) {
        this.log('warn', 'Max duration exceeded', { elapsed });
        return this.createResult({
          success: false,
          terminationReason: 'max_duration_exceeded',
          metrics: { iterations: iteration - 1, totalLlmCalls, totalToolCalls, durationMs: elapsed },
        });
      }

      this.log('info', `Iteration ${iteration}`, { totalToolCalls, totalLlmCalls });
      this.emit('iteration_started', { iteration, goal, requestId: this.requestId });

      // AGENT EXECUTION
      const result = await agent.run({ context, workItem });

      totalLlmCalls += result.metrics.llmCallsMade;
      totalToolCalls += result.metrics.toolCallsMade;

      this.emit('iteration_completed', {
        iteration,
        result: {
          success: result.success,
          response: result.response?.slice(0, 200),
          toolCalls: result.metrics.toolCallsMade,
          llmCalls: result.metrics.llmCallsMade,
        },
        requestId: this.requestId,
      });

      // TERMINAL CHECK: User input needed
      if (result.needsUserInput && result.userPrompt) {
        this.log('info', 'Pausing for user input', { question: result.userPrompt.question });
        return this.createResult({
          success: false,
          paused: true,
          userPrompt: result.userPrompt,
          terminationReason: 'user_input_required',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: Date.now() - startTime },
        });
      }

      // TERMINAL CHECK: Goal state reached
      const structured = result.structuredOutput as StructuredAgentOutput | undefined;
      if (structured?.goalStateReached === true) {
        this.log('info', 'Goal state reached', { response: result.response?.slice(0, 100) });
        this.emit('goal_achieved', { goal, response: result.response, requestId: this.requestId });
        return this.createResult({
          success: true,
          response: result.response || structured.response || '',
          terminationReason: 'goal_state_reached',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: Date.now() - startTime },
        });
      }

      // TERMINAL CHECK: Agent refusal
      if (result.isRefusal) {
        this.log('warn', 'Agent refused', { response: result.response });
        return this.createResult({
          success: false,
          error: result.response,
          terminationReason: 'refusal',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: Date.now() - startTime },
        });
      }

      // TERMINAL CHECK: Hard agent error (not recoverable)
      if (result.error && !result.success && structured?.action !== 'continue') {
        this.log('error', 'Agent error', { error: result.error });
        return this.createResult({
          success: false,
          error: result.error,
          terminationReason: 'agent_error',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: Date.now() - startTime },
        });
      }

      // BOUND CHECK: Total tool calls
      if (totalToolCalls >= this.config.maxToolCalls) {
        this.log('warn', 'Max tool calls exceeded', { totalToolCalls });
        return this.createResult({
          success: false,
          terminationReason: 'max_tool_calls_exceeded',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: Date.now() - startTime },
        });
      }

      // Continue loop - agent will see accumulated context
      this.log('info', `Continuing to iteration ${iteration + 1}`);
    }
  }

  /**
   * Resume after user input pause.
   */
  async resume(context: ContextWindow, userResponse: string): Promise<OrchestratorResult> {
    // Inject user response into context
    context.addMessage('user', userResponse);
    this.log('info', 'Resuming after user input');

    // Re-enter loop with stored goal and agent type
    return this.execute(context, this.goal, this.agentType);
  }

  // --- Private helpers ---

  private createAgent(agentType: string): Agent | null {
    const runtime = this.agentRegistry?.getRuntimeConfig(agentType);
    if (!runtime) return null;

    return new Agent(
      runtime.config,
      this.llm,
      this.toolRegistry,
      this.emit,
      this.requestId,
      this.agentRegistry,
      runtime.llm
    );
  }

  private createWorkItem(goal: string): WorkItem {
    return createWorkItem({
      workId: this.requestId,
      goal,
      objective: goal,
      agent: this.agentType,
      dependencies: [],
      targetPaths: [],
    });
  }

  private createResult(partial: Partial<OrchestratorResult> & { terminationReason: TerminationReason; metrics: OrchestratorMetrics }): OrchestratorResult {
    return {
      success: partial.success ?? false,
      response: partial.response,
      error: partial.error,
      paused: partial.paused ?? false,
      userPrompt: partial.userPrompt,
      terminationReason: partial.terminationReason,
      metrics: partial.metrics,
    };
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void {
    if (this.logger) {
      this.logger[level](`[Orchestrator] ${msg}`, data);
    }
  }
}
```

### Phase 6: Update Harness

#### Step 6.1: Replace tier with agentType

**File:** `src/agent-ts/harness/harness.ts`

**PATCH** `runOrchestrator()` method:

```typescript
// BEFORE:
async runOrchestrator(context: ContextWindow, goal: string, tier: 'standard' | 'complex'): Promise<...>

// AFTER:
async runOrchestrator(context: ContextWindow, goal: string, agentType: string = 'standard'): Promise<...>
```

**PATCH** the orchestrator instantiation:

```typescript
// BEFORE:
const result = await orchestrator.execute(context, goal, tier === 'complex' ? 'complex' : 'standard');

// AFTER:
const result = await orchestrator.execute(context, goal, agentType);
```

**PATCH** any `Tier` type references - delete or replace with `agentType: string`.

#### Step 6.2: Update harness exports

**File:** `src/agent-ts/harness/harness.ts`

**DELETE** `Tier` type export if exists.

### Phase 7: Update Agent

#### Step 7.1: Update structured output handling

**File:** `src/agent-ts/agent/agent.ts`

**PATCH** the response parsing in `executeLoop()` to handle new schema:

```typescript
// In the section that parses structured output (around line 250-280):
// Ensure we extract goalStateReached, action, response from structured output

const structured = result.structuredOutput as StructuredAgentOutput | undefined;

// Map action to termination
if (structured?.action === 'done' && structured.goalStateReached === true) {
  // Agent declares goal reached
  result.success = true;
  result.response = structured.response || result.response;
  result.terminationReason = 'final';
}

if (structured?.action === 'need_user_input' && structured.userPrompt) {
  result.needsUserInput = true;
  result.userPrompt = structured.userPrompt;
  result.terminationReason = 'user_input_required';
}
```

#### Step 7.2: Ensure agent adds its question to context before pause

**File:** `src/agent-ts/agent/agent.ts`

**PATCH** - When `needsUserInput` is true, ensure the agent's question is in the context:

```typescript
// Before returning with needsUserInput: true
if (result.needsUserInput && result.userPrompt) {
  // The assistant message with the question should already be in context
  // from addMessage() after LLM response. Verify this is the case.
  // If not, add: context.addMessage('assistant', result.userPrompt.question);
}
```

### Phase 8: Update Config

#### Step 8.1: Update harness_config.json

**File:** `config/harness_config.json`

**PATCH** the `standard` agent config to include new output schema:

```json
{
  "standard": {
    "llm": { ... },
    "budget": { ... },
    "tools": [ ... ],
    "output_schema": {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": ["continue", "need_user_input", "done"]
        },
        "response": {
          "type": ["string", "null"]
        },
        "goalStateReached": {
          "type": ["boolean", "null"]
        },
        "userPrompt": {
          "type": ["object", "null"],
          "properties": {
            "question": { "type": "string" },
            "context": { "type": "string" }
          }
        },
        "reasoning": {
          "type": ["string", "null"]
        }
      },
      "required": ["action", "goalStateReached"]
    }
  }
}
```

### Phase 9: Update Exports and Cleanup

#### Step 9.1: Update orchestrator/index.ts

**File:** `src/agent-ts/orchestrator/index.ts`

**PATCH** exports:

```typescript
// Core orchestrator (new loop-based)
export { Orchestrator, OrchestratorConfig, OrchestratorResult, OrchestratorMetrics, TerminationReason } from './orchestrator';

// DAG executor (standalone, for future use)
export { DAGExecutor, DAGExecutorConfig, DAGResult, RuntimeScript, RuntimeScriptOutput, parseRuntimeScript } from './dag-executor';

// Work items (still needed for agent interface)
export { WorkItem, WorkBounds, createWorkItem } from '../wizard/work-item';

// DELETE: WorkItemStateManager exports
// DELETE: Tier export
```

#### Step 9.2: Delete runtime-script.ts (merged into dag-executor.ts)

**File:** `src/agent-ts/orchestrator/runtime-script.ts`

**DELETE** entire file (content moved to dag-executor.ts).

### Phase 10: Event Emission Updates

#### Step 10.1: Update event types

**File:** `src/agent-ts/communication/event_bus.ts` (if event types defined here)

**PATCH** - Add new events, remove DAG-specific events:

```typescript
// ADD:
type OrchestratorEvent =
  | { type: 'orchestration_started'; goal: string; agentType: string; requestId: string }
  | { type: 'iteration_started'; iteration: number; goal: string; requestId: string }
  | { type: 'iteration_completed'; iteration: number; result: { success: boolean; response?: string; toolCalls: number; llmCalls: number }; requestId: string }
  | { type: 'goal_achieved'; goal: string; response?: string; requestId: string }
  | { type: 'goal_not_achieved'; goal: string; reason: TerminationReason; error?: string; requestId: string };

// REMOVE (or deprecate):
// - 'runtime_script_created'
// - 'workitem_started'
// - 'workitem_completed'
// - 'workitem_failed'
```

---

## Verification Checklist

After implementation, verify:

1. [ ] `Orchestrator.execute()` loops until `goalStateReached === true` or bounds exceeded
2. [ ] `Orchestrator.resume()` injects user response and continues
3. [ ] Agent structured output includes `goalStateReached` field
4. [ ] System prompt instructs delta thinking and explicit goal completion
5. [ ] DAGExecutor is standalone in `dag-executor.ts`, not used by orchestrator
6. [ ] `workitem-state.ts` deleted
7. [ ] `runtime-script.ts` deleted (merged into dag-executor.ts)
8. [ ] No references to `tier` remain (replaced with `agentType`)
9. [ ] No references to `WorkItemStateManager` remain
10. [ ] Events updated for iteration-based model
11. [ ] harness_config.json has new output_schema for standard agent
12. [ ] Net reduction in lines of code achieved

## File Summary

| File | Action | Lines Changed (est.) |
|------|--------|---------------------|
| `orchestrator/orchestrator.ts` | REWRITE | -400, +180 |
| `orchestrator/dag-executor.ts` | CREATE | +200 |
| `orchestrator/runtime-script.ts` | DELETE | -100 |
| `orchestrator/workitem-state.ts` | DELETE | -120 |
| `orchestrator/index.ts` | PATCH | -10, +5 |
| `agent/types.ts` | PATCH | +15 |
| `agent/agent.ts` | PATCH | +20 |
| `agent/prompts.ts` | PATCH | -30, +40 |
| `harness/harness.ts` | PATCH | -20, +10 |
| `config/harness_config.json` | PATCH | +20 |
| `communication/event_bus.ts` | PATCH | +10 |

**Net change:** ~-400 lines (significant reduction)
