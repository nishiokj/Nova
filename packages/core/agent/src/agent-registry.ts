/**
 * Agent registry with tool definitions for agent-as-tool usage.
 */

import type { AgentConfig } from './types.js';
import type { ToolDefinition } from 'types';

const DEFAULT_AGENT_TOOL_DESCRIPTIONS: Record<string, string> = {
  explorer: 'Understand code before acting. Pass an objective ("how does auth work?", "find where X is implemented") and receive distilled artifacts—signatures, call graphs, side effects—without polluting your context with full files. ~50 tokens/artifact vs ~2000 tokens/file. Use Read only AFTER you know which specific file to edit.',
  runtime_script: 'Generate an executable WorkItem DAG for parallelizing multiple independent tasks. Use when you have 3+ independent subtasks that can run concurrently.',
  standard: 'Execute a focused task using available tools.',
  coding: 'Delegate a self-contained programming task that can execute independently. Use for substantial coding work (new features, refactors) that doesn\'t require your intermediate results.',
  context_compactor: 'Compact conversation context to fit limits.',
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

function deepCloneJson<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneAgentConfig(config: AgentConfig): AgentConfig {
  return {
    ...config,
    tools: [...config.tools],
    budget: { ...config.budget },
    llmParams: { ...config.llmParams },
    outputSchema: config.outputSchema
      ? {
          ...config.outputSchema,
          schema: deepCloneJson(config.outputSchema.schema),
        }
      : undefined,
  };
}

function buildAgentToolDefinition(agentType: string): ToolDefinition {
  const description =
    DEFAULT_AGENT_TOOL_DESCRIPTIONS[agentType] ??
    `Run the ${agentType} agent on a focused objective.`;

  return {
    name: agentType,
    description: `${description} Returns a concise text summary; discovered context is merged by the runtime.`,
    parameters: AGENT_TOOL_PARAMETER_SCHEMA,
    strict: false, // params needs additionalProperties for flexibility
  };
}

/**
 * Registry for agent configs and their tool definitions.
 * NOTE: This registry stores ONLY agent capabilities (tools, budget, schema).
 * LLM provider/model selection comes EXCLUSIVELY from SessionStore via getModelSelection.
 */
export class AgentRegistry {
  private configs = new Map<string, AgentConfig>();
  private toolDefinitions = new Map<string, ToolDefinition>();

  constructor(configs: AgentConfig[]) {
    for (const config of configs) {
      this.configs.set(config.type, config);
      this.toolDefinitions.set(config.type, buildAgentToolDefinition(config.type));
    }
  }

  has(type: string): boolean {
    return this.configs.has(type);
  }

  getConfig(type: string): AgentConfig {
    const config = this.configs.get(type);
    if (!config) {
      throw new Error(`Unknown agent type: ${type}`);
    }
    return cloneAgentConfig(config);
  }

  listConfigs(): AgentConfig[] {
    return Array.from(this.configs.values());
  }

  getToolDefinition(type: string): ToolDefinition | undefined {
    return this.toolDefinitions.get(type);
  }

  listToolDefinitions(): ToolDefinition[] {
    return Array.from(this.toolDefinitions.values());
  }
}
