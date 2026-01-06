/**
 * Comprehensive test suite for Stagnation Detection
 *
 * Goal: Find bugs, not just pass tests.
 * Focus areas:
 * - Retry counting edge cases
 * - Identical output detection
 * - Global stagnation detection
 * - Hash collision potential
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  StagnationDetector,
  noStagnation,
  type StagnationSignal,
} from './stagnation.js';
import { WorkLedger, EntryStatus } from './work-ledger.js';
import { PlanState } from './plan-state.js';
import { createWizardPlan, createWizardStep } from '../types/plans.js';
import type { WorkerOutcome } from './worker.js';
import { createWorkerOutcome } from './worker.js';
import { createWorkItem } from './work-item.js';

function createMockOutcome(params: {
  success?: boolean;
  finalResponse?: string;
  stepNum?: number;
}): WorkerOutcome {
  const outcome = createWorkerOutcome({
    workId: 'test',
    stepNum: params.stepNum ?? 1,
    baseVersion: 1,
  });
  outcome.success = params.success ?? false;
  outcome.finalResponse = params.finalResponse;
  return outcome;
}

describe('StagnationDetector', () => {
  let detector: StagnationDetector;
  let ledger: WorkLedger;

  beforeEach(() => {
    detector = new StagnationDetector(3, 3, 10);
    ledger = new WorkLedger();
  });

  describe('Retry counting', () => {
    it('should not detect stagnation below retry threshold', () => {
      const workItem = createWorkItem({ stepNum: 1, goal: 'Test', objective: 'Test' });

      // Dispatch and complete 3 times (at threshold, not over)
      for (let i = 0; i < 3; i++) {
        const entryId = ledger.recordDispatch(1, workItem, `worker-${i}`);
        ledger.recordCompletion(entryId, createMockOutcome({ success: false, stepNum: 1 }));
      }

      const signal = detector.check(1, ledger);

      expect(signal.detected).toBe(false);
    });

    it('should detect stagnation when over retry threshold', () => {
      const workItem = createWorkItem({ stepNum: 1, goal: 'Test', objective: 'Test' });

      // Dispatch and complete 4 times (over threshold of 3)
      for (let i = 0; i < 4; i++) {
        const entryId = ledger.recordDispatch(1, workItem, `worker-${i}`);
        ledger.recordCompletion(entryId, createMockOutcome({ success: false, stepNum: 1 }));
      }

      const signal = detector.check(1, ledger);

      expect(signal.detected).toBe(true);
      expect(signal.suggestedAction).toBe('skip_step');
    });

    it('should NOT count DISPATCHED entries (in-flight)', () => {
      const workItem = createWorkItem({ stepNum: 1, goal: 'Test', objective: 'Test' });

      // Dispatch 5 times but don't complete - all are "in-flight"
      for (let i = 0; i < 5; i++) {
        ledger.recordDispatch(1, workItem, `worker-${i}`);
        // Don't call recordCompletion
      }

      const signal = detector.check(1, ledger);

      // Should not detect stagnation because none are completed/failed
      expect(signal.detected).toBe(false);
    });

    it('should count FAILED entries', () => {
      const workItem = createWorkItem({ stepNum: 1, goal: 'Test', objective: 'Test' });

      for (let i = 0; i < 4; i++) {
        const entryId = ledger.recordDispatch(1, workItem, `worker-${i}`);
        ledger.recordCompletion(entryId, createMockOutcome({ success: false, stepNum: 1 }));
      }

      const signal = detector.check(1, ledger);

      expect(signal.detected).toBe(true);
    });

    it('BUG CANDIDATE: COMPLETED entries also count toward retry limit', () => {
      // If a step keeps completing successfully but then failing,
      // the COMPLETED entries also count toward the retry limit
      const workItem = createWorkItem({ stepNum: 1, goal: 'Test', objective: 'Test' });

      // 2 successful completions
      for (let i = 0; i < 2; i++) {
        const entryId = ledger.recordDispatch(1, workItem, `worker-${i}`);
        ledger.recordCompletion(entryId, createMockOutcome({ success: true, stepNum: 1 }));
      }

      // 2 failed completions
      for (let i = 0; i < 2; i++) {
        const entryId = ledger.recordDispatch(1, workItem, `worker-${i + 2}`);
        ledger.recordCompletion(entryId, createMockOutcome({ success: false, stepNum: 1 }));
      }

      const signal = detector.check(1, ledger);

      // Total is 4 (2 completed + 2 failed), which is > 3
      // This might not be the intended behavior - maybe only failures should count?
      expect(signal.detected).toBe(true);
    });
  });

  describe('Identical output detection', () => {
    it('should not detect with fewer than maxIdenticalOutputs', () => {
      const signal1 = detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: 'Same response',
        stepNum: 1,
      }));
      const signal2 = detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: 'Same response',
        stepNum: 1,
      }));

      expect(signal1.detected).toBe(false);
      expect(signal2.detected).toBe(false);
    });

    it('should detect after maxIdenticalOutputs identical responses', () => {
      // Need 3 identical outputs to trigger detection
      detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: 'Same response',
        stepNum: 1,
      }));
      detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: 'Same response',
        stepNum: 1,
      }));
      const signal = detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: 'Same response',
        stepNum: 1,
      }));

      expect(signal.detected).toBe(true);
      expect(signal.suggestedAction).toBe('pivot_approach');
    });

    it('should reset detection when output changes', () => {
      detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: 'Response A',
        stepNum: 1,
      }));
      detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: 'Response A',
        stepNum: 1,
      }));
      // Different response resets the counter
      detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: 'Response B',
        stepNum: 1,
      }));
      const signal = detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: 'Response B',
        stepNum: 1,
      }));

      // Only 2 identical B responses, not 3
      expect(signal.detected).toBe(false);
    });

    it('should track outputs per step independently', () => {
      // Step 1 gets 3 identical
      for (let i = 0; i < 3; i++) {
        detector.check(1, ledger, createMockOutcome({
          success: true,
          finalResponse: 'Step 1 response',
          stepNum: 1,
        }));
      }

      // Step 2 gets 2 identical
      detector.check(2, ledger, createMockOutcome({
        success: true,
        finalResponse: 'Step 2 response',
        stepNum: 2,
      }));
      const signal = detector.check(2, ledger, createMockOutcome({
        success: true,
        finalResponse: 'Step 2 response',
        stepNum: 2,
      }));

      // Step 2 should not trigger since only 2 identical
      expect(signal.detected).toBe(false);
    });

    it('BUG CANDIDATE: hash collisions could cause false positives', () => {
      // Using MD5 truncated to 8 chars means high collision probability
      // Two different strings could hash to same value
      // This test documents the risk

      // The hash is first 8 chars of MD5, which is 32 bits = 4 billion possibilities
      // In practice, collision probability is low but not zero
      const output1 = 'This is a unique response number one';
      const output2 = 'This is a unique response number two';

      detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: output1,
        stepNum: 1,
      }));
      detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: output2,
        stepNum: 1,
      }));
      const signal = detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: output1,
        stepNum: 1,
      }));

      // Should not detect since outputs are different
      expect(signal.detected).toBe(false);
    });

    it('should handle empty finalResponse', () => {
      // No finalResponse means no hash is computed
      const signal = detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: undefined,
        stepNum: 1,
      }));

      expect(signal.detected).toBe(false);
    });

    it('should handle empty string finalResponse', () => {
      for (let i = 0; i < 3; i++) {
        detector.check(1, ledger, createMockOutcome({
          success: true,
          finalResponse: '',
          stepNum: 1,
        }));
      }

      // BUG CANDIDATE: Empty string '' will hash to same value
      // If multiple steps return empty response, this could trigger
      const signal = detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: '',
        stepNum: 1,
      }));

      // This will trigger because all empty strings hash the same
      // May or may not be intended behavior
    });
  });

  describe('Global stagnation detection', () => {
    it('should not detect with less than threshold entries', () => {
      const workItem = createWorkItem({ stepNum: 1, goal: 'Test', objective: 'Test' });

      // Create 5 entries, all failed (less than threshold of 10)
      for (let i = 0; i < 5; i++) {
        const entryId = ledger.recordDispatch(1, workItem, `worker-${i}`);
        ledger.recordCompletion(entryId, createMockOutcome({ success: false, stepNum: 1 }));
      }

      const signal = detector.check(1, ledger);

      // Should only check retry stagnation, not global
      expect(signal.reason).not.toContain('No steps completed');
    });

    it('should detect when no steps completed in recent work', () => {
      const workItem = createWorkItem({ stepNum: 1, goal: 'Test', objective: 'Test' });

      // Create 10+ failed entries across different steps
      for (let i = 0; i < 12; i++) {
        const stepNum = (i % 3) + 1; // Steps 1, 2, 3 cycling
        const item = createWorkItem({ stepNum, goal: 'Test', objective: 'Test' });
        const entryId = ledger.recordDispatch(stepNum, item, `worker-${i}`);
        ledger.recordCompletion(entryId, createMockOutcome({ success: false, stepNum }));
      }

      const signal = detector.check(1, ledger);

      expect(signal.detected).toBe(true);
      expect(signal.severity).toBe(1.0);
      expect(signal.suggestedAction).toBe('abort_or_simplify');
    });

    it('should not detect global stagnation if some entries completed', () => {
      const workItem = createWorkItem({ stepNum: 1, goal: 'Test', objective: 'Test' });

      // Create 11 entries: 10 failed, 1 completed
      for (let i = 0; i < 10; i++) {
        const entryId = ledger.recordDispatch(1, workItem, `worker-${i}`);
        ledger.recordCompletion(entryId, createMockOutcome({ success: false, stepNum: 1 }));
      }
      const successEntry = ledger.recordDispatch(1, workItem, 'worker-success');
      ledger.recordCompletion(successEntry, createMockOutcome({ success: true, stepNum: 1 }));

      // Should have 11 entries total, 1 completed
      const signal = detector.check(1, ledger);

      // Should not detect global stagnation because 1 completed
      expect(signal.suggestedAction).not.toBe('abort_or_simplify');
    });
  });

  describe('resetStep', () => {
    it('should clear output hash tracking', () => {
      // Build up to near detection
      detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: 'Same response',
        stepNum: 1,
      }));
      detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: 'Same response',
        stepNum: 1,
      }));

      // Reset
      detector.resetStep(1);

      // Check again - should not trigger
      const signal = detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: 'Same response',
        stepNum: 1,
      }));

      expect(signal.detected).toBe(false);
    });
  });

  describe('cleanupAll', () => {
    it('should clear all tracking state', () => {
      // Build up state for multiple steps
      for (let step = 1; step <= 3; step++) {
        detector.check(step, ledger, createMockOutcome({
          success: true,
          finalResponse: `Response for step ${step}`,
          stepNum: step,
        }));
      }

      detector.cleanupAll();

      // Check should start fresh
      const signal = detector.check(1, ledger, createMockOutcome({
        success: true,
        finalResponse: 'Response for step 1',
        stepNum: 1,
      }));

      expect(signal.detected).toBe(false);
    });
  });

  describe('getEscalationAction', () => {
    it('should return skip for skip_step suggestion', () => {
      const signal: StagnationSignal = {
        detected: true,
        severity: 0.8,
        reason: 'Too many retries',
        stepNum: 1,
        suggestedAction: 'skip_step',
      };

      const plan = createWizardPlan({
        goal: 'Test',
        steps: [createWizardStep({ stepNum: 1, objective: 'Test' })],
      });
      const state = PlanState.fromWizardPlan(plan);

      const action = detector.getEscalationAction(signal, state);

      expect(action.action).toBe('skip');
      expect(action.stepNum).toBe(1);
    });

    it('should return abort for abort_or_simplify suggestion', () => {
      const signal: StagnationSignal = {
        detected: true,
        severity: 1.0,
        reason: 'Global stagnation',
        suggestedAction: 'abort_or_simplify',
      };

      const plan = createWizardPlan({
        goal: 'Test',
        steps: [createWizardStep({ stepNum: 1, objective: 'Test' })],
      });
      const state = PlanState.fromWizardPlan(plan);

      const action = detector.getEscalationAction(signal, state);

      expect(action.action).toBe('abort');
    });

    it('should return none for unrecognized suggestion', () => {
      const signal: StagnationSignal = {
        detected: true,
        severity: 0.5,
        reason: 'Some issue',
        suggestedAction: 'pivot_approach', // Not handled
      };

      const plan = createWizardPlan({
        goal: 'Test',
        steps: [createWizardStep({ stepNum: 1, objective: 'Test' })],
      });
      const state = PlanState.fromWizardPlan(plan);

      const action = detector.getEscalationAction(signal, state);

      expect(action.action).toBe('none');
    });

    it('should return none when not detected', () => {
      const signal = noStagnation();

      const plan = createWizardPlan({
        goal: 'Test',
        steps: [createWizardStep({ stepNum: 1, objective: 'Test' })],
      });
      const state = PlanState.fromWizardPlan(plan);

      const action = detector.getEscalationAction(signal, state);

      expect(action.action).toBe('none');
    });

    it('BUG CANDIDATE: skip_step without stepNum', () => {
      const signal: StagnationSignal = {
        detected: true,
        severity: 0.8,
        reason: 'Too many retries',
        // stepNum is undefined!
        suggestedAction: 'skip_step',
      };

      const plan = createWizardPlan({
        goal: 'Test',
        steps: [createWizardStep({ stepNum: 1, objective: 'Test' })],
      });
      const state = PlanState.fromWizardPlan(plan);

      const action = detector.getEscalationAction(signal, state);

      // Should return 'none' because stepNum is undefined
      expect(action.action).toBe('none');
    });
  });
});

describe('noStagnation', () => {
  it('should return a signal with detected=false', () => {
    const signal = noStagnation();

    expect(signal.detected).toBe(false);
    expect(signal.severity).toBe(0);
    expect(signal.reason).toBe('');
    expect(signal.suggestedAction).toBe('');
  });
});
