/**
 * Watcher Agent - Control-plane hook implementation backed by an LLM agent.
 *
 * Routes orchestrator control events to trigger-specific handlers,
 * runs a watcher agent to evaluate the situation, and returns structured
 * decisions via control-plane hooks.
 *
 * Core mechanism: protocol decisions and patches drive orchestrator behavior.
 */

import {
  assertNever,
  createHook,
  type AgentErrorDecision,
  type BoundsDecision,
  type CadenceDecision,
  type ControlEvent,
  type DecisionFor,
  type DecisionRequiredEvent,
  type EventFor,
  type HandoffDecision,
  type Hook,
  type HookContext,
  type HookOutcome,
  type PromptAnswerDecision,
  type QualityGateDecision,
  type StatePatch,
  type TerminationReason,
  type WorkItemCompletedDecision,
  type WorkItemSpec,
  failed,
  isAgentError,
  isBoundsExceeded,
  isCadenceAudit,
  isGoalReached,
  isHandoffRequested,
  isUserInputRequired,
  isWorkItemCompleted,
  success,
} from 'protocol';
import type { WatcherAction, WatcherTrigger, DecisionLogEntry, WatcherWorkItem, WatcherActionType } from './types.js';
import { getValidActions } from './types.js';
import type { DecisionLog } from './decision-log.js';
import type { WorkLog } from './work-log.js';
import type { WorkItemLog } from './workitem-log.js';
import { appendSalienceObservation } from './salience.js';
import {
  extractPreProcessedContext,
  formatPreProcessedContext,
  writeSemanticFileAsync,
  type SemanticWriteConfig,
} from './semantic/index.js';

// ============================================
// CONFIG
// ============================================

/** Default timeout increased to 90s - watcher needs time to read files + reason */
const DEFAULT_TIMEOUT_MS = 90_000;

/** Per-trigger timeout configuration - critical paths get more time */
const TIMEOUT_BY_TRIGGER: Record<WatcherTrigger, number> = {
  session_init: 120_000,       // Session bootstrap
  prompt_user: 120_000,        // Most critical - must answer user questions
  goal_state_reached: 90_000,  // Quality gate evaluation (goal reached)
  work_item_completed: 90_000, // Quality gate evaluation
  bounds_exceeded: 150_000,    // May need to realign or split work
  cadence_audit: 120_000,      // Periodic check
  agent_error: 150_000,        // Error diagnosis needs context
  scope_collision: 120_000,    // Concurrency conflict resolution
  handoff_approval: 90_000,    // Plan review - needs time to read spec
};

/** Max retries before giving up */
type InFlightWatcher = {
  runPromise: Promise<WatcherAction>;
  visiblePromise: Promise<WatcherAction>;
  startedAt: number;
};

const IN_FLIGHT_WATCHERS = new Map<string, InFlightWatcher>();

function normalizeWatcherAction(action: WatcherAction): WatcherAction {
  if (action.watcherAction !== 'continue') return action;
  return { ...action, watcherAction: 'allow' } as WatcherAction;
}

function isNoInterventionAction(action: WatcherActionType): boolean {
  return action === 'allow' || action === 'continue';
}

/** Max workitem log content to inject (prevent prompt bloat for very long sessions) */
const MAX_WORKITEM_LOG_INJECT_LENGTH = 50000;
const WORK_ITEM_ID_GUIDANCE = 'When returning workItems, include a stable "id" for each item and use those ids in "dependencies" when sequencing is required.';

// ============================================
// WORKITEM LOG FORMATTING FOR INJECTION
// ============================================

/**
 * Format workitem log entries for direct injection into watcher prompt.
 * This gives the watcher immediate access to the agent's reasoning and actions
 * without requiring file reads.
 */
async function formatWorkItemLogForInjection(workItemLog: WorkItemLog | null): Promise<string> {
  if (!workItemLog) {
    return '*WorkItem log not available*';
  }

  try {
    const entries = await workItemLog.readAll();
    if (entries.length === 0) {
      return '*WorkItem log is empty*';
    }

    const sections: string[] = [];

    // Init entry - objective and setup
    const init = entries.find(e => e.type === 'init');
    if (init && init.type === 'init') {
      sections.push(`**Objective**: ${init.objective}`);
      sections.push(`**Agent**: ${init.agent}`);
      if (init.cwd) sections.push(`**CWD**: ${init.cwd}`);
    }

    // Messages with reasoning - the core of what the watcher needs
    const messages = entries.filter(e => e.type === 'message');
    if (messages.length > 0) {
      sections.push('\n### Agent Conversation & Reasoning\n');
      for (const msg of messages) {
        if (msg.type !== 'message') continue;
        const roleLabel = msg.role === 'assistant' ? '**Assistant**' : msg.role === 'user' ? '**User**' : '**System**';

        // Include reasoning prominently if present
        if (msg.reasoning) {
          sections.push(`${roleLabel} (with reasoning):`);
          sections.push(`<reasoning>\n${msg.reasoning}\n</reasoning>`);
          sections.push(`<response>\n${msg.content}\n</response>\n`);
        } else {
          sections.push(`${roleLabel}: ${msg.content}\n`);
        }
      }
    }

    // Tool calls - show what the agent did
    const toolCalls = entries.filter(e => e.type === 'tool_call');
    if (toolCalls.length > 0) {
      sections.push('\n### Tool Calls\n');
      for (const tc of toolCalls) {
        if (tc.type !== 'tool_call') continue;
        const status = tc.success ? '✓' : '✗';
        const argsStr = JSON.stringify(tc.args, null, 2);
        sections.push(`${status} **${tc.tool}** (${tc.durationMs}ms)`);
        sections.push(`Args: \`\`\`json\n${argsStr}\n\`\`\``);
        if (tc.resultSummary) {
          sections.push(`Result: ${tc.resultSummary}`);
        }
        sections.push('');
      }
    }

    // Decisions - what the watcher previously decided for this workitem
    const decisions = entries.filter(e => e.type === 'decision');
    if (decisions.length > 0) {
      sections.push('\n### Prior Watcher Decisions\n');
      for (const dec of decisions) {
        if (dec.type !== 'decision') continue;
        sections.push(`- **${dec.trigger}** → ${dec.action}: ${dec.rationale}`);
        if (dec.question) sections.push(`  Question: "${dec.question}"`);
        if (dec.answer) sections.push(`  Answer: "${dec.answer}"`);
      }
    }

    // Metrics if available
    const metrics = entries.find(e => e.type === 'metrics');
    if (metrics && metrics.type === 'metrics') {
      sections.push('\n### Metrics\n');
      sections.push(`- Tool calls: ${metrics.toolCalls}`);
      sections.push(`- LLM calls: ${metrics.llmCalls}`);
      sections.push(`- Context used: ${(metrics.contextPercentUsed * 100).toFixed(1)}%`);
      sections.push(`- Duration: ${(metrics.durationMs / 1000).toFixed(1)}s`);
    }

    let result = sections.join('\n');

    // Truncate if too long (but with a generous limit)
    if (result.length > MAX_WORKITEM_LOG_INJECT_LENGTH) {
      result = result.slice(0, MAX_WORKITEM_LOG_INJECT_LENGTH) +
        `\n\n... [truncated ${result.length - MAX_WORKITEM_LOG_INJECT_LENGTH} chars - see full log at ${workItemLog.filePath()}]`;
    }

    return result;
  } catch (err) {
    return `*Error reading workitem log: ${err instanceof Error ? err.message : String(err)}*`;
  }
}

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
  runAgent: (objective: string, trigger: WatcherTrigger, signal?: AbortSignal) => Promise<WatcherAction>;
  /** Called when the watcher produces split/create_work_item actions. */
  onCreateWorkItems?: (items: WatcherWorkItem[]) => void;
  /** Called after every watcher decision for observability/debugging. */
  onDecision?: (entry: DecisionLogEntry) => void;
  /** Base timeout for watcher agent execution (default: 90000ms). Per-trigger timeouts take precedence. */
  watcherTimeoutMs?: number;
}

// ============================================
// CONTROL-PLANE HOOK FACTORY
// ============================================

interface WatcherContext<Evt extends ControlEvent = ControlEvent> {
  event: Evt;
  hook: HookContext;
}

function assertEventType<Evt extends ControlEvent>(
  event: ControlEvent,
  guard: (evt: ControlEvent) => evt is Evt,
  expected: Evt['type']
): asserts event is Evt {
  if (!guard(event)) {
    throw new Error(`[WATCHER] Expected ${expected} event, got ${event.type}`);
  }
}

function toTerminationReason(event: ControlEvent): TerminationReason {
  switch (event.type) {
    case 'goal_state_reached':
      return 'goal_state_reached';
    case 'bounds_exceeded':
      switch (event.boundType) {
        case 'iterations':
          return 'max_iterations_exceeded';
        case 'tool_calls':
          return 'max_tool_calls_exceeded';
        case 'duration':
          return 'max_duration_exceeded';
        default:
          return assertNever(event.boundType);
      }
    case 'user_input_required':
      return 'user_input_required';
    case 'cadence_audit':
      return 'cadence_audit';
    case 'agent_error':
      return event.errorType === 'exception' ? 'agent_error' : event.errorType;
    case 'handoff_requested':
      return 'handoff_requested';
    case 'work_item_completed':
      return 'goal_state_reached';
    case 'user_stopped':
      return 'user_stopped';
    case 'transient_error':
      // Cache discriminant so exhaustive switch doesn't narrow event to never.
      const errorType = event.errorType;
      switch (errorType) {
        case 'rate_limit':
          return 'rate_limit';
        case 'circuit_open':
          return 'circuit_open';
        case 'timeout':
          return 'timeout';
        default:
          return assertNever(errorType);
      }
    default:
      return assertNever(event);
  }
}

function toWorkItemSpecs(items: WatcherWorkItem[]): WorkItemSpec[] {
  if (!items || items.length === 0) return [];
  return items.map(item => ({
    id: item.id,
    goal: item.goal,
    objective: item.objective,
    agent: item.agent,
    dependencies: item.dependencies,
    targetPaths: item.targetPaths,
    bounds: item.bounds,
  }));
}

function injectGuidancePatch(message?: string): StatePatch[] | undefined {
  if (!message) return undefined;
  return [{ op: 'inject_guidance', content: message }];
}

export function createWatcherControlHooks(
  config: WatcherAgentConfig,
  sessionKey: string
): Array<Hook<ControlEvent, unknown>> {
  const base = {
    policy: { kind: 'retry_then_degrade', maxRetries: 1, backoffMs: 500, degradeTo: 'skip' } as const,
    criticality: 'critical' as const,
    idempotency: 'idempotent' as const,
    priority: 50,
    timeoutMs: 90_000,
  };

  const runHook = async <E extends DecisionRequiredEvent>(
    event: EventFor<E>,
    ctx: HookContext,
    handler: (wc: WatcherContext<EventFor<E>>) => Promise<{ decision: DecisionFor<E>; patches?: StatePatch[] }>
  ): Promise<HookOutcome<DecisionFor<E>>> => {
    if (event.sessionKey !== sessionKey) {
      return { kind: 'skip', reason: 'session_mismatch' };
    }
    try {
      const result = await handler({ event, hook: ctx });
      return success(result.decision, result.patches);
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
  };

  const makeHook = <E extends DecisionRequiredEvent>(
    eventType: E,
    handler: (wc: WatcherContext<EventFor<E>>) => Promise<{ decision: DecisionFor<E>; patches?: StatePatch[] }>
  ): Hook<EventFor<E>, DecisionFor<E>> => createHook(eventType, {
    ...base,
    id: `watcher:${sessionKey}:${eventType}`,
    run: (event, ctx) => runHook(event, ctx, handler),
  });

  // Cast for HookRegistry compatibility; makeHook enforces event/decision pairing.
  const hooks = [
    makeHook('goal_state_reached', (wc) =>
      handleGoalReached(config, wc)
    ),
    makeHook('bounds_exceeded', (wc) =>
      handleBoundsExceeded(config, wc)
    ),
    makeHook('user_input_required', (wc) =>
      handlePromptUser(config, wc)
    ),
    makeHook('cadence_audit', (wc) =>
      handleCadenceAudit(config, wc)
    ),
    makeHook('agent_error', (wc) =>
      handleAgentError(config, wc)
    ),
    makeHook('handoff_requested', (wc) =>
      handleHandoffApproval(config, wc)
    ),
    makeHook('work_item_completed', (wc) =>
      handleWorkItemCompleted(config, wc)
    ),
  ] as Array<Hook<ControlEvent, unknown>>;

  return hooks;
}

// ============================================
// SNAPSHOT FORMATTING (trigger-aware)
// ============================================

/**
 * Format for goal_state_reached: WHAT happened, not HOW.
 * No tool call history — agent finished; tool replay is noise.
 */
function formatGoalReachedContext(ctx: WatcherContext): string {
  const { event, hook } = ctx;
  const metrics = 'metrics' in event ? event.metrics : hook.metrics;
  const filesModified = 'filesModified' in event ? event.filesModified : hook.filesModified;
  const response = 'response' in event ? event.response : '';

  const sections: string[] = [];

  sections.push(`### Execution Summary
- Duration: ${(metrics.durationMs / 1000).toFixed(1)}s | Tool calls: ${metrics.toolCallsMade} | Context: ${(metrics.contextPercentUsed * 100).toFixed(0)}% used`);

  if (filesModified.length > 0) {
    sections.push(`### Files Modified (${filesModified.length})
${filesModified.map(f => `- ${f}`).join('\n')}`);
  }

  const responsePreview = response.length > 3000
    ? response.slice(0, 3000) + '\n... [truncated]'
    : response;
  if (responsePreview) {
    sections.push(`### Agent Response
${responsePreview}`);
  }

  const recentMessages = hook.recentMessages.slice(-2).map(m => `- ${m.role}: ${m.content.slice(0, 200)}`);
  if (recentMessages.length > 0) {
    sections.push(`### Recent Messages
${recentMessages.join('\n')}`);
  }

  return '\n' + sections.join('\n\n');
}

/**
 * Full context for bounds_exceeded and agent_error — includes everything available.
 */
function formatFullContext(ctx: WatcherContext): string {
  const { event, hook } = ctx;
  const metrics = 'metrics' in event ? event.metrics : hook.metrics;
  const filesModified = 'filesModified' in event ? event.filesModified : hook.filesModified;
  const response = 'response' in event ? event.response : '';

  const sections: string[] = [];

  sections.push(`### Execution Metrics
- LLM calls: ${metrics.llmCalls} | Tool calls: ${metrics.toolCallsMade}
- Duration: ${(metrics.durationMs / 1000).toFixed(1)}s | Context: ${(metrics.contextPercentUsed * 100).toFixed(0)}% used`);

  if (filesModified.length > 0) {
    sections.push(`### Files Modified (${filesModified.length})
${filesModified.map(f => `- ${f}`).join('\n')}`);
  }

  const responsePreview = response.length > 3000
    ? response.slice(0, 3000) + '\n... [truncated]'
    : response;
  if (responsePreview) {
    sections.push(`### Agent Response
${responsePreview}`);
  }

  const recentMessages = hook.recentMessages.slice(-4).map(m => `- ${m.role}: ${m.content.slice(0, 200)}`);
  if (recentMessages.length > 0) {
    sections.push(`### Recent Messages
${recentMessages.join('\n')}`);
  }

  return '\n' + sections.join('\n\n');
}

/**
 * Medium-depth context for cadence audits — metrics + files + brief response.
 */
function formatCadenceContext(ctx: WatcherContext): string {
  const { event, hook } = ctx;
  const metrics = 'metrics' in event ? event.metrics : hook.metrics;
  const filesModified = 'filesModified' in event ? event.filesModified : hook.filesModified;
  const response = 'response' in event ? event.response : '';

  const sections: string[] = [];

  sections.push(`### Execution Metrics
- LLM calls: ${metrics.llmCalls} | Tool calls: ${metrics.toolCallsMade}
- Duration: ${(metrics.durationMs / 1000).toFixed(1)}s | Context: ${(metrics.contextPercentUsed * 100).toFixed(0)}% used`);

  if (filesModified.length > 0) {
    sections.push(`### Files Modified (${filesModified.length})
${filesModified.map(f => `- ${f}`).join('\n')}`);
  }

  if (event.type === 'cadence_audit') {
    sections.push(`### Recent Activity
${event.recentActivity}`);
  }

  const responsePreview = response.length > 500
    ? response.slice(0, 500) + '\n... [truncated]'
    : response;
  if (responsePreview) {
    sections.push(`### Agent Response (preview)
${responsePreview}`);
  }

  return '\n' + sections.join('\n\n');
}

/**
 * Dispatcher: select the right formatter based on trigger type.
 */
function formatSnapshotForTrigger(trigger: WatcherTrigger, ctx: WatcherContext): string {
  switch (trigger) {
    case 'goal_state_reached':
    case 'work_item_completed':
      return formatGoalReachedContext(ctx);
    case 'cadence_audit':
      return formatCadenceContext(ctx);
    case 'bounds_exceeded':
    case 'prompt_user':
      return formatFullContext(ctx);
    case 'agent_error':
    case 'handoff_approval':
    case 'session_init':
    case 'scope_collision':
      return formatFullContext(ctx);
    default:
      return assertNever(trigger);
  }
}

function buildWatcherObjective(params: {
  config: WatcherAgentConfig;
  ctx: WatcherContext;
  workItemLogContent: string;
  snapshotContext: string;
  taskText: string;
  headerLines?: string[];
}): string {
  const { config, ctx, workItemLogContent, snapshotContext, taskText, headerLines } = params;
  const workId = ctx.event.workId ?? 'unknown';
  const headerBlock = headerLines && headerLines.length > 0 ? `${headerLines.join('\n')}\n\n` : '';

  return `You are the watcher for session ${config.sessionId}.

${headerBlock}## Session Context
- **Salience**: ${config.salienceFilePath} (read for session goal and principles)
- **Work Log**: ${config.workLog.filePath()} (read for other workitems status)

## WorkItem Context (WorkItem: ${workId})

The following is the FULL context of the agent's activity for this work item:

<workitem-log>
${workItemLogContent}
</workitem-log>

${snapshotContext}

${taskText}`;
}

// ============================================
// HANDLERS
// ============================================

async function handlePromptUser(
  config: WatcherAgentConfig,
  ctx: WatcherContext
): Promise<{ decision: PromptAnswerDecision; patches?: StatePatch[] }> {
  const { event } = ctx;
  assertEventType(event, isUserInputRequired, 'user_input_required');

  const prompt = event.prompt;
  const questionText = prompt?.question ?? 'Unknown question';
  const optionsText = prompt?.options
    ? `\nOptions: ${JSON.stringify(prompt.options)}`
    : '';

  // Detect potentially ambiguous questions for logging
  const ambiguousPatterns = [
    /what (should|would|could) .+ (do|prioritize|focus|work)/i,
    /what (does|means).+ (value|goal|objective)/i,
    /which (direction|path|way).+ (should|to)/i,
    /how (can|do i) .+ provide/i,
  ];
  const isAmbiguous = ambiguousPatterns.some(pattern => pattern.test(questionText));

  if (isAmbiguous && !prompt?.options?.length) {
    console.warn(`[WATCHER] prompt_user: Potentially ambiguous question without options: "${questionText.slice(0, 100)}..."`);
    // Add observation to salience
    await appendSalienceObservation(config.salienceFilePath, {
      trigger: 'prompt_user',
      action: 'ambiguous_question_detected',
      workId: event.workId,
      summary: `Ambiguous prompt_user question detected: "${questionText.slice(0, 80)}". Consider providing specific options.`,
    }).catch(err => {
      console.warn('[WATCHER] Salience update failed:', err instanceof Error ? err.message : String(err));
    });
  }

  // Get workitem-level context (full conversation, tool calls, scoped decisions)
  const workItemLog = event.workId ? await config.getWorkItemLog(event.workId) : null;
  const workItemLogContent = await formatWorkItemLogForInjection(workItemLog);

  const snapshotContext = formatSnapshotForTrigger('prompt_user', ctx);

  const taskText = `## Question from Agent

**Question**: ${questionText}${optionsText}
**Agent Context**: ${prompt?.context ?? 'none'}

## Your Task

**You MUST answer with \`watcherAction: "answer"\`.** There is no user available in async mode.

## Answering Guidelines

1. **Use the workitem context above** to understand WHY the agent is asking this question.
2. **Specific options questions**: Pick the option that best aligns with the session goal.
3. **Open-ended questions**: Reinterpret based on session goal; if asking "what should I do", tell them to continue with best judgment unless you see a problem in their reasoning above.
4. **Default behavior**: Return \`watcherAction: "answer"\` with "Continue with your best judgment."

## Format Requirements

Your response MUST include:
- \`watcherAction: "answer"\` (always)
- \`answer.text: <your answer text>\` (always)
- \`reason: <why you chose this>\` (required)

**Invalid actions for prompt_user**: \`escalate\`, \`quality_gate\`, \`allow\` (use "answer" for all)

Read salience for session goal, then answer based on both the goal AND the agent's situation shown above.`;

  const objective = buildWatcherObjective({
    config,
    ctx,
    workItemLogContent,
    snapshotContext,
    taskText,
  });

  const action = await runAndLog(config, 'prompt_user', objective, ctx);

  // Log decision to workitem (scoped) in addition to global decision log
  if (workItemLog && action.watcherAction === 'answer') {
    await workItemLog.appendDecision(
      'prompt_user',
      action.watcherAction,
      action.reason,
      questionText,
      action.answer.text
    ).catch(err => {
      console.warn('[WATCHER] WorkItem decision log failed:', err instanceof Error ? err.message : String(err));
    });
  }

  if (action.watcherAction === 'answer') {
    return {
      decision: {
        action: 'answer',
        text: action.answer.text,
        confidence: 0.7,
        contextAddendum: action.answer.contextAddendum,
      },
    };
  }

  // Watcher failed to provide a proper 'answer' action.
  // Check if the watcher's reason contains useful guidance we can use as an answer.
  const watcherReason = action.reason;
  const hasUsefulReason = watcherReason.length > 20 &&
    !watcherReason.includes('timeout') &&
    !watcherReason.includes('error') &&
    !watcherReason.includes('fallback');

  // If watcher produced reasoning that looks like an actual answer, use it
  if (hasUsefulReason) {
    console.warn(`[WATCHER] prompt_user: Watcher returned "${action.watcherAction}" instead of "answer", but has useful reason. Using reason as answer.`);
    return {
      decision: {
        action: 'answer',
        text: watcherReason,
        confidence: 0.5,
        contextAddendum: `Watcher returned action "${action.watcherAction}" but provided usable guidance.`,
      },
    };
  }

  // Watcher truly failed - use default answer
  const defaultAnswer = prompt?.options?.[0]
    ? (typeof prompt.options[0] === 'string' ? prompt.options[0] : (prompt.options[0] as { label?: string }).label ?? 'Continue')
    : 'Continue with your best judgment.';

  console.error(`[WATCHER] prompt_user: Watcher failed to answer. Action: "${action.watcherAction}", Reason: "${watcherReason.slice(0, 100)}". Using default: "${defaultAnswer}"`);

  return {
    decision: {
      action: 'answer',
      text: defaultAnswer,
      confidence: 0.4,
      contextAddendum: `[Watcher fallback]: action="${action.watcherAction}" reason="${watcherReason.slice(0, 120)}"`,
    },
  };
}

async function handleBoundsExceeded(
  config: WatcherAgentConfig,
  ctx: WatcherContext
): Promise<{ decision: BoundsDecision; patches?: StatePatch[] }> {
  const { event } = ctx;
  assertEventType(event, isBoundsExceeded, 'bounds_exceeded');

  const workItemLog = event.workId ? await config.getWorkItemLog(event.workId) : null;
  const workItemLogContent = await formatWorkItemLogForInjection(workItemLog);

  const snapshotContext = formatSnapshotForTrigger('bounds_exceeded', ctx);

  const taskText = `The agent has hit a resource bound: **${event.boundType}** (current ${event.current} / limit ${event.limit}).

## Your Task

Based on the workitem log above, assess:
1. Was the agent making meaningful progress?
2. Is the work too broad to complete within bounds?

### Actions (prefer "split" over "realign")

- **"split"** (PREFERRED): Decompose remaining work into focused work items
  - Use when: goal is vague, work can be parallelized, agent was exploring aimlessly
  - Each item: SPECIFIC objective, INDEPENDENT when possible, bounds: {maxToolCalls: 200, maxLlmCalls: 30, maxDurationMs: 300000}

- **"realign"** (USE SPARINGLY): Give agent one more chance
  - Only if agent made real progress and just needs a nudge to finish
  - Max 3 realigns enforced by orchestrator

${WORK_ITEM_ID_GUIDANCE}`;

  const objective = buildWatcherObjective({
    config,
    ctx,
    workItemLogContent,
    snapshotContext,
    taskText,
  });

  const action = await runAndLog(config, 'bounds_exceeded', objective, ctx);

  if (workItemLog) {
    await workItemLog.appendDecision(
      'bounds_exceeded',
      action.watcherAction,
      action.reason
    ).catch(err => {
      console.warn('[WATCHER] WorkItem decision log failed:', err instanceof Error ? err.message : String(err));
    });
  }

  switch (action.watcherAction) {
    case 'split':
    case 'create_work_item':
      return { decision: { action: 'split', workItems: toWorkItemSpecs(action.workItems) } };

    case 'realign':
      return {
        decision: { action: 'realign', guidance: action.realign.systemMessage },
        patches: injectGuidancePatch(action.realign.systemMessage),
      };

    case 'allow':
    case 'continue':
      return { decision: { action: 'wrap_up', summary: action.reason } };

    case 'answer':
    case 'quality_gate':
      return { decision: { action: 'abort', reason: action.reason } };

    default:
      return assertNever(action);
  }
}

async function handleAgentError(
  config: WatcherAgentConfig,
  ctx: WatcherContext
): Promise<{ decision: AgentErrorDecision; patches?: StatePatch[] }> {
  const { event } = ctx;
  assertEventType(event, isAgentError, 'agent_error');

  const workItemLog = event.workId ? await config.getWorkItemLog(event.workId) : null;
  const workItemLogContent = await formatWorkItemLogForInjection(workItemLog);

  const snapshotContext = formatSnapshotForTrigger('agent_error', ctx);

  const taskText = `The agent encountered an error: **${event.errorType}**.

## Your Task

Based on the workitem log above:
1. Diagnose what went wrong (check tool calls for failures)
2. If recoverable: return "realign" with fix instructions in systemMessage
3. If not recoverable: return "allow" to allow termination`;

  const objective = buildWatcherObjective({
    config,
    ctx,
    workItemLogContent,
    snapshotContext,
    taskText,
  });

  const action = await runAndLog(config, 'agent_error', objective, ctx);

  if (workItemLog) {
    await workItemLog.appendDecision(
      'agent_error',
      action.watcherAction,
      action.reason
    ).catch(err => {
      console.warn('[WATCHER] WorkItem decision log failed:', err instanceof Error ? err.message : String(err));
    });
  }

  switch (action.watcherAction) {
    case 'realign':
      return {
        decision: { action: 'retry', guidance: action.realign.systemMessage },
        patches: injectGuidancePatch(action.realign.systemMessage),
      };

    case 'allow':
    case 'continue':
    case 'answer':
    case 'split':
    case 'create_work_item':
    case 'quality_gate':
      return { decision: { action: 'abort', reason: action.reason } };

    default:
      return assertNever(action);
  }
}

async function handleGoalReached(
  config: WatcherAgentConfig,
  ctx: WatcherContext
): Promise<{ decision: QualityGateDecision; patches?: StatePatch[] }> {
  const { event } = ctx;
  assertEventType(event, isGoalReached, 'goal_state_reached');

  const workItemLog = event.workId ? await config.getWorkItemLog(event.workId) : null;
  const workItemLogContent = await formatWorkItemLogForInjection(workItemLog);

  await config.workLog.append({
    type: 'workitem_status',
    timestamp: new Date().toISOString(),
    workId: event.workId ?? 'unknown',
    status: 'completed',
    summary: event.response.slice(0, 200),
    durationMs: event.metrics.durationMs,
    filesModified: event.filesModified,
  }).catch(err => {
    console.warn('[WATCHER] Work log write failed (workitem_status):', err instanceof Error ? err.message : String(err));
  });

  const snapshotContext = formatSnapshotForTrigger('goal_state_reached', ctx);

  const taskText = `The agent reports goal_state_reached.

## Your Task — Quality Gate

Based on the workitem log above:
1. Does the work address the session goal? (read salience)
2. Check for obvious omissions, untested changes, or incomplete work
3. If quality gate passes: return "quality_gate" with passed=true
4. If quality gate fails: return "quality_gate" with passed=false and issues list

For follow-up work items, prefer INDEPENDENT items (parallelization).
Set bounds: {maxToolCalls: 200, maxLlmCalls: 30, maxDurationMs: 300000}

${WORK_ITEM_ID_GUIDANCE}`;

  const objective = buildWatcherObjective({
    config,
    ctx,
    workItemLogContent,
    snapshotContext,
    taskText,
  });

  const action = await runAndLog(config, 'goal_state_reached', objective, ctx);

  if (workItemLog) {
    await workItemLog.appendDecision(
      'goal_state_reached',
      action.watcherAction,
      action.reason
    ).catch(err => {
      console.warn('[WATCHER] WorkItem decision log failed:', err instanceof Error ? err.message : String(err));
    });
  }

  switch (action.watcherAction) {
    case 'quality_gate':
      if (action.qualityGate.passed) {
        return { decision: { verdict: 'passed' } };
      }
      return {
        decision: {
          verdict: 'failed',
          issues: action.qualityGate.issues ?? [action.reason],
        },
      };

    case 'allow':
    case 'continue':
    case 'answer':
    case 'realign':
    case 'split':
    case 'create_work_item':
      return {
        decision: {
          verdict: 'failed',
          issues: [action.reason],
        },
      };

    default:
      return assertNever(action);
  }
}

async function handleWorkItemCompleted(
  config: WatcherAgentConfig,
  ctx: WatcherContext
): Promise<{ decision: WorkItemCompletedDecision; patches?: StatePatch[] }> {
  const { event } = ctx;
  assertEventType(event, isWorkItemCompleted, 'work_item_completed');

  const workItemLog = event.workId ? await config.getWorkItemLog(event.workId) : null;
  const workItemLogContent = await formatWorkItemLogForInjection(workItemLog);

  await config.workLog.append({
    type: 'workitem_status',
    timestamp: new Date().toISOString(),
    workId: event.workId ?? 'unknown',
    status: event.success ? 'completed' : 'failed',
    summary: event.response.slice(0, 200),
    durationMs: event.metrics.durationMs,
    filesModified: event.filesModified,
  }).catch(err => {
    console.warn('[WATCHER] Work log write failed (workitem_status):', err instanceof Error ? err.message : String(err));
  });

  const snapshotContext = formatSnapshotForTrigger('work_item_completed', ctx);

  const taskText = `The agent completed a work item (success=${event.success}).

## Your Task — Work Item Review

Based on the workitem log above:
1. Should the work item be accepted?
2. If issues remain, prefer split/create work items with bounded scope.
3. If recoverable: return "realign" with guidance

${WORK_ITEM_ID_GUIDANCE}`;

  const objective = buildWatcherObjective({
    config,
    ctx,
    workItemLogContent,
    snapshotContext,
    taskText,
  });

  const action = await runAndLog(config, 'work_item_completed', objective, ctx);

  if (workItemLog) {
    await workItemLog.appendDecision(
      'work_item_completed',
      action.watcherAction,
      action.reason
    ).catch(err => {
      console.warn('[WATCHER] WorkItem decision log failed:', err instanceof Error ? err.message : String(err));
    });
  }

  switch (action.watcherAction) {
    case 'split':
    case 'create_work_item': {
      try {
        config.onCreateWorkItems?.(action.workItems);
      } catch (err) {
        console.warn('[WATCHER] onCreateWorkItems callback failed:', err instanceof Error ? err.message : String(err));
      }
      return { decision: { action: 'split', workItems: toWorkItemSpecs(action.workItems) } };
    }

    case 'realign':
      return {
        decision: { action: 'retry', guidance: action.realign.systemMessage },
        patches: injectGuidancePatch(action.realign.systemMessage),
      };

    case 'quality_gate':
      if (action.qualityGate.passed) {
        return { decision: { action: 'accept', summary: action.reason } };
      }
      return {
        decision: { action: 'retry', guidance: action.qualityGate.issues?.join('\n') ?? action.reason },
      };

    case 'allow':
    case 'continue':
    case 'answer':
      return { decision: { action: 'accept', summary: action.reason } };

    default:
      return assertNever(action);
  }
}

async function handleCadenceAudit(
  config: WatcherAgentConfig,
  ctx: WatcherContext
): Promise<{ decision: CadenceDecision; patches?: StatePatch[] }> {
  const { event } = ctx;
  assertEventType(event, isCadenceAudit, 'cadence_audit');

  const workItemLog = event.workId ? await config.getWorkItemLog(event.workId) : null;
  const workItemLogContent = await formatWorkItemLogForInjection(workItemLog);

  // Pre-process deterministic facts from workitem log
  let preprocessedContext = '';
  let workItemCreated = new Date().toISOString();
  if (workItemLog) {
    try {
      const preprocessed = await extractPreProcessedContext(workItemLog);
      preprocessedContext = formatPreProcessedContext(preprocessed);
      // Extract created timestamp from init entry if available
      const entries = await workItemLog.readAll();
      const initEntry = entries.find(e => e.type === 'init');
      if (initEntry?.type === 'init') {
        workItemCreated = initEntry.timestamp;
      }
    } catch (err) {
      console.warn('[WATCHER] Pre-processing failed:', err instanceof Error ? err.message : String(err));
    }
  }

  const snapshotContext = formatSnapshotForTrigger('cadence_audit', ctx);

  const taskText = `This is a periodic cadence audit. The agent is still executing.

${preprocessedContext ? `<preprocessed-facts>\n${preprocessedContext}\n</preprocessed-facts>\n` : ''}## Your Task — Progress Check AND Semantic Generation

Based on the workitem log above:
1. Is the agent making progress toward the session goal? (read salience)
2. Check for drift (off-topic work), thrashing (repeating failed approaches), or stalling

### Actions (in order of preference)

1. **"split"** — PREFERRED when goal is too broad or agent is stalling
   - Create 2-4 SPECIFIC, SCOPED work items that can run in parallel
   - bounds: {maxToolCalls: 200, maxLlmCalls: 30, maxDurationMs: 300000}

2. **"realign"** — Use when agent made progress but drifted

3. **"allow"** — Use when agent is clearly on track with productive progress

${WORK_ITEM_ID_GUIDANCE}

### Semantic Output (REQUIRED)

In addition to your decision, you MUST produce a \`semantic\` field with your understanding of:

1. **stateAndProgress**: Current state of work
   - objective: The workItem objective
   - currentState: Array of {component, status: complete|partial|not_started|blocked, location?}
   - changesMade: Array of {file, summary, rationale}
   - gapAnalysis: Array of {required, current, blocker?}
   - reasoningTrace: Numbered steps of agent decision-making
   - blockers: Array of blockers preventing progress

2. **decisionContext**: Context for future decisions
   - pendingQuestions: Questions awaiting response
   - tradeoffs: Array of trade-off analyses with options and considerations

3. **crossReferences**: Links to related context
   - preferences: Relevant preference keys
   - siblingWorkItems: Related workItem IDs
   - decisions: Related decision keys

4. **meta**: Metadata
   - auditSequence: (use 0 for first audit, increment for subsequent)
   - logPosition: Number of events processed
   - totalEvents: Total events in log`;

  const objective = buildWatcherObjective({
    config,
    ctx,
    workItemLogContent,
    snapshotContext,
    taskText,
  });

  const action = await runAndLog(config, 'cadence_audit', objective, ctx);

  // Fire-and-forget semantic write (non-blocking)
  if (event.workId && 'semantic' in action && action.semantic) {
    const writeConfig: SemanticWriteConfig = {
      workingDir: config.workingDir,
      sessionId: config.sessionId,
      workId: event.workId,
    };
    writeSemanticFileAsync(writeConfig, action.semantic, workItemCreated);
  }

  await config.workLog.append({
    type: 'note',
    timestamp: new Date().toISOString(),
    workId: event.workId,
    note: `[cadence audit] ${action.watcherAction}: ${action.reason}`,
    source: 'watcher',
  }).catch(err => {
    console.warn('[WATCHER] Work log write failed (cadence audit):', err instanceof Error ? err.message : String(err));
  });

  if (workItemLog) {
    await workItemLog.appendDecision(
      'cadence_audit',
      action.watcherAction,
      action.reason
    ).catch(err => {
      console.warn('[WATCHER] WorkItem decision log failed:', err instanceof Error ? err.message : String(err));
    });
  }

  switch (action.watcherAction) {
    case 'allow':
    case 'continue': {
      const hasUsefulGuidance = action.reason.length > 20;
      if (hasUsefulGuidance) {
        return { decision: { action: 'inject_guidance', message: action.reason } };
      }
      return { decision: { action: 'continue' } };
    }

    case 'realign':
      return {
        decision: { action: 'realign', guidance: action.realign.systemMessage },
        patches: injectGuidancePatch(action.realign.systemMessage),
      };

    case 'split':
    case 'create_work_item': {
      try {
        config.onCreateWorkItems?.(action.workItems);
      } catch (err) {
        console.warn('[WATCHER] onCreateWorkItems callback failed:', err instanceof Error ? err.message : String(err));
      }
      return { decision: { action: 'split', workItems: toWorkItemSpecs(action.workItems) } };
    }

    case 'answer':
    case 'quality_gate':
      return { decision: { action: 'continue' } };

    default:
      return assertNever(action);
  }
}

async function handleHandoffApproval(
  config: WatcherAgentConfig,
  ctx: WatcherContext
): Promise<{ decision: HandoffDecision; patches?: StatePatch[] }> {
  const { event } = ctx;
  assertEventType(event, isHandoffRequested, 'handoff_requested');

  const handoffSpec = event.handoffSpec;
  if (!handoffSpec) {
    return { decision: { action: 'approve' } };
  }
  const handoffSpecText = JSON.stringify(handoffSpec, null, 2);

  const workItemLog = event.workId ? await config.getWorkItemLog(event.workId) : null;
  const workItemLogContent = await formatWorkItemLogForInjection(workItemLog);

  const snapshotContext = formatSnapshotForTrigger('handoff_approval', ctx);

  const taskText = `The planning agent has produced a work breakdown and is requesting handoff to execution.

## Proposed Plan

\`\`\`json
${handoffSpecText}
\`\`\`

## Your Task — Plan Review

Based on the planner's reasoning above and the proposed plan:
1. Do the work items address the session goal? (read salience)
2. Are objectives specific and actionable?
3. Are dependencies correctly identified?
4. Is the scope reasonable?

If acceptable: return "allow"
If needs revision: return "realign" with specific feedback

Guidelines:
- Approve plans that are reasonable, even if not perfect.
- Reject plans that are vague, overly complex, or miss the goal.
- Provide specific, actionable feedback when rejecting.`;

  const objective = buildWatcherObjective({
    config,
    ctx,
    workItemLogContent,
    snapshotContext,
    taskText,
  });

  const action = await runAndLog(config, 'handoff_approval', objective, ctx);

  await config.workLog.append({
    type: 'note',
    timestamp: new Date().toISOString(),
    workId: event.workId,
    note: `[handoff review] ${action.watcherAction}: ${action.reason}`,
    source: 'watcher',
  }).catch(err => {
    console.warn('[WATCHER] Work log write failed (handoff review):', err instanceof Error ? err.message : String(err));
  });

  if (workItemLog) {
    await workItemLog.appendDecision(
      'handoff_approval',
      action.watcherAction,
      action.reason
    ).catch(err => {
      console.warn('[WATCHER] WorkItem decision log failed:', err instanceof Error ? err.message : String(err));
    });
  }

  switch (action.watcherAction) {
    case 'allow':
    case 'continue':
      return { decision: { action: 'approve' } };

    case 'realign':
      return {
        decision: { action: 'modify', changes: action.realign.systemMessage },
        patches: injectGuidancePatch(action.realign.systemMessage),
      };

    case 'answer':
    case 'split':
    case 'create_work_item':
    case 'quality_gate':
      return { decision: { action: 'approve' } };

    default:
      return assertNever(action);
  }
}

// ============================================
// FALLBACK BEHAVIOR
// ============================================

/**
 * Determine the appropriate fallback action when the watcher fails or times out.
 * Different triggers have different safety requirements.
 */
function getFallbackAction(trigger: WatcherTrigger, error: Error, ctx: WatcherContext): WatcherAction {
  const errorMsg = error.message;
  const terminationReason = toTerminationReason(ctx.event);

  switch (trigger) {
    case 'prompt_user':
      // MUST answer - use first option as fallback when available
      if (ctx.event.type === 'user_input_required') {
        const options = ctx.event.prompt.options;
        if (options && options.length > 0) {
          const first = options[0];
          const text = typeof first === 'string' ? first : first.label ?? 'Continue';
          return {
            watcherAction: 'answer',
            answer: { text },
            reason: `Watcher fallback (${errorMsg.slice(0, 50)}): Using first option`,
          };
        }
      }
      return {
        watcherAction: 'answer',
        answer: { text: 'Continue' },
        reason: `Watcher fallback (${errorMsg.slice(0, 50)}): Using default answer`,
      };

    case 'cadence_audit':
      // Don't terminate on oversight failure - let agent continue working
      return {
        watcherAction: 'allow',
        reason: `Oversight unavailable (${errorMsg.slice(0, 50)}): Agent continues`,
      };

    case 'bounds_exceeded':
      // Graceful degradation - tell agent to wrap up
      return {
        watcherAction: 'realign',
        realign: {
          systemMessage: `[Watcher unavailable] Resource bounds hit (${terminationReason}). Wrap up your current work and report what was accomplished.`,
        },
        reason: `Watcher fallback (${errorMsg.slice(0, 50)}): Requesting wrap-up`,
      };

    case 'agent_error':
      // Can't diagnose - allow termination but log
      return {
        watcherAction: 'allow',
        reason: `Watcher fallback (${errorMsg.slice(0, 50)}): Cannot diagnose ${terminationReason}, allowing termination`,
      };

    case 'goal_state_reached':
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
        watcherAction: 'allow',
        reason: `Watcher fallback (${errorMsg.slice(0, 50)}): Plan approved by default`,
      };

    case 'session_init':
    case 'scope_collision':
      // Non-critical triggers - allow termination
      return {
        watcherAction: 'allow',
        reason: `Watcher fallback (${errorMsg.slice(0, 50)})`,
      };

    default:
      return assertNever(trigger);
  }
}

// ============================================
// HELPERS
// ============================================

/**
 * Run the watcher agent with retry logic and append the result to the decision log.
 * Wraps execution with per-trigger timeout and a single in-flight guard to
 * prevent concurrent watcher runs for the same trigger/work item.
 */
async function runAndLog(
  config: WatcherAgentConfig,
  trigger: WatcherTrigger,
  objective: string,
  ctx: WatcherContext
): Promise<WatcherAction> {
  const baseTimeout = TIMEOUT_BY_TRIGGER[trigger] ?? config.watcherTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const inFlightKey = `${ctx.event.sessionKey}:${ctx.event.workId}:${trigger}`;
  const existing = IN_FLIGHT_WATCHERS.get(inFlightKey);
  if (existing) {
    return existing.visiblePromise;
  }

  const timeout = baseTimeout;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let runPromise: Promise<WatcherAction>;
  const controller = new AbortController();

  const cleanupInFlight = () => {
    const entry = IN_FLIGHT_WATCHERS.get(inFlightKey);
    if (entry?.runPromise === runPromise) {
      IN_FLIGHT_WATCHERS.delete(inFlightKey);
    }
  };

  runPromise = (async () => {
    try {
      return await config.runAgent(objective, trigger, controller.signal);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[WATCHER] Agent run failed for ${trigger}: ${error.message}`);
      return getFallbackAction(trigger, error, ctx);
    }
  })();

  const visiblePromise = Promise.race([
    runPromise,
    new Promise<WatcherAction>((resolve) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        resolve(getFallbackAction(trigger, new Error(`Watcher timeout after ${timeout}ms`), ctx));
      }, timeout);
    }),
  ]).then((rawAction) => {
    const action = normalizeWatcherAction(rawAction);
    // Validate the action is valid for this trigger
    const validActions = getValidActions(trigger);
    if (validActions.length > 0 && !validActions.includes(action.watcherAction)) {
      console.warn(`[WATCHER] Invalid action "${action.watcherAction}" for trigger "${trigger}". Valid: [${validActions.join(', ')}]. Using fallback.`);
      return getFallbackAction(trigger, new Error(`Invalid action: ${action.watcherAction}`), ctx);
    }
    return action;
  }).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    cleanupInFlight();
  });

  IN_FLIGHT_WATCHERS.set(inFlightKey, { runPromise, visiblePromise, startedAt: Date.now() });
  void runPromise.finally(() => {
    cleanupInFlight();
  });

  const action = await visiblePromise;

  // Build execution metrics from hook context for audit trail
  const executionMetrics = {
    toolCallsMade: ctx.hook.metrics.toolCallsMade,
    filesModified: [...ctx.hook.filesModified],
    durationMs: ctx.hook.metrics.durationMs,
    contextPercentUsed: ctx.hook.metrics.contextPercentUsed,
  };

  const entry: DecisionLogEntry = {
    timestamp: new Date().toISOString(),
    trigger,
    watcherAction: action.watcherAction,
    question: ctx.event.type === 'user_input_required' ? ctx.event.prompt.question : undefined,
    answer: action.watcherAction === 'answer' ? action.answer.text : undefined,
    rationale: action.reason,
    workItemId: ctx.event.workId,
    qualityGate: action.watcherAction === 'quality_gate' ? action.qualityGate : undefined,
    executionMetrics,
  };

  try {
    await config.decisionLog.append(entry);
  } catch (err) {
    console.warn('[WATCHER] Decision log write failed:', err instanceof Error ? err.message : String(err));
  }

  // Write observation to salience file for memory continuity
  // Only write significant decisions (not routine continues or fallbacks)
  const shouldWriteToSalience = !isNoInterventionAction(action.watcherAction) ||
    trigger === 'prompt_user' ||
    trigger === 'work_item_completed' ||
    trigger === 'goal_state_reached';

  if (shouldWriteToSalience) {
    const summary = buildObservationSummary(trigger, action, ctx);
    await appendSalienceObservation(config.salienceFilePath, {
      trigger,
      action: action.watcherAction,
      workId: ctx.event.workId,
      summary,
    }).catch(err => {
      console.warn('[WATCHER] Salience update failed:', err instanceof Error ? err.message : String(err));
    });
  }

  try {
    config.onDecision?.(entry);
  } catch (err) {
    console.warn('[WATCHER] onDecision callback failed:', err instanceof Error ? err.message : String(err));
  }

  return action;
}

/**
 * Build a human-readable summary of the watcher observation for salience.
 */
function buildObservationSummary(
  trigger: WatcherTrigger,
  action: WatcherAction,
  ctx: WatcherContext
): string {
  const parts: string[] = [];

  switch (trigger) {
    case 'prompt_user':
      if (ctx.event.type === 'user_input_required') {
        parts.push(`Agent asked: "${ctx.event.prompt.question.slice(0, 100)}"`);
      }
      if (action.watcherAction === 'answer') {
        parts.push(`Answered: "${action.answer.text.slice(0, 150)}"`);
      }
      break;

    case 'goal_state_reached':
    case 'work_item_completed':
      if (action.watcherAction === 'quality_gate') {
        if (action.qualityGate.passed) {
          parts.push('Quality gate passed.');
        } else if (action.qualityGate.issues?.length) {
          parts.push(`Quality issues: ${action.qualityGate.issues.slice(0, 3).join('; ')}`);
        }
      }
      if (ctx.hook.filesModified.length) {
        parts.push(`Modified: ${ctx.hook.filesModified.slice(0, 3).join(', ')}`);
      }
      break;

    case 'bounds_exceeded':
      if (ctx.event.type === 'bounds_exceeded') {
        parts.push(`Hit ${ctx.event.boundType} at ${ctx.event.current}/${ctx.event.limit}.`);
      }
      if (action.watcherAction === 'split' || action.watcherAction === 'create_work_item') {
        parts.push(`Split into ${action.workItems.length} work items.`);
      } else if (action.watcherAction === 'realign') {
        parts.push('Realigned with guidance.');
      }
      break;

    case 'cadence_audit':
      parts.push(`Progress check at iteration ${ctx.hook.iteration}.`);
      break;

    case 'agent_error':
      if (ctx.event.type === 'agent_error') {
        parts.push(`Error: ${ctx.event.errorType}`);
      }
      break;

    case 'handoff_approval':
      parts.push(isNoInterventionAction(action.watcherAction) ? 'Plan approved.' : 'Plan needs revision.');
      break;

    case 'session_init':
    case 'scope_collision':
      break;

    default:
      return assertNever(trigger);
  }

  if (action.reason && action.reason.length < 200) {
    parts.push(action.reason);
  }

  return parts.join(' ') || 'Decision recorded.';
}
