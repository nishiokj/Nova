---
name: test
description: >
  AST-driven behavioral test writer. Uses the entity graph CLI to mechanically
  identify boundaries, wire dependencies, and recursively test from the largest
  behavioral surface inward. Invoke with /test <target>.
user-invocable: true
---

# Behavioral Test Writer

## Adversarial Reality

Your tests will be reviewed by a separate skeptical agent whose goal is to falsify them.

If the skeptic catches any of the following, you lose points:
- bug-locking: preserving current bugs or implementation accidents as the contract
- helper-first evasion: testing cheap pure helpers while higher-risk ready boundaries are left untouched
- silent skips or hidden infra gating
- mocking owned code or leaning on substitutes without checking observable behavior
- private-constant coupling, identity assertions, or exact shape/count trivia
- shallow or conditional assertions that can pass while behavior is wrong

Write as if every shortcut will be attacked.

You write tests by following the entity graph, not by reading source and guessing. The AST has already identified every boundary, dependency, call tree, and env var. Your job is to translate that mechanical map into behavioral tests.

## Mantra

1. Extract large boundaries from the AST graph
2. Plumb dependencies to minimize mocking — use real implementations down to the system boundary
3. Test large behaviors end-to-end at the boundary
4. Test edge cases at the entrypoints
5. Assert the return values
6. Find subtrees in the main path that have side effects — things that return, modify, or persist through injected deps
7. Recursively treat each side-effecting subtree as its own sub-boundary and repeat

---

## Phase 0: Bootstrap Test Infrastructure

Before writing ANY test, verify the test environment exists. **If infrastructure is missing, set it up — do not skip or mock around it.**

### Database

Most boundaries in this project need Postgres. Set it up:

```bash
# Start Postgres (Docker or local) + run migrations
bun run db:setup

# Verify it's reachable
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/agent_memory" \
  bun -e "import postgres from 'postgres'; const sql = postgres(process.env.DATABASE_URL); await sql\`SELECT 1\`; await sql.end(); console.log('OK')"
```

For entity-graph tests specifically, the schema is created via `SCHEMA_DDL`:
```typescript
import { SCHEMA_DDL } from 'packages/plugins/entity-graph/src/schema.js'
await sql.unsafe(SCHEMA_DDL)
```

### Env Vars

Run `test-health env <entity-id>` to see what env vars the boundary reads. For each:

| Status | Action |
|---|---|
| Var has a test-safe default (e.g., `NODE_ENV=test`) | Set it in `beforeAll` |
| Var is a secret/credential | Check `.env` for a dev value. If present, use it. If not, **escalate** (see below). |
| Var controls behavior (feature flags, mode switches) | Test with multiple values — this is a behavioral axis. |

### Connectivity Check

Before the test suite runs, verify all required resources are reachable. If a resource is down, **fail loudly with a clear error**, not a silent skip.

```typescript
// WRONG — silent skip hides missing infrastructure
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip

// RIGHT — fail with actionable message
beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL required. Run: bun run db:setup')
  }
  sql = postgres(process.env.TEST_DATABASE_URL)
  await sql`SELECT 1`.catch(() => {
    throw new Error('Cannot connect to test database. Run: bun run db:setup')
  })
})
```

**Exception:** If the target boundary genuinely does not need a database (pure computation, in-memory only), do not require one. The CLI deps output tells you.

### Escalation

Some resources genuinely require user input. When you cannot unblock yourself, **ask with a specific, actionable request** — not a vague "I'm stuck."

**Things you CAN do yourself** (do not ask):
- Start/create Docker containers for databases or services
- Install dependencies needed to run or test within containers
- Create test databases, run migrations, seed data
- Set env vars that have obvious test defaults
- Create temp directories, fake clocks, in-memory substitutes
- Write Dockerfiles, docker-compose files, or setup scripts if they don't exist
- Install dev dependencies in package.json

**Things you MUST ask the user for:**
- Secrets, API keys, or credentials not in `.env` and not derivable
- Access to external third-party services (Stripe, AWS, OAuth providers)
- Clarification on business logic you don't understand from the source

**How to ask:**

Be specific. State what boundary you're testing, what resource you need, and what the user can do to provide it. Give them a concrete action — a command to run, a value to provide, or a decision to make.

```
BLOCKED: boundary `function:src/auth/verify.ts:verifyToken`
NEED: OAUTH_CLIENT_SECRET — this boundary reads it via process.env.
       Not found in .env. I cannot generate a valid test value for this.
ACTION: Either:
  (a) Add OAUTH_CLIENT_SECRET=<your-test-value> to .env
  (b) Tell me if there's a test/sandbox OAuth provider I should use
  (c) Tell me to skip this boundary — I'll move to the next one
```

**Rules:**
- Exhaust self-service options before asking. Check `.env`, check existing test files for patterns, check package.json scripts.
- Ask once per resource, not once per test. If you need `TEST_DATABASE_URL`, ask once and use it everywhere.
- If the user says "skip it," that boundary is deferred, not mocked. Move on. Do not invent a substitute.
- Never silently assume a default for credentials or secrets. Wrong credentials produce tests that pass locally and fail everywhere else.

---

## CLI

The entity graph CLI provides your mechanical foundation. Every command requires `DATABASE_URL` (from `.env` or `--db <url>`).

```bash
# Actual invocation
CLI="bun run packages/plugins/entity-graph/src/cli.ts"

# List boundaries — exported entities with cross-file callers, ordered by fan-in
$CLI boundaries [filepath]
$CLI gaps [filepath]                    # Untested/blocked boundaries only

# Inspect a specific boundary
$CLI deps <entity-id>                   # Injectable dependencies + wiring status
$CLI tree <entity-id> [--max-depth N]   # Call tree with assertion points (injected=true)
$CLI env <entity-id>                    # Env vars read in the call tree

# Full project index (JSON) — all boundaries, deps, trees, env vars
$CLI index [filepath]
```

---

## Process

When invoked with `/test <target>`:

### 1. Get Boundaries

Run `boundaries <target>` or `gaps <target>` to find untested ones.

Each boundary has:
- **Entity ID** — `function:src/orders.ts:processOrder`
- **Fan-in** — how many files depend on it. Higher = test first.
- **Readiness** — `ready` (all deps wirable), `blocked` (unwirable deps), `unknown`

Start with the highest fan-in ready boundary.

### 2. Map the Boundary

For your chosen boundary, run all three:

```bash
$CLI deps <entity-id>       # What does it need?
$CLI tree <entity-id>       # What does it call? Where are assertion points?
$CLI env <entity-id>        # What env vars are in play?
```

Then **read the actual source**. The CLI gives structure. You need to understand:
- What it returns for valid/invalid inputs
- What errors it throws
- What side effects it produces through injected deps

### 3. Wire Dependencies

From `deps`, determine how to provide each parameter:

| Dep Type | Strategy |
|---|---|
| Value types, configs, options | Pass directly |
| Internal collaborators (same codebase) | **Use real instances** — these are NOT mocking targets |
| `Sql` / database connections | Real test database (see Phase 0). TRUNCATE between tests. |
| HTTP/gRPC clients | Fake server or recording proxy. Never `jest.fn()`. |
| Filesystem I/O | Temp directory, real reads/writes, clean up in `afterEach` |
| Clock / timers | Vitest fake timers (`vi.useFakeTimers()`) |
| Env vars | Set in `beforeAll`, restore in `afterAll` |

**The goal is the longest possible real call chain before hitting a system boundary.** Do not mock what you own.

### 4. Test the Trunk

The boundary's return value is the trunk of the call tree.

For each behavioral contract:
- Arrange: wire deps, seed state
- Act: ONE call to the boundary
- Assert: check the return value against a **specific expected value**

Cover in this order:
1. **Happy path** — valid input, expected output
2. **Error paths** — invalid input, expected error type and message
3. **Edge cases** — empty inputs, boundary values, type extremes, unexpected combinations

Bias 60/40 toward sad paths.

### 5. Assert Subtree Side Effects

From `tree`, find nodes where **`injected=true`**. These are cross-module calls on injected dependencies — places where data persists beyond the return value.

After the boundary runs, **query the real resource** to verify the side effect:
```typescript
// After calling the boundary
const rows = await sql`SELECT * FROM entity_graph.entities WHERE filepath = ${filepath}`
expect(rows).toHaveLength(3)
expect(rows[0].name).toBe('processOrder')
```

A correct return value with wrong side effects is a silent data corruption bug. These assertions catch it.

### 6. Recurse

Recurse into call tree nodes that meet ALL of these criteria (mechanical, not judgment):
- **`injected=true`** in the call tree (crosses a module boundary)
- **Is itself a boundary** in the entity graph (has cross-file callers, fan-in > 0)
- **Has its own call tree** with at least one `injected=true` subtree node

For each, go back to Step 2. The recursion bottoms out when a node has no further injected subtrees — it's a leaf that produces side effects only through the boundary above it.

### 7. Validate

For each test: "If I deleted the source and only had this test, what behavior would it specify?"

- "It specifies that method X is called with argument Y" → **coupled to implementation**. Rewrite.
- "It specifies that input A produces output B" → **behavioral**. Keep.

Before you stop, assume the skeptic will target the most recent test adds and ask:
- Which minimal wrong-value or wrong-path mutation would survive this file?
- Which risky ready boundary did I avoid because a helper was easier?
- Am I asserting a contract, or just documenting today's implementation?

---

## Anti-Gaming Rules

These prevent tests that look comprehensive but verify nothing.

### Banned Assertion Patterns

```typescript
// BANNED — verifies existence, not correctness
expect(result).toBeDefined()
expect(result).toBeTruthy()
expect(result).toBeInstanceOf(Object)
expect(result).toHaveProperty('total')
expect(existingError).toBe(err)              // same reference
expect(entry).toBe(REGISTRY.foo)             // identity / storage coupling
expect(Object.keys(config)).toHaveLength(5)  // exact key-count trivia
expect([...params.keys()]).toHaveLength(7)   // exact query-param trivia

if (maybeValue) {
  expect(maybeValue.foo).toBe('bar')         // conditional assertion can silently pass
}

// REQUIRED — verifies specific behavioral output
expect(result.total).toBe(42.50)
expect(result.items).toHaveLength(3)
expect(result.items[0].name).toBe('Widget')
```

Every assertion must be **data-dependent**: it must fail if the boundary computes a different value. If you can change the boundary's implementation and the assertion still passes, it's not a real assertion.

### Banned Shortcuts

| Shortcut | Why It's Wrong | What To Do Instead |
|---|---|---|
| `describe.skip` for missing infra | Hides that tests don't run | Fix the infra (Phase 0) or flag as blocker |
| Mocking an internal collaborator | Tests mock interactions, not behavior | Use the real collaborator |
| Snapshot tests (`toMatchSnapshot`) | Pins entire output, breaks on any change, doesn't specify WHICH properties matter | Assert on specific properties |
| Copy-pasting computation from source into test | Tautology — tests that the code equals itself | Derive expected values independently |
| `expect(() => fn()).not.toThrow()` as sole assertion | Verifies the function runs, not what it produces | Assert on the return value |
| Exact key counts / exact query-param counts | Couples tests to incidental structure, not behavior | Assert required fields and semantics |
| Identity / same-reference assertions | Couples tests to object reuse or in-place mutation | Assert semantic contents and observable effects |
| Conditional assertions (`if (value) expect(...)`) | Can pass when the target disappears entirely | First assert the target exists, then assert its value |
| Comments like "current implementation", "matches first", "by design" to justify expectations | Usually preserves an implementation accident or bug | State the intended contract, not today's quirk |
| Only testing pure helpers while ready exported/stateful boundaries remain | Creates broad-looking but low-value coverage | Start with the highest-risk ready boundary and work inward |

### Required Practices

1. **Every test must have at least one data-dependent assertion.** A test that only checks types, shapes, or existence is not a test.
2. **Error path tests must assert on the error type AND the error content** (message or properties). `expect(fn).toThrow()` alone is insufficient — it doesn't verify WHICH error.
3. **Side effect tests must query the real resource**, not check that a mock was called. `expect(mockDb.query).toHaveBeenCalledWith(...)` tests the calling convention, not the behavior.
4. **If a higher-risk ready boundary exists, do not stop at helper tests.** Pure helpers are allowed only after the exported or stateful boundary is covered, or when you explicitly mark the boundary blocked.
5. **No conditional pass paths.** If the value under test might be absent, assert on that absence or fail loudly. Do not make the assertion optional.
6. **Track a boundary ledger in your handoff.** List: ready boundaries tested, ready boundaries deferred, blocked boundaries, and why.
7. **Assume a skeptic will try minimal behavior-changing probes.** If a wrong-value, wrong-path, missing-action, or swallowed-error mutation would obviously survive, the file is not done.

---

## Test Isolation

### Database Tests

```typescript
let sql: ReturnType<typeof postgres>

beforeAll(async () => {
  sql = postgres(process.env.TEST_DATABASE_URL!, { max: 2 })
  await sql.unsafe(SCHEMA_DDL)  // or: await migrate(db)
})

afterAll(async () => {
  await sql.end()
})

beforeEach(async () => {
  // Clean slate per test — TRUNCATE is fast and deterministic
  await sql`TRUNCATE entity_graph.entities CASCADE`
})
```

### Parallel Safety

Vitest runs test files in parallel by default. Database tests that share tables will interfere.

Options (pick one per test file):
1. **Schema-per-file**: Create a unique schema per test file, drop in `afterAll`
2. **Sequential execution**: Mark integration test files for serial execution via vitest config
3. **Transaction rollback**: Wrap each test in a transaction, rollback in `afterEach`

For entity-graph tests, option 1 is cleanest — the DDL already supports schema creation.

---

## Constraints

- Match the project's existing test framework (Vitest), conventions, and directory structure (`tests/`)
- Name tests by behavior: `valid_order_returns_receipt_with_correct_total`
- One behavioral contract per test. Multiple asserts on the same behavior are fine.
- Arrange-Act-Assert strictly.
- No test interdependence. Each test owns its setup and teardown.
- Never mock internal collaborators.
- Do not test private functions directly — exercise them through the boundary.
- Do not write tests without first running the CLI commands.
- If a resource cannot be wired, the boundary is **blocked** — say so and move on. Do not mock around it.
