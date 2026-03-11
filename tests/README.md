# Test Layout

This repository has legacy test placement, but the canonical layout going forward is:

- `tests/behavioral/<subsystem>/...` for behavioral tests that exercise real boundaries end-to-end or near end-to-end
- `tests/_infra/` for shared behavioral-test infrastructure and resource helpers
- `tests/_fixtures/` for reusable fixtures and payloads
- `tests/<subsystem>/...` for existing legacy suites and subsystem-specific unit-style tests

## Behavioral Tests

Behavioral tests are the default home for blue-team coverage work.

They should:
- start from an exported or stateful boundary
- use the longest real call chain practical before a true system boundary
- assert observable outputs and side effects
- live under `tests/behavioral/<subsystem>/`
- use the `.behavior.test.ts` suffix

Examples:
- `tests/behavioral/entity-graph/pr-review.behavior.test.ts`
- `tests/behavioral/agent-memory/derived-tasks.behavior.test.ts`
- `tests/behavioral/harness-daemon/bridge-gateway.behavior.test.ts`

## Shared Infra

If multiple behavioral files need the same setup, extract it into `tests/_infra/`.

Typical candidates:
- Postgres connection/setup helpers
- schema-per-file helpers
- temp-dir helpers
- random-port allocation
- HTTP server lifecycle helpers
- clock or time-control helpers

Keep reusable inputs and payloads in `tests/_fixtures/`, not `tests/_infra/`.

## Legacy Tests

Older behavioral and integration tests still exist in places like:
- `tests/integration/`
- `tests/entity-graph/*.integration.test.ts`
- `tests/agent-memory/**/*.test.ts`

Those files remain valid, but they are not the placement pattern for new behavioral work.

When adding a new behavioral suite, prefer creating it under `tests/behavioral/`.
Only extend a legacy location when the existing file already owns the boundary and splitting it out would add churn with no benefit.
