# Handoff Plan: Fix Traces Routes Status Codes and Add Tests

## Goal
Fix incorrect HTTP status codes in packages/agent-memory/src/daemon/routes/agent-traces.ts and add minimal test coverage for traces functionality.

## Context
The traces routes incorrectly return 400 Bad Request instead of 404 Not Found when resources don't exist. This violates HTTP semantics:
- GET /traces/:id - returns 400 instead of 404 when trace not found (line 74)
- GET /traces/revision/:revision - returns 400 instead of 404 when not found (line 83)
- PATCH /traces/:id - returns 400 instead of 404 when not found (line 114)
- DELETE /traces/:id - returns 400 instead of 404 when not found (line 127)

All other routes (derived-jobs, derived-tasks, auth) correctly use `notFound()` for missing resources.

The same bug pattern exists in agent-goals.ts and agent-actions.ts but those are out of scope for this objective.

No test coverage exists for traces routes.

## Work Items

### Item 1: Fix HTTP status codes in agent-traces.ts
- **ID**: fix-traces-status-codes
- **Objective**: Fix incorrect HTTP status codes in packages/agent-memory/src/daemon/routes/agent-traces.ts. Import `notFound` from server.ts and change `badRequest()` to `notFound()` on lines 74, 83, 114, and 127 for missing resource errors.
- **Delta**: Fix traces routes to return 404 Not Found instead of 400 Bad Request for missing traces
- **Agent**: execution
- **TargetPaths**: [packages/agent-memory/src/daemon/routes/agent-traces.ts]
- **Dependencies**: []

### Item 2: Add minimal test coverage for traces routes
- **ID**: add-traces-tests
- **Objective**: Add minimal test coverage for traces routes in packages/agent-memory/src/daemon/routes/agent-traces.routes.test.ts. Test GET /traces/:id and GET /traces/revision/:revision endpoints to verify they return 404 when resources don't exist. Use existing test patterns from packages/agent-memory/src/db/db.test.ts for test database setup.
- **Delta**: Add tests for traces routes to verify 404 responses
- **Agent**: execution
- **TargetPaths**: [packages/agent-memory/src/daemon/routes/agent-traces.routes.test.ts]
- **Dependencies**: [fix-traces-status-codes]

## Notes
- Work items are atomic and independent (second depends on first to test the fix)
- Same bug exists in agent-goals.ts and agent-actions.ts but is out of scope
- Keep tests minimal - focus on the fix (404 responses) rather than comprehensive coverage
