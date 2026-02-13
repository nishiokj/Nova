# GraphD Local-to-User Ownership & Lifecycle
## Full Implementation Spec

**Status:** Proposed  
**Author:** Harness team  
**Scope:** Harness daemon, GraphD integration, model-selection persistence, user-local data lifecycle  
**Last Updated:** 2026-02-12

---

## 1) Executive Summary

We will make GraphD **daemon-owned and local-to-user by default**.

- The harness daemon will use GraphD’s **embedded/direct SQLite access path** for internal reads/writes.
- GraphD HTTP server mode becomes **optional** (off by default), used only when external clients/tools need network access.
- Persistence-critical flows (especially `selected_model` / model-selection preferences) must no longer depend on an external GraphD HTTP process being up.
- A fresh harness distribution will initialize a fresh local SQLite DB automatically.

This removes a class of failures where preferences appear non-sticky due to missing GraphD TCP availability, while keeping container/external deployment as an explicit opt-in mode.

---

## 2) Problem Statement

Observed behavior and architecture review showed:

1. Model-selection persistence is expected to be sticky across sessions.
2. Certain preference paths are currently routed through GraphD-backed metadata storage.
3. When GraphD HTTP is unavailable/intermittent, preference writes/reads can fail or silently miss, creating non-deterministic UX.
4. API keys can still work because provider key storage may use a direct SQLite/local manager path not strictly coupled to GraphD HTTP.

Result: users may still send requests (API keys present) while model-selection persistence appears unreliable.

---

## 3) Goals / Non-Goals

### Goals

- Guarantee sticky persistence for model selection across daemon/TUI restarts.
- Tie data lifecycle to daemon lifecycle by default.
- Keep GraphD as user-local data plane.
- Preserve an external/network mode for advanced/container use.
- Maintain backward compatibility with existing keys/tables.

### Non-Goals

- Full schema redesign of users/auth tables in this phase.
- Multi-tenant cloud-hosted GraphD design.
- Removing GraphD abstractions entirely.

---

## 4) Architecture Decision

## Decision

Adopt **Mode A (default): Embedded/Direct GraphD store access from daemon**.

Support **Mode B (optional): External GraphD HTTP endpoint**.

### Mode A (Default)

- Daemon opens/owns local DB path (user-scoped).
- Daemon reads/writes preferences directly via GraphStore/GraphD library APIs (no HTTP dependency).
- No separate GraphD server startup required.

### Mode B (Optional)

- If explicitly configured, daemon points to GraphD HTTP endpoint.
- Health checks + fail-fast boot warnings.
- Intended for tooling integration, remote access, container composition, or debugging.

---

## 5) Data Ownership & Locality

- GraphD DB location should be user-local (e.g., under harness data dir).
- One DB per harness user profile/environment by default.
- Existing `users` table stays in place for now (no migration in this phase).
- Fresh installs initialize new DB/schema at first daemon startup.

### Recommended paths

- macOS/Linux: `${XDG_DATA_HOME:-~/.local/share}/harness/graphd.sqlite`
- Optional override: `HARNESS_GRAPH_DB_PATH`

---

## 6) Persistence Model Clarification

Model selection should be persisted in user preference metadata (existing canonical keyspace), including modern key(s) such as:

- `user_prefs:model_selections` (canonical)
- Legacy compatibility read support for historical keys if present (e.g., `selected_model`)

### Contract

- On model change in TUI → daemon persists immediately (sync write or acknowledged async write).
- On startup/session hydration → daemon returns persisted value deterministically.
- If write fails, UI receives explicit error and fallback behavior is visible (no silent drop).

---

## 7) Configuration Spec

Introduce explicit storage mode configuration:

```env
# default
HARNESS_GRAPH_MODE=embedded   # values: embedded | http

# embedded mode
HARNESS_GRAPH_DB_PATH=/path/to/graphd.sqlite

# http mode
HARNESS_GRAPHD_URL=http://127.0.0.1:9444
HARNESS_GRAPHD_TIMEOUT_MS=2000
HARNESS_GRAPHD_REQUIRED=true  # fail daemon startup if unreachable
```

### Precedence

1. CLI flags
2. Environment variables
3. Config file defaults

---

## 8) Daemon Lifecycle Changes

## Boot sequence (new default)

1. Resolve graph mode (`embedded` default).
2. Resolve DB path and ensure directory exists.
3. Initialize GraphStore and apply migrations/schema bootstrap.
4. Register persistence repositories/services.
5. Start daemon APIs.

No GraphD HTTP spawn is required in embedded mode.

## Optional HTTP mode boot

1. Resolve URL.
2. Perform health check with retry budget.
3. If `HARNESS_GRAPHD_REQUIRED=true`, fail startup on unhealthy endpoint.
4. Else degrade with explicit warning and mark persistence unavailable.

---

## 9) Interface / Repository Refactor

Create a thin persistence abstraction used by model/user preference services:

- `PreferenceStore` interface
  - `getModelSelections(userId)`
  - `setModelSelections(userId, payload)`
  - `getRawPref(key)` / `setRawPref(key,value)` (optional)

Implementations:

1. `EmbeddedGraphPreferenceStore`
2. `HttpGraphPreferenceStore`

Selection based on `HARNESS_GRAPH_MODE` at composition root.

This isolates transport choice from business logic.

---

## 10) Error Handling & Guarantees

- **Write path:** return ack only after durable write confirmation.
- **Read path:** if unavailable, return structured error (not empty-success).
- **Telemetry/logging:** include mode, db path/url, operation, latency, error code.
- **User-facing UX:** show “Could not persist model preference” when write fails.

---

## 11) Migration Plan

### Phase 0: No schema move

- Keep existing tables, including `users`.
- Keep key formats unchanged.

### Phase 1: Transport decoupling

- Implement `PreferenceStore` interface.
- Wire embedded mode default.
- Keep HTTP mode behind config.

### Phase 2: Compatibility reads

- On hydrate, read canonical key first.
- If absent, check legacy key(s) and backfill canonical key.

### Phase 3: Cleanup

- Add metrics on legacy key hits.
- Remove legacy reads in a later release once hit-rate is near zero.

---

## 12) Testing Plan

### Unit

- PreferenceStore contract tests (shared suite) run against both implementations.
- Serialization/deserialization tests for model selections.
- Legacy key fallback + backfill behavior.

### Integration

- Daemon restart preserves selected model.
- TUI session key changes do not affect persisted selection.
- Embedded mode startup with fresh DB initializes schema.
- HTTP mode startup fails/degrades as configured.

### E2E

1. Set model in TUI.
2. Restart TUI only.
3. Restart daemon.
4. Verify model remains selected.
5. Verify requests still work with provider credentials.

### Failure injection

- Simulate GraphD HTTP outage in http mode.
- Simulate file lock/db unavailable in embedded mode.
- Validate explicit user-visible and log-visible failure semantics.

---

## 13) Distribution & Containerization

### Local distribution

- Bundle harness with no pre-populated DB.
- First run creates fresh DB.
- Optional migration step if prior DB discovered.

### Container deployment (future-safe)

- Embedded mode works with mounted persistent volume.
- HTTP mode supported when GraphD runs as sidecar/service.
- Document both in deployment examples.

---

## 14) Security & Privacy

- DB file permissions should be user-restricted (`0600` where possible).
- Keep credentials and prefs in user-local storage boundary.
- Avoid opening HTTP listener unless explicitly configured.
- If HTTP enabled, default bind to loopback only.

---

## 15) Observability

Add structured events/counters:

- `graph_mode_selected`
- `preference_read_success/failure`
- `preference_write_success/failure`
- `model_selection_hydrate_source` (`canonical`, `legacy`, `default`)
- `graph_http_healthcheck_result`

Include correlation IDs through TUI → daemon persistence calls.

---

## 16) Rollout Plan

1. Ship behind feature flag:
   - `HARNESS_GRAPH_MODE=embedded` (default for canary users)
2. Monitor persistence failure rate and restart-sticky success metric.
3. Promote embedded mode to global default.
4. Keep HTTP mode supported but explicit.

Success criteria:

- Model-selection stickiness > 99.9% across restarts.
- Near-zero silent persistence failures.
- No regression in API key/provider request flow.

---

## 17) Implementation Checklist

- [ ] Add config schema for `HARNESS_GRAPH_MODE`, DB path, HTTP options
- [ ] Implement `PreferenceStore` interface
- [ ] Add embedded + HTTP implementations
- [ ] Update daemon composition root to choose implementation
- [ ] Ensure model-selection service uses `PreferenceStore` only
- [ ] Add explicit write-ack error propagation to TUI
- [ ] Add startup logs showing selected mode and resolved path/url
- [ ] Add compatibility read/backfill for legacy preference key(s)
- [ ] Add unit/integration/e2e test coverage
- [ ] Add docs for local + container deployments

---

## 18) Open Questions

1. Should we eventually move provider credential storage into same abstraction layer for consistency?
2. Do we want optional encryption-at-rest for local DB?
3. Should external HTTP mode require auth even on loopback?

---

## 19) Recommended Immediate Decision

Proceed with:

- **Embedded mode as default**
- **HTTP mode optional**
- **No users-table migration in this phase**
- **Strict persistence error visibility** for model selection

This provides the reliability fix now without schema churn or deployment lock-in.
