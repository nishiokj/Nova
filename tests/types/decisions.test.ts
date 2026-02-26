/**
 * Tests for protocol decision types, type guards, and serialization.
 *
 * Covers: all type guards, serializeDecision, summarizeDecision (every branch).
 */

import {
  isQualityPassed,
  isQualityFailed,
  isBoundsRealign,
  isBoundsSplit,
  isPromptAnswer,
  isCadenceContinue,
  isCadenceStop,
  isCadenceStopWorkItem,
  isErrorRetry,
  isWorkItemAccepted,
  serializeDecision,
  summarizeDecision,
  type QualityGateDecision,
  type BoundsDecision,
  type PromptAnswerDecision,
  type CadenceDecision,
  type AgentErrorDecision,
  type WorkItemCompletedDecision,
} from 'protocol/control/decisions.js';

// =========================================================================
// QualityGateDecision type guards
// =========================================================================

describe('QualityGateDecision guards', () => {
  it('isQualityPassed identifies passed', () => {
    const d: QualityGateDecision = { verdict: 'passed' };
    expect(isQualityPassed(d)).toBe(true);
    expect(isQualityFailed(d)).toBe(false);
  });

  it('isQualityFailed identifies failed', () => {
    const d: QualityGateDecision = { verdict: 'failed', issues: ['lint error'] };
    expect(isQualityFailed(d)).toBe(true);
    expect(isQualityPassed(d)).toBe(false);
  });

  it('neither guard matches needs_human', () => {
    const d: QualityGateDecision = { verdict: 'needs_human', concerns: ['complex logic'] };
    expect(isQualityPassed(d)).toBe(false);
    expect(isQualityFailed(d)).toBe(false);
  });
});

// =========================================================================
// BoundsDecision type guards
// =========================================================================

describe('BoundsDecision guards', () => {
  it('isBoundsRealign identifies realign', () => {
    const d: BoundsDecision = { action: 'realign', guidance: 'focus on core' };
    expect(isBoundsRealign(d)).toBe(true);
    expect(isBoundsSplit(d)).toBe(false);
  });

  it('isBoundsSplit identifies split', () => {
    const d: BoundsDecision = {
      action: 'split',
      workItems: [{ goal: 'a', objective: 'b', agent: 'standard', dependencies: [] }],
    };
    expect(isBoundsSplit(d)).toBe(true);
    expect(isBoundsRealign(d)).toBe(false);
  });

  it('neither guard matches wrap_up', () => {
    const d: BoundsDecision = { action: 'wrap_up', summary: 'done' };
    expect(isBoundsRealign(d)).toBe(false);
    expect(isBoundsSplit(d)).toBe(false);
  });

  it('neither guard matches abort', () => {
    const d: BoundsDecision = { action: 'abort', reason: 'timeout' };
    expect(isBoundsRealign(d)).toBe(false);
    expect(isBoundsSplit(d)).toBe(false);
  });
});

// =========================================================================
// PromptAnswerDecision
// =========================================================================

describe('PromptAnswerDecision guards', () => {
  it('isPromptAnswer identifies answer', () => {
    const d: PromptAnswerDecision = { action: 'answer', text: 'yes', confidence: 0.9 };
    expect(isPromptAnswer(d)).toBe(true);
  });

  it('isPromptAnswer rejects escalate', () => {
    const d: PromptAnswerDecision = { action: 'escalate', reason: 'unsure' };
    expect(isPromptAnswer(d)).toBe(false);
  });

  it('isPromptAnswer rejects defer', () => {
    const d: PromptAnswerDecision = { action: 'defer', to: 'user' };
    expect(isPromptAnswer(d)).toBe(false);
  });
});

// =========================================================================
// CadenceDecision
// =========================================================================

describe('CadenceDecision guards', () => {
  it('isCadenceContinue identifies continue', () => {
    const d: CadenceDecision = { action: 'continue' };
    expect(isCadenceContinue(d)).toBe(true);
    expect(isCadenceStop(d)).toBe(false);
    expect(isCadenceStopWorkItem(d)).toBe(false);
  });

  it('isCadenceStop identifies stop', () => {
    const d: CadenceDecision = { action: 'stop', reason: 'stuck' };
    expect(isCadenceStop(d)).toBe(true);
    expect(isCadenceContinue(d)).toBe(false);
  });

  it('isCadenceStopWorkItem identifies stop_work_item', () => {
    const d: CadenceDecision = { action: 'stop_work_item', reason: 'no progress' };
    expect(isCadenceStopWorkItem(d)).toBe(true);
    expect(isCadenceStop(d)).toBe(false);
  });

  it('no guard matches inject_guidance', () => {
    const d: CadenceDecision = { action: 'inject_guidance', message: 'try another approach' };
    expect(isCadenceContinue(d)).toBe(false);
    expect(isCadenceStop(d)).toBe(false);
    expect(isCadenceStopWorkItem(d)).toBe(false);
  });
});

// =========================================================================
// AgentErrorDecision
// =========================================================================

describe('AgentErrorDecision guards', () => {
  it('isErrorRetry identifies retry', () => {
    const d: AgentErrorDecision = { action: 'retry', guidance: 'try again' };
    expect(isErrorRetry(d)).toBe(true);
  });

  it('isErrorRetry rejects abort', () => {
    const d: AgentErrorDecision = { action: 'abort', reason: 'fatal' };
    expect(isErrorRetry(d)).toBe(false);
  });

  it('isErrorRetry rejects escalate', () => {
    const d: AgentErrorDecision = { action: 'escalate', to: 'ops' };
    expect(isErrorRetry(d)).toBe(false);
  });
});

// =========================================================================
// WorkItemCompletedDecision
// =========================================================================

describe('WorkItemCompletedDecision guards', () => {
  it('isWorkItemAccepted identifies accept', () => {
    const d: WorkItemCompletedDecision = { action: 'accept', summary: 'all good' };
    expect(isWorkItemAccepted(d)).toBe(true);
  });

  it('isWorkItemAccepted rejects retry', () => {
    const d: WorkItemCompletedDecision = { action: 'retry', guidance: 'missed a test' };
    expect(isWorkItemAccepted(d)).toBe(false);
  });

  it('isWorkItemAccepted rejects escalate', () => {
    const d: WorkItemCompletedDecision = { action: 'escalate', to: 'user', reason: 'needs approval' };
    expect(isWorkItemAccepted(d)).toBe(false);
  });
});

// =========================================================================
// serializeDecision
// =========================================================================

describe('serializeDecision', () => {
  it('serializes to valid JSON', () => {
    const d: QualityGateDecision = { verdict: 'passed' };
    const json = serializeDecision(d);
    expect(JSON.parse(json)).toEqual({ verdict: 'passed' });
  });

  it('round-trips a complex decision', () => {
    const d: BoundsDecision = {
      action: 'split',
      workItems: [
        { goal: 'a', objective: 'b', agent: 'standard', dependencies: [] },
        { goal: 'c', objective: 'd', agent: 'planner', dependencies: ['a'] },
      ],
    };
    const json = serializeDecision(d);
    const parsed = JSON.parse(json);
    expect(parsed.workItems).toHaveLength(2);
    expect(parsed.workItems[1].dependencies).toEqual(['a']);
  });
});

// =========================================================================
// summarizeDecision — exhaustive branch coverage
// =========================================================================

describe('summarizeDecision', () => {
  // QualityGateDecision variants
  it('summarizes passed quality gate', () => {
    expect(summarizeDecision({ verdict: 'passed' })).toBe('Quality gate passed');
  });

  it('summarizes failed quality gate with issues', () => {
    const summary = summarizeDecision({ verdict: 'failed', issues: ['lint', 'types'] });
    expect(summary).toBe('Quality gate failed: lint, types');
  });

  it('summarizes needs_human quality gate', () => {
    const summary = summarizeDecision({ verdict: 'needs_human', concerns: ['complex change'] });
    expect(summary).toBe('Needs human review: complex change');
  });

  // BoundsDecision variants
  it('summarizes realign', () => {
    const summary = summarizeDecision({ action: 'realign', guidance: 'focus on tests' } as BoundsDecision);
    expect(summary).toBe('Realigning: focus on tests');
  });

  it('summarizes split', () => {
    const summary = summarizeDecision({
      action: 'split',
      workItems: [
        { goal: 'a', objective: 'x', agent: 'standard', dependencies: [] },
        { goal: 'b', objective: 'y', agent: 'standard', dependencies: [] },
      ],
    } as BoundsDecision);
    expect(summary).toBe('Splitting into 2 work items');
  });

  it('summarizes wrap_up', () => {
    const summary = summarizeDecision({ action: 'wrap_up', summary: 'almost done' } as BoundsDecision);
    expect(summary).toBe('Wrapping up: almost done');
  });

  it('summarizes abort', () => {
    const summary = summarizeDecision({ action: 'abort', reason: 'fatal error' } as BoundsDecision);
    expect(summary).toBe('Aborting: fatal error');
  });

  // PromptAnswerDecision variants
  it('summarizes answer with confidence', () => {
    const summary = summarizeDecision({ action: 'answer', text: 'yes', confidence: 0.95 } as PromptAnswerDecision);
    expect(summary).toBe('Answering with confidence 0.95');
  });

  it('summarizes escalate', () => {
    const summary = summarizeDecision({ action: 'escalate', to: 'ops' } as AgentErrorDecision);
    expect(summary).toBe('Escalating to ops');
  });

  it('summarizes defer', () => {
    const summary = summarizeDecision({ action: 'defer', to: 'user' } as PromptAnswerDecision);
    expect(summary).toBe('Deferring to user');
  });

  // CadenceDecision variants
  it('summarizes continue', () => {
    expect(summarizeDecision({ action: 'continue' } as CadenceDecision)).toBe('Continuing');
  });

  it('summarizes inject_guidance', () => {
    expect(summarizeDecision({ action: 'inject_guidance', message: 'refocus' } as CadenceDecision)).toBe('Injecting guidance');
  });

  it('summarizes stop', () => {
    expect(summarizeDecision({ action: 'stop', reason: 'stuck' } as CadenceDecision)).toBe('Stopping: stuck');
  });

  it('summarizes stop_work_item', () => {
    expect(summarizeDecision({ action: 'stop_work_item', reason: 'no progress' } as CadenceDecision)).toBe('Stopping work item: no progress');
  });

  // AgentErrorDecision variants
  it('summarizes retry', () => {
    expect(summarizeDecision({ action: 'retry', guidance: 'try again' } as AgentErrorDecision)).toBe('Retrying with guidance');
  });

  // WorkItemCompletedDecision
  it('summarizes accept', () => {
    expect(summarizeDecision({ action: 'accept', summary: 'all good' } as WorkItemCompletedDecision)).toBe('Work item accepted');
  });
});
