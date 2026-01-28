/**
 * Watcher Agent - StopHook handler backed by an LLM agent.
 *
 * Routes orchestrator terminal conditions to trigger-specific handlers,
 * runs a watcher agent to evaluate the situation, and returns structured
 * StopHookResult decisions.
 *
 * Core mechanism: StopHookResult { decision: 'block', reason, systemMessage }
 * causes the orchestrator to create a new work item from `reason`, inject
 * `systemMessage` into context, and continue the loop instead of terminating.
 */

import type { StopHookResult, StopHookContext } from 'agent';
import type { WatcherAction, WatcherTrigger, DecisionLogEntry } from './types.js';
import type { DecisionLog } from './decision-log.js';

// ============================================
// CONFIG
// ============================================

export interface WatcherAgentConfig {
  sessionId: string;
  salienceFilePath: string;
  decisionLog: DecisionLog;
  workingDir: string;
  /** Runs the watcher agent with a trigger-specific objective and returns structured output. */
  runAgent: (objective: string) => Promise<WatcherAction>;
  /** Called when the watcher produces split/create_work_item actions. */
  onCreateWorkItems?: (items: WatcherAction['workItems']) => void;
  /** Called after every watcher decision for observability/debugging. */
  onDecision?: (entry: DecisionLogEntry) => void;
}

// ============================================
// STOP HOOK FACTORY
// ============================================

/**
 * Create a StopHookHandler backed by the watcher agent.
 * Routes by terminationReason to trigger-specific handlers.
 */
export function createWatcherStopHook(config: WatcherAgentConfig): (ctx: StopHookContext) => Promise<StopHookResult> {
  return async (ctx: StopHookContext): Promise<StopHookResult> => {
    switch (ctx.terminationReason) {
      case 'user_input_required':
        return handlePromptUser(config, ctx);
      case 'max_iterations_exceeded':
      case 'max_tool_calls_exceeded':
      case 'max_duration_exceeded':
        return handleBoundsExceeded(config, ctx);
      case 'agent_error':
      case 'exception':
        return handleAgentError(config, ctx);
      case 'goal_state_reached':
        return handleGoalReached(config, ctx);
      default:
        return { decision: 'allow' };
    }
  };
}

// ============================================
// HANDLERS
// ============================================

async function handlePromptUser(
  config: WatcherAgentConfig,
  ctx: StopHookContext
): Promise<StopHookResult> {
  const prompt = ctx.userPrompt;
  const questionText = prompt?.question ?? 'Unknown question';
  const optionsText = prompt?.options
    ? `\nOptions: ${JSON.stringify(prompt.options)}`
    : '';

  const objective = `You are the watcher for session ${config.sessionId}.
Read the salience file at: ${config.salienceFilePath}
Read the decision log at: ${config.decisionLog.filePath()}

The agent has paused to ask the user a question:

**Question**: ${questionText}${optionsText}
**Context**: ${prompt?.context ?? 'none'}

Your job:
1. Read the salience file for the session goal and operating principles.
2. Read the decision log for prior decisions in this session.
3. Determine if you can answer this question based on the goal, principles, and prior decisions.
4. If yes: return action "answer" with text and optional contextAddendum.
5. If no: return action "escalate" with reason explaining why the user must decide.`;

  const action = await runAndLog(config, 'prompt_user', objective, ctx.workId, questionText);

  if (action.watcherAction === 'answer' && action.answer) {
    return {
      decision: 'block',
      reason: action.answer.text,
      systemMessage: action.answer.contextAddendum
        ? `[Watcher answered]: ${action.answer.contextAddendum}`
        : `[Watcher answered autonomously]: ${action.reason}`,
    };
  }

  // escalate / continue — let the orchestrator pause for user input
  return { decision: 'allow' };
}

async function handleBoundsExceeded(
  config: WatcherAgentConfig,
  ctx: StopHookContext
): Promise<StopHookResult> {
  const objective = `You are the watcher for session ${config.sessionId}.
Read the salience file at: ${config.salienceFilePath}
Read the decision log at: ${config.decisionLog.filePath()}

The agent has hit a resource bound: **${ctx.terminationReason}** (iteration ${ctx.iteration}).

Recent response (truncated): ${ctx.response.slice(0, 500)}

Your job:
1. Assess whether meaningful progress was being made.
2. If the agent was on track but needs more room: return action "realign" with a systemMessage refocusing the agent and trimming scope.
3. If the agent was drifting or wasting cycles: return action "continue" to let termination proceed.
4. If the work should be split: return action "split" with workItems.`;

  const action = await runAndLog(config, 'bounds_exceeded', objective, ctx.workId);

  if (action.watcherAction === 'realign' && action.realign) {
    return {
      decision: 'block',
      reason: action.realign.newGoal ?? `Continue: ${action.reason}`,
      systemMessage: action.realign.systemMessage,
    };
  }

  if ((action.watcherAction === 'split' || action.watcherAction === 'create_work_item') && action.workItems?.length) {
    try {
      config.onCreateWorkItems?.(action.workItems);
    } catch {
      // Callback failure is non-fatal — don't break the stop hook promise chain
    }
    return { decision: 'allow' };
  }

  return { decision: 'allow' };
}

async function handleAgentError(
  config: WatcherAgentConfig,
  ctx: StopHookContext
): Promise<StopHookResult> {
  const objective = `You are the watcher for session ${config.sessionId}.
Read the salience file at: ${config.salienceFilePath}
Read the decision log at: ${config.decisionLog.filePath()}

The agent encountered an error: **${ctx.terminationReason}** (iteration ${ctx.iteration}).

Response/error: ${ctx.response.slice(0, 500)}

Your job:
1. Diagnose whether this is recoverable.
2. If recoverable: return action "realign" with a systemMessage containing fix instructions.
3. If not recoverable: return action "escalate" with reason.`;

  const action = await runAndLog(config, 'agent_error', objective, ctx.workId);

  if (action.watcherAction === 'realign' && action.realign) {
    return {
      decision: 'block',
      reason: action.realign.newGoal ?? `Fix: ${action.reason}`,
      systemMessage: action.realign.systemMessage,
    };
  }

  return { decision: 'allow' };
}

async function handleGoalReached(
  config: WatcherAgentConfig,
  ctx: StopHookContext
): Promise<StopHookResult> {
  const objective = `You are the watcher for session ${config.sessionId}.
Read the salience file at: ${config.salienceFilePath}
Read the decision log at: ${config.decisionLog.filePath()}

The agent reports goal_state_reached (iteration ${ctx.iteration}).

Response: ${ctx.response.slice(0, 1000)}

Your job — quality gate:
1. Read the salience file for the session goal.
2. Verify the response actually addresses the goal.
3. Check for obvious omissions, untested changes, or incomplete work.
4. If quality gate passes: return action "quality_gate" with passed=true.
5. If quality gate fails: return action "quality_gate" with passed=false and issues list.`;

  const action = await runAndLog(config, 'work_item_completed', objective, ctx.workId);

  if (action.watcherAction === 'quality_gate' && action.qualityGate && !action.qualityGate.passed) {
    const issues = action.qualityGate.issues?.join('; ') ?? action.reason;
    return {
      decision: 'block',
      reason: `Quality gate failed. Fix these issues: ${issues}`,
      systemMessage: `[Watcher quality gate]: The following issues were found:\n${action.qualityGate.issues?.map(i => `- ${i}`).join('\n') ?? action.reason}`,
    };
  }

  return { decision: 'allow' };
}

// ============================================
// HELPERS
// ============================================

/**
 * Run the watcher agent and append the result to the decision log.
 */
async function runAndLog(
  config: WatcherAgentConfig,
  trigger: WatcherTrigger,
  objective: string,
  workItemId?: string,
  question?: string
): Promise<WatcherAction> {
  let action: WatcherAction;
  try {
    action = await config.runAgent(objective);
  } catch (err) {
    // If the watcher agent fails, default to allowing termination
    action = {
      watcherAction: 'continue',
      reason: `Watcher agent error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const entry: DecisionLogEntry = {
    timestamp: new Date().toISOString(),
    trigger,
    watcherAction: action.watcherAction,
    question,
    answer: action.answer?.text,
    rationale: action.reason,
    workItemId,
  };

  try {
    await config.decisionLog.append(entry);
  } catch {
    // Decision log write failure is non-fatal
  }

  try {
    config.onDecision?.(entry);
  } catch {
    // Callback failure is non-fatal — don't break the stop hook promise chain
  }

  return action;
}
