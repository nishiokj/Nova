# Per-Agent-Type Model Configuration

## Summary

Each agent type (`standard`, `explorer`, `coding`) has independent model selection. `standard` is the base—if not set, nothing runs. `explorer` and `coding` fall back to `standard` if not explicitly configured.

## Scope

### Delete (Dead Code)

**Orchestrator types:**
- `packages/orchestrator/src/orchestrator.ts`: Remove `AgentClass` type (line 139) and `ModelOverrideConfig` interface (lines 145-152). Unused scaffolding.

**Routing agent (no longer used):**
- `packages/harness-daemon/src/harness/config_loader.ts:991` - routing config
- `packages/launcher/default-config.ts:19` - routing config
- `packages/agent/src/prompts.ts:438` - ROUTING_PROMPT mapping
- `packages/agent/src/prompts.ts:9-30` - ROUTING_PROMPT constant
- `packages/agent/src/agent-registry.ts:9` - routing description
- `packages/shared/src/output_schemas.ts:162` - RoutingOutputSchema export
- `packages/shared/src/output_schemas.ts` - RoutingOutputSchema definition
- Dashboard color mappings (routing entries in ExecutionFlow, ExecutionTimeline, LLMCallList, TurnRow)

### Consolidate `complex` + `coding-agent` → `coding`

Merge `complex` and `coding-agent` into single `coding` agent type:

**Rename `complex` → `coding`:**
- `packages/harness-daemon/src/harness/config_loader.ts:1016` - agent config key
- `packages/agent/src/prompts.ts:443` - prompt mapping key
- `packages/harness-daemon/src/harness/config_types.ts:63` - doc comment
- `packages/agent/src/types.ts:9` - doc comment

**Delete `coding-agent` (consolidated into `coding`):**
- `packages/agent/src/agent-registry.ts:13` - tool description (merge into `coding`)
- `packages/agent/src/prompts.ts:444` - mapping entry
- `packages/launcher/default-config.ts:88,93` - config and tool list entries

**Keep `coding` config from `complex`** (higher limits), **use CODING_AGENT_PROMPT** for better prompt.

**Note:** The `Tier = 'simple' | 'standard' | 'complex'` type and `ComplexityLevel` type remain unchanged—these are request complexity classifications, not agent types. The word "complex" in these contexts is unrelated to the `complex` agent type being renamed.

### Modify

**1. Session Store** (`packages/harness-daemon/src/harness/session_store.ts`)

Replace single `modelOverride` with a map:

```typescript
// Before
private modelOverride: ModelOverride | null = null;

// After
private modelSelections: Map<string, ModelOverride> = new Map();

setModelSelection(agentType: string, selection: ModelOverride | null): void {
  if (selection === null) {
    this.modelSelections.delete(agentType);
  } else {
    this.modelSelections.set(agentType, selection);
  }
}

getModelSelection(agentType: string): ModelOverride | null {
  return this.modelSelections.get(agentType)
    ?? (agentType !== 'standard' ? this.modelSelections.get('standard') : null)
    ?? null;
}

getAllModelSelections(): Map<string, ModelOverride> {
  return new Map(this.modelSelections);
}

clearModelSelections(): void {
  this.modelSelections.clear();
}
```

Update `close()` to clear the map instead of single field.

**2. Orchestrator** (`packages/orchestrator/src/orchestrator.ts`)

Constructor change:
```typescript
// Before
modelOverride?: ModelOverride

// After
getModelSelection?: (agentType: string) => ModelOverride | null
```

In `createAgent(agentType: string)`:
```typescript
// Before
if (this.modelOverride) { ... }

// After
const modelSelection = this.getModelSelection?.(agentType);
if (modelSelection) { ... }
```

Same pattern in `resolveCompactionLlmConfig`.

**3. Harness** (`packages/harness-daemon/src/harness/harness.ts`)

Update `setSessionSelectedModel` signature:
```typescript
// Before
setSessionSelectedModel(sessionKey: string, override: ModelOverride | null): void

// After
setSessionSelectedModel(sessionKey: string, agentType: string, selection: ModelOverride | null): void
```

When creating orchestrator, pass a closure:
```typescript
const getModelSelection = (agentType: string) => store.getModelSelection(agentType);
```

**4. Bridge Gateway** (`packages/harness-daemon/src/harness/bridge_gateway.ts`)

Extend `set_model` command:
```typescript
// Request data adds optional field
{ provider, model, reasoning?, agentType?: string }  // agentType defaults to 'standard'

// Response/event includes agentType
{ type: 'model_changed', data: { agentType, provider, model, reasoning } }
```

Extend `get_model` to return all selections:
```typescript
// Response
{
  success: true,
  selections: { standard: {...}, explorer: {...}, coding: {...} }
}
```

Persistence keys:
- `user_prefs:model:standard`
- `user_prefs:model:explorer`
- `user_prefs:model:coding`

**5. TUI Store** (`packages/tui/store.ts`)

Replace individual model fields with a map:
```typescript
// Before
private selectedModel: string | null = null;
private selectedProvider: string | null = null;
private selectedReasoningLevel: string | null = null;

// After
private modelSelections: Map<string, { model: string; provider: string; reasoning: string | null }> = new Map();
private modelsActiveTab: 'standard' | 'explorer' | 'coding' = 'standard';
```

Methods:
```typescript
setModelSelection(agentType: string, selection: { model: string; provider: string; reasoning: string | null } | null): void
getModelSelection(agentType: string): { model: string; provider: string; reasoning: string | null } | null
setModelsActiveTab(tab: 'standard' | 'explorer' | 'coding'): void
getModelsActiveTab(): 'standard' | 'explorer' | 'coding'
```

Snapshot includes:
```typescript
modelSelections: Map<string, { model: string; provider: string; reasoning: string | null }>;
modelsActiveTab: 'standard' | 'explorer' | 'coding';
```

**6. TUI Models View** (`packages/tui/index.tsx`)

Layout:
```
╭─ Model Selection ─────────────────────────────────────╮
│ [standard]  explorer  coding                          │
├───────────────────────────────────────────────────────┤
│ ▸ claude-sonnet-4-20250514 (Anthropic)               │
│   claude-opus-4-5-20251101 (Anthropic)               │
│   gpt-4o (OpenAI)                                     │
├───────────────────────────────────────────────────────┤
│ ←/→: switch tab  ↑/↓: select  Enter: confirm  d: clear│
╰───────────────────────────────────────────────────────╯
```

For non-standard tabs, if no selection, show indicator:
```
│ (using standard: claude-sonnet-4-20250514)            │
```

Keybindings:
- `←`/`→` or `Tab`/`Shift+Tab`: Switch between tabs
- `↑`/`↓`: Navigate model list
- `Enter`: Confirm selection for current tab
- `d` or `Backspace`: Clear selection for current tab (revert to standard fallback)
- `Esc`: Exit models view

**7. TUI Types** (`packages/tui/types.ts`)

Add `agentType` to model-related event types if needed for `model_changed` event handling.

## Fallback Logic

```
getModelSelection(agentType):
  1. If modelSelections.has(agentType) → return it
  2. If agentType !== 'standard' && modelSelections.has('standard') → return standard
  3. Return null (agent cannot run without model)
```

## Validation

If `getModelSelection('standard')` returns null when any agent tries to run:
- Orchestrator should emit error event
- TUI should prompt user to select a model via `/models`

## Files Changed

| File | Change |
|------|--------|
| `packages/orchestrator/src/orchestrator.ts` | Delete `AgentClass`, `ModelOverrideConfig`; change constructor to accept `getModelSelection` closure |
| `packages/harness-daemon/src/harness/session_store.ts` | Replace `modelOverride` field with `modelSelections` map |
| `packages/harness-daemon/src/harness/harness.ts` | Update `setSessionSelectedModel` signature; pass closure to orchestrator |
| `packages/harness-daemon/src/harness/bridge_gateway.ts` | Add `agentType` to `set_model`/`get_model` commands; update persistence keys |
| `packages/harness-daemon/src/harness/config_loader.ts` | Delete routing config; rename complex → coding |
| `packages/tui/store.ts` | Replace model fields with `modelSelections` map; add `modelsActiveTab` |
| `packages/tui/index.tsx` | Tabbed models UI with left/right navigation |
| `packages/tui/types.ts` | Add `agentType` to model event types |
| `packages/agent/src/agent-registry.ts` | Delete routing description; delete coding-agent; add coding description |
| `packages/agent/src/prompts.ts` | Delete ROUTING_PROMPT; delete routing/coding-agent mappings; rename complex → coding with CODING_AGENT_PROMPT |
| `packages/launcher/default-config.ts` | Delete routing config; delete coding-agent config; rename complex → coding |
| `packages/shared/src/output_schemas.ts` | Delete RoutingOutputSchema |
| `packages/harness-daemon/src/harness/config_types.ts` | Update doc comment (agent types list) |
| `packages/agent/src/types.ts` | Update doc comment (agent types list) |
| `packages/dashboard*/` | Remove routing color mappings (4 files) |

## Not In Scope

- Per-agent reasoning level cycling (use existing pattern within each tab)
- Model validation against provider availability (existing behavior)
- Agent registry model defaults (agents define tools/prompts, not models)
