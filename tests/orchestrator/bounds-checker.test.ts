/**
 * Boundary-value tests for BoundsChecker.
 *
 * Focus: exact boundary conditions (at-limit, one-over, one-under),
 * the asymmetric > vs >= comparisons, multi-violation detection,
 * and toTerminationReason mapping.
 */

import { BoundsChecker, type ExecutionLimits } from 'orchestrator/bounds-checker.js';

const LIMITS: ExecutionLimits = {
  maxIterations: 10,
  maxDurationMs: 60_000,
  maxToolCalls: 20,
};

function checker(overrides: Partial<ExecutionLimits> = {}): BoundsChecker {
  return new BoundsChecker({ ...LIMITS, ...overrides });
}

// =========================================================================
// check() - composite bounds checking
// =========================================================================

describe('BoundsChecker.check()', () => {
  it('reports safe when all values are well under limits', () => {
    const result = checker().check({ iteration: 1, elapsedMs: 0, totalToolCalls: 0 });
    expect(result.safe).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.firstViolation).toBeNull();
  });

  // --- Iteration boundary ---

  it('is safe at exactly maxIterations (uses >)', () => {
    const result = checker().check({ iteration: 10, elapsedMs: 0, totalToolCalls: 0 });
    expect(result.safe).toBe(true);
  });

  it('violates at one over maxIterations', () => {
    const result = checker().check({ iteration: 11, elapsedMs: 0, totalToolCalls: 0 });
    expect(result.safe).toBe(false);
    expect(result.violations).toContain('iterations');
    expect(result.firstViolation).toBe('iterations');
  });

  // --- Duration boundary ---

  it('is safe at exactly maxDurationMs (uses >)', () => {
    const result = checker().check({ iteration: 1, elapsedMs: 60_000, totalToolCalls: 0 });
    expect(result.safe).toBe(true);
  });

  it('violates at one over maxDurationMs', () => {
    const result = checker().check({ iteration: 1, elapsedMs: 60_001, totalToolCalls: 0 });
    expect(result.safe).toBe(false);
    expect(result.violations).toContain('duration');
  });

  // --- Tool calls boundary (uses >=, stricter) ---

  it('violates at exactly maxToolCalls (uses >=)', () => {
    const result = checker().check({ iteration: 1, elapsedMs: 0, totalToolCalls: 20 });
    expect(result.safe).toBe(false);
    expect(result.violations).toContain('toolCalls');
  });

  it('is safe at one under maxToolCalls', () => {
    const result = checker().check({ iteration: 1, elapsedMs: 0, totalToolCalls: 19 });
    expect(result.safe).toBe(true);
  });

  // --- Multiple violations ---

  it('reports all violated bounds simultaneously', () => {
    const result = checker().check({ iteration: 100, elapsedMs: 999_999, totalToolCalls: 100 });
    expect(result.safe).toBe(false);
    expect(result.violations).toHaveLength(3);
    expect(result.violations).toContain('iterations');
    expect(result.violations).toContain('duration');
    expect(result.violations).toContain('toolCalls');
    // firstViolation should be the first in the array (iterations)
    expect(result.firstViolation).toBe('iterations');
  });

  // --- Zero limits ---

  it('handles zero maxIterations (always violates since iteration > 0 is true for any run)', () => {
    const result = checker({ maxIterations: 0 }).check({ iteration: 1, elapsedMs: 0, totalToolCalls: 0 });
    expect(result.safe).toBe(false);
    expect(result.violations).toContain('iterations');
  });

  it('handles zero maxToolCalls (always violates since 0 >= 0)', () => {
    const result = checker({ maxToolCalls: 0 }).check({ iteration: 1, elapsedMs: 0, totalToolCalls: 0 });
    expect(result.safe).toBe(false);
    expect(result.violations).toContain('toolCalls');
  });

  it('handles zero maxDurationMs (violates once any time passes)', () => {
    const result = checker({ maxDurationMs: 0 }).check({ iteration: 1, elapsedMs: 1, totalToolCalls: 0 });
    expect(result.safe).toBe(false);
    expect(result.violations).toContain('duration');
  });
});

// =========================================================================
// Individual bound checks
// =========================================================================

describe('BoundsChecker.checkIterations()', () => {
  it('returns true at limit (<=)', () => {
    expect(checker().checkIterations(10)).toBe(true);
  });

  it('returns false above limit', () => {
    expect(checker().checkIterations(11)).toBe(false);
  });

  it('returns true below limit', () => {
    expect(checker().checkIterations(9)).toBe(true);
  });
});

describe('BoundsChecker.checkDuration()', () => {
  it('returns true at limit (<=)', () => {
    expect(checker().checkDuration(60_000)).toBe(true);
  });

  it('returns false above limit', () => {
    expect(checker().checkDuration(60_001)).toBe(false);
  });

  it('returns true below limit', () => {
    expect(checker().checkDuration(59_999)).toBe(true);
  });
});

describe('BoundsChecker.checkToolCalls()', () => {
  it('returns false at limit (<, strict)', () => {
    // Note: checkToolCalls uses < (strict less-than), so exactly at limit is false
    expect(checker().checkToolCalls(20)).toBe(false);
  });

  it('returns true one under limit', () => {
    expect(checker().checkToolCalls(19)).toBe(true);
  });

  it('returns false above limit', () => {
    expect(checker().checkToolCalls(21)).toBe(false);
  });
});

// =========================================================================
// Asymmetry documentation: check() vs individual methods
// =========================================================================

describe('asymmetry between check() and individual methods', () => {
  it('check() iteration uses > while checkIterations uses <=', () => {
    const bc = checker({ maxIterations: 5 });
    // At exactly 5: check says safe (5 > 5 is false), checkIterations says true (5 <= 5)
    expect(bc.check({ iteration: 5, elapsedMs: 0, totalToolCalls: 0 }).safe).toBe(true);
    expect(bc.checkIterations(5)).toBe(true);
    // At 6: both agree it's violated
    expect(bc.check({ iteration: 6, elapsedMs: 0, totalToolCalls: 0 }).safe).toBe(false);
    expect(bc.checkIterations(6)).toBe(false);
  });

  it('check() toolCalls uses >= while checkToolCalls uses <', () => {
    const bc = checker({ maxToolCalls: 5 });
    // At exactly 5: both agree it's violated
    expect(bc.check({ iteration: 1, elapsedMs: 0, totalToolCalls: 5 }).safe).toBe(false);
    expect(bc.checkToolCalls(5)).toBe(false);
    // At 4: both agree it's safe
    expect(bc.check({ iteration: 1, elapsedMs: 0, totalToolCalls: 4 }).safe).toBe(true);
    expect(bc.checkToolCalls(4)).toBe(true);
  });
});

// =========================================================================
// toTerminationReason
// =========================================================================

describe('BoundsChecker.toTerminationReason()', () => {
  it('maps iterations to max_iterations_exceeded', () => {
    expect(BoundsChecker.toTerminationReason('iterations')).toBe('max_iterations_exceeded');
  });

  it('maps duration to max_duration_exceeded', () => {
    expect(BoundsChecker.toTerminationReason('duration')).toBe('max_duration_exceeded');
  });

  it('maps toolCalls to max_tool_calls_exceeded', () => {
    expect(BoundsChecker.toTerminationReason('toolCalls')).toBe('max_tool_calls_exceeded');
  });
});
