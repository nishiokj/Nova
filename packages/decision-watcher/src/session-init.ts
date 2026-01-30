/**
 * Session Init
 *
 * Bootstrap an async watcher session: write salience file, create decision log,
 * create watcher control hooks, and produce the initial planning work item.
 */

import type { ControlEvent, Hook } from 'protocol';
import type { WatcherAction, WatcherTrigger, WatcherWorkItem } from './types.js';
import type { DecisionLog } from './decision-log.js';
import type { WorkLog } from './work-log.js';
import { writeSalienceFile, salienceFilePath } from './salience.js';
import { createDecisionLog } from './decision-log.js';
import { createWorkLog } from './work-log.js';
import { createWatcherControlHooks } from './watcher-agent.js';
import { getWorkItemLog } from './workitem-log.js';

// ============================================
// TYPES
// ============================================

export interface AsyncSessionConfig {
  sessionId: string;
  goal: string;
  workingDir: string;
  /** Runs the watcher agent with a trigger-specific objective string. */
  runAgent: (objective: string, trigger: WatcherTrigger) => Promise<WatcherAction>;
  /** Called when watcher produces work items via split/create. */
  onCreateWorkItems?: (items: WatcherWorkItem[]) => void;
  /** Operating principles to include in the salience file. */
  principles?: string[];
}

export interface AsyncSessionResult {
  salienceFilePath: string;
  decisionLogPath: string;
  workLogPath: string;
  decisionLog: DecisionLog;
  workLog: WorkLog;
  hooks: Array<Hook<ControlEvent, unknown>>;
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
 * 3. Create watcher control hooks
 * 4. Produce the planning objective string
 *
 * The caller (harness) registers the returned hooks in the orchestrator registry
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
    type: 'session_start',
    timestamp: new Date().toISOString(),
    goal: config.goal,
    mode: 'async',
  }).catch(err => {
    console.warn('[WATCHER] Work log write failed (session_start):', err instanceof Error ? err.message : String(err));
  });

  // 4. Create watcher control hooks
  const hooks = createWatcherControlHooks({
    sessionId: config.sessionId,
    salienceFilePath: salience,
    decisionLog,
    workLog,
    getWorkItemLog: (workId: string) => getWorkItemLog(config.workingDir, config.sessionId, workId),
    workingDir: config.workingDir,
    runAgent: config.runAgent,
    onCreateWorkItems: config.onCreateWorkItems,
  }, config.sessionId);

  // 5. Build planning objective
  const planningObjective = buildPlanningObjective(config.goal, salience, decisionLog.filePath(), workLog.filePath());

  return {
    salienceFilePath: salience,
    decisionLogPath: decisionLog.filePath(),
    workLogPath: workLog.filePath(),
    decisionLog,
    workLog,
    hooks,
    planningObjective,
  };
}

// ============================================
// PLANNING OBJECTIVE
// ============================================

/**
 * Build the objective string for the planning agent.
 *
 * The planning agent:
 * - Reads the salience file for context and principles
 * - Explores the codebase minimally (just enough to plan)
 * - Asks clarifying questions (answered by watcher autonomously)
 * - Produces a structured handoff spec
 *
 * NOTE: Skill knowledge is baked into the system prompt. Do NOT tell the agent to read skill files.
 */
export function buildPlanningObjective(
  goal: string,
  saliencePath: string,
  decisionLogPath: string,
  workLogPath: string
): string {
  return `## Goal

${goal}

## Context Files

- **Salience**: ${saliencePath} — session goal and principles
- **Decision log**: ${decisionLogPath} — prior decisions this session
- **Work log**: ${workLogPath} — session activity

## Your Task

1. **Read the salience file** for goal context and operating principles.
2. **Explore minimally** — use Glob/Grep/Read to understand what needs to change.
3. **Ask questions** — use PromptUser if the goal is ambiguous. The watcher answers.
4. **Produce a plan** — output your handoffSpec when ready.

## handoffSpec Format

Your handoffSpec MUST be a valid JSON object and include:
- \`goal\` (string)
- \`context\` (string)
- \`workItems\` (array), each item with:
  - \`id\` (string)
  - \`objective\` (string, include file paths)
  - \`delta\` (string; one commit)
  - \`agent\` (string)
  - \`domain\` (string, optional)
  - \`dependencies\` (string[], optional)
  - \`targetPaths\` (string[], optional)

## Principles

- **Atomic**: Each work item = one commit
- **Parallel**: Independent items run concurrently (minimize dependencies)
- **Specific**: Include file paths in objectives
- **Bounded**: Max 5-7 work items. If bigger, split the goal first.

When ready: set \`goalStateReached: true\`, \`action: "handoff"\`, and include \`handoffSpec\`.`;
}
