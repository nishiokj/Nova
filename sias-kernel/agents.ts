import { AgentRegistry } from '../packages/agent-core/src/agent/agent-registry.js';
import type { AgentConfig, AgentBudget } from '../packages/agent-core/src/agent/types.js';
import type { StructuredOutputSchema, LLMRequestConfig } from '../packages/agent-core/src/types/llm.js';
import { buildAgentConfig, getAgentPrompt } from '../packages/agent-core/src/agent/prompts.js';
import type { KernelConfig } from './config.js';
import type { AgentType } from './types.js';

const PRINCIPAL_PROMPT = `You are the Principal Engineer for the SIAS kernel.

Responsibilities:
1. Set clear objectives for coding iterations.
2. Maintain architectural coherence and avoid flip-flopping.
3. Approve upgrades when benchmarks improve.
4. Escalate to OnCall when anomalies require investigation.

Always respond with JSON matching the PrincipalOutput schema.`;

const ONCALL_PROMPT = `You are the OnCall Engineer for the SIAS kernel.

Responsibilities:
1. Diagnose failures or regressions.
2. Propose targeted fixes or logging patches.
3. Escalate to Principal when blocked.

Always respond with JSON matching the OnCallOutput schema.`;

const TESTING_PROMPT = `You are the Testing Agent for the SIAS kernel.

Responsibilities:
1. Review benchmark suite results.
2. Highlight regressions and improvements.
3. Recommend proceed/block/investigate.

Always respond with JSON matching the TestingOutput schema.`;

function buildPrincipalSchema(): StructuredOutputSchema {
  return {
    name: 'principal_output',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        decision: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: {
              type: 'string',
              enum: ['continue', 'adjust_objective', 'escalate', 'approve_upgrade', 'rollback', 'pause'],
            },
            reasoning: { type: 'string' },
            confidence: { type: 'number' },
          },
          required: ['type', 'reasoning', 'confidence'],
        },
        next_objective: {
          anyOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                goal: { type: 'string' },
                success_criteria: { type: 'array', items: { type: 'string' } },
                target_files: { type: 'array', items: { type: 'string' } },
                constraints: { type: 'array', items: { type: 'string' } },
                delegate_to: { type: 'string' },
              },
              required: ['goal', 'success_criteria', 'constraints', 'delegate_to'],
            },
            { type: 'null' },
          ],
        },
        new_constraints: {
          anyOf: [
            {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  constraint: { type: 'string' },
                  learned_from: { type: 'string' },
                },
                required: ['constraint', 'learned_from'],
              },
            },
            { type: 'null' },
          ],
        },
        related_decisions: {
          anyOf: [
            {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  decision_id: { type: 'string' },
                  similarity: { type: 'number' },
                  should_reverse: { type: 'boolean' },
                  reasoning: { type: 'string' },
                },
                required: ['decision_id', 'similarity', 'should_reverse', 'reasoning'],
              },
            },
            { type: 'null' },
          ],
        },
      },
      required: ['decision', 'next_objective', 'new_constraints', 'related_decisions'],
    },
  };
}

function buildOnCallSchema(): StructuredOutputSchema {
  return {
    name: 'oncall_output',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        investigation_status: {
          type: 'string',
          enum: ['ongoing', 'resolved', 'escalated', 'blocked'],
        },
        diagnosis: {
          anyOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                root_cause: { type: 'string' },
                confidence: { type: 'number' },
                evidence: { type: 'array', items: { type: 'string' } },
                hypothesis_history: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      hypothesis: { type: 'string' },
                      tested: { type: 'boolean' },
                      result: { type: ['string', 'null'], enum: ['confirmed', 'rejected', null] },
                    },
                    required: ['hypothesis', 'tested', 'result'],
                  },
                },
              },
              required: ['root_cause', 'confidence', 'evidence', 'hypothesis_history'],
            },
            { type: 'null' },
          ],
        },
        actions: {
          anyOf: [
            {
              type: 'array',
              items: { type: 'object', additionalProperties: false, properties: {} },
            },
            { type: 'null' },
          ],
        },
        resolution: {
          anyOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                summary: { type: 'string' },
                patches_applied: { type: 'array', items: { type: 'string' } },
                verification: { type: 'string' },
              },
              required: ['summary', 'patches_applied', 'verification'],
            },
            { type: 'null' },
          ],
        },
      },
      required: ['investigation_status', 'diagnosis', 'actions', 'resolution'],
    },
  };
}

function buildTestingSchema(): StructuredOutputSchema {
  return {
    name: 'testing_output',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        suite_result: { type: 'object', additionalProperties: false, properties: {} },
        recommendation: { type: 'string', enum: ['proceed', 'block', 'investigate'] },
        reasoning: { type: 'string' },
        regressions: {
          anyOf: [
            {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  benchmark_id: { type: 'string' },
                  severity: { type: 'string', enum: ['minor', 'major', 'critical'] },
                  details: { type: 'string' },
                },
                required: ['benchmark_id', 'severity', 'details'],
              },
            },
            { type: 'null' },
          ],
        },
        improvements: {
          anyOf: [
            {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  benchmark_id: { type: 'string' },
                  improvement_percent: { type: 'number' },
                  details: { type: 'string' },
                },
                required: ['benchmark_id', 'improvement_percent', 'details'],
              },
            },
            { type: 'null' },
          ],
        },
      },
      required: ['suite_result', 'recommendation', 'reasoning', 'regressions', 'improvements'],
    },
  };
}

function buildBudget(maxIterations: number, maxToolCalls: number, maxDurationMs: number): AgentBudget {
  return { maxIterations, maxToolCalls, maxDurationMs };
}

function toLLMRequestConfig(modelConfig: KernelConfig['agents'][keyof KernelConfig['agents']]): LLMRequestConfig {
  return {
    provider: modelConfig.provider,
    model: modelConfig.model,
    apiKey: modelConfig.apiKey,
    maxTokens: modelConfig.maxTokens,
    temperature: modelConfig.temperature,
    reasoning: modelConfig.reasoning,
  };
}

function createAgentConfig(
  type: AgentType,
  systemPrompt: string,
  tools: string[],
  budget: AgentBudget,
  outputSchema?: StructuredOutputSchema
): AgentConfig {
  return {
    type,
    systemPrompt,
    tools,
    budget,
    outputSchema,
  };
}

export function createKernelAgentRegistry(config: KernelConfig): AgentRegistry {
  const principalConfig = createAgentConfig(
    'principal',
    PRINCIPAL_PROMPT,
    ['Read', 'Glob', 'Grep'],
    buildBudget(1, 20, 300000),
    buildPrincipalSchema()
  );

  const oncallConfig = createAgentConfig(
    'oncall',
    ONCALL_PROMPT,
    ['Read', 'Glob', 'Grep', 'Bash'],
    buildBudget(5, 50, 600000),
    buildOnCallSchema()
  );

  const testingConfig = createAgentConfig(
    'testing',
    TESTING_PROMPT,
    [],
    buildBudget(1, 5, 600000),
    buildTestingSchema()
  );

  const codingConfig = buildAgentConfig(
    'coding',
    ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    buildBudget(10, 150, 300000),
    undefined
  ) as AgentConfig;

  codingConfig.systemPrompt = getAgentPrompt('standard');

  return new AgentRegistry([
    { config: principalConfig, llm: toLLMRequestConfig(config.agents.principal) },
    { config: oncallConfig, llm: toLLMRequestConfig(config.agents.oncall) },
    { config: testingConfig, llm: toLLMRequestConfig(config.agents.testing) },
    { config: codingConfig, llm: toLLMRequestConfig(config.agents.coding) },
  ]);
}
