# Value Creation Suggestions - Agent/Watcher Infrastructure

## Identified Opportunities

Based on analysis of the codebase and current state, here are high-value, low-risk improvements for the agent/watcher infrastructure:

### 1. Implement FileDecisionDatabase Persistence (HIGH VALUE, LOW RISK)

**Location:** `packages/decision-watcher/src/db/index.ts`

**Issue:** `FileDecisionDatabase` class has TODO stubs for file persistence - `load()` and `save()` methods are not implemented. This means decisions/preferences don't persist across sessions.

**Impact:** Currently, the watcher must re-populate the decision database each session. With persistence, decisions accumulate over time, improving the watcher's ability to answer questions autonomously.

**Work Required:**
- Implement `load()` method to read JSON file and populate in-memory database
- Implement `save()` method to serialize in-memory database to JSON file
- Call `save()` after `upsert()` and `delete()` operations
- Call `load()` in constructor

**Risk Level:** LOW - Self-contained implementation, doesn't affect running systems, tests can verify correctness

**Commit Message:** `feat: implement file persistence for decision database`

---

### 2. Implement Smarter Category Relevance Detection (MEDIUM VALUE, LOW RISK)

**Location:** `packages/decision-watcher/src/engine/index.ts`

**Issue:** `isCategoryRelevant()` method currently returns `true` for all categories with a TODO comment. This means the watcher can't filter decisions by context relevance.

**Impact:** Implementing category relevance would improve watcher efficiency by reducing the search space and providing more accurate decision matching.

**Work Required:**
- Define category-to-context mappings (e.g., "architecture" decisions are relevant to agent.ts, "testing" to agent.test.ts)
- Implement keyword-based or path-based relevance checking
- Consider using the `appliesTo` field from Decision type

**Risk Level:** LOW-MEDIUM - Changes to core logic but current behavior is always true, so adding smarter logic is additive

**Commit Message:** `feat: implement category relevance detection in decision engine`

---

### 3. Create Dead Jobs Cleanup Script (MEDIUM VALUE, LOW RISK)

**Location:** `scripts/cleanup-dead-jobs.ts` (new file)

**Issue:** `packages/agent-memory/data/dead-jobs/` contains 70+ JSON files (400-500 bytes each). These accumulate over time and should be cleaned up.

**Impact:** Regular cleanup would prevent disk bloat and improve performance of directory operations.

**Work Required:**
- Create script that:
  - Lists all dead job files with timestamps
  - Prompts for retention policy (e.g., keep last N days, or keep last N files)
  - Deletes files matching policy
- Add error handling and dry-run mode

**Risk Level:** LOW - Read-only for production data, only touches dead-jobs directory

**Commit Message:** `feat: add dead jobs cleanup script`

---

### 4. Initialize Jimmy Observations Log (LOW VALUE, VERY LOW RISK)

**Location:** `data/jimmy-observations.md` (new file)

**Issue:** The personal-assistant skill mentions logging observations to this file, but it doesn't exist yet. Jimmy has nowhere to log errors, bugs, DX issues, and slop encountered while using the system.

**Impact:** Provides a backlog of improvements for the user to review and implement. This is how Jimmy can report issues encountered during operations.

**Work Required:**
- Create the file with a header and initial structure
- Add instructions for the format (as documented in personal-assistant SKILL.md)

**Risk Level:** VERY LOW - Purely additive file creation

**Commit Message:** `chore: initialize jimmy-observations.md for improvement backlog`

---

### 5. Document Deleted Watcher File (LOW VALUE, NO RISK)

**Location:** Documentation files, potential import references

**Issue:** Git shows `D packages/decision-watcher/src/watcher/index.ts` (deleted). May need to update references or document why it was removed.

**Impact:** Clarity for future developers on codebase evolution.

**Work Required:**
- Search for any imports/references to `packages/decision-watcher/src/watcher/index.ts`
- If found, update them to point to the correct location
- Add a brief note in README.md or CHANGES.md about the file deletion

**Risk Level:** NONE - Documentation only

**Commit Message:** `docs: document deletion of watcher/index.ts`

---

## Recommended Execution Order

1. **Jimmy Observations Log** (trivial, quick win)
2. **FileDecisionDatabase Persistence** (high impact, core feature)
3. **Dead Jobs Cleanup** (utility, independent)
4. **Category Relevance Detection** (performance improvement)
5. **Documentation** (cleanup)

Items 1-3 can be done in parallel. Items 4-5 have mild dependencies (4 requires understanding the decision matching logic).

## Estimated Total Value

- **High impact:** FileDecisionDatabase persistence (enables accumulated decision knowledge)
- **Medium impact:** Category relevance, dead jobs cleanup
- **Low impact:** Documentation, observations log

All items are low-risk and align with the principle of minimal intervention - each provides clear benefit without destabilizing the system.
