# First-Class Outcome Mapper & Grading Pipeline

## Context

The AgentLab experiment runner (`run_cli.ts`) is a lossy bottleneck. The harness emits a rich event stream (tool calls, LLM details, files modified, reasoning, status transitions) but the runner only captures 6 numbers. The experiment builder even declares metrics like `FILES_MODIFIED` and `DIFF_LINES` and artifacts like `**/*.patch` that the runner never produces.

Worse, the token metrics are silently broken — the runner reads `data.prompt_tokens` (snake_case) but the bridge wire format is camelCase (`data.promptTokens`). Every trial reports 0 tokens.

The fix is not "add grading" — it's a pipeline redesign with clear separation:

**Execute → Map → Grade → Aggregate**

The runner becomes a pure state machine + collector. An OutcomeMapper translates raw emissions to benchmark-specific shapes. A Grader scores those shapes. The SDK's existing analysis handles aggregation.

---

## Bugs to Fix (Prerequisites)

### Bug 1: Token metrics always zero
**File**: `scripts/agentlab/run_cli.ts:339-341`
- Reads `data.prompt_tokens` / `data.completion_tokens` / `data.tool_calls_count` (snake_case)
- Bridge wire format is camelCase: `data.promptTokens` / `data.completionTokens` / `data.toolCallsCount`
- **Fix**: Read camelCase field names matching the `LlmCallData` type in `harness-client/src/types.ts:479-488`

### Bug 2: `files_modified` events silently dropped
Three locations need `files_modified` added:
1. `packages/infra/harness-client/src/types.ts:360-372` — `BridgeEventType` union lacks `files_modified`
2. `packages/infra/harness-client/src/index.ts:28-41` — `VALID_EVENT_TYPES` set lacks `files_modified`
3. `packages/apps/tui/bridge_client.ts:13-26` — `VALID_EVENT_TYPES` set lacks `files_modified`

The daemon-side (`harness-daemon/src/harness/types.ts:80`) already includes it. The translator emits it. But client-side validation drops it before it reaches handlers.

### Bug 3: `tools_used` from response dropped
**File**: `scripts/agentlab/run_cli.ts:382-383`
- Reads `data.tools_used.length` but never stores the array itself

---

## New Files

### 1. `scripts/agentlab/types.ts` — Pipeline type vocabulary (~120 lines)

Defines the data shapes for each pipeline stage:

```
TrialEmissions    — what the runner collects (universal, benchmark-agnostic)
OutcomeMapper     — interface: (emissions, task) → MappedOutcome
Grader            — interface: (outcome, task) → GradeResult
```

**TrialEmissions** is the key type — structured capture of everything the bridge emits:
- `llmCalls: LLMCallRecord[]` — per-call: provider, model, agentType, tokens (prompt/completion/cached), duration, toolCallsCount, toolNames
- `toolCalls: ToolCallRecord[]` — per-call: toolName, success, durationMs, args (from `progress` events with `kind === 'tool'`)
- `filesModified: string[]` — from `files_modified` events
- `streamContent: string` — concatenated agent output from `stream` events
- `responseToolsUsed: string[]` — from `response` event's `tools_used`
- `responseMetadata: Record<string, unknown>` — from `response` event's `metadata`
- `workspaceDiff: string` — `git diff` captured from workspace after trial
- `eventLog: CapturedEvent[]` — raw timestamped event log for replay/debug
- `metrics` — derived aggregates (totals for tokens, calls, diff line counts)

**OutcomeMapper** interface:
- `name: string` — identifier (e.g. `'swebench'`, `'qa'`)
- `map(emissions, task) → Record<string, unknown>` — sync, pure data extraction

**Grader** interface:
- `name: string` — identifier
- `grade(outcome, task) → Promise<GradeResult>` — async (may invoke subprocesses)

**GradeResult**: `{ score: number, label: string, rationale?: string, details?: Record<string, unknown> }`

### 2. `scripts/agentlab/mappers.ts` — OutcomeMapper registry + built-ins (~80 lines)

Registry with `registerMapper()` / `getMapper()`. Ships with:

- **`swebench`** — extracts `{ instance_id, model_name_or_path, model_patch }` from emissions. `instance_id` from `task.input.instance_id`, `model_patch` from `emissions.workspaceDiff`.
- **`qa`** — extracts `{ answer }` from `emissions.streamContent`
- **`passthrough`** — returns `{ success, metrics }` as-is for benchmarks that only need numeric metrics

### 3. `scripts/agentlab/graders.ts` — Grader registry + built-ins (~100 lines)

Registry with `registerGrader()` / `getGrader()`. Ships with:

- **`swebench`** — shells out to `python -m swebench.harness.run_evaluation` with the prediction patch. Parses eval report. Returns `{ score: 0|1, label: 'resolved'|'unresolved'|'eval_error'|'no_patch' }`.
- **`exact_match`** — string equality between `outcome.answer` and `task.expected`
- **`contains`** — checks if answer contains expected substring
- **`patch_non_empty`** — binary: did the agent produce any code changes?

### 4. `scripts/agentlab/grade_cli.ts` — Post-run grading CLI (~180 lines)

Walks a completed run directory, applies mapper + grader to each trial:

```
bun scripts/agentlab/grade_cli.ts \
  --run-dir .lab/runs/run_20260212_193110 \
  --mapper swebench \
  --grader swebench
```

Per trial:
1. Read the task payload artifact (`task.json` / runner task input file)
2. Read `out/trial_emissions.json` (raw emissions)
3. `mapper.map(emissions, task)` → `MappedOutcome`
4. `grader.grade(outcome, task)` → `GradeResult`
5. Write `out/grade_result.json`
6. Write `out/mapped_outcome.json`

After all trials: write `analysis/grade_summary.json` with aggregate stats (resolve_rate, by_label breakdown).

---

## Modified Files

### 5. `packages/infra/harness-client/src/types.ts` — Add `files_modified` to BridgeEventType

Add `| 'files_modified'` to the `BridgeEventType` union at line 372. Add `FilesModifiedData` interface and entry in `BridgeEventDataMap`.

### 6. `packages/infra/harness-client/src/index.ts` — Add `files_modified` to VALID_EVENT_TYPES

Add `'files_modified'` to the Set at line 28-41.

### 7. `packages/apps/tui/bridge_client.ts` — Add `files_modified` to VALID_EVENT_TYPES

Add `'files_modified'` to the Set at line 13-26.

### 8. `packages/apps/tui/types.ts` — Add `files_modified` to BridgeEventType

Add `| "files_modified"` to the union at line 56-68.

### 9. `scripts/agentlab/run_cli.ts` — Become a full collector (~250 lines changed)

Major changes:
- **Fix camelCase bug**: Read `data.promptTokens` not `data.prompt_tokens` (and same for completionTokens, toolCallsCount)
- **Refactor `runRequest`**: Replace scattered counters with a `TrialEmissions` collector. The `onEvent` handler captures ALL event types:
  - `llm_call` → build full `LLMCallRecord`
  - `progress` with `kind === 'tool'` → build `ToolCallRecord`
  - `files_modified` → append paths
  - `stream` → concatenate content
  - `response` → capture `tools_used` and `metadata`
  - All events → append to `eventLog`
- **Capture workspace diff**: After harness completes, run `git diff` (and `git diff <base_commit>..HEAD` for committed changes) in the workspace directory
- **Write `trial_emissions.json`**: Full structured emissions as a trial artifact
- **Write `model.patch`**: The workspace diff as a standalone artifact file
- **Enriched `result.json`**: Populate the `metrics` object with real data (filesModifiedCount, diffLinesAdded, diffLinesDeleted, cachedTokens, uniqueToolsUsed), populate `artifacts` array, use `ext` for grading hooks

### 10. `scripts/agentlab/run_swebench_lite_experiment_sdk.mjs` — Wire new metrics

Update the experiment builder to declare metrics that the runner now actually produces:
- `Metric.fromOutput('files_modified_count', '/metrics/filesModifiedCount')`
- `Metric.fromOutput('diff_lines_added', '/metrics/diffLinesAdded')`
- `Metric.fromOutput('cached_tokens', '/metrics/cachedTokens')`
- Update `.artifacts()` to collect `['trial_emissions.json', 'model.patch', 'grade_result.json', 'mapped_outcome.json']`

---

## Implementation Order

| Step | File(s) | What |
|------|---------|------|
| 1 | `harness-client/src/types.ts`, `harness-client/src/index.ts`, `tui/bridge_client.ts`, `tui/types.ts` | Fix `files_modified` event plumbing (bug 2) |
| 2 | `scripts/agentlab/types.ts` | Create pipeline types |
| 3 | `scripts/agentlab/run_cli.ts` | Fix camelCase bug (bug 1), refactor to full collector, write emissions + patch |
| 4 | `scripts/agentlab/mappers.ts` | OutcomeMapper interface + built-ins |
| 5 | `scripts/agentlab/graders.ts` | Grader interface + built-ins |
| 6 | `scripts/agentlab/grade_cli.ts` | Post-run grading CLI |
| 7 | `scripts/agentlab/run_swebench_lite_experiment_sdk.mjs` | Wire new metrics/artifacts |

Steps 1-2 have no dependencies and can be parallel. Step 3 depends on 1+2. Steps 4-5 depend on 2. Step 6 depends on 4+5. Step 7 depends on 3.

---

## Key Design Decisions

**Why TrialEmissions is a flat struct, not generic**: The runner always collects the same things. The bridge emits a fixed set of event types. Making this generic adds abstraction with zero benefit.

**Why mappers are sync and graders are async**: Mappers do pure data extraction — read fields, parse diffs. No I/O. Graders may invoke subprocesses (SWE-bench eval harness), make HTTP calls (LLM judge), or hit the filesystem.

**Why grading is a separate CLI, not part of the runner**: The runner executes in a container with the agent. The grader may need a different environment (Python for SWE-bench, network for LLM judge). Separation also enables re-grading without re-running trials.

**Why `trial_emissions.json` is separate from `result.json`**: The runner expects `result.json` (`agent_result_v1`) in a fixed schema. Emissions are our internal rich format. Keeping them separate means the contract is maintained while we have arbitrarily rich data for mappers.

**Why workspace diff captures both committed and uncommitted changes**: The agent may or may not commit. `git diff` captures unstaged changes. `git diff <base_commit>..HEAD` captures committed changes. The runner captures both concatenated.

---

## Verification

1. **Token bug fix**: Run a trial, verify `result.json` has non-zero `tokens_in`/`tokens_out`
2. **Full collection**: Run a trial, verify `out/trial_emissions.json` contains populated `llmCalls`, `toolCalls`, `filesModified` arrays
3. **Workspace diff**: Run a trial against a SWE-bench task, verify `out/model.patch` contains the agent's diff
4. **Mapper**: Run `grade_cli.ts --mapper swebench` on a completed run, verify `mapped_outcome.json` has correct `instance_id` and `model_patch`
5. **Grader**: Run `grade_cli.ts --grader patch_non_empty` on a completed run, verify `grade_result.json` scores correctly
6. **SWE-bench grader** (requires `swebench` Python package): Run full `--grader swebench` and verify resolved/unresolved classification matches manual inspection
