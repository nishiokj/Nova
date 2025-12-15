# Production Checklist

This repository mixes a Python multi-process voice agent (entrypoint `run_app.py:1`) and a static Web UI (`front-end/main.js:1`). Use the checklist below before calling the code “production ready.”

## Clean Architecture & Boundaries
- [ ] Publish a current diagram and narrative for the multi-process flow implemented in `src/app/multi_process_app.py:1` (main/audio/STT, agent, TTS, RL worker) so new contributors understand process responsibilities and IPC requirements.
- [ ] Define interface contracts for the EventBus payloads under `src/communication` (schemas, validation helpers, versioning) to prevent silent drift between producers and consumers.
- [ ] Explicitly document the configuration surface that `AppConfig` exposes (`src/app_config.py:1`) and mark any optional fields with defaults plus rationale; add schema validation before boot.
- [ ] Enforce dependency direction: UI → API transport layer → services → harness; add automated checks (e.g., `import-linter`) to ensure modules in `src/services`, `src/harness`, `src/rl`, etc., do not introduce cycles.
- [ ] Capture extension points (custom STT, new harness tools, alternative transports) with interface/ABC definitions and example implementations in `docs/`.

## Maintainability & Code Quality
- [x] Adopt a formatter/linter stack (e.g., `black`, `isort`, `ruff`) and enforce it via pre-commit; hook type checking with `mypy` across `src/` to guard multi-process boundaries.
- [ ] Expand module-level docstrings, especially in `src/services`, `src/communication`, and `src/harness`, to describe threading/process expectations.
- [ ] Track technical debt in issues and budget time for refactors after large feature drops (e.g., porting more logic from `run_multi.py`/`run_single.py` into `src/app`).
- [ ] Ensure logging is centralized (structured JSON option already hinted in `AppConfig.logging`) and that loggers include correlation ids/session ids for tracing.
- [x] Configure CI (GitHub Actions, etc.) to run lint, type check, unit tests, and packaging checks on every push.

- [x] Provide a single onboarding script (`scripts/setup_env.sh` or similar) that installs Python, `pip-tools`, system deps (PortAudio for PyAudio, ffmpeg for `pydub`, GPU drivers), and Node requirements.
- [x] Capture OS-specific notes for audio hardware enumeration and microphone permissions; mention PulseAudio/ALSA setup for Linux and WASAPI/CoreAudio for Windows/macOS.
- [x] Supply sample `.env`/`.env.example` describing OpenAI, Anthropic, or other credentials, and document how these variables are injected into the processes.
- [ ] Offer containerized dev environments (Dev Container or Docker Compose) so contributors without microphones can still run synthetic audio fixtures.
- [ ] Verify `run_app.py` behaves correctly with both `RuntimeMode` options and on CPUs lacking AVX (Whisper fallback).

- [x] Author a root `README.md` that links to architecture docs, setup instructions, entrypoints (`run_app.py:1`, `run_multi.py`, `front-end/package.json:1`), and troubleshooting tips.
- [ ] Fill `docs/` with: config schema reference, event catalog, process lifecycle, deployment cookbook, and how to extend harness tools.
- [ ] Document how to run evaluations (`scripts/run_eval.py`) and RL logging (`scripts/verify_rl_worker.py`), including expected input/output artifacts.
- [ ] Record operational runbooks: rotating logs under `logs/`, cleaning stale audio buffers, resetting RL worker state.
- [ ] Keep changelog/release notes describing backward-incompatible config or protocol changes.

- [x] Convert the Python code into a distributable package (create `pyproject.toml`, expose console scripts like `voice-agent = app.cli:main`, and publish internal wheels).
- [ ] Provide Docker images for backend runtime (CPU and GPU variants) with health checks, plus a stage for the static UI (served by CDN or behind reverse proxy).
- [ ] Automate version stamping for configs and binaries; embed git SHA/build metadata through `AppConfig` logging.
- [ ] Bundle config templates (under `config/`) inside releases and expose overrides via env vars/CLI to avoid editing files in place.
- [ ] For the front-end, add a production build (minification, asset hashing) and describe how it connects to TLS-secured backend endpoints.

## Testing & Quality Assurance
- [ ] Keep `pytest` suites (`pytest.ini:1`, `tests/`) green and categorized (unit/integration/slow); gate merges on coverage threshold for critical modules (audio pipeline, event bus, harness orchestrator).
- [ ] Add end-to-end smoke tests that spin up the multi-process stack with synthetic audio frames and assert event timelines plus RL worker creation.
- [ ] Include contract tests for WebSocket payloads so the UI and backend stay in sync (snapshot JSON fixtures for messages handled in `front-end/main.js:1`).
- [ ] Run UI tests (Cypress/Playwright) to ensure start/stop flows work with mocked backends.
- [ ] Provide load/stress scenarios (background noise, long sessions, multiple concurrent agents) and capture performance budgets (latency/tokens per second).

- [x] Lock Python dependencies using `pip-tools`, `uv`, or Poetry; today `requirements.txt:1` uses loose `>=`/`<=`, so generate hashed lock files per platform/feature set.
- [ ] Mirror production dependencies into `requirements-test.txt:1` where appropriate; avoid mismatches between runtime and test-only packages.
- [ ] Document acceptable upgrade cadence (monthly security updates, quarterly feature bumps) with automated Dependabot/Renovate PRs.
- [ ] For Node, keep `front-end/package-lock.json:1` in sync and audit with `npm audit`; fail CI on high vulnerabilities.
- [ ] Cache large model assets (e.g., Whisper weights) and document checksum verification to detect tampering.

## Security, Secrets & Compliance
- [ ] Enforce secret management (Vault, AWS Secrets Manager, etc.) instead of storing API keys locally; confirm configs checked in `config/*.json` never contain real credentials.
- [ ] Threat-model audio ingestion: validate file formats, limit data retention, and provide PII scrubbing routines before logging.
- [ ] Run SAST/DAST scanners (Bandit, Semgrep, Trivy) in CI for both Python and Node targets.
- [ ] Implement sandboxing or strict allowlists for harness tools that may execute shell commands to prevent privilege escalation.
- [ ] Provide audit logs for agent decisions and RL data, plus retention policies aligning with compliance requirements.

## Runtime Reliability & Observability
- [ ] Harden process supervision: `ProcessManager` should restart crashed workers, emit alerts, and expose metrics about restarts/timeouts.
- [ ] Surface metrics (Prometheus/OpenTelemetry) for audio backlog, STT latency, agent response time, TTS duration, RL worker health, and UI WebSocket errors.
- [ ] Add graceful degradation when STT/TTS engines fail (retry, fallback to text-only), and include user-facing notices through the UI status chips.
- [ ] Ensure `run_app.py:1` handles signals cleanly in containerized environments and sets exit codes that orchestration layers understand.
- [ ] Capture structured errors with stack traces plus correlation IDs, and write alerts for repeated failures (e.g., audio device not found, STT load failure).

## Front-End Integration & UX
- [ ] Replace placeholder WebSocket endpoint in `front-end/main.js:80` with environment-based configuration and document TLS requirements.
- [ ] Define and version JSON message types shared between UI and backend; add validation both client-side and server-side.
- [ ] Provide accessibility review (keyboard navigation, ARIA, captions) plus responsive layout testing for `front-end/index.html`/`styles.css`.
- [ ] Localize user-visible strings and move them into resource files.
- [ ] Automate front-end build/test/deploy steps within the same CI/CD pipeline as the backend.

## Release & Operations
- [ ] Introduce release pipelines that produce signed artifacts (wheels, containers, static assets) and push them to registries.
- [ ] Maintain migration scripts for config format changes and database/storage layers (if/when they exist); include backward compatibility tests.
- [ ] Add feature flags or staged rollout controls to toggle RL worker, router, or experimental models at runtime without redeploying.
- [ ] Document backup/restore and disaster recovery, especially for logs, RL datasets, and evaluation artifacts under `evals/` and `logs/`.
- [ ] Periodically run manual production readiness reviews, updating this checklist with new learnings.

Track completion status in this file or link each item to issues/PRs for full traceability.
