---
type: workflow
title: Boundary-First Concern Intelligence — Implementation Spec
description: Status: proposal
Owner: agent-memory + entity-graph integration
Implement a deterministic, boundary-first architecture intelligence system that: 
acceptance_criteria: []
template: feature
templateId: 01JN0000000000000000000001
specs: [plan, implement, unit-tests, integration-tests, run-tests, invariants]
---
# Boundary-First Concern Intelligence — Implementation Spec

Status: proposal
Owner: agent-memory + entity-graph integration
## 0. Objective
Implement a deterministic, boundary-first architecture intelligence system that:
1. Derives **Concerns** (not inferred business domains) from existing structural and behavioral data.
2. Computes **boundary pressure** and **boundary hardness** between concerns.
3. Raises deterministic architecture red flags (leakage, bypass, churn, hub files, cycles, blast-radius inflation).
4. Exposes results via API for Cockpit/automation.
This spec intentionally avoids LLM classification in the scoring path.
## 1. Terminology
- Concern: a stable code concern cluster (file set), discovered from graph signals.
- Boundary: interaction surface between two concerns.
- Pressure: normalized coupling intensity across a boundary.
- Hardness: how well-separated a boundary is, adjusted by interface mediation.
## 2. Packaging and Placement
## 2.1 Primary home
Place computation in `agent-memory` (derived system, persistence, APIs already exist):
- `packages/agent-memory/src/architecture/types.ts`
- `packages/agent-memory/src/architecture/file-graph.ts`
- `packages/agent-memory/src/architecture/cluster.ts`
- `packages/agent-memory/src/architecture/metrics.ts`
- `packages/agent-memory/src/architecture/alerts.ts`
- `packages/agent-memory/src/architecture/index.ts`
- `packages/agent-memory/scripts/derive-architecture-boundaries.ts`
- `packages/agent-memory/src/daemon/routes/architecture.ts`
Rationale:
- Reuses `derived` runner, job tracking, replay/rate-limit policies.
- Reuses existing evidence tables and session/test data.
- Can query `entity_graph.*` directly (already done in evidence retriever).
## 2.2 Secondary integration points
- Optional read helper additions in `packages/entity-graph/src/queries.ts` for file-level edge rollups.
- Cockpit read-through endpoints in `packages/harness-daemon/src/harness/routes/cockpit.ts`.
## 3. Existing Data Reused (No New Collectors Required)
## 3.1 Structural graph (AST indexer output)
From `entity_graph` schema:
- `entity_graph.entities`
- `entity_graph.imports`
- `entity_graph.calls`
- `entity_graph.uses`
- `entity_graph.owns`
- `entity_graph.extends`
- `entity_graph.implements`
## 3.2 Behavioral / historical signals
From `agent-memory`:
- `agent_traces` (revision/session_key, trace.files[].path)
- `test_specs` (tests_entity_ids, entity_id, last_result, pass_rate)
- `runtime_facts` (related_entity_ids, occurrence_count)
- `test_reports` (session_key, work_item_id, verdict, categories)
- `config_facts` (affects_entity_ids)
No dependency on GraphD SQLite internals for the core run.
## 4. New Persistence Model
Add migration: `packages/agent-memory/src/db/migrations/0xx_architecture_boundaries.sql`
## 4.1 Tables
### architecture_runs
- `id TEXT PK`
- `started_at TIMESTAMPTZ NOT NULL`
- `completed_at TIMESTAMPTZ`
- `status TEXT CHECK (status IN ('running','success','failed'))`
- `lookback_days INTEGER NOT NULL`
- `config_hash TEXT NOT NULL`
- `graph_hash TEXT` (hash of file graph edges used this run)
- `error TEXT`
- `stats JSONB NOT NULL DEFAULT '{}'::jsonb`
Indexes:
- `(status, started_at DESC)`
- `(config_hash)`
### architecture_concerns
- `run_id TEXT NOT NULL REFERENCES architecture_runs(id) ON DELETE CASCADE`
- `concern_id TEXT NOT NULL`
- `label TEXT NOT NULL`
- `confidence REAL NOT NULL`
- `size_files INTEGER NOT NULL`
- `internal_weight REAL NOT NULL`
- `external_weight REAL NOT NULL`
- `cohesion REAL NOT NULL`
- `stability REAL NOT NULL`
- `volatility REAL NOT NULL`
- `signal_density REAL NOT NULL`
- `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`
- PK `(run_id, concern_id)`
Indexes:
- `(run_id)`
- `(confidence DESC)`
### architecture_concern_files
- `run_id TEXT NOT NULL REFERENCES architecture_runs(id) ON DELETE CASCADE`
- `concern_id TEXT NOT NULL`
- `file_path TEXT NOT NULL`
- `membership_score REAL NOT NULL`
- `is_core BOOLEAN NOT NULL DEFAULT false`
- PK `(run_id, file_path)`
Indexes:
- `(run_id, concern_id)`
- `(run_id, file_path)`
### architecture_boundaries
- `run_id TEXT NOT NULL REFERENCES architecture_runs(id) ON DELETE CASCADE`
- `left_concern_id TEXT NOT NULL`
- `right_concern_id TEXT NOT NULL`
- `cross_weight REAL NOT NULL`
- `internal_left REAL NOT NULL`
- `internal_right REAL NOT NULL`
- `pressure REAL NOT NULL`
- `pressure_norm REAL NOT NULL`
- `hardness REAL NOT NULL`
- `interface_ratio REAL NOT NULL`
- `direct_bypass_ratio REAL NOT NULL`
- `directional_left_to_right REAL NOT NULL`
- `directional_right_to_left REAL NOT NULL`
- `symmetry_ratio REAL NOT NULL`
- `top_cross_files JSONB NOT NULL DEFAULT '[]'::jsonb`
- PK `(run_id, left_concern_id, right_concern_id)`
Indexes:
- `(run_id, pressure_norm DESC)`
- `(run_id, hardness ASC)`
### architecture_alerts
- `id TEXT PK`
- `run_id TEXT NOT NULL REFERENCES architecture_runs(id) ON DELETE CASCADE`
- `alert_type TEXT NOT NULL`
- `severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical'))`
- `status TEXT NOT NULL CHECK (status IN ('open','acknowledged','resolved')) DEFAULT 'open'`
- `concern_id TEXT`
- `left_concern_id TEXT`
- `right_concern_id TEXT`
- `file_path TEXT`
- `score REAL NOT NULL`
- `threshold REAL NOT NULL`
- `title TEXT NOT NULL`
- `description TEXT NOT NULL`
- `evidence JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `resolved_at TIMESTAMPTZ`
Indexes:
- `(status, severity, created_at DESC)`
- `(run_id)`
- `(alert_type)`
## 5. Deterministic File Graph Construction
All metrics are computed over normalized file paths relative to repo root.
## 5.1 Candidate file set
`F = { filepath from entity_graph.entities }`
Optional scope filter:
- include: `packages/**`, `apps/**`, `services/**`, `src/**`
- exclude: lockfiles, generated folders, vendor folders
## 5.2 Pair-level signal definitions
For each unordered file pair `(i,j)`, compute:
### S_static(i,j)
From cross-file structural edges.
Directed edge counts by type (cross-file only):
- imports: `c_imports(i,j)`
- calls: `c_calls(i,j)`
- uses: `c_uses(i,j)`
- extends: `c_extends(i,j)`
- implements: `c_implements(i,j)`
- owns: `c_owns(i,j)` (usually weak across files)
Raw static score:
`raw_static(i,j) = 1.00*c_imports + 1.25*c_calls + 0.75*c_uses + 1.10*c_extends + 1.10*c_implements + 0.40*c_owns`
Normalization:
`S_static(i,j) = clip( log(1 + raw_static(i,j)) / P95_log_static , 0, 1 )`
where `P95_log_static` is 95th percentile of `log(1 + raw_static)` across non-zero pairs in the run.
### S_change(i,j)
From `agent_traces` grouped by non-synthetic revision in lookback window.
For each revision group `r`, let `F_r` be unique files in trace payload.
Contribution per pair in group:
`delta_change_r(i,j) = 1 / C(|F_r|, 2)` if `(i,j) ⊆ F_r` and `|F_r| >= 2`, else `0`
`raw_change(i,j) = Σ_r delta_change_r(i,j)`
`S_change(i,j) = clip(raw_change(i,j) / P95_change, 0, 1)`
### S_touch(i,j)
From `agent_traces` grouped by `session_key` in lookback window.
For session `s`, `F_s = unique files touched in traces for session`.
`delta_touch_s(i,j) = 1 / C(|F_s|, 2)` if `(i,j) ⊆ F_s` and `|F_s| >= 2` else `0`
`raw_touch(i,j) = Σ_s delta_touch_s(i,j)`
`S_touch(i,j) = clip(raw_touch(i,j) / P95_touch, 0, 1)`
### S_test(i,j)
From `test_specs`.
For each test row `t`:
- map `tests_entity_ids[]` + `entity_id` to file set `F_t` via `entity_graph.entities`
- require `|F_t| >= 2`
`delta_test_t(i,j) = 1 / C(|F_t|, 2)` if `(i,j) ⊆ F_t` else `0`
`raw_test(i,j) = Σ_t delta_test_t(i,j)`
`S_test(i,j) = clip(raw_test(i,j) / P95_test, 0, 1)`
### S_runtime(i,j)
From `runtime_facts`.
For each runtime row `k`:
- map `related_entity_ids[]` to file set `F_k`
- pair contribution weighted by occurrence count
`delta_runtime_k(i,j) = log(1 + occurrence_count_k) / C(|F_k|,2)` if `(i,j) ⊆ F_k` and `|F_k| >= 2` else `0`
`raw_runtime(i,j) = Σ_k delta_runtime_k(i,j)`
`S_runtime(i,j) = clip(raw_runtime(i,j) / P95_runtime, 0, 1)`
### S_semantic(i,j)
Deterministic lexical similarity from file-level token vectors (no model call):
- tokenize filepath segments + entity names + optional `raw_text`
- lowercase, drop stopwords, drop length < 3
- compute TF-IDF vector per file
- cosine similarity for candidate pairs only
Candidate pairs for semantic evaluation:
- pairs with any non-zero previous signal, plus
- pairs in same top-level package/app/service segment
`S_semantic(i,j) = cosine_tfidf(i,j)` in `[0,1]`
## 5.3 Final edge weight
`W(i,j) = 0.40*S_static + 0.20*S_change + 0.15*S_touch + 0.10*S_test + 0.10*S_runtime + 0.05*S_semantic`
Keep an edge if:
- `W(i,j) >= 0.12`, or
- pair is in top-8 highest `W` neighbors for file `i` or `j`.
This produces a sparse weighted undirected file graph `G=(F,E,W)`.
## 6. Concern Discovery (Deterministic)
## 6.1 Initial partition
- Build connected components on strong edges (`W >= 0.20`).
- Each component is an initial concern candidate.
## 6.2 Deterministic refinement
Run deterministic modularity-improving file moves:
- Iterate files in lexical order of `file_path`.
- For each file, evaluate moving to neighbor concern with max positive `ΔQ`.
- Apply move if `ΔQ >= 0.005`.
- Tie-break: lower concern lexical id.
- Stop after no moves or 10 passes.
No RNG in move order or tie-break.
## 6.3 Concern IDs and continuity
Run-level provisional ID:
`provisional_id = 'concern.' + hex(sha1(join('|', first_5_core_files_sorted)))[0:12]`
Cross-run ID continuity:
- Compare current concerns to previous successful run.
- Overlap score: `Jaccard(file_set_current, file_set_prev)`.
- Reuse previous `concern_id` if max overlap `>= 0.60`.
- If multiple matches: choose highest overlap, then lexical `concern_id`.
- Otherwise mint new ID from provisional hash.
## 6.4 Concern label generation (deterministic)
Generate labels from cluster terms, no LLM:
- collect top TF-IDF terms across concern files
- candidate label = highest weighted term bigram or package prefix
- enforce sibling orthogonality:
- reject label if token Jaccard with sibling label > 0.5
- fallback label: `concern_<short_id>`
## 7. Boundary Metrics
For each concern pair `(A,B)` with non-zero cross weight:
- `cross(A,B) = Σ W(i,j), i∈A, j∈B`
- `internal(A) = Σ W(i,j), i,j∈A, i<j`
- `internal(B) = Σ W(i,j), i,j∈B, i<j`
Smoothing constants:
- `lambda_internal = 0.5`
- `epsilon = 1e-6`
Pressure:
`pressure(A,B) = cross(A,B) / ( sqrt((internal(A)+lambda_internal)*(internal(B)+lambda_internal)) + epsilon )`
Pressure normalization:
`pressure_norm(A,B) = pressure / (1 + pressure)`
Range `[0,1)`.
## 7.1 Directed boundary flow
From directed static edges only (imports/calls/uses/extends/implements):
- `dir(A->B) = weighted directed edge count`
- `dir(B->A) = weighted directed edge count`
Symmetry:
`symmetry_ratio = min(dir(A->B), dir(B->A)) / (max(dir(A->B), dir(B->A)) + epsilon)`
## 7.2 Interface mediation
A file is considered interface-like if any condition matches:
- path regex contains: `route|routes|controller|api|transport|gateway|client|handler|http|grpc|rpc|contract|schema|dto`
- or file has exported `interface|type` entities
- or file entity raw_text contains transport tokens: `fetch(`, `axios`, `express`, `fastify`, `grpc`, `request(`
For directed cross-boundary static edges:
- `interface_cross_weight`: sum of cross-edge weights where source or target file is interface-like
- `cross_static_weight`: sum of all directed cross-boundary static edge weights
`interface_ratio = interface_cross_weight / (cross_static_weight + epsilon)`
`direct_bypass_ratio = 1 - interface_ratio`
## 7.3 Boundary hardness
`hardness(A,B) = clip( (1 - pressure_norm(A,B)) * (0.6 + 0.4*interface_ratio), 0, 1 )`
Interpretation:
- higher hardness = better separated boundary
- low hardness with high pressure = leaky boundary
## 8. Concern Metrics
For each concern `C`:
- `size_files = |C|`
- `internal_weight = Σ W(i,j), i,j∈C, i<j`
- `external_weight = Σ W(i,j), i∈C, j∉C`
- `cohesion = internal_weight / (internal_weight + external_weight + epsilon)`
Stability/volatility vs previous run:
- `stability = |C_now ∩ C_prev| / |C_now ∪ C_prev|` (best-matched prior concern)
- `volatility = 1 - stability`
Signal density:
- `signal_density = nonzero_edges_within_C / max_possible_edges_within_C`
Concern confidence:
`confidence = clip(0.50*cohesion + 0.30*stability + 0.20*signal_density, 0, 1)`
## 9. Alert Determination Rules
All alerts are deterministic, thresholded, and include evidence payload.
## 9.1 Leaky boundary
Trigger if all true:
- `pressure_norm >= 0.65`
- `hardness <= 0.35`
- persisted for `>= 3` consecutive successful runs
Severity:
- `critical` if `pressure_norm >= 0.80`
- `high` otherwise
## 9.2 Boundary bypass
Trigger if all true:
- `direct_bypass_ratio >= 0.70`
- `interface_ratio` dropped by at least `0.15` vs prior 14-day median
- `cross_static_weight` above run p75 (avoid tiny-noise boundaries)
Severity: `high`
## 9.3 Architectural cycle (cross-concern)
Trigger if all true:
- `dir(A->B) >= 20`
- `dir(B->A) >= 20`
- `symmetry_ratio >= 0.60`
Severity: `high` (or `critical` if both directions >= 50)
## 9.4 Hub file / bridge hotspot
Per-file metrics:
- `cross_degree_weight(file)` = sum of `W(file, other)` where `other` in different concern
- `internal_degree_weight(file)` = sum to same concern
- `bridge_ratio = cross_degree_weight / (internal_degree_weight + epsilon)`
Trigger:
- `cross_degree_weight >= p99` over files in run
- `bridge_ratio >= 2.5`
- file touches `>= 3` distinct concern boundaries
Severity: `medium` (or `high` if bridge_ratio >= 4)
## 9.5 Concern churn
Run-to-run:
`file_reassignment_rate = moved_files / tracked_files`
Trigger if:
- `file_reassignment_rate > 0.12`
- and no config hash change (to avoid false positives from intentional retuning)
Severity: `medium`
## 9.6 Blast-radius inflation (concern-level)
For each concern `C`, from lookback window:
- change sets = revisions (or sessions if revision unavailable) that touched any file in `C`
- for each change set `x`, compute `external_concern_count_x`
- current score = 14-day EMA of `external_concern_count`
- baseline = 30-day EMA prior to current 14-day window
Trigger:
- `change_set_count >= 20`
- `current_score >= 1.35 * baseline`
Severity: `medium` (or `high` if >= 1.75x)
## 10. Runtime and Scheduling
## 10.1 Derived task
Create recurring derived task:
- name: `derive-architecture-boundaries`
- script: `packages/agent-memory/scripts/derive-architecture-boundaries.ts`
- mode: `recurring`
- interval: `24h` (default), configurable
- replay policy: `cooldown`
- cooldown: `6h`
## 10.2 Script metadata schema
```ts
{
  lookbackDays: number = 30,
  minEdgeWeight: number = 0.12,
  strongEdgeWeight: number = 0.20,
  maxPairsPerFile: number = 128,
  maxFiles: number = 20000,
  emitAlerts: boolean = true
}
```
## 10.3 Determinism contract
For same input snapshot and same config hash:
- same graph hash
- same concern assignments
- same boundary metrics
- same alert set
## 11. APIs
Add routes in `packages/agent-memory/src/daemon/routes/architecture.ts` and register in route index.
## 11.1 GET /architecture/runs
Query:
- `limit` default 20
- `status` optional
Response:
```json
{
  "runs": [
    {
      "id": "...",
      "status": "success",
      "startedAt": "...",
      "completedAt": "...",
      "lookbackDays": 30,
      "configHash": "...",
      "graphHash": "...",
      "stats": {"files": 4200, "edges": 38211, "concerns": 37, "alerts": 12}
    }
  ]
}
```
## 11.2 GET /architecture/concerns
Query:
- `runId` optional (default latest success)
- `minConfidence` optional
- `limit` optional
Response:
```json
{
  "runId": "...",
  "concerns": [
    {
      "concernId": "concern.abc123",
      "label": "session_permissions",
      "confidence": 0.82,
      "sizeFiles": 44,
      "cohesion": 0.71,
      "stability": 0.88,
      "volatility": 0.12
    }
  ]
}
```
## 11.3 GET /architecture/concerns/:id
Returns concern detail + files + top boundaries.
## 11.4 GET /architecture/boundaries
Query:
- `runId` optional
- `minPressure` optional
- `maxHardness` optional
- `limit` optional
Response contains:
- concern pair
- pressure, hardness
- interface_ratio, direct_bypass_ratio
- directional flow and symmetry
- top crossing files
## 11.5 GET /architecture/alerts
Query:
- `runId` optional
- `status` optional (`open|acknowledged|resolved`)
- `severity` optional
- `type` optional
## 11.6 POST /architecture/recompute
Triggers derived task run immediately.
Body:
```json
{
  "lookbackDays": 30,
  "force": false
}
```
Returns scheduled job id.
## 11.7 POST /architecture/alerts/:id/resolve
Body:
```json
{ "note": "optional" }
```
## 12. Cockpit Integration
## 12.1 New Cockpit read-through endpoints (harness-daemon)
Add pass-throughs in `packages/harness-daemon/src/harness/routes/cockpit.ts`:
- `GET /cockpit/architecture/overview?sessionKey=...`
- `GET /cockpit/architecture/alerts?sessionKey=...`
## 12.2 Session-aware focus derivation
Reuse existing `extractSessionFiles(agent_events)`.
For selected session:
1. Gather touched files (`read`/`edited`).
2. Join with latest `architecture_concern_files`.
3. Compute active concern score:
`active_score(concern) = 2*(edited_files_in_concern) + 1*(read_files_in_concern)`
4. Return top concerns + highest pressure boundaries touching them + open alerts.
## 13. Query and Compute Plumbing Details
## 13.1 Structural pair extraction SQL skeleton
- Build entity->file mapping once.
- For each relation table, join source/target entity ids to filepaths.
- Exclude same-file pairs for boundary signals.
- Aggregate counts per `(min(fileA,fileB), max(fileA,fileB), edge_type)`.
## 13.2 agent_traces file extraction
Trace filepaths come from JSON path:
- `trace.files[*].path`
Grouping keys:
- co-change: `revision` where `revision NOT LIKE 'session:%'`
- co-touch: `session_key`
## 13.3 Entity-to-file mapping for test/runtime/config
For arrays of entity ids (`tests_entity_ids`, `related_entity_ids`, `affects_entity_ids`):
- join to `entity_graph.entities(id)`
- derive unique file sets per source row before pair expansion.
## 14. Quality Gates and CI
## 14.1 Build-time checks
Fail CI if determinism or quality thresholds regress unexpectedly:
- determinism check: same fixture + same config -> same graph hash/assignment hash
- concern count explosion: >2x median historical without config hash change
- alert explosion: >3x median historical without config hash change
## 14.2 Run health metrics
Persist in `architecture_runs.stats`:
- files considered
- edges kept
- concern count
- singleton concern count
- alerts emitted
- compute duration
## 15. Test Plan
## 15.1 Unit tests
- Signal normalization and clipping
- Pressure/hardness formulas
- Deterministic tie-break behavior
- Alert threshold boundaries
## 15.2 Integration tests
- Synthetic repo fixture with known concern structure
- Replay same snapshot twice -> identical outputs
- Introduce deliberate cross-concern shortcuts -> leaky/bypass alerts appear
## 15.3 Performance targets
For 10k files / 300k candidate pairs:
- run time <= 8 minutes on standard dev host
- peak memory <= 2 GB
## 16. Rollout Plan
1. Phase 1: compute-only, no alerts (store concerns/boundaries).
2. Phase 2: enable alerts with medium/high thresholds.
3. Phase 3: Cockpit integration + session-aware overview.
4. Phase 4: optional policy hooks (warn/block on repeated critical alerts).
## 17. Non-Goals
- No automatic refactoring or graph rewrites.
- No LLM-generated concern assignment in scoring path.
- No attempt to infer universally correct business domains.
## 18. Why This Fits Current Stack
- Uses AST graph already indexed in `entity_graph`.
- Uses behavior/test/runtime evidence already in `agent-memory`.
- Uses existing derived-job scheduling and daemon route architecture.
- Produces deterministic, auditable metrics with explicit formulas.

## Acceptance Criteria

- [ ] *Define acceptance criteria...*
## Workflow Steps

1. **plan** — Plan the feature implementation [planner]
2. **implement** — Implement the feature [coder] (after: plan)
3. **unit-tests** — Write unit tests for new code [coder] (after: implement)
4. **integration-tests** — Write integration tests [coder] (after: implement)
5. **run-tests** — Run all tests [test-runner] (after: unit-tests, integration-tests)
6. **invariants** — Verify semantic invariants hold [coder] (after: run-tests)