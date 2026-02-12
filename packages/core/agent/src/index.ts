/**
 * Agent Module - Barrel Export
 */

export { Agent, type ModelSelection, type MemoryInjector } from './agent.js';
export { AgentRegistry } from './agent-registry.js';
export {
  circuitBreakerRegistry,
  resetProviderCircuit,
  getCircuitStatus,
} from './circuit-breaker-registry.js';
export { TOOL_LIMITS, getMaxOutputLength, isRefusal, REFUSAL_PATTERNS } from './constants.js';
export type {
  AgentType,
  AgentBudget,
  AgentConfig,
  LLMParams,
  AgentRunParams,
  AgentMetrics,
  AgentResult,
  UserPromptInfo,
  EventEmitCallback,
  AgentHooks,
  AgentCadenceMetrics,
  AgentCadenceResult,
  ToolHookResult,
  AgentRuntimeConfig,
  InternalHookEvent,
  InternalHookContext,
  InternalHookHandler,
  InternalHookQueue,
  ExecutionSnapshot,
  StopHookResult,
  StopHookContext,
  StopHookHandler,
} from './types.js';

export { DEFAULT_AGENT_BUDGET, DEFAULT_LLM_PARAMS, noopEmit, noopHookQueue } from './types.js';
export {
  EXPLORER_PROMPT,
  RUNTIME_SCRIPT_PROMPT,
  STANDARD_PROMPT,
  WATCHER_PROMPT,
  ASYNC_MODE_ADDENDUM,
  ASYNC_AGENT_PROMPT,
  getAgentPrompt,
  getAsyncModeAddendum,
  getAsyncAgentPrompt,
  buildAgentConfig,
  buildEnvironmentPrompt,
  PLANNING_PROMPT_ADDENDUM,
  getPlanningPromptAddendum,
} from './prompts.js';
export type { EnvironmentContext } from './prompts.js';
