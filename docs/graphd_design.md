# Graphd Design: Two-Tier Repository Graph

## 1. Purpose and Constraints

Graphd is a background daemon that maintains a repository graph for agents.
It is read-only with respect to the repo, is cheap to keep correct, and never
decides what to edit. It only returns ranked impact candidates with confidence
and rationale. The executor still validates reality with grep/tests.

Non-interference requirements:
- No repo writes or environment mutation
- CPU and memory budgets
- Idle-only refinement for derived edges
- Explicit opt-in for LSP or heavy parsing

## 2. Architecture Overview

Two tiers:
- Tier A: persistent, cheap, universal (SQLite)
- Tier B: ephemeral, derived, higher fidelity (in-memory cache)

Tier A is always maintained. Tier B is built lazily on demand or when idle.

## 3. Tier A (Persistent, SQLite)

Tier A stores stable, low-churn facts.

Entities:
- files: path, language, hash, mtime
- symbols (defs only): function/class/type/config/logger definitions

Edges:
- module_edges: file A imports/depends on file B
- exports (optional): language-dependent module exports

Artifacts (optional):
- run_artifacts: last failing tests, typecheck errors, lint errors

Suggested tables:
```
files(path PRIMARY KEY, lang, hash, mtime)
symbols(id PRIMARY KEY, path, kind, name, qualname, sig, span_start, span_end, hash)
module_edges(src_path, dst_path, kind, confidence)
exports(path, symbol_id, kind, confidence)
run_artifacts(path, kind, details_json, updated_at)
```

## 4. Tier B (Ephemeral, Derived)

Tier B stores short-lived, higher fidelity relationships.

Computed when:
- explicitly requested (e.g., "who calls foo()?"), or
- opportunistically when idle and within budget

Methods:
- ripgrep-based call-site search scoped to repo or reachable module subgraph
- lightweight AST parsing when a plugin is available
- optional LSP hook if the user opts in

Cache fields:
- TTL / expires_at
- confidence (0.0-1.0)
- provenance ("rg", "ast-lite", "lsp")

Suggested cache record:
```
derived_edges(src_symbol, dst_symbol_or_path, kind, confidence, provenance, expires_at)
```

## 5. Impact Inference Endpoint (the worklist input)

The graph does not decide edits. It ranks likely impacts.

Endpoint:
- POST /impact

Input:
- changed entity (file or symbol id)
- change type (sig_change, rename, move, config_contract_change, etc.)
- optional proposed diff or summary
- budget (max candidates)

Output:
```
ImpactItem:
  kind: callers | implementers | imports | tests | configs | loggers
  target: file path or symbol id
  confidence: float
  rationale: string
  suggested_verification: string  # rg query, run test target, open file
```

The runtime microloop decides what to read/edit using these ranked suggestions.

## 6. Invariant Taxonomy (Impact Hints, not Rules)

Keep invariants small and tied to patch safety:
- SignatureContract: changing params/return type implies updating call sites
- NameContract: renames imply updating references/imports
- ModuleBoundary: edits outside allowed directories require escalation
- ConfigContract: config key changes imply updating readers + docs
- LoggingContract: logger name changes imply updating filters/dashboards

These are impact hints, not correctness proofs.

## 7. Resource and Behavior Controls

Hard controls:
- nice/ionice (or OS equivalent), CPU quota, max RAM
- debounce file events and batch updates
- idle-only refinement for Tier B
- never spawn LSP unless opted in

Soft controls:
- .graphdignore
- pause signal from agent (e.g., "tests running")
- backpressure: if agent is active, only answer queries, do not refine

## 8. Interop: Stable API over SQLite

SQLite is internal. Interop is via a stable local API:
- Unix domain socket (preferred) or localhost HTTP
- JSON schema with versioning
- normalized enums for kinds, provenance, and entity types
- stable ids for symbols + file paths

Offline export:
- JSONL dumps for tooling
- optional GraphML for external graph tools

## 9. Minimal Endpoint Set

- GET /symbol?path=...&line=...  -> nearest definition
- GET /context?symbol_id=...&depth=1 -> defs + module edges + cached derived neighbors
- POST /impact -> ranked impact candidates
- POST /search -> controlled rg queries (optional)
- GET /health -> version, db stats, cache stats

## 10. Integration Points

- Microloop invariant checkers can call POST /impact to gate risky changes.
- Executor uses impact results to build a dependency worklist, but validates with
  grep/tests before edits.
- Tier B stays ephemeral; Tier A stays correct and cheap.
