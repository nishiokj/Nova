# Behavioral Tests

This is the canonical home for new behavioral tests.

Layout:
- `tests/behavioral/<subsystem>/...`

Examples:
- `tests/behavioral/entity-graph/pr-review.behavior.test.ts`
- `tests/behavioral/agent-memory/derived-tasks.behavior.test.ts`
- `tests/behavioral/harness-daemon/bridge-gateway.behavior.test.ts`

Behavioral tests should:
- begin from an exported or stateful boundary
- use real internal collaborators
- touch real resources where practical
- assert outputs, errors, and persisted side effects

Existing behavioral tests outside this directory are legacy placement.
Do not use legacy placement as the default for new suites.
