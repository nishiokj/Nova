# Test Health System — Implementation Spec

## Goal

Given any module in a codebase, mechanically answer: **can an agent write a reliable end-to-end test for this, right now?** If yes, guide it. If no, say exactly what's blocking.

The system does not generate tests. It provides the structural awareness — boundaries, call trees, dependency wiring, environment requirements — that makes test authoring systematic rather than ad hoc. An LLM agent (or a human) uses this information to write tests that are top-down, mock-free, and resilient to implementation changes.

---

## Design Philosophy

### Top-Down, Not Bottom-Up

Traditional mutation testing asks "did you test this operator?" — bottom-up, line-level, brittle. We start from the **root of the call tree** and work down. If the return value is correct for all input partitions, internal operator correctness follows for free. The only things that need separate assertions are **subtree leaves that diverge from the trunk** — places where data persists or escapes beyond the return value.

### No Mocks

Mocking creates invisible regions where bugs hide. Instead of mocking dependencies, inject real, controllable implementations. Instead of `MockDb`, use SQLite in-memory. Instead of `MockEventBus`, use an in-memory array. The test runs through real code paths. If a dependency truly cannot run in tests (third-party API), that's a **blocker** the system surfaces — not something it papers over with a mock.

### Derive, Don't Maintain

The #1 source of maintenance debt in test infrastructure is hand-maintained configuration that drifts from the code. Everything possible is derived from the entity graph and source scanning. The only manually maintained artifact is a small **dependency substitution table** that maps production dependencies to test-time alternatives. This changes rarely (when you add a new external dependency) and is high-value (it encodes the one thing the code can't tell you: what to use instead of Postgres in tests).

### Simple Primitives, Structural Guarantees

No adversarial games, no scoring models, no fault class taxonomies. The primitives are:
1. The entity graph tells you the structure
2. The call tree tells you the assertion points
3. The environment registry tells you how to wire deps
4. Coverage tells you what's live vs dead

If these are right, gaming is structurally infeasible — there's nothing to game.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     ENTITY GRAPH                         │
│          (existing: entities, edges, queries)             │
│                                                           │
│  + call tree queries (new)                                │
│  + env var detection (new)                                │
│  + external call classification (new)                     │
│  + test file analysis (new)                               │
└──────────┬───────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────┐
│                  TEST HEALTH MODULE                       │
│                                                           │
│  Boundary discovery ─── call tree expansion               │
│  Environment check  ─── dep registry lookup               │
│  Gap detection      ─── test file cross-reference         │
│  Readiness verdict  ─── blocker identification            │
└──────────┬──────────────────────┬────────────────────────┘
           │                      │
           ▼                      ▼
┌──────────────────┐  ┌──────────────────────────────────┐
│   CLI / API      │  │   Skill (/dev-test)              │
│                  │  │                                    │
│  test-health     │  │  Reads test-health output.        │
│    boundaries    │  │  Directs the agent:               │
│    deps          │  │  - what to test                   │
│    env           │  │  - how to wire deps               │
│    gaps          │  │  - where to assert                │
│    tree          │  │  - what's blocking                │
└──────────────────┘  └──────────────────────────────────┘
```

### What Exists (entity-graph today)

| Capability | Implementation |
|---|---|
| AST parsing (tree-sitter) | `parser/extractor.ts` — classes, functions, methods, types, interfaces, enums |
| Edge extraction | `imports`, `calls`, `uses`, `owns`, `extends`, `implements` |
| Blast radius | Recursive CTE walking all edge types to depth N |
| Entity lookup | By file, by ID, by line range, callers/users/importers of |
| Unused export detection | Exported entities with zero inbound references |
| PR review pipeline | Diff → entity changes → blast radius → risk scoring → impact gaps |
| File leasing | Multi-agent coordination for concurrent file access |
| Postgres-backed | Durable, queryable, isolated `entity_graph` schema |

### What This Spec Adds

| Capability | Purpose |
|---|---|
| **Call tree from root** | Given a boundary, expand the full call tree downward with structural annotations |
| **Env var scanning** | Find all `process.env` / `Bun.env` reads in a call tree |
| **External call classification** | Identify calls that cross ownership boundaries (injected deps, I/O) |
| **Test file analysis** | Which test files cover which boundaries, what do they assert on |
| **Dependency substitution registry** | Map production deps to test-time alternatives |
| **Readiness verdicts** | Per-boundary: ready / blocked (with blocker details) |
| **Gap detection** | Boundaries without tests, subtree leaves without assertions |

---

## Core Concepts

### Boundary

A **boundary** is an exported entity (function, method, class) that is called or imported from outside its own module. Boundaries are the natural test targets — they are the stable interface that survives internal refactors.

**Derivation:** Fully mechanical from the entity graph.

```sql
-- Entities that are exported AND have at least one inbound edge from a different file
SELECT DISTINCT e.*
FROM entity_graph.entities e
WHERE e.exported = true
  AND e.kind IN ('function', 'method', 'class')
  AND (
    EXISTS (
      SELECT 1 FROM entity_graph.imports i
      JOIN entity_graph.entities caller ON caller.id = i.importer_id
      WHERE i.imported_id = e.id AND caller.filepath != e.filepath
    )
    OR EXISTS (
      SELECT 1 FROM entity_graph.calls c
      JOIN entity_graph.entities caller ON caller.id = c.caller_id
      WHERE c.callee_id = e.id AND caller.filepath != e.filepath
    )
    OR EXISTS (
      SELECT 1 FROM entity_graph.uses u
      JOIN entity_graph.entities user_e ON user_e.id = u.user_id
      WHERE u.used_id = e.id AND user_e.filepath != e.filepath
    )
  )
```

**Fan-in as weight:** A boundary called from 15 files matters more than one called from 1. The count of distinct external callers is the natural priority signal.

### Call Tree

The call tree from a boundary is the full graph of functions/methods reachable by following `calls` edges downward from that boundary. Unlike blast radius (which walks dependency edges *upward* from a change), the call tree walks *downward* from an entry point.

**Structure:**

```
boundary: processOrder(order)
├─ validateItems(order.items)         depth=1, same_module=true
├─ calculateTotal(items)              depth=1, same_module=true
├─ db.insertOrder(record)             depth=1, same_module=false, injected=true
│   └─ db.execute(sql, params)        depth=2, same_module=false, injected=true
├─ events.emit("order.created", p)    depth=1, same_module=false, injected=true
└─ return receipt                     (trunk terminus)
```

Each node in the call tree carries:
- `depth` — hops from the boundary
- `sameModule` — whether the callee is defined in the same file/module as the boundary
- `injected` — whether the callee is a method on a parameter (injected dependency) rather than a locally-defined function
- `feedsTrunk` — whether this node's return value flows back to the boundary's return value
- `divergentLeaf` — whether this node has effects beyond what the boundary returns

**`feedsTrunk` and `divergentLeaf` are not mutually exclusive.** A call to `db.insertOrder()` may return an `id` that feeds the trunk AND write a row to the database (divergent). Both properties can be true simultaneously.

**Limitation:** `feedsTrunk` and `divergentLeaf` cannot be determined from the AST alone with full accuracy. The AST tells you the structural call tree. It cannot tell you that a conditional branch inside a callee is unreachable given the data flowing from the specific caller. Runtime coverage is the oracle for what's actually live. The call tree provides the structural candidates; coverage filters out the dead branches.

### Assertion Points

An **assertion point** is a node in the call tree where the test should verify behavior. There are two categories:

1. **Trunk assertion** — the boundary's return value. Always an assertion point. Verified by calling the boundary with various inputs and checking the output.

2. **Subtree assertions** — nodes in the call tree whose effects are not fully captured by the trunk return value. These are the divergent leaves: DB writes, event emissions, state mutations on injected objects, file writes, HTTP calls.

The test health system identifies subtree assertion points structurally: they are calls on injected dependencies (method calls on constructor/function parameters whose types come from outside the module).

### Environment Readiness

A boundary is **ready for testing** when every dependency in its call tree has either:
- A test-time substitute registered in the dependency registry, OR
- Is a same-module pure function (no external deps needed)

A boundary is **blocked** when at least one dependency in its call tree has no registered test substitute and cannot be instantiated in a test environment.

---

## Entity Graph Extensions

### New Entity Properties

Add to `entity_graph.entities`:

```sql
ALTER TABLE entity_graph.entities
  ADD COLUMN IF NOT EXISTS params_text TEXT,
  ADD COLUMN IF NOT EXISTS return_text TEXT;
```

- `params_text` — the raw parameter list text (e.g., `(order: Order, db: Database)`)
- `return_text` — the raw return type text (e.g., `Promise<Result<Receipt, OrderError>>`)

These are extracted during parsing by reading the tree-sitter nodes for formal parameters and return type annotations. They're stored as raw text (not parsed types) to avoid building a type system. The agent or skill reads them to understand input/output shape.

### New Table: `entity_graph.env_reads`

```sql
CREATE TABLE IF NOT EXISTS entity_graph.env_reads (
  id          SERIAL PRIMARY KEY,
  entity_id   TEXT NOT NULL,     -- function/method that reads the env var
  var_name    TEXT NOT NULL,     -- e.g., "DATABASE_URL"
  filepath    TEXT NOT NULL,
  line        INTEGER,
  accessor    TEXT NOT NULL      -- "process.env" | "Bun.env" | "import.meta.env" | "dotenv"
);

CREATE INDEX IF NOT EXISTS idx_eg_env_reads_entity ON entity_graph.env_reads(entity_id);
CREATE INDEX IF NOT EXISTS idx_eg_env_reads_var ON entity_graph.env_reads(var_name);
```

**Extraction:** During AST parsing, detect patterns:
- `process.env.VAR_NAME` / `process.env['VAR_NAME']`
- `Bun.env.VAR_NAME`
- `import.meta.env.VAR_NAME`
- Destructuring: `const { VAR_NAME } = process.env`

Tree-sitter query for member expressions where the object is `process.env` or `Bun.env`:

```scheme
(member_expression
  object: (member_expression
    object: (identifier) @obj
    property: (property_identifier) @prop)
  property: (property_identifier) @var_name
  (#eq? @obj "process")
  (#eq? @prop "env"))
```

And subscript access:

```scheme
(subscript_expression
  object: (member_expression
    object: (identifier) @obj
    property: (property_identifier) @prop)
  index: (string) @var_name
  (#eq? @obj "process")
  (#eq? @prop "env"))
```

### New Table: `entity_graph.constructor_deps`

```sql
CREATE TABLE IF NOT EXISTS entity_graph.constructor_deps (
  id          SERIAL PRIMARY KEY,
  class_id    TEXT NOT NULL,      -- the class entity
  param_name  TEXT NOT NULL,      -- constructor parameter name
  param_type  TEXT,               -- type annotation text (if available)
  position    INTEGER NOT NULL    -- parameter ordinal position
);

CREATE INDEX IF NOT EXISTS idx_eg_ctor_deps_class ON entity_graph.constructor_deps(class_id);
```

**Extraction:** For each class with a constructor method, parse the constructor's formal parameters. Each parameter is a dependency that must be provided at instantiation — and therefore must be provided in tests.

### New Table: `entity_graph.function_deps`

```sql
CREATE TABLE IF NOT EXISTS entity_graph.function_deps (
  id          SERIAL PRIMARY KEY,
  function_id TEXT NOT NULL,      -- the function/method entity
  param_name  TEXT NOT NULL,
  param_type  TEXT,
  position    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eg_fn_deps_function ON entity_graph.function_deps(function_id);
```

Same as constructor deps but for standalone functions. If `processOrder(order: Order, db: Database)` takes a `db` parameter, this table records it.

---

## New Queries

### `callTreeFrom(entityId, maxDepth)`

Walk `calls` edges **downward** from a boundary entity. Returns each node with depth, whether it's in the same module, and whether the call is on an injected dependency.

```sql
WITH RECURSIVE call_tree AS (
  -- Seed: the boundary itself
  SELECT
    e.id,
    e.kind,
    e.name,
    e.filepath,
    e.start_line,
    e.end_line,
    e.exported,
    0 AS depth,
    e.filepath AS root_filepath,
    false AS injected
  FROM entity_graph.entities e
  WHERE e.id = $1

  UNION

  -- Walk calls edges downward (caller → callee)
  SELECT DISTINCT
    callee.id,
    callee.kind,
    callee.name,
    callee.filepath,
    callee.start_line,
    callee.end_line,
    callee.exported,
    ct.depth + 1,
    ct.root_filepath,
    callee.filepath != ct.root_filepath AS injected
  FROM call_tree ct
  JOIN entity_graph.calls c ON c.caller_id = ct.id
  JOIN entity_graph.entities callee ON callee.id = c.callee_id
  WHERE ct.depth < $2
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY depth ASC) AS rn
  FROM call_tree
  WHERE depth > 0
)
SELECT * FROM ranked WHERE rn = 1
ORDER BY depth ASC, filepath ASC
```

**Note on cross-file resolution:** The current entity-graph only resolves calls within the same file (`resolveCallTarget` checks `knownEntities` which is per-file). Cross-file call resolution is the primary gap to close. See [Extractor Improvements](#extractor-improvements).

### `envVarsInTree(entityId, maxDepth)`

Given a boundary, find all env vars read anywhere in its call tree.

```sql
WITH RECURSIVE call_tree AS (
  -- same CTE as callTreeFrom
  ...
)
SELECT DISTINCT er.var_name, er.accessor, er.entity_id, er.filepath, er.line
FROM call_tree ct
JOIN entity_graph.env_reads er ON er.entity_id = ct.id
ORDER BY er.var_name
```

### `depsOf(entityId)`

For a boundary function or class, return the injected dependencies — constructor params or function params whose types are interfaces/classes defined outside the module.

```sql
-- For a class boundary, get constructor deps
SELECT cd.param_name, cd.param_type, cd.position
FROM entity_graph.constructor_deps cd
WHERE cd.class_id = $1
ORDER BY cd.position;

-- For a function boundary, get function deps
SELECT fd.param_name, fd.param_type, fd.position
FROM entity_graph.function_deps fd
WHERE fd.function_id = $1
ORDER BY fd.position;
```

### `boundaries(filepath?)`

List all boundaries, optionally filtered to a file/module. Includes fan-in count.

```sql
SELECT
  e.*,
  (
    SELECT COUNT(DISTINCT caller.filepath)
    FROM entity_graph.calls c
    JOIN entity_graph.entities caller ON caller.id = c.caller_id
    WHERE c.callee_id = e.id AND caller.filepath != e.filepath
  ) +
  (
    SELECT COUNT(DISTINCT imp.filepath)
    FROM entity_graph.imports i
    JOIN entity_graph.entities imp ON imp.id = i.importer_id
    WHERE i.imported_id = e.id AND imp.filepath != e.filepath
  ) AS fan_in
FROM entity_graph.entities e
WHERE e.exported = true
  AND e.kind IN ('function', 'method', 'class')
  AND ($1 IS NULL OR e.filepath = $1)
  AND (
    EXISTS (SELECT 1 FROM entity_graph.calls c
            JOIN entity_graph.entities caller ON caller.id = c.caller_id
            WHERE c.callee_id = e.id AND caller.filepath != e.filepath)
    OR EXISTS (SELECT 1 FROM entity_graph.imports i
               JOIN entity_graph.entities imp ON imp.id = i.importer_id
               WHERE i.imported_id = e.id AND imp.filepath != e.filepath)
  )
ORDER BY fan_in DESC, e.filepath, e.start_line
```

### `testFilesFor(entityId)`

Find test files that import the boundary's module. Convention-based: files matching `**/*.test.ts`, `**/*.spec.ts`, `**/test_*.ts`, `**/__tests__/**`.

```sql
SELECT DISTINCT test_file.*
FROM entity_graph.entities test_file
WHERE test_file.kind = 'file'
  AND (
    test_file.filepath LIKE '%.test.ts'
    OR test_file.filepath LIKE '%.spec.ts'
    OR test_file.filepath LIKE '%__tests__%'
    OR test_file.filepath LIKE '%test_%'
  )
  AND EXISTS (
    SELECT 1 FROM entity_graph.imports i
    WHERE i.importer_id = test_file.id
      AND i.imported_id IN (
        SELECT id FROM entity_graph.entities WHERE filepath = (
          SELECT filepath FROM entity_graph.entities WHERE id = $1
        )
      )
  )
```

---

## Dependency Substitution Registry

### Purpose

The only manually maintained artifact. Maps production dependencies to their test-time alternatives. Located at the repository root: `test-health.yaml`.

### Schema

```yaml
# test-health.yaml
version: 1

substitutions:
  Database:
    # What the production code uses
    prod:
      type: PostgresDatabase
      module: src/infra/postgres.ts
      env: [DATABASE_URL]
    # What tests should use instead
    test:
      type: SQLiteMemory
      module: src/infra/sqlite-memory.ts
      env: []
      setup: |
        const db = new SQLiteMemory()
        await db.runMigrations()
      inspect: |
        // Query the db directly after test
        const rows = await db.query("SELECT * FROM orders")
      teardown: |
        await db.close()

  EventBus:
    prod:
      type: RedisEventBus
      module: src/infra/redis-events.ts
      env: [REDIS_URL]
    test:
      type: InMemoryEventBus
      module: src/infra/memory-events.ts
      env: []
      setup: |
        const bus = new InMemoryEventBus()
      inspect: |
        // Check emitted events
        bus.emitted  // Array<{ type: string, payload: unknown }>

  StripeClient:
    prod:
      type: StripeSDK
      module: src/payments/stripe.ts
      env: [STRIPE_SECRET_KEY]
    test:
      blocker: true
      reason: "No test substitute available. Stripe test mode requires STRIPE_TEST_KEY."
      # When blocker is true, the system reports this boundary as blocked
      # and does NOT suggest mocking.

env_defaults:
  # Env vars that should always be set in test environments
  NODE_ENV: test
  LOG_LEVEL: silent
  TZ: UTC

test_patterns:
  # Glob patterns that identify test files
  - "**/*.test.ts"
  - "**/*.spec.ts"
  - "**/__tests__/**/*.ts"
  - "**/test_*.py"
```

### Rules

1. **If a dependency has a `test` entry** — the system reports it as wirable and provides the setup/inspect/teardown snippets to the agent.
2. **If a dependency has `blocker: true`** — the system reports the boundary as blocked. The agent does not write a test for it. It does not mock. It flags it for human resolution.
3. **If a dependency is not in the registry** — the system reports it as **unknown**. The agent flags it for the developer to add a registry entry. No guessing, no mocking.
4. **Env vars** — if a call tree reads env vars, and those vars are listed in a substitution's `prod.env`, they're covered by the substitution. If they're not in any substitution, they're surfaced as "env var read but not mapped — add to registry or env_defaults."

### Why This Doesn't Rot

- The registry is keyed by **type names** that appear in the source code. If someone renames `PostgresDatabase`, the call tree will show an unresolved dependency. The registry entry stops matching. The system reports it.
- Adding a new dependency without a registry entry means `test-health deps` shows it as unknown. The feedback loop is immediate.
- The registry is ~20-50 lines for a typical project. It changes when you add a new external dependency, which happens rarely.

---

## Extractor Improvements

### Cross-File Call Resolution

The most important gap. Currently, `resolveCallTarget` only resolves calls within the same file. This means the call tree stops at file boundaries.

**Approach:** When the extractor encounters a call `foo.bar()` or `bar()`:

1. **Direct call (`bar()`):** Check if `bar` was imported from another file. If there's an import edge from the current file to another file with symbol `bar`, resolve the call to that entity.

2. **Method call on imported object (`foo.bar()`):** If `foo` is an imported symbol, resolve `foo` to its source entity, then look for method `bar` on that entity's class.

3. **Method call on parameter (`this.db.insert()`):** If `db` is a constructor parameter or function parameter, we can't resolve the concrete implementation from the AST — but we CAN record the call as targeting a method on the parameter's declared type. This is sufficient for call tree construction: we know the call crosses the ownership boundary.

**Implementation in `extractor.ts`:**

```typescript
// During extract(), after processing imports, build a symbol resolution map:
// importedSymbol → (sourceFile, entityId)
// Then during call extraction, check this map before falling back to local resolution.
```

This is the critical path item. Without cross-file call resolution, call trees are per-file only and miss the most important information: how does this boundary reach its dependencies?

### Parameter Extraction

For each function/method entity, extract formal parameter names and type annotations:

```typescript
// Tree-sitter query for formal parameters
const FORMAL_PARAMS_QUERY = `
(formal_parameters
  (required_parameter
    pattern: (identifier) @param.name
    type: (type_annotation (_) @param.type)?))
`
```

Store in `function_deps` and `constructor_deps` tables.

### Env Var Extraction

Add env var detection to the extraction pipeline. For each `process.env.X` or `Bun.env.X` access, record the variable name and the enclosing entity.

---

## Test Health Module

### API Surface

The test health module sits between the entity graph and the CLI/skill. It orchestrates queries and produces structured results.

```typescript
interface TestHealthModule {
  // Discovery
  boundaries(filepath?: string): Promise<BoundaryInfo[]>
  callTree(entityId: string, maxDepth?: number): Promise<CallTreeNode[]>

  // Environment
  depsFor(entityId: string): Promise<DependencyInfo[]>
  envVarsFor(entityId: string): Promise<EnvVarInfo[]>
  readiness(entityId: string): Promise<ReadinessVerdict>

  // Gap detection
  testCoverage(entityId: string): Promise<TestCoverageInfo>
  gaps(filepath?: string): Promise<GapReport>

  // Registry
  loadRegistry(): Promise<SubstitutionRegistry>
}
```

### Types

```typescript
interface BoundaryInfo {
  entity: Entity
  fanIn: number                    // count of external callers/importers
  hasTests: boolean                // any test file imports this boundary's module
  readiness: 'ready' | 'blocked' | 'unknown'
}

interface CallTreeNode {
  entity: Entity
  depth: number
  sameModule: boolean              // defined in same file as boundary
  injected: boolean                // call on an injected dependency
  paramName?: string               // if injected, which parameter
  paramType?: string               // if injected, the declared type
}

interface DependencyInfo {
  paramName: string
  paramType: string | null
  // From the registry:
  substitution?: {
    testType: string
    testModule: string
    setup: string
    inspect: string
    teardown?: string
  }
  blocker?: {
    reason: string
  }
  status: 'wirable' | 'blocked' | 'unknown'
}

interface EnvVarInfo {
  varName: string
  accessor: string                 // "process.env" | "Bun.env"
  readBy: Entity                   // which entity reads it
  coveredBy?: string               // which substitution covers it (if any)
  default?: string                 // from env_defaults in registry
  status: 'covered' | 'defaulted' | 'unmapped'
}

interface ReadinessVerdict {
  boundary: Entity
  ready: boolean
  deps: DependencyInfo[]
  envVars: EnvVarInfo[]
  blockers: string[]               // human-readable blocker descriptions
  testFiles: Entity[]              // existing test files for this boundary
}

interface GapReport {
  totalBoundaries: number
  tested: number
  ready: number
  blocked: number
  unknown: number
  boundaries: BoundaryInfo[]
}
```

---

## CLI Surface

### `test-health boundaries [filepath]`

List all boundaries in the project (or a specific file). Shows fan-in, test status, readiness.

```
$ test-health boundaries src/orders/

BOUNDARY                           FAN-IN  TESTS  STATUS
function:src/orders/process.ts:processOrder    12  yes    ready
function:src/orders/cancel.ts:cancelOrder       8  no     blocked
function:src/orders/validate.ts:validateOrder   6  yes    ready
class:src/orders/service.ts:OrderService        4  no     unknown

Totals: 4 boundaries, 2 tested, 2 ready, 1 blocked, 1 unknown
```

### `test-health deps <entity-id>`

Show what a boundary depends on and how to wire it for tests.

```
$ test-health deps function:src/orders/process.ts:processOrder

BOUNDARY: processOrder(order: Order, db: Database, events: EventBus)

DEPENDENCIES:
  db: Database
    prod: PostgresDatabase (src/infra/postgres.ts)
    test: SQLiteMemory (src/infra/sqlite-memory.ts)   [wirable]
    env:  DATABASE_URL → not needed (SQLite in-memory)

  events: EventBus
    prod: RedisEventBus (src/infra/redis-events.ts)
    test: InMemoryEventBus (src/infra/memory-events.ts)   [wirable]
    env:  REDIS_URL → not needed (in-memory)

ENV VARS IN CALL TREE:
  NODE_ENV        → defaulted to "test"
  LOG_LEVEL       → defaulted to "silent"

VERDICT: ready
```

### `test-health tree <entity-id>`

Show the call tree from a boundary with structural annotations.

```
$ test-health tree function:src/orders/process.ts:processOrder

processOrder(order, db, events)
├─ validateOrder(order)                    depth=1  same_module
├─ calculateTotal(order.items)             depth=1  same_module
├─ db.insertOrder(record)                  depth=1  injected(db: Database)
│   └─ db.execute(sql, params)             depth=2  injected(db: Database)
├─ events.emit("order.created", payload)   depth=1  injected(events: EventBus)
└─ return { id, total, status }

ASSERTION POINTS:
  1. Return value: { id, total, status }
  2. db.insertOrder → verify persisted row
  3. events.emit → verify emitted event
```

### `test-health env <entity-id>`

Check environment readiness for a specific boundary.

```
$ test-health env function:src/orders/cancel.ts:cancelOrder

BOUNDARY: cancelOrder(orderId: string, db: Database, stripe: StripeClient)

BLOCKERS:
  stripe: StripeClient
    No test substitute registered.
    prod: StripeSDK (src/payments/stripe.ts)
    env:  STRIPE_SECRET_KEY
    Action: Add a substitution to test-health.yaml or mark as blocker.

VERDICT: blocked (1 unresolved dependency)
```

### `test-health gaps [filepath]`

Show which boundaries lack tests, ordered by priority (fan-in).

```
$ test-health gaps

UNTESTED BOUNDARIES (by priority):
  function:src/orders/cancel.ts:cancelOrder          fan-in=8   blocked
  class:src/orders/service.ts:OrderService           fan-in=4   unknown
  function:src/auth/verify.ts:verifyToken            fan-in=22  ready  ← START HERE

TESTED BUT INCOMPLETE:
  function:src/orders/process.ts:processOrder        fan-in=12
    Missing subtree assertions:
      - db.insertOrder (no assertion on persisted data)
      - events.emit (no assertion on emitted events)
```

### `test-health init`

Bootstrap the `test-health.yaml` registry by scanning the codebase for injectable dependencies and env var reads, then generating a skeleton.

```
$ test-health init

Scanned 847 entities across 123 files.
Found 31 boundaries.
Found 8 unique injectable types: Database, EventBus, StripeClient, Logger, Cache, ...
Found 14 env var reads: DATABASE_URL, REDIS_URL, STRIPE_SECRET_KEY, NODE_ENV, ...

Generated: test-health.yaml
  8 substitution stubs (fill in test alternatives)
  14 env var entries (set defaults or mark as covered)
```

---

## Skill Interface

### `/dev-test <target>`

The skill reads test-health output and directs the agent. The skill's system prompt includes:

```markdown
## Test Health Skill

You are writing tests guided by structural analysis of the codebase.

### Rules

1. **Never mock.** If a dependency is marked `wirable` in the test-health output,
   use the registered test substitute. If it's marked `blocked` or `unknown`,
   stop and tell the user — do not mock it.

2. **Test from the boundary.** Call the boundary function with inputs, assert on
   outputs. Do not call internal/private functions.

3. **Assert at every assertion point.** The call tree shows where data persists
   beyond the return value. After calling the boundary, verify each assertion point:
   - Query the test database for expected rows
   - Check the in-memory event bus for expected events
   - Inspect any other injectable state

4. **Input partitions from types.** The boundary's parameter types define the input
   space. Test at least:
   - One valid input per output variant (success, each error type)
   - Edge cases from the types (empty, null, max, zero)
   - The boundary between valid and invalid

5. **Don't break on refactors.** Never assert on:
   - Internal function calls or call order
   - Log messages (unless logging IS the contract)
   - Intermediate state
   Assert only on the boundary's return value and the assertion points' observable state.
```

### Skill Workflow

```
1. Run `test-health deps <target>` → get dependency wiring
2. Run `test-health tree <target>` → get call tree and assertion points
3. Run `test-health env <target>` → check for blockers
4. If blocked → report blockers, stop
5. If ready:
   a. Set up test environment (instantiate test substitutes per registry)
   b. Write test cases (one per input partition)
   c. Each test: call boundary → assert return value → assert subtree leaves
   d. Run tests → fix failures → iterate
```

---

## Staged Testing Model

### Stage 1: Trunk Verification

For each boundary, verify the main path:
- Valid inputs → expected return value
- Invalid inputs → expected errors
- Edge inputs → correct boundary behavior

This catches the majority of bugs. If the return value is correct, internal computation is correct.

### Stage 2: Subtree Leaf Verification

For each assertion point in the call tree (injected dependency calls that persist data):
- After the boundary runs, inspect the test substitute's state
- Verify the correct data was persisted / emitted / sent

This catches bugs that don't manifest in the return value — silent data corruption, wrong events, missing writes.

### Stage 3: Coverage-Driven Gap Analysis (future)

Run the Stage 1 + 2 tests with coverage instrumentation. Cross-reference coverage with the call tree:
- Branches in the call tree that executed → live (covered by test inputs)
- Branches that didn't execute → either dead from this call path, or need different inputs
- The entity graph provides the structural candidates; coverage says which are live

This is where the "dead branch" insight applies: a conditional inside a callee that can never be true when called from this specific boundary is structurally present in the call tree but never executes. Coverage distinguishes "not tested" from "not reachable."

---

## Implementation Plan

### Phase 0: Extractor Improvements (prerequisite)

1. **Cross-file call resolution** — resolve calls to imported symbols, building cross-module `calls` edges
2. **Parameter extraction** — extract formal parameter names and type annotations for all functions/methods
3. **Env var extraction** — detect `process.env` / `Bun.env` reads and store in `env_reads` table
4. **Constructor dependency extraction** — parse constructor parameters and store in `constructor_deps`

These are all additions to `parser/extractor.ts` and new tree-sitter queries in `parser/queries.ts`. The schema additions (`env_reads`, `constructor_deps`, `function_deps`, `params_text`, `return_text`) go in `schema.ts`.

### Phase 1: Core Queries

1. **`callTreeFrom`** — recursive CTE walking calls edges downward
2. **`boundaries`** — exported entities with external callers, with fan-in
3. **`envVarsInTree`** — env vars reachable from a boundary
4. **`depsOf`** — injectable dependencies of a boundary
5. **`testFilesFor`** — test files that import a boundary's module

These are new functions in `queries.ts`.

### Phase 2: Test Health Module

1. **`SubstitutionRegistry`** — YAML parser for `test-health.yaml`
2. **`readiness(entityId)`** — cross-reference call tree deps against registry
3. **`gaps(filepath?)`** — boundaries without tests or with missing assertion points
4. **Integration with EntityGraph class** — add methods to the facade

### Phase 3: CLI

1. **`test-health` binary** — standalone CLI that connects to the entity-graph Postgres and reads `test-health.yaml`
2. Commands: `boundaries`, `deps`, `tree`, `env`, `gaps`, `init`
3. JSON output mode for programmatic consumption

### Phase 4: Skill

1. **Updated `/dev-test` skill** — reads test-health output, follows the rules
2. **Skill reads registry** — knows how to wire each dependency
3. **Skill follows staged model** — trunk first, then subtree assertions
4. **Skill respects blockers** — stops and reports instead of mocking

---

## What This Does NOT Do

1. **Does not generate tests.** Provides structure and guidance. The agent or human writes the actual tests.
2. **Does not run tests.** That's the test framework's job (vitest, jest, pytest, cargo test).
3. **Does not do mutation testing.** No operator perturbation, no fault classes, no adversarial games.
4. **Does not score or rate test quality.** The signal is binary per boundary: tested or not, subtree leaves asserted or not, environment ready or not.
5. **Does not detect semantic bugs.** It ensures structural coverage of boundaries and assertion points. Whether the assertions check the *right* values is the developer's responsibility.
6. **Does not resolve runtime types.** If a function takes `any` or an untyped parameter, the system can identify the dependency structurally (it's a parameter) but can't determine the concrete type. TypeScript type annotations are the input; without them, resolution is partial.
7. **Does not track conditional reachability.** A branch inside a callee that's unreachable from a specific caller appears in the call tree. Only runtime coverage can filter these. The system over-reports (safe direction) rather than under-reports.

---

## Success Criteria

The system is working when:

1. An agent can run `test-health deps <boundary>` and get everything it needs to set up a test environment — no guessing, no mocking, no reading unrelated source files.
2. An agent can run `test-health tree <boundary>` and know exactly where to assert — the return value plus every subtree leaf where data diverges.
3. `test-health gaps` shows which boundaries are untested and why, prioritized by impact (fan-in).
4. A test written using this system does not break when an implementation detail changes. It breaks only when the boundary's observable behavior changes.
5. When someone adds a new dependency, `test-health` immediately surfaces it as unknown/blocked. The feedback loop is same-session, not weeks-later.
