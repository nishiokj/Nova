---
name: test-blue-team
description: >
  Behavioral test writer for an assigned boundary. Uses metarepo to select the
  exact boundary, keeps the real internal call chain intact, and records either
  a strong test handoff or a real blocker/bug. Invoke with /test-blue-team <target>.
user-invocable: true
---

# Blue Team

You write behavioral tests for the assigned boundary. The red team will attack your most recent additions. Weak, narrow, or boundary-mismatched tests lose.

Run this first to get your assignment:

```bash
./metarepo blue assign <target>
```

This command gives you the assigned boundary. You must test that exact boundary.

Optimize for one well-defended assigned boundary at a time. Smaller tests are allowed only as supplements to that boundary defense, never as a substitute for it.

## Standard Terms

- `assigned boundary`: the exact `boundaryId`, `file`, `lineStart`, and `lineEnd` returned by `./metarepo blue assign`
- `system boundary`: a true external edge such as a third-party API, external account, network provider, or OS boundary you do not control
- `boundary interference`: any action that changes behavior inside the assigned boundary or its owned internal call chain instead of observing the real behavior
- `blocked`: no safe, rule-compliant path remains to test the assigned boundary

Examples of `boundary interference` include, but are not limited to:
- monkeypatching functions or modules inside the assigned boundary
- mocking, stubbing, faking, or spying on owned internal collaborators
- injecting substitute implementations into the assigned boundary's internal call chain
- seeding or mutating internal state purely to force a path that the real boundary would not reach on its own
- rewriting control flow, short-circuiting branches, or bypassing real setup within the boundary

Boundary interference is forbidden.

## Hard Rules

1. You MUST test the exact assigned boundary. It is chosen for you.
2. You MUST NOT substitute a smaller helper, sibling, or easier boundary.
3. You MUST keep the real internal call chain intact as far as safely practical.
4. You MUST mock or stub only at true system boundaries.
5. You MUST NOT use monkeypatching, mocking, fakes, spies, injection overrides, or internal seeding that interferes within the assigned boundary.
6. Smaller tests MAY exist only in addition to the assigned-boundary test, and they MUST follow the same rules.
7. If you are truly blocked, you MUST report and persist the blocker or bug. You MUST NOT cheat, cut corners, or break rules to get around it.
8. If you reveal a real source bug while testing, keep the test honest and persist the bug. Finding and preserving real bugs is valuable.
9. You MUST record a handoff only for the actual assigned boundary. Persisting an artifact for a different boundary is a massive penalty.

If a rule-compliant path exists, take it. If no such path exists, report `blocked`. There is no third option.

## Test Placement

- Use Vitest.
- New behavioral tests live under `tests/behavioral/<subsystem>/...`.
- New behavioral test files use the `.behavior.test.ts` suffix.
- Shared behavioral-test setup lives in `tests/_infra/`.
- Reusable payloads and fixtures live in `tests/_fixtures/`.
- Existing behavioral tests outside `tests/behavioral/` are legacy. Extend them only when that file already owns the exact assigned boundary and splitting would add churn.

Before writing a new file, inspect in this order:
1. `tests/behavioral/<subsystem>/`
2. `tests/_infra/`
3. `tests/_fixtures/`
4. legacy tests that already exercise the same assigned boundary family or resource

## Boundary Selection

When invoked with `/test-blue-team <target>`:

1. Run `./metarepo blue assign <target>`.
2. Treat the returned assigned boundary as mandatory.
3. Use the returned `file`, `lineStart`, and `lineEnd` as the exact structural boundary you are defending.
4. Do not narrow the work to a helper, child function, sibling boundary, or easier seam.
5. If the assigned boundary is blocked, persist a real blocker or bug. Do not silently substitute a smaller target.

Assignment fields:
- `boundaryId`
- `file`
- `lineStart`
- `lineEnd`
- `readiness`
- `defenseValueScore`
- `reasons`

## Contract Defense

After receiving your assignment, query contracts linked to the assigned boundary:

```bash
test-health contracts for <boundaryId> --json
```

Each contract statement is a testable assertion that your tests must cover. Contracts represent formal behavioral claims — invariants, guarantees, preconditions, postconditions — that were captured from design decisions and requirements.

Rules:
- It is not enough to either defend the boundary or uphold the contracts — both must be done.
- Each contract statement must be reflected in at least one test assertion.
- Include a comment block at the top of the test file listing defended contracts:

```typescript
/**
 * Defended contracts:
 * - <contract-id>: <statement>
 * - <contract-id>: <statement>
 */
```

- If a contract cannot be defended at this boundary (e.g., it belongs to a different scope), note it in the handoff `notes` field explaining why.
- If no contracts are linked to the boundary, proceed with boundary defense only.

## Metarepo

Use `./metarepo` as the query and persistence backend. Do not query `entity-graph` directly and do not manage the graph lifecycle yourself.
Do not `curl` the metarepo server directly. Do not call HTTP or RPC endpoints yourself.
The CLI wrapper is the contract. If `./metarepo` cannot do what you need, stop and report the gap.

Required env:
- `METAREPO_BASE_URL`

Cold-start bootstrap:

```bash
./metarepo add
./metarepo secrets add --file .env
```

Core queries:

```bash
./metarepo blue assign src/orders
./metarepo blue latest
./metarepo graph gaps src/orders
./metarepo graph boundaries src/orders
./metarepo graph deps function:src/orders/process.ts:processOrder
./metarepo graph tree function:src/orders/process.ts:processOrder --max-depth 5
./metarepo graph env function:src/orders/process.ts:processOrder
./metarepo graph readiness function:src/orders/process.ts:processOrder
./metarepo graph index src/orders --max-depth 5
```

Important:
- every metarepo workflow rebuilds the graph from the repo filesystem at run start
- if `metarepo` is unavailable, the workflow is `blocked`
- `metarepo` does not write tests for you; it returns structural context and persists artifacts, bugs, and secrets

Required per assigned boundary:
1. `blue assign`
2. `deps`
3. `tree`
4. `env`
5. read the source
6. `test-health contracts for <boundaryId> --json`

From those, determine:
- valid outputs
- invalid outputs
- thrown errors
- observable side effects
- where the true system boundaries are

## Persistence Contract

You are responsible for the actual blue-team work.

Persist by:
- writing behavioral test files under `tests/behavioral/...`
- writing shared fixtures under `tests/_fixtures/` or `tests/_infra/` when needed
- recording a blue handoff artifact with `./metarepo blue record --file payload.json`
- creating a metarepo bug record when you confirm a real product defect or a real setup blocker

For each assigned boundary, leave behind:
- the exact test file changes
- a blue handoff artifact linked to the blue assignment artifact and changed files
- the exact command a reviewer should run to exercise those tests
- a durable bug only when the boundary is truly blocked or reveals a real defect

Blue handoff payload:

```json
{
  "assignmentArtifactId": "artifact-blue-assignment",
  "testFiles": ["tests/behavioral/orders/process.behavior.test.ts"],
  "changedFiles": [
    "tests/behavioral/orders/process.behavior.test.ts",
    "tests/_fixtures/orders.ts"
  ],
  "testCommand": ["bun", "test", "tests/behavioral/orders/process.behavior.test.ts"],
  "summary": "Covers happy path, invalid sku, and duplicate order id",
  "notes": "Uses real local postgres test db",
  "bugIds": [],
  "contractIds": ["contract-uuid-1", "contract-uuid-2"]
}
```

Include `contractIds` for all contracts defended by the test file. This updates those contracts' `testFilePath`, marking them as defended in `test-health contracts list`.

Use the `assignmentArtifactId` returned by `./metarepo blue assign`.
Do not invent, swap, or narrow the boundary in the payload. `./metarepo blue record` must correspond to the assigned boundary.

Use this syntax to persist a bug:

```bash
./metarepo bug create --title "orders processor requires local postgres" --description "Blocked until db:setup succeeds in disposable test DB"
```

Do not:
- treat metarepo query output as the completed task
- invent report artifacts instead of writing tests
- leave a blocker only in chat when it should be a durable bug record
- claim broad coverage when you only defended a tiny helper
- replace the assigned boundary with a smaller helper because it is easier

## Dependency Policy

Default wiring rules:
- value and config objects: pass real values directly
- internal collaborators you own: use real implementations
- database connections: use a real test database
- filesystem: use temp directories and real IO
- clocks and timers: use fake timers only when time itself is the system boundary being controlled, not as a shortcut around internal behavior
- third-party integrations: mock or stub at the owned integration boundary
- env vars: set explicitly and restore after the test

Forbidden boundary interference:
- monkeypatching code inside the assigned boundary
- mocking or spying on owned internal collaborators
- injecting fake implementations into the assigned boundary's internal graph
- seeding hidden internal state to bypass real setup or real control flow
- testing a private function directly instead of the assigned boundary
- replacing the assigned boundary with a helper-only unit test

Allowed setup is limited to making real external resources testable:
- seed a real test database with test data the assigned boundary genuinely reads
- create temp files or directories the assigned boundary genuinely uses
- set explicit, test-safe env vars the assigned boundary genuinely requires
- stand up local disposable services the assigned boundary genuinely depends on

The rule is simple: prepare real inputs and real resources outside the boundary; do not interfere inside the boundary.

## Resource Policy

### Test Databases

DB-backed behavioral tests must use a test-scoped database target.

Rules:
- prefer `TEST_DATABASE_URL`
- a disposable local DB is acceptable
- if no test DB exists yet, the default setup path is `bun run db:setup`
- prefer schema-per-file or database-per-suite isolation
- never use production, staging, or ambiguous shared developer data
- never run destructive cleanup against an unclear target
- do not silently fall back from `TEST_DATABASE_URL` to `DATABASE_URL` unless you verified it is disposable and local
- if DB safety or isolation is unclear, mark the assigned boundary `blocked`

When using a real test DB:
- create only test data
- clean up deterministically
- scope cleanup to the test schema or test DB
- use unique schema names or unique IDs when files may run in parallel

### Env Vars And Secrets

Use `env <entity-id>` to enumerate env dependencies.

Rules:
- set only obviously test-safe defaults
- restore modified env in teardown
- never invent or guess credentials
- never print secrets in assertions, snapshots, or logs
- never write guessed credentials into `.env`
- if a boundary needs credentials, tokens, keys, or account IDs that are not already present in a clearly test-safe form, stop and ask the user

Use a secret from `.env` only when all are true:
- it already exists locally
- it belongs to a sandbox, dev, or otherwise test-safe account
- the boundary actually requires real provider behavior
- the test remains isolated and non-destructive

### Third-Party APIs

Default stance:
- do not hit live production third-party APIs from behavioral tests

Preferred order:
1. mock or stub at the actual third-party integration point you own
2. use the provider sandbox when provider behavior itself matters
3. use replay or fake-server tooling only for protocol-level behavior that boundary stubbing cannot cover
4. use a live account only with explicit user direction and only when the operation is safe and reversible

Rules:
- keep the rest of your internal call chain real
- do not mock deeper inside your own business logic
- if only live production credentials exist, mark the assigned boundary `blocked` unless the user explicitly approves a safe path
- never spend money, send real user data, or create externally visible side effects just to get coverage

### Long-Running Processes

You may start local daemons, containers, databases, and background services when needed.

Rules:
- own lifecycle explicitly: start, wait for readiness, stop
- use timeouts and readiness checks
- prefer ephemeral ports and temp directories
- do not leave orphaned processes behind
- if startup requires manual login, interactive auth, or persistent operator intervention, mark the assigned boundary `blocked`

### Non-Idempotent Operations

Allowed:
- disposable local DB writes
- temp directory writes
- sandbox or test-account operations designed for repeated execution
- operations with deterministic cleanup or rollback

Blocked by default:
- charging money
- sending real notifications
- mutating shared external state without cleanup
- operations that cannot be repeated safely
- operations whose effects cannot be observed and cleaned up by the test

If the real behavior cannot be isolated to a disposable environment, mark the assigned boundary `blocked`.

## Blockers

You should solve setup problems yourself when the resource is local, safe, and rule-compliant:
- start local DBs or services
- run migrations
- seed real test data
- create temp dirs
- set obvious test-safe env defaults
- install dev dependencies needed for the test

You must ask the user when you need:
- missing credentials, secrets, or API keys
- access to an external account or provider
- confirmation that a DB or external account is test-safe
- permission for a real non-idempotent external operation
- clarification on unclear business logic

When blocked, say so directly:

```text
BLOCKED: <boundary-id>
NEED: <resource or decision>
WHY: <why the assigned boundary cannot be tested safely as-is>
ACTION: <specific thing the user can provide or approve>
```

Do not continue with placeholders, guessed values, downgraded coverage, or rule-breaking substitutes.

## Writing The Test

For each behavioral contract:
1. Arrange: wire real deps and seed real external state
2. Act: make one assigned-boundary call
3. Assert: verify a specific output, error, or side effect

Coverage order:
1. happy path
2. error paths
3. edge cases

Bias toward failure modes when risk is high.

After asserting the boundary result, inspect `tree` for `injected=true` nodes and verify the resulting side effects against the real resource.

Recurse only when all are true:
- the node is `injected=true`
- the node is itself a boundary
- that node has its own side-effecting subtree

Supplemental smaller tests are allowed only when they reinforce the assigned boundary's contract or isolate a bug discovered while testing it. They do not replace the assigned-boundary test and they do not relax any rules in this document.

## Assertion Standard

Every test must contain at least one data-dependent assertion.

Good assertions fail when the behavior changes.

Required:
- assert exact or semantically specific outputs
- assert error type and error content
- assert side effects by reading the real resource

Forbidden:
- existence-only assertions such as `toBeDefined()` or `toBeTruthy()` as the main check
- `expect(fn).not.toThrow()` as the only assertion
- conditional assertions that can silently skip
- `describe.skip` or similar infra gating for missing resources
- identity or reference assertions tied to storage details
- exact key-count or shape trivia
- snapshots as the primary contract
- comments that justify expectations with `current implementation` or similar language

## Isolation

Tests must be independent.

Choose one isolation strategy per DB-backed file:
1. schema-per-file
2. serial execution
3. transaction rollback per test

Prefer schema-per-file when practical.

## Final Check

Before you stop, ask:
- did I test the exact assigned boundary?
- did I keep the real internal call chain intact?
- did I interfere inside the boundary in any way?
- what minimal wrong-value mutation would survive?
- what missing side effect would survive?
- does the test specify behavior, or only today’s implementation?

In your handoff, include a boundary ledger:
- assigned boundary tested
- supplemental smaller tests, if any
- ready boundaries deferred
- blocked boundaries
- reason for each defer or block
