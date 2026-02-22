# Semantic Compiler Implementation Specification

## 0) Objective

Align `packages/plugins/semantic-compiler` with the declared contract in:
- `config/skills/semantic-compiler/SKILL.md`
- `config/skills/semantic-compiler/references/schema.md`
- `config/skills/semantic-compiler/references/output-contract.md`

and close the runtime/contract gap discovered in implementation review.

Primary goals:
1. Produce **schema-valid** Verification Programs (VPs) by default.
2. Enforce the `needs_user_answer`/one-retry path before marking execution-ready.
3. Raise the practical quality of strategy inference, operationalization, and assertions.
4. Keep stage machine and CLI behavior deterministic and auditable.

---

## 1) Current-state summary (delta vs spec)

### Strong alignment already in place
- Stage order/state machine exists (`stage0_parse` → `stage5_emit_verdict`).
- Core compile pipeline exists and creates findings, invariant questions, statuses.
- CLI, harness, evidence, and report generation are wired.
- Strategy plugins for required IDs exist.

### Gaps to close (contract-impacting)
- **Type/schema drift**: `types.ts` does not match reference schema
  - Missing typed assertions on `assert` steps.
  - Missing `schema_nonconformant` finding code.
  - `CompileFinding.code` set not aligned (`agent_*` extras are not spec'd).
  - `VerificationStep` lacks `assertion`/`predicate`/`trace_source` fields.
- **No hard schema validation** against `schema.md`/`output-contract.md`.
- **No one-retry resolution loop** implemented:
  - strategy misses do not generate clarifying questions, they immediately fail.
- **Targeted clarification quality**:
  - strategy misses currently return `strategy_unavailable` with no reformulation guidance.
- **Strategy matching quality**:
  - UI/API/trace heuristics are narrow and often miss obvious invariants (e.g. cart/product flows).
- **Assertions are not typed in strategy outputs** (all steps are string specs only).
- **Work item gating semantics** are implicit:
  - verifier tasks are still emitted alongside unresolved questions.
- **Evidence/report output** exists but is light on execution metadata for downstream consumers.

---

## 2) Target implementation architecture

### 2.1 Canonical data contracts (enforced)
- Update `packages/plugins/semantic-compiler/src/types.ts` to mirror `references/schema.md`:
  - `VerificationStep` union with assertion variants:
    - `kind: assert` must include `assertion`.
    - `kind: trace_check` must include `predicate` + `trace_source`.
  - Add missing `CompileFinding.code: 'schema_nonconformant'`.
  - Keep optional `CompilationReport` and `ApprovalDecision` types exported in `types.ts`.
- Introduce a runtime validator module (e.g. `validator.ts`):
  - Validate VP + each invariant + each finding + each step.
  - Returns canonical findings with `code='schema_nonconformant'` and stable `finding_id`.

### 2.2 Compile pipeline as two-phase with one retry
- Add explicit compile attempt state:
  - `compileVerificationProgram(request, options)` (existing) remains single-pass rule generator.
  - New internal `compileAttempt({ ... , context })` + `applyApprovalDecision()` helper.
  - New API: `compileVerificationProgramWithRetry(request, decision?)`.
- Transition semantics:
  1. **Pass 1**: produce invariant compiles + questions.
  2. If any invariant has questions → return with `needs_user_answer`.
  3. **Pass 2** (when decision provided)
     - Apply `ApprovalDecision.edited_invariants` before recompilation.
     - Apply `ApprovalDecision.answers` by injecting structured clarifications into invariant context.
     - Re-run compile.
     - If invariant still unresolved after Pass 2 → `failed` with smallest concrete blocker and rewrite suggestion.
- Remove immediate hard-fail when strategy unavailable if clarifications can make it compilable:
  - On initial miss, generate `needs_user_answer` + reformulation prompt (`clarify behavior boundary`, `define measurable assertions`, etc.).

### 2.3 Strategy plugins and typed output
- Keep plugin contract unchanged (`supports` + `compile`) but improve internals:
  - add shared `emitAssertStep` helper requiring assertion objects.
  - each strategy compile always emits:
    - deterministic seed/stub metadata where applicable,
    - at least one `assert` step with typed assertion,
    - typed `trace_check` with predicate when using event semantics,
    - non-empty evidence list.
- Strategy selection heuristics
  - Expand keyword coverage and regexes:
    - `ui_scenario`: `cart`, `product`, `page`, `button`, `form`, `modal`, `click`, `navigate`, etc.
    - `api_scenario`: `HTTP verbs`, `/api/`, `endpoint`, `status`, `status code`, `response`, `body`, `code`.
    - `restart_persistence`: `restart`, `reboot`, `resume`, `session restored`, `signed in`, `re-auth`.
    - `trace_checker`: temporal words (`never`, `always`, `precede`, `before`, `after`, `event`).
  - Add tie-breaker preference:
    - strongest explicit marker first (`api verb+path`, `trace/event ordering`, `restart phrase`).

### 2.4 Question quality and rewrite guidance
- Extend `targetedQuestions(...)` with invariant-specific taxonomy:
  - boundary questions (scope, path conditions, failure policy),
  - semantic definitions (`signed in`, `accessible`, `error`, `success`, `timeout`),
  - evidence/fixture availability.
- Ensure each question has meaningful `rationale` and at least 2 actionable options.
- If an invariant fails twice, replace long list of questions with exactly one concise blocking rewrite suggestion.

### 2.5 Approval gate and DAG generation
- `vpToWorkItemSpecs` behavior:
  - If any invariant `compile_status !== 'compiled'` **do not emit** that invariant’s verifier node.
  - If any invariant `needs_user_answer`, emit `review_gate` and make verifier tasks depend on it.
  - Do not include `emit_verdict` unless at least one verifiable invariant exists and all non-failed invariants are approved.
- `buildUserReviewPrompts` to include invariant context plus rationale and invariant id in deterministic sorted order.

### 2.6 CLI/state machine hardening
- `cli.ts`:
  - For `compile`, persist state with `artifacts.vp_path`, `findings` and, when needed, `pending_questions`.
  - Exit non-zero when schema/contract validation fails.
- Stage transitions:
  - On compile fail: `markStageFailed`.
  - On pending questions: set `markStageWaitingUser` and keep stage as `stage2_user_review_gate`.
  - Add `resume` path on `state` input for `verify` if user-approved questions were recorded.

### 2.7 Evidence/report quality (non-breaking)
- Keep existing evidence/report outputs, add
  - deterministic invariant folder naming `inv_<inv_id_lc>`,
  - invariant-level run metadata includes compile status, strategy id, questions count, evidence list,
  - report summary section includes failed/needs-user-answer counts.

---

## 3) Concrete changes by file

### `packages/plugins/semantic-compiler/src/types.ts`
- Align interfaces/enums with schema.md.
- Add `Assertion` union type.
- Make `VerificationStep` discriminated union.
- Add `schema_nonconformant` finding code.
- Export `CompileAttemptInput`, `CompilationReport`, `ApprovalDecision`.

### `packages/plugins/semantic-compiler/src/compiler.ts`
- Add normalization and schema validation integration.
- Add `compileWithInput({request, previousFindings?, attempt})` helper.
- On strategy miss, emit user-facing clarifying question set instead of immediate failed state.
- Respect one-retry policy using `ApprovalDecision`.
- Convert duplicate/global findings to canonical IDs in deterministic pass.
- Ensure each invariant includes `refined/assumptions/plan/verdict_rule` even on failed status.

### `packages/plugins/semantic-compiler/src/plugins.ts`
- Expand strategy token coverage and tie-break scoring.
- Emit typed `VerificationStep` objects with assertion payloads.
- Ensure each strategy returns `evidence` that ties to execution artifacts.

### `packages/plugins/semantic-compiler/src/adapters.ts`
- Keep stable IDs for review + verify nodes.
- Gate verifier tasks by `compile_status === 'compiled'` when stage requires execution-ready.
- Add deterministic ordering of prompts/specs for reproducibility.

### `packages/plugins/semantic-compiler/src/stages.ts`
- Add helpers to persist `artifacts` and `pending_questions` transitions explicitly.
- Optional: `markStageWaitingForApproval` alias for readability if needed.

### `packages/plugins/semantic-compiler/src/harness.ts`
- Ensure generated specs align with typed assertions from plans (e.g., render structured assertions where supported).
- Add invariant-level skip behavior for non-compilable statuses.

### `packages/plugins/semantic-compiler/src/evidence.ts`
- Include invariant compile status and questions in run.json.
- Include manifest references to trace and outputs expected by `emitVerdictArtifacts`.

### `packages/plugins/semantic-compiler/src/report.ts`
- Add explicit sections for unresolved questions / compile blockers in summary.
- Add invariant status counts from VP (compiled / needs_user_answer / failed).

### `packages/plugins/semantic-compiler/src/cli.ts`
- Add input validation (schema + file existence checks).
- Add `--resume-state`/`--apply-answers` option for retry flow (optional in v1).
- Return structured machine-readable summary JSON to stdout when `--json` set.

---

## 4) Acceptance Criteria

- **Contract compliance**
  - Every emitted VP includes required top-level keys.
  - No use of forbidden alias fields (`id`, `raw`, `type`, `action`, `assert` in steps).
  - Any assertion step includes typed `assertion`.
  - Any `trace_check` step includes `predicate` + `trace_source`.

- **One-retry behavior**
  - Invariant ambiguous + first pass unresolved ⇒ `needs_user_answer` with targeted questions.
  - On retry with answer(s), invariant either becomes `compiled` or `failed` with concrete blocker.
  - Never infinite re-asks.

- **Strategy quality**
  - Known realistic cases in `ability.test.ts` pass under expected strategy IDs (including cart/checkout/product cases).

- **Execution readiness semantics**
  - `vpToWorkItemSpecs` does not emit verification/verdict tasks for unresolved or failed invariants.
  - Review gate appears whenever questions exist.

- **Observability**
  - CLI writes deterministic state and evidence layout for every run.

---

## 5) Test plan

### Update existing tests
- `tests/semantic-compiler/compiler.test.ts`
  - add schema validation assertions.
  - add explicit contract failure test for alias fields.
- `tests/semantic-compiler/ability.test.ts`
  - convert known-gap tests to expected fixed behavior:
    - strategy misses now generate clarifying questions + retry path.
    - e-commerce checkout scenario recognized as `ui_scenario`.
  - add `schema_nonconformant` and one-retry tests.
- `tests/semantic-compiler/io.test.ts`
  - assert compile artifacts include validation markers and question-aware DAG behavior.

### Add tests
- `tests/semantic-compiler/retry.test.ts`
  - Pass one: needs_user_answer then retry compiled.
  - Pass two: retry remains unresolved -> failed with rewrite hint.
- `tests/semantic-compiler/schema.test.ts`
  - roundtrip validate using canonical `schema.md` examples.

---

## 6) Rollout Plan

- **Phase 1 (2 days)**: type/schema alignment + schema validator + assert step typing.
- **Phase 2 (2 days)**: retry loop + improved strategy heuristics + targeted question quality.
- **Phase 3 (1 day)**: CLI/state/evidence gating and tests stabilization.
- **Phase 4 (1 day)**: cleanup, docs refresh (`SKILL.md` examples + integration spec), remove known-gap comments.

Success signal: all semantic-compiler tests green + ability suite no known-gap expectations remain unresolved.

---

## 7) Rollback strategy

- All public entry points retain backward-compatible defaults.
- If any phase causes regressions in existing consumers, disable `strict` retry path behind `COMPILE_RETRY=1` toggle and default to current behavior.
- Keep old behavior in parallel behind feature flags during roll-forward.
