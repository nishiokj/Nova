/**
 * Agent Module - Barrel Export
 */

export { Agent, type ModelSelection } from './agent.js';
export type { MemoryInjector } from './memory-bridge.js';
export { AgentRegistry } from './agent-registry.js';
export { TOOL_LIMITS, getMaxOutputLength, isRefusal, REFUSAL_PATTERNS } from './constants.js';
export type {
  AgentType,
  AgentBudget,
  AgentConfig,
  LLMParams,
  AgentRunParams,
  AgentControlDirective,
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
} from './types.js';

export { DEFAULT_AGENT_BUDGET, DEFAULT_LLM_PARAMS, noopEmit, noopHookQueue } from './types.js';
export {
  buildExplorerPrompt,
  buildRuntimeScriptPrompt,
  buildStandardPrompt,
  buildCodingAgentPrompt,
  buildAsyncAgentPrompt,
  buildPlanningPromptAddendum,
  getAgentPrompt,
  buildAgentConfig,
  buildEnvironmentPrompt,
  NOVA_VOCAB,
  vocabForProvider,
} from './prompts.js';
export type { EnvironmentContext, ToolVocabulary } from './prompts.js';
