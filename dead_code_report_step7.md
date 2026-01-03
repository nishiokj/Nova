# Dead-Code Candidates Report (Step 7)

Scope: starting from `src/harness/harness.py` → `AgentHarness.process` → `self.agent.run(...)` (TieredAgent/Agent stack), identify symbols that are not referenced anywhere in the repo and so are candidates for deletion.

## Confirmed Dead-Code Candidates

### 1. `AgentHarness._get_tool_progress_message`

- **Symbol:** `AgentHarness._get_tool_progress_message(self, tool_name: str, step_number: int) -> Optional[str]`
- **File:** `src/harness/harness.py`
- **Type:** Private instance method
- **Rationale:**
  - Not called anywhere within `src/harness/harness.py` (verified by direct inspection).
  - Repo-wide search for `_get_tool_progress_message` finds no references in any `.py` file; the only occurrences are in `tui/logs/health.jsonl` (log output from prior runs, not executable code).
  - Not part of the public harness API surface used by workers, services, or tests.
- **Dynamic-usage risk:** Low. The method is private, never referenced by name in code, and not mentioned in tests. There is no indication it is used via reflection/dynamic lookup.
- **Deletion impact:** Safe to delete. Removing this method will not affect the `AgentHarness.process → agent.run` flow or any known caller.

---

## Notes on Non-Candidates in Harness/Agent Path

Within `src/harness/harness.py` and `src/harness/agent/agent.py`, all other inspected functions, classes, and helpers are either:

- On the critical call path from `AgentHarness.process` to `TieredAgent.run` and `Agent.run`, or
- Part of the public API surface that external modules/tests rely on (e.g., control methods like `stop`, `pause`, `resume_with_answer`, tier selection, session persistence, callback registration).

Because these symbols are referenced in code or tests, or are clearly designed as extension points, they are **not** flagged as dead-code candidates in this step.
