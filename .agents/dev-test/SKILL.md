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

## Phase 0: Check for Health Report

Before doing anything else, check if a health report exists at `<health_dir>/report.json`.

**If it exists**, read it. This report was produced by the referee (a deterministic script that ran mutation testing against the current codebase). It contains:

- Per-fault-class kill rates (how many injected bugs your tests caught)
- Blind spots (fault classes with zero mutations — untested dimensions)
- Survived mutations (specific behavioral changes your tests failed to detect)

**Use this to focus your work:**

1. **Weak fault classes** (kill rate < 80%): Prioritize writing tests that would catch mutations in these categories. The fault classes are:
   - `wrong_value` — computation produces incorrect result
   - `wrong_path` — control flow takes incorrect branch
   - `missing_action` — operation that should happen is skipped
   - `wrong_binding` — correct operation applied to wrong data
   - `wrong_sequencing` — operations happen in wrong order
   - `boundary_error` — off-by-one, inclusive/exclusive, edge condition
   - `error_handling` — error swallowed, wrong error, missing propagation
   - `resource_lifecycle` — leak, missing cleanup, use-after-close

2. **Survived mutations**: If the report lists specific mutations that survived, read their `gap` descriptions. Each one tells you exactly what behavioral property is unverified. Write tests that close those gaps.

3. **Blind spots**: Fault classes with `NOT TESTED` have zero mutation coverage — the mutation generator didn't produce any mutants in that category. You can't fix this (it's the red team's job), but be aware of the gap.

**If no report exists**, proceed with full discovery from Phase 1. You're starting cold.

---

## Phase 1: Discovery

Before writing a single test, understand the behavioral surface. Do NOT skip this phase. Use Glob, Grep, and Read to actually examine the code.

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

Draw the line between your code and external systems:

| BOUNDARY — mock this | NOT A BOUNDARY — use real instances |
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

## Phase 3: Mocking Philosophy

### The bright-line rule

**Mock at system boundaries. Never mock collaborators.**

A system boundary is where your code talks to something it doesn't own: network, disk, clock, OS, external processes. Everything else is a collaborator — test it with real instances.

### Why this is the only correct rule

- Mocking collaborators tests that your code calls certain methods in a certain order → **implementation coupling**. Refactor the collaboration, tests break, behavior didn't change.
- Mocking at system boundaries tests that your code produces the right output given certain external conditions → **behavioral testing**. Restructure all internal collaboration, tests still pass.

### Mock implementation guidance

- **Mocks must be dumb.** A mock containing business logic is a parallel implementation that can diverge from reality. Mocks return canned data or record calls. Nothing more.
- **Prefer fakes over mocks when available.** An in-memory database (SQLite) beats a mock database because it enforces real constraints. A fake clock that you advance manually beats mocking `SystemTime`.
- **Never mock what you're testing.** Don't mock internal methods of the thing under test to "isolate" one method. That tests nothing.
- **If mocking is painful, the design might be wrong.** Difficulty mocking often signals that the code has too many implicit dependencies or does too much. Consider refactoring the production code before writing a complex mock.

---

## Phase 4: Input Extremes

For every input parameter, push it to the edges of what the type system allows. These are the tests that find real bugs, not the happy-path tests.

### Numeric

| Category | Values |
|---|---|
| Zeros | `0`, `-0.0` |
| Signs | Positive, negative |
| Type limits | `MAX`, `MIN`, `MAX + 1` (overflow), `MIN - 1` (underflow) |
| Float specials | `NaN`, `Infinity`, `-Infinity`, subnormals |
| Off-by-one zone | Values at and around known boundaries |

### Strings

| Category | Values |
|---|---|
| Empty / whitespace | `""`, `" "`, `"\t"`, `"\n"` |
| Unicode | Multi-byte (`é`, `中`), emoji (`👨‍👩‍👧‍👦`), RTL, zero-width joiners |
| Injection | Null bytes (`\0`), format strings (`%s`, `{}`), control characters |
| Deceptive | `"null"`, `"undefined"`, `"true"`, `"0"`, `"NaN"`, `"<script>"` |
| Length | Single char, very long string (test implicit size assumptions) |
| Whitespace traps | Leading/trailing spaces, internal multiple spaces |

### Collections

| Category | Values |
|---|---|
| Size | Empty, single element, very large |
| Content | Duplicates (if uniqueness assumed), null elements (if type permits) |
| Nesting | Empty inner collections, deeply nested |
| Order | Pre-sorted, reverse-sorted, random (if order matters) |

### Optional / Nullable

- `None`/`null` for every optional parameter
- Every combination of present/absent optionals (if feasible, otherwise cover the important combos)

### State-dependent behavior

- Call methods in unexpected order
- Call the same operation twice (idempotency)
- Use after error (call again after a previous failure)
- Concurrent calls (if the interface implies thread safety)

### When property-based testing fits

If the module under test has properties that should hold for ALL inputs (not just specific examples), consider property-based tests:

- **Roundtrip**: `deserialize(serialize(x)) == x`
- **Invariant**: `sorted(list).is_sorted() == true` for any list
- **Equivalence**: `fast_path(x) == slow_path(x)` for any x
- **Idempotency**: `f(f(x)) == f(x)`

Use the project's existing property-testing library if available. Don't introduce one solely for this.

---

## Phase 5: Test Design Principles

### Name tests by behavior, not by method

```
BAD:  test_process_order, test_process_order_2, test_process_order_error
GOOD: test_valid_order_returns_receipt_with_correct_total
GOOD: test_out_of_stock_item_returns_error_listing_unavailable_items
GOOD: test_empty_order_is_rejected
```

A failing test name should tell you what behavior broke without reading the test body.

### One behavioral assertion per test

Verify one contract per test. Multiple `assert` statements are fine if they verify aspects of the **same behavior** (e.g., status code AND response body of one API call). Don't test two independent behaviors in one test.

### Arrange-Act-Assert, strictly

```
// Arrange — set up preconditions
// Act — ONE call to the public interface
// Assert — verify the observable outcome
```

No assertions in Arrange. No mutations in Assert. One logical Act.

### Test the sad path harder than the happy path

Happy paths get tested by manual usage and QA. The bugs live in:

- Error handling paths
- Boundary conditions
- Unexpected input combinations
- State after partial failures
- Resource cleanup after errors

Allocate test effort accordingly. A 60/40 split toward sad-path/edge-case tests is usually right.

### No test interdependence

Each test sets up its own world and tears it down. No test depends on another test's side effects, execution order, or shared mutable state. If setup is expensive, share immutable fixtures — never mutable state.

---

## Phase 6: Self-Validation

After writing the suite, validate against the North Star.

### Reimplementation check

For each test, ask: *"If I deleted the source and only had this test, what behavior would it specify?"*

- If the answer is *"it specifies that method X is called with argument Y"* → **implementation-coupled**. Rewrite.
- If the answer is *"it specifies that input A produces output B"* → **behavioral**. Keep.

### Coverage gap check

Walk the contract catalog from Phase 2. Every contract must have at least one test. Any behaviors you discovered during implementation that aren't in the catalog? Add tests for them.

### Mutation thought experiment

For each core behavior, imagine a subtle bug:

- Off-by-one in a loop
- Wrong comparison operator (`<` vs `<=`)
- Swapped function arguments
- Missing null/error check
- Dropped error variant

Would a test catch it? If not, add one.

### Fragility check

Imagine these refactors:

- Extracting a helper function
- Renaming an internal variable
- Splitting one struct into two collaborating structs
- Changing a data structure (HashMap → BTreeMap)
- Reordering independent operations

Would any test break? If so, that test asserts on internals. Rewrite it to assert on output.

---

## Output

Structure the test suite deliverable as:

1. **Discovery summary** — The public interface, boundaries, key behaviors you found
2. **Contract catalog** — Plain-English behavioral contracts per entry point
3. **Test code** — Organized by behavioral area, using the project's existing test framework, conventions, and directory structure
4. **Validation notes** — Any remaining gaps, risks, or areas where coverage could be stronger

Match the style, naming conventions, and file structure of existing tests in the codebase. Do not introduce new test frameworks or dependencies unless the existing ones are clearly insufficient.
