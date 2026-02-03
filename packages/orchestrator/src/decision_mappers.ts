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
  CadenceDecision,
  AgentErrorDecision,
  HandoffDecision,
  WorkItemCompletedDecision,
  StopHookResult,
  DeferredWorkItem,
} from 'protocol';
import { assertNever } from 'protocol';

/**
 * Helper to convert work items to deferred work format.
 */
function mapWorkItemsToDeferredWork(
  workItems: Array<{
    id?: string;
    goal: string;
    objective: string;
    agent: string;
    dependencies?: string[];
    targetPaths?: string[];
    bounds?: { maxToolCalls?: number; maxLlmCalls?: number; maxDurationMs?: number };
  }>
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
      return { decision: 'block', reason: decision.issues.join('\n') };
    case 'needs_human':
      return { decision: 'block', reason: decision.concerns.join('\n') };
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
 * Map cadence audit decision to stop result.
 */
export function mapCadenceDecisionToStopResult(decision: CadenceDecision): StopHookResult {
  switch (decision.action) {
    case 'continue':
      return { decision: 'allow' };
    case 'inject_guidance':
      return { decision: 'allow', systemMessage: decision.message };
    case 'realign':
      return { decision: 'block', reason: decision.guidance };
    case 'split':
      return { decision: 'allow', deferredWork: mapWorkItemsToDeferredWork(decision.workItems) };
    case 'stop':
      return { decision: 'allow', systemMessage: decision.reason };
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
 * Map handoff decision to stop result.
 */
export function mapHandoffDecisionToStopResult(decision: HandoffDecision): StopHookResult {
  switch (decision.action) {
    case 'approve':
      return { decision: 'allow' };
    case 'reject':
      return { decision: 'block', reason: decision.feedback };
    case 'modify':
      return { decision: 'block', reason: decision.changes };
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
