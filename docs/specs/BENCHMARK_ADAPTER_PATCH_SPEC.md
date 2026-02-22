# Benchmark Execution Patch Spec

## North Star Usage

### Build the experiment

```typescript
const exp = ExperimentBuilder.create('swebench_ab_glm5_vs_codex', 'SWE-bench A/B: GLM-5 vs Codex Spark')
  .datasetJsonl('.lab/experiments/data/swebench_lite.jsonl', {
    suiteId: 'swebench_lite', schemaVersion: 'task_boundary_v2', splitId: 'test', limit: 50,
  })
  .agentArtifact('.lab/agents/rex-feb22.tar.gz')           // Frozen agent
  .grading({
    script: '.lab/grading/swebench/run.sh',                 // User-provided grade script
    assets: '.lab/grading/swebench/assets/',                 // User-provided per-task grade data
    output: '/out/grade.json',
  })
  .baseline('glm_5', { model_provider: 'z.ai-coder', model: 'glm-5' })
  .addVariant('codex_spark', { model_provider: 'codex', model: 'gpt-5.3-codex-spark' })
  .replications(3)
  .timeoutMs(1_800_000)
  .build();
```

### Prepare and validate

```bash
# Freeze the agent from local installation
lab agent freeze --from . --target linux-x64 --out .lab/agents/rex-feb22.tar.gz

# Pull all task images referenced in dataset, validate everything
lab preflight experiment.yaml

# Output:
#   [check] agent artifact: .lab/agents/rex-feb22.tar.gz (42MB, linux-x64)
#   [check] entrypoint: bin/rex — found, executable
#   [check] dataset: 50 tasks, all have 'image' field
#   [check] task images: 47/50 cached, pulling 3...
#   [check] grade script: .lab/grading/swebench/run.sh — found, executable
#   [check] grade assets: 50/50 tasks have matching asset dirs
#   [smoke] injecting agent into swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest
#   [smoke] bin/rex --version → rex 0.9.1 ✓
#   [smoke] bin/rex run --dry-run --input-file /in/task.json → produces /out/result.json schema ✓
#   [smoke] bash /grade/run.sh --dry-run → produces /out/grade.json schema ✓
#   preflight passed: 50 tasks, 2 variants, 3 replications = 300 trials
```

### Run

```bash
lab run experiment.yaml --concurrent 10
```

### Results

```
lab views <run_id> variant_summary

┌──────────────┬───────┬──────────────┬──────────────────┐
│ variant_id   │ total │ resolve_rate │ avg_latency_ms   │
├──────────────┼───────┼──────────────┼──────────────────┤
│ glm_5        │   150 │       0.3200 │         142300.5 │
│ codex_spark  │   150 │       0.3867 │         118450.2 │
└──────────────┴───────┴──────────────┴──────────────────┘
```

---

## Core Principles

1. **The framework defines file schemas and path conventions. The user fills them in.**
   No benchmark-specific code in the runner. No SWE-bench adapter trait.
   Same pattern as input: user writes a conversion script → JSONL.
   For grading: user provides a grade script + assets → grade.json.

2. **Agent is frozen at experiment build time.**
   `lab agent freeze` produces a portable Linux artifact. Same bytes every trial.
   No registry fetches, no installs, no network at trial time.

3. **Task images are pre-pulled at prep time, not per trial.**
   Dataset JSONL includes an `image` field per task. `lab preflight` pulls them all upfront.

4. **Single container per trial.**
   Task image is the base. Frozen agent is copied in. Agent runs. Grading runs. Container destroyed.
   No two-container model. No proxy. No socket.

5. **Build-time validation catches failures before the experiment starts.**
   Architecture compatibility, dependency resolution, contract compliance — all verified before
   committing to a multi-hour run.

---

## What The User Provides

The framework is benchmark-agnostic. The user provides three things, all as files:

### 1. Dataset JSONL (already exists, extended with `image` field)

```json
{
  "schema_version": "task_boundary_v2",
  "task": {
    "id": "swebench_astropy_astropy_12907",
    "image": "swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest",
    "workspace": "/testbed",
    "input": {
      "prompt": "Modeling's separability_matrix does not compute separability correctly..."
    }
  }
}
```

New fields vs v1:
- `task.image` — container image for this task (runner reads it, doesn't interpret it)
- `task.workspace` — working directory inside the container (runner sets `$WORKSPACE`)

The user's conversion script (their "adapter") is responsible for populating these from
whatever benchmark source they use. For SWE-bench: read from HuggingFace, compute image
name from instance_id (`__` → `_1776_`), set workspace to `/testbed`.

### 2. Frozen agent artifact

```
.lab/agents/rex-feb22.tar.gz
├── bin/
│   ├── bun                    # Linux bun binary
│   └── rex                    # Entry script
├── app/                       # Built application
│   ├── node_modules/
│   ├── packages/
│   └── ...
└── manifest.json              # Artifact metadata
```

`manifest.json`:
```json
{
  "schema_version": "agent_artifact_v1",
  "id": "rex",
  "version": "0.9.1",
  "platform": "linux-x64",
  "entrypoint": "bin/rex",
  "frozen_at": "2026-02-22T10:30:00Z",
  "source_commit": "147d6e5"
}
```

Built by `lab agent freeze`. Produces a self-contained Linux artifact from the local
installation. This is the ONLY version of the agent that runs during the experiment.

### 3. Grading script + per-task assets

```
.lab/grading/swebench/
├── run.sh                          # The grade script (same for all tasks)
└── assets/
    ├── astropy__astropy-12907/
    │   ├── test_patch.diff
    │   ├── fail_to_pass.json
    │   ├── pass_to_pass.json
    │   └── test_directives.txt
    ├── django__django-16379/
    │   └── ...
    └── ...
```

The user builds this directory. For SWE-bench: pull grading fields from HuggingFace,
write per-task asset directories. The grade script is whatever they want — the framework
just executes it and reads the output.

---

## Runner Changes

### Container lifecycle (the only structural change)

**Current:**
```
docker run --rm {image} {agent_command}
```

**After:**
```
docker create {task_image} tail -f /dev/null         → container_id
docker start  {container_id}
docker cp     {agent_artifact}  {container_id}:/opt/agent/
docker cp     {task_input}      {container_id}:/in/
docker cp     {grade_script}    {container_id}:/grade/run.sh
docker cp     {grade_assets}    {container_id}:/grade/data/
docker exec   {container_id}    {agent_command}       # Agent phase
docker exec   {container_id}    {grade_command}       # Grade phase (if configured)
docker cp     {container_id}:/out/. {trial_dir}/out/  # Collect
docker rm -f  {container_id}                           # Cleanup
```

### Image resolution

**Current:** `request.runtime.image` — one value for all trials.

**After:** If experiment config sets `image_source: per_task`, runner reads `task.image`
from the task JSONL record for each trial. Falls back to global `runtime.image` if field
is absent (backwards compatible).

### Environment variables set by runner

Agent phase:
```
TASK_PROMPT=/in/task.json           # Read task input from here
WORKSPACE=/testbed                  # Value from task.workspace field
RESULT_PATH=/out/result.json        # Write result here
AGENT_DIR=/opt/agent                # Where agent artifact was extracted
```

Grade phase:
```
WORKSPACE=/testbed                  # Same workspace, now modified by agent
OUTPUT_DIR=/out                     # Where agent wrote result.json
GRADE_DATA=/grade/data              # Per-task grading assets
GRADE_RESULT=/out/grade.json        # Write grade result here
```

### Agent command resolution

The experiment config specifies the command template. Runner substitutes paths:

```yaml
runtime:
  agent:
    artifact: .lab/agents/rex-feb22.tar.gz
    command: ["/opt/agent/bin/rex", "run",
              "--input-file", "/in/task.json",
              "--working-dir", "${WORKSPACE}",
              "--output", "/out/result.json"]
```

### Result collection

**Current:** Read `result.json` only.

**After:** Read `result.json` + `grade.json` (if grade phase was configured).
`grade.json` is parsed into existing `benchmark_score_record_v1` schema.
Written to `trial_dir/grade.json` and appended to `run_dir/scores.jsonl`.

---

## Build-Time Sanity Checks (`lab preflight`)

### Phase 1: Static validation (no containers, fast)

| Check | What | Catches |
|-------|------|---------|
| **Artifact exists** | `agent_artifact` path exists and is a valid tar.gz | Typos, missing builds |
| **Manifest valid** | `manifest.json` inside artifact has required fields | Corrupt or outdated artifacts |
| **Platform match** | `manifest.platform` is `linux-x64` (or matches task image arch) | macOS binary in Linux container |
| **Entrypoint exists** | `manifest.entrypoint` file exists inside artifact, is executable | Broken builds |
| **Dataset schema** | Every JSONL row validates against `task_boundary_v2` | Missing fields, schema drift |
| **Image fields present** | Every task has `task.image` (if `image_source: per_task`) | Tasks that would fail at trial time |
| **Grade script exists** | `grading.script` path exists and is executable | Missing grade script |
| **Grade assets complete** | For every `task.id` in dataset, a matching directory exists in `grading.assets/` | Tasks that would have no grading data |
| **Grade asset contents** | Each asset directory contains expected files (non-empty) | Incomplete grading data |
| **Experiment schema** | Resolved experiment config validates against schema | Config errors |

### Phase 2: Image availability (network, parallelizable)

| Check | What | Catches |
|-------|------|---------|
| **Image pull** | Every unique `task.image` in dataset exists locally or can be pulled | Missing images, registry issues |
| **Image platform** | Pulled images match expected platform (linux/amd64) | ARM vs x86 mismatch |
| **Dedup report** | Count unique images vs total tasks (SWE-bench: ~60 env images shared across ~300 tasks) | Helps estimate disk/pull time |

### Phase 3: Smoke test (starts one container, slow but catches real failures)

Pick one task at random (or first task). Run the full trial lifecycle in dry-run mode:

| Check | What | Catches |
|-------|------|---------|
| **Container starts** | `docker create` + `docker start` succeeds with task image | Image format issues, Docker daemon problems |
| **Agent injection** | `docker cp` of artifact + extract succeeds | Permission issues, path conflicts |
| **Agent starts** | `docker exec {entrypoint} --version` returns 0 | Missing shared libraries, broken runtime |
| **Dependency check** | `docker exec ldd {entrypoint}` — all libs resolved | libc mismatch, missing system deps |
| **Input contract** | `docker exec {agent_command} --dry-run` with minimal task input produces `/out/result.json` | Agent doesn't understand the input format |
| **Result schema** | Output `result.json` validates against `agent_result_v1` | Agent produces wrong schema |
| **Grade contract** | `docker exec bash /grade/run.sh --dry-run` produces `/out/grade.json` | Grade script fails in this environment |
| **Grade schema** | Output `grade.json` validates against `benchmark_score_record_v1` | Grade script produces wrong schema |
| **Cleanup** | `docker rm -f` succeeds | Container leak |

### Phase 3 requirements on agent and grade script

For smoke tests to work, the agent entrypoint must support:
- `--version` — print version and exit (validates runtime works)
- `--dry-run` — accept input, produce a valid but empty result.json without actually running (validates contract)

The grade script must support:
- `--dry-run` — produce a valid but placeholder grade.json without running tests (validates contract)

These are not optional. If your agent doesn't support `--dry-run`, preflight can only
verify up to "agent starts." You'll discover input/output contract issues at trial time.

---

## Existing Infrastructure Reused (no changes needed)

| Component | Why unchanged |
|-----------|---------------|
| Scheduling engine | Doesn't care where the container image comes from |
| Variant management | Variants are bindings, not container config |
| Experiment design (paired, sweep, etc.) | Operates on trial results, source-agnostic |
| `benchmark_score_record_v1` schema | Already defined, grade.json conforms to it |
| `benchmark_summary_v1` schema | Already defined, aggregated from scores.jsonl |
| ViewSets (AbTest, MultiVariant, etc.) | SQL views, just need grade data in the tables |
| Sink interface | Writes trial data, adding grade field is additive |
| Evidence recording | Already collects artifacts from /out/ |

---

## Changes Required Per Crate

### lab-schemas

```
ADDED:
  AgentArtifactManifest {
    schema_version: "agent_artifact_v1",
    id: String,
    version: String,
    platform: String,              // "linux-x64"
    entrypoint: String,            // "bin/rex"
    frozen_at: String,             // ISO 8601
    source_commit: Option<String>,
  }

  GradingConfig {
    script: PathBuf,               // Host path to grade script
    assets: PathBuf,               // Host path to per-task asset dirs
    output: String,                // Container path for grade output (default: /out/grade.json)
  }

MODIFIED:
  RuntimeConfig:
    + agent_artifact: Option<PathBuf>      // Path to frozen agent tar.gz
    + image_source: ImageSource            // PerTask | Global(String), default Global
    + grading: Option<GradingConfig>
```

### lab-core

```
ADDED constants:
  AGENT_DIR: &str = "/opt/agent"
  GRADE_SCRIPT: &str = "/grade/run.sh"
  GRADE_DATA_DIR: &str = "/grade/data"
  GRADE_RESULT_PATH: &str = "/out/grade.json"
```

### lab-runner

```
MODIFIED: run_builtin_adapter_container()
  Container lifecycle: docker run --rm → docker create/start/exec/cp/rm
  Image resolution: global image → per-task task.image field (if image_source == PerTask)
  Agent delivery: baked into image → docker cp frozen artifact into container
  Post-agent: nothing → docker exec grade script (if grading configured)
  Result collection: result.json → result.json + grade.json

ADDED: preflight validation
  lab preflight <experiment.yaml>
  Runs Phase 1 (static) + Phase 2 (images) + Phase 3 (smoke test)

ADDED: agent freeze
  lab agent freeze --from <project_dir> --target <platform> --out <artifact_path>
  Packages project into portable tar.gz with manifest.json
```

### lab-analysis

```
ADDED DuckDB view:
  CREATE VIEW grades AS
  SELECT * FROM read_json_auto('{run_dir}/trials/*/out/grade.json', filename=true, union_by_name=true)

MODIFIED: variant_summary view
  Prefers grade.resolved over self-reported metrics.success when grade data exists.
  Falls back to metrics.success for non-graded experiments.

MODIFIED: AbTest views (ab_test.sql)
  paired_outcomes, effect_size, win_loss_tie reference grade.resolved when available.
```

### agentlab-sdk (TypeScript)

```
MODIFIED: ExperimentBuilder
  .agentArtifact(path)         // Sets runtime.agent_artifact
  .grading({ script, assets, output })  // Sets runtime.grading

  No Benchmarks.SWEBenchLite(). No adapter registry. User provides files.
```

---

## What The User's SWE-bench Setup Script Produces

The user writes ONE script (their "adapter") that runs at experiment prep time. Not part of the framework:

```bash
#!/bin/bash
# prepare_swebench.sh — user-owned, benchmark-specific

# 1. Build dataset JSONL with image fields
python3 build_swebench_dataset.py \
  --source princeton-nlp/SWE-bench_Lite \
  --split test \
  --limit 50 \
  --out .lab/experiments/data/swebench_lite.jsonl
# Each row gets: task.image = "swebench/sweb.eval.x86_64.{sanitized_id}:latest"
#                task.workspace = "/testbed"

# 2. Build grading assets from HuggingFace dataset
python3 build_swebench_grading.py \
  --source princeton-nlp/SWE-bench_Lite \
  --split test \
  --limit 50 \
  --script-template grading_templates/swebench_run.sh \
  --out .lab/grading/swebench/
# Produces: run.sh + assets/{instance_id}/ per task

# 3. Freeze agent
lab agent freeze --from . --target linux-x64 --out .lab/agents/rex-feb22.tar.gz

# 4. Validate everything
lab preflight experiment.yaml
```

The framework never sees "SWE-bench." It sees: a JSONL with image fields, a tar.gz agent artifact,
a grade script with asset directories. Generic inputs, generic execution.

---

## Backwards Compatibility

| Mode | Image | Agent | Grading | Behavior |
|------|-------|-------|---------|----------|
| **Legacy** (current) | Global `runtime.image` | Baked into image | None (self-reported) | Unchanged, all existing experiments work |
| **Per-task + artifact** | `task.image` from JSONL | Frozen artifact, docker cp'd in | Optional grade script | New capability |
| **Per-task + artifact + grading** | `task.image` from JSONL | Frozen artifact | Grade script + assets | Full north star |

No breaking changes. `image_source` defaults to `Global`. `agent_artifact` defaults to None (use image).
`grading` defaults to None (no grade phase). Existing experiments see zero difference.

---

## Trial Lifecycle (complete, no hand-waving)

```
runner: task_record = read task JSONL row for this trial
runner: task_image = task_record["task"]["image"]
runner: workspace = task_record["task"]["workspace"]    # e.g. "/testbed"
runner: task_id = task_record["task"]["id"]

runner: container_id = docker create {task_image} tail -f /dev/null
runner: docker start {container_id}

runner: docker cp {agent_artifact.tar.gz} {container_id}:/tmp/agent.tar.gz
runner: docker exec {container_id} tar xzf /tmp/agent.tar.gz -C /opt/agent

runner: docker cp {trial_dir}/in/task.json {container_id}:/in/task.json

runner: if grading configured:
          grade_asset_dir = {grading.assets}/{task_id}/
          docker cp {grading.script}    {container_id}:/grade/run.sh
          docker cp {grade_asset_dir}/. {container_id}:/grade/data/

runner: docker exec {container_id} \
          -e TASK_PROMPT=/in/task.json \
          -e WORKSPACE={workspace} \
          -e RESULT_PATH=/out/result.json \
          {agent_command}
        # Agent runs, has full access to task deps, modifies workspace

runner: if grading configured:
          docker exec {container_id} \
            -e WORKSPACE={workspace} \
            -e OUTPUT_DIR=/out \
            -e GRADE_DATA=/grade/data \
            -e GRADE_RESULT=/out/grade.json \
            bash /grade/run.sh
          # Grade script runs in same container, same modified state

runner: docker cp {container_id}:/out/. {trial_dir}/out/
runner: docker rm -f {container_id}

runner: result = parse {trial_dir}/out/result.json as agent_result_v1
runner: grade = parse {trial_dir}/out/grade.json as benchmark_score_record_v1 (if exists)
runner: sink.write(trial_id, result, grade)
```

Every path is known. Every file is written by a known actor. No discovery, no negotiation.
