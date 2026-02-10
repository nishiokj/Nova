# Semantic Compiler Integration (MVP)

## Decision

Implement semantic compilation as a dedicated package: `packages/semantic-compiler`.

- Not a skill: skills are instruction bundles, not deterministic compiler/runtime primitives.
- Not a new scheduler: stage execution can map to existing `WorkItem` DAGs and hook flow.
- Plugin boundary is required: verification strategies must be replaceable behind strict contracts.

## Compile Target

Compiler output is a Verification Program (VP), not tests.

- Canonical schema: `vp_version`, `uow_id`, `invariants[]`, `compile_findings[]`
- Invariant output includes:
  - refined intent + operational definition
  - explicit assumptions
  - verification plan steps + evidence requirements
  - compile status (`compiled | needs_user_answer | failed`)

## Existing Primitive Mapping

1. `packages/work` / `protocol.WorkItemSpec`
- Use `vpToWorkItemSpecs()` to project VP to executable DAG nodes.
- Recommended node pattern:
  - optional `review_gate`
  - `verify_INV-*` per invariant
  - terminal `emit_verdict`

2. `packages/orchestrator` hook registry
- Keep orchestration unchanged.
- VP user gate maps naturally to existing `user_input_required` control event.
- Compiler prompts are produced by `buildUserReviewPrompts()`.

3. `packages/decision-watcher`
- Watcher remains the autonomous resolver for PromptUser questions.
- Compiler questions are narrow and operational, so watcher/user approval is meaningful.

4. `packages/control-plane`
- Existing workflow template mechanism can trigger semantic-verify DAGs.
- No new control-plane state model needed for MVP.

5. Evidence + reporting surfaces
- Use deterministic file layout under `evidence/`.
- Emit machine and human outputs:
  - `reports/invariant_results.json`
  - `reports/99_summary.md`

## Stage Flow (state machine)

Persist stage state JSON and resume safely:

- `stage0_parse`
- `stage1_compile_invariants`
- `stage2_user_review_gate`
- `stage3_generate_harness`
- `stage4_run_verification`
- `stage5_emit_verdict`

Implementation: `packages/semantic-compiler/src/stages.ts`.

## End-to-End Hot Path

1. Parse spec + system surface + invariant strings.
2. Compile invariants into VP via strategy plugins.
3. If ambiguity exists, emit targeted gate questions (`needs_user_answer`).
4. On approval, generate harness artifacts + deterministic evidence tree.
5. Execute verification nodes through existing orchestrator/work queue.
6. Emit verdict artifacts and surface through existing cockpit/test-report flows.

## CLI Usage (MVP)

Semantic compiler now exposes a `uow` CLI from `packages/semantic-compiler/src/cli.ts`:

- `uow compile --input <compile-request.json> --out <dir> [--state <state.json>]`
- `uow verify --vp <vp.json> --out <dir> [--run-id <id>] [--seed <number>]`
- `uow report --vp <vp.json> --verdicts <invariant_results.json> --out <dir>`

## MVP Strategy Plugins

`packages/semantic-compiler/src/plugins.ts` ships four strategies:

- `restart_persistence`
- `ui_scenario`
- `api_scenario`
- `trace_checker`

Each strategy contract:

- input: refined invariant context + system surface + repo metadata
- output: steps + assumptions + evidence + verdict rule (+ optional questions)

This keeps future strategy additions isolated from core compile pipeline.
