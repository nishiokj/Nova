# Agent Architecture Refactor: Implementation Specification

**Version**: 1.0
**Date**: 2026-01-06
**Status**: Draft

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architectural Invariants](#2-architectural-invariants)
3. [System Flow](#3-system-flow)
4. [Cleanup & Deletions](#4-cleanup--deletions)
5. [New Type Definitions](#5-new-type-definitions)
6. [Agent Primitive](#6-agent-primitive)
7. [Orchestrator](#7-orchestrator)
8. [Event System](#8-event-system)
9. [Harness Integration](#9-harness-integration)
10. [State Management](#10-state-management)
11. [Agent Instantiation & Tool Discretion](#11-agent-instantiation--tool-discretion)
12. [Session & Request Tracking](#12-session--request-tracking)
13. [Logger Integration](#13-logger-integration)
14. [LLM Adapter Compliance](#14-llm-adapter-compliance)
15. [Migration Checklist](#15-migration-checklist)

---

## 1. Executive Summary

This specification defines the refactoring of the current `Agent → Planner → Wizard → Worker` architecture into a cleaner **Agents-as-Functions + Orchestrator** model.

### Current Architecture (To Be Replaced)

```
Harness
  └─ Agent (coordinator, creates Planner, Wizard)
       ├─ Planner (creates WizardPlan with WizardSteps)
       └─ Wizard (orchestrates Workers over PlanState)
            └─ Worker (executes bounded work, returns WorkerOutcome)
```

**Problems:**
- Agent is an awkward coordinator, not a true agent
- Planner is functionally an agent but implemented as a separate class
- Worker is functionally an agent but named differently
- WizardPlan/WizardStep/PlanState are coupled abstractions
- Tight coupling between planning and execution

### New Architecture

```
Harness
  ├─ RoutingAgent(goal) → tier classification
  │
  ├─ [simple] → Agent.run(context, workItem) → response
  │              Context updated, no orchestration
  │
  └─ [standard|complex] → Orchestrator.execute(context, goal)
                           ├─ ExplorerAgent → system context
                           ├─ RuntimeScriptAgent → WorkItem DAG
                           └─ Execute DAG → response
```

**Key Changes:**
- **Agent** is the pure, composable primitive (absorbs Worker)
- **Orchestrator** dispatches agents and owns state (replaces Wizard)
- **WorkItem** is the unit of work (replaces WizardStep)
- **RuntimeScript** is the declarative execution plan (replaces WizardPlan)
- **RoutingAgent** lives in Harness, gates Orchestrator invocation
- Event callback pattern replaces direct EventBus coupling

---

## 2. Architectural Invariants

### 2.1 Agent Invariants

| Invariant | Description | Rationale |
|-----------|-------------|-----------|
| **AI-1** | Agent receives ContextWindow by value and mutates it locally during its lifecycle | Enables pure function semantics while allowing efficient context building |
| **AI-2** | Agent receives an EventEmitCallback, never the EventBus directly | Decouples agent from event infrastructure; callback handles tagging and fan-out |
| **AI-3** | Agent.run() is the single entry point; all configuration is at construction | Clean API: `agent.run({ context, workItem })` with no ambient state |
| **AI-4** | Agent returns AgentResult with all outputs; no side effects beyond context mutation | Enables composition and testing |
| **AI-5** | Agent tool access is determined at instantiation via config.tools | Enforces tool discretion per agent type |

### 2.2 Orchestrator Invariants

| Invariant | Description | Rationale |
|-----------|-------------|-----------|
| **OI-1** | Orchestrator is invoked only for `standard` and `complex` tiers | Simple requests bypass orchestration entirely |
| **OI-2** | Orchestrator owns WorkLedger, KnowledgeStore; receives ContextWindow from caller | Single-writer pattern for state; context ownership stays with Harness |
| **OI-3** | Orchestrator returns when queue is empty and all agents have returned | No background execution; synchronous completion model |
| **OI-4** | Orchestrator returns output from last completed WorkItem | Deterministic output selection |
| **OI-5** | RuntimeScript is immutable during execution (patching deferred to future) | Simplifies initial implementation |

### 2.3 Event Invariants

| Invariant | Description | Rationale |
|-----------|-------------|-----------|
| **EI-1** | Every event carries `requestId` | Enables per-run routing and telemetry correlation |
| **EI-2** | EventEmitCallback is passed down the call chain; components never instantiate EventBus | Inversion of control; testability |
| **EI-3** | Event publishing uses `queueMicrotask()` for async fan-out | Non-blocking; prevents event handler exceptions from breaking execution |
| **EI-4** | EventBus supports `subscribeRun(runId, handler)` for per-run channels | TUI can subscribe to specific run, unsubscribe on completion |

### 2.4 State Invariants

| Invariant | Description | Rationale |
|-----------|-------------|-----------|
| **SI-1** | ContextWindow is created/hydrated by Harness, passed to Orchestrator/Agent | Single source of truth for conversation state |
| **SI-2** | Session state persists to GraphD at run completion | Durability for resume capability |
| **SI-3** | Request state (requestId, runId) flows through entire execution chain | Traceability |

---

## 3. System Flow

### 3.1 High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                 HARNESS                                      │
│                                                                              │
│  1. Receive request (inputText, sessionKey, requestId)                      │
│  2. Get/create ContextWindow for session                                     │
│  3. Create EventEmitCallback that tags events with requestId                │
│  4. Call RoutingAgent(goal) → tier                                          │
│                                                                              │
│  ┌─────────────────────┐    ┌──────────────────────────────────────────┐   │
│  │  tier === 'simple'  │    │  tier === 'standard' | 'complex'         │   │
│  │                     │    │                                          │   │
│  │  Create Agent       │    │  Create Orchestrator                     │   │
│  │  Run single WorkItem│    │  Orchestrator.execute(context, goal)     │   │
│  │  Return response    │    │  Return response                         │   │
│  └─────────────────────┘    └──────────────────────────────────────────┘   │
│                                                                              │
│  5. Persist ContextWindow to GraphD                                         │
│  6. Return AgentRunResult                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Orchestrator Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              ORCHESTRATOR                                    │
│                                                                              │
│  execute(context: ContextWindow, goal: string, tier: Tier)                  │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ PHASE 1: EXPLORATION                                                  │   │
│  │                                                                        │   │
│  │ 1. Build exploration questions from goal                              │   │
│  │ 2. Instantiate ExplorerAgent (read-only tools)                        │   │
│  │ 3. Run ExplorerAgent → exploration WorkLedger                         │   │
│  │ 4. Parse system context:                                              │   │
│  │    - Package managers (npm, pip, cargo, etc.)                         │   │
│  │    - Frameworks (React, FastAPI, etc.)                                │   │
│  │    - Languages (TypeScript, Python, etc.)                             │   │
│  │    - OS environment                                                    │   │
│  │    - Relevant artifacts/files                                         │   │
│  │    - Codebase patterns                                                 │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ PHASE 2: SCRIPT GENERATION                                            │   │
│  │                                                                        │   │
│  │ 1. Instantiate RuntimeScriptAgent                                     │   │
│  │ 2. Pass goal + systemContext                                          │   │
│  │ 3. Receive RuntimeScript (declarative WorkItem DAG)                   │   │
│  │ 4. Emit 'runtime_script_created' event                                │   │
│  │ 5. Initialize WorkItemState map                                       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ PHASE 3: EXECUTION LOOP                                               │   │
│  │                                                                        │   │
│  │ while (readyQueue.length > 0 || inFlight.size > 0) {                  │   │
│  │   1. Promote WorkItems whose dependencies are satisfied               │   │
│  │   2. Dispatch ready WorkItems to appropriate agents (parallel)        │   │
│  │      - Instantiate agent based on workItem.agent type                 │   │
│  │      - Pass context (by value), workItem, emit callback               │   │
│  │      - Emit 'workitem_started' event                                  │   │
│  │   3. await Promise.race(inFlight)                                     │   │
│  │   4. Process completed agent result:                                  │   │
│  │      - Merge context changes                                          │   │
│  │      - Update WorkItemState                                           │   │
│  │      - Record in WorkLedger                                           │   │
│  │      - Emit 'workitem_completed' or 'workitem_failed'                 │   │
│  │   5. Check for user input request → pause if needed                   │   │
│  │   6. Check stagnation → skip if needed                                │   │
│  │ }                                                                      │   │
│  │                                                                        │   │
│  │ Return last completed WorkItem's response                             │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  Emit 'goal_achieved' or 'goal_not_achieved'                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Agent Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                  AGENT                                       │
│                                                                              │
│  run(params: { context: ContextWindow, workItem: WorkItem })                │
│                                                                              │
│  1. Initialize AgentResult                                                  │
│  2. Build system message from config.systemPrompt + workItem.objective      │
│  3. Enter execution loop:                                                   │
│     while (iteration < budget.maxIterations) {                              │
│       a. Check bounds (tool calls, duration)                                │
│       b. Build messages from context                                        │
│       c. Call LLM via adapter                                               │
│       d. Emit 'llm_call' event                                              │
│       e. Process tool calls if any:                                         │
│          - Emit 'tool_call' event (starting)                                │
│          - Execute via ToolRegistry                                         │
│          - Emit 'tool_call' event (completed)                               │
│          - Update context with results                                      │
│       f. Check for action markers ([FINAL], [NEED_CONTEXT], [CONTINUE])     │
│       g. Handle user input request if detected                              │
│     }                                                                        │
│  4. Return AgentResult                                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Cleanup & Deletions

### 4.1 Files to DELETE

| File | Reason |
|------|--------|
| `src/agent-ts/wizard/worker.ts` | Functionality absorbed into new Agent |
| `src/agent-ts/wizard/plan-state.ts` | Replaced by WorkItemState in Orchestrator |
| `src/agent-ts/planner/planner.ts` | Becomes RuntimeScriptAgent (inline) |
| `src/agent-ts/planner/index.ts` | Delete entire planner/ folder |
| `src/agent-ts/types/plans.ts` | WizardPlan/WizardStep replaced by RuntimeScript/WorkItem |

### 4.2 Files to SIGNIFICANTLY MODIFY

| File | Changes |
|------|---------|
| `src/agent-ts/agent/agent.ts` | Complete rewrite: becomes Worker-derived pure agent |
| `src/agent-ts/wizard/wizard.ts` | Rename to `orchestrator/orchestrator.ts`, major rewrite |
| `src/agent-ts/wizard/work-item.ts` | Add new fields (delta, agent, dependencies as IDs) |
| `src/agent-ts/communication/event_bus.ts` | Add `subscribeRun()`, microtask publishing |
| `src/agent-ts/types/events.ts` | Add orchestrator events, ensure requestId on all |
| `src/agent-ts/harness/harness.ts` | Add RoutingAgent, update Orchestrator integration |
| `src/agent-ts/wizard/index.ts` | Update exports (no Worker, no PlanState) |

### 4.3 Files to CREATE

| File | Purpose |
|------|---------|
| `src/agent-ts/orchestrator/orchestrator.ts` | New Orchestrator class |
| `src/agent-ts/orchestrator/workitem-state.ts` | WorkItem state tracking during execution |
| `src/agent-ts/orchestrator/runtime-script.ts` | RuntimeScript type and parsing |
| `src/agent-ts/orchestrator/index.ts` | Re-exports |
| `src/agent-ts/agent/types.ts` | Agent types (AgentConfig, AgentResult, etc.) |
| `src/agent-ts/agent/prompts.ts` | System prompts for all agent types |
| `src/agent-ts/agent/agent-configs.ts` | Pre-defined agent configurations |

### 4.4 Files to KEEP AS-IS

| File | Reason |
|------|--------|
| `src/agent-ts/wizard/work-ledger.ts` | Still useful for audit trail |
| `src/agent-ts/wizard/knowledge.ts` | Still useful for fact accumulation |
| `src/agent-ts/wizard/stagnation.ts` | Still useful for detecting stuck execution |
| `src/agent-ts/wizard/context.ts` | `buildSystemMessage()` reused in Agent |

### 4.5 References to Update

All imports of deleted/renamed modules must be updated:

```typescript
// OLD
import { Planner } from '../planner/index.js';
import { Wizard } from '../wizard/index.js';
import { Worker } from '../wizard/worker.js';
import { PlanState } from '../wizard/plan-state.js';
import { WizardPlan, WizardStep, StepStatus, StepPhase } from '../types/plans.js';

// NEW
import { Orchestrator } from '../orchestrator/index.js';
import { Agent } from '../agent/index.js';
import { WorkItemState, WorkItemStatus } from '../orchestrator/workitem-state.js';
import { RuntimeScript, RuntimeWorkItem } from '../orchestrator/runtime-script.js';
```

---

## 5. New Type Definitions

### 5.1 Agent Types (`src/agent-ts/agent/types.ts`)

```typescript
/**
 * Agent type identifiers.
 * Each type has a pre-defined configuration.
 */
export type AgentType =
  | 'routing'           // Classifies request complexity (nano model)
  | 'explorer'          // Read-only codebase exploration
  | 'runtime_script'    // Generates executable WorkItem DAGs
  | 'standard'          // General purpose execution (70% of calls)
  | 'linter'            // Code quality checks
  | 'tester'            // Test execution
  | 'context_compactor' // Context window compression
  | 'debugger'          // Diagnosis and debugging
  | 'web_crawler';      // Web research

/**
 * Budget constraints for agent execution.
 */
export interface AgentBudget {
  /** Maximum LLM calls per run */
  maxIterations: number;
  /** Maximum tool calls per run */
  maxToolCalls: number;
  /** Maximum duration in milliseconds */
  maxDurationMs: number;
}

export const DEFAULT_AGENT_BUDGET: AgentBudget = {
  maxIterations: 10,
  maxToolCalls: 15,
  maxDurationMs: 120_000,
};

/**
 * Agent configuration - wired at instantiation.
 * Determines the agent's capabilities and constraints.
 */
export interface AgentConfig {
  /** Agent type identifier */
  type: AgentType;
  /** LLM model to use */
  model: string;
  /** System prompt defining agent behavior */
  systemPrompt: string;
  /** Tools this agent can access (discretionary) */
  tools: string[];
  /** Resource budget */
  budget: AgentBudget;
  /** Whether to allow implicit finals (no [FINAL] marker) */
  allowImplicitFinals?: boolean;
}

/**
 * Parameters for Agent.run().
 * Minimal interface - all config is at construction.
 */
export interface AgentRunParams {
  /** Context window - passed by value, agent mutates locally */
  context: ContextWindow;
  /** Work item defining the objective */
  workItem: WorkItem;
}

/**
 * Metrics from agent execution.
 */
export interface AgentMetrics {
  /** Number of LLM calls made */
  llmCallsMade: number;
  /** Number of tool calls made */
  toolCallsMade: number;
  /** Number of successful tool calls */
  toolCallsSucceeded: number;
  /** Number of failed tool calls */
  toolCallsFailed: number;
  /** Total duration in milliseconds */
  durationMs: number;
}

/**
 * Result from Agent.run().
 * Contains all outputs; no side effects beyond context mutation.
 */
export interface AgentResult {
  /** Whether the objective was achieved */
  success: boolean;
  /** Response content (if successful) */
  response: string;
  /** Error message (if failed) */
  error?: string;
  /** Execution metrics */
  metrics: AgentMetrics;
  /** Files read during execution */
  filesRead: string[];
  /** Paths invalidated by Write/Edit operations */
  invalidatedPaths: string[];
  /** Tool errors encountered */
  toolErrors: string[];
  /** Why execution terminated */
  terminationReason: string;
  /** Whether user input is needed */
  needsUserInput: boolean;
  /** User prompt info (if needsUserInput) */
  userPrompt?: UserPromptInfo;
  /** Whether LLM refused to complete */
  isRefusal: boolean;
}

/**
 * User prompt information for interactive requests.
 */
export interface UserPromptInfo {
  question: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multiSelect?: boolean;
}

/**
 * Event emit callback type.
 * Agents receive this, never the EventBus directly.
 */
export type EventEmitCallback = (event: AgentEvent) => void;

/**
 * Noop emit callback for testing or when events aren't needed.
 */
export const noopEmit: EventEmitCallback = () => {};
```

### 5.2 WorkItem Types (`src/agent-ts/wizard/work-item.ts` - UPDATED)

```typescript
/**
 * Resource bounds for a work unit.
 */
export interface WorkBounds {
  /** Max tool calls (default: 15) */
  maxToolCalls: number;
  /** Max duration in ms (default: 120000) */
  maxDurationMs: number;
  /** Max LLM calls (default: 8) */
  maxLlmCalls: number;
}

export const DEFAULT_WORK_BOUNDS: WorkBounds = {
  maxToolCalls: 15,
  maxDurationMs: 120_000,
  maxLlmCalls: 8,
};

/**
 * Bounded work unit dispatched to Agent.
 * WorkItems are the fundamental unit of work in the system.
 */
export interface WorkItem {
  /** Unique work item ID */
  readonly workId: string;
  /** High-level goal this work contributes to */
  readonly goal: string;
  /** What this work accomplishes (definition of done) */
  readonly objective: string;
  /** Semantic description of how this advances toward the goal */
  readonly delta?: string;
  /** WorkItem IDs this depends on (must complete first) */
  readonly dependencies: readonly string[];
  /** Agent type to use for execution */
  readonly agent: AgentType;
  /** Resource bounds */
  readonly bounds: WorkBounds;
  /** Suggested tool to use */
  readonly toolHint?: string;
  /** Target file paths to operate on */
  readonly targetPaths?: readonly string[];
  /** Additional parameters for the agent */
  readonly params?: Record<string, unknown>;
}

/**
 * Create a work item with defaults.
 */
export function createWorkItem(params: {
  goal: string;
  objective: string;
  delta?: string;
  dependencies?: string[];
  agent?: AgentType;
  bounds?: Partial<WorkBounds>;
  toolHint?: string;
  targetPaths?: string[];
  params?: Record<string, unknown>;
}): WorkItem {
  return {
    workId: generateWorkId(),
    goal: params.goal,
    objective: params.objective,
    delta: params.delta,
    dependencies: Object.freeze(params.dependencies ?? []),
    agent: params.agent ?? 'standard',
    bounds: { ...DEFAULT_WORK_BOUNDS, ...params.bounds },
    toolHint: params.toolHint,
    targetPaths: params.targetPaths ? Object.freeze(params.targetPaths) : undefined,
    params: params.params,
  };
}

function generateWorkId(): string {
  return `work_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
```

### 5.3 RuntimeScript Types (`src/agent-ts/orchestrator/runtime-script.ts`)

```typescript
import type { WorkItem } from '../wizard/work-item.js';
import type { AgentType } from '../agent/types.js';

/**
 * Declarative execution script generated by RuntimeScriptAgent.
 * Represents a DAG of WorkItems to execute.
 */
export interface RuntimeScript {
  /** The goal this script accomplishes */
  goal: string;
  /** Ordered list of work items (topologically sorted) */
  workItems: WorkItem[];
  /** System context gathered during exploration */
  systemContext: SystemContext;
  /** Timestamp of script creation */
  createdAt: number;
}

/**
 * System context gathered by ExplorerAgent.
 */
export interface SystemContext {
  /** Detected package managers (npm, pip, cargo, etc.) */
  packageManagers: string[];
  /** Detected frameworks (React, FastAPI, Express, etc.) */
  frameworks: string[];
  /** Detected languages (TypeScript, Python, Rust, etc.) */
  languages: string[];
  /** Operating system */
  os: string;
  /** Relevant artifacts/files discovered */
  artifacts: Artifact[];
  /** Codebase patterns/conventions */
  patterns: string[];
}

/**
 * An artifact discovered during exploration.
 */
export interface Artifact {
  /** File path */
  path: string;
  /** Type of artifact */
  type: 'config' | 'source' | 'test' | 'doc' | 'other';
  /** Brief description */
  description?: string;
  /** Relevance to the goal (0-1) */
  relevance?: number;
}

/**
 * Raw output format from RuntimeScriptAgent.
 * Parsed into RuntimeScript.
 */
export interface RuntimeScriptOutput {
  goal: string;
  workItems: Array<{
    id: string;
    objective: string;
    delta: string;
    agent: AgentType;
    dependencies: string[];
    toolHint?: string;
    targetPaths?: string[];
    params?: Record<string, unknown>;
  }>;
}

/**
 * Parse RuntimeScriptAgent output into RuntimeScript.
 */
export function parseRuntimeScript(
  output: RuntimeScriptOutput,
  systemContext: SystemContext
): RuntimeScript {
  const workItems: WorkItem[] = output.workItems.map((item) => ({
    workId: item.id,
    goal: output.goal,
    objective: item.objective,
    delta: item.delta,
    dependencies: Object.freeze(item.dependencies),
    agent: item.agent,
    bounds: DEFAULT_WORK_BOUNDS,
    toolHint: item.toolHint,
    targetPaths: item.targetPaths ? Object.freeze(item.targetPaths) : undefined,
    params: item.params,
  }));

  return {
    goal: output.goal,
    workItems,
    systemContext,
    createdAt: Date.now(),
  };
}
```

### 5.4 WorkItemState Types (`src/agent-ts/orchestrator/workitem-state.ts`)

```typescript
import type { WorkItem } from '../wizard/work-item.js';
import type { AgentResult } from '../agent/types.js';

/**
 * WorkItem execution status.
 */
export type WorkItemStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'awaiting_user';

/**
 * Mutable state for a WorkItem during execution.
 */
export interface WorkItemState {
  /** The immutable WorkItem definition */
  workItem: WorkItem;
  /** Current status */
  status: WorkItemStatus;
  /** Agent ID executing this item (if in_progress) */
  agentId?: string;
  /** Attempt count (for retries) */
  attemptCount: number;
  /** Result from last execution (if completed/failed) */
  result?: AgentResult;
  /** Error message (if failed) */
  error?: string;
  /** Timestamp when started */
  startedAt?: number;
  /** Timestamp when completed */
  completedAt?: number;
}

/**
 * Create initial WorkItemState from WorkItem.
 */
export function createWorkItemState(workItem: WorkItem): WorkItemState {
  return {
    workItem,
    status: 'pending',
    attemptCount: 0,
  };
}

/**
 * Manager for WorkItem states during orchestration.
 * Single-writer pattern: only Orchestrator mutates.
 */
export class WorkItemStateManager {
  private states = new Map<string, WorkItemState>();

  /**
   * Initialize from RuntimeScript.
   */
  initFromScript(workItems: WorkItem[]): void {
    this.states.clear();
    for (const item of workItems) {
      this.states.set(item.workId, createWorkItemState(item));
    }
  }

  /**
   * Get state by workId.
   */
  get(workId: string): WorkItemState | undefined {
    return this.states.get(workId);
  }

  /**
   * Get all states.
   */
  getAll(): WorkItemState[] {
    return Array.from(this.states.values());
  }

  /**
   * Get WorkItems ready for execution (pending with satisfied dependencies).
   */
  getReady(): WorkItemState[] {
    return this.getAll().filter((state) => {
      if (state.status !== 'pending') return false;
      return state.workItem.dependencies.every((depId) => {
        const depState = this.states.get(depId);
        return depState && (depState.status === 'completed' || depState.status === 'skipped');
      });
    });
  }

  /**
   * Get in-progress WorkItems.
   */
  getInProgress(): WorkItemState[] {
    return this.getAll().filter((s) => s.status === 'in_progress');
  }

  /**
   * Mark WorkItem as in_progress.
   */
  markInProgress(workId: string, agentId: string): void {
    const state = this.states.get(workId);
    if (!state) throw new Error(`Unknown workId: ${workId}`);
    state.status = 'in_progress';
    state.agentId = agentId;
    state.attemptCount++;
    state.startedAt = Date.now();
  }

  /**
   * Mark WorkItem as completed.
   */
  markCompleted(workId: string, result: AgentResult): void {
    const state = this.states.get(workId);
    if (!state) throw new Error(`Unknown workId: ${workId}`);
    state.status = 'completed';
    state.result = result;
    state.completedAt = Date.now();
  }

  /**
   * Mark WorkItem as failed.
   */
  markFailed(workId: string, error: string, result?: AgentResult): void {
    const state = this.states.get(workId);
    if (!state) throw new Error(`Unknown workId: ${workId}`);
    state.status = 'failed';
    state.error = error;
    state.result = result;
    state.completedAt = Date.now();
  }

  /**
   * Mark WorkItem as skipped.
   */
  markSkipped(workId: string, reason: string): void {
    const state = this.states.get(workId);
    if (!state) throw new Error(`Unknown workId: ${workId}`);
    state.status = 'skipped';
    state.error = reason;
    state.completedAt = Date.now();
  }

  /**
   * Mark WorkItem as awaiting user input.
   */
  markAwaitingUser(workId: string): void {
    const state = this.states.get(workId);
    if (!state) throw new Error(`Unknown workId: ${workId}`);
    state.status = 'awaiting_user';
  }

  /**
   * Reset WorkItem for retry.
   */
  resetForRetry(workId: string): void {
    const state = this.states.get(workId);
    if (!state) throw new Error(`Unknown workId: ${workId}`);
    state.status = 'pending';
    state.agentId = undefined;
    state.result = undefined;
    state.error = undefined;
    state.startedAt = undefined;
    state.completedAt = undefined;
  }

  /**
   * Check if all WorkItems are done (completed, failed, or skipped).
   */
  isAllDone(): boolean {
    return this.getAll().every((s) =>
      s.status === 'completed' || s.status === 'failed' || s.status === 'skipped'
    );
  }

  /**
   * Get counts by status.
   */
  getCounts(): Record<WorkItemStatus, number> {
    const counts: Record<WorkItemStatus, number> = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      awaiting_user: 0,
    };
    for (const state of this.states.values()) {
      counts[state.status]++;
    }
    return counts;
  }
}
```

### 5.5 Event Types (`src/agent-ts/types/events.ts` - ADDITIONS)

```typescript
// Add to existing WizardEventType union
export type OrchestratorEventType =
  | 'runtime_script_created'   // DAG created
  | 'workitem_started'         // Agent dispatched for WorkItem
  | 'workitem_completed'       // WorkItem succeeded
  | 'workitem_failed'          // WorkItem failed
  | 'workitem_skipped'         // WorkItem skipped
  | 'goal_achieved'            // Overall goal succeeded
  | 'goal_not_achieved';       // Overall goal failed

// Update AgentType to include new types
export type AgentType =
  | 'routing'
  | 'explorer'
  | 'runtime_script'
  | 'standard'
  | 'linter'
  | 'tester'
  | 'context_compactor'
  | 'debugger'
  | 'web_crawler'
  | 'orchestrator';  // For orchestrator-level events

/**
 * Base event with required requestId.
 */
export interface AgentEvent<T = Record<string, unknown>> {
  type: WizardEventType | OrchestratorEventType;
  /** REQUIRED: Correlates all events for a single request */
  requestId: string;
  /** Unix timestamp in seconds */
  timestamp: number;
  /** WorkItem ID if event is workitem-related */
  workItemId?: string;
  /** Legacy: step number (for compatibility) */
  stepNum?: number;
  /** Event-specific payload */
  data: T;
}

/**
 * Data for runtime_script_created event.
 */
export interface RuntimeScriptCreatedData {
  goal: string;
  workItemCount: number;
  workItems: Array<{
    workId: string;
    objective: string;
    delta?: string;
    agent: AgentType;
    dependencies: string[];
  }>;
  systemContext: {
    packageManagers: string[];
    frameworks: string[];
    languages: string[];
  };
}

/**
 * Data for workitem_started event.
 */
export interface WorkItemStartedData {
  workId: string;
  objective: string;
  delta?: string;
  agent: AgentType;
  dependencies: string[];
}

/**
 * Data for workitem_completed event.
 */
export interface WorkItemCompletedData {
  workId: string;
  objective: string;
  response: string;
  metrics: {
    llmCallsMade: number;
    toolCallsMade: number;
    durationMs: number;
  };
}

/**
 * Data for workitem_failed event.
 */
export interface WorkItemFailedData {
  workId: string;
  objective: string;
  error: string;
  toolErrors?: string[];
  terminationReason: string;
}
```

---

## 6. Agent Primitive

### 6.1 Agent Class (`src/agent-ts/agent/agent.ts`)

```typescript
/**
 * Agent - Pure execution primitive.
 *
 * Receives ContextWindow by value and mutates it locally during execution.
 * Returns AgentResult with all outputs.
 *
 * Replaces the old Worker class with a cleaner interface.
 */

import type { LLMAdapter, Message } from '../llm/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ContextWindow, ContextItem } from '../types/context.js';
import type { WorkItem } from '../wizard/work-item.js';
import type {
  AgentConfig,
  AgentRunParams,
  AgentResult,
  AgentMetrics,
  EventEmitCallback,
  noopEmit,
} from './types.js';
import { createEvent } from '../types/events.js';
import { buildSystemMessage } from '../wizard/context.js';

/**
 * Action markers in LLM response.
 */
enum AgentAction {
  TOOL = 'tool',
  FINAL = 'final',
  NEED_CONTEXT = 'need_context',
  CONTINUE = 'continue',
}

const ACTION_MARKERS = {
  FINAL: /\[FINAL\]/i,
  NEED_CONTEXT: /\[NEED_CONTEXT\]/i,
  CONTINUE: /\[CONTINUE\]/i,
};

const REFUSAL_PATTERNS = [
  /cannot be completed/i,
  /can't be completed/i,
  /cannot complete/i,
  /unable to complete/i,
  /exceeds? (?:the )?(?:budget|limit)/i,
  /not (?:possible|achievable|feasible)/i,
];

/**
 * Pure execution agent.
 */
export class Agent {
  private config: AgentConfig;
  private llm: LLMAdapter;
  private toolRegistry: ToolRegistry;
  private emit: EventEmitCallback;
  private requestId: string;

  constructor(
    config: AgentConfig,
    llm: LLMAdapter,
    toolRegistry: ToolRegistry,
    emit: EventEmitCallback = noopEmit,
    requestId: string = ''
  ) {
    this.config = config;
    this.llm = llm;
    this.toolRegistry = toolRegistry;
    this.emit = emit;
    this.requestId = requestId;
  }

  /**
   * Execute the agent on a work item.
   * Context is passed by value and mutated locally.
   */
  async run(params: AgentRunParams): Promise<AgentResult> {
    const { context, workItem } = params;
    const startTime = Date.now();

    const metrics: AgentMetrics = {
      llmCallsMade: 0,
      toolCallsMade: 0,
      toolCallsSucceeded: 0,
      toolCallsFailed: 0,
      durationMs: 0,
    };

    const result: AgentResult = {
      success: false,
      response: '',
      metrics,
      filesRead: [],
      invalidatedPaths: [],
      toolErrors: [],
      terminationReason: '',
      needsUserInput: false,
      isRefusal: false,
    };

    try {
      await this.executeLoop(context, workItem, result, metrics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.error = message;
      result.terminationReason = `exception:${message}`;
      this.emitLlmError(error instanceof Error ? error : new Error(message));
    }

    metrics.durationMs = Date.now() - startTime;
    return result;
  }

  /**
   * Main execution loop.
   */
  private async executeLoop(
    context: ContextWindow,
    workItem: WorkItem,
    result: AgentResult,
    metrics: AgentMetrics
  ): Promise<void> {
    const maxIterations = Math.min(
      this.config.budget.maxIterations,
      workItem.bounds.maxLlmCalls
    );

    // Track files read within this agent's execution
    const localReadFiles = new Set(context.getReadFilesArray());

    // Auto-read target files
    if (workItem.targetPaths && workItem.targetPaths.length > 0) {
      await this.autoReadTargetFiles(workItem.targetPaths, context, localReadFiles, metrics);
    }

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // Check bounds
      if (metrics.toolCallsMade >= workItem.bounds.maxToolCalls) {
        result.terminationReason = 'bounds:tool_calls';
        result.error = 'Tool call limit reached';
        break;
      }

      if (metrics.durationMs >= workItem.bounds.maxDurationMs) {
        result.terminationReason = 'bounds:duration';
        result.error = 'Duration limit reached';
        break;
      }

      // Build system message
      const systemMessage = buildSystemMessage(
        workItem.goal,
        workItem.objective,
        undefined, // stepNum not used
        '', // behavioralRules
        this.toolRegistry.getWorkingDir()
      );

      // Get tool definitions (filtered by config.tools)
      const allTools = this.toolRegistry.getDefinitions();
      const allowedTools = this.config.tools.length > 0
        ? allTools.filter((t) => this.config.tools.includes(t.name))
        : allTools;

      // Build messages from context
      const messages = this.buildMessages(systemMessage, workItem, context);

      // Call LLM
      const llmStartTime = Date.now();
      const response = await this.llm.respond({
        messages: messages as Message[],
        tools: allowedTools.length > 0 ? allowedTools : undefined,
      });
      const llmDurationMs = Date.now() - llmStartTime;
      metrics.llmCallsMade++;

      // Emit llm_call event
      this.emitLlmCall(response, messages, llmDurationMs, allowedTools);

      const content = response.content ?? '';
      const toolCalls = response.toolCalls ?? [];

      // Add assistant message to context
      this.addAssistantMessage(context, content, toolCalls);

      // Check for action markers
      const action = this.extractAction(content);

      // Handle tool calls
      if (toolCalls.length > 0) {
        await this.processToolCalls(
          toolCalls,
          context,
          localReadFiles,
          result,
          metrics
        );

        // Check for user input request
        if (result.needsUserInput) {
          result.filesRead = Array.from(localReadFiles);
          return;
        }

        // If [FINAL] in content, terminate after tools
        if (action === AgentAction.FINAL) {
          this.handleFinalAction(content, result);
          result.filesRead = Array.from(localReadFiles);
          return;
        }

        continue;
      }

      // No tool calls - check action markers
      if (action === AgentAction.FINAL) {
        this.handleFinalAction(content, result);
        result.filesRead = Array.from(localReadFiles);
        return;
      }

      if (action === AgentAction.NEED_CONTEXT) {
        const prompt = this.extractUserPrompt(content);
        if (prompt) {
          result.needsUserInput = true;
          result.userPrompt = prompt;
          result.terminationReason = 'user_input_required';
          result.filesRead = Array.from(localReadFiles);
          return;
        }
        continue;
      }

      if (action === AgentAction.CONTINUE) {
        continue;
      }

      // No action, no tools - check for implicit final
      if (this.config.allowImplicitFinals && content.length > 100) {
        result.success = true;
        result.response = content;
        result.terminationReason = 'implicit_final';
        result.filesRead = Array.from(localReadFiles);
        return;
      }

      // Stuck
      result.terminationReason = 'no_action';
      result.error = 'LLM response has no tools and no action markers';
      break;
    }

    if (!result.terminationReason) {
      result.terminationReason = 'iterations_exhausted';
      result.error = 'Maximum iterations reached';
    }

    result.filesRead = Array.from(localReadFiles);
  }

  /**
   * Build messages array for LLM call.
   */
  private buildMessages(
    systemMessage: string,
    workItem: WorkItem,
    context: ContextWindow
  ): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: systemMessage },
    ];

    // Get context items
    const contextItems = context.getItemsForLLM();

    // Check if there's user input
    const hasUserInput = contextItems.some(
      (item) => item.type === 'message' && (item as any).role === 'user'
    );

    // If no user input, add objective as user message
    if (!hasUserInput) {
      messages.push({
        role: 'user',
        content: `Execute the following objective:\n\n${workItem.objective}`,
      });
    }

    // Add context items
    for (const item of contextItems) {
      if (item.type === 'message') {
        messages.push({
          role: (item as any).role,
          content: (item as any).content,
        });
      } else if (item.type === 'function_call') {
        messages.push(item);
      } else if (item.type === 'function_call_output') {
        messages.push(item);
      }
    }

    return messages;
  }

  /**
   * Add assistant message to context.
   */
  private addAssistantMessage(
    context: ContextWindow,
    content: string,
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  ): void {
    if (toolCalls.length > 0) {
      if (content) {
        context.addMessage('assistant', content);
      }
      for (const tc of toolCalls) {
        context.appendItem({
          type: 'function_call',
          callId: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          timestamp: Date.now(),
        });
      }
    } else {
      context.addMessage('assistant', content);
    }
  }

  /**
   * Process tool calls.
   */
  private async processToolCalls(
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    context: ContextWindow,
    localReadFiles: Set<string>,
    result: AgentResult,
    metrics: AgentMetrics
  ): Promise<void> {
    for (const call of toolCalls) {
      // Check if tool is allowed
      if (this.config.tools.length > 0 && !this.config.tools.includes(call.name)) {
        const errorMsg = `Tool "${call.name}" is not allowed for this agent`;
        result.toolErrors.push(errorMsg);
        context.appendItem({
          type: 'function_call_output',
          callId: call.id,
          output: errorMsg,
          isError: true,
          timestamp: Date.now(),
        });
        continue;
      }

      // Emit tool_call starting
      this.emit(createEvent('tool_call', {
        toolName: call.name,
        arguments: call.arguments,
        phase: 'starting',
      }));

      const toolStartTime = Date.now();

      try {
        const toolResult = await this.toolRegistry.execute(call.name, call.arguments);
        const toolDurationMs = Date.now() - toolStartTime;

        metrics.toolCallsMade++;

        if (toolResult.isSuccess) {
          metrics.toolCallsSucceeded++;

          // Track file reads
          if (call.name.toLowerCase() === 'read' && call.arguments.path) {
            localReadFiles.add(String(call.arguments.path));
          }

          // Track invalidated paths
          if (
            (call.name.toLowerCase() === 'write' || call.name.toLowerCase() === 'edit') &&
            call.arguments.path
          ) {
            result.invalidatedPaths.push(String(call.arguments.path));
            localReadFiles.delete(String(call.arguments.path));
          }
        } else {
          metrics.toolCallsFailed++;
          if (toolResult.error) {
            result.toolErrors.push(`${call.name}: ${toolResult.error}`);
          }
        }

        // Emit tool_call completed
        this.emit(createEvent('tool_call', {
          toolName: call.name,
          arguments: call.arguments,
          phase: 'completed',
          result: toolResult.output?.slice(0, 10000),
          success: toolResult.isSuccess,
          durationMs: toolDurationMs,
        }));

        // Add result to context
        context.appendItem({
          type: 'function_call_output',
          callId: call.id,
          output: toolResult.output ?? '',
          isError: !toolResult.isSuccess,
          durationMs: toolDurationMs,
          timestamp: Date.now(),
        });

        // Check for user input request (ask_user tool)
        if (call.name === 'ask_user' && toolResult.isSuccess) {
          try {
            const parsed = JSON.parse(toolResult.output ?? '{}');
            result.needsUserInput = true;
            result.userPrompt = parsed;
            result.terminationReason = 'user_input_required';
            return;
          } catch {
            // Not a user prompt
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        metrics.toolCallsMade++;
        metrics.toolCallsFailed++;
        result.toolErrors.push(`${call.name}: ${message}`);

        this.emit(createEvent('tool_call', {
          toolName: call.name,
          arguments: call.arguments,
          phase: 'completed',
          result: `Error: ${message}`,
          success: false,
          durationMs: Date.now() - toolStartTime,
        }));

        context.appendItem({
          type: 'function_call_output',
          callId: call.id,
          output: `Error: ${message}`,
          isError: true,
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * Auto-read target files before execution.
   */
  private async autoReadTargetFiles(
    targetPaths: readonly string[],
    context: ContextWindow,
    localReadFiles: Set<string>,
    metrics: AgentMetrics
  ): Promise<void> {
    for (const targetPath of targetPaths) {
      if (localReadFiles.has(targetPath)) continue;

      try {
        const result = await this.toolRegistry.execute('read', { path: targetPath });
        if (result.isSuccess) {
          localReadFiles.add(targetPath);
          metrics.toolCallsMade++;
          metrics.toolCallsSucceeded++;

          const fileContent = typeof result.output === 'string'
            ? result.output
            : JSON.stringify(result.output);

          context.addFileContent(targetPath, fileContent.slice(0, 10000));
        } else {
          metrics.toolCallsFailed++;
        }
      } catch {
        metrics.toolCallsFailed++;
      }
    }
  }

  /**
   * Extract action from content.
   */
  private extractAction(content: string): AgentAction | null {
    if (ACTION_MARKERS.FINAL.test(content)) return AgentAction.FINAL;
    if (ACTION_MARKERS.NEED_CONTEXT.test(content)) return AgentAction.NEED_CONTEXT;
    if (ACTION_MARKERS.CONTINUE.test(content)) return AgentAction.CONTINUE;
    return null;
  }

  /**
   * Handle [FINAL] action.
   */
  private handleFinalAction(content: string, result: AgentResult): void {
    if (REFUSAL_PATTERNS.some((p) => p.test(content))) {
      result.isRefusal = true;
      result.error = 'LLM refused to complete the task';
      result.terminationReason = 'refusal';
    } else {
      result.success = true;
      result.response = content.replace(/\[FINAL\]/gi, '').trim();
      result.terminationReason = 'final';
    }
  }

  /**
   * Extract user prompt from NEED_CONTEXT content.
   */
  private extractUserPrompt(content: string): AgentResult['userPrompt'] | null {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Emit llm_call event.
   */
  private emitLlmCall(
    response: any,
    messages: Array<Record<string, unknown>>,
    durationMs: number,
    tools: any[]
  ): void {
    const content = response.content ?? '';
    const toolCalls = response.toolCalls ?? [];

    this.emit(createEvent('llm_call', {
      agentType: this.config.type,
      promptPreview: this.getPromptPreview(messages),
      responsePreview: content.slice(0, 4000) || this.buildToolCallPreview(toolCalls),
      totalTokens: response.usage?.totalTokens ?? 0,
      promptTokens: response.usage?.promptTokens ?? 0,
      completionTokens: response.usage?.completionTokens ?? 0,
      durationMs,
      model: response.model ?? 'unknown',
      toolCallsCount: toolCalls.length,
      toolNames: tools.map((t) => t.name),
      messageCount: messages.length,
    }));
  }

  /**
   * Emit llm_error event.
   */
  private emitLlmError(error: Error): void {
    this.emit(createEvent('llm_error', {
      agentType: this.config.type,
      provider: this.llm.provider,
      model: this.llm.model,
      error: error.message,
      errorType: this.classifyError(error),
    }));
  }

  /**
   * Get preview from messages.
   */
  private getPromptPreview(messages: Array<Record<string, unknown>>): string {
    if (!messages.length) return '';
    const first = messages[0];
    if (first.role === 'system' && typeof first.content === 'string') {
      return first.content.slice(0, 4000);
    }
    return '';
  }

  /**
   * Build preview from tool calls.
   */
  private buildToolCallPreview(
    toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>
  ): string {
    if (!toolCalls.length) return '';
    return `[Tools: ${toolCalls.map((tc) => tc.name).join(', ')}]`;
  }

  /**
   * Classify error type.
   */
  private classifyError(error: Error): string {
    const msg = error.message;
    if (msg.includes('rate limit') || msg.includes('429')) return 'rate_limit';
    if (msg.includes('timeout')) return 'timeout';
    if (msg.includes('circuit')) return 'circuit_open';
    return 'unknown';
  }
}
```

### 6.2 Agent Configurations (`src/agent-ts/agent/agent-configs.ts`)

```typescript
/**
 * Pre-defined agent configurations.
 * Each agent type has specific tools, budget, and system prompt.
 */

import type { AgentConfig, AgentType, AgentBudget } from './types.js';
import {
  ROUTING_PROMPT,
  EXPLORER_PROMPT,
  RUNTIME_SCRIPT_PROMPT,
  STANDARD_PROMPT,
} from './prompts.js';

/**
 * Read-only tools for exploration.
 */
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];

/**
 * All standard tools.
 */
const ALL_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'];

/**
 * Budget for routing (minimal).
 */
const ROUTING_BUDGET: AgentBudget = {
  maxIterations: 1,
  maxToolCalls: 0,
  maxDurationMs: 5_000,
};

/**
 * Budget for exploration.
 */
const EXPLORER_BUDGET: AgentBudget = {
  maxIterations: 5,
  maxToolCalls: 20,
  maxDurationMs: 60_000,
};

/**
 * Budget for script generation.
 */
const SCRIPT_BUDGET: AgentBudget = {
  maxIterations: 2,
  maxToolCalls: 0,
  maxDurationMs: 30_000,
};

/**
 * Budget for standard execution.
 */
const STANDARD_BUDGET: AgentBudget = {
  maxIterations: 10,
  maxToolCalls: 15,
  maxDurationMs: 120_000,
};

/**
 * Agent configuration registry.
 */
export const AGENT_CONFIGS: Record<AgentType, AgentConfig> = {
  routing: {
    type: 'routing',
    model: 'gpt-5-nano', // Fast, cheap for classification
    systemPrompt: ROUTING_PROMPT,
    tools: [], // No tools
    budget: ROUTING_BUDGET,
    allowImplicitFinals: true,
  },

  explorer: {
    type: 'explorer',
    model: 'claude-haiku', // Fast for exploration
    systemPrompt: EXPLORER_PROMPT,
    tools: READ_ONLY_TOOLS,
    budget: EXPLORER_BUDGET,
    allowImplicitFinals: false,
  },

  runtime_script: {
    type: 'runtime_script',
    model: 'claude-sonnet', // Needs reasoning for planning
    systemPrompt: RUNTIME_SCRIPT_PROMPT,
    tools: [], // No tools, just generates JSON
    budget: SCRIPT_BUDGET,
    allowImplicitFinals: true,
  },

  standard: {
    type: 'standard',
    model: 'claude-sonnet',
    systemPrompt: STANDARD_PROMPT,
    tools: ALL_TOOLS,
    budget: STANDARD_BUDGET,
    allowImplicitFinals: false,
  },

  linter: {
    type: 'linter',
    model: 'claude-haiku',
    systemPrompt: '', // TODO: Define
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    budget: STANDARD_BUDGET,
    allowImplicitFinals: false,
  },

  tester: {
    type: 'tester',
    model: 'claude-sonnet',
    systemPrompt: '', // TODO: Define
    tools: ['Read', 'Bash'],
    budget: STANDARD_BUDGET,
    allowImplicitFinals: false,
  },

  context_compactor: {
    type: 'context_compactor',
    model: 'claude-haiku',
    systemPrompt: '', // TODO: Define
    tools: [],
    budget: SCRIPT_BUDGET,
    allowImplicitFinals: true,
  },

  debugger: {
    type: 'debugger',
    model: 'claude-sonnet',
    systemPrompt: '', // TODO: Define
    tools: ALL_TOOLS,
    budget: STANDARD_BUDGET,
    allowImplicitFinals: false,
  },

  web_crawler: {
    type: 'web_crawler',
    model: 'claude-haiku',
    systemPrompt: '', // TODO: Define
    tools: ['WebFetch', 'WebSearch'],
    budget: STANDARD_BUDGET,
    allowImplicitFinals: false,
  },
};

/**
 * Get agent config with optional overrides.
 */
export function getAgentConfig(
  type: AgentType,
  overrides?: Partial<AgentConfig>
): AgentConfig {
  const base = AGENT_CONFIGS[type];
  if (!base) {
    throw new Error(`Unknown agent type: ${type}`);
  }
  return { ...base, ...overrides };
}
```

### 6.3 Agent Prompts (`src/agent-ts/agent/prompts.ts`)

```typescript
/**
 * System prompts for agent types.
 */

/**
 * RoutingAgent prompt.
 * Classifies request complexity into tiers.
 */
export const ROUTING_PROMPT = `You are a request complexity classifier.

Classify the user's request into exactly one tier:

**simple**:
- Factual questions answerable from knowledge
- No file access or tools needed
- Single-turn response

**standard**:
- Requires tools but straightforward
- 1-5 tool calls expected
- Single focused task

**complex**:
- Multi-step task requiring planning
- Multiple files or components involved
- Parallel work beneficial
- Iterative refinement likely needed

Respond with ONLY the tier name: simple, standard, or complex

Do not explain. Just output the single word.`;

/**
 * ExplorerAgent prompt.
 * Gathers system context and artifacts.
 */
export const EXPLORER_PROMPT = `You are a codebase exploration agent.

Your job is to gather information about the system and codebase to help plan task execution.

You MUST discover and report:
1. **Package managers**: Look for package.json, requirements.txt, Cargo.toml, go.mod, etc.
2. **Frameworks**: React, Vue, FastAPI, Express, Django, etc.
3. **Languages**: TypeScript, Python, Rust, Go, etc.
4. **Relevant files**: Files that relate to the task objective
5. **Patterns**: Coding conventions, file organization, testing patterns

Use the available tools (Read, Glob, Grep, Bash) to explore.

When done, output [FINAL] followed by a JSON summary:
{
  "packageManagers": ["npm", "pip"],
  "frameworks": ["React", "FastAPI"],
  "languages": ["TypeScript", "Python"],
  "os": "darwin",
  "artifacts": [
    { "path": "src/main.ts", "type": "source", "description": "Main entry point" }
  ],
  "patterns": ["Uses barrel exports", "Tests in __tests__ folders"]
}`;

/**
 * RuntimeScriptAgent prompt.
 * Generates executable WorkItem DAG.
 */
export const RUNTIME_SCRIPT_PROMPT = `You are a task planning agent.

Given a goal and system context, create an executable script of WorkItems.

Each WorkItem represents a unit of work to be executed by an agent.

Output a JSON object with this structure:
{
  "goal": "The overall goal",
  "workItems": [
    {
      "id": "work_001",
      "objective": "What this work accomplishes (definition of done)",
      "delta": "How this advances toward the goal",
      "agent": "standard|explorer|linter|tester|debugger|web_crawler",
      "dependencies": [],  // IDs of WorkItems that must complete first
      "toolHint": "Optional: specific tool to use",
      "targetPaths": ["Optional: file paths to operate on"]
    }
  ]
}

Guidelines:
- Maximize parallelization: independent work should have no dependencies
- Each WorkItem should be substantial (not micro-steps)
- Choose the right agent type for each task
- Use explorer for read-only discovery
- Use standard for general execution
- Use linter/tester for code quality
- Dependencies must reference valid WorkItem IDs

[FINAL] is implied - just output the JSON.`;

/**
 * StandardAgent prompt.
 * General purpose execution with tools.
 */
export const STANDARD_PROMPT = `You are an expert software engineer executing a task.

You have access to tools for reading, writing, and searching code.

Guidelines:
- Use tools to gather information before making changes
- Make targeted, minimal changes
- Verify your work with appropriate checks

Action markers:
- [FINAL] - Task is complete, include your response after this marker
- [NEED_CONTEXT] - You need user input, include a JSON prompt: {"question": "...", "options": [...]}
- [CONTINUE] - You're making progress but need another iteration

You MUST include an action marker in your response.`;
```

---

## 7. Orchestrator

### 7.1 Orchestrator Class (`src/agent-ts/orchestrator/orchestrator.ts`)

```typescript
/**
 * Orchestrator - Dispatches agents and owns execution state.
 *
 * Replaces the Wizard class with a cleaner execution model:
 * 1. ExplorerAgent gathers system context
 * 2. RuntimeScriptAgent generates WorkItem DAG
 * 3. Orchestrator executes DAG, dispatching agents in parallel
 */

import { v4 as uuidv4 } from 'uuid';
import type { LLMAdapter } from '../llm/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ContextWindow } from '../types/context.js';
import type { EventEmitCallback, AgentResult } from '../agent/types.js';
import { Agent } from '../agent/agent.js';
import { getAgentConfig } from '../agent/agent-configs.js';
import { createWorkItem, type WorkItem } from '../wizard/work-item.js';
import { WorkLedger } from '../wizard/work-ledger.js';
import { KnowledgeStore } from '../wizard/knowledge.js';
import { StagnationDetector } from '../wizard/stagnation.js';
import {
  WorkItemStateManager,
  type WorkItemState,
} from './workitem-state.js';
import {
  parseRuntimeScript,
  type RuntimeScript,
  type SystemContext,
  type RuntimeScriptOutput,
} from './runtime-script.js';
import { createEvent } from '../types/events.js';

/**
 * Orchestrator configuration.
 */
export interface OrchestratorConfig {
  /** Maximum iterations in execution loop */
  maxIterations: number;
  /** Maximum parallel agents */
  maxParallelAgents: number;
  /** Maximum retries per WorkItem */
  maxRetriesPerWorkItem: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  maxIterations: 50,
  maxParallelAgents: 3,
  maxRetriesPerWorkItem: 3,
};

/**
 * Result from Orchestrator.execute().
 */
export interface OrchestratorResult {
  success: boolean;
  response: string;
  error?: string;
  metrics: OrchestratorMetrics;
  paused: boolean;
  userPrompt?: AgentResult['userPrompt'];
}

/**
 * Orchestrator metrics.
 */
export interface OrchestratorMetrics {
  totalIterations: number;
  totalLlmCalls: number;
  totalToolCalls: number;
  durationMs: number;
  workItemsCompleted: number;
  workItemsFailed: number;
  workItemsSkipped: number;
}

/**
 * Tier classification.
 */
export type Tier = 'simple' | 'standard' | 'complex';

/**
 * Logger protocol.
 */
export interface OrchestratorLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  warning(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Orchestrator class.
 */
export class Orchestrator {
  private config: OrchestratorConfig;
  private toolRegistry: ToolRegistry;
  private llm: LLMAdapter;
  private emit: EventEmitCallback;
  private requestId: string;
  private logger?: OrchestratorLogger;

  // State (owned by Orchestrator)
  private workLedger!: WorkLedger;
  private knowledge!: KnowledgeStore;
  private stateManager!: WorkItemStateManager;
  private stagnation!: StagnationDetector;

  // Metrics
  private totalLlmCalls = 0;
  private totalToolCalls = 0;

  constructor(
    config: Partial<OrchestratorConfig>,
    toolRegistry: ToolRegistry,
    llm: LLMAdapter,
    emit: EventEmitCallback,
    requestId: string,
    logger?: OrchestratorLogger
  ) {
    this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
    this.toolRegistry = toolRegistry;
    this.llm = llm;
    this.emit = emit;
    this.requestId = requestId;
    this.logger = logger;
  }

  /**
   * Execute a goal.
   */
  async execute(
    context: ContextWindow,
    goal: string,
    tier: 'standard' | 'complex'
  ): Promise<OrchestratorResult> {
    const startTime = Date.now();

    // Initialize state
    this.workLedger = new WorkLedger();
    this.knowledge = new KnowledgeStore();
    this.stateManager = new WorkItemStateManager();
    this.stagnation = new StagnationDetector(this.config.maxRetriesPerWorkItem);
    this.totalLlmCalls = 0;
    this.totalToolCalls = 0;

    try {
      // Phase 1: Generate RuntimeScript
      const script = await this.generateRuntimeScript(context, goal, tier);

      // Initialize state from script
      this.stateManager.initFromScript(script.workItems);

      // Emit runtime_script_created event
      this.emit(createEvent('runtime_script_created', {
        goal: script.goal,
        workItemCount: script.workItems.length,
        workItems: script.workItems.map((w) => ({
          workId: w.workId,
          objective: w.objective,
          delta: w.delta,
          agent: w.agent,
          dependencies: [...w.dependencies],
        })),
        systemContext: {
          packageManagers: script.systemContext.packageManagers,
          frameworks: script.systemContext.frameworks,
          languages: script.systemContext.languages,
        },
      }));

      // Phase 2: Execute DAG
      const result = await this.executeDAG(context, goal, script);

      // Emit goal result
      const counts = this.stateManager.getCounts();
      if (result.success) {
        this.emit(createEvent('goal_achieved', {
          goal,
          completed: counts.completed,
          skipped: counts.skipped,
        }));
      } else if (!result.paused) {
        this.emit(createEvent('goal_not_achieved', {
          goal,
          reason: result.error ?? 'Unknown',
          completed: counts.completed,
          failed: counts.failed,
          skipped: counts.skipped,
        }));
      }

      return {
        ...result,
        metrics: {
          totalIterations: 0, // TODO: Track
          totalLlmCalls: this.totalLlmCalls,
          totalToolCalls: this.totalToolCalls,
          durationMs: Date.now() - startTime,
          workItemsCompleted: counts.completed,
          workItemsFailed: counts.failed,
          workItemsSkipped: counts.skipped,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log('error', `Orchestrator error: ${message}`);

      return {
        success: false,
        response: '',
        error: message,
        metrics: {
          totalIterations: 0,
          totalLlmCalls: this.totalLlmCalls,
          totalToolCalls: this.totalToolCalls,
          durationMs: Date.now() - startTime,
          workItemsCompleted: 0,
          workItemsFailed: 0,
          workItemsSkipped: 0,
        },
        paused: false,
      };
    } finally {
      this.stagnation.cleanupAll();
    }
  }

  /**
   * Generate RuntimeScript via ExplorerAgent + RuntimeScriptAgent.
   */
  private async generateRuntimeScript(
    context: ContextWindow,
    goal: string,
    tier: 'standard' | 'complex'
  ): Promise<RuntimeScript> {
    // For standard tier, create a single-WorkItem script
    if (tier === 'standard') {
      const workItem = createWorkItem({
        goal,
        objective: goal,
        delta: 'Execute the goal directly',
        agent: 'standard',
      });
      return {
        goal,
        workItems: [workItem],
        systemContext: {
          packageManagers: [],
          frameworks: [],
          languages: [],
          os: process.platform,
          artifacts: [],
          patterns: [],
        },
        createdAt: Date.now(),
      };
    }

    // Complex tier: run ExplorerAgent then RuntimeScriptAgent

    // 1. Exploration
    const explorerConfig = getAgentConfig('explorer');
    const explorerAgent = new Agent(
      explorerConfig,
      this.llm,
      this.toolRegistry,
      this.emit,
      this.requestId
    );

    const explorationWorkItem = createWorkItem({
      goal,
      objective: `Explore the codebase to understand:
1. What package managers are used?
2. What frameworks are in use?
3. What languages are present?
4. What files are relevant to: ${goal}
5. What patterns/conventions exist?`,
      agent: 'explorer',
    });

    const explorationResult = await explorerAgent.run({
      context,
      workItem: explorationWorkItem,
    });

    this.totalLlmCalls += explorationResult.metrics.llmCallsMade;
    this.totalToolCalls += explorationResult.metrics.toolCallsMade;

    // Parse system context from exploration
    const systemContext = this.parseSystemContext(explorationResult.response);

    // 2. Script generation
    const scriptConfig = getAgentConfig('runtime_script');
    const scriptAgent = new Agent(
      scriptConfig,
      this.llm,
      this.toolRegistry,
      this.emit,
      this.requestId
    );

    const scriptWorkItem = createWorkItem({
      goal,
      objective: `Create an executable WorkItem DAG for: ${goal}

System context:
${JSON.stringify(systemContext, null, 2)}`,
      agent: 'runtime_script',
    });

    const scriptResult = await scriptAgent.run({
      context,
      workItem: scriptWorkItem,
    });

    this.totalLlmCalls += scriptResult.metrics.llmCallsMade;

    // Parse script output
    const scriptOutput = this.parseScriptOutput(scriptResult.response, goal);
    return parseRuntimeScript(scriptOutput, systemContext);
  }

  /**
   * Execute the WorkItem DAG.
   */
  private async executeDAG(
    context: ContextWindow,
    goal: string,
    script: RuntimeScript
  ): Promise<{ success: boolean; response: string; error?: string; paused: boolean; userPrompt?: AgentResult['userPrompt'] }> {
    let iteration = 0;
    let lastResponse = '';
    let paused = false;
    let userPrompt: AgentResult['userPrompt'] | undefined;

    // In-flight agents: workId -> Promise
    type InFlightResult = {
      workId: string;
      result: AgentResult;
    };
    const inFlight = new Map<string, Promise<InFlightResult>>();

    while (!this.stateManager.isAllDone() || inFlight.size > 0) {
      iteration++;
      if (iteration > this.config.maxIterations) {
        this.log('warning', 'Max iterations reached');
        break;
      }

      // Dispatch ready WorkItems
      const ready = this.stateManager.getReady();
      for (const state of ready) {
        if (inFlight.size >= this.config.maxParallelAgents) break;

        const agentId = uuidv4().slice(0, 8);
        this.stateManager.markInProgress(state.workItem.workId, agentId);

        this.emit(createEvent('workitem_started', {
          workId: state.workItem.workId,
          objective: state.workItem.objective,
          delta: state.workItem.delta,
          agent: state.workItem.agent,
          dependencies: [...state.workItem.dependencies],
        }));

        // Dispatch agent
        const promise = this.dispatchAgent(context, state.workItem, agentId);
        inFlight.set(state.workItem.workId, promise);
      }

      if (inFlight.size === 0) {
        // No work in flight and no ready items
        if (!this.stateManager.isAllDone()) {
          this.log('warning', 'Possible deadlock - no ready WorkItems');
          break;
        }
        continue;
      }

      // Wait for any agent to complete
      const completed = await Promise.race(inFlight.values());
      inFlight.delete(completed.workId);

      const { workId, result } = completed;
      const state = this.stateManager.get(workId)!;

      // Update metrics
      this.totalLlmCalls += result.metrics.llmCallsMade;
      this.totalToolCalls += result.metrics.toolCallsMade;

      // Handle user input request
      if (result.needsUserInput && result.userPrompt) {
        this.stateManager.markAwaitingUser(workId);
        paused = true;
        userPrompt = result.userPrompt;
        break;
      }

      // Process result
      if (result.success) {
        this.stateManager.markCompleted(workId, result);
        lastResponse = result.response;

        this.emit(createEvent('workitem_completed', {
          workId,
          objective: state.workItem.objective,
          response: result.response,
          metrics: {
            llmCallsMade: result.metrics.llmCallsMade,
            toolCallsMade: result.metrics.toolCallsMade,
            durationMs: result.metrics.durationMs,
          },
        }));
      } else {
        // Check retry
        if (state.attemptCount < this.config.maxRetriesPerWorkItem) {
          this.stateManager.resetForRetry(workId);
          this.log('info', `Retrying WorkItem ${workId}`, { attempt: state.attemptCount + 1 });
        } else {
          this.stateManager.markFailed(workId, result.error ?? 'Unknown error', result);

          this.emit(createEvent('workitem_failed', {
            workId,
            objective: state.workItem.objective,
            error: result.error ?? 'Unknown error',
            toolErrors: result.toolErrors,
            terminationReason: result.terminationReason,
          }));
        }
      }
    }

    // Determine success
    const counts = this.stateManager.getCounts();
    const success = counts.failed === 0 && counts.completed > 0;

    return {
      success,
      response: lastResponse,
      error: success ? undefined : 'Some WorkItems failed',
      paused,
      userPrompt,
    };
  }

  /**
   * Dispatch an agent for a WorkItem.
   */
  private async dispatchAgent(
    context: ContextWindow,
    workItem: WorkItem,
    agentId: string
  ): Promise<{ workId: string; result: AgentResult }> {
    try {
      const config = getAgentConfig(workItem.agent);
      const agent = new Agent(
        config,
        this.llm,
        this.toolRegistry,
        this.emit,
        this.requestId
      );

      const result = await agent.run({ context, workItem });
      return { workId: workItem.workId, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        workId: workItem.workId,
        result: {
          success: false,
          response: '',
          error: message,
          metrics: { llmCallsMade: 0, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
          filesRead: [],
          invalidatedPaths: [],
          toolErrors: [message],
          terminationReason: `exception:${message}`,
          needsUserInput: false,
          isRefusal: false,
        },
      };
    }
  }

  /**
   * Parse system context from exploration result.
   */
  private parseSystemContext(response: string): SystemContext {
    try {
      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return {
          packageManagers: parsed.packageManagers ?? [],
          frameworks: parsed.frameworks ?? [],
          languages: parsed.languages ?? [],
          os: parsed.os ?? process.platform,
          artifacts: parsed.artifacts ?? [],
          patterns: parsed.patterns ?? [],
        };
      }
    } catch {
      this.log('warning', 'Failed to parse system context');
    }
    return {
      packageManagers: [],
      frameworks: [],
      languages: [],
      os: process.platform,
      artifacts: [],
      patterns: [],
    };
  }

  /**
   * Parse script output from RuntimeScriptAgent.
   */
  private parseScriptOutput(response: string, goal: string): RuntimeScriptOutput {
    try {
      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return {
          goal: parsed.goal ?? goal,
          workItems: parsed.workItems ?? [],
        };
      }
    } catch {
      this.log('warning', 'Failed to parse script output');
    }
    // Fallback: single WorkItem
    return {
      goal,
      workItems: [
        {
          id: 'work_001',
          objective: goal,
          delta: 'Execute the goal directly',
          agent: 'standard',
          dependencies: [],
        },
      ],
    };
  }

  /**
   * Resume after user input.
   */
  async resume(
    context: ContextWindow,
    userResponse: string
  ): Promise<OrchestratorResult> {
    // Add user response to context
    context.addMessage('user', userResponse);

    // Find awaiting WorkItem and reset it
    const awaiting = this.stateManager.getAll().find((s) => s.status === 'awaiting_user');
    if (awaiting) {
      this.stateManager.resetForRetry(awaiting.workItem.workId);
    }

    // Continue execution
    // Note: We need to store the script for resume - this is a limitation
    // For now, throw error
    throw new Error('Resume not yet implemented - script state not preserved');
  }

  private log(level: keyof OrchestratorLogger, msg: string, meta?: Record<string, unknown>): void {
    this.logger?.[level](msg, { component: 'orchestrator', requestId: this.requestId, ...meta });
  }
}
```

---

## 8. Event System

### 8.1 Event Bus Updates (`src/agent-ts/communication/event_bus.ts`)

```typescript
/**
 * EventBus - Central pub/sub event router.
 *
 * Updated to support:
 * - Per-run subscriptions via subscribeRun(runId, handler)
 * - Microtask-based async fan-out
 * - requestId tagging
 */

import { EventEmitter } from 'events';
import type { WizardEvent, WizardEventType, AgentEvent, OrchestratorEventType } from '../types/events.js';

type AnyEvent = WizardEvent<any> | AgentEvent<any>;

/**
 * EventBus protocol interface.
 */
export interface EventBusProtocol {
  publish(event: AnyEvent): void;
  subscribe(type: WizardEventType | OrchestratorEventType, handler: (event: AnyEvent) => void): () => void;
  subscribeAll(handler: (event: AnyEvent) => void): () => void;
  /** Subscribe to events for a specific run */
  subscribeRun(runId: string, handler: (event: AnyEvent) => void): () => void;
  /** Subscribe to all events globally */
  subscribeGlobal(handler: (event: AnyEvent) => void): () => void;
  shutdown(): void;
  isShutdown(): boolean;
}

/**
 * EventBus implementation.
 */
export class EventBus implements EventBusProtocol {
  private emitter = new EventEmitter();
  private runHandlers = new Map<string, Set<(event: AnyEvent) => void>>();
  private globalHandlers = new Set<(event: AnyEvent) => void>();
  private shutdownFlag = false;
  private readonly ALL_EVENTS = '__all__';

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  publish(event: AnyEvent): void {
    if (this.shutdownFlag) return;

    // Extract runId from event data if present
    const runId = (event as any).runId ?? (event.data as any)?.runId;

    // Fan out to run-specific handlers via microtask
    if (runId && this.runHandlers.has(runId)) {
      for (const handler of this.runHandlers.get(runId)!) {
        queueMicrotask(() => {
          try {
            handler(event);
          } catch (err) {
            console.error('[EventBus] Handler error:', err);
          }
        });
      }
    }

    // Fan out to global handlers via microtask
    for (const handler of this.globalHandlers) {
      queueMicrotask(() => {
        try {
          handler(event);
        } catch (err) {
          console.error('[EventBus] Handler error:', err);
        }
      });
    }

    // Legacy: emit to type-specific and catch-all subscribers
    this.emitter.emit(event.type, event);
    this.emitter.emit(this.ALL_EVENTS, event);
  }

  subscribe(
    type: WizardEventType | OrchestratorEventType,
    handler: (event: AnyEvent) => void
  ): () => void {
    this.emitter.on(type, handler);
    return () => this.emitter.off(type, handler);
  }

  subscribeAll(handler: (event: AnyEvent) => void): () => void {
    this.emitter.on(this.ALL_EVENTS, handler);
    return () => this.emitter.off(this.ALL_EVENTS, handler);
  }

  subscribeRun(runId: string, handler: (event: AnyEvent) => void): () => void {
    if (!this.runHandlers.has(runId)) {
      this.runHandlers.set(runId, new Set());
    }
    this.runHandlers.get(runId)!.add(handler);
    return () => {
      this.runHandlers.get(runId)?.delete(handler);
      if (this.runHandlers.get(runId)?.size === 0) {
        this.runHandlers.delete(runId);
      }
    };
  }

  subscribeGlobal(handler: (event: AnyEvent) => void): () => void {
    this.globalHandlers.add(handler);
    return () => this.globalHandlers.delete(handler);
  }

  shutdown(): void {
    if (this.shutdownFlag) return;
    this.shutdownFlag = true;
    this.emitter.removeAllListeners();
    this.runHandlers.clear();
    this.globalHandlers.clear();
  }

  isShutdown(): boolean {
    return this.shutdownFlag;
  }
}

/**
 * Create an EventEmitCallback that tags events and publishes to EventBus.
 */
export function createEventEmitCallback(
  eventBus: EventBusProtocol,
  requestId: string,
  runId?: string
): (event: AnyEvent) => void {
  return (event: AnyEvent) => {
    // Tag event with requestId and runId
    const taggedEvent = {
      ...event,
      requestId,
      runId: runId ?? requestId,
      timestamp: event.timestamp ?? Date.now() / 1000,
    };
    eventBus.publish(taggedEvent);
  };
}
```

---

## 9. Harness Integration

### 9.1 Harness Updates (`src/agent-ts/harness/harness.ts`)

Key changes:
- Add RoutingAgent call
- Replace Agent with Orchestrator for standard/complex
- Create EventEmitCallback for each run

```typescript
// In AgentHarness.run()

run(params: AgentRunParams): AgentRunHandle {
  const { requestId, inputText, tier: requestedTier, sessionKey } = params;
  const eventQueue = new AsyncEventQueue();
  const runId = requestId;

  // Create emit callback that tags events
  const emit = createEventEmitCallback(this.eventBus, requestId, runId);

  // Get or create context
  const contextWindow = this.getOrCreateContext(sessionKey);

  // Add user input to context
  contextWindow.addMessage('user', inputText);

  const resultPromise = (async (): Promise<AgentRunResult> => {
    try {
      // 1. Route to determine tier (unless explicitly provided)
      const tier = requestedTier ?? await this.route(inputText, emit);

      // 2. Simple tier - direct agent call
      if (tier === 'simple') {
        return this.runSimpleAgent(contextWindow, inputText, requestId, emit);
      }

      // 3. Standard/Complex - use Orchestrator
      const orchestrator = new Orchestrator(
        this.orchestratorConfig,
        this.toolRegistry,
        this.llm,
        emit,
        requestId,
        this.logger
      );

      const result = await orchestrator.execute(contextWindow, inputText, tier);

      // Persist context
      this.persistContext(contextWindow);

      return {
        requestId,
        sessionKey,
        success: result.success,
        finalText: result.response,
        errorMessage: result.error,
        paused: result.paused,
        userPrompt: result.userPrompt,
        toolsUsed: [], // TODO: Track from result
        durationMs: result.metrics.durationMs,
        metadata: { tier, metrics: result.metrics },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        requestId,
        sessionKey,
        success: false,
        finalText: '',
        errorMessage: message,
        paused: false,
        toolsUsed: [],
        durationMs: 0,
      };
    }
  })();

  return { result: resultPromise, events: eventQueue };
}

/**
 * Route a request to determine tier.
 */
private async route(goal: string, emit: EventEmitCallback): Promise<Tier> {
  const routingConfig = getAgentConfig('routing');

  // Create lightweight LLM for routing
  const routingLLM = createAdapter({
    provider: 'openai',
    model: 'gpt-5-nano',
    apiKey: this.config.llm.apiKey,
    maxTokens: 10,
  });

  const response = await routingLLM.respond({
    messages: [
      { role: 'system', content: routingConfig.systemPrompt },
      { role: 'user', content: goal },
    ],
  });

  const content = response.content?.toLowerCase().trim() ?? '';

  if (content.includes('simple')) return 'simple';
  if (content.includes('complex')) return 'complex';
  return 'standard';
}

/**
 * Run simple tier - single agent, no orchestration.
 */
private async runSimpleAgent(
  context: ContextWindow,
  goal: string,
  requestId: string,
  emit: EventEmitCallback
): Promise<AgentRunResult> {
  const config = getAgentConfig('standard');
  const agent = new Agent(config, this.llm, this.toolRegistry, emit, requestId);

  const workItem = createWorkItem({
    goal,
    objective: goal,
    agent: 'standard',
  });

  const result = await agent.run({ context, workItem });

  this.persistContext(context);

  return {
    requestId,
    sessionKey: context.sessionKey,
    success: result.success,
    finalText: result.response,
    errorMessage: result.error,
    paused: result.needsUserInput,
    userPrompt: result.userPrompt,
    toolsUsed: [], // TODO: Track
    durationMs: result.metrics.durationMs,
  };
}
```

---

## 10. State Management

### 10.1 State Ownership

| Component | Owns | Scope |
|-----------|------|-------|
| **Harness** | ContextWindow (per session), EventBus | Process lifetime |
| **Orchestrator** | WorkItemStateManager, WorkLedger, KnowledgeStore | Single execute() call |
| **Agent** | Local context mutations | Single run() call |

### 10.2 Context Flow

```
Harness
  │ contextWindow = getOrCreateContext(sessionKey)
  │ contextWindow.addMessage('user', inputText)
  │
  ├─ [simple] ─────────────────────────────────────────┐
  │   agent.run({ context: contextWindow, workItem })  │
  │   // Agent mutates contextWindow directly          │
  │   persistContext(contextWindow)                    │
  │                                                    │
  └─ [standard|complex] ───────────────────────────────┤
      orchestrator.execute(contextWindow, goal, tier)  │
        │                                              │
        ├─ ExplorerAgent.run({ context, workItem })    │
        │   // Mutates context                         │
        │                                              │
        ├─ RuntimeScriptAgent.run({ context, workItem })│
        │   // Mutates context                         │
        │                                              │
        └─ for each WorkItem in DAG:                   │
            Agent.run({ context, workItem })           │
            // All agents share and mutate context     │
                                                       │
      persistContext(contextWindow) ◄──────────────────┘
```

### 10.3 State Persistence

- **GraphD**: Session and context snapshots persist to GraphD
- **Resume**: Orchestrator.resume() reloads state from ContextWindow (WorkItem state needs enhancement)

---

## 11. Agent Instantiation & Tool Discretion

### 11.1 Tool Filtering

Each agent type has a whitelist of allowed tools in `AGENT_CONFIGS`:

```typescript
// Explorer - read-only
tools: ['Read', 'Glob', 'Grep', 'Bash']

// Standard - full access
tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']

// Routing, RuntimeScript - no tools
tools: []
```

### 11.2 Agent Instantiation

```typescript
// In Orchestrator.dispatchAgent()
const config = getAgentConfig(workItem.agent);
const agent = new Agent(config, this.llm, this.toolRegistry, this.emit, this.requestId);

// Tool filtering happens in Agent.processToolCalls()
if (this.config.tools.length > 0 && !this.config.tools.includes(call.name)) {
  // Reject tool call
}
```

### 11.3 Custom Agent Instantiation

For inline/lambda-style agents:

```typescript
// Custom config for one-off agent
const customConfig: AgentConfig = {
  type: 'standard',
  model: 'claude-sonnet',
  systemPrompt: 'Custom prompt...',
  tools: ['Read', 'Write'],
  budget: { maxIterations: 5, maxToolCalls: 10, maxDurationMs: 60000 },
};

const agent = new Agent(customConfig, llm, toolRegistry, emit, requestId);
```

---

## 12. Session & Request Tracking

### 12.1 Identifiers

| ID | Scope | Source |
|----|-------|--------|
| `sessionKey` | Conversation session | Harness (from TUI) |
| `requestId` | Single user request | Harness (generated or from TUI) |
| `runId` | Execution run (usually = requestId) | Harness |
| `workId` | Single WorkItem | createWorkItem() |
| `agentId` | Single agent dispatch | Orchestrator (UUID) |

### 12.2 Tracking Flow

```
Request arrives at Harness
  requestId = params.requestId or generateUUID()
  sessionKey = params.sessionKey

  ContextWindow = getOrCreateContext(sessionKey)

  EventEmitCallback tags all events with:
    - requestId
    - runId (= requestId by default)
    - timestamp

  Orchestrator receives requestId, passes to Agent

  Agent emits events with requestId

  EventBus routes to:
    - Run-specific handlers (subscribeRun(runId))
    - Global handlers (subscribeGlobal())

  GraphDSubscriber persists events with requestId
```

---

## 13. Logger Integration

### 13.1 Logger Protocol

Unchanged from current implementation:

```typescript
interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  warning(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
```

### 13.2 Logger Usage

```typescript
// Agent
this.log('info', `Tool call: ${call.name}`, { requestId: this.requestId });

// Orchestrator
this.log('debug', `Dispatching WorkItem ${workId}`, { requestId: this.requestId, agentType: workItem.agent });
```

---

## 14. LLM Adapter Compliance

### 14.1 Adapter Interface

Current adapter interface (unchanged):

```typescript
interface LLMAdapter {
  provider: string;
  model: string;
  respond(params: LLMRequestParams): Promise<LLMResponse>;
}

interface LLMRequestParams {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

interface LLMResponse {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  model?: string;
}
```

### 14.2 Agent LLM Calls

Agent.run() calls comply with adapter:

```typescript
const response = await this.llm.respond({
  messages: messages as Message[],
  tools: allowedTools.length > 0 ? allowedTools : undefined,
});
```

### 14.3 Model Selection

Model is determined by AgentConfig.model:
- Routing: `gpt-5-nano`
- Explorer: `gpt-5-mini`
- RuntimeScript: `gpt-5.2`
- Standard: `gpt-5.2`

---

## 15. Migration Checklist

### Phase 1: Types & Interfaces

- [ ] Create `src/agent-ts/agent/types.ts`
- [ ] Create `src/agent-ts/orchestrator/workitem-state.ts`
- [ ] Create `src/agent-ts/orchestrator/runtime-script.ts`
- [ ] Update `src/agent-ts/wizard/work-item.ts` (add new fields)
- [ ] Update `src/agent-ts/types/events.ts` (add orchestrator events)

### Phase 2: Agent Primitive

- [ ] Create `src/agent-ts/agent/prompts.ts`
- [ ] Create `src/agent-ts/agent/agent-configs.ts`
- [ ] Rewrite `src/agent-ts/agent/agent.ts` (absorb Worker)
- [ ] Update `src/agent-ts/agent/index.ts`

### Phase 3: Orchestrator

- [ ] Create `src/agent-ts/orchestrator/orchestrator.ts`
- [ ] Create `src/agent-ts/orchestrator/index.ts`

### Phase 4: Event System

- [ ] Update `src/agent-ts/communication/event_bus.ts`
- [ ] Add `createEventEmitCallback` helper

### Phase 5: Harness Integration

- [ ] Update `src/agent-ts/harness/harness.ts`
- [ ] Add routing logic
- [ ] Replace Agent with Orchestrator

### Phase 6: Cleanup

- [ ] Delete `src/agent-ts/wizard/worker.ts`
- [ ] Delete `src/agent-ts/wizard/plan-state.ts`
- [ ] Delete `src/agent-ts/planner/planner.ts`
- [ ] Delete `src/agent-ts/planner/index.ts`
- [ ] Delete `src/agent-ts/types/plans.ts`
- [ ] Update all imports

### Phase 7: Testing

- [ ] Update/create unit tests for Agent
- [ ] Update/create unit tests for Orchestrator
- [ ] Integration tests for Harness → Orchestrator flow
- [ ] Event system tests

### Phase 8: Documentation

- [ ] Update README
- [ ] Update architecture docs
- [ ] Migration guide for existing code

---

## Appendix A: File Structure After Migration

```
src/agent-ts/
├── agent/
│   ├── agent.ts           # NEW: Pure agent primitive
│   ├── agent-configs.ts   # NEW: Pre-defined configs
│   ├── prompts.ts         # NEW: System prompts
│   ├── types.ts           # NEW: Agent types
│   └── index.ts           # Updated exports
├── orchestrator/
│   ├── orchestrator.ts    # NEW: Orchestrator class
│   ├── workitem-state.ts  # NEW: WorkItem state manager
│   ├── runtime-script.ts  # NEW: RuntimeScript types
│   └── index.ts           # NEW: Exports
├── wizard/
│   ├── work-item.ts       # UPDATED: New fields
│   ├── work-ledger.ts     # KEPT: Unchanged
│   ├── knowledge.ts       # KEPT: Unchanged
│   ├── stagnation.ts      # KEPT: Unchanged
│   ├── context.ts         # KEPT: buildSystemMessage
│   └── index.ts           # UPDATED: No Worker, no PlanState
├── communication/
│   ├── event_bus.ts       # UPDATED: subscribeRun, microtask
│   └── index.ts
├── harness/
│   ├── harness.ts         # UPDATED: Routing, Orchestrator
│   └── ...
├── types/
│   ├── events.ts          # UPDATED: Orchestrator events
│   └── ...                # plans.ts DELETED
└── planner/               # DELETED entirely
```

---

## Appendix B: Event Reference

| Event | Emitter | Data |
|-------|---------|------|
| `llm_call` | Agent | agentType, promptPreview, responsePreview, tokens, duration |
| `tool_call` | Agent | toolName, arguments, phase, result, success, duration |
| `llm_error` | Agent | agentType, provider, model, error, errorType |
| `runtime_script_created` | Orchestrator | goal, workItemCount, workItems, systemContext |
| `workitem_started` | Orchestrator | workId, objective, delta, agent, dependencies |
| `workitem_completed` | Orchestrator | workId, objective, response, metrics |
| `workitem_failed` | Orchestrator | workId, objective, error, toolErrors, terminationReason |
| `goal_achieved` | Orchestrator | goal, completed, skipped |
| `goal_not_achieved` | Orchestrator | goal, reason, completed, failed, skipped |

---

*End of Specification*
