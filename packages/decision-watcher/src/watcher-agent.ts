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
import { getValidActions } from './types.js';
import type { DecisionLog } from './decision-log.js';
import type { WorkLog } from './work-log.js';
import type { WorkItemLog } from './workitem-log.js';

// ============================================
// CONFIG
// ============================================

/** Default timeout increased to 90s - watcher needs time to read files + reason */
const DEFAULT_TIMEOUT_MS = 90_000;

/** Per-trigger timeout configuration - critical paths get more time */
const TIMEOUT_BY_TRIGGER: Record<WatcherTrigger, number> = {
  session_init: 60_000,        // Session bootstrap
  prompt_user: 120_000,        // Most critical - must answer user questions
  work_item_completed: 90_000, // Quality gate evaluation
  bounds_exceeded: 75_000,     // May need to realign or split work
  cadence_audit: 60_000,       // Periodic check - can be faster
  agent_error: 75_000,         // Error diagnosis needs context
  scope_collision: 60_000,     // Concurrency conflict resolution
  handoff_approval: 90_000,    // Plan review - needs time to read spec
};

/** Max retries before giving up */
const MAX_RETRIES = 2;

export interface WatcherAgentConfig {
  sessionId: string;
  salienceFilePath: string;
  /** Session-level decision log (global, for audit trail) */
  decisionLog: DecisionLog;
  /** Session-level work log (workitem status summaries) */
  workLog: WorkLog;
  /** Get workitem-level log (full conversation, tool calls, scoped decisions) */
  getWorkItemLog: (workId: string) => Promise<WorkItemLog | null>;
  workingDir: string;
  /** Runs the watcher agent with a trigger-specific objective and returns structured output. */
  runAgent: (objective: string, trigger: WatcherTrigger) => Promise<WatcherAction>;
  /** Called when the watcher produces split/create_work_item actions. */
  onCreateWorkItems?: (items: WatcherAction['workItems']) => void;
  /** Called after every watcher decision for observability/debugging. */
  onDecision?: (entry: DecisionLogEntry) => void;
  /** Base timeout for watcher agent execution (default: 90000ms). Per-trigger timeouts take precedence. */
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
      // Planning agent requesting handoff - watcher reviews and approves
      case 'handoff_requested':
        return handleHandoffApproval(config, ctx);
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

  // Get workitem-level context (full conversation, tool calls, scoped decisions)
  const workItemLog = ctx.workId ? await config.getWorkItemLog(ctx.workId) : null;
  const workItemLogPath = workItemLog?.filePath() ?? 'not available';

  const snapshotContext = formatSnapshotForTrigger('prompt_user', ctx);

  const objective = `You are the watcher for session ${config.sessionId}.

## Session Context (read these first for broad awareness)
- **Salience**: ${config.salienceFilePath}
  Contains: session goal, operating mode, principles

- **Work Log**: ${config.workLog.filePath()}
  Contains: all WorkItems in this session, their status, brief summaries
  Shows: what's running in parallel, what completed, dependencies

## WorkItem Context (the agent asking this question)
- **WorkItem Log**: ${workItemLogPath}
  Contains: FULL conversation history, tool calls, discoveries, prior decisions
  This tells you WHY the agent is asking and what it found
  **READ THIS** to understand the agent's reasoning

## Question from Agent (WorkItem: ${ctx.workId ?? 'unknown'})

**Question**: ${questionText}${optionsText}
**Agent Context**: ${prompt?.context ?? 'none'}
${snapshotContext}

## Your Task

**You MUST answer.** There is no user available in async mode.

1. Read salience for session goal.
2. Read work-log for session state (other workitems, completed work).
3. **Read workitem log for THIS agent's full context** (conversation, tool calls, discoveries).
4. If needed, use Read/Grep tools to verify agent's findings.
5. Answer with awareness of both session goal AND agent's specific situation.

Guidelines:
- Technical decisions: follow codebase conventions the agent discovered.
- Ambiguous requirements: choose what aligns with session goal.
- Options questions: pick the most sensible option based on agent's context.
- Uncertain: pick first option and explain reasoning.

Return \`watcherAction: "answer"\` with your answer text.`;

  const action = await runAndLog(config, 'prompt_user', objective, ctx);

  // Log decision to workitem (scoped) in addition to global decision log
  if (workItemLog && action.watcherAction === 'answer') {
    await workItemLog.appendDecision(
      'prompt_user',
      action.watcherAction,
      action.reason,
      questionText,
      action.answer?.text
    ).catch(err => {
      console.warn('[WATCHER] WorkItem decision log failed:', err instanceof Error ? err.message : String(err));
    });
  }

  if (action.watcherAction === 'answer' && action.answer) {
    return {
      decision: 'block',
      reason: action.answer.text,
      systemMessage: action.answer.contextAddendum
        ? `[Watcher answered]: ${action.answer.contextAddendum}`
        : `[Watcher answered autonomously]: ${action.reason}`,
    };
  }

  // Watcher failed to provide an answer (timeout, error, wrong action, etc.)
  // Provide a default answer to keep async session moving.
  const defaultAnswer = prompt?.options?.[0]
    ? (typeof prompt.options[0] === 'string' ? prompt.options[0] : (prompt.options[0] as { label?: string }).label ?? 'Continue')
    : 'Continue with your best judgment.';

  return {
    decision: 'block',
    reason: defaultAnswer,
    systemMessage: `[Watcher auto-answer (fallback)]: Watcher did not provide answer (action: ${action.watcherAction}). Using default: ${defaultAnswer}`,
  };
}

async function handleBoundsExceeded(
  config: WatcherAgentConfig,
  ctx: StopHookContext
): Promise<StopHookResult> {
  // Get workitem-level context
  const workItemLog = ctx.workId ? await config.getWorkItemLog(ctx.workId) : null;
  const workItemLogPath = workItemLog?.filePath() ?? 'not available';

  const snapshotContext = formatSnapshotForTrigger('bounds_exceeded', ctx);

  const objective = `You are the watcher for session ${config.sessionId}.

## Session Context
- **Salience**: ${config.salienceFilePath} — session goal, principles
- **Work Log**: ${config.workLog.filePath()} — all WorkItems status, what's running/completed

## WorkItem Context (the agent that hit bounds)
- **WorkItem Log**: ${workItemLogPath}
  Contains: FULL conversation, tool calls, discoveries
  **READ THIS** to understand what the agent was doing and why it hit bounds

The agent has hit a resource bound: **${ctx.terminationReason}** (iteration ${ctx.iteration}).
${snapshotContext}

Your job:
1. **Read the workitem log** to understand what the agent was doing and why.
2. Assess whether meaningful progress was being made (check conversation, tool calls, files modified).
3. If the agent was on track but needs more room: return action "realign" with a systemMessage refocusing the agent and trimming scope.
4. If the agent was drifting or wasting cycles: return action "split" with workItems to decompose remaining work.

### Parallelization
When creating work items, prefer INDEPENDENT items that run concurrently.
Only add dependencies for genuine data/ordering constraints.
Set generous bounds (maxToolCalls: 200, maxLlmCalls: 30, maxDurationMs: 300000).`;

  const action = await runAndLog(config, 'bounds_exceeded', objective, ctx);

  // Log decision to workitem
  if (workItemLog) {
    await workItemLog.appendDecision(
      'bounds_exceeded',
      action.watcherAction,
      action.reason
    ).catch(err => {
      console.warn('[WATCHER] WorkItem decision log failed:', err instanceof Error ? err.message : String(err));
    });
  }

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
    } catch (err) {
      console.warn('[WATCHER] onCreateWorkItems callback failed:', err instanceof Error ? err.message : String(err));
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

  // Watcher failed (timeout/error) on bounds_exceeded — provide a realignment
  // nudge so the agent can wrap up instead of silently terminating.
  if (action.reason?.includes('Watcher agent error') || action.reason?.includes('Watcher timeout')) {
    return {
      decision: 'block',
      reason: 'Wrap up your current work and report progress.',
      systemMessage: `[Watcher fallback — bounds exceeded]: Agent hit ${ctx.terminationReason}. Wrap up and summarize what was accomplished.`,
    };
  }

  // Handle invalid watcher actions for bounds_exceeded context
  // Valid actions: realign, split, create_work_item
  // Invalid actions (continue, answer, quality_gate, etc.) should block and wrap up
  if (!['realign', 'split', 'create_work_item'].includes(action.watcherAction)) {
    return {
      decision: 'block',
      reason: 'Wrap up your current work and report progress.',
      systemMessage: `[Watcher fallback — bounds exceeded]: Watcher returned "${action.watcherAction}" which is not valid for bounds_exceeded. Agent hit ${ctx.terminationReason}. Wrap up and summarize what was accomplished.`,
    };
  }

  // Valid actions but missing required data (e.g., split without workItems)
  return { decision: 'allow' };
}

async function handleAgentError(
  config: WatcherAgentConfig,
  ctx: StopHookContext
): Promise<StopHookResult> {
  // Get workitem-level context
  const workItemLog = ctx.workId ? await config.getWorkItemLog(ctx.workId) : null;
  const workItemLogPath = workItemLog?.filePath() ?? 'not available';

  const snapshotContext = formatSnapshotForTrigger('bounds_exceeded', ctx);

  const objective = `You are the watcher for session ${config.sessionId}.

## Session Context
- **Salience**: ${config.salienceFilePath} — session goal, principles
- **Work Log**: ${config.workLog.filePath()} — all WorkItems status

## WorkItem Context (the agent that errored)
- **WorkItem Log**: ${workItemLogPath}
  Contains: FULL conversation, tool calls leading up to error
  **READ THIS** to understand what the agent was doing when it failed

The agent encountered an error: **${ctx.terminationReason}** (iteration ${ctx.iteration}).
${snapshotContext}

Your job:
1. **Read the workitem log** to understand the agent's actions leading to the error.
2. Diagnose whether this is recoverable (check tool history for what failed and why).
3. If recoverable: return action "realign" with a systemMessage containing fix instructions.
4. If not recoverable: return action "continue" to allow termination.`;

  const action = await runAndLog(config, 'agent_error', objective, ctx);

  // Log decision to workitem
  if (workItemLog) {
    await workItemLog.appendDecision(
      'agent_error',
      action.watcherAction,
      action.reason
    ).catch(err => {
      console.warn('[WATCHER] WorkItem decision log failed:', err instanceof Error ? err.message : String(err));
    });
  }

  if (action.watcherAction === 'realign' && action.realign) {
    return {
      decision: 'block',
      reason: action.realign.newGoal ?? `Fix: ${action.reason}`,
      systemMessage: action.realign.systemMessage,
    };
  }

  if (action.watcherAction === 'continue') {
    return { decision: 'allow' };
  }

  // Invalid actions for agent_error context
  // Valid actions: realign, continue
  return {
    decision: 'block',
    reason: 'Wrap up and report the error.',
    systemMessage: `[Watcher fallback — agent error]: Watcher returned "${action.watcherAction}" which is not valid for agent_error. Agent encountered ${ctx.terminationReason}. Wrap up and summarize the error.`,
  };
}

async function handleGoalReached(
  config: WatcherAgentConfig,
  ctx: StopHookContext
): Promise<StopHookResult> {
  // Get workitem-level context
  const workItemLog = ctx.workId ? await config.getWorkItemLog(ctx.workId) : null;
  const workItemLogPath = workItemLog?.filePath() ?? 'not available';

  // Write status to session-level work log (WorkItem completed)
  const snap = ctx.executionSnapshot;
  const agentSummary = snap?.fullResponse ?? ctx.response;
  await config.workLog.append({
    type: 'workitem_status',
    timestamp: new Date().toISOString(),
    workId: ctx.workId ?? 'unknown',
    status: 'completed',
    summary: agentSummary.slice(0, 200),
    durationMs: snap?.metrics.durationMs,
    filesModified: snap?.filesModified,
  }).catch(err => {
    console.warn('[WATCHER] Work log write failed (workitem_status):', err instanceof Error ? err.message : String(err));
  });

  const snapshotContext = formatSnapshotForTrigger('work_item_completed', ctx);

  const objective = `You are the watcher for session ${config.sessionId}.

## Session Context
- **Salience**: ${config.salienceFilePath} — session goal, principles
- **Work Log**: ${config.workLog.filePath()} — all WorkItems status

## WorkItem Context (the agent that completed)
- **WorkItem Log**: ${workItemLogPath}
  Contains: FULL conversation, tool calls, what the agent did
  **READ THIS** to understand the agent's complete journey and output

The agent reports goal_state_reached (iteration ${ctx.iteration}).
${snapshotContext}

Your job — quality gate:
1. Read the salience file for the session goal.
2. **Read the workitem log** to see the agent's full conversation and discoveries.
3. Verify the response actually addresses the goal (check files modified and the full response).
4. Check for obvious omissions, untested changes, or incomplete work.
5. If quality gate passes: return action "quality_gate" with passed=true.
6. If quality gate fails: return action "quality_gate" with passed=false and issues list.

### Parallelization
When creating follow-up work items, prefer INDEPENDENT items that run concurrently.
Only add dependencies for genuine data/ordering constraints.
Set generous bounds (maxToolCalls: 200, maxLlmCalls: 30, maxDurationMs: 300000).`;

  const action = await runAndLog(config, 'work_item_completed', objective, ctx);

  // Log decision to workitem
  if (workItemLog) {
    await workItemLog.appendDecision(
      'work_item_completed',
      action.watcherAction,
      action.reason
    ).catch(err => {
      console.warn('[WATCHER] WorkItem decision log failed:', err instanceof Error ? err.message : String(err));
    });
  }

  if (action.watcherAction === 'quality_gate' && action.qualityGate && !action.qualityGate.passed) {
    const issues = action.qualityGate.issues?.join('; ') ?? action.reason;
    return {
      decision: 'block',
      reason: `Quality gate failed. Fix these issues: ${issues}`,
      systemMessage: `[Watcher quality gate]: The following issues were found:\n${action.qualityGate.issues?.map(i => `- ${i}`).join('\n') ?? action.reason}`,
    };
  }

  // quality_gate with passed=true - allow termination
  if (action.watcherAction === 'quality_gate' && action.qualityGate && action.qualityGate.passed) {
    return { decision: 'allow' };
  }

  // If the watcher identified follow-up work items, dispatch them as deferred work
  if ((action.watcherAction === 'split' || action.watcherAction === 'create_work_item') && action.workItems?.length) {
    try {
      config.onCreateWorkItems?.(action.workItems);
    } catch (err) {
      console.warn('[WATCHER] onCreateWorkItems callback failed:', err instanceof Error ? err.message : String(err));
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

  // Invalid actions for work_item_completed context
  // Valid actions: quality_gate, split, create_work_item
  // If we can't verify quality, allow termination (safer than blocking)
  return { decision: 'allow' };
}

async function handleCadenceAudit(
  config: WatcherAgentConfig,
  ctx: StopHookContext
): Promise<StopHookResult> {
  // Get workitem-level context
  const workItemLog = ctx.workId ? await config.getWorkItemLog(ctx.workId) : null;
  const workItemLogPath = workItemLog?.filePath() ?? 'not available';

  const snapshotContext = formatSnapshotForTrigger('cadence_audit', ctx);

  const objective = `You are the watcher for session ${config.sessionId}.

## Session Context
- **Salience**: ${config.salienceFilePath} — session goal, principles
- **Work Log**: ${config.workLog.filePath()} — all WorkItems status

## WorkItem Context (the agent being audited)
- **WorkItem Log**: ${workItemLogPath}
  Contains: FULL conversation, tool calls, what the agent has been doing
  **READ THIS** to understand the agent's progress and detect drift/thrashing

This is a periodic cadence audit (every 3 minutes). The agent is still executing.
${snapshotContext}

Your job — progress check:
1. **Read the workitem log** to see what the agent has been doing.
2. Read the salience file for the session goal.
3. Check for drift: is the agent still working toward the session goal, or has it gone off-track?
4. Check for thrashing: is the agent repeating failed approaches or stuck in a loop?
5. If on track: return action "continue" with a brief assessment.
6. If drifting or thrashing: return action "realign" with a systemMessage refocusing the agent.
7. If work should be split: return action "split" with workItems to decompose the remaining work.`;

  const action = await runAndLog(config, 'cadence_audit', objective, ctx);

  // Write watcher assessment to session-level work log
  await config.workLog.append({
    type: 'note',
    timestamp: new Date().toISOString(),
    workId: ctx.workId,
    note: `[cadence audit] ${action.watcherAction}: ${action.reason}`,
    source: 'watcher',
  }).catch(err => {
    console.warn('[WATCHER] Work log write failed (cadence audit):', err instanceof Error ? err.message : String(err));
  });

  // Log decision to workitem
  if (workItemLog) {
    await workItemLog.appendDecision(
      'cadence_audit',
      action.watcherAction,
      action.reason
    ).catch(err => {
      console.warn('[WATCHER] WorkItem decision log failed:', err instanceof Error ? err.message : String(err));
    });
  }

  if (action.watcherAction === 'continue') {
    return { decision: 'allow' };
  }

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
    } catch (err) {
      console.warn('[WATCHER] onCreateWorkItems callback failed:', err instanceof Error ? err.message : String(err));
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

  // Invalid actions for cadence_audit context
  // Valid actions: continue, realign, split, create_work_item
  return {
    decision: 'allow',
  };
}

async function handleHandoffApproval(
  config: WatcherAgentConfig,
  ctx: StopHookContext
): Promise<StopHookResult> {
  // Get the handoffSpec from the stop hook context
  const handoffSpec = ctx.handoffSpec;
  if (!handoffSpec) {
    // No spec to review - allow (orchestrator will handle)
    return { decision: 'allow' };
  }

  // Get workitem-level context (the planning agent's work)
  const workItemLog = ctx.workId ? await config.getWorkItemLog(ctx.workId) : null;
  const workItemLogPath = workItemLog?.filePath() ?? 'not available';

  const objective = `You are the watcher for session ${config.sessionId}.

## Session Context
- **Salience**: ${config.salienceFilePath} — session goal, principles
- **Work Log**: ${config.workLog.filePath()} — all WorkItems status

## WorkItem Context (the planning agent's work)
- **WorkItem Log**: ${workItemLogPath}
  Contains: FULL conversation, tool calls, what the planner discovered
  **READ THIS** to understand the planning agent's reasoning and discoveries

The planning agent has produced a work breakdown and is requesting handoff to execution.

## Proposed Plan

\`\`\`json
${handoffSpec}
\`\`\`

## Your Task — Plan Review

1. Read the salience file to understand the session goal.
2. **Read the workitem log** to see what the planner discovered and why it proposed this plan.
3. Review the proposed work items:
   - Do they address the session goal?
   - Are the objectives specific and actionable?
   - Are dependencies correctly identified?
   - Is the scope reasonable (not too large)?
4. If the plan is acceptable: return action "continue" with your assessment.
5. If the plan needs revision: return action "realign" with specific feedback for the planner.

Guidelines:
- Approve plans that are reasonable, even if not perfect.
- Reject plans that are vague, overly complex, or miss the goal.
- Provide specific, actionable feedback when rejecting.`;

  const action = await runAndLog(config, 'handoff_approval', objective, ctx);

  // Log the handoff review to session-level work log
  await config.workLog.append({
    type: 'note',
    timestamp: new Date().toISOString(),
    workId: ctx.workId,
    note: `[handoff review] ${action.watcherAction}: ${action.reason}`,
    source: 'watcher',
  }).catch(err => {
    console.warn('[WATCHER] Work log write failed (handoff review):', err instanceof Error ? err.message : String(err));
  });

  // Log decision to workitem
  if (workItemLog) {
    await workItemLog.appendDecision(
      'handoff_approval',
      action.watcherAction,
      action.reason
    ).catch(err => {
      console.warn('[WATCHER] WorkItem decision log failed:', err instanceof Error ? err.message : String(err));
    });
  }

  // Watcher approved the plan
  if (action.watcherAction === 'continue') {
    return { decision: 'allow' };
  }

  // Watcher rejected with feedback - block so planner can revise
  if (action.watcherAction === 'realign' && action.realign) {
    return {
      decision: 'block',
      reason: action.realign.newGoal ?? `Revise plan: ${action.reason}`,
      systemMessage: action.realign.systemMessage,
    };
  }

  // Unexpected action - approve by default (safer to proceed than block indefinitely)
  return { decision: 'allow' };
}

// ============================================
// FALLBACK BEHAVIOR
// ============================================

/**
 * Determine the appropriate fallback action when the watcher fails or times out.
 * Different triggers have different safety requirements.
 */
function getFallbackAction(trigger: WatcherTrigger, error: Error, ctx: StopHookContext): WatcherAction {
  const errorMsg = error.message;

  switch (trigger) {
    case 'prompt_user':
      // MUST answer - use first option as fallback
      return {
        watcherAction: 'answer',
        answer: { text: 'Continue' },
        reason: `Watcher fallback (${errorMsg.slice(0, 50)}): Using default answer`,
      };

    case 'cadence_audit':
      // Don't terminate on oversight failure - let agent continue working
      return {
        watcherAction: 'continue',
        reason: `Oversight unavailable (${errorMsg.slice(0, 50)}): Agent continues`,
      };

    case 'bounds_exceeded':
      // Graceful degradation - tell agent to wrap up
      return {
        watcherAction: 'realign',
        realign: {
          systemMessage: `[Watcher unavailable] Resource bounds hit (${ctx.terminationReason}). Wrap up your current work and report what was accomplished.`,
        },
        reason: `Watcher fallback (${errorMsg.slice(0, 50)}): Requesting wrap-up`,
      };

    case 'agent_error':
      // Can't diagnose - allow termination but log
      return {
        watcherAction: 'continue',
        reason: `Watcher fallback (${errorMsg.slice(0, 50)}): Cannot diagnose error, allowing termination`,
      };

    case 'work_item_completed':
      // Can't verify quality - pass quality gate to allow termination
      return {
        watcherAction: 'quality_gate',
        qualityGate: { passed: true },
        reason: `Watcher fallback (${errorMsg.slice(0, 50)}): Quality gate skipped - allowing termination`,
      };

    case 'handoff_approval':
      // Can't review plan - approve by default (safer to proceed than block)
      return {
        watcherAction: 'continue',
        reason: `Watcher fallback (${errorMsg.slice(0, 50)}): Plan approved by default`,
      };

    case 'session_init':
    case 'scope_collision':
      // Non-critical triggers - allow termination
      return {
        watcherAction: 'continue',
        reason: `Watcher fallback (${errorMsg.slice(0, 50)})`,
      };

    default:
      return {
        watcherAction: 'continue',
        reason: `Watcher fallback (${errorMsg.slice(0, 50)})`,
      };
  }
}

// ============================================
// HELPERS
// ============================================

/**
 * Run the watcher agent with retry logic and append the result to the decision log.
 * Wraps execution with per-trigger timeout and exponential backoff on failure.
 */
async function runAndLog(
  config: WatcherAgentConfig,
  trigger: WatcherTrigger,
  objective: string,
  ctx: StopHookContext
): Promise<WatcherAction> {
  const baseTimeout = TIMEOUT_BY_TRIGGER[trigger] ?? config.watcherTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  let action: WatcherAction | null = null;
  let lastError: Error | null = null;

  // Retry loop with exponential backoff on timeout
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Increase timeout on each retry: base * (1, 1.5, 2)
    const timeout = Math.round(baseTimeout * (1 + attempt * 0.5));

    try {
      const agentPromise = config.runAgent(objective, trigger);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Watcher timeout after ${timeout}ms`)), timeout)
      );

      action = await Promise.race([agentPromise, timeoutPromise]);
      break; // Success - exit retry loop

    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < MAX_RETRIES) {
        console.warn(`[WATCHER] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for ${trigger}: ${lastError.message}. Retrying...`);
      } else {
        console.error(`[WATCHER] All ${MAX_RETRIES + 1} attempts failed for ${trigger}: ${lastError.message}`);
      }
    }
  }

  // If all retries failed, use trigger-specific fallback
  if (!action) {
    action = getFallbackAction(trigger, lastError ?? new Error('Unknown error'), ctx);
    console.warn(`[WATCHER] Using fallback for ${trigger}: ${action.watcherAction} - ${action.reason}`);
  } else {
    // Validate the action is valid for this trigger
    const validActions = getValidActions(trigger);
    if (validActions.length > 0 && !validActions.includes(action.watcherAction)) {
      console.warn(`[WATCHER] Invalid action "${action.watcherAction}" for trigger "${trigger}". Valid: [${validActions.join(', ')}]. Using fallback.`);
      action = getFallbackAction(trigger, new Error(`Invalid action: ${action.watcherAction}`), ctx);
    }
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
  } catch (err) {
    console.warn('[WATCHER] Decision log write failed:', err instanceof Error ? err.message : String(err));
  }

  try {
    config.onDecision?.(entry);
  } catch (err) {
    console.warn('[WATCHER] onDecision callback failed:', err instanceof Error ? err.message : String(err));
  }

  return action;
}
