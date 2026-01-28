/**
 * Session Init
 *
 * Bootstrap an async watcher session: write salience file, create decision log,
 * create the watcher stopHook, and produce the initial planning work item.
 */

import type { StopHookResult, StopHookContext } from 'agent';
import type { WatcherAction } from './types.js';
import type { DecisionLog } from './decision-log.js';
import type { WorkLog } from './work-log.js';
import { writeSalienceFile, salienceFilePath } from './salience.js';
import { createDecisionLog } from './decision-log.js';
import { createWorkLog } from './work-log.js';
import { createWatcherStopHook } from './watcher-agent.js';

// ============================================
// TYPES
// ============================================

export interface AsyncSessionConfig {
  sessionId: string;
  goal: string;
  workingDir: string;
  /** Runs the watcher agent with an objective string. */
  runAgent: (objective: string) => Promise<WatcherAction>;
  /** Called when watcher produces work items via split/create. */
  onCreateWorkItems?: (items: WatcherAction['workItems']) => void;
  /** Operating principles to include in the salience file. */
  principles?: string[];
}

export interface AsyncSessionResult {
  salienceFilePath: string;
  decisionLogPath: string;
  workLogPath: string;
  decisionLog: DecisionLog;
  workLog: WorkLog;
  stopHook: (ctx: StopHookContext) => Promise<StopHookResult>;
  planningObjective: string;
}

// ============================================
// SESSION INIT
// ============================================

/**
 * Initialize an async watcher session.
 *
 * Flow:
 * 1. Write salience file (goal, mode=async, principles)
 * 2. Create empty decision log
 * 3. Create watcher stopHook
 * 4. Produce the planning objective string
 *
 * The caller (harness) uses the returned stopHook in `OrchestratorRuntime`
 * and enqueues a work item with the planning objective.
 */
export async function initAsyncSession(config: AsyncSessionConfig): Promise<AsyncSessionResult> {
  // 1. Write salience file
  const salience = await writeSalienceFile(config.workingDir, {
    sessionId: config.sessionId,
    goal: config.goal,
    mode: 'async',
    principles: config.principles,
  });

  // 2. Create decision log
  const decisionLog = await createDecisionLog(config.workingDir, config.sessionId);

  // 3. Create work log
  const workLog = await createWorkLog(config.workingDir, config.sessionId);

  // Write session_start entry
  await workLog.append({
    timestamp: new Date().toISOString(),
    type: 'session_start',
    watcherNote: `Session started with goal: ${config.goal.slice(0, 200)}`,
  }).catch(() => {});

  // 4. Create watcher stopHook
  const stopHook = createWatcherStopHook({
    sessionId: config.sessionId,
    salienceFilePath: salience,
    decisionLog,
    workLog,
    workingDir: config.workingDir,
    runAgent: config.runAgent,
    onCreateWorkItems: config.onCreateWorkItems,
  });

  // 5. Build planning objective
  const planningObjective = buildPlanningObjective(config.goal, salience, decisionLog.filePath(), workLog.filePath());

  return {
    salienceFilePath: salience,
    decisionLogPath: decisionLog.filePath(),
    workLogPath: workLog.filePath(),
    decisionLog,
    workLog,
    stopHook,
    planningObjective,
  };
}

// ============================================
// PLANNING OBJECTIVE
// ============================================

/**
 * Build the objective string for the planning agent.
 *
 * The planning agent is a standard agent that:
 * - Reads the salience file for context
 * - Explores the codebase as needed
 * - Asks clarifying questions (answered by watcher or escalated to user)
 * - Produces a structured handoff spec via PromptUser or handoffSpec
 */
function buildPlanningObjective(
  goal: string,
  saliencePath: string,
  decisionLogPath: string,
  workLogPath: string
): string {
  return `## Async Planning Session

You are planning the execution of the following goal:

**Goal**: ${goal}

### Context Files
- Salience file: ${saliencePath} — contains the session goal and operating principles
- Decision log: ${decisionLogPath} — records decisions made during this session
- Work log: ${workLogPath} — session memory of all agent activity

### Phase 1: Understanding (REQUIRED)
Before producing a plan, you MUST ask clarifying questions:
1. Read the salience file for goal and principles.
2. Explore the codebase — use Glob, Grep, Read.
3. Ask 2-5 clarifying questions via PromptUser to resolve ambiguity.
   - The watcher answers questions using best judgment when context meaningfully informs the decision.
   - Questions the watcher cannot answer are escalated to the user.
   - Focus on: scope boundaries, design trade-offs, ordering constraints.
DO NOT skip Phase 1.

### Phase 2: Produce Plan
When questions are answered:
1. **Produce a plan** as a structured handoff spec (set goalStateReached=true and include handoffSpec).

### Handoff Spec Format

The handoffSpec should be a JSON string with this structure:
\`\`\`json
{
  "goal": "the overall goal",
  "workItems": [
    {
      "id": "work-1",
      "objective": "specific objective for this unit of work",
      "delta": "what changes when this is done (one git commit)",
      "agent": "standard",
      "dependencies": [],
      "targetPaths": ["path/to/focus/on"]
    }
  ]
}
\`\`\`

### Parallelization
- The orchestrator runs independent work items concurrently via Promise.all.
- Design work items to maximize parallelism — prefer independent items over serial chains.
- Only use dependencies when there's a genuine ordering constraint.
- Set generous bounds on work items (e.g., maxToolCalls: 200, maxLlmCalls: 30).

### Principles
- Each work item = one atomic unit of work = one git commit
- Work items can run in parallel when they have no dependencies
- Be specific in objectives — include file paths, function names, expected behavior
- Dependencies form a DAG — downstream items wait for upstream ones`;
}
