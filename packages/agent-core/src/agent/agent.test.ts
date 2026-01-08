/**
 * Minimal tests for Agent primitive.
 */

import { describe, it, expect } from 'bun:test';
import { Agent } from './agent.js';
import type { AgentConfig } from './types.js';
import { ContextWindow } from '../types/context.js';
import { createWorkItem } from '../wizard/work-item.js';
import type { LLMAdapter, LLMResponse } from '../llm/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import { successResult } from '../types/tools.js';

function createMockLLM(response: LLMResponse): LLMAdapter {
  return {
    respond: async () => response,
    stream: async function* () {
      yield response.content;
      return response;
    },
  } as LLMAdapter;
}

function createMockToolRegistry(): ToolRegistry {
  return {
    getDefinitions: () => [],
    getWorkingDir: () => process.cwd(),
    execute: async () => ({
      toolName: 'Read',
      status: 'error',
      output: '',
      error: 'Tool not available',
      durationMs: 0,
      isSuccess: false,
    }),
  } as unknown as ToolRegistry;
}

function createReadToolRegistry(output: string): ToolRegistry {
  return {
    getDefinitions: () => [],
    getWorkingDir: () => process.cwd(),
    execute: async (name: string) => {
      if (name.toLowerCase() !== 'read') {
        return {
          toolName: name,
          status: 'error',
          output: '',
          error: 'Tool not available',
          durationMs: 0,
          isSuccess: false,
        };
      }
      return successResult('Read', output, 1);
    },
  } as unknown as ToolRegistry;
}

describe('Agent', () => {
  it('returns response when structured output action is done', async () => {
    const llm = createMockLLM({
      content: JSON.stringify({
        action: 'done',
        response: 'done',
        goalStateReached: true,
        userPrompt: null,
      }),
      stopReason: 'end_turn',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: 'test-model',
      durationMs: 1,
    });

    const config: AgentConfig = {
      type: 'standard',
      systemPrompt: 'Test prompt',
      tools: [],
      budget: { maxIterations: 2, maxToolCalls: 0, maxDurationMs: 1000 },
      outputSchema: { name: 'agent_action_output', schema: { type: 'object' }, strict: true },
    };

    const agent = new Agent(
      config,
      llm,
      createMockToolRegistry(),
      undefined,
      '',
      undefined,
      { model: 'test-model', provider: 'openai', apiKey: 'test-key' }
    );
    const context = new ContextWindow('test-session', 200_000);
    const workItem = createWorkItem({ goal: 'test', objective: 'test' });

    const result = await agent.run({ context, workItem });

    expect(result.success).toBe(true);
    expect(result.response).toBe('done');
  });

  it('halts on repeated identical tool calls without progress', async () => {
    let callId = 0;
    const config: AgentConfig = {
      type: 'standard',
      systemPrompt: 'Test prompt',
      tools: ['Read'],
      budget: { maxIterations: 5, maxToolCalls: 10, maxDurationMs: 1000 },
      outputSchema: { name: 'goal_driven_output', schema: { type: 'object' }, strict: true },
    };

    const agent = new Agent(
      config,
      {
        respond: async () => ({
          content: '',
          toolCalls: [
            { id: `call_${++callId}`, name: 'Read', arguments: { path: 'README.md' } },
          ],
          stopReason: 'tool_use',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: 'test-model',
          durationMs: 1,
        }),
        stream: async function* () {
          yield '';
          return {
            content: '',
            toolCalls: [
              { id: `call_${++callId}`, name: 'Read', arguments: { path: 'README.md' } },
            ],
            stopReason: 'tool_use',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: 'test-model',
            durationMs: 1,
          };
        },
      } as LLMAdapter,
      createReadToolRegistry('file contents'),
      undefined,
      '',
      undefined,
      { model: 'test-model', provider: 'openai', apiKey: 'test-key' }
    );
    const context = new ContextWindow('test-session', 200_000);
    const workItem = createWorkItem({ goal: 'test', objective: 'test' });

    const result = await agent.run({ context, workItem });

    expect(result.success).toBe(false);
    expect(result.terminationReason).toBe('stagnation:tool_repeat');
  });
});
