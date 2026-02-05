/**
 * Protocol Prompts - Generated Prompt Snippets
 *
 * Generates prompt snippets from schemas for LLM consumption.
 * Ensures prompts stay in sync with type definitions.
 */

import type { ControlEventType } from '../domain/events.js';
import {
  type DecisionFor,
  type DecisionRequiredEvent,
  DECISION_CONTROL_BY_EVENT,
  requiresDecision,
} from '../control/gates.js';
import {
  QualityGateDecisionSchema,
  BoundsDecisionSchema,
  PromptAnswerDecisionSchema,
  CadenceDecisionSchema,
  AgentErrorDecisionSchema,
  HandoffDecisionSchema,
  WorkItemCompletedDecisionSchema,
} from './schemas.js';
import { prompt, type Prompt, type Validator } from 'prompt-protocol';

const zodValidator = <T>(schema: {
  parse: (input: unknown) => T;
  safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: unknown };
}): Validator<T> => ({
  parse: (input) => schema.parse(input),
  safeParse: (input) => schema.safeParse(input),
});

// ============================================
// DECISION PROMPTS BY EVENT TYPE
// ============================================

/**
 * Get the prompt snippet describing valid decisions for an event type.
 */
export function getDecisionPrompt(eventType: ControlEventType): string {
  if (!requiresDecision(eventType)) return '';
  return DECISION_PROMPT_BY_EVENT[eventType].text;
}

// ============================================
// PROMPT TEMPLATES
// ============================================

const QUALITY_GATE_PROMPT = `
You must return a quality gate decision with one of these verdicts:
- { "verdict": "passed" } - Work meets quality standards
- { "verdict": "failed", "issues": ["issue1", "issue2"] } - Work has quality issues
- { "verdict": "needs_human", "concerns": ["concern1"] } - Requires human review

Consider:
- Does the work fulfill the stated objective?
- Are there any obvious errors or omissions?
- Does it follow the project's patterns and conventions?
`.trim();

const BOUNDS_DECISION_PROMPT = `
The agent has exceeded resource bounds. Choose one action:
- { "action": "realign", "guidance": "..." } - Provide guidance to refocus
- { "action": "split", "workItems": [...] } - Split into smaller work items
- { "action": "wrap_up", "summary": "..." } - Conclude with current progress
- { "action": "abort", "reason": "..." } - Abort the work item

Consider:
- How much progress has been made?
- Can the work be meaningfully split?
- Is the agent stuck or just slow?
`.trim();

const PROMPT_ANSWER_PROMPT = `
The agent is asking for user input. Choose one action:
- { "action": "answer", "text": "...", "confidence": 0.0-1.0 } - Provide an answer
- { "action": "escalate", "reason": "..." } - Escalate to human
- { "action": "defer", "to": "user" | "ops" } - Defer the question

Consider:
- Do existing decisions or preferences cover this question?
- How confident can you be in the answer?
- Is this a policy decision that needs human input?
`.trim();

const CADENCE_DECISION_PROMPT = `
Periodic audit of agent progress. Choose one action:
- { "action": "continue" } - Agent is on track
- { "action": "inject_guidance", "message": "..." } - Add helpful guidance
- { "action": "realign", "guidance": "..." } - Redirect the agent
- { "action": "split", "workItems": [...] } - Split the work
- { "action": "stop", "reason": "..." } - Stop the agent

Consider:
- Is the agent making progress toward the goal?
- Is it going in circles or stuck?
- Are there signs of scope creep?
`.trim();

const AGENT_ERROR_PROMPT = `
The agent encountered an error. Choose one action:
- { "action": "retry", "guidance": "..." } - Retry with guidance
- { "action": "abort", "reason": "..." } - Abort the work item
- { "action": "escalate", "to": "user" | "ops" } - Escalate to human

Consider:
- Is this error recoverable?
- Has the same error occurred repeatedly?
- Does the error indicate a fundamental problem?
`.trim();

const HANDOFF_DECISION_PROMPT = `
The planner is requesting handoff. Choose one action:
- { "action": "approve" } - Approve the handoff
- { "action": "reject", "feedback": "..." } - Reject with feedback
- { "action": "modify", "changes": "..." } - Approve with modifications

Consider:
- Is the plan reasonable and achievable?
- Are the work items well-defined?
- Are there obvious gaps or issues?
`.trim();

const WORK_ITEM_COMPLETED_PROMPT = `
A work item has completed. Choose one action:
- { "action": "accept", "summary": "..." } - Accept the result
- { "action": "retry", "guidance": "..." } - Retry with guidance
- { "action": "split", "workItems": [...] } - Split for additional work
- { "action": "escalate", "to": "user" | "ops", "reason": "..." } - Escalate

Consider:
- Did the work item achieve its objective?
- Are there follow-up tasks needed?
- Were there any issues during execution?
`.trim();

// ============================================
// PROMPT-PROTOCOL PROMPTS
// ============================================

export const QUALITY_GATE_DECISION_PROMPT = prompt({
  id: 'decision.quality_gate.v1',
  text: QUALITY_GATE_PROMPT,
  output: zodValidator(QualityGateDecisionSchema),
  control: DECISION_CONTROL_BY_EVENT.goal_state_reached,
});

export const BOUNDS_DECISION_PROTOCOL_PROMPT = prompt({
  id: 'decision.bounds.v1',
  text: BOUNDS_DECISION_PROMPT,
  output: zodValidator(BoundsDecisionSchema),
  control: DECISION_CONTROL_BY_EVENT.bounds_exceeded,
});

export const PROMPT_ANSWER_DECISION_PROMPT = prompt({
  id: 'decision.prompt_answer.v1',
  text: PROMPT_ANSWER_PROMPT,
  output: zodValidator(PromptAnswerDecisionSchema),
  control: DECISION_CONTROL_BY_EVENT.user_input_required,
});

export const CADENCE_DECISION_PROTOCOL_PROMPT = prompt({
  id: 'decision.cadence.v1',
  text: CADENCE_DECISION_PROMPT,
  output: zodValidator(CadenceDecisionSchema),
  control: DECISION_CONTROL_BY_EVENT.cadence_audit,
});

export const AGENT_ERROR_DECISION_PROMPT = prompt({
  id: 'decision.agent_error.v1',
  text: AGENT_ERROR_PROMPT,
  output: zodValidator(AgentErrorDecisionSchema),
  control: DECISION_CONTROL_BY_EVENT.agent_error,
});

export const HANDOFF_DECISION_PROTOCOL_PROMPT = prompt({
  id: 'decision.handoff.v1',
  text: HANDOFF_DECISION_PROMPT,
  output: zodValidator(HandoffDecisionSchema),
  control: DECISION_CONTROL_BY_EVENT.handoff_requested,
});

export const WORK_ITEM_COMPLETED_DECISION_PROMPT = prompt({
  id: 'decision.work_item_completed.v1',
  text: WORK_ITEM_COMPLETED_PROMPT,
  output: zodValidator(WorkItemCompletedDecisionSchema),
  control: DECISION_CONTROL_BY_EVENT.work_item_completed,
});

export type DecisionPrompt<E extends DecisionRequiredEvent> = Prompt<
  DecisionFor<E>,
  (typeof DECISION_CONTROL_BY_EVENT)[E]
>;

export const DECISION_PROMPT_BY_EVENT = {
  'goal_state_reached': QUALITY_GATE_DECISION_PROMPT,
  'bounds_exceeded': BOUNDS_DECISION_PROTOCOL_PROMPT,
  'user_input_required': PROMPT_ANSWER_DECISION_PROMPT,
  'cadence_audit': CADENCE_DECISION_PROTOCOL_PROMPT,
  'agent_error': AGENT_ERROR_DECISION_PROMPT,
  'handoff_requested': HANDOFF_DECISION_PROTOCOL_PROMPT,
  'work_item_completed': WORK_ITEM_COMPLETED_DECISION_PROMPT,
} as const satisfies { [E in DecisionRequiredEvent]: DecisionPrompt<E> };

// ============================================
// FULL PROMPT GENERATION
// ============================================

/**
 * Generate a full watcher prompt for an event.
 */
export function generateWatcherPrompt(
  eventType: ControlEventType,
  context: {
    objective: string;
    recentActivity: string;
    metrics: {
      toolCalls: number;
      duration: number;
      filesModified: number;
    };
  }
): string {
  const decisionPrompt = getDecisionPrompt(eventType);
  if (!decisionPrompt) {
    return ''; // No decision needed for this event
  }

  return `
## Context

**Objective:** ${context.objective}

**Recent Activity:**
${context.recentActivity}

**Metrics:**
- Tool calls: ${context.metrics.toolCalls}
- Duration: ${context.metrics.duration}ms
- Files modified: ${context.metrics.filesModified}

## Event Type: ${eventType}

${decisionPrompt}

## Response Format

Return valid JSON matching the decision schema above.
`.trim();
}

// ============================================
// SCHEMA DOCUMENTATION
// ============================================

/**
 * Get documentation for all decision types.
 */
export function getDecisionDocumentation(): string {
  return `
# Control Plane Decision Types

## QualityGateDecision
Used for: goal_state_reached, work_item_completed
${QUALITY_GATE_PROMPT}

## BoundsDecision
Used for: bounds_exceeded
${BOUNDS_DECISION_PROMPT}

## PromptAnswerDecision
Used for: user_input_required
${PROMPT_ANSWER_PROMPT}

## CadenceDecision
Used for: cadence_audit
${CADENCE_DECISION_PROMPT}

## AgentErrorDecision
Used for: agent_error
${AGENT_ERROR_PROMPT}

## HandoffDecision
Used for: handoff_requested
${HANDOFF_DECISION_PROMPT}
`.trim();
}
