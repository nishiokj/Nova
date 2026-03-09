# Test Health System — Specification

## Goal

**Mechanically prove that a test suite fully specifies a module's observable behavior, such that a competent developer could reimplement the module from the tests alone — and prove it with an adversarial system where neither side can game the measurement.**

This is not a coverage tool. Coverage counts lines executed. We count **behaviors verified**. A line can execute a million times without a single assertion checking its output. That line is untested. We will find it.

---

## Thesis: Reward-Hacking as Mechanism

Most AI safety work tries to prevent reward-hacking — to stop agents from finding clever shortcuts that satisfy the metric while violating the intent. We take the opposite approach: **we design a system where reward-hacking IS the mechanism, and the gaming behaviors of two adversaries produce the outcome we want.**

The insight: a single agent optimizing a single metric will always find ways to game it. But two agents optimizing **opposed** metrics cannot both game simultaneously — one's gaming is the other's signal.

| Agent | Reward Function | How It's Tempted to Game | What That Gaming Actually Produces |
|---|---|---|---|
| **Blue team** | Maximize boundaries where zero mutations survive | Write over-specific tests that kill mutations but are brittle | Tests that DO catch behavioral changes (even if brittle — the red team's next round will expose the brittleness by attacking from a different angle) |
| **Red team** | Maximize mutations that survive | Find the most subtle, hard-to-test behavioral gaps | Precisely the information needed to identify where tests are insufficient |

**Neither team can win by being lazy.** The blue team can't write tautological tests because they kill zero mutations. The red team can't submit trivial mutations because they get killed immediately. Both are pushed toward their hardest, most useful work by the other's pressure.

**Neither team can win by cheating.** The referee is a deterministic script that neither team controls. The rules of engagement are mechanically verified on the artifacts. There is no soft judgment to manipulate — only patches, test results, and arithmetic.

**The equilibrium IS the goal.** When both teams are operating at full strength and neither can gain ground, the test suite has converged on full behavioral specification. This isn't a hoped-for outcome — it's the mathematical consequence of two opposed optimizers reaching Nash equilibrium under a fair referee.

This is the thesis: **we don't prevent reward-hacking, we harness it. Two adversaries pulling in opposite directions, constrained by mechanical rules, will converge on honest measurement faster than any single cooperative agent ever could.**

---

## The Problem

Every existing proxy for test quality is gameable:

| Proxy | How It's Gamed |
|---|---|
| Line coverage | Execute code without asserting on its output |
| Branch coverage | Enter both branches but never check the result |
| Mutation score (naive) | Generate trivially-killed mutations, inflate the kill rate |
| Assertion count | Assert on implementation details, break on every refactor |
| Test count | Write 500 tests that all verify the happy path |

The fundamental issue: **the entity writing the tests is also the entity evaluating the tests.** Self-assessment is inherently unreliable. A test author who believes their tests are good has no mechanism to discover they're wrong.

We solve this with **adversarial separation**: one agent writes tests, a different agent tries to break them, and a deterministic script scores both. Nobody grades their own homework.

---

## The Core Claim

> If no adversarial mutation survives the test suite for a given behavioral boundary, then the test suite fully specifies that boundary's observable behavior.

This claim rests on three pillars:

1. **The mutations are valid** — they change real, observable behavior in code that actually executes during tests.
2. **The mutations are diverse** — they attack across all fault dimensions, not just arithmetic flips.
3. **The evaluation is honest** — a deterministic script applies patches and runs tests. No LLM judges whether a test "should have" caught something.

If any pillar fails, the claim fails. The rest of this spec exists to make each pillar unfailable.

---

## Guarantees

These are the properties the system MUST maintain. Each guarantee names the mechanism that enforces it and the failure mode that would break it.

### G1: Behavioral boundaries are mechanically identified

**What:** Every public function and its exit points are extracted from the AST by a deterministic parser. No LLM decides what constitutes a "boundary."

**Mechanism:** `referee.py --index` runs a language-specific AST parser that extracts:
- Every `pub fn` / `pub async fn` / exported function
- Every exit point within that function: `return`, `?` (error propagation), `panic!`, `process::exit`, explicit side effects (writes through `&mut`, I/O calls)
- The line range of the function body

**Output:** `project-index.json` → `boundaries[]` array. Same source → same boundaries, every time.

**Failure mode:** The AST parser misses a boundary (e.g., trait method generated by a macro, dynamic dispatch through `dyn Trait`). **Mitigation:** The parser declares what it can see. Anything it can't see is listed under `unresolved` in the index. Both teams are told: "these exist but are not mechanically tracked."

**Certainty: 100% for what the parser can see.** The parser is deterministic. It cannot be persuaded, confused, or gamed. It either extracts a function or it doesn't. The gap is in parser completeness, not parser correctness.

---

### G2: Mutations only target code that executes during tests

**What:** A mutation on a line that no test ever reaches is meaningless — it "survives" not because the tests are weak, but because nothing runs that code path at all. We exclude these.

**Mechanism:** `referee.py --index` runs the test suite with coverage instrumentation (e.g., `cargo llvm-cov`, `tarpaulin`, language-appropriate tool). The coverage map records which source lines executed during the test run.

**Output:** `project-index.json` → `coverage` map. Per-file, per-line: executed or not.

**Enforcement:** When the referee evaluates a red team mutation, it cross-references the mutated lines against the coverage map. If the mutation touches ONLY uncovered lines, it is classified as `invalid_target` — not counted as survived, not counted as killed. It simply doesn't exist in the scoring.

**Failure mode:** Coverage instrumentation is unavailable or broken. **Mitigation:** If coverage cannot be measured, the referee emits a warning and evaluates all mutations — but flags the report as `coverage_unverified`. The system degrades gracefully, never silently.

**Certainty: 100% when coverage data is available.** Line-level coverage is binary and deterministic. The line ran or it didn't.

---

### G3: Neither team evaluates its own work

**What:** The blue team (test writer) does not decide if its tests are good. The red team (mutation generator) does not decide if its mutations survived. A third party — the referee script — makes all verdicts.

**Mechanism:** Structural separation enforced by the system architecture:

```
Blue team → writes test files → committed to repo
Red team  → writes patch files → written to /tmp/test-health-<hash>/semantic/
Referee   → reads both, applies patches in worktrees, runs tests, emits verdicts
```

The blue team never sees red team mutations until after they're scored. The red team never runs the test suite. The referee is a deterministic Python script with no LLM component.

**Failure mode:** An agent modifies the referee script. **Mitigation:** The referee is owned by the user, not by either agent. Both skill files explicitly prohibit modifying evaluation infrastructure (Red team Rule 5). The referee could also be checksummed, but the real defense is: the user runs the referee, not the agents.

**Certainty: 100% given the user runs the referee.** The agents physically cannot score themselves — they don't have the mechanism. The referee is the only thing that applies patches and runs tests.

---

### G4: Red team cannot cheat

**What:** The red team cannot weaken the test suite, inflate its score, or produce misleading results.

**Mechanism:** Eight rules of engagement, each mechanically verifiable:

| Rule | Violation | Detection |
|---|---|---|
| 1. No modifying test files | Deletes/changes a test to make mutation survive | `git diff` of patch shows test file paths → auto-disqualify |
| 2. No modifying other source files | Changes a helper to break test assumptions | Patch touches files outside declared `target_file` → auto-disqualify |
| 3. No deleting/renaming files | Removes test file entirely | Patch contains file deletion → auto-disqualify |
| 4. No running tests | Runs `cargo test` to see if mutation survives | Agent has no test-running tool; even if it did, results are ignored — only referee verdicts count |
| 5. No modifying referee | Alters scoring logic | Referee is outside the health dir; agent skill files prohibit this |
| 6. Single minimal change | Rewrites entire function | Patch line count > threshold → flagged for review; multi-hunk patches → flagged |
| 7. Must change behavior | Cosmetic rename, whitespace change | Referee runs original and mutant against test suite — if both pass identically, equivalent mutant → score -1 |
| 8. Must explain reasoning | No gap description, no behavioral change explanation | `mutation.json` missing required fields → rejected before evaluation |

**Failure mode:** The red team produces a mutation that compiles, changes behavior, but targets code behind a mock — so no test could possibly catch it regardless of test quality. **Mitigation:** G2. Coverage map determines valid targets. Code that doesn't execute during tests is not a valid mutation target. See also G6.

**Certainty: 100% for rules 1-3, 6-8** (mechanical checks on the patch file). **High confidence for rules 4-5** (agent doesn't have the tools, but a sufficiently creative agent could try shell commands — the skill instructions prohibit it, and the referee ignores any self-reported results).

---

### G5: Blue team quality is measured by adversarial survival, not self-assessment

**What:** The blue team's score is determined by what the red team's mutations do to its test suite, not by any property the blue team claims about its own tests.

**Mechanism:** Per-boundary scoring:

| Outcome | Score |
|---|---|
| Boundary has tests and **zero mutations survive** | **+10** (airtight defense) |
| Boundary has tests, base score | **+5** |
| Per survived mutation on that boundary | **-3** |
| Floor | **0** (cannot go negative) |

The blue team's score is entirely determined by red team attacks that the referee evaluates. The blue team has no input into the scoring formula and no way to influence what mutations the red team generates.

**Failure mode:** The red team generates only easy mutations → blue team gets inflated score. **Mitigation:** Red team is scored on survival rate (G4 incentive). Easy mutations get killed and score 0 for the red team. The red team is incentivized to find HARD gaps, which is exactly what makes the blue team's score honest.

**Certainty: 100% given the adversarial incentive holds.** The scoring formula is arithmetic. The inputs (survived/killed counts) come from the referee. Neither team can influence the other's inputs.

---

### G6: Mock boundaries are respected

**What:** If the blue team mocks `DatabaseTrait` in tests, then the red team mutating the real `PostgresDb` implementation is attacking code that no test exercises through the real path. A "survived" mutation behind a mock is not evidence of weak tests — it's evidence of a mock boundary. These must be distinguished.

**Mechanism:** The project index includes a mock registry:

```json
{
  "mocks": [
    {
      "trait_or_interface": "DatabaseTrait",
      "real_impl_file": "src/db.rs",
      "real_impl_lines": [45, 120],
      "mock_impl_file": "tests/mocks.rs",
      "used_in_tests": ["test_process_order", "test_checkout"]
    }
  ]
}
```

When the referee evaluates a mutation, it checks:
1. Are the mutated lines within a `real_impl` range of a mocked trait?
2. If yes, do any tests exercise this code through the **real** implementation (not the mock)?
3. If no tests use the real implementation → mutation is classified as `behind_mock`, not `survived`.

**Practically:** This is enforced by G2 (coverage). If the real `PostgresDb::query()` never executes during tests (because all tests use `MockDb`), then those lines are uncovered → mutations there are `invalid_target`. The mock registry provides the *explanation* for why they're uncovered; the coverage map provides the *enforcement*.

**Failure mode:** Partial mocking — some tests use real impl, some use mock. Mutation targets lines that only execute under the mock path. **Mitigation:** Line-level coverage is path-agnostic. If the line executes at all during any test, it's covered. The mutation is valid. This is correct behavior: if the line runs, the tests should verify its effect.

**Certainty: 100% through coverage enforcement.** The mock registry is informational. Coverage is the enforcement mechanism, and coverage is binary.

---

### G7: Scoring is deterministic and reproducible

**What:** Same source code + same tests + same mutations → same score. Always.

**Mechanism:** The referee is a Python script. No LLM in the evaluation loop. The operations are:
1. `git worktree add` (deterministic)
2. `git apply` (deterministic)
3. `cargo check` (deterministic)
4. `cargo test` (deterministic — tests must not depend on wall clock, network, or randomness)
5. Arithmetic on pass/fail counts (deterministic)

**Failure mode:** Flaky tests. A test that passes/fails non-deterministically corrupts the signal — a mutation might "survive" one run and be "killed" the next. **Mitigation:** The referee could run each mutation N times and require consensus, but this is expensive. The primary mitigation is the blue team skill's instruction: tests must not depend on external state, clock, network, or randomness. If a flaky test is detected (same mutation gets different results), the referee flags it in the report rather than counting it.

**Certainty: 100% given deterministic tests.** The referee's logic is pure. The only source of non-determinism is the test suite itself, which is the blue team's responsibility.

---

### G8: Fault class diversity is enforced

**What:** The system measures test quality across 8 independent fault dimensions, not as a single aggregate score. A test suite that kills 100% of `wrong_value` mutations but 0% of `error_handling` mutations is not "50% good" — it has a categorical blind spot.

**Mechanism:** Every mutation (mechanical and semantic) is classified into exactly one fault class:

| Fault Class | What It Means |
|---|---|
| `wrong_value` | Computation produces incorrect result |
| `wrong_path` | Control flow takes incorrect branch |
| `missing_action` | An operation that should happen is skipped |
| `wrong_binding` | Correct operation applied to wrong data |
| `wrong_sequencing` | Operations happen in wrong order |
| `boundary_error` | Off-by-one, inclusive/exclusive, edge condition |
| `error_handling` | Error swallowed, wrong error, missing propagation |
| `resource_lifecycle` | Leak, missing cleanup, use-after-close |

The report shows kill rates **per fault class**. A fault class with zero mutations is flagged as `NOT TESTED` — a blind spot. A fault class with low kill rate is flagged as `WEAK` or `GAP`.

**Enforcement on red team:** The red team skill explicitly instructs: "Diversify across fault classes. If all your mutations are `wrong_value`, you're being lazy." The red team is scored on survival rate, not volume, so there's no incentive to spam one category.

**Enforcement on blue team:** The blue team skill explicitly instructs: "Weak fault classes (kill rate < 80%): Prioritize writing tests that would catch mutations in these categories." The report drives effort toward categorical gaps.

**Failure mode:** The fault classes aren't truly exhaustive — there's a type of bug that doesn't fit any category. **Mitigation:** `uncategorized` is a valid classification. If `uncategorized` mutations appear frequently, it signals the taxonomy needs extension. The taxonomy is derived from Beizer's fault taxonomy and covers how code can be wrong at the statement level. Higher-order faults (architectural, integration, distributed) are out of scope for this system.

**Certainty: 100% for classification correctness** (deterministic rules on mutation operators). **Best-effort for exhaustiveness** (no finite taxonomy captures all possible bugs, but this one covers the statement-level fault space comprehensively).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        USER                                         │
│  Runs referee. Dispatches teams. Reviews reports. Makes decisions.   │
└──────────┬──────────────────────┬──────────────────────┬────────────┘
           │                      │                      │
           ▼                      ▼                      ▼
┌──────────────────┐  ┌──────────────────┐  ┌────────────────────────┐
│   referee.py     │  │   /dev-test      │  │   /red-team            │
│   (Script)       │  │   (LLM Skill)    │  │   (LLM Skill)         │
│                  │  │                  │  │                        │
│  Deterministic.  │  │  Writes tests.   │  │  Writes mutations.     │
│  No LLM.        │  │  Reads index +   │  │  Reads index +         │
│  Builds index.  │  │  report.         │  │  report.               │
│  Evaluates.     │  │  Targets weak    │  │  Targets gaps.         │
│  Scores.        │  │  boundaries.     │  │  Outputs patches.      │
│  Reports.       │  │                  │  │  Operates blind.       │
└────────┬─────────┘  └────────┬─────────┘  └────────┬───────────────┘
         │                     │                      │
         ▼                     ▼                      ▼
┌────────────────────────────────────────────────────────────────────┐
│                     HEALTH DIRECTORY                                │
│           /tmp/test-health-<repo-hash>/                             │
│                                                                    │
│  project-index.json  ← referee --index                             │
│  report.json         ← referee --evaluate                          │
│  mechanical/         ← cargo-mutants output                        │
│  semantic/           ← red team patches                            │
│    <id>/mutation.json                                              │
│    <id>/mutation.patch                                             │
└────────────────────────────────────────────────────────────────────┘
```

### Separation of Concerns

| Component | Nature | Inputs | Outputs | Can Run Tests? |
|---|---|---|---|---|
| `referee.py` | Deterministic script | Source code, test files, patches | `project-index.json`, `report.json` | **YES** (only component that can) |
| `/dev-test` | LLM skill | Source code, index, report | Test files (committed to repo) | **NO** |
| `/red-team` | LLM skill | Source code, test files, index, report | Patch files (written to health dir) | **NO** |

The critical invariant: **only the referee runs tests.** Both LLM skills operate on static analysis of source and tests. They reason about what the tests check, but they never execute them.

---

## The Project Index

The project index is the mechanical foundation. Both teams read it. Neither team writes to it. The referee builds it.

### Schema: `project-index.json`

```json
{
  "version": 1,
  "repo_root": "/absolute/path/to/repo",
  "commit": "abc123",
  "timestamp": "2026-03-04T12:00:00Z",
  "language": "rust",

  "boundaries": [
    {
      "id": "crate::module::function_name",
      "file": "src/module.rs",
      "line_start": 10,
      "line_end": 55,
      "visibility": "pub",
      "signature": "pub fn function_name(arg: Type) -> Result<Output, Error>",
      "exit_points": [
        { "type": "return",            "line": 25 },
        { "type": "error_propagation", "line": 30, "error_type": "io::Error" },
        { "type": "error_propagation", "line": 42, "error_type": "ParseError" },
        { "type": "panic",             "line": 50, "message": "invariant violated" }
      ],
      "covered_lines": [10, 11, 12, 15, 16, 25, 30],
      "uncovered_lines": [42, 50, 51, 52, 53, 54, 55],
      "coverage_ratio": 0.636,
      "mock_dependencies": ["DatabaseTrait"]
    }
  ],

  "coverage": {
    "summary": {
      "total_lines": 1200,
      "covered_lines": 980,
      "percentage": 81.7
    },
    "files": {
      "src/module.rs": {
        "executed": [1, 2, 3, 10, 11, 12, 15, 16, 25, 30],
        "total": 55,
        "covered": 38,
        "percentage": 69.1
      }
    }
  },

  "mocks": [
    {
      "trait_or_interface": "DatabaseTrait",
      "real_impl_file": "src/db.rs",
      "real_impl_lines": [45, 120],
      "mock_impl_file": "tests/mocks.rs",
      "mock_impl_name": "MockDb",
      "used_in_tests": ["test_process_order", "test_checkout_flow"]
    }
  ],

  "test_infrastructure": {
    "framework": "cargo test",
    "test_files": ["tests/test_orders.rs", "src/module.rs"],
    "fixture_files": [],
    "helper_files": ["tests/common/mod.rs"],
    "total_tests": 42,
    "test_pass": true
  },

  "unresolved": [
    "Macro-generated impl blocks in src/macros.rs (lines 10-50) — cannot extract boundaries",
    "Dynamic dispatch through Box<dyn Handler> in src/router.rs:88 — concrete types unknown"
  ]
}
```

### How The Index Is Built

```
referee.py --index
  │
  ├─ 1. AST Extraction
  │     Parse source files with language-specific tooling.
  │     For Rust: syn / tree-sitter-rust
  │     Extract: pub fn signatures, line ranges, exit points.
  │     Output: boundaries[] (before coverage data)
  │
  ├─ 2. Coverage Measurement
  │     Run test suite with coverage instrumentation.
  │     For Rust: cargo llvm-cov --json / cargo tarpaulin --out json
  │     Map executed lines per file.
  │     Merge into boundaries[].covered_lines / uncovered_lines.
  │
  ├─ 3. Mock Detection
  │     Heuristic scan for mock patterns:
  │       - #[automock], mock!, MockAll (mockall crate)
  │       - #[double] (mockall_double)
  │       - struct Mock* implementing trait *
  │     Cross-reference: which traits are mocked, where are real impls,
  │     which tests use mocks.
  │
  └─ 4. Test Infrastructure Scan
        Identify test framework, locate test files, count tests,
        verify tests pass before proceeding.
        If tests fail on clean HEAD → abort. Cannot evaluate health
        of a broken test suite.
```

### Index Properties

- **Deterministic:** Same source at same commit → same index. Always.
- **Idempotent:** Running `--index` twice produces identical output.
- **Read-only for teams:** Both skills read the index. Neither can write to it.
- **Commit-pinned:** The index records the commit hash it was built from. If HEAD moves, the index is stale and must be rebuilt.

---

## Behavioral Boundaries

A behavioral boundary is the atom of measurement. Everything — scoring, coverage, gap analysis — is scoped to boundaries.

### Definition

```
boundary = (public function) × (exit points)
```

A public function with 3 exit points (happy return, error propagation, panic) represents 3 behavioral paths that tests should verify.

### Why AST Extraction, Not LLM Judgment

An LLM could identify "behavioral boundaries" by reading the code and reasoning about it. We explicitly reject this approach:

1. **Non-deterministic.** Ask twice, get different boundaries.
2. **Gameable.** A blue team LLM could define boundaries that make its tests look comprehensive. A red team LLM could define boundaries that make gaps look smaller.
3. **Unauditable.** "The LLM said there are 12 boundaries" — how do you verify this?

AST extraction is none of these things. The parser extracts what's there. You can read the source and count the `pub fn` declarations yourself. The boundary list is verifiable by inspection.

### What AST Extraction Misses

Honesty requires acknowledging limitations:

| Missed Pattern | Why | Impact |
|---|---|---|
| Trait methods via `impl Trait for Type` | Parser may not resolve which types implement which traits | Some public APIs invisible to index |
| Macro-generated functions | `#[derive(...)]`, `macro_rules!` generating `pub fn` | Boundaries exist but aren't in the AST |
| Dynamic dispatch (`dyn Trait`) | Concrete types determined at runtime | Exit points depend on which impl is called |
| Closure callbacks | `fn register(callback: impl Fn(...))` | The callback's behavior is user-defined |
| FFI boundaries | `extern "C" fn` | Different calling convention, different concerns |

These are listed in `project-index.json` → `unresolved[]`. Both teams are told they exist. The system does not pretend they don't.

---

## Scoring Model

### Blue Team — Per Boundary

| Condition | Score |
|---|---|
| Boundary has tests, **zero mutations survive** | **+10** |
| Boundary has tests, baseline | **+5** |
| Per survived mutation on boundary | **-3** |
| Floor (minimum score per boundary) | **0** |

**Examples:**
- Function with 3 mutations, all killed: `+10` (airtight)
- Function with 3 mutations, 1 survives: `+5 - 3(1) = +2`
- Function with 3 mutations, 2 survive: `+5 - 3(2) = 0` (floored)
- Function with no mutations generated: `+5` (base only; red team hasn't attacked yet)

**Aggregate:** Sum of all boundary scores. Higher is better. Maximum possible = `10 × number_of_boundaries`.

### Red Team — Per Mutation

| Outcome | Score |
|---|---|
| **Survived** | **+1** |
| **Killed** | **0** |
| **Unviable** (doesn't compile) | **-1** |
| **Equivalent** (no behavioral change) | **-1** |
| **Invalid target** (uncovered code) | **-1** |
| **Disqualified** (rule violation) | **-ALL** |

**Aggregate:** Sum of all mutation scores. The red team is incentivized to produce few, high-quality mutations that survive — not many low-quality ones. Every unviable or equivalent mutation actively hurts their score.

### Combined Health Score

The report presents both scores independently. They are NOT combined into a single number because they measure different things:

- **Blue team score** answers: "How well do the tests specify behavior?"
- **Red team score** answers: "How effectively were gaps identified?"

A high blue score + high red score = strong tests AND the red team still found nuanced gaps. This is the healthiest state — it means both teams are operating at a high level and the system is converging.

A high blue score + low red score = strong tests and the red team couldn't find gaps. Either the tests are genuinely airtight, or the red team was ineffective. Subsequent rounds will clarify.

A low blue score + high red score = weak tests and the red team exposed it. Blue team has clear work to do.

---

## Exhaustive Adversarial Catalog

Every scoring system invites gaming. Below is every attack vector we have identified — including the weird ones — with the defense mechanism and its certainty level. If an attack is not listed here, it is either a variant of one that is, or we haven't thought of it yet (and we want to hear about it).

### Red Team — Structural Attacks

These attacks try to change the playing field rather than play the game.

| # | Attack | Defense | Certainty |
|---|---|---|---|
| R1 | **Delete test files** to make mutations survive | Patch validation: patch parsed as unified diff. If any path in the diff matches a test file → `disqualified`. Test files are enumerated in `project-index.json → test_infrastructure.test_files`. | **100%** — file paths in a unified diff are unambiguous |
| R2 | **Modify test files** — weaken assertions, add `#[ignore]`, change expected values | Same as R1. Patch targets are extracted from the diff header (`--- a/` / `+++ b/`). Any match against test files → `disqualified`. | **100%** |
| R3 | **Modify test helpers/fixtures** — change shared setup to break test assumptions | `test_infrastructure.helper_files` and `test_infrastructure.fixture_files` are enumerated in the index. Patch touching any of these → `disqualified`. | **100%** |
| R4 | **Modify build configuration** — change `Cargo.toml`, feature flags, or build scripts to skip tests or alter compilation | Patch must target exactly the file declared in `mutation.json → target_file`. Any file outside that → `disqualified`. Build files are never valid targets. | **100%** |
| R5 | **Modify non-target source files** — change a dependency of the function under test to break test assumptions indirectly | Same as R4. Patch must modify exactly one file, and it must match `target_file`. Multi-file patches → `disqualified`. | **100%** |
| R6 | **Delete, rename, or move files** | Unified diff format records file operations (`rename from`, `rename to`, `deleted file mode`). Referee rejects patches containing these operations. | **100%** |
| R7 | **Modify the referee script** | Referee lives at `~/.claude/skills/red-team/referee.py`, outside the health dir. Skill instructions prohibit this. Red team output is restricted to `<health_dir>/semantic/`. Even if the agent attempted to write elsewhere, it would need explicit user approval. | **Structural** |
| R8 | **Modify the project index** | Index lives at `<health_dir>/project-index.json`. Red team only writes to `<health_dir>/semantic/`. If the index is modified, its `commit` field won't match HEAD and the referee will rebuild it. | **High** |

### Red Team — Scoring Attacks

These attacks try to inflate the red team's score without finding real gaps.

| # | Attack | Defense | Certainty |
|---|---|---|---|
| R9 | **Generate 500 trivial mutations** hoping some survive by chance | Scored on net score: survived(+1), killed(0), unviable(-1). 500 mutations with 10 survivors and 50 unviable = 10 - 50 = **-40**. Volume strategy is self-destructive. | **100%** — arithmetic |
| R10 | **Submit equivalent mutations** — cosmetic changes (rename variable, reorder independent statements, change whitespace) | Equivalence detection pipeline: (1) syntactic heuristic classifies the operator type, (2) differential verification confirms behavioral change. See [Mutation Verification Protocol](#mutation-verification-protocol). Equivalent → **-1**. | **High** — see MV6 limitations |
| R11 | **Submit duplicate mutations** — same behavioral change with different IDs | Referee deduplicates: if two patches produce identical diffs after normalization (strip context lines, normalize whitespace) → second one is `duplicate`, not scored. | **100%** |
| R12 | **Mutate code behind mocks** — change real impl that tests never exercise because they use MockDb | Coverage map: if ALL mutated lines are in `coverage.files[target_file].executed == false` → `invalid_target` → **-1**. | **100%** with coverage data |
| R13 | **Mutate uncovered code** — dead code, unreachable branches, error paths never triggered | Same as R12. If the line doesn't appear in the coverage map's executed set → `invalid_target`. | **100%** with coverage data |
| R14 | **Run the test suite** before submitting to cherry-pick survivors | Red team skill prohibits this (Rule 4). Even if the agent runs tests via Bash: (a) the referee ignores self-reported results, (b) the referee re-runs tests itself in an isolated worktree. The agent seeing results doesn't change the referee's evaluation. | **Structural** — the referee is the sole evaluator regardless |
| R15 | **Submit mutations that change behavior only for inputs no test uses** — e.g., change rounding only for amounts > $1M when tests use small amounts | This is a **legitimate finding**. The tests should cover large amounts if the code handles them. Score: `survived(+1)`. This is the system working correctly. | **N/A** — this is desired behavior |

### Red Team — Semantic Attacks

These are the subtle, creative attempts that require deeper defense.

| # | Attack | Defense | Certainty |
|---|---|---|---|
| R16 | **Add `#[cfg(not(test))]`** around the mutation so it only activates in non-test builds | Referee runs `cargo test` which compiles with `cfg(test)` active. The mutation is invisible to the test binary → tests pass → mutation "survives." **BUT**: the behavioral change only manifests in production, not tests. This IS a behavioral change from the test suite's perspective: the tests cannot distinguish original from mutant. However, the mutation doesn't change behavior *in the context tests can observe*. Defense: referee runs a second compilation without `cfg(test)` and diffs the resulting binary. If the binary differs but tests don't → `conditional_mutation`, classified separately. | **Needs implementation** — currently a gap |
| R17 | **Mutate error messages only** — change `"invalid input"` to `"bad input"` | Is this behavioral? Depends on whether tests assert on error messages. If tests check error TYPES but not messages → survived, legitimately. If tests check messages → killed. The system is working correctly either way. If the referee classifies this as equivalent, it must be because NO observable output changed — but a changed error string IS an observable output. Defense: this is a valid mutation. If it survives, the blue team should test error messages. | **100%** — valid mutation, correctly scored |
| R18 | **Mutate logging output only** | Same analysis as R17. If no test checks log output → survives. If the code's contract includes logging behavior, this is a real gap. If logging is considered non-contractual → this is an equivalent mutation in spirit but not in execution. Defense: logging mutations are valid. The blue team decides whether logging is contractual by writing (or not writing) tests for it. | **100%** — valid by definition |
| R19 | **Change the function's public API signature** — add/remove parameters | Adding a parameter breaks all callers → `cargo check` fails → `unviable(-1)`. Removing a parameter might compile if no callers exist → but then the function is dead code → uncovered → `invalid_target(-1)`. | **100%** |
| R20 | **Introduce undefined behavior** — integer overflow, use-after-free (in unsafe code), data races | In safe Rust: integer overflow panics in debug, wraps in release. `cargo test` runs in debug mode by default → panic → test fails → `killed`. In unsafe Rust: UB is UB, behavior is unpredictable. Defense: referee runs tests. If they crash/fail → killed. If they pass despite UB → the mutation "survived" and this IS a real gap (tests don't catch the UB). | **100%** — correctly scored either way |
| R21 | **Submit a mutation valid at an old commit but not at HEAD** | Referee applies patches against HEAD (or the commit in the project index). `git apply` fails → `unviable(-1)`. | **100%** |

### Blue Team — Structural Attacks

| # | Attack | Defense | Certainty |
|---|---|---|---|
| B1 | **Write tautological tests** — `assert!(true)`, `assert_eq!(1, 1)` | Such tests kill zero mutations. Blue team score doesn't improve because mutations still survive. | **100%** — tautologies don't interact with source code |
| B2 | **Write redundant tests** — same assertion 50 times with different names | Scoring is per mutation killed, not per test written. 50 identical tests kill the same mutations as 1. No score inflation. | **100%** |
| B3 | **Inflate test count** without meaningful assertions — tests that call functions but don't assert on results | Same as B1. Tests without assertions don't kill mutations. The mutation changes the return value, the test ignores it, the test passes, the mutation survives. | **100%** |
| B4 | **Write snapshot tests** that pin the entire output — `assert_eq!(function(input), "<entire output copied from current run>")` | These DO kill mutations (high kill rate). But they are maximally implementation-coupled: rename an internal variable that affects debug output → test breaks. The Reimplementation Test criterion flags this, but it's not mechanically enforced today. **This is a known gap.** See [Known Limitations](#known-limitations). | **Best-effort** |
| B5 | **Call private functions** via `#[cfg(test)] pub` visibility tricks | Tests that reach past the public interface are implementation-coupled. They kill mutations but break on any internal refactor. Same gap as B4 — not mechanically enforced. | **Best-effort** |

### Blue Team — Semantic Attacks

| # | Attack | Defense | Certainty |
|---|---|---|---|
| B6 | **Over-mock** — mock everything so tests verify mock interactions, not real behavior | Coverage map shows which real code executes during tests. If a boundary's `covered_lines` is empty because everything is mocked → boundary scores +5 base but is fully exposed to red team attacks. Red team mutations will survive trivially. Score drops to 0. | **100%** via adversarial pressure |
| B7 | **Test only easy behaviors** — verify happy path, ignore error handling and edge cases | Red team is instructed to attack error paths, boundaries, and edge cases. Per-fault-class reporting makes this visible: if `error_handling` kill rate is 0%, the report shows it. | **100%** via adversarial pressure + reporting |
| B8 | **Write tests with overly broad assertions** — `assert!(result.is_ok())` instead of checking the actual value | Red team mutates the return value → result is still `Ok(...)` but with wrong data → mutation survives → blue team penalized. | **100%** — this is what mutation testing catches |
| B9 | **Write tests that use the exact same inputs the red team uses** (anticipating attacks) | Teams don't communicate. Red team can't see blue team's tests until after generating mutations. Blue team can't see red team's mutations until after the referee scores them. The shared interface is the health report, which contains RESULTS, not strategies. | **Structural** |
| B10 | **Write property-based tests with trivial generators** — `proptest` with range `0..1` | Kills mutations in the trivial range only. Red team attacks the range tests don't cover. Mutations targeting values outside the generator range will survive. | **100%** via adversarial pressure |

### System-Level Attacks

| # | Attack | Defense | Certainty |
|---|---|---|---|
| S1 | **Same LLM session plays both roles** — "chess against itself" | Two separate skill files with distinct identities, incentives, and output locations. User dispatches them in separate conversations. An agent in a blue team session has no mechanism to write to `<health_dir>/semantic/`. An agent in a red team session has no mechanism to write test files. | **Structural** |
| S2 | **Teams collude** via side channel | The only shared artifact is the health report, produced by the referee. Teams cannot read each other's work-in-progress. Blue team's tests are in the repo; red team's mutations are in the health dir. Neither has reason or mechanism to read the other's raw output before the referee runs. | **Structural** |
| S3 | **Flaky tests** corrupt signal — same mutation killed in one run, survived in another | **Currently a gap.** The referee runs each mutation once. Mitigation: multi-run consensus (run each mutation N times, require N/N agreement). Not yet implemented. Degradation: a flaky test might cause one incorrect verdict per flaky test, not systemic corruption. | **Best-effort** — needs multi-run |
| S4 | **Adversarial convergence failure** — both teams plateau without reaching full coverage | This is a real possibility. If the red team can't find gaps and the blue team has blind spots, the system stalls. Mitigation: the mechanical mutation layer (cargo-mutants) provides a baseline independent of LLM creativity. Blind spots are reported. The user can dispatch the red team with specific guidance. | **Best-effort** — requires user judgment |
| S5 | **Index staleness** — index built at commit A, evaluated at commit B | Index records its commit hash. Referee checks `index.commit` against `HEAD`. If they differ → warning in report + offer to rebuild. Stale index means coverage data and boundary definitions may be wrong. | **100%** when implemented |

---

## Mutation Verification Protocol

This section answers the question: **what IS a valid mutation, and how do we know with certainty?**

A mutation is not just "a patch file." It is a formal object with six properties, each mechanically verified. A mutation that fails ANY verification step is rejected before it ever reaches the scoring phase. The referee NEVER scores an unverified mutation.

### Formal Definition

> A **valid mutation** is a syntactic transformation that:
> 1. Modifies exactly one contiguous region of source code
> 2. Within a single function body that is part of the module's public interface
> 3. On lines that execute during the test suite
> 4. Producing code that compiles
> 5. That changes the function's observable input→output mapping
> 6. For at least one input reachable during test execution

Properties 1-4 are **mechanically verifiable with 100% certainty**. Property 5 is **verifiable with high confidence**. Property 6 is **entailed by properties 3 and 5 together**.

### The Verification Pipeline

Every mutation passes through six gates. Each gate is binary: pass or reject. No gate involves LLM judgment.

```
mutation.patch + mutation.json
        │
        ▼
┌─── MV1: STRUCTURAL VALIDITY ───┐
│  Parse unified diff             │
│  Exactly one file modified      │──── FAIL → disqualified
│  File is not a test file        │
│  File is not build config       │
│  mutation.json has all fields   │
└────────────┬────────────────────┘
             │ PASS
             ▼
┌─── MV2: TARGET VALIDATION ─────┐
│  target_file exists in repo     │
│  target_function exists in      │──── FAIL → disqualified
│    project-index.json           │
│  Mutated lines fall within      │
│    boundary's [line_start,      │
│    line_end] range              │
└────────────┬────────────────────┘
             │ PASS
             ▼
┌─── MV3: COVERAGE VALIDATION ───┐
│  At least one mutated line      │
│  appears in coverage map's      │──── FAIL → invalid_target (-1)
│  executed set for target_file   │
└────────────┬────────────────────┘
             │ PASS
             ▼
┌─── MV4: PATCH APPLICATION ─────┐
│  git apply --check passes       │──── FAIL → unviable (-1)
│  against index commit           │
└────────────┬────────────────────┘
             │ PASS
             ▼
┌─── MV5: COMPILATION ───────────┐
│  cargo check passes in          │──── FAIL → unviable (-1)
│  isolated worktree              │
└────────────┬────────────────────┘
             │ PASS
             ▼
┌─── MV6: BEHAVIORAL CHANGE ─────┐
│  Syntactic heuristic: does the  │
│  operator/literal/control flow  │──── FAIL → equivalent (-1)
│  change affect a data-dependent │
│  expression?                    │
│                                 │
│  If heuristic is inconclusive:  │
│  Differential verification —    │
│  run function with N test       │
│  inputs, compare outputs of     │
│  original vs mutant.            │
│  Any difference → PASS          │
│  All same → likely equivalent   │
└────────────┬────────────────────┘
             │ PASS
             ▼
    ┌─── VERIFIED MUTATION ───┐
    │  Eligible for scoring   │
    │  by test suite pass/    │
    │  fail evaluation        │
    └─────────────────────────┘
```

### Gate Details

**MV1 — Structural Validity** (100% certain)

Checks performed on the raw patch file and metadata JSON. No code execution required.

- Patch parses as valid unified diff (standard format, `---`/`+++` headers, `@@` hunk markers)
- Exactly one file appears in the diff (count unique `+++ b/` paths)
- That file does not match any path in `test_infrastructure.test_files`, `test_infrastructure.helper_files`, or `test_infrastructure.fixture_files`
- That file is not `Cargo.toml`, `Cargo.lock`, `build.rs`, or any CI/CD config
- `mutation.json` contains all required fields: `id`, `target_file`, `target_function`, `fault_class`, `gap`, `behavioral_change`
- `fault_class` is one of the 8 recognized values
- `target_file` in JSON matches the file in the diff

**MV2 — Target Validation** (100% certain)

Cross-references the mutation against the project index.

- `target_file` exists on disk at the repo root
- `target_function` matches the `id` or function name of a boundary in `project-index.json → boundaries[]`
- The line numbers modified by the patch (parsed from `@@` hunk headers) fall within `[boundary.line_start, boundary.line_end]`
- If any mutated line falls OUTSIDE the boundary range → `disqualified` (modifying code outside the declared function)

**MV3 — Coverage Validation** (100% certain, given coverage data)

Cross-references mutated lines against the coverage map.

- Extract the set of lines modified by the patch
- Look up `coverage.files[target_file].executed`
- At least one mutated line must appear in the executed set
- If zero mutated lines are covered → `invalid_target`: the mutation targets code that no test reaches, so its survival/death is meaningless

**Why "at least one"?** A mutation might span a covered line and an uncovered line (e.g., changing a branch condition on a covered line that guards an uncovered block). The covered line is what matters — the mutation changes behavior reachable by tests.

**MV4 — Patch Application** (100% certain)

- `git apply --check` in a clean worktree at the index commit
- Failure means the patch is malformed, targets wrong lines, or is stale
- This is a format/freshness check, not a correctness check

**MV5 — Compilation** (100% certain)

- Full `cargo check` in the worktree after applying the patch
- Tests that the mutation produces syntactically and type-valid code
- Catches: removed semicolons, type mismatches, borrow checker violations, missing imports

**MV6 — Behavioral Change Verification** (High confidence, NOT 100%)

This is the hardest gate. The question: "does this mutation change the function's observable input→output mapping, or is it a no-op?"

**Why this can't be 100%:** Semantic equivalence of two programs is undecidable in general (reducible to the halting problem). For any finite verification procedure, there exist mutations that change the code but not the behavior, and our procedure won't catch all of them.

**What we do instead — two-tier verification:**

**Tier 1: Syntactic Heuristic (fast, catches ~95%)**

Classify the syntactic change and determine if it's in a data-dependent position:

| Change Type | Likely Behavioral? | Known Equivalent Cases |
|---|---|---|
| Arithmetic operator change (`+`→`-`) | Yes | Only if operand is 0 (identity element) |
| Comparison operator change (`<`→`<=`) | Yes | Only if no value exists at the boundary |
| Literal change (`42`→`43`) | Yes | Only if the value is unused |
| Control flow change (`if`→`if !`) | Yes | Only if both branches are identical |
| Function call removal | Yes | Only if function has no side effects and return is unused |
| Statement reorder | Yes | Only if no data dependency between statements |
| Variable reference swap (`a`→`b`) | Yes | Only if `a == b` at that point always |
| `.iter()`→`.into_iter()` | Maybe | No if collection is used after; Yes if it's not |
| Type cast change | Maybe | Depends on value ranges |

If the heuristic classifies the change as "likely behavioral" with no known equivalent pattern → **PASS**.

If the heuristic is inconclusive → proceed to Tier 2.

**Tier 2: Differential Verification (slower, catches ~99%)**

Run the original function and the mutant function against the same inputs and compare outputs.

1. Extract the actual inputs used by the test suite (from test source code or by instrumenting test execution)
2. Run the original function against these inputs, capture outputs
3. Run the mutant function against the same inputs, capture outputs
4. If any input produces different output → **confirmed behavioral change → PASS**
5. If all inputs produce identical output → **likely equivalent → FAIL**

**Residual risk:** A mutation that changes behavior only for inputs that no test uses AND that the differential verifier doesn't generate. This is a true false-negative. The mitigation is that such mutations are also unlikely to be caught by the test suite anyway — if no test exercises the differing behavior, the mutation survives, and the blue team is correctly penalized.

### What This Gives Us

After a mutation passes all six gates:

- **We know it targets the right code** (MV1, MV2) — 100%
- **We know tests can reach it** (MV3) — 100%
- **We know it compiles** (MV4, MV5) — 100%
- **We have high confidence it changes behavior** (MV6) — ~99%

The combined confidence that a verified mutation is legitimate: **effectively certain** for the structural properties, **high confidence** for behavioral change. The ~1% residual is equivalent mutations that slip through both tiers of MV6. These are scored -1 if caught later, and the scoring system tolerates the noise.

**Crucially: we never score an unverified mutation.** Every mutation that reaches the "run tests and check pass/fail" stage has been mechanically validated as targeting real, covered, compilable code with high confidence of behavioral change. This is what makes a "survived" verdict meaningful — it's not "the tests missed something that might not matter," it's "the tests missed a real behavioral change in code they actually exercise."

---

## Mock Contracts

Mocks are the single biggest threat to measurement integrity. A mock replaces real behavior with canned responses. Any mutation behind a mock is invisible to tests — not because the tests are weak, but because the mock prevents the real code from executing.

The system must distinguish **"tests are weak"** from **"tests can't see this code"**. Mock contracts are how.

### Definition

> A **mock contract** declares: "In the test environment, trait `T` is implemented by mock `M` instead of real implementation `R`. All tests that exercise code depending on `T` will see `M`'s behavior, not `R`'s. Therefore, mutations in `R` are invisible to these tests."

### Schema

```json
{
  "trait_or_interface": "DatabaseTrait",
  "real_impl": {
    "file": "src/db/postgres.rs",
    "type_name": "PostgresDb",
    "line_start": 15,
    "line_end": 220,
    "methods": [
      { "name": "query", "lines": [45, 80] },
      { "name": "execute", "lines": [82, 130] },
      { "name": "transaction", "lines": [132, 220] }
    ]
  },
  "mock_impl": {
    "file": "tests/mocks/db.rs",
    "type_name": "MockDb",
    "line_start": 5,
    "line_end": 60
  },
  "consumers": [
    {
      "function": "crate::orders::process_order",
      "file": "src/orders.rs",
      "depends_on_trait_via": "fn process_order(db: &dyn DatabaseTrait)"
    }
  ],
  "tests_using_mock": ["test_process_order_happy_path", "test_process_order_out_of_stock"],
  "tests_using_real": [],
  "coverage_consequence": "Lines 45-220 in src/db/postgres.rs are uncovered by tests using MockDb. Mutations in this range are invalid_target."
}
```

### How Mock Contracts Are Built

The referee detects mocks via heuristic scan during `--index`:

**Rust patterns:**
- `#[automock]` attribute → trait is mocked via `mockall`
- `#[double]` attribute → `mockall_double` substitution
- `struct Mock*` implementing a trait → manual mock
- `cfg(test)` conditional imports that swap implementations
- Test functions that construct mock types

**The scan produces:**
- Which traits are mocked
- Where the real implementation lives (file + lines)
- Where the mock lives
- Which tests use the mock (by tracing type construction in test functions)
- Which tests use the real implementation (if any)

**Cross-reference with coverage:**
- If `real_impl.lines` are covered → some tests use the real implementation → mutations there are valid
- If `real_impl.lines` are NOT covered → all tests use the mock → mutations there are `invalid_target`
- This is the enforcement. The mock contract provides the **explanation**. Coverage provides the **verdict**.

### Mock Scope as a Risk Signal

Mock contracts also serve as a risk signal in the report:

```json
{
  "mock_risk": [
    {
      "trait": "DatabaseTrait",
      "real_impl_lines": 175,
      "covered_by_real_tests": 0,
      "risk": "high",
      "note": "175 lines of database logic are completely untested through real implementation. All tests use MockDb. Bugs in SQL generation, connection handling, or transaction semantics cannot be detected by the current test suite."
    }
  ]
}
```

This doesn't affect scoring — it's informational. But it tells the user: "your test suite is structurally incapable of catching bugs in this region, regardless of how many tests you write, as long as you're mocking the database."

The fix is outside this system's scope: write integration tests with a real database. But the system surfaces the problem explicitly rather than hiding it.

---

## Data Contracts

### Interface: Red Team → Referee

**Location:** `<health_dir>/semantic/<mutation_id>/`

**Files per mutation:**

`mutation.json` (required):
```json
{
  "id": "string — descriptive slug, unique",
  "target_file": "string — path relative to repo root",
  "target_function": "string — function name being mutated",
  "fault_class": "enum — one of the 8 fault classes",
  "gap": "string — plain English description of what the tests don't cover",
  "behavioral_change": "string — what observable behavior changes",
  "confidence": "enum — high | medium | low"
}
```

`mutation.patch` (required):
```
Unified diff format. Must apply cleanly with `git apply` against repo root at the commit recorded in the project index.
```

**Validation (referee performs before evaluation):**
1. Both files exist and parse correctly
2. `target_file` matches a file in the repo
3. `target_function` matches a boundary in the index
4. `fault_class` is one of the 8 recognized classes
5. Patch modifies ONLY `target_file`
6. Patch does NOT modify any file under test directories
7. Patch applies cleanly
8. Mutated code compiles

Failures at steps 1-7 → `disqualified`. Failure at step 8 → `unviable`.

### Interface: Referee → Both Teams

**Location:** `<health_dir>/report.json`

```json
{
  "version": 1,
  "timestamp": "ISO 8601",
  "repo_root": "string",
  "commit": "string",
  "index_commit": "string — commit the project index was built from",
  "coverage_available": true,

  "summary": {
    "total_boundaries": 25,
    "boundaries_tested": 22,
    "boundaries_airtight": 15,
    "total_mutations": 45,
    "killed": 38,
    "survived": 5,
    "unviable": 1,
    "equivalent": 1,
    "overall_kill_rate": 0.884
  },

  "blue_team": {
    "total_score": 185,
    "max_possible": 250,
    "percentage": 74.0,
    "per_boundary": {
      "crate::module::process_order": {
        "score": 10,
        "mutations_faced": 3,
        "survived": 0,
        "verdict": "airtight"
      },
      "crate::module::validate_input": {
        "score": 2,
        "mutations_faced": 2,
        "survived": 1,
        "verdict": "gap"
      }
    }
  },

  "red_team": {
    "total_score": 3,
    "mutations_submitted": 8,
    "survived": 5,
    "killed": 2,
    "unviable": 1,
    "equivalent": 0,
    "invalid_target": 0,
    "disqualified": 0
  },

  "by_fault_class": {
    "wrong_value":        { "total": 12, "killed": 11, "survived": 1, "kill_rate": 0.917 },
    "wrong_path":         { "total": 8,  "killed": 7,  "survived": 1, "kill_rate": 0.875 },
    "missing_action":     { "total": 5,  "killed": 5,  "survived": 0, "kill_rate": 1.0 },
    "wrong_binding":      { "total": 3,  "killed": 2,  "survived": 1, "kill_rate": 0.667 },
    "wrong_sequencing":   { "total": 2,  "killed": 2,  "survived": 0, "kill_rate": 1.0 },
    "boundary_error":     { "total": 6,  "killed": 5,  "survived": 1, "kill_rate": 0.833 },
    "error_handling":     { "total": 9,  "killed": 6,  "survived": 3, "kill_rate": 0.667 },
    "resource_lifecycle": { "total": 0,  "killed": 0,  "survived": 0, "kill_rate": null, "status": "NOT TESTED" }
  },

  "survived_mutations": [
    {
      "id": "validate_input__boundary__off_by_one_max_length",
      "target_file": "src/module.rs",
      "target_function": "validate_input",
      "fault_class": "boundary_error",
      "gap": "Tests check that strings over 256 chars are rejected, but no test checks the boundary at exactly 256.",
      "behavioral_change": "Changes < 256 to <= 256, rejecting strings of exactly 256 chars."
    }
  ],

  "blind_spots": ["resource_lifecycle"],

  "warnings": [
    "Index was built at commit abc123 but HEAD is now def456. Rebuild index for accurate results."
  ]
}
```

### Interface: Referee → Both Teams (Index)

**Location:** `<health_dir>/project-index.json`

Schema defined in [The Project Index](#the-project-index) section above.

---

## Workflow

### Cold Start (No Existing Tests)

```
Step 0:  referee.py --index
         → Extracts boundaries, measures coverage (likely ~0%), detects mocks
         → Writes project-index.json

Step 1:  /dev-test <target>
         → Reads index (no report yet — starting cold)
         → Discovers public interface, traces data flow
         → Writes contract catalog, then test code
         → Tests committed to repo

Step 2:  referee.py --index
         → Rebuilds index with new coverage data (now >0%)

Step 3:  referee.py --mechanical
         → Runs cargo-mutants against new tests
         → Initial kill rate established

Step 4:  /red-team <target>
         → Reads index + report
         → Studies tests, finds gaps
         → Writes semantic mutations to health dir

Step 5:  referee.py --evaluate
         → Evaluates mechanical + semantic mutations
         → Writes report.json with per-boundary, per-fault-class scores

Step 6:  /dev-test <target>
         → Reads report, sees survived mutations
         → Writes tests to close gaps
         → Repeat from Step 2
```

### Steady State (Existing Tests)

```
Step 0:  referee.py --index
         → Rebuild index (or verify it's current)

Step 1:  referee.py --all
         → Full evaluation of current state
         → report.json shows baseline

Step 2:  /red-team <target>
         → Attacks weak fault classes and boundaries
         → Writes mutations

Step 3:  referee.py --evaluate
         → Scores red team mutations
         → Updated report

Step 4:  /dev-test <target>
         → Closes gaps identified by red team
         → Writes new tests

Step 5:  Repeat from Step 0
```

### Convergence

The system converges when:
- All boundaries score +10 (no mutations survive)
- All fault classes have kill rate >= 80%
- No blind spots remain
- Red team cannot find gaps (red team score → 0)

At convergence, the test suite satisfies the Reimplementation Test: a competent developer could reimplement the module from the tests alone, because every observable behavior at every boundary has been verified against adversarial mutations across all fault dimensions.

**Convergence is not permanent.** New code introduces new boundaries. Refactored code changes existing ones. The index must be rebuilt and the cycle restarted after significant changes.

---

## Implementation Status

| Component | Status | Location |
|---|---|---|
| `/dev-test` skill | **Built** | `~/.claude/skills/dev-test/SKILL.md` |
| `/red-team` skill | **Built** | `~/.claude/skills/red-team/SKILL.md` |
| `referee.py` — mechanical layer | **Built** | `~/.claude/skills/red-team/referee.py` |
| `referee.py` — semantic layer | **Built** | `~/.claude/skills/red-team/referee.py` |
| `referee.py` — report generation | **Built** | `~/.claude/skills/red-team/referee.py` |
| `referee.py --index` (AST extraction) | **Not built** | — |
| `referee.py --index` (coverage measurement) | **Not built** | — |
| `referee.py --index` (mock detection) | **Not built** | — |
| Coverage-based mutation validation | **Not built** | — |
| Per-boundary scoring | **Not built** | — |
| Patch validation (anti-cheat) | **Not built** | — |
| Skills consuming project index | **Not built** | — |
| Stale index detection | **Not built** | — |

### What Works Today

The current system supports the basic loop:
1. `/dev-test` writes tests (with health report awareness)
2. `/red-team` generates mutations (with health report awareness)
3. `referee.py` evaluates both mechanical and semantic mutations
4. Report feeds back into both teams

### What's Missing For Full Guarantees

The guarantees claimed in this spec require the project index and coverage validation. Without them:
- G1 (mechanical boundaries) → **not enforced** — teams define their own scope
- G2 (coverage validation) → **not enforced** — mutations can target uncovered code
- G6 (mock boundaries) → **not enforced** — mutations behind mocks count as survived
- Boundary-based scoring → **not available** — report shows fault-class aggregates only

The mechanical and semantic evaluation layers work. The index is the gap.

---

## Known Limitations

These are things this system **cannot** do, by design or by practical constraint. We list them here because a system that hides its limitations is less trustworthy than one that states them plainly.

### Hard Limitations (Fundamental)

1. **Cannot prove the absence of all gaps.** Surviving zero mutations proves resilience against the mutations that were generated. It does NOT prove resilience against ALL possible mutations. There may exist a mutation nobody thought of. This is inherent to adversarial testing — it can prove the presence of gaps but not the absence of all gaps. The Reimplementation Test is an asymptotic goal, not a provable property.

2. **Cannot guarantee mutation quality.** The red team is an LLM. It might miss gaps that exist. The system incentivizes it to find gaps, but can't guarantee it finds ALL gaps. A zero-survival score means "the red team couldn't find anything," not "nothing exists to find."

3. **Equivalent mutation detection is undecidable.** MV6 (behavioral change verification) uses heuristics and differential testing, achieving ~99% confidence. The remaining ~1% is inherent: semantic equivalence of two programs is reducible to the halting problem. We handle the residual by scoring undetected equivalents as -1 when caught, and tolerating the noise.

4. **Cannot catch architectural bugs.** This system operates at the function/module level. Bugs that emerge from the interaction of correctly-behaving components (race conditions, distributed consistency, emergent performance degradation) are out of scope.

5. **Cannot test through integration boundaries without real infrastructure.** If the module talks to Postgres and tests use MockDb, mutations in the SQL generation layer are behind the mock. The system correctly identifies this (via coverage and mock contracts), but can't fix it — that requires integration tests with a real database, which is outside this system's scope. The system surfaces this as a `mock_risk` signal.

### Practical Limitations (Solvable, Not Yet Solved)

6. **Conditional compilation attacks (R16).** A mutation wrapped in `#[cfg(not(test))]` is invisible to the test binary. The referee currently doesn't detect this. Fix: compile the mutant BOTH with and without `cfg(test)`, diff the binaries, classify accordingly. This is implementable but not yet built.

7. **Flaky test handling.** If `test_timing_sensitive` passes 99% of the time and fails 1%, the referee's single-run evaluation may produce incorrect verdicts. Fix: multi-run consensus (run each mutation N times, require unanimous agreement). Implementable but adds evaluation time proportional to N.

8. **Blue team implementation coupling (B4, B5).** Tests that assert on implementation details (snapshot tests, private function calls) achieve high kill rates but are brittle. The scoring system doesn't mechanically penalize this. Fix: automated refactoring resilience testing — apply semantics-preserving refactors (extract method, rename variable) and check if tests still pass. Not yet built.

9. **Rust-centric today.** The AST extraction, coverage tooling, and mutation operators are designed for Rust (`syn`, `cargo llvm-cov`, `cargo-mutants`). Extending to other languages requires language-specific implementations of the index builder. The architecture is language-agnostic; the tooling is not yet.

10. **Project index not yet built.** The guarantees G1, G2, G6, and the boundary-based scoring all depend on the project index (`referee.py --index`). Without it, the system functions but with degraded guarantees: teams define their own scope, mutations can target uncovered code, and mock boundaries are not enforced. The index is the critical path to full guarantee enforcement.

---

## Premortem Addendum (Hardening Before Trust)

This section treats the current design as if it already failed in production and works backward from concrete failure stories. The purpose is to close reward-hack seams before this system is used for confidence-critical decisions.

### Failure Scenarios

| ID | Premortem Failure | Reward-Hack Seam | Early Signal | Hardening Control |
|---|---|---|---|---|
| P1 | Red team submits mutations that make tests hang, not fail | Survival metric conflates "not killed" with "valuable gap" | Spike in timeout outcomes on red patches | Add `timeout_abuse` class. Score `-2` for attacker. Never count timeout as survived. |
| P2 | Blue team writes brittle snapshot tests that kill many mutants but fail harmless refactors | Blue score rewards kill rate only | High kill rate plus frequent breakage after no-op refactors | Add `robustness lane` with semantics-preserving refactors. Blue gets bonus only if both kill and robustness pass. |
| P3 | Red team farms one weak boundary repeatedly for easy points | Per-mutation reward allows concentration | >50% of red survivors on one boundary | Cap credited survivors per boundary per round. Require novelty fingerprint delta for full credit. |
| P4 | Red team uses `cfg(not(test))` or environment-gated changes | Test-only execution hides production behavior | Mutation survives but binary differs across build modes | Mandatory dual build check (`test` and `non-test`) and classify as `conditional_behavior_gap`. |
| P5 | Coverage data is stale or partial, invalidating target checks | G2 assumes trustworthy coverage map | Index commit != HEAD or missing files in coverage output | Hard-fail evaluation on stale/partial coverage unless explicit `--degraded` flag is passed. |
| P6 | Equivalent mutants pass MV6 and pollute signal | Heuristic/differential misses corner equivalence | High equivalent detection in manual audit | Add independent mutation auditor lane and random referee spot-checks with alternate oracle. |
| P7 | Blue and red overfit to visible report patterns, not behavior | Shared visible metrics become training target | Visible lane improves while hidden lane stagnates | Split scoring into visible lane and holdout lane. Convergence requires both. |
| P8 | Referee bug silently biases one team | Single deterministic judge is a single point of failure | Sudden score drift after referee change | Version referee, lock with checksum, require referee self-test suite pass before run acceptance. |
| P9 | Flaky tests create false kills/survivals | Single-run verdict too noisy | Same mutation alternates outcomes | Multi-run consensus with `stable_killed`, `stable_survived`, `unstable` states. Unstable not scored. |
| P10 | Mutation modifies behavior only through global state side-effects (env, fs, threads) | Observable behavior model is too narrow | Tests pass alone, fail in suite, or vice versa | Execute isolated process per mutation with clean env/fs sandbox and leak checks. |
| P11 | Mock-heavy code reports false confidence on pure unit coverage | Mock boundaries hide real behavior | High mock risk with low integration coverage | Add explicit `integration_obligation` gate for high-risk mocks before convergence allowed. |
| P12 | Red team weaponizes compile cost (pathological generics/macros) | Runtime budget not part of reward | Compile/eval time balloons on red submissions | Resource budget per mutation. Over-budget patch is `resource_abuse` and penalized. |

### Counter-Active Agent Topology

Two agents are not enough for robust equilibrium. Use four adversarial roles plus referee:

| Role | Objective | Can Influence | Cannot Influence |
|---|---|---|---|
| Blue Defender | Maximize behavioral kill rate while staying refactor-robust | Test files | Mutation scoring, referee code |
| Red Attacker | Find real behavior gaps in covered code | Mutation patches | Test files, referee code |
| Green Mutation Auditor | Disprove red claims (equivalent, invalid target, duplicate, resource abuse) | Audit challenges on red mutations | Test files, blue score formula |
| Yellow Refactor Auditor | Disprove blue robustness with semantics-preserving refactors | Refactor challenge patches and brittleness findings | Red score formula, target code semantics |
| Referee | Deterministically adjudicate all artifacts | Verdicts and scoring | Team strategy |

This balances incentives by making every reward claim contestable by an independent agent with opposite incentives.

### Reward Model Adjustments

#### Blue Defender

`blue_boundary_score = clamp(0, 12, 5 + airtight_bonus + robustness_bonus - survived_penalty - brittleness_penalty)`

- `airtight_bonus = +3` if zero stable survivors on boundary.
- `robustness_bonus = +2` if yellow refactor lane finds zero brittle failures on boundary.
- `survived_penalty = 3 * stable_survivors`.
- `brittleness_penalty = 2 * confirmed_brittle_refactor_failures`.

#### Red Attacker

`red_mutation_score = survive_reward + severity_bonus - quality_penalties`

- `survive_reward = +1` for `stable_survived`.
- `severity_bonus = +0.5` if mutation hits a boundary currently marked `airtight` in previous round.
- `quality_penalties`: `equivalent(-1)`, `invalid_target(-1)`, `unviable(-1)`, `duplicate(-1)`, `timeout_abuse(-2)`, `resource_abuse(-2)`.

#### Green Mutation Auditor

- `+1` for each accepted challenge that reclassifies a red mutation from scored to unscored/penalized.
- `-1` for rejected challenge.
- Per-round challenge cap prevents spam.

#### Yellow Refactor Auditor

- `+1` per confirmed semantics-preserving refactor that breaks blue tests.
- `-2` if refactor is not semantics-preserving or breaks compile.
- Bonus `+1` when brittle break occurs on boundary previously marked `airtight`.

### Mandatory Hardening Rules

1. `stale_index` is a hard error by default. No automatic fallback.
2. Every mutation gets a wall-clock timeout and CPU/memory cap.
3. Timeouts are never counted as survived.
4. Evaluation uses clean process isolation per mutation (`tmpdir`, env scrub, no shared caches unless deterministic).
5. Random seed, timezone, locale, and clock mode are fixed for evaluation.
6. At least one hidden holdout mutation set is scored each round and excluded from team-visible detail.
7. At least one hidden holdout input set is used for differential checks in MV6 tier 2.
8. Each fault class must have a minimum mutation count before class-level kill rates are considered meaningful.
9. Convergence cannot be declared if any high-risk mock contract has zero real-path integration coverage.
10. Referee changes require signed version bump and passing referee regression suite.

### Edge Cases Requiring Explicit Handling

| Edge Case | Failure Risk | Required Handling |
|---|---|---|
| Floating-point nondeterminism (`NaN`, `-0`, platform math differences) | False equivalent or flaky verdicts | Canonical float comparison policy in referee and deterministic math flags where possible |
| Concurrency and race-sensitive behavior | Non-reproducible kill/survive outcomes | Dedicated stress lane with repeated scheduling perturbation; classify separately from deterministic lane |
| Panic vs abort profile differences | Mutation appears dead in test profile, live in release profile | Evaluate both debug test profile and release-like profile for selected critical boundaries |
| Locale/timezone-sensitive formatting/parsing | Hidden behavior drift by environment | Force `TZ=UTC`, `LC_ALL=C`, fixed locale in mutation runs |
| Serialization order of maps/sets | Snapshot brittleness and false red wins | Canonicalize serialized structures before assertion where contract allows |
| Background thread/task leaks | Mutation passes tests but degrades process over rounds | Post-test leak probes (thread/task/file descriptor counts) and `resource_lifecycle` penalties |
| Generated code and macro expansions | Unindexed boundaries and blind zones | Expand and map generated spans into boundary index, or hard-report unresolved coverage debt |
| Cross-file semantic dependencies | Single-file mutation rule hides real attack surfaces | Allow controlled multi-file mutations only through explicit dependency whitelist and stricter auditing |

### Confidence Gate (Required Before "Converged")

A project is not "converged" unless all conditions below hold in the same round:

1. Fresh index at current commit with full coverage map.
2. Deterministic lane instability rate below 1% (`unstable` verdicts / total evaluations).
3. Visible-lane and holdout-lane kill rates both meet threshold (for example `>= 85%`).
4. Every fault class has at least `N` evaluated mutations (recommend `N >= 5`) or is explicitly marked out-of-scope.
5. No unresolved high-risk mock contracts with zero real-path tests.
6. Robustness lane shows zero confirmed brittle failures on boundaries marked airtight.
7. Red and green dispute resolution backlog is empty (no unadjudicated contested mutations).

If any gate fails, convergence claim is blocked and report status is `not_converged`.

### Implementation Priorities (Critical Path)

| Priority | Item | Why It Is Blocking |
|---|---|---|
| P0 | Build `--index` with commit pinning + coverage integrity checks | Without this, G1/G2/G6 are not enforceable |
| P0 | Add timeout/resource abuse classification | Prevents DoS from being rewarded as survivor signal |
| P0 | Add stale-index hard-fail and degraded-mode explicit opt-in | Prevents silent false confidence |
| P1 | Add multi-run consensus and `unstable` verdict class | Removes flake noise from score |
| P1 | Add holdout lane (hidden mutations + hidden inputs) | Prevents overfitting to visible report |
| P1 | Add mutation auditor (green lane) and robustness auditor (yellow lane) | Creates independent counter-active incentives |
| P2 | Add semantics-preserving refactor catalog for brittleness testing | Penalizes implementation-coupled blue tests |
| P2 | Expand unresolved boundary handling for macros/generated code | Reduces blind spots |

This addendum is normative for a confidence-critical deployment. If these controls are not implemented, reports should be labeled `advisory`, not `proof-like`.
