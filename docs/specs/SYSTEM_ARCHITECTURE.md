# AgentLab System Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  BOUNDARY 1: EXPERIMENT DEFINITION                                                       │
│                                                                                          │
│  Human Intent                                                                            │
│       │                                                                                  │
│       ▼                                                                                  │
│  ┌─────────────────────────────────┐     ┌──────────────────────────────────┐            │
│  │  ExperimentBuilder (TS SDK)     │     │  experiment.yaml                 │            │
│  │  .baseline('glm_5', bindings)   │────▶│  version: 0.5                    │            │
│  │  .addVariant('gpt_5', bindings) │     │  design.max_concurrency: 10  ◀── DEAD KNOB   │
│  │  .maxConcurrency(10)            │     │  dataset.path: tasks.jsonl       │            │
│  │  .replications(3)               │     │  runtime.agent.image: ...        │            │
│  │  .metric(...)                   │     │  variants, metrics, policy       │            │
│  └─────────────────────────────────┘     └──────────────┬───────────────────┘            │
│                                                          │                               │
└──────────────────────────────────────────────────────────┼───────────────────────────────┘
                                                           │
═══════════════════════════════════════════════════════════════════════════════════════════
                                                           │
┌──────────────────────────────────────────────────────────┼───────────────────────────────┐
│  BOUNDARY 2: CLI → RUNNER INVOCATION                     │                               │
│                                                          ▼                               │
│  $ lab run experiment.yaml --container                                                   │
│       │                                                                                  │
│       ▼                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐                │
│  │  run_experiment_with_behavior()  (lib.rs:3018)                      │                │
│  │                                                                      │                │
│  │  1. Parse YAML → JSON                                                │                │
│  │  2. Apply overrides (knobs)                                          │                │
│  │  3. Create run_dir = .lab/runs/run_{timestamp}/                      │                │
│  │  4. Write: resolved_experiment.json, manifest.json, run_control.json │                │
│  │  5. Load dataset JSONL → Vec<Task>                                   │                │
│  │  6. Resolve variants → Vec<Variant>                                  │                │
│  └───────────────────────────────┬──────────────────────────────────────┘                │
│                                  │                                                       │
└──────────────────────────────────┼───────────────────────────────────────────────────────┘
                                   │
═══════════════════════════════════════════════════════════════════════════════════════════
                                   │
┌──────────────────────────────────┼───────────────────────────────────────────────────────┐
│  BOUNDARY 3: SCHEDULE BUILDING   │                                                       │
│                                  ▼                                                       │
│  ┌──────────────────────────────────────────────────────────────┐                        │
│  │  build_trial_schedule()  (lib.rs:3952)                      │                        │
│  │                                                              │                        │
│  │  variants(2) × tasks(100) × replications(3) = 600 slots    │                        │
│  │                                                              │                        │
│  │  Policies:                                                   │                        │
│  │    VariantSequential: all V0 then all V1                    │                        │
│  │    PairedInterleaved: V0-T0, V1-T0, V0-T1, V1-T1, ...     │                        │
│  │    Randomized: Fisher-Yates with deterministic seed         │                        │
│  │                                                              │                        │
│  │  Output: Vec<TrialSlot { variant_idx, task_idx, repl_idx }> │                        │
│  └───────────────────────────────┬──────────────────────────────┘                        │
│                                  │                                                       │
│                                  ▼                                                       │
│                        resolved_schedule.json                                            │
│                        + schedule_progress.json (init: next_schedule_index = 0)          │
│                                  │                                                       │
└──────────────────────────────────┼───────────────────────────────────────────────────────┘
                                   │
═══════════════════════════════════════════════════════════════════════════════════════════
                                   │
┌──────────────────────────────────┼───────────────────────────────────────────────────────┐
│  BOUNDARY 4: TRIAL EXECUTION LOOP (THE BOTTLENECK)                                       │
│                                  │                                                       │
│                                  ▼                                                       │
│  ┌──────────────────────────────────────────────────────────────────────────────┐        │
│  │  execute_schedule_engine()  (lib.rs:2354)                                    │        │
│  │                                                                              │        │
│  │  for schedule_idx in next_schedule_index..600 {    ◀── SEQUENTIAL FOR LOOP   │        │
│  │      // ONE AT A TIME. NO CONCURRENCY. EVER.       ◀── max_concurrency: 🗑️   │        │
│  │                                                                              │        │
│  │      ┌────────────────────────────────────────────────────────┐              │        │
│  │      │  Per-Trial Prep                                        │              │        │
│  │      │  1. Create trial_dir/  (in/, out/, state/, workspace/) │              │        │
│  │      │  2. Write task.json, bindings.json, policy.json        │              │        │
│  │      │  3. Stage credentials to deps/                         │              │        │
│  │      │  4. Restore workspace from chain snapshot (if chained) │              │        │
│  │      │  5. Pre-workspace snapshot                             │              │        │
│  │      └────────────────────┬───────────────────────────────────┘              │        │
│  │                           │                                                  │        │
│  │                           ▼                                                  │        │
│  │  ════════════════ DOCKER BOUNDARY ═══════════════════════════════            │        │
│  │                                                                              │        │
│  │      ┌─ HOST ──────────────────────┐    ┌─ CONTAINER ──────────────────┐    │        │
│  │      │                             │    │                              │    │        │
│  │      │  trial_dir/in/         ─ro──┼───▶│  /agentlab/in/              │    │        │
│  │      │  trial_dir/out/        ─rw──┼───▶│  /agentlab/out/             │    │        │
│  │      │  trial_dir/state/      ─rw──┼───▶│  /agentlab/state/           │    │        │
│  │      │  trial_dir/workspace/  ─rw──┼───▶│  /agentlab/workspace/  (cwd)│    │        │
│  │      │  trial_dir/deps/       ─rw──┼───▶│  /agentlab/deps/            │    │        │
│  │      │  dataset_path/         ─ro──┼───▶│  /dataset/                  │    │        │
│  │      │                        tmpfs┼───▶│  /tmp/                      │    │        │
│  │      │                             │    │                              │    │        │
│  │      │  ENV VARS:                  │    │  AGENTLAB_TASK_PATH          │    │        │
│  │      │                             │    │  AGENTLAB_BINDINGS_PATH      │    │        │
│  │      │                             │    │  AGENTLAB_RESULT_PATH        │    │        │
│  │      │                             │    │  AGENTLAB_TRAJECTORY_PATH    │    │        │
│  │      │                             │    │  AGENTLAB_TRIAL_ID           │    │        │
│  │      │                             │    │  AGENTLAB_VARIANT_ID         │    │        │
│  │      │                             │    │  AGENTLAB_TIMEOUT_MS         │    │        │
│  │      │                             │    │  HOME=/agentlab/deps/home    │    │        │
│  │      └─────────────────────────────┘    └──────────────┬───────────────┘    │        │
│  │                                                         │                    │        │
│  │  ════════════════════════════════════════════════════════════════════════    │        │
│  │                                                         │                    │        │
│  │                                                         ▼                    │        │
│  │      ┌──────────────────────────────────────────────────────────────┐        │        │
│  │      │  AGENT INVOCATION (inside container)                         │        │        │
│  │      │                                                              │        │        │
│  │      │  rex run                                                     │        │        │
│  │      │    --input-file /agentlab/in/task.json                       │        │        │
│  │      │    --bindings-file /agentlab/in/bindings.json                │        │        │
│  │      │    --output /agentlab/out/result.json                        │        │        │
│  │      │    --events /agentlab/out/trajectory.jsonl                   │        │        │
│  │      │    --session-key trial_1                                     │        │        │
│  │      │    --working-dir /agentlab/workspace                         │        │        │
│  │      │                                                              │        │        │
│  │      │  ┌──────────────────────────────────────────────┐            │        │        │
│  │      │  │  HarnessDaemon (in-process WebSocket)        │            │        │        │
│  │      │  │       │                                      │            │        │        │
│  │      │  │       ▼                                      │            │        │        │
│  │      │  │  Agent Loop (orchestrator → LLM → tools)     │            │        │        │
│  │      │  │       │                                      │            │        │        │
│  │      │  │       ├──▶ WRITES: /agentlab/out/result.json │            │        │        │
│  │      │  │       └──▶ WRITES: /agentlab/out/trajectory  │            │        │        │
│  │      │  └──────────────────────────────────────────────┘            │        │        │
│  │      └──────────────────────────────────────────────────────────────┘        │        │
│  │                           │                                                  │        │
│  │                           ▼  (container exits)                               │        │
│  │                                                                              │        │
│  │      ┌────────────────────────────────────────────────────────────┐          │        │
│  │      │  Post-Trial Processing                                     │          │        │
│  │      │  1. Post-workspace snapshot + diff (incremental/cumulative)│          │        │
│  │      │  2. Materialize result.json to trial_dir root              │          │        │
│  │      │  3. Build evidence record → evidence_records.jsonl         │          │        │
│  │      │  4. Extract metrics, events, bindings from result          │          │        │
│  │      │  5. sink.append_trial_record()     ──▶ facts/trials.jsonl  │          │        │
│  │      │  6. sink.append_metric_rows()      ──▶ facts/metrics.jsonl │          │        │
│  │      │  7. sink.append_event_rows()       ──▶ facts/events.jsonl  │          │        │
│  │      │  8. sink.append_variant_snapshot()                         │          │        │
│  │      │  9. sink.flush()                                           │          │        │
│  │      └────────────────────┬───────────────────────────────────────┘          │        │
│  │                           │                                                  │        │
│  │                           ▼                                                  │        │
│  │      ┌────────────────────────────────────────────────────────────┐          │        │
│  │      │  Scheduling State Update                                   │          │        │
│  │      │                                                            │          │        │
│  │      │  if success: consecutive_failures[variant] = 0             │          │        │
│  │      │  if failed:  consecutive_failures[variant] += 1            │          │        │
│  │      │                                                            │          │        │
│  │      │  if consecutive_failures >= max → pruned_variants.insert() │          │        │
│  │      │                                                            │          │        │
│  │      │  schedule_progress.next_schedule_index += 1                │          │        │
│  │      │  write_schedule_progress()  ──▶ schedule_progress.json     │          │        │
│  │      └────────────────────────────────────────────────────────────┘          │        │
│  │                           │                                                  │        │
│  │  }  // next iteration of for loop                                            │        │
│  └──────────────────────────────────────────────────────────────────────────────┘        │
│                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                   │
═══════════════════════════════════════════════════════════════════════════════════════════
                                   │
┌──────────────────────────────────┼───────────────────────────────────────────────────────┐
│  BOUNDARY 7: SINK (facts/*.jsonl)│                                                       │
│                                  ▼                                                       │
│  ┌──────────────────────────────────────────────────────────────────┐                    │
│  │  RunSink trait  (sink.rs:91)                                     │                    │
│  │                                                                  │                    │
│  │  impl: JsonlRunSink                                              │                    │
│  │    BufWriter<File> per file, serde_json per row, flush after     │                    │
│  │    each trial                                                    │                    │
│  │                                                                  │                    │
│  │  ┌────────────────────┐  ┌───────────────────┐  ┌─────────────┐ │                    │
│  │  │ facts/trials.jsonl │  │ facts/metrics.jsonl│  │ facts/      │ │                    │
│  │  │ 1 row per trial    │  │ 1 row per metric  │  │ events.jsonl│ │                    │
│  │  │ outcome, metrics,  │  │ per trial (long   │  │ 1 row per   │ │                    │
│  │  │ bindings, success  │  │ format)            │  │ hook event  │ │                    │
│  │  └────────────────────┘  └───────────────────┘  └─────────────┘ │                    │
│  │                                                                  │                    │
│  │  ┌──────────────────────────┐  ┌────────────────────┐           │                    │
│  │  │ facts/variant_snapshots  │  │ facts/run_manifest │           │                    │
│  │  │ .jsonl                   │  │ .json              │           │                    │
│  │  │ 1 row per binding per    │  │ Single JSON:       │           │                    │
│  │  │ trial                    │  │ run_id, variant_ids│           │                    │
│  │  └──────────────────────────┘  └────────────────────┘           │                    │
│  └──────────────────────────────────────────────────────────────────┘                    │
│                                  │                                                       │
│                          APPEND-ONLY, IMMUTABLE                                          │
│                                  │                                                       │
└──────────────────────────────────┼───────────────────────────────────────────────────────┘
                                   │
═══════════════════════════════════════════════════════════════════════════════════════════
                                   │
┌──────────────────────────────────┼───────────────────────────────────────────────────────┐
│  BOUNDARY 8: ANALYSIS (on-demand, never during execution)                                │
│                                  │                                                       │
│                                  ▼                                                       │
│  ┌──────────────────────────────────────────────────────────────────┐                    │
│  │  $ lab views <run_id>                                            │                    │
│  │  $ lab query <run_dir> "SELECT ..."                              │                    │
│  │  $ lab trend <experiment_id>                                     │                    │
│  │                                                                  │                    │
│  │  materialize_run_duckdb()  (lab-analysis:580)                    │                    │
│  │                                                                  │                    │
│  │  facts/*.jsonl ──▶ read_json_auto() ──▶ DuckDB views            │                    │
│  │                                                                  │                    │
│  │  Core views:                     Opinionated bundles:            │                    │
│  │    trials                          AbTest:    win_loss_tie       │                    │
│  │    metrics_long                    MultiVar:  variant_ranking    │                    │
│  │    events                          ParamSweep: best_config       │                    │
│  │    variant_snapshots               Regression: pass_rate_trend   │                    │
│  │    variant_summary                                               │                    │
│  │    task_variant_matrix           View set auto-selected from:    │                    │
│  │    run_progress                    comparison + scheduling +     │                    │
│  │                                    variant_count                  │                    │
│  └──────────────────────────────────────────────────────────────────┘                    │
│                                                                                          │
│  DuckDB is a QUERY RUNTIME, not a database.                                              │
│  Materialized on-demand. Recreatable from facts JSONL at any time.                       │
│                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Boundary Details

### Boundary 1: Experiment Definition (Human → SDK → YAML)

The TypeScript SDK provides a fluent builder API that produces an `experiment.yaml` conforming to `experiment_v1_0.jsonschema`.

**Key fields:**
- `design.max_concurrency` — Exposed in SDK via `.maxConcurrency(n)`. **Not implemented in runner.** The execution engine is a sequential `for` loop.
- `design.comparison` — `paired` | `unpaired` | `none`. Drives scheduling policy and analysis view selection.
- `design.replications` — Number of times each (variant, task) pair is executed.
- `design.random_seed` — Deterministic seed for reproducible schedule shuffling.
- `runtime.agent` — Agent image, entrypoint command, environment overrides.
- `runtime.policy` — Timeout, network mode, sandbox config, resource limits.
- `metrics[]` — Metric definitions sourced from runner, events, output, or artifacts.

**Validation at build time:**
- Required fields: id, name, dataset path/suite/split/limit, agent mode, timeout > 0
- Policy coherence: paired comparison requires 2+ variants
- Retry policy: max_attempts >= 1

### Boundary 2: CLI → Runner Invocation (YAML → Rust)

| Command | Purpose |
|---------|---------|
| `lab run <exp>` | Standard run with container |
| `lab run-dev <exp>` | Dev mode: network=full, setup_command allowed |
| `lab run-experiment <exp>` | Strict: network=none, no setup |
| `lab continue --run-dir <dir>` | Resume from schedule_progress.json |
| `lab replay --run-dir <dir> --trial-id <id>` | Re-run single trial |
| `lab fork --run-dir <dir> --from-trial <id>` | Branch from checkpoint |
| `lab pause / lab resume` | Checkpoint and resume running trials |

**Orchestration flow** (`run_experiment_with_behavior`, lib.rs:3018):
1. Parse YAML + apply overrides (knobs)
2. Create `run_dir = .lab/runs/run_{YYYYMMDD_HHMMSS}/`
3. Write resolved_experiment.json, manifest.json, run_control.json
4. Load dataset JSONL → `Vec<Task>`
5. Resolve variant plan → `Vec<Variant>` + baseline_id
6. Build trial schedule
7. Initialize `JsonlRunSink`
8. Execute schedule engine (the sequential loop)
9. Validate facts against schemas
10. Write attestation.json, set status = "completed"

### Boundary 3: Schedule Building

**Input:** variant_count × task_count × replications × scheduling_policy × random_seed

**Output:** `Vec<TrialSlot { variant_idx, task_idx, repl_idx }>` written to `resolved_schedule.json`

**Three scheduling policies:**

| Policy | Order | Use Case |
|--------|-------|----------|
| VariantSequential | All V0, then all V1 | Unpaired comparison, parameter sweeps |
| PairedInterleaved | V0-T0, V1-T0, V0-T1, V1-T1 | Within-task paired comparison |
| Randomized | Fisher-Yates with LCG seed | Reduce ordering bias |

**Example:** 2 variants × 100 tasks × 3 replications = 600 slots.

### Boundary 4: Trial Execution Loop (The Bottleneck)

**`execute_schedule_engine()`** (lib.rs:2354) — Takes 20+ `&mut` parameters. Sequential `for` loop.

**Per-trial lifecycle:**

```
Prep (host)
  ├── Create trial_dir/ with subdirs (in/, out/, state/, workspace/, deps/)
  ├── Write task.json, bindings.json, policy.json to trial_dir/in/
  ├── Stage credentials to deps/
  ├── Restore workspace from chain snapshot (if chained)
  └── Pre-workspace snapshot
       │
       ▼
Docker Execution
  ├── docker run --rm with bind mounts and env vars
  ├── Agent runs inside container
  ├── Agent writes result.json + trajectory.jsonl
  └── Container exits
       │
       ▼
Post-Processing (host)
  ├── Post-workspace snapshot + diff
  ├── Materialize result.json
  ├── Build evidence record
  ├── Extract metrics, events, bindings
  ├── Sink: append to facts/*.jsonl
  └── Update scheduling state (consecutive_failures, pruned_variants, schedule_progress)
```

### Boundary 5: Docker Container Contract

**Mounts (host → container):**

| Host Path | Container Path | Mode | Purpose |
|-----------|----------------|------|---------|
| `trial_dir/in/` | `/agentlab/in/` | ro | Task input files |
| `trial_dir/out/` | `/agentlab/out/` | rw | Agent writes result + trajectory |
| `trial_dir/state/` | `/agentlab/state/` | rw | Control interface (pause/resume) |
| `trial_dir/workspace/` | `/agentlab/workspace/` | rw | Working directory (cwd) |
| `trial_dir/deps/` | `/agentlab/deps/` | rw | Staged credentials |
| `dataset_path/` | `/dataset/` | ro | Task dataset |
| tmpfs | `/tmp/` | rw | Temp files |

**Environment variables:**

| Variable | Value |
|----------|-------|
| `AGENTLAB_TASK_PATH` | `/agentlab/in/task.json` |
| `AGENTLAB_BINDINGS_PATH` | `/agentlab/in/bindings.json` |
| `AGENTLAB_DEPENDENCIES_PATH` | `/agentlab/in/dependencies.json` |
| `AGENTLAB_POLICY_PATH` | `/agentlab/in/policy.json` |
| `AGENTLAB_RESULT_PATH` | `/agentlab/out/result.json` |
| `AGENTLAB_TRAJECTORY_PATH` | `/agentlab/out/trajectory.jsonl` |
| `AGENTLAB_RUN_ID` | `run_{timestamp}` |
| `AGENTLAB_TRIAL_ID` | `trial_{N}` |
| `AGENTLAB_VARIANT_ID` | variant id string |
| `AGENTLAB_TASK_ID` | task id string |
| `AGENTLAB_TIMEOUT_MS` | timeout in milliseconds |
| `HOME` | `/agentlab/deps/home` |

**Input files (runner writes, agent reads):**

| File | Schema | Content |
|------|--------|---------|
| `task.json` | `task_v1` | Task id, prompt, expected output, benchmark-specific fields |
| `bindings.json` | — | Variant config (model_provider, model, reasoning, etc.) |
| `dependencies.json` | — | Service/file dependency declarations |
| `policy.json` | — | Timeout, network, sandbox policy |

**Output files (agent writes, runner reads):**

| File | Schema | Content |
|------|--------|---------|
| `result.json` | `agent_result_v1` | outcome, answer, metrics (latency, tokens, turns) |
| `trajectory.jsonl` | `hook_events_v1` | Per-event trace: model calls, tool calls, errors |

### Boundary 6: Agent Invocation (Inside Container)

The agent CLI (`rex run`) starts an in-process `HarnessDaemon` (WebSocket server), connects a `HarnessClient`, and drives the agent loop:

1. Parse `--input-file` → extract task prompt
2. Parse `--bindings-file` → extract model selection (provider, model, reasoning)
3. Start daemon + connect client
4. `set_model` request with bindings
5. `send_text` with task prompt
6. Wait for response, collecting streaming events
7. Build `AgentResult` with metrics (latency_ms, tokens_in, tokens_out, turn_count, tool_call_count)
8. Write result.json to `--output` path
9. Append hook events to `--events` trajectory file

### Boundary 7: Sink Interface (Trial → JSONL)

**`RunSink` trait** (sink.rs:91):

```rust
trait RunSink {
    fn write_run_manifest(&mut self, run: &RunManifestRecord) -> Result<()>;
    fn append_trial_record(&mut self, row: &TrialRecord) -> Result<()>;
    fn append_metric_rows(&mut self, rows: &[MetricRow]) -> Result<()>;
    fn append_event_rows(&mut self, rows: &[EventRow]) -> Result<()>;
    fn append_variant_snapshot(&mut self, rows: &[VariantSnapshotRow]) -> Result<()>;
    fn flush(&mut self) -> Result<()>;
}
```

**`JsonlRunSink`** — One `BufWriter<File>` per JSONL file, `serde_json::to_writer` per row, flush after each trial.

**Fact files:**

| File | Granularity | Key Fields |
|------|-------------|------------|
| `facts/run_manifest.json` | 1 per run | run_id, baseline_id, variant_ids |
| `facts/trials.jsonl` | 1 row per trial | trial_id, variant_id, task_id, outcome, metrics, bindings |
| `facts/metrics_long.jsonl` | 1 row per metric per trial | metric_name, metric_value, metric_source |
| `facts/events.jsonl` | 1 row per hook event | event_type, seq, payload |
| `facts/variant_snapshots.jsonl` | 1 row per binding per trial | binding_name, binding_value |

All fact files are **append-only and immutable** once written.

### Boundary 8: Analysis (On-Demand DuckDB Materialization)

Triggered by `lab views`, `lab query`, or `lab trend`. Never runs during execution.

**Flow:** `facts/*.jsonl` → `read_json_auto()` → DuckDB in-memory views → SQL queries

**Core views** (always created):
- `trials` — One row per trial with outcome, metrics, bindings
- `metrics_long` — Long-format metrics (one row per metric per trial)
- `events` — Hook events
- `variant_snapshots` — Binding key-value pairs per trial
- `variant_summary` — Aggregated pass rate, metric means per variant
- `task_variant_matrix` — Pass rate per (task, variant) pair
- `run_progress` — Trial counts and pass rate per run

**Opinionated view bundles** (auto-selected from experiment design):

| View Set | Condition | Headline View |
|----------|-----------|---------------|
| AbTest | paired + 2 variants | `win_loss_tie` |
| MultiVariant | paired + 3+ variants | `variant_ranking` |
| ParameterSweep | unpaired + variant_sequential | `best_config` |
| Regression | comparison=none | `pass_rate_trend` |

DuckDB is a **query runtime**, not a database. The `.duckdb` file is recreatable from facts JSONL at any time.

### Boundary 9: Resumability (Schedule Progress)

**`schedule_progress.json`** — Written after every trial completion:

```json
{
  "next_schedule_index": 150,
  "next_trial_index": 150,
  "completed_slots": [
    { "schedule_index": 0, "trial_id": "trial_1", "status": "completed" },
    { "schedule_index": 1, "trial_id": "trial_2", "status": "failed" }
  ],
  "pruned_variants": [1],
  "consecutive_failures": { "0": 0, "1": 5 }
}
```

`lab continue --run-dir <dir>` reads this file and re-enters `execute_schedule_engine()` at `next_schedule_index`.

**Guarantees:**
- Deterministic schedule (same seed → same order) → resumption picks up at exact same point
- Facts JSONL is append-only → re-running doesn't overwrite
- Schedule progress written synchronously after each trial → crash recovery loses at most one trial

---

## State Classification

```
SCHEDULING STATE (drives execution)          ANALYSIS STATE (derived, read-only)
─────────────────────────────────            ────────────────────────────────────
schedule_progress.json                       facts/trials.jsonl
  next_schedule_index                        facts/metrics_long.jsonl
  next_trial_index                           facts/events.jsonl
  completed_slots[]                          facts/variant_snapshots.jsonl

consecutive_failures: BTreeMap<usize>        analysis/agentlab.duckdb
pruned_variants: HashSet<usize>              (materialized on-demand from facts)
chain_states: BTreeMap<String, Chain>
                                             evidence/evidence_records.jsonl
ALL PASSED AS &mut INTO THE FOR LOOP         evidence/task_chain_states.jsonl
ALL ASSUME SINGLE-THREAD OWNERSHIP
```

---

## Disk Layout

```
{project_root}/
  experiment.yaml
  .lab/
    knobs/
      manifest.json                          # What can be overridden
      overrides.json                         # Current override values
    runs/
      run_{timestamp}/
        manifest.json                        # Run metadata
        resolved_experiment.json             # Fully resolved spec (after overrides)
        resolved_experiment.digest           # SHA256
        resolved_variants.json               # Final variant configs
        resolved_variants.digest
        resolved_schedule.json               # Full trial slot sequence
        resolved_schedule.digest
        attestation.json                     # Provenance record

        runtime/
          run_control.json                   # Status: running|completed|failed
          run_session.json                   # Behavior + execution options
          schedule_progress.json             # Resumability checkpoint
          operation.lock                     # Concurrency guard

        facts/
          run_manifest.json                  # Single JSON: run_id, variant_ids
          trials.jsonl                       # 1 row per trial
          metrics_long.jsonl                 # 1 row per metric per trial
          events.jsonl                       # 1 row per hook event
          variant_snapshots.jsonl            # 1 row per binding per trial

        evidence/
          evidence_records.jsonl             # Full provenance per trial
          task_chain_states.jsonl            # Chain step records
          chains/
            {variant}::{chain_label}/
              chain_root_workspace/
              step_{N}_{trial_id}_workspace/

        trials/
          trial_{N}/
            trial_input.json                 # Complete input (agent_task_v1)
            trial_metadata.json              # IDs, policy, chain info
            result.json                      # Agent output (agent_result_v1)
            trial_state.json                 # Status: running|completed|failed
            harness_stdout.log
            harness_stderr.log
            in/                              # Mounted as /agentlab/in (ro)
              task.json
              bindings.json
              dependencies.json
              policy.json
            out/                             # Mounted as /agentlab/out (rw)
              result.json
              trajectory.jsonl
            state/                           # Mounted as /agentlab/state (rw)
            workspace/                       # Mounted as /agentlab/workspace (rw)
            deps/                            # Mounted as /agentlab/deps (rw)
              home/.config/rex/master.key

        artifacts/                           # Content-addressed store
          sha256/{first-2-hex}/{rest}/blob

        analysis/                            # Generated on-demand
          agentlab.duckdb
          load_duckdb.sql
          duckdb_view_context.json

        benchmark/                           # If benchmark adapter configured
          predictions.jsonl
          scores.jsonl
          summary.json
```

---

## Known Issues

1. **`max_concurrency` is decorative.** The SDK exposes it, the schema validates it, every test fixture hardcodes it to 1, and the runner ignores it. The execution engine is a synchronous `for` loop with 20+ `&mut` parameters that assume single-threaded ownership.

2. **No async runtime.** No tokio, no async fn, no `.await` anywhere in the runner crate. Implementing concurrency requires restructuring trial execution to decouple dispatch from completion handling.

3. **Scheduling state blocks parallelism.** `consecutive_failures`, `pruned_variants`, and `chain_states` are mutated after each trial and fed into the next iteration. Parallel execution requires either batch-updating on completion or accepting delayed pruning decisions.

4. **`docker run --rm` is the only execution model.** No `docker create` + `docker start` + `docker exec` lifecycle. No Docker volume mounts for shared agent artifacts. Each trial is a fresh container invocation.
