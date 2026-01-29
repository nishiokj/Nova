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
  | 'user_stopped'

  // Bounds exceeded (agent-level)
  | 'iterations_exhausted'
  | 'bounds:tool_calls'
  | 'bounds:duration'

  // Transient errors (retryable by caller)
  | 'rate_limit'
  | 'circuit_open'
  | 'timeout'

  // Semantic errors (agent misbehavior)
  | 'invalid_action'
  | 'no_action'
  | 'stagnation:tool_repeat'
  | 'refusal'

  // Watcher intervention (mid-agent cadence check)
  | 'watcher_stopped'

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
  | 'user_stopped'
  | 'max_iterations_exceeded'
  | 'max_tool_calls_exceeded'
  | 'max_duration_exceeded'
  | 'rate_limit'
  | 'circuit_open'
  | 'timeout'
  | 'refusal'
  | 'agent_error'
  // Semantic errors (continuable by Ralph Loop)
  | 'no_action'
  | 'invalid_action'
  // Watcher periodic oversight
  | 'cadence_audit'
  // Watcher intervention (mid-agent cadence check stopped the agent)
  | 'watcher_stopped';
