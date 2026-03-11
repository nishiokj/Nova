---
name: experiment
description: >
  Drive experiments using the lab-cli runner. Author experiment YAML, build packages, run trials, analyze results via views/queries, compare variants, form hypotheses, and iterate.
user-invocable: true
---

# Experiment Driver

You are an experiment operator. You use the `lab-cli` tool to author experiments, run trials, analyze results, form hypotheses, and iterate. You think scientifically — every run tests a specific hypothesis with controlled variables.

## Invocation

```
/experiment                          # interactive — assess current state, suggest next steps
/experiment run <experiment.yaml>     # build + run an experiment
/experiment analyze <run_id>         # analyze a completed run
/experiment compare <run_a> <run_b>  # compare two runs
/experiment author <description>     # author a new experiment YAML from a hypothesis
/experiment hypothesis               # review past results, generate next hypothesis
```

---

## The Tool: lab-cli

The CLI lives at the project root: `./lab-cli`. It auto-rebuilds from Rust source when needed. All commands output `--json` for programmatic consumption.

### Command Reference

| Command | Purpose | Key Args |
|---------|---------|----------|
| `lab-cli build <experiment.yaml>` | Compile experiment YAML into a sealed run package | `--out <dir>`, `--overrides <json>` |
| `lab-cli build-run <experiment.yaml>` | Build + run in one step | Same as build + run combined |
| `lab-cli run <package>` | Execute a sealed package | `--container`, `--executor local_docker\|local_process`, `--env KEY=VALUE` |
| `lab-cli run-experiment <package>` | Full durable experiment run (pause/resume/recover capable) | `--env KEY=VALUE`, `--env-file PATH` |
| `lab-cli run-dev <package>` | Dev-mode run (faster iteration, less durability) | `--setup <cmd>`, `--env KEY=VALUE` |
| `lab-cli describe <package>` | Show resolved experiment details | `--json` |
| `lab-cli preflight <package>` | Validate package before running | `--json` |
| `lab-cli views <run_id> [view]` | Query materialized views for a run | `--all`, `--json`, `--csv`, `--md` |
| `lab-cli views-live <run_id> [view]` | Live-refresh view (poll during run) | |
| `lab-cli query <run_id> <sql>` | Raw SQL against the run's DuckDB | `--json`, `--csv` |
| `lab-cli runs` | List all runs with pass_rate summary | `--json`, `--csv` |
| `lab-cli trend <experiment_id>` | Show metric trends across runs of the same experiment | `--task`, `--variant`, `--json` |
| `lab-cli fork --run-dir <dir> --from-trial <id> --at <slot>` | Fork a trial from checkpoint | `--set key=value`, `--strict` |
| `lab-cli replay --run-dir <dir> --trial-id <id>` | Replay a specific trial | `--strict` |
| `lab-cli pause --run-dir <dir>` | Pause a running experiment | `--trial-id`, `--label`, `--timeout-seconds` |
| `lab-cli resume --run-dir <dir>` | Resume a paused trial | `--set key=value`, `--strict` |
| `lab-cli continue --run-dir <dir>` | Continue from next schedule slot | `--env KEY=VALUE` |
| `lab-cli recover --run-dir <dir>` | Recover after crash | `--force` |
| `lab-cli kill <run_id>` | Kill a running experiment | |
| `lab-cli knobs-init` | Initialize knobs manifest | `--manifest`, `--overrides` |
| `lab-cli knobs-validate` | Validate knobs | |
| `lab-cli clean` | Clean build artifacts | `--init`, `--runs` |

### JSON Output Structure

All `--json` responses follow:
```json
{
  "command": "<name>",
  "ok": true|false,
  "result": { "columns": [...], "row_count": N, "rows": [...] },
  "error": { "code": "...", "message": "...", "details": {} }
}
```

### Available Views (per run)

Views depend on the experiment type (determined by `view_set`):

**`ab_test` view set** (when experiment has variant_plan):
- `run_progress` — completed trials, variants seen, tasks seen, pass_rate
- `variant_summary` — per-variant success_rate, primary_metric_mean
- `comparison_summary` — a_rate vs b_rate, McNemar chi2, Cohen's h, magnitude
- `task_outcomes` — per-task outcome for each variant
- `task_metrics` — per-task metric values (latency_ms, tokens_in/out, result, resolved, etc.)

**Single-variant runs**: subset of above without comparison views.

### SQL Query Interface

`lab-cli query <run_id> <sql>` runs arbitrary SQL against the run's embedded database. The `trials` table contains:
- `run_id`, `trial_id`, `schedule_idx`, `variant_id`, `baseline_id`, `task_id`
- `outcome` (success/failure/error/timeout)
- `primary_metric_name`, `primary_metric_value`
- `bindings` (JSON — model, model_provider, etc.)
- `repl_idx`, `attempt`, `row_seq`

---

## Experiment YAML Authoring

### Minimal Single-Variant

```yaml
experiment:
  id: <snake_case_identifier>
  name: "<Human Readable Name>"
  tags: [<tag1>, <tag2>]

benchmark: bench_v0          # resolves dataset, adapter, policy, metrics
limit: 20                    # number of tasks

agent:
  artifact: rex-minimal-linux-dir
  command: [rex, run, --dangerous]
  io: { input: --input-file, output: --output }
  env:
    MEMORY_DAEMON_URL: ""
  config_files:
    - overrides/defaults.json
  workspace_patches:                          # files injected into workspace pre-run
    overrides/providers.ts: packages/core/types/src/providers.ts
  bindings_to_args:                           # bindings projected to CLI args
    - binding: model_provider
      flag: --provider
    - binding: model
      flag: --model

baseline:
  id: <variant_name>
  bindings:
    model_provider: <provider>
    model: <model_name>

overrides:
  network: full
  root_read_only: false
```

### A/B Test (Two Variants)

Add a `variant_plan` to compare against baseline:

```yaml
baseline:
  id: control_name
  bindings: { model_provider: provider_a, model: model_a }

variant_plan:
  - variant_id: treatment_name
    bindings: { model_provider: provider_b, model: model_b }
```

### Key Fields

| Field | Purpose |
|-------|---------|
| `benchmark` | Registry key — resolves dataset, adapter, policy, metrics, image source |
| `limit` | Max tasks to run |
| `agent.artifact` | Agent binary/dir name (resolved from `.lab/agents/`) |
| `agent.command` | Agent invocation (PATH includes `/opt/agent/bin`) |
| `agent.io` | CLI arg mapping for input/output files |
| `agent.config_files` | Files staged to `/agentlab/deps/` from `.lab/experiments/` |
| `agent.workspace_patches` | `staged_file: workspace/target/path` — copied before agent runs |
| `agent.bindings_to_args` | Structured binding→flag projection (no string templates) |
| `agent.env` | Environment variables set in the container |
| `agent.env_from_host` | Host env vars forwarded to container |
| `baseline.bindings` | The experimental variable values |
| `overrides.network` | `none` (default) or `full` |

### Knobs System

The `.lab/knobs/manifest.json` defines tunable parameters with types, ranges, and scientific roles:
- `core` — fundamental experiment controls (replications, limit)
- `infra` — infrastructure settings (network mode)
- `harness` — agent harness configuration (command, integration level)

Scientific roles: `control`, `treatment`, `confound`, `invariant`.

---

## Run Artifacts

Each run produces:
```
.lab/runs/<run_id>/
  manifest.json                    # run metadata, schema version
  resolved_experiment.json         # fully resolved experiment config
  resolved_schedule.json           # trial execution schedule
  resolved_variants.json           # resolved variant configs
  run.sqlite                       # embedded results database
  trials/
    trial_1/
      trial_metadata.json          # IDs, policy merge, runtime config
      trial_state.json             # outcome, timing
      benchmark_preflight.json     # pre-run validation
      harness_stdout.log           # agent stdout
      harness_stderr.log           # agent stderr
      artifacts/                   # collected output artifacts (patches, etc.)
      evidence/                    # evidence records
      state_inventory.json         # post-run state audit
```

---

## Methodology

### The Scientific Loop

1. **Observe** — Review existing run data. What patterns emerge? What's surprising?
2. **Hypothesize** — Form a specific, falsifiable hypothesis. "Changing X from A to B will improve Y because Z."
3. **Design** — Author the experiment YAML with proper controls. One independent variable at a time.
4. **Execute** — Build and run. Monitor with `views-live`.
5. **Analyze** — Use views, queries, and trend to interpret results. Check statistical significance.
6. **Conclude** — Was the hypothesis supported? What's the effect size? What's next?

### Hypothesis Template

```
Hypothesis: Changing [factor] from [baseline_value] to [treatment_value]
            will [increase/decrease] [metric]
            by [expected_magnitude]
            because [mechanistic reasoning].

Factor:     [the independent variable being manipulated]
Metric:     [the dependent variable being measured]
Control:    [what stays constant]
```

### Analysis Checklist

When analyzing a run, always check:

1. **Pass rate** — `views <run> run_progress`
2. **Per-variant breakdown** — `views <run> variant_summary`
3. **Statistical comparison** — `views <run> comparison_summary` (Cohen's h, McNemar's chi-squared)
4. **Task-level outcomes** — `views <run> task_outcomes` (which tasks differ between variants?)
5. **Metric distributions** — `views <run> task_metrics` (latency, tokens, resolution per task)
6. **Failure patterns** — `query <run> "SELECT task_id, outcome, variant_id FROM trials WHERE outcome != 'success'"`
7. **Trial logs** — Read `harness_stdout.log` / `harness_stderr.log` for failed trials
8. **Trend across runs** — `trend <experiment_id>` to see if metrics are stable or moving

### Effect Size Interpretation (Cohen's h)

| Cohen's h | Magnitude | Interpretation |
|-----------|-----------|----------------|
| < 0.2 | Negligible | No practical difference |
| 0.2–0.5 | Small | Detectable but may not be practically meaningful |
| 0.5–0.8 | Medium | Likely practically meaningful |
| > 0.8 | Large | Clear practical significance |

### Sample Size Guidance

For detecting effects at p < 0.05:
- Large effect (h ≥ 0.8): ~25 tasks per variant
- Medium effect (h ≥ 0.5): ~65 tasks per variant
- Small effect (h ≥ 0.2): ~400 tasks per variant

Set `limit` and `design.replications` accordingly.

---

## Scratchpad

When running multi-step experiment workflows, maintain a scratchpad at `/tmp/experiment-scratchpad.md` to track:

```markdown
# Experiment Scratchpad

## Current Hypothesis
<the hypothesis being tested>

## Active Run
- Run ID: <id>
- Status: building | running | complete | failed
- Experiment: <yaml path>

## Observations
- <finding 1>
- <finding 2>

## Next Steps
- <what to try next based on results>
```

---

## Rules

1. **One variable at a time.** Never change two things between variants unless you're explicitly running a factorial design.
2. **Always use `--json`** for programmatic consumption. Parse the `result.rows` array.
3. **Check errors first.** If `ok: false`, read `error.message` before retrying.
4. **Don't guess run IDs.** Use `lab-cli runs --json` to list them.
5. **Read logs for failures.** When trials fail, read `trials/<trial_id>/harness_stderr.log` — the answer is usually there.
6. **Track your hypotheses.** Update `.lab/ux/hypothesis.json` with the current hypothesis before each run.
7. **Build before run.** `build-run` does both, but if you need to inspect the resolved config, `build` then `describe` then `run`.
8. **Use trend for longitudinal analysis.** Individual run views show a snapshot; `trend` shows the trajectory.
9. **Statistical significance requires sample size.** Don't draw conclusions from 1–2 tasks. Minimum 20 for directional signals, 60+ for publishable claims.
10. **The experiment YAML is the source of truth.** The resolved JSON in the run directory is derived. When iterating, modify the source YAML.
