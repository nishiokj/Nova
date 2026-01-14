/**
 * Agent Module - Barrel Export
 */

export { Agent } from './agent.js';
export { AgentRegistry } from './agent-registry.js';
export type {
  AgentType,
  AgentBudget,
  AgentConfig,
  AgentRunParams,
  AgentMetrics,
  AgentResult,
  UserPromptInfo,
  EventEmitCallback,
  AgentHooks,
  ToolHookResult,
  AgentRuntimeConfig,
} from './types.js';

export { DEFAULT_AGENT_BUDGET, noopEmit } from './types.js';
export {
  ROUTING_PROMPT,
  SIMPLE_PROMPT,
  EXPLORER_PROMPT,
  RUNTIME_SCRIPT_PROMPT,
  STANDARD_PROMPT,
  getAgentPrompt,
  buildAgentConfig,
  PLANNING_PROMPT_ADDENDUM,
  getPlanningPromptAddendum,
} from './prompts.js';
