import type { WorkItemSpec } from './state.js';

export type QualityGateDecision =
  | { verdict: 'passed' }
  | { verdict: 'failed'; issues: string[] }
  | { verdict: 'needs_human'; concerns: string[] };

export function isQualityPassed(d: QualityGateDecision): d is { verdict: 'passed' } {
  return d.verdict === 'passed';
}

export function isQualityFailed(d: QualityGateDecision): d is { verdict: 'failed'; issues: string[] } {
  return d.verdict === 'failed';
}

export type BoundsDecision =
  | { action: 'realign'; guidance: string }
  | { action: 'split'; workItems: WorkItemSpec[] }
  | { action: 'wrap_up'; summary: string }
  | { action: 'abort'; reason: string };

export function isBoundsRealign(d: BoundsDecision): d is { action: 'realign'; guidance: string } {
  return d.action === 'realign';
}

export function isBoundsSplit(d: BoundsDecision): d is { action: 'split'; workItems: WorkItemSpec[] } {
  return d.action === 'split';
}

export type PromptAnswerDecision =
  | { action: 'answer'; text: string; confidence: number; contextAddendum?: string }
  | { action: 'escalate'; reason: string }
  | { action: 'defer'; to: 'user' | 'ops' };

export function isPromptAnswer(d: PromptAnswerDecision): d is { action: 'answer'; text: string; confidence: number; contextAddendum?: string } {
  return d.action === 'answer';
}

export type CadenceDecision =
  | { action: 'continue' }
  | { action: 'inject_guidance'; message: string }
  | { action: 'realign'; guidance: string; newWork?: WorkItemSpec }
  | { action: 'split'; workItems: WorkItemSpec[] }
  | { action: 'stop'; reason: string }
  | { action: 'stop_work_item'; reason: string };

export function isCadenceContinue(d: CadenceDecision): d is { action: 'continue' } {
  return d.action === 'continue';
}

export function isCadenceStop(d: CadenceDecision): d is { action: 'stop'; reason: string } {
  return d.action === 'stop';
}

export function isCadenceStopWorkItem(
  d: CadenceDecision
): d is { action: 'stop_work_item'; reason: string } {
  return d.action === 'stop_work_item';
}

export type AgentErrorDecision =
  | { action: 'retry'; guidance: string }
  | { action: 'abort'; reason: string }
  | { action: 'escalate'; to: 'user' | 'ops' };

export function isErrorRetry(d: AgentErrorDecision): d is { action: 'retry'; guidance: string } {
  return d.action === 'retry';
}

export type WorkItemCompletedDecision =
  | { action: 'accept'; summary: string }
  | { action: 'retry'; guidance: string }
  | { action: 'split'; workItems: WorkItemSpec[] }
  | { action: 'escalate'; to: 'user' | 'ops'; reason: string };

export function isWorkItemAccepted(d: WorkItemCompletedDecision): d is { action: 'accept'; summary: string } {
  return d.action === 'accept';
}

export type AnyDecision =
  | QualityGateDecision
  | BoundsDecision
  | PromptAnswerDecision
  | CadenceDecision
  | AgentErrorDecision
  | WorkItemCompletedDecision;

export function serializeDecision(decision: AnyDecision): string {
  return JSON.stringify(decision);
}

export function summarizeDecision(decision: AnyDecision): string {
  if ('verdict' in decision) {
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
      case 'retry': return 'Retrying with guidance';
      case 'accept': return 'Work item accepted';
    }
  }

  return 'Unknown decision';
}
