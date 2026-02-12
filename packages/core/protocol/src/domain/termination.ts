/**
 * Termination Reasons - Single Source of Truth
 *
 * All possible reasons for agent/orchestrator termination.
 * This is a discriminated union - all code must handle every case.
 */

import { assertNever } from '../assertNever.js';

/**
 * All possible reasons for termination.
 * Single source of truth - all other code imports from here.
 */
export type TerminationReason =
  // Success
  | 'goal_state_reached'

  // User interaction
  | 'user_input_required'
  | 'handoff_requested'
  | 'user_stopped'

  // Bounds exceeded
  | 'max_iterations_exceeded'
  | 'max_tool_calls_exceeded'
  | 'max_duration_exceeded'

  // Transient errors
  | 'rate_limit'
  | 'circuit_open'
  | 'timeout'

  // Agent errors
  | 'agent_error'
  | 'invalid_action'
  | 'no_action'
  | 'refusal'
  | 'stagnation'

  // Observer intervention
  | 'observer_stopped'
  | 'observer_work_item_stopped'
  | 'cadence_audit';

/**
 * Categorize termination reasons.
 */
export type TerminationCategory =
  | 'success'
  | 'user_interaction'
  | 'bounds'
  | 'transient'
  | 'agent_error'
  | 'observer';

/**
 * Get the category of a termination reason.
 * Uses exhaustive switch to ensure all reasons are handled.
 */
export function getTerminationCategory(reason: TerminationReason): TerminationCategory {
  switch (reason) {
    case 'goal_state_reached':
      return 'success';

    case 'user_input_required':
    case 'handoff_requested':
    case 'user_stopped':
      return 'user_interaction';

    case 'max_iterations_exceeded':
    case 'max_tool_calls_exceeded':
    case 'max_duration_exceeded':
      return 'bounds';

    case 'rate_limit':
    case 'circuit_open':
    case 'timeout':
      return 'transient';

    case 'agent_error':
    case 'invalid_action':
    case 'no_action':
    case 'refusal':
    case 'stagnation':
      return 'agent_error';

    case 'observer_stopped':
    case 'observer_work_item_stopped':
    case 'cadence_audit':
      return 'observer';

    default:
      return assertNever(reason, `Unknown termination reason: ${reason}`);
  }
}

/**
 * Is this termination reason blockable by a hook?
 * Some reasons (like user_stopped) cannot be blocked.
 */
export function isBlockable(reason: TerminationReason): boolean {
  switch (reason) {
    // Blockable - hooks can intervene
    case 'goal_state_reached':
    case 'max_iterations_exceeded':
    case 'max_tool_calls_exceeded':
    case 'max_duration_exceeded':
    case 'user_input_required':
    case 'handoff_requested':
    case 'agent_error':
    case 'cadence_audit':
    case 'stagnation':
      return true;

    // Non-blockable - must be honored
    case 'user_stopped':
    case 'rate_limit':
    case 'circuit_open':
    case 'timeout':
    case 'invalid_action':
    case 'no_action':
    case 'refusal':
    case 'observer_stopped':
    case 'observer_work_item_stopped':
      return false;

    default:
      return assertNever(reason);
  }
}

/**
 * Is this termination reason retryable?
 */
export function isRetryable(reason: TerminationReason): boolean {
  switch (reason) {
    case 'rate_limit':
    case 'circuit_open':
    case 'timeout':
    case 'agent_error':
    case 'stagnation':
      return true;

    case 'goal_state_reached':
    case 'user_input_required':
    case 'handoff_requested':
    case 'user_stopped':
    case 'max_iterations_exceeded':
    case 'max_tool_calls_exceeded':
    case 'max_duration_exceeded':
    case 'invalid_action':
    case 'no_action':
    case 'refusal':
    case 'observer_stopped':
    case 'observer_work_item_stopped':
    case 'cadence_audit':
      return false;

    default:
      return assertNever(reason);
  }
}

/**
 * All termination reasons as an array (for iteration).
 */
export const ALL_TERMINATION_REASONS: readonly TerminationReason[] = [
  'goal_state_reached',
  'user_input_required',
  'handoff_requested',
  'user_stopped',
  'max_iterations_exceeded',
  'max_tool_calls_exceeded',
  'max_duration_exceeded',
  'rate_limit',
  'circuit_open',
  'timeout',
  'agent_error',
  'invalid_action',
  'no_action',
  'refusal',
  'stagnation',
  'observer_stopped',
  'observer_work_item_stopped',
  'cadence_audit',
] as const;
