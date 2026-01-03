# Python Agent → TypeScript Migration Plan

## Summary

Migrate the Python Agent system (harness, planner, wizard, worker) to TypeScript to:
- Eliminate process complexity (bridge.py, harness_worker processes)
- Enable native async/event-driven patterns
- Improve development velocity with unified TypeScript stack

**Strategy**: Clean break on a new branch. TypeScript is the default. Each chunk is a PR that replaces Python functionality. Delete Python code as we go.

---

## Architecture Comparison

### Current (Python)
```
TUI (TS) → bridge.py → EventBus → harness_worker (process)
                                   → AgentHarness
                                   → TieredAgent → Planner → Wizard → Worker
                                   → GraphD (SQLite)
```

### Target (TypeScript)
```
TUI (TS) → Agent (in-process)
           → Planner → Wizard → Worker (async)
           → GraphD Client (better-sqlite3)
           → Dashboard (Vite, polls GraphD HTTP)
```

**Key wins**: Single process, native async/await, unified type system, no IPC overhead.

---

## Chunk Dependency Graph

```
Chunk 1 (Shared Types) ──────────────────────────────┐
       │                                              │
       ├──> Chunk 2 (GraphD Client) ─────────────────┤
       │                                              │
       ├──> Chunk 3 (LLM Adapter) ───────────────────┤
       │                                              │
       └──> Chunk 4 (Tool Registry) ─────────────────┤
                                                      │
                                                      v
                                        Chunk 5 (Worker/Wizard)
                                                      │
                                                      v
                                        Chunk 6 (Planner/Agent + TUI Integration)
```

---

## Chunk 1: Shared Types & Event System

**Goal**: TypeScript types that mirror Python dataclasses.

### Files to Create
```
src/agent-ts/
  types/
    events.ts       # WizardEventType, WizardEvent
    plan.ts         # Plan, PlanStep, PlanPhase
    worker.ts       # WorkerOutcome, WorkerMetrics
    tools.ts        # ToolResult, ToolStatus
    session.ts      # SessionContext, ContextWindow
  index.ts
```

### Source Reference
- `src/harness/agent/wizard/events.py` → `events.ts`
- `src/harness/agent/plan_models.py` → `plan.ts`
- `dashboard/src/domain/models.ts` (reuse existing types!)

### Footguns
- **Enum serialization**: Python uses `.value`, TS uses string values directly
- **Timestamps**: Python `time.time()` returns float seconds, JS `Date.now()` returns int ms

### Done When
- All event types from Python exist in TypeScript
- JSON serialization matches exactly

---

## Chunk 2: GraphD TypeScript Client

**Goal**: TypeScript GraphD persistence using better-sqlite3.

### Files to Create
```
src/agent-ts/
  graphd/
    store.ts        # GraphStore (better-sqlite3)
    server.ts       # HTTP server (Express/Fastify)
    schema.ts       # DDL statements
    types.ts
```

### Source Reference
- `src/harness/graphd/store.py` → `store.ts`
- `src/harness/graphd/server.py` → `server.ts`

### Key Methods to Port
```typescript
class GraphStore {
  sessionTouch(sessionKey: string, workingDir?: string): boolean
  messageAdd(sessionKey: string, role: string, content: string, metadata?: object): number
  contextSave(sessionKey: string, context: object): number
  contextGet(sessionKey: string): object | null
  sessionUpdateMetadata(sessionKey: string, metadata: object): boolean
}
```

### Footguns
- **Schema versioning**: Must match `GRAPHD_SCHEMA_VERSION` from Python
- **WAL mode**: Enable with `PRAGMA journal_mode=WAL` for concurrent reads

### Done When
- All GraphStore methods from Python ported
- Dashboard can read from TypeScript GraphD
- HTTP API matches Python spec

---

## Chunk 3: LLM Adapter Layer

**Goal**: TypeScript LLM adapters using @anthropic-ai/sdk and openai.

### Files to Create
```
src/agent-ts/
  llm/
    adapter.ts      # LLMAdapter interface
    anthropic.ts    # AnthropicAdapter
    openai.ts       # OpenAIAdapter
    types.ts        # LLMConfig, LLMResponse
    retry.ts        # Exponential backoff
```

### Source Reference
- `src/util/llm_adapter.py` → TypeScript

### Interface
```typescript
interface LLMAdapter {
  respond(params: {
    messages: Message[];
    tools?: ToolDefinition[];
    maxTokens?: number;
  }): Promise<LLMResponse>;

  stream(params: StreamParams): AsyncGenerator<string, LLMResponse>;
}
```

### Footguns
- **Tool schema format**: Anthropic vs OpenAI differ
- **Streaming**: Different event structures between providers

### Done When
- Can make LLM calls with tools
- Streaming works for TUI output

---

## Chunk 4: Tool Registry & Execution

**Goal**: Port tool execution layer to TypeScript.

### Files to Create
```
src/agent-ts/
  tools/
    registry.ts     # ToolRegistry class
    executor.ts     # Tool execution engine
    types.ts        # ToolResult, ToolConfig
    builtins/
      bash.ts       # spawn-based execution
      read.ts       # fs.readFile
      write.ts      # fs.writeFile
      grep.ts       # ripgrep subprocess
      glob.ts       # fast-glob
```

### Source Reference
- `src/harness/agent/tool_registry.py` → TypeScript

### Key Pattern
```typescript
class ToolExecutor {
  async executeBash(args: BashArgs): Promise<ToolResult> {
    return new Promise((resolve) => {
      const proc = spawn('bash', ['-c', args.command], {
        cwd: args.workdir,
        timeout: args.timeout ?? 120000,
      });
      // handle stdout, stderr, exit code
    });
  }
}
```

### Footguns
- **Timeout handling**: Node spawn timeout sends SIGTERM, may need SIGKILL follow-up
- **Path normalization**: Use `path.posix` for consistency

### Done When
- All builtin tools work (Bash, Read, Write, Grep, Glob)
- Timeouts and cancellation work

---

## Chunk 5: Worker & Wizard Orchestration

**Goal**: Port the core orchestration loop to TypeScript.

### Files to Create
```
src/agent-ts/
  wizard/
    worker.ts       # Stateless Worker
    wizard.ts       # Wizard orchestrator
    plan-state.ts   # PlanState management
    work-ledger.ts  # Append-only audit trail
    knowledge.ts    # KnowledgeStore
    context.ts      # ContextWindow, SessionContext
    stagnation.ts   # Stagnation detector
```

### Source Reference
- `src/harness/agent/wizard/wizard.py` (lines 208-900) → `wizard.ts`
- `src/harness/agent/wizard/worker.py` (lines 369-700) → `worker.ts`

### Core Loop (wizard.ts)
```typescript
async orchestrate(params: OrchestrateParams): Promise<WizardResult> {
  while (iteration < this.config.maxIterations) {
    const readySteps = this.planState.getReadySteps();
    if (!readySteps.length) break;

    const step = readySteps[0];
    const outcome = await this.worker.execute(context, workItem);

    this.applyReflectionVerdict(step, outcome);
    this.emitEvent({ type: 'STEP_COMPLETED', stepNum: step.stepNum, data: outcome });
  }
  return this.buildResult();
}
```

### Worker Loop (worker.ts)
```typescript
async execute(context: ContextWindow, workItem: WorkItem): Promise<WorkerOutcome> {
  while (iteration < this.config.maxIterations) {
    const response = await this.llm.respond({ messages, tools });

    if (response.toolCalls?.length) {
      for (const call of response.toolCalls) {
        const result = await this.toolRegistry.execute(call.name, call.arguments);
        // accumulate in contextDelta
      }
      continue;
    }

    if (this.isFinalResponse(response.content)) {
      return { success: true, finalResponse: content, ... };
    }
  }
}
```

### Footguns
- **Single-writer invariant**: Never mutate state in parallel. Use sequential `for...of`, not `Promise.all` for step execution.
- **Event ordering**: Timestamp all events, sort on consumption if needed.

### Done When
- Wizard can execute a multi-step plan
- Events are emitted correctly (dashboard can display them)
- User input pause/resume works

---

## Chunk 6: Planner, Agent & TUI Integration

**Goal**: Complete the migration. Delete bridge.py.

### Files to Create
```
src/agent-ts/
  planner/
    planner.ts      # Planner class
    fast-path.ts    # Simple pattern matching
    prompts.ts      # Planning prompts
  agent/
    agent.ts        # Agent class
    tiered-agent.ts # TieredAgent
  synthesis/
    synthesizer.ts  # ResponseSynthesizer
  harness.ts        # AgentHarness equivalent
  index.ts
```

### Source Reference
- `src/harness/agent/planner.py` → `planner.ts`
- `src/harness/agent/agent.py` → `agent.ts`
- `src/harness/agent/synthesis.py` → `synthesizer.ts`

### TUI Integration
```typescript
// tui-ts/index.tsx - after migration complete
import { AgentHarness } from '../src/agent-ts';

const harness = new AgentHarness(config);
const response = await harness.process(userInput, tier, sessionKey);
```

### Footguns
- **Planning prompts**: LLM may behave differently. Test and tune.
- **Tier configuration**: Must match Python tier configs.

### Done When
- TUI calls TypeScript Agent directly (no bridge.py)
- End-to-end flow works
- Delete `tui-ts/bridge.py` and Python agent code

---

## Files to Delete After Migration

After Chunk 6 is complete and tested:

```
DELETE:
- tui-ts/bridge.py
- src/harness/agent/ (entire directory)
- src/harness/graphd/ (entire directory, replaced by TS)
- src/util/llm_adapter.py
- src/communication/event_bus.py
- src/communication/process_manager.py
```

---

## Critical Python Files Reference

Read these carefully before porting each chunk:

| File | Lines | What to Port |
|------|-------|--------------|
| `src/harness/agent/wizard/wizard.py` | 208-900 | Core orchestration loop |
| `src/harness/agent/wizard/worker.py` | 369-700 | Stateless tool execution |
| `src/harness/agent/wizard/events.py` | all | Event types |
| `src/harness/agent/planner.py` | all | Planning logic |
| `src/harness/agent/agent.py` | all | TieredAgent |
| `src/harness/agent/synthesis.py` | all | Response synthesis |
| `src/harness/graphd/store.py` | all | SQLite persistence |

---

## TypeScript Patterns Reference

Reuse these from existing TS code:

| File | What to Reuse |
|------|---------------|
| `dashboard/src/domain/models.ts` | Event types, PlanStep, ToolCall, etc. |
| `dashboard/src/lib/mappers.ts` | Event parsing patterns |
| `tui-ts/types.ts` | Protocol types |
| `tui-ts/client.ts` | EventEmitter patterns |

---

## Next Steps

1. Create new branch for TypeScript migration
2. Start with Chunk 1: Create `src/agent-ts/types/`
3. Set up Jest for testing
4. Each chunk is a PR, merged when tests pass
