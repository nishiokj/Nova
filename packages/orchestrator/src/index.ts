/**
 * Orchestrator Module - Barrel Export
 */

// Core orchestrator (loop-until-goal)
export {
  Orchestrator,
  type OrchestratorConfig,
  DEFAULT_ORCHESTRATOR_CONFIG,
  type OrchestratorResult,
  type OrchestratorMetrics,
  type OrchestratorLogger,
  type TerminationReason,
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
