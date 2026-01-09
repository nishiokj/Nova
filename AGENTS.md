# Agent Instructions

These instructions apply to the entire repository.

## Architecture & Separation of Concerns
- Preserve the existing architecture and separations of concern.
- Do not instantiate ad-hoc loggers inside modules; use the established logging entry points.
- Keep data flow and control flow boundaries intact; do not merge or blur layers.
- Before editing, identify which layer (data, control, interface) the change belongs to and keep it there.
- If a change requires crossing layers, stop and reconsider; prefer adapting the correct layer instead.

## No Dead Code or Compatibility Slop
- Do not leave placeholder code, “ralph wiggums,” or temporary hacks.
- Remove dead code introduced during a change; do not leave unused paths or scaffolding.
- Avoid backwards-compatibility shims unless explicitly required by the task.

## Minimum Patch Discipline
- Apply the smallest correct change that fixes the root cause.
- Do not introduce new code paths, abstractions, or utilities without necessity.
- Prefer modifying existing functions/structures over adding new ones.
- Reason about the resulting system state before implementing the patch.

## Precision & Concision
- Be precise and concise in edits and documentation updates.
- Use clear, minimal naming and avoid verbose or duplicative structures.

## Root-Cause Focus
- Diagnose from first principles and validate assumptions against the codebase.
- Fix root causes; do not apply symptom-only workarounds.
- Treat architecture, control theory, modularity, and efficiency as primary constraints.

