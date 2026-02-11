# Decouple Watcher: Make It a Real Plugin

## Context

The watcher is supposed to be a plugin (`decision-watcher` in `packages/infra/`) but its concerns are scattered across 4 packages:

- **`shared/output_schemas.ts`** — All watcher Zod schemas, trigger-specific schema builder, semantic output schema (duplicate)
- **`shared/structured_output.ts`** — Watcher-specific lenient parser, `watcher_action` special case in generic `parseAndValidateOutput`
- **`agent/src/agent.ts`** — ~170 lines of watcher-specific code: lenient parser (DUPLICATED from shared), schema reminders, output validation special cases. Also has `planner_output` special case.
- **`harness-daemon/harness.ts`** — `runWatcherAgent()`: creates Agent instances, manages ContextWindow, builds trigger-specific schemas, parses output. All of this should be internal to the plugin.

The hook interface (`Hook<ControlEvent, Decision>`) already IS the right plugin boundary — it's just being bypassed. After this refactor, the watcher plugin owns everything: schemas, LLM interaction, output parsing. The harness provides infrastructure and receives decisions.

## Patterns Endorsed

1. **Plugin owns its LLM interaction** — Plugins that need LLM calls receive infrastructure deps (LLMAdapter, ToolRegistry, etc.) and create their own Agent instances. No callback proxying.
2. **Schemas are plugin-internal** — Output schemas for plugin agents live in the plugin package. `shared` only holds cross-cutting vocabulary (enums, contracts).
3. **Hook interface is the plugin boundary** — Plugins register hooks, receive events, return decisions. The orchestrator/harness never reaches into plugin internals.
4. **Agent class is schema-agnostic** — No hardcoded `if (schemaId === 'xxx')` branches. Custom parsing/reminders are injected via `AgentConfig` hooks.

---

## Phase 1: Make Agent Schema-Agnostic

Add `parseOutput` and `schemaReminder` to `AgentConfig`. Remove all hardcoded schema special cases.

### `packages/core/agent/src/types.ts`
- Add to `AgentConfig`:
  ```typescript
  parseOutput?: (parsed: Record<string, unknown>, rawContent: string) => Record<string, unknown> | null;
  schemaReminder?: string;
  ```

### `packages/core/agent/src/agent.ts`
- **`buildSchemaReminder()`** (line 2771): If `this.config.schemaReminder` is set, return it. Delete the `watcher_action` and `planner_output` if-branches. Keep the generic fallback.
- **`parseStructuredOutput()`** (line 3102+): If `this.config.parseOutput` is set, call it instead of the built-in validation. Delete the `if (schemaId === 'watcher_action')` block (lines 3122-3130).
- **Delete** these watcher-specific private methods entirely (~100 lines):
  - `normalizeWatcherActionCandidate()` (2833-2935)
  - `parseWatcherActionLenient()` (2937-2948)
  - `inferQualityGate()` (2821-2831)
  - `inferBooleanFromText()` (2799-2807)
  - `readNestedString()` (2809-2819)
- **Keep** `parseBoolean()` — still used by `normalizeActionOutputCandidate()`.
- **Remove** `WATCHER_ACTION_VALUES` from imports (line 23) — no longer needed.

### Verification
- `bun test packages/core/agent/` — existing tests still pass
- Nothing breaks yet: `parseOutput` is optional, so existing agents with `watcher_action` schema still fall through to generic `getOutputSchema` validation in shared

---

## Phase 2: Move Watcher Schemas into decision-watcher

Consolidate ALL watcher output schemas, lenient parser, and schema builder into the plugin.

### Create `packages/infra/decision-watcher/src/output-schemas.ts`
Move from `shared/output_schemas.ts`:
- All per-action Zod schemas (`WatcherAnswerSchema`, `WatcherRealignSchema`, `WatcherSplitSchema`, `WatcherCreateWorkItemSchema`, `WatcherStopWorkItemSchema`, `WatcherQualityGateSchema`, `WatcherContinueDecisionSchema`)
- `WatcherBaseSchema`, `WatcherActionOutputSchema`
- `WATCHER_ACTION_SCHEMAS` map
- `buildWatcherSchemaForActions()`, `getWatcherSchemaJsonForActions()`

Replace `WatcherSemanticOutputSchema` with import from `./semantic/schemas.js` (`SemanticOutputSchema`) — eliminate the duplicate.

Move from `shared/structured_output.ts`:
- `normalizeWatcherActionCandidate()` (lenient parser)
- `parseWatcherActionLenient()`

Add new exports:
- `parseWatcherOutput(raw: unknown): WatcherActionOutput | null` — coerce + lenient parse (uses `coerceStructuredOutput` from shared + local normalizer)
- `buildWatcherParseOutput(): AgentConfig['parseOutput']` — returns the `parseOutput` callback for AgentConfig
- `WATCHER_SCHEMA_REMINDER: string` — the prompt text currently hardcoded in agent.ts
- `PLANNER_SCHEMA_REMINDER: string` — extract the planner reminder too, export for harness to use

### Modify `packages/core/shared/src/output_schemas.ts`
- Delete all watcher schemas (lines ~211-488): `WatcherSemanticOutputSchema`, all sub-schemas, `WatcherBaseSchema`, per-action schemas, `WatcherActionOutputSchema`, `WATCHER_ACTION_SCHEMAS`, `buildWatcherSchemaForActions`, `getWatcherSchemaJsonForActions`
- Remove `watcher_action` from `OUTPUT_SCHEMAS` registry
- Remove `WatcherActionOutput` type export

### Modify `packages/core/shared/src/structured_output.ts`
- Delete `normalizeWatcherActionCandidate()` (~115 lines)
- Delete `parseWatcherActionLenient()`
- Delete `if (schemaName === 'watcher_action')` block in `parseAndValidateOutput`
- Remove `getWatcherSchemaJsonForActions` from re-exports
- Remove `WATCHER_ACTION_VALUES` import

### Modify `packages/core/shared/src/index.ts`
- Remove `getWatcherSchemaJsonForActions`, `WatcherActionOutput` from exports

### Update `packages/infra/decision-watcher/src/index.ts`
- Export new symbols from `./output-schemas.js`

### Delete `packages/core/protocol/src/protocol/schemas.ts` `WatcherOutputSchema` (lines 223-245)
- Unused third definition of watcher output shape. Clean it up.

### Move test: `shared/structured_output.watcher.test.ts` → `decision-watcher/src/output-schemas.test.ts`

### Verification
- `bun test packages/core/shared/` — no watcher test, generic tests pass
- `bun test packages/infra/decision-watcher/` — ported watcher tests pass
- `npx tsc --noEmit` across protocol, shared, agent, decision-watcher — clean

---

## Phase 3: Internalize Agent Creation in decision-watcher

Replace the harness's `runWatcherAgent()` with watcher-owned Agent creation.

### New interface in `packages/infra/decision-watcher/src/watcher-agent.ts`

Replace `runAgent` callback:
```typescript
interface WatcherRuntime {
  llm: LLMAdapter;
  toolRegistry: ToolRegistry;
  agentConfig: AgentConfig;        // Watcher agent config from registry
  llmConfig: LLMRequestConfig;     // Pre-resolved from model selection
  agentRegistry: AgentRegistry;    // For sub-agent spawning if needed
  contextWindow: ContextWindow;    // Session-scoped, harness-owned lifetime
  emit: EventEmitCallback;
  sessionKey: string;
  requestId: string;
  getModelSelection?: (agentType: string) => ModelSelection | null;
  memoryInjector?: MemoryInjector;
}

interface WatcherAgentConfig {
  // ... same fields except:
  // DELETE: runAgent callback
  // ADD:
  runtime: WatcherRuntime;
}
```

### Add `runWatcherLLM()` in `watcher-agent.ts`
Private function that:
1. Gets valid actions for trigger via `getValidActions(trigger)`
2. Builds trigger-specific schema via `getWatcherSchemaJsonForActions(validActions)`
3. Overrides `agentConfig.outputSchema` with trigger-specific schema
4. Sets `agentConfig.parseOutput = buildWatcherParseOutput()`
5. Sets `agentConfig.schemaReminder = WATCHER_SCHEMA_REMINDER`
6. Creates `new Agent(overriddenConfig, { llm, toolRegistry, llmConfig, ... })`
7. Creates WorkItem via `createWorkItem()`
8. Runs agent, extracts `structuredOutput`
9. Maps to `WatcherAction` (move the switch/case from harness lines 3058-3093)
10. Validates via `assertValidActionForTrigger()`

### Update `runAndLog()` in `watcher-agent.ts`
- Call `runWatcherLLM(config.runtime, objective, trigger, signal)` instead of `config.runAgent()`

### Modify `packages/infra/harness-daemon/src/harness/harness.ts`
- **Delete** `runWatcherAgent()` method (~170 lines, 2932-3102)
- **Delete** or simplify `validateAsyncAgentSchemas()` — remove watcher check, keep planner check if desired
- **Update** watcher hook registration (around line 3610) to construct `WatcherRuntime`:
  - Create ContextWindow (move from `runWatcherAgent` lines 3006-3017 to here — create once per session)
  - Build `WatcherRuntime` from existing harness infrastructure
  - Pass to `createWatcherControlHooks({ ..., runtime })`
- **Remove imports**: `getWatcherSchemaJsonForActions`, `parseAndValidateOutput` (watcher usage), `WatcherActionOutput` from shared

### Update `packages/infra/decision-watcher/package.json`
- Add: `"context": "workspace:*"`, `"work": "workspace:*"`, `"tools": "workspace:*"` (for ContextWindow, createWorkItem, ToolRegistry types)

### Verification
- `npx tsc --noEmit` across all modified packages
- `bun test packages/infra/decision-watcher/`
- `bun test packages/infra/harness-daemon/`
- Integration: start async session, verify watcher fires, makes LLM calls, returns decisions

---

## Phase 4: Final Cleanup

1. Verify no package imports watcher schemas from `shared` (grep for moved symbols)
2. Delete `packages/core/shared/src/structured_output.watcher.test.ts` (moved in Phase 2)
3. Search for any remaining `watcher_action` string literals in agent/shared/harness that should be gone
4. Update MEMORY.md with new architecture

---

## Dependency Graph (After)

```
shared (watcher_contract.ts enums only, no schemas)
  ↓
agent (generic Agent, parseOutput/schemaReminder hooks, zero watcher knowledge)
  ↓
decision-watcher (ALL watcher: schemas, parsing, Agent creation, LLM calls, hook handlers)
  ↓
harness-daemon (provides LLMAdapter/ToolRegistry/ContextWindow, registers hooks, fires events)
```

No circular dependencies. `agent` never imports from `decision-watcher`.

## Files Modified (summary)

| File | Action |
|------|--------|
| `agent/src/types.ts` | Add `parseOutput`, `schemaReminder` to AgentConfig |
| `agent/src/agent.ts` | Remove ~170 lines watcher+planner special cases, wire hooks |
| `shared/src/output_schemas.ts` | Remove all watcher schemas (~280 lines) |
| `shared/src/structured_output.ts` | Remove watcher lenient parser (~120 lines) |
| `shared/src/index.ts` | Remove watcher schema exports |
| `decision-watcher/src/output-schemas.ts` | **NEW** — all watcher schemas + parser + builder |
| `decision-watcher/src/output-schemas.test.ts` | **NEW** — ported from shared |
| `decision-watcher/src/watcher-agent.ts` | Replace `runAgent` with `WatcherRuntime`, add `runWatcherLLM` |
| `decision-watcher/package.json` | Add context, work, tools deps |
| `harness-daemon/harness.ts` | Delete `runWatcherAgent` (~170 lines), simplify registration |
| `protocol/src/protocol/schemas.ts` | Delete unused `WatcherOutputSchema` |
