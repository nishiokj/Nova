import { assertNever } from './assert-never.js';

export type TerminationReason =
  | 'goal_state_reached'
  | 'user_input_required'
  | 'user_stopped'
  | 'max_iterations_exceeded'
  | 'max_tool_calls_exceeded'
  | 'max_duration_exceeded'
  | 'rate_limit'
  | 'circuit_open'
  | 'timeout'
  | 'agent_error'
  | 'invalid_action'
  | 'no_action'
  | 'refusal'
  | 'observer_stopped'
  | 'observer_work_item_stopped'
  | 'cadence_audit';

export type TerminationCategory =
  | 'success'
  | 'user_interaction'
  | 'bounds'
  | 'transient'
  | 'agent_error'
  | 'observer';

export function getTerminationCategory(reason: TerminationReason): TerminationCategory {
  switch (reason) {
    case 'goal_state_reached':
      return 'success';
    case 'user_input_required':
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
      return 'agent_error';
    case 'observer_stopped':
    case 'observer_work_item_stopped':
    case 'cadence_audit':
      return 'observer';
    default:
      return assertNever(reason, `Unknown termination reason: ${reason}`);
  }
}

export function isBlockable(reason: TerminationReason): boolean {
  switch (reason) {
    case 'goal_state_reached':
    case 'max_iterations_exceeded':
    case 'max_tool_calls_exceeded':
    case 'max_duration_exceeded':
    case 'user_input_required':
    case 'agent_error':
    case 'cadence_audit':
      return true;
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

export function isRetryable(reason: TerminationReason): boolean {
  switch (reason) {
    case 'rate_limit':
    case 'circuit_open':
    case 'timeout':
    case 'agent_error':
      return true;
    case 'goal_state_reached':
    case 'user_input_required':
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

export const ALL_TERMINATION_REASONS: readonly TerminationReason[] = [
  'goal_state_reached',
  'user_input_required',
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
  'observer_stopped',
  'observer_work_item_stopped',
  'cadence_audit',
] as const;
