# Test Coverage Review

Date: 2026-02-26

## Executive Summary

The Nova monorepo has **82 test files** across **24 packages**. Test quality varies
significantly: some domains (LLM retry, orchestrator control flow) are thoroughly
tested with edge cases and invariant checks, while several core domains have **zero
test coverage**. There is no mutation testing, and true cross-process integration
tests are limited to a single smoke script.

---

## 1. Coverage Map: Source Modules vs Tests

### Well-Tested Domains

| Domain | Test Files | Verdict |
|--------|-----------|---------|
| **Orchestrator** | 6 files (basic, edge-cases, invariants, statemachine, applyPatches, unifiedHooks) | Strong. Covers happy path, pause/cancel, hook cancellation, work-item scoping, lifecycle event invariants. |
| **LLM** | 7 files (adapter, retry, policies, codex, codex.tool-names, schema_compiler, tool_skins) | Strong. Retry/circuit-breaker tests are exemplary — include "BUG CANDIDATE" annotations, jitter edge cases, overflow, concurrent state. |
| **Agent-Memory** | 30 files across architecture, connectors, db, models, normalization, resolution, etc. | Comprehensive breadth. Largest test surface in the repo. |
| **Tools/Builtins** | 9 files (apply_patch, bash, glob, grep, read, write, web_search, expand_conversation, types) | Good per-tool coverage. |
| **Shared** | 4 files (output_schemas, streaming_json, structured_output, structured_output.observer) | Solid. |
| **TUI** | 6 files (diff, normalization, parsing, rendering, store, syntax) | Good UI-layer coverage. |
| **Semantic-Compiler** | 3 files (ability, compiler, io) | Adequate. |
| **Comms-Bus** | 1 file (pub/sub + EventBus forwarding) | Covers the core integration path, but only 2 test cases. |
| **Agent** | 2 files (agent + memory-integration) | Covers basic execution, cancellation, tool calls, memory injection. |

### Partially Tested Domains (Gaps)

| Domain | Source Files | Tests | Gaps |
|--------|-------------|-------|------|
| **Harness-Daemon** | 23 source files | 4 test files | **Missing:** `orchestrator_runner.ts`, `permissions.ts` (600 lines, security-critical), `config_loader.ts`, `session_state.ts`, `session_queries.ts`, `event_translator.ts`, `error_handlers.ts`, `local_providers.ts`, `skills_loader.ts`, `daemon.ts`, `harness.ts`, `harness_infra.ts`, `auth_service.ts`. Only bridge_gateway, configured_effect_hooks, session_store, and graphd_subscriber have tests. |
| **GraphD** | 8 source files | 1 test file | Only `store.metadata_merge` is tested. **Missing:** `server.ts`, `manager.ts`, `graphd.ts` (main daemon), `utils.ts`, `schema.ts` (migration logic). |
| **LLM Rate Limits** | `rate-limits.ts` (183 lines) | 0 test files | `parseRateLimitHeaders()` and `classifyRateLimitType()` are non-trivial parsing functions with multiple provider-specific branches. Zero coverage. |
| **Orchestrator** | `bounds-checker.ts`, `decision_mappers.ts`, `execution_state.ts` | Indirect only | BoundsChecker is exercised indirectly through orchestrator tests, but has no dedicated unit tests for boundary conditions (e.g., exactly-at-limit vs one-over). |
| **Memory-Injector** | `injector.ts`, `types.ts` | 1 test file | Only tests `injector.recent`; main injection path coverage unclear. |

### Untested Domains (Zero Coverage)

| Domain | Source Files | Complexity | Risk |
|--------|-------------|-----------|------|
| **Runtime** | `cancellation.ts`, `control.ts`, `errors.ts`, `tracing.ts` | Medium-high (Effect-based concurrency, deferred cancellation, queue-based control) | **High** — These are foundational concurrency primitives. Bugs here ripple into orchestrator and agent. |
| **Protocol** | 20 source files across `control/`, `domain/`, `effects/`, `hooks/`, `protocol/` | Medium (type guards, decision serialization, hook policies, schema validation) | **Medium** — `decisions.ts` has ~225 lines of type guards + summarizeDecision logic with switch exhaustiveness. `gates.ts` has control flow logic. |
| **Work** | `work-item.ts`, `knowledge.ts` | Low-medium | **Low-medium** — Used by agent and orchestrator but may be largely structural. |
| **Entity-Graph** | 10 source files (pipeline, parser, extractor, queries, leasing, hooks) | High (tree-sitter parsing, SQL persistence, provenance-based wipe-and-replace) | **High** — `pipeline.ts` has raw SQL construction with dynamic parameter binding. No test coverage whatsoever. |
| **Harness-Client** | `index.ts`, `types.ts` | Low | Low — likely thin client. |
| **Prompt-Protocol** (external) | Unknown | Unknown | Low — external dependency. |
| **Apps (Launcher, Dashboard, Dashboard-Compact)** | Multiple files | Medium | Medium — UI/CLI entry points. |

---

## 2. Test Quality Assessment

### Strengths

- **Retry/Circuit-Breaker tests** (`tests/llm/retry.test.ts`) are best-in-class:
  annotated "BUG CANDIDATE" sections, overflow edge cases, concurrent state mutation
  scenarios, jitter distribution checks. This should be the quality bar for the whole
  repo.
- **Orchestrator tests** cover the full pause/cancel/resume state machine with real
  Effect runtime execution, not just mocked stubs.
- **Agent-memory** tests have the deepest coverage in breadth, touching connectors,
  normalization, resolution, architecture, and observability.

### Weaknesses

- **Heavy mock duplication:** The `createMockLLM`, `createResponse`, `createToolRegistry`,
  and `createAgentRegistry` helpers are copy-pasted across 5+ orchestrator/agent test
  files with minor variations. This should be a shared test fixture module.
- **Happy-path bias in several areas:** `comms-bus/bus.test.ts` has only 2 tests — both
  happy-path. No tests for: client disconnect/reconnect, message ordering under load,
  server crash recovery, malformed message handling.
- **No negative/adversarial testing for permissions:** `permissions.ts` is 600 lines of
  security-critical code (path traversal checks, shell command parsing, glob matching)
  with **zero tests**. This is the highest-risk gap in the entire repo.
- **No property-based testing:** For domains like JSON parsing (`streaming_json.ts`),
  permission rule matching, and rate-limit header parsing, property-based tests (e.g.,
  fast-check) would find edge cases that hand-written examples miss.

---

## 3. Do We Need Mutation Testing?

**Yes, selectively.** Full-repo mutation testing would be expensive and noisy. Target
it at:

| Target | Rationale |
|--------|-----------|
| `packages/core/llm/src/retry.ts` | Already well-tested — mutation testing validates the tests actually catch regressions, not just pass. |
| `packages/core/orchestrator/src/bounds-checker.ts` | Small, pure, critical boundary logic. Off-by-one errors here silently change agent behavior. |
| `packages/core/llm/src/rate-limits.ts` | Once tests exist, mutation testing verifies the classification branches are load-bearing. |
| `packages/infra/harness-daemon/src/harness/permissions.ts` | Once tests exist. The glob matching + shell parsing logic is a prime mutation testing target. |

**Recommended tool:** [Stryker Mutator](https://stryker-mutator.io/) with the Vitest
plugin. Start with `--mutate 'packages/core/llm/src/retry.ts'` and expand incrementally.

---

## 4. Do We Need More Integration Tests?

**Yes.** The current integration surface is thin:

| What Exists | What's Missing |
|-------------|----------------|
| `scripts/smoke/interprocess-smoke.ts` (single smoke script) | **Orchestrator-to-Agent-to-Tool roundtrip:** An integration test that exercises the real orchestrator→agent→tool→LLM pipeline with a lightweight local LLM mock server (not just in-memory mocks). |
| `tests/comms-bus/bus.test.ts` (real TCP server/client) | **Bus under failure conditions:** Disconnect, reconnect, message loss, backpressure. |
| `tests/agent-memory/derived/integration.test.ts` | **Daemon lifecycle:** Start harness-daemon, connect TUI client, send a request, verify end-to-end event flow through bus → orchestrator → agent → tool → response. |
| None | **GraphD persistence roundtrip:** Write entities via entity-graph pipeline, query them back via graphd store, verify correctness. Requires SQLite or Postgres test harness. |
| None | **Permission checker integration:** Load real config files, check tool/target combinations, verify the priority cascade (dangerous → session → persistent → ask). |

### Recommended Integration Test Architecture

```
tests/
  integration/
    orchestrator-roundtrip.integration.test.ts
    daemon-lifecycle.integration.test.ts
    permission-cascade.integration.test.ts
    graphd-persistence.integration.test.ts
    bus-resilience.integration.test.ts
```

Tag these with a vitest project or `describe.skip` behind an env flag so they don't
run on every local `vitest run`.

---

## 5. Core Domains Still Not Adequately Tested

### Critical Priority (security, correctness, data integrity)

1. **`permissions.ts`** — Default-deny permission system, 600 lines, zero tests.
   Shell command parsing (`parseChainedCommands`), path traversal detection,
   `restrictWriteToPaths` enforcement, glob matching cascades. This is the security
   boundary of the entire agent system.

2. **`entity-graph/pipeline.ts`** — Raw SQL construction with dynamic parameter
   indices, provenance-based deletion, concurrent worker pool. SQL injection risk
   if entity data is ever attacker-influenced.

3. **`runtime/` (cancellation.ts, control.ts)** — Foundational concurrency
   primitives used by every execution path. `interruptWhenCancelled` races an Effect
   against a deferred signal — subtle timing bugs here would be silent.

4. **`rate-limits.ts`** — Provider-specific header parsing with duration string
   parsing, timestamp parsing, and rate-limit classification. Untested branches will
   produce wrong backoff times in production.

### High Priority (functional correctness)

5. **`protocol/control/decisions.ts`** — `summarizeDecision()` has a complex switch
   across all decision types. Missing a branch silently returns "Unknown decision".

6. **`orchestrator/bounds-checker.ts`** — Boundary conditions (exactly at limit vs
   over) are not directly tested. The `>=` vs `>` distinction in `checkToolCalls`
   (uses `>=`) vs `checkIterations` (uses `>`) is load-bearing and should have
   dedicated boundary tests.

7. **`graphd/store.ts`** — SQLite store with schema migration, metadata merge logic.
   Only metadata_merge is tested; CRUD operations, schema versioning, and error paths
   are not.

8. **`harness-daemon/` (13 untested files)** — Most of the daemon's operational
   logic is untested: config loading, session lifecycle, error handling, auth service,
   event translation.

### Medium Priority (reliability)

9. **`comms-bus/`** — Only 2 happy-path tests. Needs disconnect/reconnect,
   malformed message, and backpressure tests.

10. **`shared/logger.ts`, `profiler.ts`** — No tests. Lower risk but profiler timing
    bugs could produce misleading performance data.

---

## 6. Concrete Recommendations

### Immediate Actions (this sprint)

- [ ] **Write unit tests for `permissions.ts`** — Prioritize: path traversal,
  `parseChainedCommands`, `isDeleteLikeCommand`, `restrictWriteToPaths`, rule
  priority cascade. Aim for 30+ test cases.
- [ ] **Write unit tests for `rate-limits.ts`** — Cover all provider header formats
  (OpenAI, Anthropic, Cerebras), duration parsing edge cases, classification branches.
- [ ] **Write unit tests for `bounds-checker.ts`** — Boundary-value tests for
  exactly-at-limit, one-over, and one-under for each bound type.
- [ ] **Extract shared test fixtures** — Create `tests/_fixtures/mock-llm.ts` with
  the common `createMockLLM`, `createResponse`, `createToolRegistry`,
  `createAgentRegistry` helpers to eliminate duplication.

### Near-Term (next 2 sprints)

- [ ] **Write unit tests for `runtime/cancellation.ts` and `runtime/control.ts`**
- [ ] **Write unit tests for `protocol/control/decisions.ts`**
- [ ] **Add integration test for orchestrator roundtrip** with a real TCP mock server
- [ ] **Add integration test for permission cascade** with temp config files
- [ ] **Introduce Stryker mutation testing** for `retry.ts` and `bounds-checker.ts`

### Longer-Term

- [ ] **Entity-graph pipeline tests** (requires tree-sitter + test SQL fixtures)
- [ ] **Harness-daemon unit tests** for the 13 untested source files
- [ ] **GraphD store CRUD tests** (requires SQLite test harness)
- [ ] **Property-based testing** for `streaming_json.ts`, `permissions.ts` glob
  matching, and rate-limit header parsing
- [ ] **CI coverage gates** — Add `vitest run --coverage` with threshold enforcement
  to the CI pipeline (e.g., fail if coverage drops below 60% for core packages)
