# Behavioral Test Infra

Put shared behavioral-test infrastructure here.

Use this directory for reusable helpers that manage real resources or test harness setup, such as:
- database bootstrap and cleanup
- schema-per-file helpers
- temp directory lifecycle
- random-port reservation
- test server startup and shutdown
- common env var setup and restore

Do not put boundary-specific fixtures here.
Put reusable payloads, sample responses, and static fixture data in `tests/_fixtures/`.

If a setup pattern appears in more than one behavioral test file, extract it here.
