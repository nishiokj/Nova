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

export { registerHook, getHandlers, HOOK_REGISTRY } from './hooks/index.js';
