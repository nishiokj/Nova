/**
 * Decision Types - Discriminated Unions
 *
 * Each hook trigger has its own decision type.
 * These are the domain-specific outcomes that hooks produce.
 */

import type { WorkItemSpec } from '../domain/state.js';
import { assertNever } from '../assertNever.js';

// ============================================
// QUALITY GATE (goal_state_reached, work_item_completed)
// ============================================

/**
 * Decision for quality gate evaluation.
 * Determines whether the agent's work meets quality standards.
 */
export type QualityGateDecision =
  | { verdict: 'passed' }
  | { verdict: 'failed'; issues: string[] }
  | { verdict: 'needs_human'; concerns: string[] };

/**
 * Type guard for passed quality gate.
 */
export function isQualityPassed(d: QualityGateDecision): d is { verdict: 'passed' } {
  return d.verdict === 'passed';
}

/**
 * Type guard for failed quality gate.
 */
export function isQualityFailed(d: QualityGateDecision): d is { verdict: 'failed'; issues: string[] } {
  return d.verdict === 'failed';
}

// ============================================
// BOUNDS EXCEEDED (max_iterations, max_tool_calls, max_duration)
// ============================================

/**
 * Decision for bounds exceeded scenarios.
 * Determines how to handle resource limits being hit.
 */
export type BoundsDecision =
  | { action: 'realign'; guidance: string }
  | { action: 'split'; workItems: WorkItemSpec[] }
  | { action: 'wrap_up'; summary: string }
  | { action: 'abort'; reason: string };

/**
 * Type guard for realign action.
 */
export function isBoundsRealign(d: BoundsDecision): d is { action: 'realign'; guidance: string } {
  return d.action === 'realign';
}

/**
 * Type guard for split action.
 */
export function isBoundsSplit(d: BoundsDecision): d is { action: 'split'; workItems: WorkItemSpec[] } {
  return d.action === 'split';
}

// ============================================
// PROMPT ANSWER (user_input_required)
// ============================================

/**
 * Decision for user input prompts.
 * Determines how to answer when the agent asks for user input.
 */
export type PromptAnswerDecision =
  | { action: 'answer'; text: string; confidence: number; contextAddendum?: string }
  | { action: 'escalate'; reason: string }
  | { action: 'defer'; to: 'user' | 'ops' };

/**
 * Type guard for answer action.
 */
export function isPromptAnswer(d: PromptAnswerDecision): d is { action: 'answer'; text: string; confidence: number; contextAddendum?: string } {
  return d.action === 'answer';
}

// ============================================
// CADENCE AUDIT (periodic check)
// ============================================

/**
 * Decision for cadence audit.
 * Periodic oversight of agent progress.
 */
export type CadenceDecision =
  | { action: 'continue' }
  | { action: 'inject_guidance'; message: string }
  | { action: 'realign'; guidance: string; newWork?: WorkItemSpec }
  | { action: 'split'; workItems: WorkItemSpec[] }
  | { action: 'stop'; reason: string }
  | { action: 'stop_work_item'; reason: string };

/**
 * Type guard for continue action.
 */
export function isCadenceContinue(d: CadenceDecision): d is { action: 'continue' } {
  return d.action === 'continue';
}

/**
 * Type guard for stop action.
 */
export function isCadenceStop(d: CadenceDecision): d is { action: 'stop'; reason: string } {
  return d.action === 'stop';
}

/**
 * Type guard for stop_work_item action.
 */
export function isCadenceStopWorkItem(
  d: CadenceDecision
): d is { action: 'stop_work_item'; reason: string } {
  return d.action === 'stop_work_item';
}

// ============================================
// AGENT ERROR (agent_error, invalid_action, no_action, stagnation)
// ============================================

/**
 * Decision for agent errors.
 * Determines how to handle agent misbehavior.
 */
export type AgentErrorDecision =
  | { action: 'retry'; guidance: string }
  | { action: 'abort'; reason: string }
  | { action: 'escalate'; to: 'user' | 'ops' };

/**
 * Type guard for retry action.
 */
export function isErrorRetry(d: AgentErrorDecision): d is { action: 'retry'; guidance: string } {
  return d.action === 'retry';
}

// ============================================
// WORK ITEM COMPLETED
// ============================================

/**
 * Decision for completed work items.
 * Determines what to do after a work item finishes.
 */
export type WorkItemCompletedDecision =
  | { action: 'accept'; summary: string }
  | { action: 'retry'; guidance: string }
  | { action: 'split'; workItems: WorkItemSpec[] }
  | { action: 'escalate'; to: 'user' | 'ops'; reason: string };

/**
 * Type guard for accept action.
 */
export function isWorkItemAccepted(d: WorkItemCompletedDecision): d is { action: 'accept'; summary: string } {
  return d.action === 'accept';
}

// ============================================
// UNION OF ALL DECISIONS
// ============================================

/**
 * Union of all possible decisions.
 * Used when the decision type is not known statically.
 */
export type AnyDecision =
  | QualityGateDecision
  | BoundsDecision
  | PromptAnswerDecision
  | CadenceDecision
  | AgentErrorDecision
  | WorkItemCompletedDecision;

// ============================================
// DECISION SERIALIZATION
// ============================================

/**
 * Serialize a decision for logging/storage.
 */
export function serializeDecision(decision: AnyDecision): string {
  return JSON.stringify(decision);
}

/**
 * Get a human-readable summary of a decision.
 */
export function summarizeDecision(decision: AnyDecision): string {
  if ('verdict' in decision) {
    // QualityGateDecision
    switch (decision.verdict) {
      case 'passed': return 'Quality gate passed';
      case 'failed': return `Quality gate failed: ${decision.issues.join(', ')}`;
      case 'needs_human': return `Needs human review: ${decision.concerns.join(', ')}`;
    }
  }

  if ('action' in decision) {
    switch (decision.action) {
      case 'realign': return `Realigning: ${(decision as { guidance: string }).guidance}`;
      case 'split': return `Splitting into ${(decision as { workItems: WorkItemSpec[] }).workItems.length} work items`;
      case 'wrap_up': return `Wrapping up: ${(decision as { summary: string }).summary}`;
      case 'abort': return `Aborting: ${(decision as { reason: string }).reason}`;
      case 'answer': return `Answering with confidence ${(decision as PromptAnswerDecision & { action: 'answer' }).confidence}`;
      case 'escalate': return `Escalating to ${(decision as { to: string }).to}`;
      case 'defer': return `Deferring to ${(decision as { to: string }).to}`;
      case 'continue': return 'Continuing';
      case 'inject_guidance': return 'Injecting guidance';
      case 'stop': return `Stopping: ${(decision as { reason: string }).reason}`;
      case 'stop_work_item': return `Stopping work item: ${(decision as { reason: string }).reason}`;
      case 'retry': return `Retrying with guidance`;
      case 'accept': return 'Work item accepted';
    }
  }

  return 'Unknown decision';
}
