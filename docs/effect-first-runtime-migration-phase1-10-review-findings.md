# Effect-First Runtime Migration (Phases 1-10) Review Findings

## Findings

### 1) High: Non-retryable LLM errors are reclassified as `RetriesExhaustedError`

- File: `packages/core/llm/src/policies.ts:360`
- File: `packages/core/agent/src/agent.ts:1013`
- Impact: `RateLimitError` and similar failures can lose their original type and be reported as `agent_error` instead of `rate_limit`, breaking termination semantics and operator handling.
- Detail: `resilientCall` wraps all failures in `RetriesExhaustedError`; agent-side classification checks direct `RateLimitError` first, so wrapped errors are miscategorized.

### 2) High: Work-item scoped cancel escalates to full-run cancellation

- File: `packages/core/orchestrator/src/orchestrator.ts:921`
- File: `packages/core/orchestrator/src/orchestrator.ts:1133`
- Impact: `scope: 'work_item'` cancel can terminate the whole run instead of only targeted work items.
- Detail: `cancel` always sets run control state to `cancelling`, and runtime-control terminal handling treats `cancelling/cancelled` as run-terminal.

### 3) High: Pause/cancel processing is delayed until iteration boundaries

- File: `packages/core/orchestrator/src/orchestrator.ts:1205`
- File: `packages/core/orchestrator/src/orchestrator.ts:1321`
- Impact: Runtime control actions can be delayed while long-running work is active.
- Detail: Control queue sync occurs before entering a long await path for in-progress execution; no concurrent control-consumer path interrupts active iteration work promptly.

### 4) Medium: Hook cancellation signal not propagated through harness execution path

- File: `packages/core/orchestrator/src/orchestrator.ts:442`
- File: `packages/core/orchestrator/src/orchestrator.ts:545`
- File: `packages/infra/harness-daemon/src/harness/harness.ts:2500`
- Impact: Hook work may continue despite cancellation requests; phase-9 interruptibility guarantee is weakened.
- Detail: Orchestrator passes an abort signal into effect-hook execution, but harness-side hook runner does not consume or propagate it.

### 5) Medium: `resume` / `continue` keep stale pause/cancellation metadata

- File: `packages/core/orchestrator/src/orchestrator.ts:848`
- File: `packages/core/orchestrator/src/orchestrator.ts:905`
- Impact: Run-control snapshots/events can show `state: running` with stale pause/cancellation metadata.
- Detail: Transition to running state preserves existing metadata fields instead of clearing invalidated state-specific payloads.

## Open Questions / Assumptions

1. Should `cancel` with `scope: 'work_item'` ever transition run state to `cancelling`, or should it only mark targeted work?
2. For effect hooks, is hard cancellation required, or is timeout-only behavior acceptable?

## Validation Notes

- Type/lint checks passed for affected runtime packages (`types`, `runtime`, `llm`, `tools`, `agent`, `orchestrator`, `harness-daemon`).
- Focused tests currently fail broadly; many are still aligned to pre-migration Promise-based LLM interfaces and likely belong to phase 11 test migration work.
