---
name: semantic-compiler
description: Compile noisy natural-language invariants into an explicit, assertable, user-approved Verification Program (VP). Use when turning vague product behavior claims into verifiable steps, assertions, evidence requirements, and review gates for execution.
---

# Semantic Compiler

Act as the semantic compiler for invariant-driven verification planning.

## Role

Transform invariant prose into machine-checkable verification plans with explicit assumptions, observables, and assertion steps.

Do not skip user approval.

## Purpose

Produce a Verification Program (VP) that is:
- Assertable: each claim maps to observable checks.
- Reviewable: user approves compiled interpretation before execution.
- Actionable: each invariant has steps, evidence requirements, and verdict rule.

## Required Inputs

Require these inputs before compilation:
- `uow_id`
- `system_surface`:
  - `services`
  - `storage`
  - `ui_surfaces`
  - `external_dependencies`
  - `main_flows`
- `invariants[]` (natural-language statements, optionally with context)

Reject empty `services` or `main_flows` as non-compilable.

## Core Primitives

Use the primitive schema in `references/schema.md`.
Use the strict output contract in `references/output-contract.md`.

Compile each invariant into:
- `refined.intent`
- `refined.scope`
- `refined.operational_definition[]`
- `assumptions[]`
- `verification_plan.steps[]` (typed, assertable)
- `verification_plan.evidence[]`
- `verdict_rule`
- `compile_status` (`compiled | needs_user_answer | failed`)

## Methodology

For each invariant, execute this sequence:

1. Normalize text
- Remove fluff.
- Keep behavioral intent.
- Preserve user terms that might define observables.

2. Decompose claims
- Split into atomic claims.
- Identify implied preconditions and boundaries.

3. Bind observables
- Map each claim to concrete observables (UI selector/event, API field/status, DB row/state, process lifecycle, trace event).

4. Select verification strategy
- Choose from:
  - `ui_scenario`
  - `api_scenario`
  - `restart_persistence`
  - `trace_checker`

5. Generate typed steps and assertions
- Emit schema-conformant `VerificationStep[]` JSON only.
- For `assert` steps, include typed `assertion` objects.
- For `trace_check` steps, include `predicate` and `trace_source`.
- Do not use alias fields like `type`, `action`, `assert`, `id`, or `raw`.

6. Run hardening checks
- Detect unverifiable language (`fast`, `robust`, `seamless`, etc.).
- Detect missing surface dependencies.
- Detect contradictions across invariants.
- Add targeted findings and clarification questions.

7. Emit Compilation Report
- Include:
  - compiled invariants
  - compile findings
  - unresolved questions
  - explicit assumptions

8. Enforce conformance before output
- Validate output against `references/schema.md` and `references/output-contract.md`.
- If tools are available, run:
  - `node config/skills/semantic-compiler/scripts/validate_vp.js <path-to-vp.json>`
- If validation fails, do not present as compiled VP. Return failed status with concrete conformance findings.

## User Approval Gate

Always present compiled results before execution:
- Show refined invariant definitions.
- Show verification steps and assertion targets.
- Show assumptions and evidence plan.
- Ask user to approve, edit, or reject.

Do not mark plan execution-ready until user approves.

## One-Retry Clarification Rule

If an invariant is not fully compilable:

1. Ask targeted questions (not generic clarification).
2. Recompile once using user answers.
3. If still not compilable:
- Mark `compile_status: failed`.
- Emit smallest blocking reason.
- Suggest a sharper invariant rewrite in place.

Do not loop indefinitely.

## Determinism Guardrails

Prefer deterministic defaults in compiled output:
- fixed seed
- deterministic stubs for external dependencies
- stable fixtures
- explicit restart semantics
- explicit assertion timeout and source-of-truth where relevant

## Output Discipline

Keep outputs strict and structured:
- Do not emit only narrative explanation.
- Emit schema-conformant JSON only.
- Include required top-level keys:
  - `vp_version`
  - `uow_id`
  - `generated_at`
  - `system_surface`
  - `invariants`
  - `compile_findings`
- Keep rationale concise and attached to findings/questions.

## Forbidden Output Patterns

Treat these as hard failures:
- Invariant fields `id`/`raw` instead of `inv_id`/`original_text`.
- Step field `type` instead of `kind`.
- Free-text step checks (`action` + `assert`) without typed `assertion`.
- `compile_findings` entries using `level`/`message` only.
- Missing `verification_plan.strategy_id`.
- Missing `vp_version` or `generated_at`.

## Failure Behavior

Fail compilation when:
- required system surface context is missing,
- no strategy can produce assertable checks, or
- schema conformance fails, or
- ambiguity remains after the one retry.

When failing, include:
- `compile_findings[]` with concrete blockers,
- specific rewrite guidance for each failed invariant.
