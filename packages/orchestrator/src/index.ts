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
  type ModelOverride,
} from './orchestrator.js';

export {
  registerHook,
  getHandlers,
  HOOK_REGISTRY,
  type StopHookHandler,
  type StopHookContext,
} from './hooks/index.js';

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
