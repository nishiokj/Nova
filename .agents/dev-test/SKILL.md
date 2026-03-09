---
name: dev-test
description: Write developer test suites using the Reimplementation Test methodology. Discovers behavioral contracts, tests at architectural boundaries, pushes input interfaces to extremes, and validates against an ungameable quality criterion. Invoke with /dev-test <target>.
user-invocable: true
---

# Developer Test Suite — Reimplementation Test Methodology

You are writing a **developer test suite**, not a unit test suite. The boundary is the module's public interface, not each internal class. Test behavior, not structure.

## North Star: The Reimplementation Test

A test suite is complete when a competent developer could **reimplement the module from the tests alone**, producing something behaviorally equivalent without ever seeing the source.

This is the ONLY quality criterion. Every test you write must serve this goal.

**Two-axis validation:**

| | High mutation kill | Low mutation kill |
|---|---|---|
| **High refactor resilience** | GOOD TESTS — assert on behavior | WEAK TESTS — execute but don't assert |
| **Low refactor resilience** | OVER-COUPLED — assert on internals | WORTHLESS — neither detect bugs nor survive change |

- **Mutation kill rate**: Inject a bug that changes observable behavior → at least one test must fail. If none fails, you have a coverage gap.
- **Refactoring resilience**: Restructure internals without changing behavior → all tests must still pass. If a test breaks, it's coupled to implementation.

A test that fails either axis is a bad test, regardless of what it "covers."

---

## Invocation

When invoked with `/dev-test <target>`, `<target>` is the module, file, function, or feature area to test. If no target is given, ask the user what to test.

---

## Health Directory

All test health artifacts are stored in a temp directory outside the repo:

```
/tmp/test-health-$(echo "$(git rev-parse --show-toplevel)" | md5 -q | cut -c1-12)/
```

Compute this path at the start of every invocation. This is the shared interface between you and the red team — you never communicate directly.

---

## Phase 0: Structural Analysis via Test Health

Before doing anything else, use the **test-health system** to understand the target's structure. This is the foundation for all subsequent phases.

### 0.1 Check for entity graph availability

If the project has an entity graph database (check for `DATABASE_URL` or `TEST_DATABASE_URL` env var), use the `test-health` CLI or the TestHealthModule API to gather structural data:

```bash
# What are the testable boundaries?
test-health boundaries <target-filepath> --json

# What does this boundary depend on? How to wire it?
test-health deps <entity-id> --json

# What's the call tree? Where are the assertion points?
test-health tree <entity-id> --json

# What env vars does it need?
test-health env <entity-id> --json

# What's untested?
test-health gaps <target-filepath> --json
```

### 0.2 Use test-health output to guide your work

The test-health system tells you:

1. **Boundaries** — the exported functions/classes with external callers. These are your test targets. Prioritize by fan-in (most-imported first).

2. **Dependencies** — what each boundary needs to run. Each dep has a status:
   - `wirable` — a test substitute exists in `test-health.yaml`. Use it. The registry provides setup/inspect/teardown code.
   - `blocked` — no substitute, and the registry explicitly marks it as a blocker. **Stop.** Report the blocker to the user. Do NOT mock it.
   - `unknown` — no registry entry. Flag it for the developer to add. Do NOT mock it.

3. **Call tree** — the functions reachable from the boundary. Cross-module calls on injected dependencies are your **assertion points** — places where data persists beyond the return value.

4. **Env vars** — environment variables read in the call tree. Covered vars have test defaults. Unmapped vars are blockers.

5. **Readiness verdict** — `ready` means all deps are wirable and all env vars are covered. `blocked` means at least one dependency cannot be satisfied in tests.

### 0.3 Check for mutation testing report

Also check if a health report exists at `<health_dir>/report.json`.

**If it exists**, read it. It contains:

- Per-fault-class kill rates (how many injected bugs your tests caught)
- Blind spots (fault classes with zero mutations)
- Survived mutations (specific behavioral changes your tests failed to detect)

**Use this to focus your work:**

1. **Weak fault classes** (kill rate < 80%): Prioritize tests that catch mutations in these categories:
   - `wrong_value` — computation produces incorrect result
   - `wrong_path` — control flow takes incorrect branch
   - `missing_action` — operation that should happen is skipped
   - `wrong_binding` — correct operation applied to wrong data
   - `wrong_sequencing` — operations happen in wrong order
   - `boundary_error` — off-by-one, inclusive/exclusive, edge condition
   - `error_handling` — error swallowed, wrong error, missing propagation
   - `resource_lifecycle` — leak, missing cleanup, use-after-close

2. **Survived mutations**: Read their `gap` descriptions. Each tells you what property is unverified. Write tests that close those gaps.

**If no entity graph or report exists**, proceed with manual discovery from Phase 1.

---

## Phase 1: Discovery

Before writing a single test, understand the behavioral surface. Do NOT skip this phase. Use Glob, Grep, and Read to actually examine the code.

**If you have test-health data from Phase 0**, use it to accelerate discovery:
- Boundaries from test-health = your public interface
- Call tree = your data flow map
- Deps = your architectural boundaries

**If working without test-health**, manually identify:

### 1.1 Identify the public interface

Find every entry point that external code can call:

- Public functions, methods, trait/interface implementations
- Exported types and their constructors
- CLI arguments, API endpoints, message handlers
- Configuration options that change behavior

**Ignore** private/internal functions and helpers. You will NOT test these directly — they are exercised through the public interface.

### 1.2 Trace data flow

For each public entry point:

- What inputs does it accept? (types, ranges, domain invariants)
- What outputs does it produce? (return values, mutations, side effects, errors)
- What state does it read or modify? (database, filesystem, in-memory)
- What external systems does it touch? (network, clock, randomness)

### 1.3 Surface implicit contracts

These are behaviors the code promises but may not document:

- **Error behavior**: Invalid input → panic, error return, or silent correction?
- **Ordering**: Is output order deterministic? Stable? Dependent on input order?
- **Idempotency**: Same call twice → same result?
- **Atomicity**: On partial failure, is state rolled back or left dirty?
- **Resource lifecycle**: Are handles closed, memory freed, locks released?
- **Invariants**: What must always be true before and after a call?

### 1.4 Map architectural boundaries

**If test-health provided dependency info**, use it directly — wirable deps get test substitutes, blocked deps are flagged.

**Otherwise**, draw the line between your code and external systems:

| BOUNDARY — use test substitute | NOT A BOUNDARY — use real instances |
|---|---|
| Database connections | Internal collaborator classes |
| HTTP/gRPC clients | Data structures and value objects |
| Filesystem I/O | Pure utility functions |
| System clock, timers | In-process event handlers |
| Random number generators | Your own trait implementations |
| Environment variables | Anything you own and control |
| External process execution | |

---

## Phase 2: Contract Catalog

For each public entry point, write a plain-English list of behavioral contracts **before writing any test code.**

```
FUNCTION: process_order(order: Order) -> Result<Receipt, OrderError>

CONTRACTS:
- Valid order with in-stock items → Receipt with correct total
- Order with out-of-stock item → Err(OutOfStock) listing which items
- Negative quantity → Err(InvalidQuantity)
- Empty order (no items) → Err(EmptyOrder)
- Total includes tax when tax_rate > 0
- Total rounds to 2 decimal places (half-even)
- On success: inventory decremented for each item
- On failure: inventory unchanged (atomic rollback)
```

Every contract becomes at least one test. If you cannot state a contract in plain English, you don't understand the behavior well enough to test it.

---

## Phase 3: Dependency Wiring

### The no-mock rule

**Never mock.** If a dependency is marked `wirable` in the test-health output, use the registered test substitute. If it's marked `blocked` or `unknown`, stop and tell the user — do not mock it.

### Wiring from test-health registry

When test-health provides a `wirable` dependency with setup/inspect/teardown snippets:

```typescript
// test-health says: Database → SQLiteMemory (src/infra/sqlite-memory.ts)
// setup: const db = new SQLiteMemory(); await db.runMigrations()
// inspect: const rows = await db.query("SELECT * FROM orders")
// teardown: await db.close()

// Use this directly in your test setup:
let db: SQLiteMemory
beforeEach(async () => {
  db = new SQLiteMemory()
  await db.runMigrations()
})
afterEach(async () => {
  await db.close()
})
```

### When test-health is unavailable

Fall back to the bright-line rule: substitute at system boundaries, use real instances for everything else.

- **Prefer fakes over mocks.** An in-memory database beats a mock database because it enforces real constraints.
- **Mocks must be dumb.** A mock containing business logic is a parallel implementation that can diverge from reality.
- **Never mock what you're testing.**
- **If mocking is painful, the design might be wrong.**

---

## Phase 4: Test Writing — Staged Model

### Stage 1: Trunk Verification

Test the boundary's return value — the trunk of the call tree.

For each boundary, verify:
- Valid inputs → expected return value
- Invalid inputs → expected errors
- Edge inputs → correct boundary behavior

This catches the majority of bugs. If the return value is correct, internal computation is correct.

### Stage 2: Subtree Leaf Verification

For each **assertion point** in the call tree (injected dependency calls that persist data):

After the boundary runs, inspect the test substitute's state:
- Query the test database for expected rows
- Check the in-memory event bus for expected events
- Inspect any other injectable state

This catches bugs that don't manifest in the return value — silent data corruption, wrong events, missing writes.

**Test-health identifies these automatically**: they are the `injected=true` nodes in the call tree.

### Stage 3: Input Extremes

For every input parameter, push it to the edges of what the type system allows.

#### Numeric
| Category | Values |
|---|---|
| Zeros | `0`, `-0.0` |
| Signs | Positive, negative |
| Type limits | `MAX`, `MIN`, overflow, underflow |
| Float specials | `NaN`, `Infinity`, `-Infinity` |
| Off-by-one zone | Values at and around known boundaries |

#### Strings
| Category | Values |
|---|---|
| Empty / whitespace | `""`, `" "`, `"\t"`, `"\n"` |
| Unicode | Multi-byte, emoji, RTL, zero-width joiners |
| Injection | Null bytes, format strings, control characters |
| Deceptive | `"null"`, `"undefined"`, `"true"`, `"0"` |

#### Collections
| Category | Values |
|---|---|
| Size | Empty, single element, very large |
| Content | Duplicates, null elements |
| Order | Pre-sorted, reverse-sorted, random |

#### State-dependent
- Call methods in unexpected order
- Call the same operation twice (idempotency)
- Use after error
- Concurrent calls (if thread safety implied)

---

## Phase 5: Test Design Principles

### Name tests by behavior, not by method

```
BAD:  test_process_order, test_process_order_2, test_process_order_error
GOOD: test_valid_order_returns_receipt_with_correct_total
GOOD: test_out_of_stock_item_returns_error_listing_unavailable_items
GOOD: test_empty_order_is_rejected
```

### One behavioral assertion per test

Verify one contract per test. Multiple `assert` statements are fine if they verify aspects of the **same behavior**.

### Arrange-Act-Assert, strictly

```
// Arrange — set up preconditions (wire deps from test-health registry)
// Act — ONE call to the public interface (the boundary)
// Assert — verify the observable outcome (trunk + subtree leaves)
```

### Test the sad path harder than the happy path

A 60/40 split toward sad-path/edge-case tests is usually right.

### No test interdependence

Each test sets up its own world and tears it down. Never share mutable state.

---

## Phase 6: Self-Validation

After writing the suite, validate against the North Star.

### Reimplementation check

For each test: *"If I deleted the source and only had this test, what behavior would it specify?"*

- *"it specifies that method X is called with argument Y"* → **implementation-coupled**. Rewrite.
- *"it specifies that input A produces output B"* → **behavioral**. Keep.

### Coverage gap check

Walk the contract catalog. Every contract must have at least one test. If test-health showed assertion points (injected dependencies in the call tree), verify you have subtree assertions for each.

### Blocker check

If test-health reported any `blocked` or `unknown` dependencies, verify you flagged them in your output rather than working around them with mocks.

---

## Output

Structure the test suite deliverable as:

1. **Structural analysis** — Test-health boundaries, readiness verdicts, blockers (if available)
2. **Discovery summary** — The public interface, boundaries, key behaviors you found
3. **Contract catalog** — Plain-English behavioral contracts per entry point
4. **Test code** — Organized by behavioral area, using the project's existing test framework, conventions, and directory structure. Wired with test substitutes from the registry.
5. **Validation notes** — Any remaining gaps, risks, or areas where coverage could be stronger. Include any blockers surfaced by test-health.

Match the style, naming conventions, and file structure of existing tests in the codebase. Do not introduce new test frameworks or dependencies unless the existing ones are clearly insufficient.
