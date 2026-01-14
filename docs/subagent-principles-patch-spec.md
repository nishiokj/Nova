# Subagent Principles: Minimum Patch Spec

## Core Principles (for system prompts, not code)

1. **Subagents are tools with cost** - Already reflected in `costHint: 'high'`
2. **Uncertainty reduction per token** - Memo for explorer system prompt
3. **Overshoot by 20%** - Heuristic for explorer gathering

---

## Patch 1: Uncertainty Categories on Artifacts

**File:** `packages/types/src/context.ts`

Add uncertainty category to `ArtifactItem`:

```typescript
// Add to ArtifactKind or as separate field
export type UncertaintyCategory =
  | 'structural'    // What exists? (entities, files, signatures)
  | 'relational'    // What connects? (dependencies, call graphs, imports)
  | 'behavioral'    // What happens? (mutations, side effects, control flow)
  | 'contractual';  // What's promised? (interfaces, invariants, preconditions)

export interface ArtifactItem {
  // ... existing fields ...

  // NEW: Which uncertainty does this artifact reduce?
  reduces: UncertaintyCategory;
}
```

**Rationale:** Each artifact explicitly declares what type of uncertainty it reduces. Explorer knows what categories to gather. Main executor knows what's missing.

**Mapping existing kinds to categories:**
- `structural`: function, class, interface, constant, summary
- `relational`: import, export, calls[]
- `behavioral`: modifies[], pattern (control flow patterns)
- `contractual`: pattern (invariant patterns), insight (gotchas = hidden contracts)

---

## Patch 2: Scalpel Reads (Line Range Support)

**File:** `packages/types/src/tools.ts`

Extend `ReadArgs`:

```typescript
export interface ReadArgs {
  path: string;
  encoding?: BufferEncoding;
  maxBytes?: number;

  // NEW: Line-based partial reads
  startLine?: number;  // 1-indexed, inclusive
  endLine?: number;    // 1-indexed, inclusive
}
```

**File:** `packages/tools/src/builtins/read.ts`

Add line-range logic after full file read:

```typescript
// After reading content...
if (args.startLine !== undefined || args.endLine !== undefined) {
  const lines = content.split('\n');
  const start = (args.startLine ?? 1) - 1;  // Convert to 0-indexed
  const end = args.endLine ?? lines.length;

  const slice = lines.slice(start, end);
  content = slice.join('\n');

  // Include context header
  const header = `// Lines ${start + 1}-${Math.min(end, lines.length)} of ${lines.length} total\n`;
  content = header + content;
}
```

**Rationale:** If executor already has file artifacts (function signatures, line numbers), it can do surgical reads instead of full file ingestion. TCP-like incremental reads.

---

## Patch 3: Subagent Returns Artifacts + Response

**File:** `packages/types/src/session.ts` (or create new)

Extend `AgentResult` to bundle artifacts:

```typescript
export interface AgentResult {
  // ... existing fields (response, metrics, etc.) ...

  // NEW: Explicit artifact bundle from subagent
  artifacts?: ArtifactItem[];
}
```

**File:** `packages/agent/src/agent.ts`

In `finalizeResult()` (or equivalent), bundle artifacts:

```typescript
// Before returning AgentResult
const result: AgentResult = {
  response: this.generateResponse(),
  metrics: this.gatherMetrics(),

  // NEW: Include discovered artifacts
  artifacts: this.localContext.getArtifacts(),
};
```

**File:** `packages/agent/src/agent.ts` - `mergeSubAgentResults()`

Update merge to use explicit artifacts field:

```typescript
// In mergeSubAgentResults()
const subArtifacts = subResult.artifacts ?? subResult.localContext?.getArtifacts() ?? [];

for (const artifact of subArtifacts) {
  // ... existing dedup logic ...
  parentLocalContext.addArtifact(artifact);
}
```

**Rationale:** Subagent explicitly returns what it found. No implicit context digging. Clear contract.

---

## Patch 4: Explorer Uncertainty Targets

**File:** `config/output_schemas.json` - explorer schema

Update artifact schema to require `reduces` field:

```json
"artifacts": {
  "type": "array",
  "items": {
    "properties": {
      "sourcePath": { "type": "string" },
      "line": { "type": ["integer", "null"] },
      "kind": { "enum": ["function", "class", "interface", "import", "export", "constant", "pattern", "summary"] },
      "name": { "type": "string" },
      "signature": { "type": ["string", "null"] },
      "description": { "type": "string" },
      "relevance": { "type": "number" },
      "reduces": { "enum": ["structural", "relational", "behavioral", "contractual"] }
    },
    "required": ["sourcePath", "kind", "name", "description", "relevance", "reduces"]
  }
}
```

**File:** `config/harness_config.json` - explorer agent

Add uncertainty coverage targets to explorer budget:

```json
"explorer": {
  "budget": {
    "max_iterations": 3,
    "max_tool_calls": 40,
    "uncertainty_targets": {
      "structural": 0.8,
      "relational": 0.8,
      "behavioral": 0.6,
      "contractual": 0.5
    },
    "overshoot_factor": 1.2
  }
}
```

**Rationale:** Explorer knows exactly what uncertainty categories to reduce. 20% overshoot built into config.

---

## Patch 5: Explorer System Prompt Update

**File:** `packages/agent/src/prompts.ts` (or wherever explorer prompt lives)

Add to explorer system prompt:

```markdown
## Uncertainty Reduction

Your goal is to reduce uncertainty for the calling agent. There are four categories:

1. **Structural** - What entities exist? Files, functions, classes, interfaces.
2. **Relational** - What connects? Dependencies, imports, call graphs.
3. **Behavioral** - What happens? Mutations, side effects, control flow.
4. **Contractual** - What's promised? Interfaces, invariants, preconditions, gotchas.

For each artifact you discover, explicitly categorize which uncertainty it reduces.

**Overshoot by 20%**: Better to return slightly more context than required. The catastrophic failure mode is the calling agent having to re-explore because you returned insufficient information.

Focus on high uncertainty-reduction-per-token. A mental model of the system is more valuable than a list of file paths.
```

---

## Summary: Files Changed

| File | Change |
|------|--------|
| `packages/types/src/context.ts` | Add `UncertaintyCategory` type, `reduces` field to `ArtifactItem` |
| `packages/types/src/tools.ts` | Add `startLine`, `endLine` to `ReadArgs` |
| `packages/tools/src/builtins/read.ts` | Implement line-range slicing (~15 lines) |
| `packages/types/src/session.ts` | Add `artifacts?: ArtifactItem[]` to `AgentResult` |
| `packages/agent/src/agent.ts` | Bundle artifacts in result, update merge logic |
| `config/output_schemas.json` | Add `reduces` to explorer artifact schema |
| `config/harness_config.json` | Add `uncertainty_targets`, `overshoot_factor` |
| `packages/agent/src/prompts.ts` | Add uncertainty reduction guidance to explorer prompt |

**Estimated net new code:** ~50-80 lines across 8 files.

---

## What This Does NOT Include

- Complex verification/claims model (rejected as too brittle)
- Confidence scores on artifacts (can add later if needed)
- Automatic re-exploration triggers (keep manual for now)
- Work queue artifact passing (current merge is sufficient)
- Uncertainty reduction metrics/telemetry (future enhancement)

---

## Implementation Order

1. **Types first** - Add `UncertaintyCategory`, update `ArtifactItem`, `ReadArgs`, `AgentResult`
2. **Read tool** - Add line-range support
3. **Agent result bundling** - Update finalize + merge
4. **Config/schemas** - Update explorer schema and config
5. **Prompts** - Add uncertainty guidance to explorer

Each patch is independently valuable and can be tested in isolation.
