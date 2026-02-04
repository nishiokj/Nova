# TODO: Closed-Loop System Improvements

## Status: 🔴 NEEDS WORK

**Current State Assessment (2026-01-29)**

The system is **NOT** in the desired closed-loop state described below. While the foundational structure exists, significant gaps must be addressed before the system can be considered "closed loop" in the robust, high-fidelity sense.

---

## Desired State: What "Closed Loop" Means

### 1. ROBUST .watcher Information

**Required per session:**
- `work-log.jsonl`: Complete audit trail of all activities (session_start, notes, workitem_created, workitem_status, workitem_complete, files modified)
- `decisions.jsonl`: Every watcher decision with trigger, action, rationale, execution metrics (toolCallsMade, filesModified, durationMs, contextPercentUsed)
- `salience.md`: Session goal, operating principles, and detailed session notes (timestamped, linked to work IDs)
- `handoff-spec.json` (if planning phase): Structured plan with work items, dependencies, target paths
- `workitems/` directory: Individual work item logs (`.jsonl` or `.md`) per work item

**Work Item Log Requirements:**
- `init` record with full objective, agent type, timestamp
- `status` transitions (in_progress → completed)
- `complete` record with:
  - Summary of what was done
  - Files modified (with line-level detail if possible)
  - Metrics (tool calls, duration, context used)
  - Evidence of completion

**Evidence Robustness:**
- Every work item must log specific file changes (not just "filesModified": [])
- Every action must have reasoning trace (why this tool, why this approach)
- Every file change should be attributable to a work item and commit

---

### 2. MANY WorkItems: Atomic Decomposition

**Current State:** Sessions average 0-2 work items. Many have none.

**Desired State:**
- Plans are decomposed into **5-7 atomic work items** minimum
- Large goals are split before execution (max 5-7 items per phase)
- Each work item = one git commit
- Each work item has: clear objective, target paths, delta description, dependencies

**Example of Good WorkItem (from handoff-spec.json):**
```json
{
  "id": "work-1",
  "objective": "Create HTTP API routes for agent-goals and agent-actions in packages/agent-memory/src/daemon/routes/",
  "delta": "Add new route files agent-goals.ts and agent-actions.ts following the pattern from decisions.ts. Include CRUD endpoints: GET/POST /goals, GET /goals/:id, PATCH /goals/:id, DELETE /goals/:id, GET /goals/active, GET /goals/due-soon, POST /goals/:id/complete.",
  "targetPaths": [
    "packages/agent-memory/src/daemon/routes/agent-goals.ts",
    "packages/agent-memory/src/daemon/routes/agent-actions.ts",
    "packages/agent-memory/src/daemon/routes/index.ts"
  ]
}
```

**Examples of Bad WorkItems (seen in current state):**
- "Continue with the provided answer" → No objective, no target paths, unmeasurable
- "What the fuck is that. That can't be serious..." → Unprofessional, no actionable content
- "suggest the minimal patch spec for this 'continue' issue" → Vague, no target paths

---

### 3. Hyper-Efficient Agents

**Required Agent Behavior:**
- **Specific objectives**: Every work item has concrete deliverables with file paths
- **Minimal exploration**: Use Glob/Grep/Read strategically, not blindly
- **Batch tool calls**: Don't read files one-by-one; batch related reads
- **Evidence-based completion**: Work is "done" when files are modified, not when "done" is declared
- **No thrashing**: If stuck, ask via PromptUser; don't spin
- **Progress over motion**: If a tool fails twice, diagnose and move on

**Evidence of Efficiency:**
- Tool call counts should correlate with task complexity
- Files modified should match objective promises
- Duration should be reasonable for task scope
- Context usage should be efficient (< 30% preferred)

---

### 4. Effective Watcher: Keeping on Track

**Watcher Responsibilities:**

**A. Cadence Audits (every 2-3 minutes)**
- Check: Is agent making progress?
- Check: Are work items being created?
- Check: Is there drift or thrashing?
- Actions: `continue`, `split`, `realign`, `escalate`

**B. Work Item Creation**
- When planning completes, **split** into execution work items
- Ensure work items are atomic (one commit each)
- Ensure work items are parallelizable (minimize dependencies)
- Ensure work items are bounded (5-7 items per phase)

**C. Answering Questions**
- PromptUser questions should be answered with specific guidance
- Answers should include rationale (why this choice)
- Answers should be actionable (next steps clear)

**D. Quality Gates**
- Before accepting "done", verify: files modified? evidence provided?
- Before handoff, verify: handoffSpec is a valid structured object? work items are atomic?
- Before completion, verify: goal was achieved? all dependent work done?

**E. Parallelization**
- Identify independent work items
- Dispatch multiple agents concurrently
- Track dependencies correctly

---

## Gaps Identified

### Gap 1: Minimal Work Items
- **Problem**: Many sessions have 0-2 work items
- **Impact**: Work is not atomic, hard to review, hard to parallelize
- **Fix**: Enforce 5-7 work item minimum for execution phases

### Gap 2: Vague Objectives
- **Problem**: Work items like "Continue with the provided answer" have no substance
- **Impact**: No clear deliverables, impossible to verify completion
- **Fix**: Require objective to include: what, where (file paths), why

### Gap 3: Incomplete Logs
- **Problem**: Many work items show "filesModified": [] despite claiming completion
- **Impact**: No audit trail, can't verify what was done
- **Fix**: Require files modified list with every work item completion

### Gap 4: Stalled Sessions
- **Problem**: Some sessions have work items stuck in "in_progress" indefinitely
- **Impact**: Work never completes, resources wasted
- **Fix**: Watcher must detect stalls and realign or escalate

### Gap 5: Sparse Documentation
- **Problem**: Some sessions have 1-line work logs, empty decisions
- **Impact**: No traceability, impossible to audit
- **Fix**: Every session must have complete work-log.jsonl, decisions.jsonl, salience.md

### Gap 6: No Parallelization
- **Problem**: All work appears serial; no evidence of concurrent agents
- **Impact**: Slower execution than possible
- **Fix**: Identify independent work items and dispatch concurrently

---

## Action Items

### Immediate (This Session)

1. **Audit All Sessions**
   - [ ] For each session in .watcher/2026-01-29/, verify:
     - [ ] work-log.jsonl is complete (session_start + activities)
     - [ ] decisions.jsonl has entries for each watcher decision
     - [ ] salience.md has operating principles and notes
     - [ ] workitems/ directory has logs for each work item
   - [ ] Flag sessions with incomplete data for remediation

2. **Strengthen WorkItem Objectives**
   - [ ] Write a specification for work item objective format
   - [ ] Template must include: what, where (file paths), why, success criteria
   - [ ] Add validation to reject vague objectives

3. **Enforce WorkItem Decomposition**
   - [ ] For planning sessions: require minimum 5 work items for execution
   - [ ] For large goals: require "split first" before execution
   - [ ] Validate handoffSpec has atomic, independent items

4. **Improve Watcher Cadence**
   - [ ] Increase cadence audit frequency if stalls detected
   - [ ] Add "stall detection" to identify work items in_progress > 10 minutes
   - [ ] Add "drift detection" to compare agent activity vs. goal

5. **Require File Change Evidence**
   - [ ] Reject "done" without files modified list
   - [ ] Require specific file changes (not just "filesModified": [])
   - [ ] Log line-level changes where possible

### Short-Term (Next Week)

6. **Implement Parallel Execution**
   - [ ] Identify independent work items in handoffSpec
   - [ ] Dispatch multiple agents concurrently
   - [ ] Track execution state across parallel agents

7. **Add Quality Metrics**
   - [ ] Track work item completion rate
   - [ ] Track file modification accuracy (claimed vs. actual)
   - [ ] Track agent efficiency (tool calls per task)
   - [ ] Track watcher effectiveness (cadence audit outcomes)

8. **Standardize Documentation**
   - [ ] Template for work-log.jsonl entries
   - [ ] Template for decisions.jsonl entries
   - [ ] Template for salience.md structure
   - [ ] Template for work item logs

9. **Add Feedback Loops**
   - [ ] Weekly audit of .watcher data quality
   - [ ] Metrics dashboard for system health
   - [ ] Automated alerts for pattern violations

### Long-Term (Next Month)

10. **Self-Improving System**
    - [ ] Analyze patterns in successful work items
    - [ ] Improve objective generation based on successful patterns
    - [ ] Adjust watcher cadence based on agent performance
    - [ ] Auto-decompose work based on task type

11. **Knowledge Base**
    - [ ] Extract lessons learned from work logs
    - [ ] Build pattern library for common tasks
    - [ ] Document anti-patterns to avoid

12. **Benchmark Suite**
    - [ ] Define success metrics for closed-loop operation
    - [ ] Automated tests for work item quality
    - [ ] Automated tests for watcher effectiveness
    - [ ] Continuous improvement tracking

---

## Success Criteria

The system is "closed loop" when:

- ✅ **Every session** has complete work-log.jsonl, decisions.jsonl, salience.md
- ✅ **Every work item** has specific objective with file paths
- ✅ **Every work item** has files modified list upon completion
- ✅ **Every planning session** produces 5-7 atomic work items
- ✅ **Every execution session** parallelizes independent work
- ✅ **Watcher cadence** detects stalls and drift within 5 minutes
- ✅ **Agents are efficient**: reasonable tool calls, relevant file changes
- ✅ **Quality gates**: verify completion before accepting "done"

---

## Notes

- See `closed-loop-principles.md` for the theoretical foundation
- The `handoff-spec.json` from session `tui_1769642885412_gyyamc` is a **good example** of proper work item decomposition
- The work-log.jsonl from that same session shows **good execution tracking**
- Use these as templates for system-wide improvements

---

## Open Questions

1. What should the maximum number of parallel agents be? (resource constraints)
2. How to handle work items that partially fail? (retry policy)
3. How to prioritize work items across sessions? (global queue vs. per-session)
4. What metrics should trigger system-wide audits? (health thresholds)

---

**Last Updated**: 2026-01-29
**Status**: 🔴 NEEDS WORK - Multiple gaps identified, action items pending
**Next Review**: After implementing Immediate action items
