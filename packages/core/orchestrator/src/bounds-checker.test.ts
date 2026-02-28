/**
 * BoundsChecker — mutation-proof boundary tests.
 *
 * Every operator boundary (>, >=, <, <=) has a test on BOTH sides.
 * Changing any operator breaks at least one test.
 */

import { describe, it, expect } from 'bun:test';
import { BoundsChecker, type ExecutionLimits } from './bounds-checker.js';

const LIMITS: ExecutionLimits = {
  maxIterations: 50,
  maxDurationMs: 300_000,
  maxToolCalls: 200,
};

describe('BoundsChecker', () => {
  // ── check() composite ──────────────────────────────────────────

  describe('check()', () => {
    it('all within bounds → safe', () => {
      const r = new BoundsChecker(LIMITS).check({ iteration: 1, elapsedMs: 0, totalToolCalls: 0 });
      expect(r.safe).toBe(true);
      expect(r.violations).toEqual([]);
      expect(r.firstViolation).toBeNull();
    });

    // --- iterations uses > (strict) ---
    it('iteration AT limit is safe (> not >=)', () => {
      const r = new BoundsChecker(LIMITS).check({ iteration: 50, elapsedMs: 0, totalToolCalls: 0 });
      expect(r.safe).toBe(true);
    });

    it('iteration ONE ABOVE limit violates', () => {
      const r = new BoundsChecker(LIMITS).check({ iteration: 51, elapsedMs: 0, totalToolCalls: 0 });
      expect(r.safe).toBe(false);
      expect(r.firstViolation).toBe('iterations');
    });

    // --- duration uses > (strict) ---
    it('duration AT limit is safe (> not >=)', () => {
      const r = new BoundsChecker(LIMITS).check({ iteration: 1, elapsedMs: 300_000, totalToolCalls: 0 });
      expect(r.safe).toBe(true);
    });

    it('duration ONE MS ABOVE limit violates', () => {
      const r = new BoundsChecker(LIMITS).check({ iteration: 1, elapsedMs: 300_001, totalToolCalls: 0 });
      expect(r.safe).toBe(false);
      expect(r.firstViolation).toBe('duration');
    });

    // --- toolCalls uses >= (non-strict) ---
    it('toolCalls AT limit violates (>= not >)', () => {
      const r = new BoundsChecker(LIMITS).check({ iteration: 1, elapsedMs: 0, totalToolCalls: 200 });
      expect(r.safe).toBe(false);
      expect(r.firstViolation).toBe('toolCalls');
    });

    it('toolCalls ONE BELOW limit is safe', () => {
      const r = new BoundsChecker(LIMITS).check({ iteration: 1, elapsedMs: 0, totalToolCalls: 199 });
      expect(r.safe).toBe(true);
    });

    // --- documents the asymmetry ---
    it('asymmetry: at-limit iterations/duration safe, toolCalls not', () => {
      const c = new BoundsChecker({ maxIterations: 10, maxDurationMs: 100, maxToolCalls: 10 });
      const r = c.check({ iteration: 10, elapsedMs: 100, totalToolCalls: 10 });
      expect(r.violations).toEqual(['toolCalls']);
    });

    // --- multiple violations ---
    it('reports ALL violations, ordered iterations→duration→toolCalls', () => {
      const r = new BoundsChecker(LIMITS).check({ iteration: 100, elapsedMs: 999_999, totalToolCalls: 500 });
      expect(r.violations).toEqual(['iterations', 'duration', 'toolCalls']);
      expect(r.firstViolation).toBe('iterations');
    });

    it('firstViolation skips non-violated bounds', () => {
      const c = new BoundsChecker({ maxIterations: 999, maxDurationMs: 1, maxToolCalls: 1 });
      const r = c.check({ iteration: 1, elapsedMs: 100, totalToolCalls: 100 });
      expect(r.firstViolation).toBe('duration');
    });

    // --- zero limits ---
    it('maxIterations=0: iteration 1 violates', () => {
      const r = new BoundsChecker({ ...LIMITS, maxIterations: 0 }).check({ iteration: 1, elapsedMs: 0, totalToolCalls: 0 });
      expect(r.firstViolation).toBe('iterations');
    });

    it('maxToolCalls=0: even 0 calls violates (0 >= 0)', () => {
      const r = new BoundsChecker({ ...LIMITS, maxToolCalls: 0 }).check({ iteration: 1, elapsedMs: 0, totalToolCalls: 0 });
      expect(r.firstViolation).toBe('toolCalls');
    });

    it('maxDurationMs=0: exactly 0ms is safe (0 > 0 = false)', () => {
      const r = new BoundsChecker({ ...LIMITS, maxDurationMs: 0 }).check({ iteration: 1, elapsedMs: 0, totalToolCalls: 0 });
      expect(r.safe).toBe(true);
    });

    it('maxDurationMs=0: 1ms violates', () => {
      const r = new BoundsChecker({ ...LIMITS, maxDurationMs: 0 }).check({ iteration: 1, elapsedMs: 1, totalToolCalls: 0 });
      expect(r.firstViolation).toBe('duration');
    });
  });

  // ── individual check methods ───────────────────────────────────

  describe('individual methods', () => {
    const c = new BoundsChecker(LIMITS);

    it('checkIterations: at limit → true, above → false', () => {
      expect(c.checkIterations(50)).toBe(true);
      expect(c.checkIterations(51)).toBe(false);
    });

    it('checkDuration: at limit → true, above → false', () => {
      expect(c.checkDuration(300_000)).toBe(true);
      expect(c.checkDuration(300_001)).toBe(false);
    });

    it('checkToolCalls: one below → true, at limit → false', () => {
      expect(c.checkToolCalls(199)).toBe(true);
      expect(c.checkToolCalls(200)).toBe(false);
    });
  });

  // ── consistency: check() agrees with individual methods ────────

  describe('check() ↔ individual method consistency', () => {
    const c = new BoundsChecker(LIMITS);

    it('iterations boundary consistent', () => {
      expect(c.checkIterations(50)).toBe(true);
      expect(c.check({ iteration: 50, elapsedMs: 0, totalToolCalls: 0 }).safe).toBe(true);
      expect(c.checkIterations(51)).toBe(false);
      expect(c.check({ iteration: 51, elapsedMs: 0, totalToolCalls: 0 }).violations).toContain('iterations');
    });

    it('duration boundary consistent', () => {
      expect(c.checkDuration(300_000)).toBe(true);
      expect(c.check({ iteration: 1, elapsedMs: 300_000, totalToolCalls: 0 }).safe).toBe(true);
      expect(c.checkDuration(300_001)).toBe(false);
      expect(c.check({ iteration: 1, elapsedMs: 300_001, totalToolCalls: 0 }).violations).toContain('duration');
    });

    it('toolCalls boundary consistent', () => {
      expect(c.checkToolCalls(199)).toBe(true);
      expect(c.check({ iteration: 1, elapsedMs: 0, totalToolCalls: 199 }).safe).toBe(true);
      expect(c.checkToolCalls(200)).toBe(false);
      expect(c.check({ iteration: 1, elapsedMs: 0, totalToolCalls: 200 }).violations).toContain('toolCalls');
    });
  });

  // ── toTerminationReason ────────────────────────────────────────

  describe('toTerminationReason()', () => {
    it('maps every BoundViolation to correct TerminationReason', () => {
      expect(BoundsChecker.toTerminationReason('iterations')).toBe('max_iterations_exceeded');
      expect(BoundsChecker.toTerminationReason('duration')).toBe('max_duration_exceeded');
      expect(BoundsChecker.toTerminationReason('toolCalls')).toBe('max_tool_calls_exceeded');
    });
  });
});
