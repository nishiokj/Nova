/**
 * BoundsChecker - Centralized execution bounds checking.
 *
 * Encapsulates the logic for checking iteration, duration, and tool call limits.
 */

/**
 * Execution limits configuration.
 */
export interface ExecutionLimits {
  maxIterations: number;
  maxDurationMs: number;
  maxToolCalls: number;
}

/**
 * Current execution state to check against limits.
 */
export interface ExecutionState {
  iteration: number;
  elapsedMs: number;
  totalToolCalls: number;
}

/**
 * Types of bound violations.
 */
export type BoundViolation = 'iterations' | 'duration' | 'toolCalls';

/**
 * Result of bounds checking.
 */
export interface BoundsCheckResult {
  /** Whether all bounds are satisfied */
  safe: boolean;
  /** List of violated bounds (empty if safe) */
  violations: BoundViolation[];
  /** The first violation encountered (for termination reason) */
  firstViolation: BoundViolation | null;
}

/**
 * BoundsChecker - Checks execution state against configured limits.
 */
export class BoundsChecker {
  constructor(private limits: ExecutionLimits) {}

  /**
   * Check if execution state violates any bounds.
   */
  check(state: ExecutionState): BoundsCheckResult {
    const violations: BoundViolation[] = [];

    if (state.iteration > this.limits.maxIterations) {
      violations.push('iterations');
    }
    if (state.elapsedMs > this.limits.maxDurationMs) {
      violations.push('duration');
    }
    if (state.totalToolCalls >= this.limits.maxToolCalls) {
      violations.push('toolCalls');
    }

    return {
      safe: violations.length === 0,
      violations,
      firstViolation: violations[0] ?? null,
    };
  }

  /**
   * Check only iteration bound.
   */
  checkIterations(iteration: number): boolean {
    return iteration <= this.limits.maxIterations;
  }

  /**
   * Check only duration bound.
   */
  checkDuration(elapsedMs: number): boolean {
    return elapsedMs <= this.limits.maxDurationMs;
  }

  /**
   * Check only tool calls bound.
   */
  checkToolCalls(totalToolCalls: number): boolean {
    return totalToolCalls < this.limits.maxToolCalls;
  }

  /**
   * Map violation type to termination reason string.
   */
  static toTerminationReason(violation: BoundViolation): string {
    switch (violation) {
      case 'iterations':
        return 'max_iterations_exceeded';
      case 'duration':
        return 'max_duration_exceeded';
      case 'toolCalls':
        return 'max_tool_calls_exceeded';
    }
  }
}
