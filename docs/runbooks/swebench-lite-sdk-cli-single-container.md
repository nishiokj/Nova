# SWE-bench Lite Runbook: Artifact + CLI Execution (Single Container)

## Non-Negotiable Constraints
1. Experiment artifact generation uses the build script only (no inline manual editing).
2. Experiment execution is done by CLI only (`lab` runner), not by SDK `run()`.
3. Each trial uses exactly one container created by the Runner.
4. Trial payload/result use runner-provided files and env (`AGENTLAB_*`), not stdin piping.
5. No separate trial-driver container exists.

## Terminology
- **Host**: the machine/process running `lab` and Docker (outside the trial container).
- **Trial container**: the single sandbox container started by the Runner for one trial.
- **Harness process**: `harness-daemon` CLI process started inside that trial container by the Runner command.

## System Boundaries
- Runner location: **host**.
- Docker engine location: **host**.
- Harness daemon location: **inside the trial container**.
- Benchmark adapter location: **host**, after trial execution.

## One-Time Image Build (Host)
Run this in `/Users/jevinnishioka/Desktop/jesus` before any trial execution:

```bash
bash scripts/agentlab/build_agent_image.sh --tag rex-harness:swebench-lite
docker image inspect rex-harness:swebench-lite --format '{{.Id}}'
```

Use that tag (or digest) in `runtime.policy.sandbox.image` of the generated artifact.

## One-Time SWE-bench Evaluator Setup (Host)

```bash
bash scripts/agentlab/setup_swebench_evaluator.sh
export AGENTLAB_SWEBENCH_PYTHON=/Users/jevinnishioka/Desktop/jesus/.venv_swebench/bin/python
```

## Artifact Generation (Build Script Only)
1. Use the builder script (for example: `scripts/agentlab/build_swebench_curated_ab_experiment.mjs`).
2. Script resolves benchmark profile, runtime policy, and dependency staging.
3. Script writes the experiment artifact to `.lab/experiments/swebench_lite_curated_glm5_vs_codex_spark.yaml` (or the configured output path).
4. Script exits. It does not execute trials.

## Execution (CLI Only)
Run from `/Users/jevinnishioka/Desktop/jesus`:

```bash
AGENTLAB_LIMIT=1 bash scripts/agentlab/run_curated_experiment.sh
```

## Trial Mounts and Write Locations
For each trial, Runner creates host dirs under `.lab/runs/<run_id>/trials/<trial_id>/` and binds them:

| Host path | Container path | Writable | Written by |
|---|---|---|---|
| `.../workspace` | `/workspace` | yes | harness/tools |
| `.../state` | `/state` | yes | harness-daemon (events/control/runtime state) |
| `.../dataset` | `/dataset` | no | Runner (pre-trial copy only) |
| `.../out` | `/out` | yes | Runner + harness-daemon (task/bindings payloads, `result.json`) |
| project root | `/harness` | no | read-only harness code/deps |

## Per-Trial Process Sequence (Exact)
1. Runner (host) selects `(task, variant, repl)` and computes `trial_id`.
2. Runner creates trial dirs: `workspace`, `state`, `dataset`, `out`, `tmp`.
3. Runner copies project tree into host `workspace` (filtered copy).
4. Runner copies dataset source into host `dataset`.
5. Runner builds task + bindings payload JSON files.
6. Runner sets `AGENTLAB_TASK_PATH`, `AGENTLAB_BINDINGS_PATH`, `AGENTLAB_RESULT_PATH`, and `AGENTLAB_TRAJECTORY_PATH` env vars.
7. Runner writes control-plane file in host `state` (mounted as `/state/...`).
8. Runner starts one Docker container with `runtime.policy.sandbox.image`.
9. Runner passes the runtime command from `runtime.agent.*`.
10. Container starts with cwd `/workspace`.
11. Harness daemon CLI (`run` mode) reads task/bindings from explicit flags.
12. Harness daemon starts internal bus server (`127.0.0.1:9555`) inside the same container.
13. Harness daemon creates `HarnessClient` and connects to that local bus.
14. Harness daemon sends `init` with deterministic trial session key.
15. Harness daemon sets model from the bindings payload via `set_model`.
16. Harness daemon sends prompt via `send_text` from `task.input.prompt` (fallback: `task.prompt`).
17. Harness daemon subscribes to run events and appends JSONL to `AGENTLAB_TRAJECTORY_PATH`.
18. Harness daemon waits for terminal `response`/error condition for that request.
19. Harness daemon assembles `agent_result_v1` and writes `AGENTLAB_RESULT_PATH` (for example `/out/result.json`).
20. Harness daemon closes client + bus, exits process.
21. Runner waits for process exit, reads `result.json`, snapshots artifacts/diff.
22. Runner advances to next trial.

## Harness Daemon CLI Contract (Current)
The runtime entrypoint is:

```bash
rex run \
  --input-file ${AGENTLAB_TASK_PATH} \
  --bindings-file ${AGENTLAB_BINDINGS_PATH} \
  --output ${AGENTLAB_RESULT_PATH} \
  --events ${AGENTLAB_TRAJECTORY_PATH}
```

Required behavior:
1. Reads task + bindings payload files from explicit CLI flags (`--input-file`, `--bindings-file`).
2. Writes `agent_result_v1` JSON to the explicit `--output` path.
3. Emits trajectory JSONL to the explicit `--events` path when configured.
4. Uses `HarnessClient` interface for init/model/run/event subscription.
5. Exits non-zero on unrecoverable harness startup/runtime failure.

## Provider Credentials / Dependency Staging
### Runner + Artifact behavior
Use `runtime.dependencies.file_staging` for credential/state files that must exist in the container (for example GraphD DB and Rex master key). Optional non-file env can still be injected via `runtime.agent.overrides.env` / `env_from_host`.

Runner behavior:
1. Materializes staged files before process launch.
2. Fails the trial fast when a required staged file is missing.
3. Injects configured env overrides for the runtime process.

### Harness behavior
1. Uses staged credential/state files from the mounted dependency paths.
2. Uses `set_model` after loading task/bindings payloads.
3. Does not require inline secret values in experiment YAML.

## Runner I/O Boundary (Current)
1. Runner does not send task payload over stdin.
2. Runner executes runtime command with file/env contract only.
3. `result.json` is the canonical per-trial output artifact.

## Benchmark Grading Location
SWE-bench grading adapter runs on the **host** after trials finish. The experiment builder wires:

```yaml
benchmark:
  adapter:
    command:
      - python3
      - scripts/agentlab/swebench_official_benchmark_adapter.py
      - --benchmark-name
      - swebench_lite_curated
      - --dataset-name
      - princeton-nlp/SWE-bench_Lite
      - --split
      - test
```

Adapter behavior:
1. Maps trial evidence to SWE-bench prediction records.
2. Invokes official evaluator: `python -m swebench.harness.run_evaluation`.
3. Writes AgentLab benchmark artifacts:
- `benchmark/predictions.jsonl`
- `benchmark/scores.jsonl`
- `benchmark/summary.json`

Current boundary caveat:
- If no valid patch can be extracted from trial artifacts, adapter marks trial `verdict=missing` (official evaluator cannot score an empty patch).

## Acceptance Criteria
1. Generated artifact comes only from the build script.
2. `lab run` executes full experiment with one container per trial.
3. No trial relies on stdin for input transfer.
4. Harness command in container reads runner-provided task/bindings paths and writes `result.json`.
5. Provider credentials/state are available through explicit file staging and env overrides, without inline secrets in experiment YAML.
6. Benchmark adapter produces SWE-bench prediction/score artifacts on host.
