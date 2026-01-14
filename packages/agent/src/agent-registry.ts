/**
 * Agent registry with tool definitions for agent-as-tool usage.
 */

import type { AgentConfig } from './types.js';
import type { LLMRequestConfig, ToolDefinition } from 'types';

const DEFAULT_AGENT_TOOL_DESCRIPTIONS: Record<string, string> = {
  routing: 'Classify a request into simple/standard/complex.',
  explorer: 'Discover codebase structure, find files, and understand project layout. USE THIS when: (1) you need to find where something is implemented, (2) you need to understand how components connect, (3) searching with Glob/Grep returned too many or zero results. Returns a structured summary of findings.',
  runtime_script: 'Generate an executable WorkItem DAG for parallelizing multiple independent tasks. Use when you have 3+ independent subtasks that can run concurrently.',
  standard: 'Execute a focused task using available tools.',
  'coding-agent': 'Delegate a self-contained programming task that can execute independently. Use for substantial coding work (new features, refactors) that doesn\'t require your intermediate results.',
  context_compactor: 'Compact conversation context to fit limits.',
  debugger: 'Diagnose and fix bugs or failures in the task.',
  web_crawler: 'Fetch and summarize information from the web.',
};

const AGENT_TOOL_PARAMETER_SCHEMA: ToolDefinition['parameters'] = {
  type: 'object',
  properties: {
    objective: {
      type: 'string',
      description: 'Specific task for this agent to complete.',
    },
    delta: {
      type: 'string',
      description: 'How this task advances the overall goal.',
    },
    goal: {
      type: 'string',
      description: 'Optional override for the overall goal (defaults to parent goal).',
    },
    toolHint: {
      type: 'string',
      description: 'Optional tool suggestion if a specific tool is required.',
    },
    targetPaths: {
      type: 'array',
      description: 'Optional file paths this agent should focus on.',
      items: {
        type: 'string',
      },
    },
    params: {
      type: 'object',
      description: 'Optional structured parameters passed through to the agent.',
      additionalProperties: true,
    },
  },
  required: ['objective'],
  additionalProperties: false,
};

function buildAgentToolDefinition(agentType: string): ToolDefinition {
  const description =
    DEFAULT_AGENT_TOOL_DESCRIPTIONS[agentType] ??
    `Run the ${agentType} agent on a focused objective.`;

  return {
    name: agentType,
    description: `${description} Returns JSON with {success, response, error, metrics}.`,
    parameters: AGENT_TOOL_PARAMETER_SCHEMA,
    strict: false, // params needs additionalProperties for flexibility
  };
}

/**
 * Registry for agent configs and their tool definitions.
 */
export class AgentRegistry {
  private configs = new Map<string, { config: AgentConfig; llm: LLMRequestConfig }>();
  private toolDefinitions = new Map<string, ToolDefinition>();

  constructor(configs: Array<{ config: AgentConfig; llm: LLMRequestConfig }>) {
    for (const entry of configs) {
      this.configs.set(entry.config.type, entry);
      this.toolDefinitions.set(entry.config.type, buildAgentToolDefinition(entry.config.type));
    }
  }

  has(type: string): boolean {
    return this.configs.has(type);
  }

  getConfig(type: string): AgentConfig {
    const entry = this.configs.get(type);
    if (!entry) {
      throw new Error(`Unknown agent type: ${type}`);
    }
    return entry.config;
  }

  getRuntimeConfig(type: string): { config: AgentConfig; llm: LLMRequestConfig } {
    const entry = this.configs.get(type);
    if (!entry) {
      throw new Error(`Unknown agent type: ${type}`);
    }
    return entry;
  }

  listConfigs(): AgentConfig[] {
    return Array.from(this.configs.values()).map((entry) => entry.config);
  }

  getToolDefinition(type: string): ToolDefinition | undefined {
    return this.toolDefinitions.get(type);
  }

  listToolDefinitions(): ToolDefinition[] {
    return Array.from(this.toolDefinitions.values());
  }
}
