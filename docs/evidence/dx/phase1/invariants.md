# Phase 1 Invariants Ledger

## Phase Metadata

- phase: `phase1`
- owner: `TBD`
- status: `pending_phase0`
- commit_sha: `TBD`
- ci_run_url: `TBD`
- updated_at_utc: `TBD`

## North Star UX/DX State

1. Agent commands express intent only; bindings are projected structurally, not templated.
2. Workspace file injection is declarative (`workspace_patches`), no shell `cp` preambles.
3. Preflight catches missing bindings/invalid patch paths before any run starts.
4. Canonical docs show only the minimal opinionated path.

## Invariant Table

| ID | Status | Test | Evidence | Reviewer | Notes |
|---|---|---|---|---|---|
| P1-I01 | PENDING | tests/preflight/bindings_missing_keys | docs/evidence/dx/phase1/artifacts/p1_i01_missing_bindings.md | TBD |  |
| P1-I02 | PENDING | tests/unit/bindings_to_args_ordering | docs/evidence/dx/phase1/artifacts/p1_i02_argv_order.md | TBD |  |
| P1-I03 | PENDING | tests/unit/bindings_argv_token_integrity | docs/evidence/dx/phase1/artifacts/p1_i03_argv_integrity.md | TBD |  |
| P1-I04 | PENDING | tests/preflight/workspace_patch_path_rejection | docs/evidence/dx/phase1/artifacts/p1_i04_patch_path_rejection.md | TBD |  |
| P1-I05 | PENDING | tests/integration/workspace_patch_ordering_and_overwrite | docs/evidence/dx/phase1/artifacts/p1_i05_patch_order_and_overwrite.md | TBD |  |
| P1-I06 | PENDING | tests/docs/no_cp_hacks_in_canonical_examples | docs/evidence/dx/phase1/artifacts/p1_i06_no_cp_hacks_report.txt | TBD |  |
