# Experiment Worktree Builds — Implementation Spec

## Problem

Code-level experiment mutations (different compaction strategy, different tool backend, parallel vs. linear agents) require building agent artifacts from modified source code. Today, artifacts are built manually — someone builds the project, tars it up, drops it in `.lab/agents/`. There's no systematic way to:

1. Create an isolated code mutation from a known base
2. Build an artifact from it with verifiable provenance
3. Ensure the artifact faithfully represents the source it claims to come from
4. Run experiments comparing artifacts from different code states
5. Feed provenance into the variant identity system so the experiment skill can reason over what ran

This blocks the experiment driver from testing the most valuable category of mutations: harness improvements.

## Design Posture

The experiment skill plan (`docs/experiment-skill-plan.md`) establishes two complementary stances:

- **Exact provenance is strict.** The system must always be able to identify exactly what ran — which source tree, which artifact, which runtime configuration. This is non-negotiable because corrupted provenance silently poisons the progression chain.
- **Mutation hygiene is advisory.** The system packages the comparison cleanly and lets the agent judge whether the experiment is meaningfully focused. It does not enforce "exactly one changed hash" as a brittle validator.

This spec focuses on the strict side: producing artifacts with non-fakeable provenance. The advisory side (judging whether the diff is causally legible) is the experiment skill's job.

## Concepts

### Implementation

An **implementation** is a named, isolated copy of the project source at a specific state — a git worktree checked out to a branch. It represents one version of the agent harness code.

```
.lab/implementations/
  greedy-compaction/          # git worktree → branch exp/greedy-compaction
  parallel-tools/             # git worktree → branch exp/parallel-tools
```

Each implementation is a full working copy of the project. Code changes are made there, builds happen there, and the resulting artifact references the implementation by name.

### Artifact

An **artifact** is a sealed, deployable agent package in `.lab/agents/`. These are either directories or tarballs containing:

```
<artifact-name>/
  manifest.json    # provenance, digests, identity
  bin/
    rex            # the compiled binary or wrapper
  ...              # node_modules, packages, configs, etc.
```

The manifest is the artifact's identity document. It contains derived provenance (computed at build time, not supplied as arguments) and content digests that allow downstream systems to verify what they're running.

### Build

A **build** compiles an implementation into an artifact. The build process:
1. Derives provenance from the source directory's git state (not from arguments)
2. Compiles the project (`bun run build` + binary compilation)
3. Packages output into `.lab/agents/<artifact-name>/` or `.lab/agents/<artifact-name>.tar.gz`
4. Computes content digests of the packaged artifact
5. Writes `manifest.json` with all derived provenance and digests

The critical property: **the build system derives provenance from reality, not from parameters.** The agent cannot tell the build script "this is commit abc123" — the script reads `git rev-parse HEAD` itself.

## Provenance Model

### What the build produces

The manifest captures two categories of identity:

**Source identity** — where the code came from:
- `source_commit` — `git rev-parse HEAD` of the source directory
- `source_branch` — current branch name (if any)
- `source_impl` — implementation name (from `.impl.json`, if building from a worktree)
- `source_base_ref` — the commit the implementation branched from (from `.impl.json`)
- `dirty` — whether the working tree had uncommitted changes at build time
- `source_tree_digest` — a content hash of the exact source state, including uncommitted changes. This is what makes stale detection work even for dirty builds.

**Artifact identity** — what was produced:
- `artifact_digest` — content hash of the sealed artifact (the tarball or directory contents)
- `platform` — target platform (e.g., `linux-x64`)
- `entrypoint` — path to the executable within the artifact

### How digests are computed

**`source_tree_digest`**: Hash of the source state used to build. For clean worktrees, this is the tree hash of HEAD (`git rev-parse HEAD^{tree}`). For dirty worktrees, this incorporates uncommitted changes: `sha256(tree_hash + git_diff_output)`. The point is that two builds from the same exact source state produce the same `source_tree_digest`, and any change — committed or not — produces a different one.

**`artifact_digest`**: Content hash of the final packaged artifact. For tarballs: `sha256sum` of the `.tar.gz` file. For directories: a deterministic hash of directory contents (e.g., `tar cf - --sort=name <dir> | sha256sum`). This is what the experiment system uses as the exact code surface identity of a variant.

### How provenance flows downstream

```
Build script                    lab-cli (package resolution)         Experiment skill
─────────────                   ────────────────────────────         ────────────────
manifest.json                   resolved_variants.json               Lab notebook
  source_commit        →          runtime_overrides.agent.            Baseline:
  source_branch        →            source_commit                       variant_ref = <variant_digest>
  source_impl          →            source_branch                       provenance = artifact=<X>,
  source_tree_digest   →            source_impl                                      source_tree=<Y>,
  artifact_digest      →            bundle_digest                                    commit=<Z>
  dirty                →            source_tree_digest
                                    dirty
                                  variant_digest (derived)            Progression:
                                                                       Compared: baseline=<A> vs treatment=<B>
```

The build script produces the left column. lab-cli copies manifest fields into resolved variants during package resolution. The experiment skill reads resolved variants to populate the notebook and perform variant diffs.

### Manifest schema

```json
{
  "schema_version": "agent_artifact_v2",
  "id": "rex-greedy-compaction",
  "platform": "linux-x64",
  "entrypoint": "bin/rex",
  "frozen_at": "2026-03-10T15:30:00Z",
  "source_commit": "def5678",
  "source_branch": "exp/greedy-compaction",
  "source_impl": "greedy-compaction",
  "source_base_ref": "abc1234",
  "dirty": false,
  "source_tree_digest": "sha256:a1b2c3d4...",
  "artifact_digest": "sha256:e5f6g7h8..."
}
```

Schema version bumped to `v2` to distinguish from current manifests that have `source_commit: "local"` and no digest fields.

## Capabilities Needed

The functionality splits into two categories based on the failure mode analysis:

### Agent-driven (git operations)

These are standard git commands. Failures are loud (command errors, merge conflicts). The agent runs them directly as part of the experiment skill procedures.

| Capability | How | Failure mode |
|-----------|-----|-------------|
| Create worktree from ref | `git worktree add .lab/implementations/<name> -b exp/<name> <ref>` | Loud — branch exists, ref invalid |
| Install deps | `cd <worktree> && bun install` | Loud — install fails |
| List implementations | `git worktree list` + read `.impl.json` files | Loud — parse error |
| Check status | `git -C <worktree> status`, `git rev-list --count` | Loud — not a worktree |
| Diff against base | `git diff <base_ref>..exp/<name>` | Loud — ref not found |
| Diff two implementations | `git diff exp/<a>..exp/<b>` | Loud — ref not found |
| Rebase onto new base | `git -C <worktree> rebase <ref>` | Loud — conflicts |
| Remove worktree | `git worktree remove <path>` | Loud — dirty tree |
| Write `.impl.json` | Agent writes JSON after worktree creation | Low-stakes — metadata only |
| Commit changes | `git -C <worktree> add/commit` | Loud |

No guardrail script needed. The agent manages these as part of the `/experiment author` procedure for code mutations.

### Build-and-seal script (provenance guardrail)

This is where silent failures live. The script's job is **"make it impossible to produce an artifact that lies about what it is."**

**Input:** A source directory (worktree path, or `.` for baseline builds)
**Output:** A sealed artifact in `.lab/agents/` with a correct, derived manifest

The script must:

1. **Derive provenance from git state** — read `HEAD`, branch, dirty status from the source directory. Do not accept these as parameters.
2. **Compute source tree digest** — hash the exact source state, incorporating dirty changes if any.
3. **Run the project build** — `bun run build` (or steps from `.lab/build.json`).
4. **Validate the output** — entrypoint binary exists, platform matches (check ELF header for linux artifacts).
5. **Package the artifact** — tar or directory copy with deterministic structure.
6. **Compute artifact digest** — content hash of the sealed package.
7. **Write manifest** — with all derived fields. Non-negotiable fields: `source_commit`, `source_tree_digest`, `artifact_digest`, `dirty`, `frozen_at`.
8. **Read `.impl.json` if present** — to populate `source_impl`, `source_base_ref`. These are absent for baseline builds from the main tree.

What the script explicitly prevents:
- Building with `source_commit: "local"` (the current state of all manifests)
- Building without `source_tree_digest` (makes stale detection impossible)
- Building without `artifact_digest` (makes same-artifact detection impossible)
- Silently producing a clean manifest from a dirty worktree

What the script warns about but allows:
- Building from a dirty worktree (`dirty: true` in manifest, warning emitted)
- Building without `.impl.json` (baseline build from main tree — `source_impl` is null)

### Preflight integration (lab-cli side)

These checks belong in lab-cli's existing `preflight` command, since they operate on the sealed experiment package:

| Check | Severity | What it catches |
|-------|----------|----------------|
| Two variants reference same `artifact_digest` | **Warning** | Degenerate experiment — measuring nothing |
| Artifact `source_tree_digest` differs from implementation HEAD | **Warning** | Stale artifact — may not reflect current code |
| Manifest `dirty: true` | **Warning** | Build from uncommitted changes — reproducibility risk |
| Manifest missing `artifact_digest` or `source_tree_digest` | **Warning** | Old-format manifest — provenance incomplete |

These are warnings, not hard failures. Consistent with the plan's advisory posture: the system makes the situation visible, the agent decides whether to proceed.

## Implementation Metadata

### `.impl.json`

Written by the agent when creating an implementation. Read by the build script to populate implementation-specific manifest fields.

```json
{
  "name": "greedy-compaction",
  "branch": "exp/greedy-compaction",
  "base_ref": "abc1234",
  "base_branch": "main",
  "created_at": "2026-03-10T15:00:00Z",
  "status": "active"
}
```

### Stale detection

An artifact is stale when `manifest.source_tree_digest` does not match the current source tree digest of the implementation. The build script can report this. The experiment skill should check before authoring an experiment YAML that references the artifact.

## Experiment YAML Integration

### Code mutation experiment (agent_builds format)

The baseline uses the standard artifact (built from `main`). The treatment uses the implementation's artifact.

```yaml
experiment:
  id: bench_v0_greedy_vs_naive_compaction_v0
  name: "Bench v0: Greedy vs Naive Compaction"
  tags: [bench-v0, ab-test, compaction]

benchmark: bench_v0
limit: 25

agent_builds:
  - id: baseline_naive
    artifact: rex-baseline.tar.gz
    command: [rex, run, --dangerous]
    io: { input: --input-file, output: --output }
    bindings_to_args:
      - binding: model_provider
        flag: --provider
      - binding: model
        flag: --model

  - id: treatment_greedy
    artifact: rex-greedy-compaction.tar.gz
    command: [rex, run, --dangerous]
    io: { input: --input-file, output: --output }
    bindings_to_args:
      - binding: model_provider
        flag: --provider
      - binding: model
        flag: --model

variants:
  - id: naive_compaction
    baseline: true
    agent_ref: baseline_naive
    config:
      model_provider: z.ai-coder
      model: glm-5

  - id: greedy_compaction
    agent_ref: treatment_greedy
    config:
      model_provider: z.ai-coder
      model: glm-5

overrides:
  network: full
  root_read_only: false
```

Both variants use the same model/provider. The only difference is `agent_ref` — which artifact runs. This is a pure code comparison.

### Resolved variant provenance

lab-cli copies manifest fields into `resolved_variants.json` during package resolution:

```json
{
  "id": "greedy_compaction",
  "bindings": { "model": "glm-5", "model_provider": "z.ai-coder" },
  "runtime_overrides": {
    "agent": {
      "bundle": "agent_builds/001_rex-greedy-compaction.tar.gz",
      "bundle_digest": "sha256:e5f6g7h8...",
      "source_impl": "greedy-compaction",
      "source_commit": "def5678",
      "source_branch": "exp/greedy-compaction",
      "source_tree_digest": "sha256:a1b2c3d4...",
      "dirty": false
    }
  }
}
```

The experiment skill uses these fields to:
- Describe what the variant IS (human-readable, for the notebook)
- Compute exact provenance deltas between baseline and treatment
- Populate `variant_ref` / `variant_digest` in the notebook's Baseline section

## Workflow: Code Mutation Experiment (End to End)

```
1. Hypothesis: "Greedy compaction will reduce token usage by 30% because
   it prioritizes retaining high-salience items over FIFO ordering."

2. Create implementation:
   $ git worktree add .lab/implementations/greedy-compaction -b exp/greedy-compaction main
   # Agent writes .impl.json

3. Make code changes:
   # Agent edits files in .lab/implementations/greedy-compaction/
   $ git -C .lab/implementations/greedy-compaction add -A && git -C ... commit -m "..."

4. Build artifact (via build-and-seal script):
   $ scripts/build-artifact.sh .lab/implementations/greedy-compaction
   # → .lab/agents/rex-greedy-compaction.tar.gz
   # → manifest.json with derived provenance + digests

5. Describe what changed:
   $ git diff abc1234..exp/greedy-compaction --stat
   # → compaction.ts: replaced FIFO eviction with salience-scored greedy eviction

6. Author experiment YAML:
   # → bench_v0_greedy_vs_naive_compaction_v0.yaml (as above)

7. Validate:
   $ ./lab-cli build <yaml> --json     # compiles
   $ ./lab-cli preflight <pkg> --json  # checks provenance warnings

8. Run experiment:
   $ ./lab-cli build-run <yaml>

9. Analyze results:
   $ ./lab-cli views <run_id> --all --json

10. Decision:
   - If accepted → merge exp/greedy-compaction into main,
     rebuild baseline: scripts/build-artifact.sh .
   - If rejected → git worktree remove .lab/implementations/greedy-compaction
   - Update lab notebook with result, provenance, and variant refs
```

## Baseline Artifact Management

The "current best" artifact is rebuilt when the baseline advances (mutation accepted and merged into main).

```
$ git merge exp/greedy-compaction                    # merge the improvement
$ scripts/build-artifact.sh .                        # build baseline from main
  # → .lab/agents/rex-baseline.tar.gz with new source_commit, digests
$ git worktree remove .lab/implementations/greedy-compaction  # clean up worktree
$ git branch -d exp/greedy-compaction                # clean up branch
# artifact rex-greedy-compaction.tar.gz kept — past runs reference it
```

## Directory Layout

```
.lab/
  implementations/
    greedy-compaction/          # git worktree (full project copy)
      .impl.json                # implementation metadata
      packages/...              # the actual source code
    parallel-tools/
      .impl.json
      packages/...
  agents/
    rex-baseline.tar.gz         # baseline artifact (built from main)
    rex-greedy-compaction.tar.gz # treatment artifact (built from impl)
    rex-parallel-tools/          # can also be a dir artifact
  experiments/
    bench_v0_greedy_vs_naive_compaction_v0.yaml
  notebooks/
    bench_v0.md
    swebench_lite_curated.md
  runs/
    run_.../
scripts/
  build-artifact.sh             # build-and-seal script
```

## Build Configuration (`.lab/build.json`)

Optional config for customizing the build process per project:

```json
{
  "schema_version": "build_config_v1",
  "steps": [
    { "cmd": "bun install", "cwd": "." },
    { "cmd": "bun run build", "cwd": "." }
  ],
  "compile": {
    "cmd": "bun build packages/apps/launcher/index.ts --compile --target=bun-linux-x64 --outfile bin/rex",
    "cwd": "."
  },
  "package": {
    "format": "tar.gz",
    "entrypoint": "bin/rex",
    "include": ["bin/", "manifest.json"],
    "platform": "linux-x64"
  },
  "baseline_artifact_name": "rex-baseline"
}
```

If absent, `build-artifact.sh` uses hardcoded defaults based on the rex project's build chain.

## Implementation Notes

### Git Worktree Mechanics

- Worktrees share the same `.git` — no repo duplication
- Branches are lightweight — only the checkout is separate
- `bun install` with shared lockfile should reuse cached modules
- Worktrees can't check out the same branch as another worktree — enforce unique branch names via `exp/<name>` convention

### Cross-Platform Builds

Agent artifacts run in Docker containers (Linux). Building on macOS requires cross-compilation:
- `bun build --target=bun-linux-x64` handles this for Bun binaries
- Node modules with native dependencies may need Linux-specific builds
- v1 can assume `--target=bun-linux-x64` and validate with `file bin/rex` (should show ELF)

### Artifact Naming

Convention: `rex-<impl-name>.<format>`
- `rex-baseline.tar.gz` — the current best (built from main)
- `rex-greedy-compaction.tar.gz` — built from the greedy-compaction implementation
- `rex-parallel-tools/` — dir format for faster iteration

### Silent Failure Modes (Why the Build Script Exists)

Without a guardrail script, these failures are silent — the experiment runs, data is collected, but the results are meaningless:

| Failure | What happens | How the script prevents it |
|---------|-------------|---------------------------|
| Stale artifact (built from old commit) | Runs fine, wrong code | `source_tree_digest` derived at build time; preflight detects staleness |
| Both variants use same artifact | Runs fine, measures nothing | `artifact_digest` in manifest; preflight warns on identical digests |
| Manifest says commit X, actually commit Y | Can't reproduce, can't trace | Script reads `git rev-parse HEAD` itself — provenance is derived, not parameterized |
| Dirty worktree built without noting it | Can't reproduce | Script reads `git status --porcelain` — sets `dirty: true` automatically |
| Forgot to rebuild after code change | Old binary, provenance says one thing, behavior is another | `source_tree_digest` changes when source changes; stale detection catches mismatch |

Loud failures (wrong platform binary, missing entrypoint, tarball structure wrong) are self-correcting — the container crashes, the agent fixes it. Silent failures are why the build script is the one piece that must be automated rather than left to agent judgment.

## Future Extensions

- **`merge-into-baseline` workflow** — automate the accept workflow (merge + rebuild + cleanup)
- **Cross-notebook reasoning** — compare results across benchmarks for the same implementation
- **Artifact registry** — push/pull artifacts to shared storage for CI or multi-machine experiments
- **Composite implementations** — combine multiple independent implementations (if independence assumption holds)
