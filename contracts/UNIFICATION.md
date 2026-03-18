# Contract Verification + Semantic Compiler Unification

## What changed

The contract system previously had two directions: **intent-derived** contracts from a domain interview, and **implementation-derived** contracts mechanically extracted from the structural graph. The extraction path produced ~800 noise items like "X assumes param conforms to Y" — wrong direction. Contracts should come from domain knowledge, not code structure.

This change deletes the extraction path and replaces it with a compilation bridge to the semantic compiler. Contracts now flow:

```
interview seeds contracts → compile to verification plans → run → verdict → update status
                                      ↑
               entity changes → mark stale → re-compile
```

## Deleted

| File | Reason |
|---|---|
| `entity-graph/src/contracts/extraction.ts` | Code-derived contract extraction — the wrong direction |

## Created

| File | Purpose |
|---|---|
| `entity-graph/src/contracts/compilation.ts` | Bridge between contract storage (Postgres) and the semantic compiler |

Two functions:
- **`compileContracts(sql, sourceRoot, options?)`** — loads unverified/stale contracts, builds a `CompileRequest` with contract statements as `InvariantInput[]`, calls `compileVerificationProgram()`, writes verification plans back to each contract row
- **`recordVerdicts(sql, verdicts)`** — maps `InvariantVerdict[]` back to contract statuses: pass→verified, fail→violated, error/skipped→no status change

## Modified

### Contract types (`contracts/types.ts`)

`ContractSource` changed from `'intent' | 'implementation'` to `'interview' | 'compiled' | 'incident' | 'event'`.

Six new fields on `Contract`:

| Field | Type | Purpose |
|---|---|---|
| `verificationPlanJson` | `string \| null` | Serialized `VerificationPlan` from semantic compiler |
| `verdictRule` | `string \| null` | Rule for evaluating pass/fail |
| `refinedIntent` | `string \| null` | Compiler's refined interpretation of the contract statement |
| `compileStatus` | `'compiled' \| 'needs_user_answer' \| 'failed' \| null` | Compilation outcome |
| `lastVerdict` | `'pass' \| 'fail' \| 'error' \| 'skipped' \| null` | Most recent verification result |
| `lastVerdictAt` | `string \| null` | Timestamp of last verdict |

### Schema (`schema.ts`)

Appended 6 idempotent `ALTER TABLE entity_graph.contracts ADD COLUMN IF NOT EXISTS` statements for the new fields.

### Queries (`contracts/queries.ts`)

- `ContractRow` and `rowToContract()` extended with the 6 new columns
- `upsertContract()` persists new fields on insert and update
- New `updateContractCompilation()` — writes compilation results without rebuilding entity links
- `contractSummary()` counts by new source values (`interview`, `compiled`, `incident`, `event`) instead of `intent`/`implementation`

### Module (`contracts/module.ts`)

Two new methods on `ContractModule`:
- `compile(options?)` → delegates to `compileContracts()`
- `recordVerdicts(verdicts)` → delegates to `recordVerdicts()`

### Interview (`contracts/interview.ts`)

- `source: 'intent'` → `source: 'interview'` on all seeded contracts
- Seeded contract objects now include null values for the 6 new compilation fields

### Barrel exports (`index.ts`)

- Removed: `extractContracts`, `persistExtracted`, `ExtractedContract`
- Added: `compileContracts`, `recordVerdicts`, `CompileContractsOptions`, `CompileContractsSummary`, `updateContractCompilation`

### Entity-graph CLI (`cli.ts`)

- Removed: `extract` and `assumptions` subcommands
- Added: `compile` subcommand — calls `contractModule.compile()`
- Updated usage text

### Entity-graph package.json

Added `"semantic-compiler": "workspace:*"` to dependencies.

### Metarepo types (`metarepo/src/types.ts`)

- Removed: `ContractExtractRequest`, `ContractExtractionResult`, `ExtractedContract` re-export
- Added: `ContractCompileRequest`, `ContractCompileResult`, `CompileContractsSummary` re-export
- `MetarepoApi.contractExtract` → `MetarepoApi.contractCompile`

### Metarepo service (`metarepo/src/service.ts`)

Replaced `contractExtract` (which used `executeGraphWorkflow` to spin up an ephemeral graph DB) with `contractCompile` — reads contracts directly from the app DB, no ephemeral graph needed.

### Metarepo routes (`metarepo/src/analysis_routes.ts`)

`contract.extract` RPC case → `contract.compile`

### Metarepo client (`metarepo/src/client.ts`)

`contractExtract()` → `contractCompile()`

### Metarepo CLI (`metarepo/src/cli.ts`)

`contract extract [filepath]` → `contract compile [--contract-ids id1,id2]`

### Contract-init skill (`.agents/` and `.agent/skills/`)

Step 3 changed from "Extract implementation-derived contracts" to "Compile contracts into verification plans". Next-steps updated accordingly.

## What stayed unchanged

- **`staleness.ts`** — marks contracts stale on entity change (correct use of entity graph)
- **`interview.ts`** — seeds contracts from domain interview (right direction, only source value changed)
- **`hooks.ts`** — `postToolUse` calls `markStaleContracts` (unchanged)
- **Semantic compiler** (all files) — consumed as a library, no changes
- **`module.ts`** domain YAML parsing — stays, new methods added alongside
