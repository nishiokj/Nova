# Metarepo Implementation Spec

## Summary

`metarepo` is a single application boundary for repo-aware agent workflows.

It is **service-first only**:

- blue-team uses `metarepo`
- red-team uses `metarepo`
- red-team mutation/referee uses `metarepo`
- review uses `metarepo`

It is **not** a persistent live entity-graph service.

Instead:

- repo metadata, run metadata, artifacts, ledgers, bugs, and secret references are durable
- entity graphs are ephemeral, derived run state
- each workflow run builds a graph from a concrete filesystem snapshot
- artifacts are stamped with source metadata rather than pretending to stay fresh forever

This keeps the application state useful while avoiding the operational cost and correctness traps of maintaining a continuously synchronized graph.

## Problem

We currently have the right primitives in the wrong boundary shape.

- `entity-graph` and `test-health` already implement the structural analysis core
- PR review has a deployable service shell, but it is too narrow and still product-shaped
- blue-team assumes repo-local CLI and repo-local graph lifecycle
- red-team is split between local heuristics, CLI access, filesystem artifacts, and referee handoffs
- the current service boundary still carries product-specific naming and deployment assumptions

The result is duplicated runtime assumptions, fragmented deployment, and no single control plane for durable repo artifacts.

## Goals

1. Create one application boundary called `metarepo`.
2. Make all repo-aware workflows service-first with no local fallback.
3. Build entity graphs from the real repo filesystem on demand.
4. Persist artifacts and operational metadata in one place.
5. Allow multiple workflows to share durable context without pretending the graph itself is durable.
6. Keep freshness semantics honest: derived graph state is scoped to a run.

## Non-Goals

This spec does not require:

- continuously synchronized graph state
- persistent raw AST storage
- guaranteed live filesystem watchers for all edit sources
- serving cached graph content across app restarts in v1
- broad query-engine rewrites
- full workflow orchestration DAGs in v1

## Design Decision

### Durable state

`metarepo` persists:

- repo records
- run records
- event ledger entries
- workflow artifacts
- mutation proposals
- mutation results / referee results
- bug records
- test-health reports and summaries
- secret references and environment profiles

### Ephemeral state

`metarepo` does **not** persist the graph as a long-lived source of truth.

For each run:

1. resolve a concrete source root on disk
2. create an ephemeral graph database for the run
3. run `buildFullGraph(...)`
4. execute the requested workflow(s)
5. persist outputs as artifacts
6. destroy the ephemeral graph database

This means graph freshness is simple:

- if a workflow needs graph-backed analysis, it builds from source at run start
- if source changes after the run starts, the run is only guaranteed relative to the source snapshot it started from

## Why This Over A Live Graph

We do **not** want v1 to rely on “keep the graph synchronized with the filesystem.”

That model would require:

- generic edit detection beyond agent hooks
- restart reconciliation
- file fingerprinting / invalidation
- transactional update journal semantics
- strong staleness guarantees

The current code does not provide that level of guarantee.

By rebuilding from source on demand, we get:

- simpler correctness model
- fewer crash-recovery edge cases
- no dependence on perfect watcher coverage
- a clear source of truth: filesystem or git checkout

## Source Model

`metarepo` works against real source trees on disk.

It supports two source modes.

### 1. Local repo mode

The repo record stores an absolute local root path.

Example:

```json
{
  "repo_id": "repo_123",
  "source_kind": "local",
  "root_path": "/Users/alice/code/project"
}
```

In this mode:

- `metarepo` reads directly from the existing checkout
- no source files are copied into the database
- mutation workflows use a temporary copy or worktree for isolation

### 2. Managed git mode

The repo record stores clone metadata and auth references.

Example:

```json
{
  "repo_id": "repo_456",
  "source_kind": "git",
  "clone_url": "git@github.com:org/repo.git",
  "auth_ref": "secret_ref_git_repo_456"
}
```

In this mode:

- `metarepo` creates a temporary checkout or worktree for the requested ref/SHA
- graph build runs against that temporary checkout
- the temporary checkout is cleaned up after the run unless retained for debugging

## Source Freshness Contract

`metarepo` does not claim that durable artifacts stay aligned with later source edits.

Instead, every artifact is stamped with a source fingerprint.

Minimum source fingerprint fields:

- `repo_id`
- `source_kind`
- `root_path` or `clone_url`
- `commit_sha` if available
- `dirty` boolean if applicable
- `created_at`

Optional future fields:

- manifest hash
- changed file list
- branch name
- actor / initiator

Artifacts are interpreted as facts about the source state at creation time.

## Core Data Model

### Repo

Long-lived repo/application record.

Suggested fields:

- `id`
- `name`
- `source_kind`
- `root_path nullable`
- `clone_url nullable`
- `default_branch nullable`
- `auth_ref nullable`
- `default_env_profile_id nullable`
- `created_at`
- `updated_at`

### Run

One workflow execution context.

Suggested fields:

- `id`
- `repo_id`
- `workflow`
- `status`
- `source_fingerprint_json`
- `requested_by`
- `created_at`
- `started_at nullable`
- `finished_at nullable`

### Artifact

Generic persisted output from a run.

Suggested fields:

- `id`
- `repo_id`
- `run_id`
- `kind`
- `title`
- `payload_json`
- `source_fingerprint_json`
- `created_at`

Key artifact kinds:

- `review`
- `boundary_index`
- `red_targets`
- `red_dossier`
- `mutation_proposal`
- `mutation_result`
- `referee_result`
- `bug`
- `test_report`

### Event Ledger

Append-only operational log for workflows.

Suggested fields:

- `id`
- `repo_id`
- `run_id nullable`
- `event_type`
- `payload_json`
- `created_at`

### Secret Reference

Reference to encrypted or externally stored secret material.

Suggested fields:

- `id`
- `repo_id nullable`
- `kind`
- `name`
- `provider`
- `encrypted_payload` or external vault reference
- `created_at`
- `updated_at`

### Environment Profile

Reusable environment binding for runs.

Suggested fields:

- `id`
- `repo_id`
- `name`
- `variables_json`
- `secret_bindings_json`
- `created_at`
- `updated_at`

## Runtime Model

### Graph build lifecycle

For any graph-backed workflow:

1. resolve source root
2. allocate ephemeral graph DB
3. run `SCHEMA_DDL`
4. run `buildFullGraph(sql, { sourceRoot, ... })`
5. execute workflow against that graph DB
6. persist durable artifacts
7. drop ephemeral graph DB

This reuses the current disposable database-per-workflow shape and keeps graph isolation simple.

### Mutation workflow lifecycle

`red.mutate` requires filesystem isolation.

1. resolve source root
2. create temp worktree or temp copy
3. allocate ephemeral graph DB
4. build graph from temp source root
5. apply mutation in temp root
6. run narrow tests
7. classify result
8. persist mutation proposal + mutation result + referee result
9. clean up temp root and ephemeral graph DB

## API Shape

The API should be **hybrid RPC**, not pure resource REST and not giant opaque monolith endpoints.

Why:

- workflows like blue-team, red-team, review, and mutation are operational procedures
- low-level graph queries are still useful as composable building blocks
- pure REST becomes awkward for orchestration-heavy use cases
- pure giant workflow endpoints become hard to reuse

### Resource-oriented endpoints

These operate on durable application state.

- `POST /repos`
- `GET /repos/:id`
- `PATCH /repos/:id`
- `GET /repos/:id/artifacts`
- `GET /repos/:id/bugs`
- `POST /repos/:id/bugs`
- `GET /runs/:id`
- `GET /runs/:id/artifacts`
- `GET /artifacts/:id`
- `POST /repos/:id/env-profiles`
- `POST /repos/:id/secret-refs`

### RPC endpoints

Graph-backed primitives create a run, build the graph, persist outputs, and return run metadata.

- `POST /rpc/graph.boundaries`
- `POST /rpc/graph.deps`
- `POST /rpc/graph.tree`
- `POST /rpc/graph.env`
- `POST /rpc/graph.readiness`
- `POST /rpc/graph.gaps`
- `POST /rpc/graph.index`
- `POST /rpc/review.run`
- `POST /rpc/red.targets`
- `POST /rpc/red.dossier`
- `POST /rpc/red.mutate`
- `POST /rpc/referee.run`

Read-only repo context helpers do not build the graph and return plain data:

- `POST /rpc/test.recent_paths`
- `POST /rpc/test.smells`

## Workflow Semantics

### review.run

Purpose:

- build graph once
- compute review output and markdown
- persist review artifact

This replaces the product-specific PR review boundary with a general review workflow inside `metarepo`.

External systems may still post the result to GitHub, but that is no longer the application boundary.

### red.mutate

Purpose:

- execute a concrete mutation in an isolated temp source root
- run narrow tests
- classify `survived`, `killed`, or `invalid`
- persist result

### referee.run

Purpose:

- validate mutation proposals or mutation results
- persist judgment

## Artifact-First Coordination

Cross-agent coordination should move out of the filesystem and into durable records.

Examples:

- blue-team created tests become artifacts
- red-team queries recent blue-team artifacts rather than scraping git alone
- mutation proposals live in the DB rather than `.tmp/test-red-team/proposals`
- bugs live in the DB and can influence future target selection
- referee results attach directly to proposal ids

Filesystem outputs may still exist as implementation details, but they are not the canonical interface.

## Graph Optimization Strategy

### v1

Keep graph build simple and correct:

- full graph build from the resolved source root
- one build per run
- reuse the built graph across steps within the same run when a workflow chains multiple operations

### v2 options

Potential future optimizations:

- per-run graph reuse across chained RPCs
- opportunistic graph cache keyed by source fingerprint
- subtree/package-scoped builds when explicitly requested
- file-hash invalidation to skip unchanged files

These are optimizations only.

They are not required for correctness in v1.

## Deployment Boundary

There is one deployable app: `metarepo`.

Migration requirements:

- rename the service package or at least its runtime naming from PR-review-specific terms to `metarepo`
- rename workflow/image/docs/deploy language accordingly
- remove “PR review service” as a public boundary concept

Internally, existing code can be reused aggressively during the migration.

## Migration Sequence

1. Rename the service boundary concept to `metarepo`.
2. Keep the current service shell but convert it to the new API surface.
3. Add durable tables for repos, runs, artifacts, ledger entries, bugs, env profiles, and secret refs.
4. Keep ephemeral graph DB lifecycle for each run.
5. Add graph RPCs, review.run, red endpoints, and deterministic mutation/referee execution.
6. Move blue-team and red-team to service-only graph/red clients.
7. Move review/CI callers to service-only clients.
8. Replace filesystem proposal handoff with durable artifact records.

## Testing Strategy

### Unit

- source resolution
- source fingerprint creation
- artifact persistence
- RPC request/response validation
- workflow state transitions

### Behavioral

- local repo run builds graph from real filesystem
- review.run persists review artifacts
- graph and red endpoints return stable repo-scoped context for agent workflows
- red.mutate uses temp isolated source root
- service restart does not corrupt durable repo/run/artifact state

### Failure handling

- graph build failure leaves durable run record in failed state
- mutation temp root cleanup is best-effort but result classification is durable
- app crash never leaves a durable graph pretending to be fresh

## Open Questions

### 1. Local-first vs remote-first

Should v1 prioritize:

- local repos as the default source mode, with managed git only for CI/remote callers

or:

- managed git as the default source mode, with local paths as a development convenience

### 2. Workflow chaining

Should a workflow RPC be able to chain multiple steps on one graph build?

Example:

- build once
- run blue-team
- run red-team
- run referee

Recommended answer: yes, but only within a single run lifecycle, not via long-lived graph persistence.

### 3. Mutation isolation primitive

Should mutation execution use:

- git worktrees when the source is a git repo
- plain temp copies when the source is local but not cleanly git-backed

Recommended answer: support both, prefer worktrees when possible.

### 4. Secrets storage

Should secret refs point to:

- encrypted values in Postgres
- OS keychain / external secret store
- both

Recommended answer: define the abstraction now, keep the backend pluggable.

## Recommendation

Implement `metarepo` as:

- durable application state
- ephemeral graph state
- service-only workflow execution
- artifact-first coordination

Do **not** make graph synchronization correctness part of v1.

The filesystem or git checkout remains the source of truth for code.
The database remains the source of truth for workflow history and artifacts.
