/**
 * Termination reason types for agent and orchestrator.
 *
 * These types define the contract between Agent and Orchestrator for
 * communicating why execution terminated. Using union types instead of
 * strings ensures compile-time safety and prevents dispatch gaps.
 */

/**
 * Agent-level termination reasons.
 * Set by the Agent, consumed by the Orchestrator.
 */
export type AgentTerminationReason =
  // Success states
  | 'goal_state_reached'

  // User interaction
  | 'user_input_required'
  | 'handoff_requested'

  // Bounds exceeded (agent-level)
  | 'iterations_exhausted'
  | 'bounds:tool_calls'
  | 'bounds:duration'

  // Transient errors (retryable by caller)
  | 'rate_limit'
  | 'circuit_open'

  // Semantic errors (agent misbehavior)
  | 'invalid_action'
  | 'no_action'
  | 'stagnation:tool_repeat'
  | 'refusal'

  // Catch-all for unexpected errors
  | 'exception';

/**
 * Orchestrator-level termination reasons.
 * Public contract returned to callers of Orchestrator.execute().
 */
export type OrchestratorTerminationReason =
  | 'goal_state_reached'
  | 'user_input_required'
  | 'handoff_requested'
  | 'max_iterations_exceeded'
  | 'max_tool_calls_exceeded'
  | 'max_duration_exceeded'
  | 'rate_limit'
  | 'circuit_open'
  | 'refusal'
  | 'agent_error';
