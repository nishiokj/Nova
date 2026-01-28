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

import type { StopHookResult, StopHookContext, ExecutionSnapshot } from 'agent';
import type { WatcherAction, WatcherTrigger, DecisionLogEntry } from './types.js';
import type { DecisionLog } from './decision-log.js';
import type { WorkLog } from './work-log.js';

// ============================================
// CONFIG
// ============================================

export interface WatcherAgentConfig {
  sessionId: string;
  salienceFilePath: string;
  decisionLog: DecisionLog;
  workLog: WorkLog;
  workingDir: string;
  /** Runs the watcher agent with a trigger-specific objective and returns structured output. */
  runAgent: (objective: string) => Promise<WatcherAction>;
  /** Called when the watcher produces split/create_work_item actions. */
  onCreateWorkItems?: (items: WatcherAction['workItems']) => void;
  /** Called after every watcher decision for observability/debugging. */
  onDecision?: (entry: DecisionLogEntry) => void;
  /** Timeout for watcher agent execution (default: 30000ms) */
  watcherTimeoutMs?: number;
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
      case 'cadence_audit':
        return handleCadenceAudit(config, ctx);
      // Explicit control flow states - allow termination
      case 'handoff_requested':
        // Planning agent requesting handoff to execution
        return { decision: 'allow' };
      case 'user_stopped':
        // User typed "stop" - explicit user command
        return { decision: 'allow' };
      // Transient errors - allow termination, let caller decide retry
      case 'rate_limit':
      case 'circuit_open':
      case 'timeout':
        return { decision: 'allow' };
      // Agent semantic errors - allow termination
      case 'refusal':
        // LLM refused to complete task
        return { decision: 'allow' };
      case 'no_action':
      case 'invalid_action':
        // Semantic errors handled by Orchestrator, allow termination
        return { decision: 'allow' };
      default:
        return { decision: 'allow' };
    }
  };
}

// ============================================
// SNAPSHOT FORMATTING (trigger-aware)
// ============================================

/**
 * Format for goal_state_reached: WHAT happened, not HOW.
 * No tool call history — agent finished; tool replay is noise.
 */
function formatGoalReachedContext(ctx: StopHookContext): string {
  const snap = ctx.executionSnapshot;
  if (!snap) {
    return `\nAgent response (truncated): ${ctx.response.slice(0, 1000)}`;
  }

  const sections: string[] = [];

  // Execution summary
  const m = snap.metrics;
  sections.push(`### Execution Summary
- Duration: ${(m.durationMs / 1000).toFixed(1)}s | Tool calls: ${m.toolCallsMade} | Context: ${(m.contextPercentUsed * 100).toFixed(0)}% used`);

  // Files modified (full list — this is the real footprint)
  if (snap.filesModified.length > 0) {
    sections.push(`### Files Modified (${snap.filesModified.length})
${snap.filesModified.map(f => `- ${f}`).join('\n')}`);
  }

  // Agent response (up to 3000 chars)
  const responsePreview = snap.fullResponse.length > 3000
    ? snap.fullResponse.slice(0, 3000) + '\n... [truncated]'
    : snap.fullResponse;
  sections.push(`### Agent Response
${responsePreview}`);

  return '\n' + sections.join('\n\n');
}

/**
 * Full context for bounds_exceeded and agent_error — includes everything.
 */
function formatFullContext(ctx: StopHookContext): string {
  const snap = ctx.executionSnapshot;
  if (!snap) {
    return `\nAgent response (truncated): ${ctx.response.slice(0, 1000)}`;
  }

  const sections: string[] = [];

  // Metrics summary
  const m = snap.metrics;
  sections.push(`### Execution Metrics
- LLM calls: ${m.llmCallsMade} | Tool calls: ${m.toolCallsMade} (${m.toolCallsSucceeded} ok, ${m.toolCallsFailed} failed)
- Duration: ${(m.durationMs / 1000).toFixed(1)}s | Context: ${(m.contextPercentUsed * 100).toFixed(0)}% used
- Tokens: ${m.inputTokens} in / ${m.outputTokens} out`);

  // Files
  if (snap.filesModified.length > 0) {
    sections.push(`### Files Modified (${snap.filesModified.length})
${snap.filesModified.map(f => `- ${f}`).join('\n')}`);
  }
  if (snap.filesRead.length > 0) {
    const display = snap.filesRead.slice(0, 15);
    const suffix = snap.filesRead.length > 15 ? `\n... and ${snap.filesRead.length - 15} more` : '';
    sections.push(`### Files Read (${snap.filesRead.length})
${display.map(f => `- ${f}`).join('\n')}${suffix}`);
  }

  // Tool call history (last 10)
  if (snap.toolHistory.length > 0) {
    const recent = snap.toolHistory.slice(-10);
    const lines = recent.map(t => {
      const status = t.success ? 'ok' : 'FAIL';
      const argsPreview = JSON.stringify(t.args).slice(0, 120);
      return `- [${status}] ${t.name}(${argsPreview}) ${t.durationMs}ms`;
    });
    sections.push(`### Recent Tool Calls (last ${recent.length} of ${snap.toolHistory.length})
${lines.join('\n')}`);
  }

  // Artifacts
  if (snap.artifacts && snap.artifacts.length > 0) {
    const display = snap.artifacts.slice(0, 8);
    sections.push(`### Artifacts Discovered (${snap.artifacts.length})
${display.map(a => `- [${a.kind}] ${a.name} (${a.sourcePath})${a.insight ? ': ' + a.insight : ''}`).join('\n')}`);
  }

  // Full response (up to 3000 chars)
  const responsePreview = snap.fullResponse.length > 3000
    ? snap.fullResponse.slice(0, 3000) + '\n... [truncated]'
    : snap.fullResponse;
  sections.push(`### Agent Response
${responsePreview}`);

  return '\n' + sections.join('\n\n');
}

/**
 * Medium-depth context for cadence audits — metrics + files + brief response.
 * No full tool history, no full response.
 */
function formatCadenceContext(ctx: StopHookContext): string {
  const snap = ctx.executionSnapshot;
  if (!snap) {
    return `\nAgent response (truncated): ${ctx.response.slice(0, 500)}`;
  }

  const sections: string[] = [];

  // Metrics summary
  const m = snap.metrics;
  sections.push(`### Execution Metrics
- LLM calls: ${m.llmCallsMade} | Tool calls: ${m.toolCallsMade} (${m.toolCallsSucceeded} ok, ${m.toolCallsFailed} failed)
- Duration: ${(m.durationMs / 1000).toFixed(1)}s | Context: ${(m.contextPercentUsed * 100).toFixed(0)}% used`);

  // Files modified
  if (snap.filesModified.length > 0) {
    sections.push(`### Files Modified (${snap.filesModified.length})
${snap.filesModified.map(f => `- ${f}`).join('\n')}`);
  }

  // Brief response preview (500 chars)
  const responsePreview = snap.fullResponse.length > 500
    ? snap.fullResponse.slice(0, 500) + '\n... [truncated]'
    : snap.fullResponse;
  sections.push(`### Agent Response (preview)
${responsePreview}`);

  return '\n' + sections.join('\n\n');
}

/**
 * Dispatcher: select the right formatter based on trigger type.
 */
function formatSnapshotForTrigger(trigger: string, ctx: StopHookContext): string {
  switch (trigger) {
    case 'work_item_completed':
      return formatGoalReachedContext(ctx);
    case 'cadence_audit':
      return formatCadenceContext(ctx);
    case 'bounds_exceeded':
    case 'prompt_user':
    default:
      return formatFullContext(ctx);
  }
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

  const snapshotContext = formatSnapshotForTrigger('prompt_user', ctx);

  const objective = `You are the watcher for session ${config.sessionId}.
Read the salience file at: ${config.salienceFilePath}
Read the decision log at: ${config.decisionLog.filePath()}
Read the work log at: ${config.workLog.filePath()} — this is your session memory of all agent activity.

The agent has paused to ask the user a question:

**Question**: ${questionText}${optionsText}
**Context**: ${prompt?.context ?? 'none'}
${snapshotContext}

Your job:
1. Read the salience file for the session goal and operating principles.
2. Read the decision log for prior decisions in this session.
3. Read the work log for session activity context.
4. Determine if you can answer this question based on the goal, principles, and prior decisions.
5. Use your best judgment when context meaningfully informs the decision. Don't escalate questions you can reasonably answer from the salience file, decision log, work log, or common engineering sense.
6. If yes: return action "answer" with text and optional contextAddendum.
7. If no: return action "escalate" with reason explaining why the user must decide.`;

  const action = await runAndLog(config, 'prompt_user', objective, ctx);

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
  const snapshotContext = formatSnapshotForTrigger('bounds_exceeded', ctx);

  const objective = `You are the watcher for session ${config.sessionId}.
Read the salience file at: ${config.salienceFilePath}
Read the decision log at: ${config.decisionLog.filePath()}
Read the work log at: ${config.workLog.filePath()} — this is your session memory of all agent activity.

The agent has hit a resource bound: **${ctx.terminationReason}** (iteration ${ctx.iteration}).
${snapshotContext}

Your job:
1. Assess whether meaningful progress was being made (check tool history and files modified).
2. If the agent was on track but needs more room: return action "realign" with a systemMessage refocusing the agent and trimming scope.
3. If the agent was drifting or wasting cycles: return action "continue" to let termination proceed.
4. If the work should be split: return action "split" with workItems.

### Parallelization
When creating work items, prefer INDEPENDENT items that run concurrently.
Only add dependencies for genuine data/ordering constraints.
Set generous bounds (maxToolCalls: 200, maxLlmCalls: 30, maxDurationMs: 300000).`;

  const action = await runAndLog(config, 'bounds_exceeded', objective, ctx);

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
    // Map work items to deferredWork for orchestrator dispatch
    return {
      decision: 'allow',
      deferredWork: action.workItems.map(w => ({
        goal: w.goal,
        objective: w.objective,
        agent: w.agent,
        background: true,
        dependencies: w.dependencies,
        targetPaths: w.targetPaths,
        bounds: w.bounds,
      })),
    };
  }

  return { decision: 'allow' };
}

async function handleAgentError(
  config: WatcherAgentConfig,
  ctx: StopHookContext
): Promise<StopHookResult> {
  const snapshotContext = formatSnapshotForTrigger('bounds_exceeded', ctx);

  const objective = `You are the watcher for session ${config.sessionId}.
Read the salience file at: ${config.salienceFilePath}
Read the decision log at: ${config.decisionLog.filePath()}
Read the work log at: ${config.workLog.filePath()} — this is your session memory of all agent activity.

The agent encountered an error: **${ctx.terminationReason}** (iteration ${ctx.iteration}).
${snapshotContext}

Your job:
1. Diagnose whether this is recoverable (check tool history for what failed and why).
2. If recoverable: return action "realign" with a systemMessage containing fix instructions.
3. If not recoverable: return action "escalate" with reason.`;

  const action = await runAndLog(config, 'agent_error', objective, ctx);

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
  // Write the agent's summary to the work log before running the watcher
  const snap = ctx.executionSnapshot;
  const agentSummary = snap?.fullResponse ?? ctx.response;
  await config.workLog.append({
    timestamp: new Date().toISOString(),
    type: 'agent_completed',
    workId: ctx.workId,
    agentType: ctx.agentType,
    agentSummary: agentSummary.slice(0, 5000),
    paths: snap?.filesModified,
    metrics: snap ? {
      toolCallsMade: snap.metrics.toolCallsMade,
      llmCallsMade: snap.metrics.llmCallsMade,
      durationMs: snap.metrics.durationMs,
      contextPercentUsed: snap.metrics.contextPercentUsed,
    } : undefined,
  }).catch(() => {});

  const snapshotContext = formatSnapshotForTrigger('work_item_completed', ctx);

  const objective = `You are the watcher for session ${config.sessionId}.
Read the salience file at: ${config.salienceFilePath}
Read the decision log at: ${config.decisionLog.filePath()}
Read the work log at: ${config.workLog.filePath()} — this is your session memory of all agent activity.

The agent reports goal_state_reached (iteration ${ctx.iteration}).
${snapshotContext}

Your job — quality gate:
1. Read the salience file for the session goal.
2. Verify the response actually addresses the goal (check files modified and the full response).
3. Check for obvious omissions, untested changes, or incomplete work.
4. If quality gate passes: return action "quality_gate" with passed=true.
5. If quality gate fails: return action "quality_gate" with passed=false and issues list.

### Parallelization
When creating follow-up work items, prefer INDEPENDENT items that run concurrently.
Only add dependencies for genuine data/ordering constraints.
Set generous bounds (maxToolCalls: 200, maxLlmCalls: 30, maxDurationMs: 300000).`;

  const action = await runAndLog(config, 'work_item_completed', objective, ctx);

  if (action.watcherAction === 'quality_gate' && action.qualityGate && !action.qualityGate.passed) {
    const issues = action.qualityGate.issues?.join('; ') ?? action.reason;
    return {
      decision: 'block',
      reason: `Quality gate failed. Fix these issues: ${issues}`,
      systemMessage: `[Watcher quality gate]: The following issues were found:\n${action.qualityGate.issues?.map(i => `- ${i}`).join('\n') ?? action.reason}`,
    };
  }

  // If the watcher identified follow-up work items, dispatch them as deferred work
  if ((action.watcherAction === 'split' || action.watcherAction === 'create_work_item') && action.workItems?.length) {
    try {
      config.onCreateWorkItems?.(action.workItems);
    } catch {
      // Callback failure is non-fatal
    }
    return {
      decision: 'allow',
      deferredWork: action.workItems.map(w => ({
        goal: w.goal,
        objective: w.objective,
        agent: w.agent,
        background: true,
        dependencies: w.dependencies,
        targetPaths: w.targetPaths,
        bounds: w.bounds,
      })),
    };
  }

  return { decision: 'allow' };
}

async function handleCadenceAudit(
  config: WatcherAgentConfig,
  ctx: StopHookContext
): Promise<StopHookResult> {
  const snapshotContext = formatSnapshotForTrigger('cadence_audit', ctx);

  const objective = `You are the watcher for session ${config.sessionId}.
Read the salience file at: ${config.salienceFilePath}
Read the decision log at: ${config.decisionLog.filePath()}
Read the work log at: ${config.workLog.filePath()} — this is your session memory of all agent activity.

This is a periodic cadence audit (every 3 minutes). The agent is still executing.
${snapshotContext}

Your job — progress check:
1. Read the work log and salience file to understand the session goal and what has happened so far.
2. Check for drift: is the agent still working toward the session goal, or has it gone off-track?
3. Check for thrashing: is the agent repeating failed approaches or stuck in a loop?
4. If on track: return action "continue" with a brief assessment.
5. If drifting or thrashing: return action "realign" with a systemMessage refocusing the agent.
6. If work should be split: return action "split" with workItems to decompose the remaining work.`;

  const action = await runAndLog(config, 'cadence_audit', objective, ctx);

  // Write watcher assessment to work log
  await config.workLog.append({
    timestamp: new Date().toISOString(),
    type: 'watcher_note',
    watcherNote: `[cadence audit] ${action.watcherAction}: ${action.reason}`,
  }).catch(() => {});

  if (action.watcherAction === 'realign' && action.realign) {
    return {
      decision: 'block',
      reason: action.realign.newGoal ?? `Realign: ${action.reason}`,
      systemMessage: action.realign.systemMessage,
    };
  }

  if ((action.watcherAction === 'split' || action.watcherAction === 'create_work_item') && action.workItems?.length) {
    try {
      config.onCreateWorkItems?.(action.workItems);
    } catch {
      // Callback failure is non-fatal
    }
    return {
      decision: 'allow',
      deferredWork: action.workItems.map(w => ({
        goal: w.goal,
        objective: w.objective,
        agent: w.agent,
        background: true,
        dependencies: w.dependencies,
        targetPaths: w.targetPaths,
        bounds: w.bounds,
      })),
    };
  }

  return { decision: 'allow' };
}

// ============================================
// HELPERS
// ============================================

/**
 * Run the watcher agent and append the result to the decision log.
 * Wraps execution with optional timeout and populates execution metrics.
 */
async function runAndLog(
  config: WatcherAgentConfig,
  trigger: WatcherTrigger,
  objective: string,
  ctx: StopHookContext
): Promise<WatcherAction> {
  let action: WatcherAction;
  const timeoutMs = config.watcherTimeoutMs ?? 30_000;

  try {
    const agentPromise = config.runAgent(objective);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Watcher timeout after ${timeoutMs}ms`)), timeoutMs)
    );
    action = await Promise.race([agentPromise, timeoutPromise]);
  } catch (err) {
    // If the watcher agent fails or times out, default to allowing termination
    action = {
      watcherAction: 'continue',
      reason: `Watcher agent error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Build execution metrics from snapshot for audit trail
  const snap = ctx.executionSnapshot;
  const executionMetrics = snap ? {
    toolCallsMade: snap.metrics.toolCallsMade,
    filesModified: snap.filesModified,
    durationMs: snap.metrics.durationMs,
    contextPercentUsed: snap.metrics.contextPercentUsed,
  } : undefined;

  const entry: DecisionLogEntry = {
    timestamp: new Date().toISOString(),
    trigger,
    watcherAction: action.watcherAction,
    question: ctx.userPrompt?.question,
    answer: action.answer?.text,
    rationale: action.reason,
    workItemId: ctx.workId,
    qualityGate: action.qualityGate,
    executionMetrics,
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
