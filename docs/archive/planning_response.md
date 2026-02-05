# Planning Response

## Goal

Fix closed-loop system to enforce atomic work decomposition, validate objective specificity, require file change evidence, and improve parallel execution.

## Context

The system has infrastructure for parallel execution, work item decomposition, and planning, but it's not operating as intended. Key issues:

1. **Vague objectives aren't rejected** - Work items like "Continue with the provided answer" have no file paths, no specificity, and cannot be verified
2. **Planning doesn't enforce 5-7 items** - The prompt asks for it, but no validation rejects plans with 0-2 items
3. **Parallel execution exists but isn't being used** - The infrastructure (`dequeueAllReady()`, `Promise.all`) exists, but watchers rarely create independent items
4. **File change evidence is weak** - Many work items claim completion with `filesModified: []`, making audit impossible

The `CLOSED_LOOP_STATE_SUMMARY.md` identifies these gaps as preventing the system from achieving desired closed-loop operation.

## Work Items

### work-1: Add work item objective validation

**Objective**: Add work item objective validation to `packages/decision-watcher/src/watcher-agent.ts` to reject vague objectives

**Delta**: Add validation function that checks objectives meet specificity requirements:
- Must include: what, where (file paths), why
- Reject handoff specs with vague objectives like "Continue with..."
- Reject objectives missing file paths
- Apply validation in `handleHandoffApproval()` before allowing plan

**Target Paths**:
- `packages/decision-watcher/src/watcher-agent.ts`

**Dependencies**: None

### work-2: Enforce 5-7 work item minimum

**Objective**: Enforce 5-7 work item minimum in planning agent objective in `packages/decision-watcher/src/session-init.ts`

**Delta**:
- Update `buildPlanningObjective()` to explicitly require minimum 5 work items and maximum 7
- Add validation in `handleHandoffApproval()` to reject plans that don't meet this requirement
- Provide specific feedback on why plan was rejected

**Target Paths**:
- `packages/decision-watcher/src/session-init.ts`
- `packages/decision-watcher/src/watcher-agent.ts`

**Dependencies**: None

### work-3: Add files modified tracking requirement

**Objective**: Add files modified tracking requirement to agent completion validation in `packages/decision-watcher/src/watcher-agent.ts`

**Delta**:
- In `handleGoalReached()` quality gate, require agents to list files modified
- If `filesModified` array is empty but work item claims completion, fail quality gate
- Add helper function to validate evidence presence
- Log warnings when evidence is missing

**Target Paths**:
- `packages/decision-watcher/src/watcher-agent.ts`

**Dependencies**: None

### work-4: Add parallel execution guidance

**Objective**: Add parallel execution guidance to watcher actions in `packages/decision-watcher/src/watcher-agent.ts`

**Delta**:
- Update objective text in `handleBoundsExceeded()` and `handleCadenceAudit()` to explicitly encourage watchers to prefer INDEPENDENT work items
- Add dependency validation to minimize chains
- Ensure `split` actions produce items with minimal dependencies

**Target Paths**:
- `packages/decision-watcher/src/watcher-agent.ts`

**Dependencies**: None

### work-5: Improve work item creation validation

**Objective**: Improve work item creation to enforce atomic objectives in `packages/orchestrator/src/orchestrator.ts`

**Delta**:
- Add validation in `createWorkItem()` to ensure objective is specific enough
- Reject or flag work items with vague objectives (less than 50 chars, no file path references, generic "continue" language)
- Add metric tracking for objective quality
- Log warnings when objective quality is poor

**Target Paths**:
- `packages/orchestrator/src/orchestrator.ts`

**Dependencies**: work-1

### work-6: Add stall detection

**Objective**: Add stall detection to watcher cadence audit in `packages/decision-watcher/src/watcher-agent.ts`

**Delta**:
- In `handleCadenceAudit()`, detect work items stuck in "in_progress" state for > 10 minutes
- Add timestamp tracking to work log
- When stall detected, create "realign" or "split" action to unblock
- Implement in `getWorkItemLog()` to read work item timestamps

**Target Paths**:
- `packages/decision-watcher/src/watcher-agent.ts`
- `packages/decision-watcher/src/workitem-log.ts`

**Dependencies**: None

## Execution Strategy

These work items can be executed in parallel:
- work-1, work-2, work-3, work-4, work-6 are independent
- work-5 depends on work-1 (validation function needs to exist first)

Expected outcome:
1. Handoff specs with vague objectives will be rejected
2. Plans must have 5-7 atomic work items
3. Agents must report files modified to pass quality gates
4. Watchers will prefer parallel execution when decomposing work
5. Stall detection will prevent hung sessions
6. System moves closer to closed-loop operation as defined in `CLOSED_LOOP_STATE_SUMMARY.md`
