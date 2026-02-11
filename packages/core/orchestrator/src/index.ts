/**
 * Orchestrator Module - Barrel Export
 */

// Core orchestrator (loop-until-goal)
export {
  Orchestrator,
  type OrchestratorConfig,
  type OrchestratorRuntime,
  type IterationState,
  DEFAULT_ORCHESTRATOR_CONFIG,
  type OrchestratorResult,
  type OrchestratorMetrics,
  type OrchestratorLogger,
  type PlanModeOptions,
} from './orchestrator.js';

export {
  BoundsChecker,
  type ExecutionLimits,
  type ExecutionState,
  type BoundViolation,
  type BoundsCheckResult,
} from './bounds-checker.js';

export type { StopHookHandler, StopHookContext } from 'agent';

// New protocol hook registry/runner (orchestrator-owned)
export {
  createHookRegistry,
  type HookRegistry,
  type HookBundle,
  type HookRegistrationMeta,
  type RegisteredHook,
} from './hookRegistry/index.js';

export {
  runHooksForEvent,
  type HookExecutionResult,
  type HookAuditEntry,
} from './hookRunner/index.js';

// Prompt-protocol helpers (re-exported from protocol)
export {
  ControlEvents,
  ControlEventTypeField,
  DECISION_PROMPT_BY_EVENT,
  type DecisionPrompt,
} from 'protocol';
