/**
 * Stagnation detection for identifying and handling stuck execution.
 * Detects retry loops, identical outputs, and global stagnation.
 *
 * Ported from: src/harness/agent/wizard/stagnation.py
 */

import { createHash } from 'crypto';
import type { WorkLedger } from './work-ledger.js';
import { EntryStatus } from './work-ledger.js';
import type { WorkerOutcome } from './worker.js';
import type { PlanState } from './plan-state.js';

/**
 * Signal indicating stagnation detected.
 */
export interface StagnationSignal {
  detected: boolean;
  severity: number; // 0.0 to 1.0
  reason: string;
  stepNum?: number;
  suggestedAction: string;
}

/**
 * Create a non-stagnation signal.
 */
export function noStagnation(): StagnationSignal {
  return {
    detected: false,
    severity: 0,
    reason: '',
    suggestedAction: '',
  };
}

/**
 * Detects execution stagnation for escalation.
 *
 * SIGNALS:
 * 1. Too many retries on same step
 * 2. Identical outputs (spinning)
 * 3. No progress across multiple steps
 */
export class StagnationDetector {
  private maxRetriesPerStep: number;
  private maxIdenticalOutputs: number;
  private noProgressThreshold: number;
  private outputHashes = new Map<number, string[]>();

  constructor(
    maxRetriesPerStep = 3,
    maxIdenticalOutputs = 3,
    noProgressThreshold = 10
  ) {
    this.maxRetriesPerStep = maxRetriesPerStep;
    this.maxIdenticalOutputs = maxIdenticalOutputs;
    this.noProgressThreshold = noProgressThreshold;
  }

  /**
   * Check for stagnation signals.
   * Evaluates all conditions and returns the signal with highest severity.
   */
  check(stepNum: number, ledger: WorkLedger, outcome?: WorkerOutcome): StagnationSignal {
    const signals: StagnationSignal[] = [];

    const history = ledger.getStepHistory(stepNum);

    // Count only COMPLETED or FAILED attempts, not DISPATCHED (in-flight)
    const completedAttempts = history.filter(
      (entry) =>
        entry.status === EntryStatus.COMPLETED || entry.status === EntryStatus.FAILED
    ).length;

    if (completedAttempts > this.maxRetriesPerStep) {
      signals.push({
        detected: true,
        severity: 0.8,
        reason: `Step ${stepNum} failed ${completedAttempts} times (max ${this.maxRetriesPerStep})`,
        stepNum,
        suggestedAction: 'skip_step',
      });
    }

    // Check for identical outputs (spinning)
    if (outcome?.finalResponse) {
      const outputHash = createHash('md5')
        .update(outcome.finalResponse)
        .digest('hex')
        .slice(0, 8);

      const hashes = this.outputHashes.get(stepNum) ?? [];
      hashes.push(outputHash);
      this.outputHashes.set(stepNum, hashes);

      if (hashes.length >= this.maxIdenticalOutputs) {
        const recent = hashes.slice(-this.maxIdenticalOutputs);
        const uniqueHashes = new Set(recent);
        if (uniqueHashes.size === 1) {
          signals.push({
            detected: true,
            severity: 0.9,
            reason: `Step ${stepNum} producing identical outputs`,
            stepNum,
            suggestedAction: 'pivot_approach',
          });
        }
      }
    }

    // Check for global stagnation
    const recent = ledger.getRecentEntries(this.noProgressThreshold);
    if (recent.length >= this.noProgressThreshold) {
      const completed = recent.filter((e) => e.status === EntryStatus.COMPLETED).length;
      if (completed === 0) {
        signals.push({
          detected: true,
          severity: 1.0,
          reason: 'No steps completed in recent work items',
          suggestedAction: 'abort_or_simplify',
        });
      }
    }

    // Return the signal with highest severity, or noStagnation if none detected
    if (signals.length === 0) {
      return noStagnation();
    }

    return signals.reduce((highest, current) =>
      current.severity > highest.severity ? current : highest
    );
  }

  /**
   * Generate escalation action based on stagnation signal.
   */
  getEscalationAction(
    signal: StagnationSignal,
    _planState: PlanState
  ): { action: 'skip' | 'abort' | 'none'; stepNum?: number } {
    if (!signal.detected) {
      return { action: 'none' };
    }

    if (signal.suggestedAction === 'skip_step' && signal.stepNum !== undefined) {
      return { action: 'skip', stepNum: signal.stepNum };
    }

    if (signal.suggestedAction === 'abort_or_simplify') {
      return { action: 'abort' };
    }

    return { action: 'none' };
  }

  /**
   * Reset tracking for a step (called on successful completion or skip).
   */
  resetStep(stepNum: number): void {
    this.outputHashes.delete(stepNum);
  }

  /**
   * Clear all tracking state (called when orchestration completes).
   */
  cleanupAll(): void {
    this.outputHashes.clear();
  }
}
