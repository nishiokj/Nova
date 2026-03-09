/**
 * Decision Mappers - Convert hook decisions to StopHookResult format.
 *
 * Extracts mapper logic from Orchestrator class for cleaner separation.
 * Each mapper handles a specific decision type from control hooks.
 */

import type {
  QualityGateDecision,
  BoundsDecision,
  PromptAnswerDecision,

  AgentErrorDecision,
  WorkItemCompletedDecision,
} from './control-plane/index.js';
import type { StopHookResult, DeferredWorkItem } from 'types';
import { assertNever } from 'types';

/**
 * Helper to convert work items to deferred work format.
 */
function mapWorkItemsToDeferredWork(
  workItems: {
    id?: string;
    goal: string;
    objective: string;
    agent: string;
    dependencies?: string[];
    targetPaths?: string[];
    bounds?: { maxToolCalls?: number; maxLlmCalls?: number; maxDurationMs?: number };
    semantic?: unknown;
  }[]
): DeferredWorkItem[] {
  return workItems.map(item => ({
    id: item.id,
    goal: item.goal,
    objective: item.objective,
    agent: item.agent,
    background: true,
    dependencies: item.dependencies,
    targetPaths: item.targetPaths,
    bounds: item.bounds,
    semantic: item.semantic,
  }));
}

/**
 * Map quality gate decision to stop result.
 */
export function mapQualityDecisionToStopResult(decision: QualityGateDecision): StopHookResult {
  switch (decision.verdict) {
    case 'passed':
      return { decision: 'allow' };
    case 'failed':
      return { decision: 'block', reason: decision.issues.join('\n') || 'Quality gate failed' };
    case 'needs_human':
      return { decision: 'block', reason: decision.concerns.join('\n') || 'Quality gate requires human review' };
    default:
      return assertNever(decision);
  }
}

/**
 * Map bounds exceeded decision to stop result.
 */
export function mapBoundsDecisionToStopResult(decision: BoundsDecision): StopHookResult {
  switch (decision.action) {
    case 'realign':
      return { decision: 'block', reason: decision.guidance };
    case 'split':
      return { decision: 'allow', deferredWork: mapWorkItemsToDeferredWork(decision.workItems) };
    case 'wrap_up':
      return { decision: 'allow', systemMessage: decision.summary };
    case 'abort':
      return { decision: 'allow', systemMessage: decision.reason };
    default:
      return assertNever(decision);
  }
}

/**
 * Map prompt answer decision to stop result.
 */
export function mapPromptDecisionToStopResult(decision: PromptAnswerDecision): StopHookResult {
  switch (decision.action) {
    case 'answer':
      return {
        decision: 'block',
        reason: decision.text,
        systemMessage: decision.contextAddendum,
      };
    case 'escalate':
    case 'defer':
      return { decision: 'allow' };
    default:
      return assertNever(decision);
  }
}

/**
 * Map agent error decision to stop result.
 */
export function mapAgentErrorDecisionToStopResult(decision: AgentErrorDecision): StopHookResult {
  switch (decision.action) {
    case 'retry':
      return { decision: 'block', reason: decision.guidance };
    case 'abort':
    case 'escalate':
      return { decision: 'allow' };
    default:
      return assertNever(decision);
  }
}

/**
 * Map work item completed decision to stop result.
 */
export function mapWorkItemDecisionToStopResult(decision: WorkItemCompletedDecision): StopHookResult {
  switch (decision.action) {
    case 'accept':
      return { decision: 'allow' };
    case 'retry':
      return { decision: 'block', reason: decision.guidance };
    case 'split':
      return { decision: 'allow', deferredWork: mapWorkItemsToDeferredWork(decision.workItems) };
    case 'escalate':
      return { decision: 'allow' };
    default:
      return assertNever(decision);
  }
}
