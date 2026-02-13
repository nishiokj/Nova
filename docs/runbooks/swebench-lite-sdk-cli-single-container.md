# SWE-bench Lite Runbook: SDK Artifact + CLI Execution (Single Container)

## Non-Negotiable Constraints
1. Experiment artifact generation uses the TypeScript SDK only.
2. Experiment execution is done by CLI only (`lab` runner), not by SDK `run()`.
3. Each trial uses exactly one container created by the Runner.
4. Trial input/output use bind-mounted files (`/out/...`), not stdin piping.
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
docker build -f Dockerfile.rex-harness -t rex-harness:swebench-lite-v1 .
docker image inspect rex-harness:swebench-lite-v1 --format '{{.Id}}'
```

Use that tag (or digest) in `runtime.sandbox.image` of the generated artifact.

## Artifact Generation (SDK Only)
1. Implement a TS script (for example: `scripts/agentlab/generate_swebench_lite_experiment_sdk.ts`).
2. Script uses `ExperimentBuilder` to build `ExperimentSpec`.
3. Script writes YAML to `.lab/experiments/swebench_lite_curated.yaml`.
4. Script exits. It does not execute trials.

## Execution (CLI Only)
Run from `/Users/jevinnishioka/Desktop/jesus`:

```bash
./lab run \
  --experiment .lab/experiments/swebench_lite_curated.yaml \
  --executor local_docker \
  --materialize outputs_only
```

## Trial Mounts and Write Locations
For each trial, Runner creates host dirs under `.lab/runs/<run_id>/trials/<trial_id>/` and binds them:

| Host path | Container path | Writable | Written by |
|---|---|---|---|
| `.../workspace` | `/workspace` | yes | harness/tools |
| `.../state` | `/state` | yes | harness-daemon (events/control/runtime state) |
| `.../dataset` | `/dataset` | no | Runner (pre-trial copy only) |
| `.../out` | `/out` | yes | Runner + harness-daemon (`trial_input.json`, `trial_output.json`) |
| project root | `/harness` | no | read-only harness code/deps |

## Per-Trial Process Sequence (Exact)
1. Runner (host) selects `(task, variant, repl)` and computes `trial_id`.
2. Runner creates trial dirs: `workspace`, `state`, `dataset`, `out`, `tmp`.
3. Runner copies project tree into host `workspace` (filtered copy).
4. Runner copies dataset source into host `dataset`.
5. Runner builds `trial_input_v1` JSON.
6. Runner writes host `out/trial_input.json` (mounted as `/out/trial_input.json`).
7. Runner writes control-plane file in host `state` (mounted as `/state/...`).
8. Runner starts one Docker container with `runtime.sandbox.image`.
9. Runner passes harness command from `runtime.harness.command`.
10. Container starts with cwd `/workspace`.
11. Harness daemon CLI (`run-trial` mode) reads `--input /out/trial_input.json`.
12. Harness daemon starts internal bus server (`127.0.0.1:9555`) inside the same container.
13. Harness daemon creates `HarnessClient` and connects to that local bus.
14. Harness daemon sends `init` with deterministic trial session key.
15. Harness daemon sets model from `trial_input.bindings` via `set_model`.
16. Harness daemon sends prompt via `send_text` from `task.input.prompt` (fallback: `task.prompt`).
17. Harness daemon subscribes to run events and appends JSONL to `--events` path (for example `/state/harness_events.jsonl`).
18. Harness daemon waits for terminal `response`/error condition for that request.
19. Harness daemon assembles `trial_output_v1` and writes `--output /out/trial_output.json`.
20. Harness daemon closes client + bus, exits process.
21. Runner waits for process exit, reads `trial_output.json`, snapshots artifacts/diff.
22. Runner advances to next trial.

## Harness Daemon CLI Contract (New)
Add a trial entrypoint in `harness-daemon`:

```bash
rex-daemon run-trial \
  --input /out/trial_input.json \
  --output /out/trial_output.json \
  --events /state/harness_events.jsonl \
  --working-dir /workspace \
  --config /workspace/config/defaults.agentlab.local.json \
  --graphd-db /state/graphd/graphd.db \
  --master-key /state/rex/master.key \
  --session-key trial_<id> \
  --provider-env openai=OPENAI_API_KEY \
  --provider-env anthropic=ANTHROPIC_API_KEY
```

Required behavior:
1. Reads input file only (no stdin dependence).
2. Writes output file only.
3. Emits event JSONL file.
4. Uses `HarnessClient` interface for init/model/run/event subscription.
5. Exits non-zero on unrecoverable harness startup/runtime failure.

## Provider Credentials / Env Vars Solution
### Runner + Artifact changes
Add to `runtime.harness` in ExperimentSpec:
- `env: Record<string, string>` for non-secret fixed env.
- `env_from_host: string[]` for explicit secret pass-through.

Runner behavior:
1. For each `env_from_host` key, read from host env.
2. If missing, fail trial fast with clear error.
3. Inject both `env` and resolved `env_from_host` into harness process:
   - local mode: `Command::env`.
   - container mode: `docker run -e KEY=VALUE`.

### Harness behavior
1. `run-trial` reads `--provider-env provider=ENV_NAME`.
2. Resolves `ENV_NAME` from process env (already injected by Runner).
3. Saves key via provider path (`providers_save`/LocalProviderManager) before `set_model`.
4. Uses writable trial-local paths:
   - GraphD DB: `/state/graphd/graphd.db`
   - Master key: `/state/rex/master.key`
5. No secret values stored in experiment YAML.

## Required Runner Change: Remove stdin Dependency
In `Experiments/rust/crates/lab-runner/src/lib.rs`:
1. Stop adding Docker `-i` solely for stdin trial input.
2. Stop writing `trial_input.json` bytes to child stdin in `run_process_with_trial_io`.
3. Keep file contracts (`runtime.harness.input_path`, `runtime.harness.output_path`) as the only trial I/O path.

## Benchmark Grading Location
SWE-bench grading adapter runs on the **host** after trials finish. It reads trial artifacts from run dir and writes:
- `benchmark/predictions.jsonl`
- `benchmark/scores.jsonl`
- `benchmark/summary.json`

## Acceptance Criteria
1. Generated artifact comes only from SDK script.
2. `lab run` executes full experiment with one container per trial.
3. No trial relies on stdin for input transfer.
4. Harness command in container reads `/out/trial_input.json` and writes `/out/trial_output.json`.
5. Provider credentials arrive through explicit `env_from_host` pass-through and work without manual interactive setup.
6. Benchmark adapter produces SWE-bench prediction/score artifacts on host.
