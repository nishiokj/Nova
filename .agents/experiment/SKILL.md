---
name: experiment
description: >
  Autonomous experiment driver. Maintains a lab notebook, forms hypotheses,
  authors experiments, runs trials, analyzes results, and advances or rejects
  mutations against a tracked baseline.
user-invocable: true
---

# Experiment Skill

You drive a closed-loop experiment system. You maintain a lab notebook, form hypotheses, author experiment YAML, run trials via `lab-cli`, analyze results, and decide whether to accept or reject each mutation. You do not guess. Every claim is grounded in run data.

## Progression Model

```
B0 --(mutation A wins)--> B1 --(mutation C wins)--> B2 --> ...
                           \-- mutation B rejected
```

- There is one **baseline** — the current best-known variant for a given benchmark.
- Each experiment compares one **treatment** against that baseline.
- Accept: treatment becomes the new baseline. Reject: baseline stays, try a different mutation.
- Inconclusive: increase N or accept ambiguity. Never advance or roll back from an inconclusive result.
- The harness is the product, not the model. Model comparisons are useful but the enduring value is harness improvement.

## Invocation

```
/experiment                        # Assess — where are we in the progression?
/experiment analyze <run_id>       # Analyze a completed run, accept or reject
/experiment hypothesis             # Generate next mutation to test
/experiment author <description>   # Author experiment YAML from a hypothesis
/experiment run <yaml>             # Build and run an experiment
```

---

## Notebook Protocol

### Location

`.lab/notebooks/<benchmark_id>.md` — one notebook per (project, benchmark) pair. Pass rates are not comparable across benchmarks, so each benchmark gets its own progression chain.

### Schema

```markdown
# Lab Notebook: <benchmark_id>

## Baseline
- Established by: <experiment_id> (run: <run_id>, variant: <variant_id>)
- Pass rate: <X> (N=<tasks>)
- Description: <1-2 line human description of this configuration>
- Key bindings: model=<model>, model_provider=<provider>
- Artifact: <artifact name or bundle path>
- Bundle digest: <bundle_digest from resolved_variants.json>

## Progression
### <N>: <experiment_id> — <what was tested>
- Mutation type: binding | config | patch | code
- Mutation: <what changed, in human terms>
- Result: accepted | rejected | inconclusive
- Effect: baseline_rate=<X>, treatment_rate=<Y>, N=<tasks>, h=<cohen_h>
- Run: <run_id>
- Notes: <observations, token differences, failure patterns>

### <N-1>: ...
(reverse chronological — most recent first)

## Rejected
- <mutation description> — <reason> (run: <run_id>)

## Open Questions
- <candidate hypotheses, observations, things to investigate>
```

### Notebook Rules

1. The notebook is the durable narrative. Exact provenance lives in run artifacts — dereference `run_id` when precision matters.
2. One progression entry per analyzed run. Entries are immutable once written (append-only).
3. Baseline updates only when `/experiment analyze` concludes "accepted."
4. Open Questions is mutable — add and remove freely.
5. If the notebook does not exist, create it from the template above. Set Baseline to "Not yet established" until the first run is analyzed and accepted.

---

## Procedures

### `/experiment` — Assess

Purpose: Orient. Where are we in the progression?

**Steps:**

1. Determine the benchmark scope. Use the user's input, or infer from recent runs.
2. Read `.lab/notebooks/<benchmark>.md`. If absent, create from template with empty baseline.
3. Run:
   ```
   ./lab-cli runs --json
   ```
   Filter to runs whose `experiment.id` matches this benchmark's experiments.
4. Cross-reference runs against notebook progression entries. Identify:
   - Completed runs not yet in the notebook (need `/experiment analyze`)
   - Currently running experiments
   - The current baseline and its pass rate
5. Output a status summary:
   ```
   Baseline: <description> at <pass_rate> (N=<tasks>), established by <run_id>
   Last experiment: <experiment_id>, result: <accepted|rejected|inconclusive>
   Unanalyzed completed runs: <count>
   ```
6. Recommend next action:

   | State | Recommendation |
   |-------|---------------|
   | Unanalyzed completed runs exist | `/experiment analyze <run_id>` |
   | No hypothesis articulated | `/experiment hypothesis` |
   | Hypothesis exists, no YAML authored | `/experiment author` |
   | YAML authored, not yet run | `/experiment run` |

---

### `/experiment analyze <run_id>` — Analyze

Purpose: Analyze a completed run. Produce an accept/reject/inconclusive decision grounded in data.

**Step 1 — Load results:**

```bash
./lab-cli views <run_id> run_progress --json
./lab-cli views <run_id> variant_summary --json
./lab-cli views <run_id> comparison_summary --json
./lab-cli views <run_id> task_outcomes --json
```

If `comparison_summary` is empty or the run is single-variant, skip to Step 6 and record as a baseline-establishing run.

**Step 2 — Describe what changed:**

Read `.lab/runs/<run_id>/resolved_variants.json`. Compare the baseline variant and treatment variant across:

| Field | Location in resolved variant |
|-------|------------------------------|
| Bindings | `variants[].bindings` |
| Agent bundle | `variants[].runtime_overrides.agent.bundle` |
| Bundle digest | `variants[].runtime_overrides.agent.bundle_digest` |
| Command | `variants[].runtime_overrides.agent.command` |
| Env vars | `variants[].runtime_overrides.agent.env` |
| Env from host | `variants[].runtime_overrides.agent.env_from_host` |
| Arg map | `variants[].runtime_overrides.agent.arg_map` |
| Workspace patches | `variants[].runtime_overrides.agent.workspace_patches` |
| File staging | `variants[].runtime_overrides.dependencies.file_staging` |

Produce two outputs:
- **Exact delta**: which fields differ, with values
- **Human summary**: one sentence describing the mutation (this goes in the notebook)

**Step 3 — Classify regressions:**

For each task where the treatment failed but baseline succeeded, read the treatment's trial log:
```
.lab/runs/<run_id>/trials/<trial_id>/harness_stderr.log
```

Classify each regression:

| Category | Indicators | Counts against mutation? |
|----------|-----------|------------------------|
| Infra noise | API 500/401/403, DNS failure, Docker error, harness timeout unrelated to agent | No |
| Capability failure | Agent ran, made tool calls, produced wrong answer | Yes |
| Resource exhaustion | Token usage >10x baseline for same task, followed by timeout | Yes (thrashing signal) |

**Step 4 — Check operational metrics:**

```bash
./lab-cli query <run_id> "SELECT variant_id, AVG(primary_metric_value) as avg_metric, COUNT(*) as n FROM trials GROUP BY variant_id" --json
```

If token/latency metrics are available in `task_metrics`:
- Treatment uses fewer tokens at equal pass rate = efficiency gain (accept signal)
- Treatment uses more tokens at equal pass rate = thrashing risk (caution signal)

**Step 5 — Decision:**

| Condition | Decision |
|-----------|----------|
| Treatment pass_rate > baseline, regressions are infra noise | **Accept** |
| Treatment pass_rate > baseline, some genuine regressions | **Accept with note** — record which tasks regressed |
| Treatment pass_rate ~ baseline, treatment uses fewer tokens | **Accept** (efficiency gain) |
| Treatment pass_rate < baseline, genuine capability regressions | **Reject** |
| Treatment pass_rate ~ baseline, no efficiency difference | **Inconclusive** — increase N or accept ambiguity |
| N < 10 completed tasks per variant | **Inconclusive** — re-run with higher limit |
| >50% of regressions are infra noise | **Inconclusive** — fix infra, re-run |

**Step 6 — Update notebook:**

- Add a progression entry with: mutation type, mutation description, result, effect data, run_id, notes.
- If **accepted**: update the Baseline section with the treatment's identity.
- If **rejected**: add one line to the Rejected section.
- Add observations to Open Questions if they suggest follow-up hypotheses.

---

### `/experiment hypothesis` — Hypothesize

Purpose: Generate the next mutation to test, informed by the progression so far.

**Steps:**

1. Read the notebook. Load: current baseline, progression chain, rejected list, open questions.
2. Review the rejected list. Do not repeat a rejected mutation unless you state what changed and why retrying is justified.
3. Sources of hypotheses:
   - Open Questions (may already have candidates)
   - Observations from recent runs (e.g., "treatment used 170x more tokens — is compaction broken?")
   - Task-level analysis: query `task_outcomes` from recent runs to find tasks that consistently fail — these may indicate a harness limitation
   - Operational metrics: high `tool_call_count` or `turn_count` may indicate thrashing, suggesting structural changes
4. Write the hypothesis in this format:
   ```
   Mutation: <what to change, specifically>
   Mutation type: binding | config | patch | code
   Expected effect: <direction + magnitude reasoning>
   Mechanism: <why this should help>
   Sample size: <limit value, based on expected effect size>
   ```
5. Write the hypothesis to the notebook's Open Questions section.
6. Recommend `/experiment author`.

### When to pivot vs. continue

- **Pivot** if 3+ mutations in the same category were rejected (e.g., tried 3 compaction strategies, none helped). Switch categories.
- **Continue** if the effect was directional but underpowered (N too small). Re-run with higher limit.
- **Re-validate** if 3+ mutations were accepted in sequence without checking baseline stability. Run the current baseline against an older known-good state.

---

### `/experiment author <description>` — Author

Purpose: Create the experiment YAML that tests the hypothesis.

**Steps:**

1. Read the notebook for the current hypothesis (from Open Questions or user input).
2. Determine the mutation type. This dictates the YAML format:

   | Mutation type | YAML format | What changes |
   |--------------|-------------|-------------|
   | binding | Single `agent:` block, `baseline:` + `variants:` | `bindings` values |
   | config | Single `agent:` block, different `config_files` per variant | Config file content |
   | patch | Single `agent:` block, different `workspace_patches` per variant | Source file overlays |
   | code | `agent_builds:` block, `variants:` with `agent_ref:` | Different artifacts |

3. For **binding mutations**, fork from a working experiment YAML:

   ```yaml
   experiment:
     id: <benchmark>_<mutation_name>_v0
     name: "<Human Readable Name>"
     tags: [<benchmark>, ab-test, <mutation-tag>]

   benchmark: <benchmark_id>
   limit: <from hypothesis sample size>
   concurrency: <2-4>

   agent:
     artifact: <current baseline artifact>
     command: [...]
     default_config: <config file>
     env_from_host: [...]
     arg_map: [...]
     config_files: [...]

   baseline:
     id: <control_name>
     bindings: { <current baseline bindings> }

   variants:
     - id: <treatment_name>
       bindings: { <mutated bindings> }

   overrides:
     network: full
     root_read_only: false
   ```

4. For **code mutations**, use the `agent_builds` format:

   ```yaml
   agent_builds:
     - id: baseline_build
       artifact: <baseline artifact>
       command: [...]
       default_config: <config>
       env_from_host: [...]
       arg_map: [...]
       config_files: [...]
     - id: treatment_build
       artifact: <treatment artifact>
       command: [...]
       default_config: <config>
       env_from_host: [...]
       arg_map: [...]
       config_files: [...]

   variants:
     - id: <baseline_name>
       baseline: true
       agent_ref: baseline_build
       config: { <identical bindings> }
     - id: <treatment_name>
       agent_ref: treatment_build
       config: { <identical bindings> }
   ```

   Both variants use the same bindings. The only difference is `agent_ref`. This isolates the code change.

   Building the treatment artifact requires a worktree. See `docs/experiment-worktree-builds-spec.md` for the full workflow:
   ```bash
   git worktree add .lab/implementations/<name> -b exp/<name> <base_ref>
   # make code changes in the worktree, commit
   bun scripts/build-agentlab-rex-artifact.ts --source .lab/implementations/<name> --build --target host
   ```

5. Write the YAML to `.lab/experiments/<experiment_id>.yaml`.
6. Validate:
   ```bash
   ./lab-cli build .lab/experiments/<experiment_id>.yaml --json
   ./lab-cli preflight <package_path> --json
   ```
7. If errors, fix and retry. If preflight warnings (dirty build, stale artifact), assess and decide whether to proceed.
8. Recommend `/experiment run`.

---

### `/experiment run <yaml>` — Run

Purpose: Execute the experiment.

**Steps:**

1. Run:
   ```bash
   ./lab-cli build-run <yaml>
   ```
   Capture the `run_id` from stdout.

2. If it fails, read the error output. Common failures and fixes:

   | Error | Fix |
   |-------|-----|
   | YAML validation error | Fix the YAML syntax or field names |
   | Missing artifact | Check `.lab/agents/`, rebuild if needed |
   | Missing Docker image | `docker pull <image>` |
   | Auth/credential error | Check env vars, config_files, env_from_host |
   | Port conflict | Kill stale containers or change concurrency |

3. Optionally monitor progress:
   ```bash
   ./lab-cli views-live <run_id> run_progress
   ```

4. On completion, recommend `/experiment analyze <run_id>`.

5. Failed or aborted runs are non-decisive. They do not change the baseline. If the failure is infrastructure (not the mutation), fix infra and re-run.

---

## Decision Heuristics

### Statistical sufficiency

| Sample size (N per variant) | Detectable effect size |
|----------------------------|----------------------|
| N < 10 | No conclusions. Directional signal only. |
| 10 <= N < 25 | Large effects (Cohen's h >= 0.8) |
| 25 <= N < 65 | Medium effects (h >= 0.5) |
| N >= 65 | Small effects (h >= 0.2) |

### Cohen's h interpretation

| h | Magnitude | Meaning |
|---|-----------|---------|
| < 0.2 | Negligible | No practical difference |
| 0.2-0.5 | Small | Detectable, may not be practically meaningful |
| 0.5-0.8 | Medium | Likely practically meaningful |
| > 0.8 | Large | Clear practical significance |

### Efficiency as signal

A mutation that achieves the same pass rate with fewer tokens is an improvement worth accepting. A mutation that achieves slightly higher pass rate but vastly more tokens is suspicious — it may be brute-forcing through thrashing.

---

## Error Recovery

| Situation | Action |
|-----------|--------|
| Run crashed mid-execution | `./lab-cli recover --run-dir .lab/runs/<run_id>` then `./lab-cli continue --run-dir .lab/runs/<run_id>` |
| Run paused | `./lab-cli resume --run-dir .lab/runs/<run_id>` |
| Need to kill a running experiment | `./lab-cli kill <run_id>` |
| lab-cli rebuild needed | Delete the binary and re-run any `./lab-cli` command — the wrapper auto-rebuilds |
| Notebook is missing or corrupt | Reconstruct from `./lab-cli runs --json` and reading run artifacts |

---

## Constraints

1. **Never advance the baseline without data.** No aspirational baselines. No "we think this would work."
2. **Never edit a progression entry.** If a prior conclusion was wrong, add a new entry documenting the reversal.
3. **Never conclude from N < 10.** Report directional signal, but mark as inconclusive.
4. **Always use `--json` for programmatic consumption.** Parse `result.rows`. Check `ok` before reading `result`.
5. **Never guess run IDs.** Use `./lab-cli runs --json` to list them.
6. **Read logs for failures.** The answer is in `trials/<trial_id>/harness_stderr.log`.
7. **The experiment YAML is the source of truth.** Resolved JSON in the run directory is derived. Iterate on the YAML.
8. **Infra failures are non-decisive.** API errors, Docker timeouts, auth issues — these do not count for or against a mutation unless the mutation is specifically about fixing that failure mode.

---

## Appendix A: CLI Reference

| Command | Purpose |
|---------|---------|
| `./lab-cli build <yaml>` | Compile YAML into sealed package |
| `./lab-cli build-run <yaml>` | Build + run in one step |
| `./lab-cli run <package>` | Run a sealed package |
| `./lab-cli run-experiment <package>` | Durable run (pause/resume/recover) |
| `./lab-cli describe <package>` | Show resolved experiment config |
| `./lab-cli preflight <package>` | Validate before running |
| `./lab-cli views <run_id> [view]` | Query views for a run |
| `./lab-cli views-live <run_id> [view]` | Live-refresh view during run |
| `./lab-cli query <run_id> <sql>` | SQL against the run's DuckDB |
| `./lab-cli runs` | List all runs |
| `./lab-cli trend <experiment_id>` | Metric trends across runs |
| `./lab-cli kill <run_id>` | Kill a running experiment |
| `./lab-cli recover --run-dir <dir>` | Recover after crash |
| `./lab-cli resume --run-dir <dir>` | Resume a paused trial |
| `./lab-cli continue --run-dir <dir>` | Continue from next schedule slot |

All commands accept `--json` for machine-readable output. JSON structure:
```json
{
  "command": "<name>",
  "ok": true,
  "result": { "columns": [...], "row_count": N, "rows": [...] }
}
```
If `ok` is false, read `error.message` before retrying.

## Appendix B: Views

Available per-run views (use `./lab-cli views <run_id> <view> --json`):

| View | Columns | Use for |
|------|---------|---------|
| `run_progress` | completed, total, pass_rate | Overall status |
| `variant_summary` | variant_id, success_rate, n | Per-variant breakdown |
| `comparison_summary` | a_rate, b_rate, chi2, cohens_h, magnitude | Statistical comparison |
| `task_outcomes` | task_id, baseline_outcome, treatment_outcome, delta_type | Which tasks differ |
| `task_metrics` | task_id, variant_id, latency_ms, tokens_in, tokens_out | Operational metrics |

## Appendix C: Run Artifacts

```
.lab/runs/<run_id>/
  manifest.json                    # run metadata
  resolved_experiment.json         # fully resolved experiment config
  resolved_variants.json           # resolved variant configs with provenance
  resolved_schedule.json           # trial execution schedule
  run.sqlite                       # results database
  trials/
    <trial_id>/
      trial_metadata.json          # IDs, runtime config
      trial_state.json             # outcome, timing
      harness_stdout.log           # agent stdout
      harness_stderr.log           # agent stderr
      artifacts/                   # patches, output files
```
