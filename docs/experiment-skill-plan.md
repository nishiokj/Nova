# Experiment Skill — Implementation Plan

## North Star

An agent spun up cold — no prior context, no human briefing — reads the lab notebook and within minutes understands: what the current best configuration is, what was tried to get there, what failed, and what's worth trying next. It then autonomously generates a hypothesis, authors the experiment, runs it, analyzes the results, and either advances the baseline or rejects the mutation and tries something else. The loop closes without human intervention beyond approving risky actions.

**Success looks like:** You come back after a weekend and the agent has run 5 experiments. 2 were accepted (pass rate went from 0.35 → 0.42 → 0.48), 2 were rejected (with clear reasoning in the notebook), and 1 is queued with a hypothesis ready. You read the notebook and understand every decision it made.

**Failure looks like:** The agent can't figure out what the baseline is. Or it writes a notebook entry that says "results inconclusive" with no data. Or it repeats low-value experiments without saying why. Or it thrashes between hypotheses without committing to a direction.

## Principles

1. **The harness is the product, not the model.** Model comparisons are fun but the enduring value is harness improvement — compaction, tool routing, agent architecture, prompt engineering. The experiment system exists to make the harness measurably better.

2. **Prefer focused mutations, not brittle purity tests.** The goal is to keep each experiment causally legible. The diff should be explainable in human terms and mostly centered on one idea, but small incidental noise is acceptable. The system should package the change surface clearly rather than pretending experiments are perfectly sterile.

3. **The notebook is the durable narrative; resolved variants are the exact provenance.** An agent's context window is ephemeral. The notebook explains what happened in human terms. The exact machine truth lives in run artifacts and resolved variant manifests.

4. **Data over intuition.** Accept/reject decisions are made from `paired_outcomes`, `effect_size`, and `trial_metrics` — not from vibes. If the data is insufficient (N too small, too much infra noise), the correct answer is "inconclusive," not a guess.

5. **Describe mutations in human terms.** The notebook must be readable by a person who wasn't there. "Changed `agent.artifact` from `rex-baseline.tar.gz` to `rex-greedy-compaction.tar.gz`" is useless. "Replaced FIFO compaction with salience-scored greedy eviction in context-window.ts" is useful.

6. **Use prior experiments as context, not handcuffs.** The agent should read what has already been tried and avoid obviously redundant work, but common sense wins. If revisiting an idea is justified, the notebook should say why.

7. **Efficiency is signal, not just pass rate.** A mutation that achieves the same pass rate with 40% fewer tokens is an improvement worth accepting. A mutation that achieves slightly higher pass rate but 10x the token usage is suspicious — it may be brute-forcing through thrashing rather than genuinely solving problems better.

## Invariants

These must hold at all times. If the skill or notebook violates any of these, something is broken.

1. **The notebook's Baseline section matches reality.** Baseline must point to an actual accepted variant from a completed run whose results justify the claimed pass rate. No aspirational baselines.

2. **Every Progression entry has a run_id.** No entry without data. No "we think this would work." Every entry is grounded in an actual experiment run.

3. **The Progression chain is append-only.** Entries are never edited or deleted. If a prior conclusion turns out to be wrong (e.g., the accepted mutation was later found to interact badly), add a new entry documenting the reversal — don't rewrite history.

4. **Baseline only advances forward.** The Baseline section is updated only when analyze concludes "accepted." It is never updated speculatively, never updated from a running experiment, and never updated without the data to back it.

5. **Every compared variant has exact provenance.** The baseline and treatment variants must each resolve to a concrete behavior surface that can be inspected and diffed. Mutation hygiene is a goal, not a brittle validator.

6. **Failed runs are non-decisive.** API 500s, auth errors, Docker timeouts, missing credentials, build failures, and aborted runs are noise unless the mutation being tested is itself about fixing that failure mode. Failed runs do not advance or roll back the baseline.

7. **Prior runs are visible before proposing the next experiment.** The agent should be able to see what has already been tested, what won, what failed, and why.

## Problem

The current experiment skill (`/experiment`) is a reference card. It documents CLI commands and YAML format but has no operational procedures. It is not a closed loop — an agent cannot autonomously iterate on harness improvements across experiments.

The value of the experiment system is **progressive improvement of the agent harness**: compaction strategies, tool backends, agent architecture, configuration. The model is mostly held constant. The iteration surface is the full agent configuration — bindings, configs, patches, and code.

## Core Abstraction: Linear Progression

```
B₀ →(mutation A wins)→ B₁ →(mutation C wins)→ B₂ → ...
                        ↳ mutation B rejected
```

- There is a **baseline** — the current best-known variant
- Each experiment compares a **candidate variant** against that baseline
- If the mutation improves results → it becomes the new baseline (B_{n+1} = B_n + mutation)
- If it regresses → reject, stay at B_n, try a different mutation
- If inconclusive → increase sample size or accept the ambiguity

**Independence assumption:** Prefer experiments that mostly test one idea at a time. When this breaks, the system should still make the full behavior surface visible so the agent can judge whether the comparison is meaningful. The mitigation: periodically re-validate the accumulated baseline against an older known-good state.

## Variant Identity and Diff Surface

A **variant** is the full resolved behavior surface of one side of an experiment. It is not just an artifact name, not just a YAML stanza, and not just a git commit.

Each variant should resolve to a machine-readable manifest with:

- **Code surface**
  - `artifact_digest` / `bundle_digest` — exact identity of the built agent package
  - `source_tree_digest` — exact source snapshot used to build it, including dirty worktree state when applicable
  - `source_commit`, `source_branch`, `source_impl`, `dirty` — human-meaningful provenance when available
- **Runtime surface**
  - bindings, model/provider, command/args, env, agent topology/orchestration settings
  - config files, workspace patches, dependency file staging, and any other runtime override that can change behavior
  - `agent_ref` when using `agent_builds`
- **Descriptor surface**
  - a short human mutation summary used in the notebook

The system should expose a stable **variant_digest** derived from the normalized code surface + runtime surface. This is what Baseline should point to.

The system should also expose a packaged diff surface for agents:

- exact provenance deltas
- runtime/settings deltas
- filtered source diff summary for behavior-relevant files
- optional raw diff when the agent wants to inspect deeper

The important split is:

- **Exact provenance is strict.** The system should always be able to identify what ran.
- **Mutation hygiene is advisory.** The system should package the comparison cleanly, but the agent is allowed to use judgment when there is incidental noise.

## Lab Notebook

### Location and Scoping

Notebooks live at `.lab/notebooks/<benchmark_id>.md`. One notebook per `(project, benchmark)` pair. This keeps causal chains clean — pass rates aren't comparable across benchmarks.

### Schema

```markdown
# Lab Notebook: <benchmark_id>

## Baseline
- Established by: <experiment_id> (run: <run_id>, variant: <variant_id>)
- Variant digest: <variant_digest>
- Provenance: artifact=<artifact_digest>, source_tree=<source_tree_digest>, commit=<source_commit|dirty>
- Pass rate: <X> (N=<tasks>)
- Description: <1-2 line human description of this configuration>
- Key settings: <short summary of the settings worth scanning>

## Progression
### N: <experiment_id> — <what was tested>
- Mutation type: binding | config | patch | code
- Mutation: <what changed, in human terms>
- Compared: baseline=<variant_digest> vs treatment=<variant_digest>
- Result: accepted | rejected | inconclusive
- Effect: h=<value>, baseline_rate=<X>, treatment_rate=<Y>, N=<tasks>
- Run: <run_id>
- Notes: <observations, token differences, failure patterns>

### N-1: ...
(reverse chronological — most recent first)

## Rejected
- <mutation description> — <1 line why> (run: <run_id>)

## Open Questions
- <candidate hypotheses, informed by observations>
```

### Notebook Rules
1. The notebook is the durable **narrative index** across sessions. It explains the progression in human terms.
2. Exact provenance lives in run artifacts and resolved variant manifests. When precision matters, the skill dereferences the notebook's `run_id` / `variant_digest` into those manifests.
3. One progression entry per analyzed experiment. Entries are immutable once written (append-only log).
4. The baseline section is updated only when a completed run is accepted.
5. Open Questions is a mutable scratchpad — the agent adds and removes freely.

## Skill Structure (SKILL.md)

```
1. Frontmatter
2. Identity + Progression Model
3. Invocation Quick Reference
4. Notebook Protocol (location, schema, rules)
5. Procedures
   5a. /experiment (assess)
   5b. /experiment analyze <run_id>
   5c. /experiment hypothesis
   5d. /experiment author <description>
   5e. /experiment run <yaml>
6. Variant Identity + Diff Surface
7. Decision Heuristics
8. Error Recovery
9. Constraints
10. Appendix: CLI Reference
11. Appendix: YAML Schemas
12. Appendix: Data Model (tables, columns)
```

## Procedure Definitions

### `/experiment` (assess)

Purpose: Orient. Where are we in the progression?

1. Determine the benchmark scope (from user input or infer from recent runs).
2. Read `.lab/notebooks/<benchmark>.md`. If it doesn't exist, create from template.
3. `./lab-cli runs --json` — list runs, filter to this benchmark's experiment_ids.
4. Cross-reference runs against notebook entries. Flag:
   - Completed runs not yet in the notebook (need analysis)
   - Running experiments (show status)
   - The current baseline variant_digest and its establishing run
5. Output: "Baseline is X at pass_rate Y. Last experiment tested Z, result was W. There are N unanalyzed runs."
6. Recommend next mode based on state:
   - Unanalyzed completed runs → `/experiment analyze <run_id>`
   - No clear next experiment articulated → `/experiment hypothesis`
   - Hypothesis described but not yet authored into an experiment → `/experiment author`
   - Experiment authored and ready to execute → `/experiment run`

### `/experiment analyze <run_id>`

Purpose: Analyze a completed run. Accept or reject the mutation.

**Step 1 — Load results:**
```
lab-cli query <run_id> "SELECT * FROM paired_outcomes ORDER BY task_id" --json
lab-cli query <run_id> "SELECT * FROM effect_size" --json
lab-cli query <run_id> "SELECT * FROM win_loss_tie" --json
```

**Step 2 — Describe what changed:**

Read `.lab/runs/<run_id>/resolved_variants.json`. Resolve the baseline and treatment variant manifests and diff them across the full behavior surface:
- code provenance (`artifact_digest`, `source_tree_digest`, `source_commit`, `source_branch`, `source_impl`, `dirty`)
- `bindings`
- `agent_ref`
- `runtime_overrides.agent.command` — different command args
- `runtime_overrides.agent.env` — different env vars
- `runtime_overrides.agent.workspace_patches` — different patches
- `runtime_overrides.dependencies.file_staging` — different config files
- any other resolved runtime field that can change agent behavior

Package the diff in two forms:
- **Exact provenance delta** — the precise code/runtime identity change
- **Human mutation summary** — the short sentence that goes in the notebook

If the factor is a code change, run `lab-cli impl diff <impl_name>` (if the implementation exists) to see the actual source diff.

**Step 3 — Classify failures:**

For each `delta_type = 'regression'` row in `paired_outcomes`:
- Read `.lab/runs/<run_id>/trials/<treatment_trial_id>/harness_stderr.log`
- Classify:
  - **Infra noise**: API 500/401/403 errors, DNS failures, Docker issues, harness timeouts unrelated to the agent. These don't count against the mutation.
  - **Capability failure**: The agent ran, made tool calls, but produced the wrong answer. These count.
  - **Resource exhaustion**: Extremely high token usage (>10x baseline for same task) followed by timeout. Indicates the mutation may cause thrashing.

**Step 4 — Check operational metrics:**

```
lab-cli query <run_id> "SELECT variant_id, AVG(tokens_in) as avg_in, AVG(tokens_out) as avg_out, AVG(latency_ms) as avg_latency, AVG(tool_call_count) as avg_tools FROM trial_metrics GROUP BY variant_id" --json
```

Even if pass rates are similar, token efficiency differences are signal:
- Mutation uses significantly fewer tokens at equal pass rate → accept (cost improvement)
- Mutation uses significantly more tokens at equal pass rate → caution (may be thrashing)

**Step 5 — Accept/reject decision:**

| Condition | Decision |
|---|---|
| Treatment pass_rate > baseline pass_rate, regressions are infra noise | **Accept** |
| Treatment pass_rate > baseline pass_rate, some genuine regressions | **Accept with note** — record which tasks regressed |
| Treatment pass_rate ≈ baseline pass_rate, treatment uses fewer tokens | **Accept** (efficiency gain) |
| Treatment pass_rate < baseline pass_rate, genuine capability regressions | **Reject** |
| Treatment pass_rate ≈ baseline pass_rate, no efficiency difference | **Inconclusive** — increase N or accept ambiguity |
| Too few tasks completed (N < 10) | **Inconclusive** — re-run with higher limit |
| Most failures are infra noise (>50% of regressions) | **Inconclusive** — fix infra, re-run |

**Step 6 — Update notebook:**

- Add progression entry with result, effect size, run_id, notes
- If accepted: update Baseline section
- If rejected: add to Rejected list
- Add any observations to Open Questions

### `/experiment hypothesis`

Purpose: Generate the next mutation to test, informed by past results.

1. Read notebook. Load: current baseline, progression chain, rejected list, open questions.
2. Use the Rejected list as context, not as a hard ban. If revisiting an old idea, state what changed or why it is worth another shot.
3. **Sources of hypotheses:**
   - Open Questions section (may already have candidates)
   - Observations from recent experiments (e.g., "treatment used 170x more tokens — is compaction broken?")
   - Task-level analysis: query `paired_outcomes` from recent runs to find tasks that consistently fail across variants — these might point to a harness limitation rather than a model limitation
   - Operational metrics: consistently high `tool_call_count` or `turn_count` might indicate the agent is thrashing, suggesting a structural change
4. **Hypothesis format:**
   ```
   Mutation: <what to change, specifically>
   Mutation type: binding | config | patch | code
   Expected effect: <direction + magnitude reasoning>
   Mechanism: <why this should help>
   Sample size: <limit value, based on expected effect size>
   ```
5. Write to notebook under Open Questions or as next planned experiment.
6. Recommend `/experiment author`.

### `/experiment author <description>`

Purpose: Create the experiment YAML that tests the hypothesis.

1. Read notebook for the current hypothesis.
2. Resolve the current baseline from the notebook's `run_id` + `variant_digest`. Use the resolved experiment/package that produced that accepted variant as the starting point.
3. Fork that YAML. Apply the mutation:

   **Binding mutation:** Change values in `baseline.bindings` or `variants[].config`.

   **Config mutation:** Create/modify a config file in `.lab/experiments/overrides/`, reference in `agent.config_files`.

   **Patch mutation:** Create/modify a source file in `.lab/experiments/overrides/`, reference in `agent.workspace_patches`.

   **Code mutation:**
   - Note that a worktree and artifact build are needed (see `docs/experiment-worktree-builds-spec.md`)
   - Use `agent_builds` format (multi-build YAML) so each variant gets its own artifact
   - Baseline variant references the current baseline artifact / variant provenance
   - Treatment variant references the implementation's artifact

4. Set `experiment.id` to `<benchmark>_<mutation_description>_v0`
5. Set `limit` based on hypothesis's expected effect size
6. `./lab-cli build <yaml> --json` — validate it compiles
7. `./lab-cli preflight <package> --json` — validate the package
8. If errors, fix and retry.
9. Recommend `/experiment run`.

### `/experiment run <yaml>`

Purpose: Execute the experiment.

1. `./lab-cli build-run <yaml>` — captures run_id from output.
2. If it fails, read error. Common failures:
   - YAML validation → fix YAML
   - Missing artifact → check `.lab/agents/`
   - Missing Docker image → pull or build
   - Auth error → check env vars and config files
3. Record run_id in notebook if helpful for operator visibility, but failed or aborted runs are non-decisive and do not change the baseline.
4. Optionally monitor: `./lab-cli views <run_id> run_progress --json` or `./lab-cli views-live <run_id>`.
5. On completion → recommend `/experiment analyze <run_id>`.

## Variant Description Procedure

When the experiment skill needs to describe what makes two variants different, it follows this procedure. This is used in `analyze` and in notebook entries.

1. Load `resolved_variants.json` from the run directory.
2. For each variant pair, compare the full resolved behavior surface:
   - code provenance: `artifact_digest`, `source_tree_digest`, `source_commit`, `source_branch`, `source_impl`, `dirty`
   - runtime settings: bindings, model/provider, `agent_ref`, command, args, env
   - injected files: config files, workspace patches, dependency file staging
3. Report changed dimensions in two layers:
   - exact provenance delta
   - filtered human-readable diff summary
4. For code mutations: if the artifact manifest has `source_impl`, use `lab-cli impl diff <impl>` (or the equivalent source diff surface) to describe the source changes.
5. Do not require a brittle "single changed hash" test. The job is to package the comparison cleanly and let the agent judge whether the experiment is meaningfully focused.

## Decision Heuristics

### Statistical sufficiency
- N < 10: Cannot draw any conclusions. Directional signal only.
- 10 ≤ N < 25: Can detect large effects (Cohen's h ≥ 0.8).
- 25 ≤ N < 65: Can detect medium effects (h ≥ 0.5).
- N ≥ 65: Can detect small effects (h ≥ 0.2).

### Infra noise vs. signal
- If a run fails mostly because of API errors / timeouts / missing credentials / Docker issues → treat it as non-decisive
- If treatment variant's `tokens_in` is >10x baseline on the same task → possible thrashing, investigate before concluding

### When to pivot vs. continue
- Pivot if: 3+ mutations in the same category rejected (e.g., tried 3 different compaction strategies, none helped)
- Continue if: effect is directional but underpowered (N too small)
- Validate if: 3+ mutations accepted in sequence without re-checking baseline stability

## What's Deferred (Out of Scope)

1. **Worktree/artifact build system** — specified in `docs/experiment-worktree-builds-spec.md`, will be implemented separately. The skill references it for code mutations but doesn't implement the workflow.
2. **Cross-notebook reasoning** — comparing results across benchmarks. Future capability.
3. **`trend` command** — currently broken (`failed to materialize project DuckDB views`). The skill works without it by querying individual run DuckDBs.
4. **Automated re-validation** — periodically re-running the baseline to check for accumulated interaction effects. Noted as a heuristic, not automated.
