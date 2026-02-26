/**
 * Shared test fixtures for LLM mocks, tool registries, and agent registries.
 *
 * Eliminates the duplication of createMockLLM / createResponse / createToolRegistry /
 * createAgentRegistry across orchestrator, agent, and integration tests.
 */

import { Effect, Stream } from 'effect';
import type { AgentConfig, AgentRegistry } from 'agent';
import type { LLMAdapter, LLMResponse } from 'llm';
import type { ToolRegistry } from 'tools';
import { getOutputSchemaJson } from 'shared';
import { successResult } from 'types';

// ---------------------------------------------------------------------------
// LLM Response builder
// ---------------------------------------------------------------------------

export interface MockResponseParams {
  action: 'done' | 'continue';
  response: string;
  goalStateReached: boolean;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

export function createResponse(params: MockResponseParams): LLMResponse {
  return {
    content: JSON.stringify({
      action: params.action,
      response: params.response,
      goalStateReached: params.goalStateReached,
      awaitingUserInput: false,
    }),
    stopReason: params.toolCalls && params.toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    toolCalls: params.toolCalls,
    model: 'mock-model',
    durationMs: 1,
  };
}

// ---------------------------------------------------------------------------
// Mock LLM adapter (sequential response playback)
// ---------------------------------------------------------------------------

export function createMockLLM(responses: LLMResponse[]): LLMAdapter {
  let index = 0;
  const next = (): LLMResponse => {
    const response = responses[Math.min(index, responses.length - 1)];
    index++;
    return response;
  };

  return {
    respond: () => Effect.sync(next),
    stream: (params) =>
      Stream.unwrap(
        Effect.sync(() => {
          const response = next();
          params.onComplete?.(response);
          return Stream.fromIterable(response.content.length > 0 ? [response.content] : []);
        }),
      ),
  } as LLMAdapter;
}

// ---------------------------------------------------------------------------
// Tool registry (SleepTool)
// ---------------------------------------------------------------------------

export interface MockToolRegistryOptions {
  onAbort?: () => void;
  defaultSleepMs?: number;
}

export function createToolRegistry(options: MockToolRegistryOptions = {}): ToolRegistry {
  const calls: string[] = [];

  return {
    getDefinitions: () => [
      {
        name: 'SleepTool',
        description: 'Mock sleep tool',
        parameters: {
          type: 'object',
          properties: { ms: { type: 'number' } },
          required: [],
        },
      },
    ],
    getWorkingDir: () => process.cwd(),
    isParallelSafe: () => false,
    execute: async (
      name: string,
      args: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ) => {
      calls.push(name);
      const ms = typeof args.ms === 'number' ? args.ms : (options.defaultSleepMs ?? 1);
      const status = await new Promise<'done' | 'aborted'>((resolve) => {
        const timer = setTimeout(() => resolve('done'), ms);
        opts?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            options.onAbort?.();
            resolve('aborted');
          },
          { once: true },
        );
      });
      if (status === 'aborted') {
        return {
          toolName: 'SleepTool',
          status: 'cancelled',
          output: 'cancelled',
          error: 'cancelled',
          durationMs: 1,
          isSuccess: false,
        };
      }
      return successResult(name, 'ok', 1);
    },
    __calls: calls,
  } as unknown as ToolRegistry;
}

// ---------------------------------------------------------------------------
// Agent registry (standard / planner / observer / explorer)
// ---------------------------------------------------------------------------

export function createAgentRegistry(maxIterations = 10): AgentRegistry {
  const base: AgentConfig = {
    type: 'standard',
    systemPrompt: 'test prompt',
    tools: ['SleepTool'],
    budget: {
      maxIterations,
      maxToolCalls: 20,
      maxDurationMs: 60_000,
      llmStreamTimeoutMs: 5_000,
    },
    llmParams: {
      maxTokens: 2048,
      temperature: 0,
    },
    outputSchema: getOutputSchemaJson('agent_action'),
  };

  const configs = new Map<string, AgentConfig>([
    ['standard', base],
    ['planner', { ...base, type: 'planner', outputSchema: getOutputSchemaJson('planner_output') }],
    ['observer', { ...base, type: 'observer' }],
    ['explorer', { ...base, type: 'explorer' }],
  ]);

  return {
    has: (type: string) => configs.has(type),
    getConfig: (type: string) => {
      const config = configs.get(type);
      if (!config) throw new Error(`Unknown agent type: ${type}`);
      return config;
    },
    listToolDefinitions: () => [],
    register: () => {},
    get: () => null,
  } as unknown as AgentRegistry;
}
