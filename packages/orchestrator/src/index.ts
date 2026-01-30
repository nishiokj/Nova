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

export {
  registerHook,
  clearHooks,
  getHooks,
  executeHooks,
  loadHooksFromConfig,
  getHandlers, // deprecated
  type HookEventType,
  type HookCallback,
  type ShellHook,
  type HookEntry,
  type HooksConfig,
  type StopHookHandler,
  type StopHookContext,
} from './hooks.js';

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

// Ralph Loop - iterative self-referential development
export {
  RalphLoop,
  runRalphLoop,
  createRalphStopHook,
  checkCompletionPromise,
  createRalphState,
  type RalphLoopConfig,
  type RalphLoopState,
  type RalphCompletionReason,
} from './ralph-loop.js';
