Title: Repository discovery and initial diagnostics

Summary:
This change adds a discovery report and initial recommendations for the repository. No production code was modified. The goal is to capture findings from a quick inspection (README, basic workspace context), record a reproduction path for the discovery steps, and propose prioritized next steps (run local tests, add CI, isolate audio/hardware tests).

Files added:
- REPORT_DISCOVERY.md — contains the discovery report, test attempt notes, and prioritized actions.

Branch:
- fix/minor (created locally during the session to stage these repository hygiene changes)

Reproduction steps (how I discovered the issue):
1. Read README.md and inspected workspace files.
2. Attempted to run tests: `pytest -q || npm test --silent || echo 'no standard test command found'` — this timed out in the environment used for discovery.
3. Collected timestamps and wrote REPORT_DISCOVERY.md summarizing findings and recommended next steps.

Fix performed:
- Added REPORT_DISCOVERY.md with repository layout, detected tooling (Python 3.11, CLI names), quick-start instructions replication, test run attempt, and prioritized recommended actions.
- Created branch `fix/minor` to hold these repository notes and proposed next steps.
- No code logic changes or dependency updates were made.

Verification steps for reviewers:
1. Confirm the new file exists: `git checkout fix/minor && ls -la REPORT_DISCOVERY.md` and open it to review contents.
2. Reproduce the diagnostic test run locally (prepare environment first):
   - `python3.11 -m venv .venv && source .venv/bin/activate`
   - `./scripts/setup_env.sh`
   - `pip install -e .[test]` (or at least `pip install -e .`)
   - `pytest -q` (or `pytest -q -k "not integration"` to skip integration/audio tests)
   - Save output: `pytest | tee test_output.log`
3. (Optional) Run the app via Docker per README: `cp .env.example .env` (edit keys) then `docker-compose up voice-agent`.

Recommended next actions (high priority):
- Run tests locally and capture logs (Action 1 in REPORT_DISCOVERY.md).
- Add CI workflow to reproduce tests in a clean environment (Action 2).
- Refactor tests to mock or mark hardware/audio-dependent tests so CI can run fast unit tests (Action 3).

If you want, I can open a PR with this branch content, create a GitHub Actions workflow, or run further repository discovery (list files, locate entrypoint, or run targeted tests).