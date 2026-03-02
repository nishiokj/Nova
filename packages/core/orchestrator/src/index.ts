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
} from './orchestrator.js';

export {
  BoundsChecker,
  type ExecutionLimits,
  type ExecutionState,
  type BoundViolation,
  type BoundsCheckResult,
} from './bounds-checker.js';

// Unified hook model (decision + effect under one registry)
export {
  createUnifiedHookRegistry,
  createSessionScopedUnifiedHookRegistry,
  runUnifiedDecisionHooks,
  runUnifiedDecisionHooksForSession,
  runUnifiedEffectHooks,
  runUnifiedEffectHooksForSession,
  type UnifiedHookRegistry,
  type SessionScopedUnifiedHookRegistry,
  type UnifiedHookRegistration,
  type UnifiedDecisionHookRegistration,
  type UnifiedEffectHookRegistration,
  type RegisteredUnifiedHook,
  type UnifiedEventType,
  type DecisionEventType,
  type EffectEventType,
  type HookScope,
  type HookMode,
} from './unifiedHooks/index.js';

// Control-plane contracts (events, decisions, patches, hook policies/outcomes)
export * from './control-plane/index.js';
