# Phase 0 Invariants Ledger

## Phase Metadata

- phase: `phase0`
- owner: `TBD`
- status: `in_progress`
- commit_sha: `TBD`
- ci_run_url: `TBD`
- updated_at_utc: `TBD`

## North Star UX/DX State

1. A user can declare `benchmark: bench_v0` without wiring dataset/adapter/policy internals.
2. A container command can invoke `rex` by name, without `/opt/agent/bin/...`.
3. Authoring uses short artifact/config references, with runner-resolved canonical paths.
4. Resolved manifests are deterministic and include pinned artifact digests.

## Invariant Table

| ID | Status | Test | Evidence | Reviewer | Notes |
|---|---|---|---|---|---|
| P0-I01 | PENDING | tests/integration/bench_registry_resolution | docs/evidence/dx/phase0/artifacts/p0_i01_registry_resolution.md | TBD |  |
| P0-I02 | PENDING | tests/preflight/legacy_field_rejection | docs/evidence/dx/phase0/artifacts/p0_i02_preflight_errors.md | TBD |  |
| P0-I03 | PENDING | tests/integration/container_path_ergonomics | docs/evidence/dx/phase0/artifacts/p0_i03_rex_pathless_invocation.log | TBD |  |
| P0-I04 | PENDING | tests/integration/artifact_digest_enforcement | docs/evidence/dx/phase0/artifacts/p0_i04_artifact_digest_checks.md | TBD |  |
| P0-I05 | PENDING | tests/golden/deterministic_defaults_resolution | docs/evidence/dx/phase0/artifacts/p0_i05_resolved_manifest_golden.json | TBD |  |
| P0-I06 | PENDING | tests/docs/canonical_contract_lint | docs/evidence/dx/phase0/artifacts/p0_i06_doc_lint_report.txt | TBD |  |
