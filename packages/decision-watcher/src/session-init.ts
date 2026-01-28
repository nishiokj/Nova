/**
 * Session Init
 *
 * Bootstrap an async watcher session: write salience file, create decision log,
 * create the watcher stopHook, and produce the initial planning work item.
 */

import type { StopHookResult, StopHookContext } from 'agent';
import type { WatcherAction } from './types.js';
import type { DecisionLog } from './decision-log.js';
import { writeSalienceFile, salienceFilePath } from './salience.js';
import { createDecisionLog } from './decision-log.js';
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
  decisionLog: DecisionLog;
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

  // 3. Create watcher stopHook
  const stopHook = createWatcherStopHook({
    sessionId: config.sessionId,
    salienceFilePath: salience,
    decisionLog,
    workingDir: config.workingDir,
    runAgent: config.runAgent,
    onCreateWorkItems: config.onCreateWorkItems,
  });

  // 4. Build planning objective
  const planningObjective = buildPlanningObjective(config.goal, salience, decisionLog.filePath());

  return {
    salienceFilePath: salience,
    decisionLogPath: decisionLog.filePath(),
    decisionLog,
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
 * - Produces a structured handoff spec via PromptUser or handoffSpec
 * - Uses PromptUser for clarifying questions (answered by watcher via stopHook)
 */
function buildPlanningObjective(
  goal: string,
  saliencePath: string,
  decisionLogPath: string
): string {
  return `## Async Planning Session

You are planning the execution of the following goal:

**Goal**: ${goal}

### Context Files
- Salience file: ${saliencePath} — contains the session goal and operating principles
- Decision log: ${decisionLogPath} — records decisions made during this session

### Your Task

1. **Read the salience file** to understand the goal and principles.
2. **Explore the codebase** to understand the current state — use Glob, Grep, Read, and Bash as needed.
3. **Ask clarifying questions** via PromptUser if you need to resolve ambiguity. The watcher will attempt to answer autonomously; if it can't, the user will be prompted.
4. **Produce a plan** as a structured handoff spec when ready.

### Handoff Spec Format

When your plan is ready, output it as a handoff spec (set goalStateReached=true and include handoffSpec):

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

### Principles
- Each work item = one atomic unit of work = one git commit
- Work items can run in parallel when they have no dependencies
- Be specific in objectives — include file paths, function names, expected behavior
- Dependencies form a DAG — downstream items wait for upstream ones`;
}
