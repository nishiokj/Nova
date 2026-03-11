# Test Skeptic Boundary-Driven Spec

## Goal

Add a separate skeptic path that does not try to score "test quality" globally.
Instead, it should:

1. pick a concrete production boundary
2. collect structured facts about that boundary and the tests that claim to cover it
3. infer the important behavioral invariants
4. choose one high-value mutation proposal that those tests are likely to miss
5. hand that proposal to a validator/executor that runs it against the narrowest relevant test target in a temp workspace

The skeptic succeeds by finding one plausible surviving mutant on a high-value boundary, or by proving a chosen boundary is defended and moving on quickly.

The skeptic is in direct competition with the writer of the tests.
It should behave like a scored attacker:

- validated surviving mutations and validated findings are wins
- invalid, equivalent, non-behavioral, intended-behavior-preserving, or mis-targeted mutation proposals are losses
- one excellent proposal is better than a pile of speculative noise

## Non-Goals

- No single scalar "good test" score for the whole suite
- No large catalog of brittle smell heuristics pretending to be truth
- No mutation of arbitrary code via freeform model edits in the main worktree
- No merging skeptic logic into the writer skill

## Design Split

Keep the split clean:

- `test-health` remains the structural index and boundary-discovery layer
- `test-red-team` remains a separate agent/skill that consumes that structure and attacks tests

The current `entity-graph` / `test-health` code already exposes most of the needed structural primitives:

- boundaries: `packages/plugins/entity-graph/src/queries.ts`
- call tree: `packages/plugins/entity-graph/src/queries.ts`
- deps/env readiness: `packages/plugins/entity-graph/src/test-health.ts`
- parser stack: `packages/plugins/entity-graph/src/parser/parser.ts`

The missing piece is a boundary dossier and mutation loop built on top of those primitives.

## Proposal / Validator Split

Keep responsibility split explicit:

- The skeptic agent proposes mutations. It does not get to stop at vague prose, and it does not mutate the live workspace.
- The validator/executor agent consumes a `MutationProposal`, checks that it is a real behavioral change, applies it in a temp worktree or temp copy, runs the narrowest relevant tests, and returns `survived`, `killed`, or `invalid`.
- The on-disk handoff is `.tmp/test-red-team/proposals/<id>/proposal.json`, with validator output at `.tmp/test-red-team/proposals/<id>/validation.json`.

This avoids two bad outcomes:

- "dirty workspace" becoming an excuse to avoid proposing anything actionable
- hand-wavy mutation ideas that no other agent can execute or verify

It also makes scoring clean:

- the skeptic is judged on proposal quality
- the validator is the truth source for whether a proposal was a real mutation and whether the tests killed it
- rejected proposals are negative signal for the skeptic, not neutral noise
- proposals that merely preserve intended behavior or amount to safe refactors are rejected as not-real mutations

## Patch Set

### 1. Extend project config for skeptic execution

Add a project-level config file:

- `test-health.yaml`

Extend the existing schema with a new optional section:

```yaml
version: 1
substitutions: {}
env_defaults: {}
test_patterns:
  - "**/*.test.ts"

skeptic:
  runner:
    command: ["bunx", "vitest", "run"]
    test_name_flag: "-t"
    timeout_sec: 60
    env: {}
  mutation:
    worktree_dir: ".tmp/test-red-team"
    proposal_dir: ".tmp/test-red-team/proposals"
    max_mutants_per_boundary: 2
    max_boundaries_per_run: 5
  selection:
    prefer_recent: true
    min_fan_in: 1
```

Why:

- the skeptic needs deterministic runner and environment setup
- this belongs with test-health because it is repo-specific, not skill-specific
- the skill should not guess how to run tests
- proposal persistence must be stable and machine-readable so a separate validator can consume it

### 2. Add skeptic analysis types

Add:

- `packages/plugins/entity-graph/src/skeptic/types.ts`

Core types:

```ts
export interface BoundaryCandidate {
  boundaryId: string
  file: string
  name: string
  kind: 'function' | 'method' | 'class'
  fanIn: number
  readiness: 'ready' | 'blocked' | 'unknown'
  recent: boolean
  riskScore: number
}

export interface TestCaseFact {
  file: string
  name: string
  lineStart: number
  lineEnd: number
  importedProdSymbols: string[]
  calledProdSymbols: string[]
  helperCalls: string[]
  assertionKinds: Array<
    | 'return-value'
    | 'error'
    | 'state'
    | 'side-effect'
    | 'ordering'
    | 'cleanup'
    | 'mock-interaction'
    | 'existence'
  >
  mockSites: MockSite[]
  seamOverrides: SeamOverride[]
  envOverrides: string[]
  touchesBoundaryDirectly: boolean
  touchesBoundaryModule: boolean
  confidence: 'high' | 'medium' | 'low'
}

export interface BoundaryDossier {
  boundary: BoundaryCandidate
  callTree: {
    totalNodes: number
    nodes: Array<{
      entityId: string
      file: string
      name: string
      depth: number
      injected: boolean
    }>
  }
  deps: Array<{ name: string; type: string | null; status: 'wirable' | 'blocked' | 'unknown' }>
  envVars: Array<{ name: string; status: 'covered' | 'defaulted' | 'unmapped' }>
  testFiles: string[]
  testCases: TestCaseFact[]
  assertionGaps: string[]
  seamCoverage: {
    reachableSeams: number
    overriddenSeams: number
    semanticAssertions: number
    mockInteractionAssertions: number
  }
}

export interface MutationProposal {
  id: string
  family:
    | 'wrong-value'
    | 'wrong-branch'
    | 'missing-side-effect'
    | 'wrong-order'
    | 'swallowed-error'
    | 'boundary-env'
    | 'cleanup-omission'
  targetEntityId: string
  targetFile: string
  targetSymbol: string
  whyThisBoundary: string
  minimalPatch: string
  testTarget: string
  validatorNotes: string
  predictedOutcome: 'survived' | 'killed' | 'invalid'
  rationale: string
  predictedSurvival: number
}
```

Proposal persistence layout:

```text
.tmp/test-red-team/proposals/
  <proposal-id>/
    proposal.json
    validation.json
```

`proposal.json` is written by the skeptic.
`validation.json` is written later by the validator/executor after temp-workspace evaluation.

### 3. Add AST-based test fact extraction

Add:

- persisted `test_case_*` tables in the entity graph schema
- `packages/plugins/entity-graph/src/parser/test-facts.ts`

Responsibility:

- parse test files with the same tree-sitter pipeline used for the entity graph
- extract `describe` / `it` / `test` blocks
- map imports
- identify direct calls to imported production symbols
- identify assertions and classify their anchors
- identify mocks, spies, fake timers, env/global overrides
- persist those facts into Postgres during the normal parse/persist lifecycle

Do not try to infer runtime execution coverage here. This is static structure only.

Required output per test block:

- test name and line range
- production imports used
- boundary touched directly or only via helper
- assertion kind counts
- mock/stub/spy callsites
- global/env/time override callsites

AST queries worth adding:

- `describe(...)`, `it(...)`, `test(...)`
- `expect(...)`
- `vi.mock`, `vi.spyOn`, `jest.mock`, `jest.spyOn`
- `mockResolvedValue`, `mockRejectedValue`
- `process.env`, `Bun.env`
- `beforeEach` / `afterEach`

### 4. Add boundary dossier builder

Add:

- `packages/plugins/entity-graph/src/skeptic/boundary_dossier.ts`

Responsibility:

1. resolve a boundary candidate
2. fetch call tree, deps, env vars, test files, and persisted test-case facts from existing `test-health` / entity-graph queries
3. materialize `TestCaseFact[]` from the persisted graph
4. identify assertion gaps at the boundary level

Boundary-level gaps should be concrete, for example:

- return/error behavior asserted, but no side-effect assertions for divergent leaves
- boundary reads env vars but no test overrides env input
- boundary has injected deps and all observable behavior is asserted through mocks only
- only helper tests touch the module, no test directly exercises exported boundary
- ordering-sensitive subtree but no ordering/cleanup assertions

Important:

This module should rank gaps, not decide quality in the abstract.

### 5. Add target selection

Add:

- `packages/plugins/entity-graph/src/skeptic/selection.ts`

Responsibility:

- turn `recent` or explicit user target into ranked boundary candidates

Selection order:

1. boundaries touched by recent source/test changes
2. ready boundaries with tests but obvious assertion/seam gaps
3. ready high-fan-in boundaries with no direct boundary tests

Candidate scoring should prefer:

- recent boundaries
- ready boundaries
- higher fan-in
- call trees with divergent leaves
- boundaries with env reads or injectable deps
- boundaries whose tests are helper-only or mock-heavy

Candidate scoring should not be presented as "quality." It is only triage.

### 6. Add mutation family chooser

Add:

- `packages/plugins/entity-graph/src/skeptic/mutation_catalog.ts`

This should not be freeform. Start with a small deterministic catalog.

Choose mutation family from boundary facts:

| Boundary/Test Signal | Mutation Family |
|---|---|
| Return semantics lightly asserted | `wrong-value` |
| Multiple branches, weak partition coverage | `wrong-branch` |
| Divergent leaf with no direct assertion | `missing-side-effect` |
| Cleanup/order-sensitive subtree | `wrong-order`, `cleanup-omission` |
| Error path present, error semantics weak | `swallowed-error` |
| Env-sensitive boundary, env not varied | `boundary-env` |

Selection algorithm:

1. enumerate valid mutation families for the chosen boundary
2. remove families already attempted for that boundary
3. score by predicted survival based on dossier gaps
4. return the top candidate only

One skeptic invocation should be responsible for one excellent mutation, not a laundry list.

### 7. Add mutation validator/executor

Add:

- `packages/plugins/entity-graph/src/skeptic/mutation_runner.ts`

Responsibility:

- accept one `MutationProposal`
- create a temp worktree or temp copy
- apply one narrow mutation
- verify it is a real behavioral mutation rather than a no-op
- run only the relevant tests
- classify result:
  - `survived`
  - `killed`
  - `invalid` (syntax/runtime setup failure)

Start simple:

- text/AST-localized mutations only
- one file at a time
- one mutant at a time
- reject invalid mutants from scoring

Do not mutate the live workspace.

### 8. Extend CLI/API instead of building a parallel script stack

Extend:

- `packages/plugins/entity-graph/src/cli.ts`
- `packages/plugins/entity-graph/src/index.ts`

New commands:

- `test-health skeptic-targets [recent|<file>|<module>] [--json]`
- `test-health skeptic-dossier <boundary-id> [--json]`
- `test-health skeptic-mutate <boundary-id> [--family <name>] [--json]`

Expected JSON contracts:

- `skeptic-targets`: ranked `BoundaryCandidate[]`
- `skeptic-dossier`: `BoundaryDossier`
- `skeptic-mutate`: `{ boundaryId, mutation, result, testsRun, stdoutSummary }`

The existing `.agents/test-red-team/scripts/skeptic_tools.py` should become a thin wrapper over these commands or be retired.

## Mutation Selection Rules

The skeptic should not invent mutation families from scratch. It should derive them from a boundary dossier.

Decision rules:

1. If the boundary has divergent leaves in the call tree and tests only assert returns, prefer `missing-side-effect`.
2. If tests assert mock calls more than state/output, prefer `wrong-value` or `swallowed-error` at the boundary.
3. If the boundary has env reads and tests do not vary env input, prefer `boundary-env`.
4. If the boundary has cleanup/order behavior in setup/teardown/resource handling, prefer `wrong-order` or `cleanup-omission`.
5. If tests only touch helpers in the module and never call the exported boundary, prefer a boundary-level mutant rather than a helper mutant.
6. If the boundary is already strongly asserted across value, error, side-effect, and cleanup dimensions, mark it defended after the configured number of killed mutants and move on.

## What If The Skeptic Picks A Strong Boundary?

Do not let it stall there.

Policy:

- maximum `2` valid mutation attempts per boundary at first
- if both high-value mutants are killed, mark boundary `defended`
- move to the next ranked boundary

This is why ranking matters. The skeptic should prefer:

- recent + weak-looking boundaries first
- high-fan-in + weakly asserted boundaries second
- only then already-strong boundaries

The agent should not be graded on "did you stay with the first boundary." It should be graded on "did you find one real hole quickly."

## Why Not Use "Functions Called Per Test" As The Main Proxy?

Do not use it as a primary quality proxy.

Reasons:

- static AST sees syntactic calls, not what executed
- one excellent boundary test may call exactly one function
- one terrible integrationish test may call ten functions and assert nothing real

It is fine as one low-weight fact in the dossier:

- direct boundary calls
- helper indirection count
- production symbols touched

It is not a success metric.

## Better Per-Test Proxies

These are worth extracting:

- direct boundary call vs helper-only reach
- semantic assertions vs mock-interaction assertions
- reachable seams vs overridden seams
- env/global/time manipulation count
- whether cleanup/order is asserted
- whether error semantics are asserted
- whether the test only proves "something exists" or "something did not throw"

Again: these are search aids, not truth.

## Implementation Order

### Phase 1

- extend `test-health.yaml` schema
- add `skeptic/types.ts`
- add `skeptic/selection.ts`
- add `skeptic-targets` CLI

Outcome:

- skeptic can quickly find the most attackable boundaries

### Phase 2

- extend the canonical parser/persistence path with persisted test-case facts
- add `skeptic/boundary_dossier.ts`
- add `skeptic-dossier` CLI

Outcome:

- skeptic gets a structured per-boundary, per-test dossier instead of raw test files

### Phase 3

- add `skeptic/mutation_catalog.ts`
- add `skeptic/mutation_runner.ts`
- add `skeptic-mutate` CLI

Outcome:

- skeptic can attempt one narrow mutation and classify it

### Phase 4

- simplify `.agents/test-red-team/SKILL.md`
- make it consume the dossier and mutation commands rather than inventing its own heuristics

Outcome:

- separate agent stays skeptical, but no longer has to do structural analysis from scratch

## Tricky Parts

These are real complications, not blockers:

1. Mapping test blocks to a boundary can be ambiguous.
Use confidence levels and fall back to file-level association.

2. Static analysis cannot prove runtime reach.
That is acceptable because the mutation runner is the truth source.

3. Mutation generation can become flaky if it is too open-ended.
Start with a tiny deterministic catalog.

4. Targeted test execution needs repo-specific config.
That is why runner config must be explicit.

5. Some boundaries will already be good.
Cap attempts and move on.

## Success Criteria

The system is working when:

1. `skeptic-targets recent` returns a short ranked list of real boundaries, not files.
2. `skeptic-dossier <boundary>` shows concrete assertion/seam gaps, not generic smell counts.
3. `skeptic-mutate <boundary>` can run one plausible mutation in isolation.
4. The skeptic can find one surviving plausible mutant in weak recent additions faster than a human could by manual reading.
5. When no mutant survives, the skeptic can say "this boundary looks defended" and advance without thrashing.
