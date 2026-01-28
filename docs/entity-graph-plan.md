# Entity Graph Plan

## Overview

A persistent entity graph that maps codebase structure (classes, functions, imports, calls, types) and their relationships across files. Built on Tree-sitter for AST parsing, Postgres for storage, and integrated into a multi-agent environment with file-level coordination.

---

## 1. AST Parsing Layer

### Tool: Tree-sitter (`node-tree-sitter`)

- Language-agnostic (40+ grammars), incremental parsing, battle-tested (GitHub Semantic, Neovim, etc.)
- Produces a CST (Concrete Syntax Tree) with positional fidelity
- Validated by the January 2026 Graph-RAG paper (arXiv:2601.08773) — deterministic AST-derived graphs outperform LLM-extracted knowledge graphs in retrieval coverage (0.90-0.99 vs 0.63-0.70)

**Alternative considered:** `@ast-grep/napi` — structural pattern matching on top of Tree-sitter. jQuery-like API (`findAll`, `SgNode`). Could be used alongside or instead of raw Tree-sitter queries for simpler extraction patterns.

**Alternative considered:** `oxc-parser` — fastest JS/TS parser (3x faster than SWC, 40x faster than Babel). Outputs ESTree AST directly. JS/TS only. Worth evaluating if multi-language support isn't needed.

### Parse Lifecycle

```
files on disk
     │
     ▼
tree-sitter ──parse──▶ syntax tree (per file, ephemeral)
                             │
                             ▼
                   extraction logic
                   (queries / traversal)
                             │
                             ▼
                   entity graph (persistent, cross-file, Postgres)
```

- **Startup:** Parse all files, build full graph
- **File change:** Re-parse that one file, replace its contribution to the graph
- **No incremental parsing needed:** `tree.edit()` is for editors with keystroke-level diffs. For file watchers, full re-parse is sub-100ms for typical source files (~80ms for 6K lines, ~120ms for 20K lines). Fast enough.

### Entity Extraction via Query API

Tree-sitter's Query API is the primary extraction mechanism. S-expression patterns with `@captures`:

```javascript
const Parser = require("tree-sitter");
const TypeScript = require("tree-sitter-typescript").typescript;
const { Query } = Parser;

const parser = new Parser();
parser.setLanguage(TypeScript);

const classQuery = new Query(TypeScript, `
  (class_declaration
    name: (type_identifier) @class.name
    body: (class_body
      (method_definition
        name: (property_identifier) @method.name) @method.def)
  ) @class.def
`);

const importQuery = new Query(TypeScript, `
  (import_statement
    (import_clause (named_imports (import_specifier name: (identifier) @import.name)))
    source: (string) @import.source
  ) @import.def
`);

const callQuery = new Query(TypeScript, `
  (call_expression
    function: (member_expression
      object: (_) @call.object
      property: (property_identifier) @call.method)
  ) @call.def
`);
```

`query.matches(tree.rootNode)` returns grouped matches. `query.captures(tree.rootNode)` returns a flat ordered list. Both provide `{ name, node }` where `node` has `.text`, `.startPosition`, `.endPosition`, `.type`, `.parent`, `.closest()`, etc.

### Key Node API

| Property/Method | Purpose |
|---|---|
| `.type` | Node kind — `"class_declaration"`, `"function_declaration"`, etc. |
| `.text` | Source text of the node |
| `.children` / `.namedChildren` | All children / only semantic children |
| `.parent` | Parent node |
| `.childForFieldName(name)` | Get child by grammar field (`"name"`, `"body"`) |
| `.descendantsOfType(type)` | Find all descendants matching a node type |
| `.closest(types)` | Walk up ancestors to find matching type |
| `.walk()` | Returns a `TreeCursor` for stateful, allocation-efficient traversal |
| `.startPosition` / `.endPosition` | `{ row, column }` location |

---

## 2. Storage Layer: Postgres

### Why Postgres (not SQLite, not Neo4j)

- **Already running** in agent-memory — zero additional ops burden
- **Row-level MVCC** — true concurrent writers, no single-writer bottleneck
- **LISTEN/NOTIFY** — built-in pub/sub for post-edit notifications to agents
- **Recursive CTEs** — well-optimized, handles transitive dependency queries when needed
- **Shared infrastructure** — same connection pool as agent-memory

Neo4j only wins if primary queries are variable-depth traversal, cycle detection, or shortest-path. For 1-2 hop lookups with type filters (the dominant pattern), Postgres with indexes is faster and simpler.

### Schema

Isolated in its own schema to stay out of agent-memory's namespace:

```sql
CREATE SCHEMA entity_graph;

-- Core entity table
CREATE TABLE entity_graph.entities (
  id          TEXT PRIMARY KEY,   -- e.g., "class:UserService" or "file:src/db.ts"
  kind        TEXT NOT NULL,      -- file, class, function, method, type, variable
  name        TEXT NOT NULL,
  filepath    TEXT NOT NULL,      -- provenance: which file this came from
  start_line  INTEGER,
  end_line    INTEGER,
  exported    BOOLEAN DEFAULT FALSE,
  async       BOOLEAN DEFAULT FALSE,
  raw_text    TEXT                -- optional: source text of the entity
);

-- Relationship tables (one per relationship type)
CREATE TABLE entity_graph.imports    (importer_id TEXT, imported_id TEXT, symbol TEXT);
CREATE TABLE entity_graph.calls      (caller_id TEXT, callee_id TEXT, site_line INTEGER);
CREATE TABLE entity_graph.uses       (user_id TEXT, used_id TEXT);
CREATE TABLE entity_graph.owns       (owner_id TEXT, owned_id TEXT);     -- class owns method, file owns class
CREATE TABLE entity_graph.extends    (child_id TEXT, parent_id TEXT);
CREATE TABLE entity_graph.implements (implementor_id TEXT, interface_id TEXT);
CREATE TABLE entity_graph.modifies   (modifier_id TEXT, modified_id TEXT);
CREATE TABLE entity_graph.creates    (creator_id TEXT, created_id TEXT);

-- File leases for multi-agent coordination
CREATE TABLE entity_graph.file_leases (
  filepath    TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- Indexes on both sides of every relationship
CREATE INDEX idx_entities_filepath   ON entity_graph.entities(filepath);
CREATE INDEX idx_entities_kind       ON entity_graph.entities(kind);
CREATE INDEX idx_imports_imported    ON entity_graph.imports(imported_id);
CREATE INDEX idx_imports_importer    ON entity_graph.imports(importer_id);
CREATE INDEX idx_calls_callee       ON entity_graph.calls(callee_id);
CREATE INDEX idx_calls_caller       ON entity_graph.calls(caller_id);
CREATE INDEX idx_uses_used          ON entity_graph.uses(used_id);
CREATE INDEX idx_uses_user          ON entity_graph.uses(user_id);
CREATE INDEX idx_owns_owner         ON entity_graph.owns(owner_id);
CREATE INDEX idx_owns_owned         ON entity_graph.owns(owned_id);
CREATE INDEX idx_extends_child      ON entity_graph.extends(child_id);
CREATE INDEX idx_extends_parent     ON entity_graph.extends(parent_id);
CREATE INDEX idx_implements_impl    ON entity_graph.implements(implementor_id);
CREATE INDEX idx_implements_iface   ON entity_graph.implements(interface_id);
CREATE INDEX idx_modifies_modifier  ON entity_graph.modifies(modifier_id);
CREATE INDEX idx_modifies_modified  ON entity_graph.modifies(modified_id);
CREATE INDEX idx_creates_creator    ON entity_graph.creates(creator_id);
CREATE INDEX idx_creates_created    ON entity_graph.creates(created_id);
```

### Query Patterns

```sql
-- File changed: who imports it?
SELECT e.* FROM entity_graph.entities e
JOIN entity_graph.imports i ON i.importer_id = e.id
WHERE i.imported_id IN (SELECT id FROM entity_graph.entities WHERE filepath = $1);

-- Function changed: who calls it?
SELECT e.* FROM entity_graph.entities e
JOIN entity_graph.calls c ON c.caller_id = e.id
WHERE c.callee_id = $1;

-- Type changed: who uses it?
SELECT e.* FROM entity_graph.entities e
JOIN entity_graph.uses u ON u.user_id = e.id
WHERE u.used_id = $1;

-- Blast radius: all files affected by changes to a given file
SELECT DISTINCT e.filepath FROM entity_graph.entities e
WHERE e.id IN (
  SELECT importer_id FROM entity_graph.imports
  WHERE imported_id IN (SELECT id FROM entity_graph.entities WHERE filepath = $1)
  UNION
  SELECT caller_id FROM entity_graph.calls
  WHERE callee_id IN (SELECT id FROM entity_graph.entities WHERE filepath = $1)
  UNION
  SELECT user_id FROM entity_graph.uses
  WHERE used_id IN (SELECT id FROM entity_graph.entities WHERE filepath = $1)
);

-- Transitive dependency chain (when needed)
WITH RECURSIVE dep_chain AS (
  SELECT imported_id AS id, 1 AS depth FROM entity_graph.imports WHERE importer_id = $1
  UNION ALL
  SELECT i.imported_id, dc.depth + 1 FROM entity_graph.imports i
  JOIN dep_chain dc ON i.importer_id = dc.id
  WHERE dc.depth < 10
)
SELECT DISTINCT e.* FROM entity_graph.entities e JOIN dep_chain dc ON e.id = dc.id;
```

---

## 3. Parse Pipeline

Single watcher process. Sequential write path. Provenance-based wipe-and-replace.

```javascript
async function parseFile(filepath) {
  const source = await readFile(filepath, "utf-8");
  const tree = parser.parse(source);
  const { entities, edges } = extract(tree, filepath);

  await db.query("BEGIN");

  // Wipe old contribution from this file
  await db.query(`DELETE FROM entity_graph.imports WHERE importer_id IN (SELECT id FROM entity_graph.entities WHERE filepath = $1)`, [filepath]);
  await db.query(`DELETE FROM entity_graph.calls WHERE caller_id IN (SELECT id FROM entity_graph.entities WHERE filepath = $1)`, [filepath]);
  await db.query(`DELETE FROM entity_graph.uses WHERE user_id IN (SELECT id FROM entity_graph.entities WHERE filepath = $1)`, [filepath]);
  await db.query(`DELETE FROM entity_graph.owns WHERE owner_id IN (SELECT id FROM entity_graph.entities WHERE filepath = $1)`, [filepath]);
  // ... same for other relationship tables
  await db.query(`DELETE FROM entity_graph.entities WHERE filepath = $1`, [filepath]);

  // Insert new entities
  for (const e of entities) {
    await db.query(
      `INSERT INTO entity_graph.entities (id, kind, name, filepath, start_line, end_line, exported, async)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [e.id, e.kind, e.name, filepath, e.startLine, e.endLine, e.exported, e.async]
    );
  }

  // Insert new relationships
  for (const rel of edges) {
    await db.query(
      `INSERT INTO entity_graph.${rel.table} VALUES ($1, $2)`,
      [rel.source, rel.target]
    );
  }

  await db.query("COMMIT");
}
```

### Startup

```javascript
async function buildFullGraph(srcDir) {
  const files = glob(`${srcDir}/**/*.ts`);
  for (const file of files) {
    await parseFile(file);
  }
}
```

### File Watcher

```javascript
watcher.on("change", async (filepath) => {
  await parseFile(filepath);
  // Notify agents via Postgres LISTEN/NOTIFY
  await db.query(`NOTIFY file_changed, '${JSON.stringify({ filepath })}'`);
});
```

---

## 4. Multi-Agent Coordination

### Problem

Two agents writing the same file = last-write-wins data loss. The conflict happens at the filesystem layer before the DB ever sees it. Retry/replay is brittle — agents can't reliably re-reason about stale intent.

### Solution: Pre/Post Tool-Use Hooks

Prevention at the tool-call boundary, not at the scheduler level. Single-threaded Node event loop guarantees no true simultaneous execution.

#### Pre-Edit Hook: File Lease Check

Before an agent's Edit tool call executes, check if another agent holds a lease on that file:

```javascript
const activeEdits = new Map(); // filepath -> agentId (in-memory, event loop is the mutex)

async function preEditHook(agentId, filepath) {
  const holder = activeEdits.get(filepath);
  if (holder && holder !== agentId) {
    await waitForRelease(filepath);
  }
  activeEdits.set(filepath, agentId);

  // Also acquire DB-level lease for durability
  const result = await db.query(`
    INSERT INTO entity_graph.file_leases (filepath, agent_id, acquired_at, expires_at)
    VALUES ($1, $2, now(), now() + interval '30 seconds')
    ON CONFLICT (filepath) DO UPDATE
    SET agent_id = EXCLUDED.agent_id,
        acquired_at = EXCLUDED.acquired_at,
        expires_at = EXCLUDED.expires_at
    WHERE entity_graph.file_leases.expires_at < now()
    RETURNING filepath
  `, [filepath, agentId]);

  return result.rows.length > 0; // true = acquired
}
```

#### Post-Edit Hook: Context Invalidation

After an Edit completes, release the lease and notify other agents via context append (avoids cache miss from full invalidation):

```javascript
async function postEditHook(agentId, filepath) {
  activeEdits.delete(filepath);
  await db.query(`DELETE FROM entity_graph.file_leases WHERE filepath = $1 AND agent_id = $2`, [filepath, agentId]);

  // Notify other agents via Postgres pub/sub
  await db.query(`NOTIFY file_changed, '${JSON.stringify({ filepath, agentId })}'`);
}

// Each agent's connection listens
agentDb.on("notification", (msg) => {
  if (msg.channel === "file_changed") {
    const { filepath, agentId: modifierAgent } = JSON.parse(msg.payload);
    if (modifierAgent !== myAgentId) {
      agent.appendContext(
        `[system] ${filepath} was modified by ${modifierAgent}. Re-read before editing.`
      );
    }
  }
});
```

### Entity-Type-Specific Reactive Hooks

When an entity is modified, fetch dependents based on entity type:

| Entity Kind | Dependents to Notify |
|---|---|
| **file** | importers of that file |
| **function** | callers of that function |
| **type/interface** | importers, users, implementors |
| **class** | extenders, importers, instantiators |
| **method** | callers |

```javascript
async function getAffectedByEntityChange(entityId, entityKind) {
  const queries = {
    file: `SELECT DISTINCT importer_id AS dep FROM entity_graph.imports
           WHERE imported_id IN (SELECT id FROM entity_graph.entities WHERE filepath = $1)`,
    function: `SELECT DISTINCT caller_id AS dep FROM entity_graph.calls WHERE callee_id = $1`,
    type: `SELECT user_id AS dep FROM entity_graph.uses WHERE used_id = $1
           UNION SELECT implementor_id FROM entity_graph.implements WHERE interface_id = $1
           UNION SELECT importer_id FROM entity_graph.imports WHERE imported_id = $1`,
    class: `SELECT child_id AS dep FROM entity_graph.extends WHERE parent_id = $1
            UNION SELECT importer_id FROM entity_graph.imports WHERE imported_id = $1`,
    method: `SELECT caller_id AS dep FROM entity_graph.calls WHERE callee_id = $1`,
  };

  const query = queries[entityKind];
  if (!query) return [];
  return (await db.query(query, [entityId])).rows;
}
```

---

## 5. Architecture Summary

```
┌──────────┐  ┌──────────┐  ┌──────────┐
│ Agent A  │  │ Agent B  │  │ Agent C  │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │             │
     │  pre-hook   │  pre-hook   │  pre-hook
     │  (lease)    │  (lease)    │  (lease)
     ▼             ▼             ▼
┌──────────────────────────────────────┐
│         Edit Tool Calls              │
│   (single-threaded Node event loop)  │
└──────────────────┬───────────────────┘
     │  post-hook (release + NOTIFY)
     ▼
┌──────────────────────────────────────┐
│        Filesystem (source files)     │
└──────────────────┬───────────────────┘
     │  fs.watch / chokidar
     ▼
┌──────────────────────────────────────┐
│  Parse Pipeline (tree-sitter)        │
│  parse file → extract entities →     │
│  wipe-and-replace in Postgres        │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│  Postgres (entity_graph schema)      │
│  entities + relationship tables      │
│  file_leases                         │
│  LISTEN/NOTIFY for agent pub/sub     │
└──────────────────────────────────────┘
```

---

## 6. Dependencies

```
tree-sitter                  — core parser
tree-sitter-typescript       — TS/TSX grammar
tree-sitter-javascript       — JS/JSX grammar
(additional grammars as needed: tree-sitter-python, tree-sitter-go, etc.)
pg                           — Postgres client (already in use)
chokidar                     — file watcher (or fs.watch)
```

---

## 7. Open Questions

- **Additional grammars:** Which languages beyond TypeScript need entity extraction?
- **Entity ID scheme:** `kind:name` is simple but may collide across files. Consider `kind:filepath:name` or content-addressed IDs.
- **Relationship granularity:** Do we need call-site line numbers? Argument types? Or just caller/callee edges?
- **Graph visualization:** Add a query endpoint for visualizing the entity graph (e.g., D3 force layout, Mermaid diagrams)?
- **In-memory adjacency list:** If multi-hop traversal becomes a hot path, layer an in-memory adjacency map on top of Postgres for sub-microsecond graph walks.
- **ast-grep vs raw tree-sitter queries:** ast-grep's pattern syntax (`class $NAME { $$$ }`) may be simpler for common extraction patterns. Evaluate DX trade-off.

---

## References

- [Reliable Graph-RAG for Codebases: AST-Derived Graphs vs LLM-Extracted Knowledge Graphs (Jan 2026)](https://arxiv.org/html/2601.08773)
- [node-tree-sitter](https://github.com/tree-sitter/node-tree-sitter)
- [ast-grep JavaScript API](https://ast-grep.github.io/guide/api-usage/js-api.html)
- [OXC Parser](https://www.npmjs.com/package/oxc-parser)
- [Tree-sitter Query Syntax](https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html)
- [Building Call Graphs with Tree-sitter](https://dzone.com/articles/call-graphs-code-exploration-tree-sitter)
- [CodeRAG with Dependency Graph Using Tree-sitter](https://medium.com/@shsax/how-i-built-coderag-with-dependency-graph-using-tree-sitter-0a71867059ae)
- [Semantic Code Graph Paper](https://arxiv.org/html/2310.02128v2)
