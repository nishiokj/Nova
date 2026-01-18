# Experiment Benchmark Spec

## Goal
Enable fast experimentation across prompts, models, and context-engineering strategies with minimal new code. Start with a single sanity run (v1), then expand to parallel runs, session forking, and dashboard support (v2).

## Principles
- Single variable per run.
- Same initial state for all runs (fork session from a base).
- Fixed question set across runs.
- Minimal new code: prefer existing harness + GraphD event stream.
- Provenance is mandatory (repo state, config, model/prompt variant).

---

## V1: Minimum Sanity Run (Single Run, Default Settings)

### Scope
- Run one experiment end-to-end using default config and a fixed prompt.
- No variance controls needed beyond default settings.
- Validate that GraphD contains the run data (events + summary metrics).

### Flow
1) Start harness daemon.
2) Connect via bus (`BusClient`).
3) `init` session.
4) `send_text` with a known prompt.
5) Stream `run:<requestId>` until completion.
6) Validate GraphD has the run (events persisted).

### Required Output
- A single JSONL record describing the run (written by the script):
  - request_id
  - session_key
  - provider/model (active)
  - prompt_id (fixed string)
  - total_llm_calls
  - total_tool_calls
  - prompt_tokens
  - completion_tokens
  - total_tokens
  - duration_ms
  - tool_names (unique list)
  - success flag
  - git_sha, branch, dirty status

### Script (v1)
- `scripts/bench/run_v1.ts` runs one default benchmark and writes JSONL output.
- Example:
  - `bun run scripts/bench/run_v1.ts --prompt \"Benchmark v1: hello\" --out bench/results.jsonl`

### Validation Criteria
- `llm_call` events exist in GraphD for the session.
- The script record matches totals derived from `llm_call` events.
- Run completes successfully without manual intervention.

### Implementation Notes
- Use existing bus protocol and events; avoid new server APIs.
- Reuse existing `llm_call` metrics and `tool_call` events.
- Keep the script minimal; if it grows, the harness is missing a necessary entry point.

---

## V2: Comparative Runs (Forking, Parallelism, Dashboarding)

### Scope
- Multi-run comparisons with controlled variable changes (model, prompt, context strategy).
- Session forking to guarantee identical initial state.
- Optional parallel runs with isolated worktrees.
- Benchmark view in dashboard (optional if data already in GraphD).

### Flow
1) Base session setup (optional seed prompt or context).
2) `session_fork` per run to clone identical context state.
3) For each run, set exactly one variable:
   - Model override (`set_model`), OR
   - Prompt variant (branch or config toggle), OR
   - Context strategy toggle (branch or config toggle).
4) `send_text` with identical question set.
5) Aggregate metrics from events (same schema as V1) + run metadata.

### Parallelism and Worktrees
- If runs mutate files, create per-run worktrees.
- Each run uses a distinct `working_dir`.
- Parallel runs without isolated worktrees are not allowed.
- For low-overhead isolation, create a branch per run and keep runs sequential.

### Compaction Divergence Testing
- Use session forking to isolate the moment of divergence.
- Trigger compaction from the same base session and compare resulting runs.

### Provenance (Required)
- git sha, branch, dirty status
- run_id, session_key, request_id
- model/provider
- prompt_variant_id
- context_strategy_id
- temperature
- config hash (optional)

### Metrics (Required)
- total_llm_calls
- total_tool_calls
- prompt_tokens
- completion_tokens
- total_tokens
- duration_ms
- tool_names (unique list)
- success flag
- completion accuracy (scored offline)

### Dashboarding
- Add a benchmark tab that reuses GraphD event data.
- Filter by run_id or metadata tags (e.g., `experiment_id`).
- Avoid new storage schema unless necessary.

### Script (v2)
- `scripts/bench/run_v2.ts` runs comparative benchmarks with session forking.
- Example:
  - `bun run scripts/bench/run_v2.ts --runs bench/runs.json --questions bench/questions.json --out bench/results.jsonl`
  - `bun run scripts/bench/run_v2.ts --runs bench/runs.json --questions bench/questions.json --model_provider openai --model gpt-4.1`

---

## Open Questions
- Do we need a formal “experiment_id” in session metadata, or can it live in the JSONL output?
- Should V2 require Git worktrees by default, or only when tools can mutate files?
- What is the minimal completion accuracy proxy for the first version?
