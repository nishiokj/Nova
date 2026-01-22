# Plan: Revive Edge Parsing + Index Building (`packages/graphd/src/index.ts`)

> Note: `packages/graphd/src/index.ts` is a **barrel file** (re-exports). The actual work to "revive edge parsing + index building" will land in the underlying modules it re-exports.

## Where the real changes will live
- `packages/graphd/src/types.ts`
  - Edge types (`ModuleEdge`, `DerivedEdge`, etc.)
  - Parsing/serialization helpers (dict/row ↔ typed objects)
- `packages/graphd/src/store.ts`
  - Persisting edges (insert/upsert)
  - Query patterns used by traversal / impact
  - Any "rebuild indexes" routines
- `packages/graphd/src/schema.ts`
  - SQLite schema + migrations
  - SQLite index definitions (`CREATE INDEX ...`)

## Quick plan (minimal + effective)

### 1) Confirm canonical edge shapes (`types.ts`)
- Identify the authoritative edge types: `ModuleEdge`, `DerivedEdge`.
- Ensure we have strict parse/convert functions.
  - Today, `index.ts` exports:
    - `createModuleEdge`, `moduleEdgeToDict`, `derivedEdgeToDict`
- Add/restore the missing reverse direction (names may vary):
  - `dictToModuleEdge` / `dictToDerivedEdge` (or equivalent)
- Parsing should include:
  - validation (required fields, enum/kind constraints)
  - defaults for optional fields
  - consistent `normalizePath(...)` usage so DB keys/indexes match expectations

### 2) Make persistence + queries align (`store.ts`)
- Locate the edge insert/upsert path and ensure it goes through the parsing helpers.
- Identify/validate the "hot queries":
  - outgoing edges from a node
  - incoming edges to a node
  - traversal seed queries used by impact/graph-walk features

### 3) Revive "index building" (`schema.ts` + `store.ts`)
Two viable approaches:

**Baseline (recommended): rely on SQLite indexes**
- Create/restore `CREATE INDEX` on:
  - `from_path`
  - `to_path`
  - `kind`
  - composite indexes like `(from_path, kind)` and/or `(to_path, kind)` depending on query patterns

**If you previously used materialized adjacency tables**
- Reintroduce `rebuildEdgeIndexes()` (full rebuild inside a single transaction)
- Optionally add incremental maintenance:
  - `updateEdgeIndexesForFile(filePath)`

### 4) Expose the intended public API (via `index.ts`)
Once the underlying functions exist, re-export them from `packages/graphd/src/index.ts` so other packages can call:
- `parseModuleEdge` / `dictToModuleEdge` (or the canonical parse helpers)
- `rebuildEdgeIndexes` (or the canonical index build routine)

### 5) Single verification pass (end-to-end)
Run one focused verification:
- Insert a small set of edges
- Rebuild/create indexes
- Query:
  - outgoing edges
  - incoming edges
- Confirm round-trip stability:
  - serialize → persist → read → parse yields the same structure

## Decisions to lock the spec (reply A/B/C)
1. **"Edge parsing" refers to:**
   - A) parsing JSON edges emitted by a scanner/daemon
   - B) parsing SQLite rows → TS types
   - C) both

2. **"Index building" should be:**
   - A) just SQLite `CREATE INDEX` (fastest to revive, least moving parts)
   - B) materialized adjacency tables (more work, faster traversals)
   - C) in-memory runtime index (no DB migration, but per-process cost)

3. **Backward compatibility requirement:**
   - A) must read old DBs / old edge payloads
   - B) schema bump/migration is OK
