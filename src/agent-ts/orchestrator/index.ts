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
} from './orchestrator.js';

// DAG executor (standalone, for future parallel execution)
export {
  DAGExecutor,
  type DAGExecutorConfig,
  type DAGResult,
  type RuntimeScript,
  type RuntimeScriptOutput,
  parseRuntimeScript,
} from './dag-executor.js';
