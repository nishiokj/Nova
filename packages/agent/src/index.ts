/**
 * Agent Module - Barrel Export
 */

export { Agent, type ModelSelection } from './agent.js';
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
  ToolHookResult,
  AgentRuntimeConfig,
  InternalHookEvent,
  InternalHookContext,
  InternalHookHandler,
  InternalHookQueue,
  StopHookResult,
  StopHookContext,
  StopHookHandler,
} from './types.js';

export { DEFAULT_AGENT_BUDGET, DEFAULT_LLM_PARAMS, noopEmit, noopHookQueue } from './types.js';
export {
  SIMPLE_PROMPT,
  EXPLORER_PROMPT,
  RUNTIME_SCRIPT_PROMPT,
  STANDARD_PROMPT,
  getAgentPrompt,
  buildAgentConfig,
  buildEnvironmentPrompt,
  PLANNING_PROMPT_ADDENDUM,
  getPlanningPromptAddendum,
} from './prompts.js';
export type { EnvironmentContext } from './prompts.js';
