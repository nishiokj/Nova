# Deterministic Concept Capture Plan

## Goal
Create a deterministic, versioned concept system that:
1. Powers a stable Focus Map (`concept -> module -> file`) in Packet view.
2. Improves memory injection via concept-aware retrieval.

## Core Design
### 1) Concept Registry (Source of Truth)
Add a checked-in registry file (`concepts.yaml`) that defines:
- `concepts`: stable IDs and names.
- `modules`: module IDs, labels, concept binding, and file selectors.
- `relations` (optional): typed concept/module dependencies.

Example shape:

```yaml
version: 1
concepts:
  - id: concept.auth
    name: Authentication
    order: 10
  - id: concept.cockpit
    name: Cockpit UI
    order: 20

modules:
  - id: module.dashboard_control
    name: Dashboard Control
    concept_id: concept.cockpit
    file_globs:
      - "packages/dashboard-control/**"
    order: 10

relations:
  - from: module.dashboard_control
    to: module.auth
    type: depends_on
```

### 2) Deterministic Assignment Compiler
Build a compiler that assigns `file -> module -> concept` with strict precedence:
1. Explicit file override.
2. Module/package exact mapping.
3. Path/glob match.
4. Fallback to `concept.unmapped`.

Tie-breakers:
1. Higher explicit priority.
2. Lower `order`.
3. Lexicographic `id`.

No LLM in assignment logic.

### 3) Persisted Mapping
Persist assignments for reproducibility:
- `file_concept_map(file_path, module_id, concept_id, ruleset_version, assigned_at)`

`ruleset_version` is a hash of `concepts.yaml` + compiler version.

## Focus Map Integration
Use session-touched files (read/edited) and join with `file_concept_map`:
- `used`: file read in session.
- `edited`: file edited in session.
- `active_now`: touched within a recent window.

Render deterministic lanes:
- `Concepts | Modules | Files`
- Fixed sorting by `order` then `id`.
- Collapsed file lists by default with counts.
- No function-level nodes/edges.

## Memory Injection Integration
Tag memory records with `concept_id` and `module_id` at write time.

Deterministic retrieval policy:
1. Primary: active concepts in current session.
2. Secondary: neighbor concepts via `depends_on`.
3. Fallback: global retrieval.

Recommended token split:
- 60% active concepts
- 30% neighboring concepts
- 10% global fallback

## Data Model Additions
- `concepts_registry` (optional cached parse of `concepts.yaml`)
- `file_concept_map`
- concept/module tags added to memory artifacts and evidence rows

## Operational Rules
1. Recompute mappings on startup scan and when registry changes.
2. Increment compiler version when assignment behavior changes.
3. Keep deterministic outputs stable across runs.
4. Expose unmapped files explicitly.

## Quality Gates
Track and enforce:
1. Mapping coverage: `% files not in concept.unmapped`.
2. Ambiguity rate: `% files matching >1 candidate rule pre-tie-break`.
3. Churn rate: `% files remapped between ruleset versions`.

Suggested CI checks:
1. Fail if coverage drops below threshold.
2. Fail if churn exceeds threshold without approved ruleset bump.

## Incremental Implementation Plan
1. Add `concepts.yaml` schema + loader.
2. Implement deterministic compiler and file map persistence.
3. Wire Focus Map to concept/module/file overlay.
4. Tag memory writes with concept/module IDs.
5. Add concept-aware retrieval stages and token budgeting.
6. Add coverage/ambiguity/churn reporting and CI checks.

## Open Decisions
1. Canonical module boundaries: package-first vs path-first.
2. Ownership for updating `concepts.yaml`.
3. Whether to allow limited auto-suggestions for unmapped files (reviewed, not auto-applied).
