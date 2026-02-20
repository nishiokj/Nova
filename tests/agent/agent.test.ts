import { Effect, Stream } from 'effect';
import { Agent } from 'agent/agent.js';
import type { AgentConfig } from 'agent/types.js';
import { ContextWindow } from 'context';
import { resetProviderCircuit, type LLMAdapter, type LLMResponse } from 'llm';
import { getOutputSchemaJson } from 'shared';
import type { ToolRegistry } from 'tools';
import { createWorkItem } from 'work';
import { successResult } from 'types';

function createResponse(params: {
  action: 'done' | 'continue';
  response: string;
  goalStateReached: boolean;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}): LLMResponse {
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

function createMockLLM(responses: LLMResponse[]): LLMAdapter {
  let index = 0;
  const next = (): LLMResponse => {
    const response = responses[Math.min(index, responses.length - 1)];
    index++;
    return response;
  };

  return {
    respond: () => Effect.sync(next),
    stream: (params) => Stream.unwrap(Effect.sync(() => {
      const response = next();
      params.onComplete?.(response);
      const chunks = response.content.length > 0 ? [response.content] : [];
      return Stream.fromIterable(chunks);
    })),
  } as LLMAdapter;
}

function createToolRegistry(): ToolRegistry {
  const calls: string[] = [];

  return {
    getDefinitions: () => [{
      name: 'SleepTool',
      description: 'Mock sleep tool',
      parameters: {
        type: 'object',
        properties: { ms: { type: 'number' } },
        required: [],
      },
    }],
    getWorkingDir: () => process.cwd(),
    isParallelSafe: () => false,
    execute: async (name, args) => {
      calls.push(name);
      if (name === 'SleepTool') {
        const ms = typeof args.ms === 'number' ? args.ms : 1;
        await new Promise((resolve) => setTimeout(resolve, ms));
        return successResult('SleepTool', 'slept', 1);
      }
      return successResult(name, 'ok', 1);
    },
    __calls: calls,
  } as unknown as ToolRegistry;
}

function createAgent(llm: LLMAdapter, toolRegistry: ToolRegistry): Agent {
  const config: AgentConfig = {
    type: 'standard',
    systemPrompt: 'Test prompt',
    tools: ['SleepTool'],
    budget: {
      maxIterations: 4,
      maxToolCalls: 8,
      maxDurationMs: 30_000,
      llmStreamTimeoutMs: 5_000,
    },
    llmParams: {
      maxTokens: 1024,
      temperature: 0,
    },
    outputSchema: getOutputSchemaJson('agent_action'),
  };

  return new Agent(config, {
    llm,
    toolRegistry,
    llmConfig: {
      provider: 'openai',
      model: 'mock-model',
      apiKey: 'test-key',
    },
  });
}

function createTestWorkItem() {
  return createWorkItem({
    goal: 'test goal',
    objective: 'test objective',
    agent: 'standard',
    bounds: {
      maxLlmCalls: 8,
      maxToolCalls: 8,
      maxDurationMs: 30_000,
    },
  });
}

describe('Agent (Effect runtime)', () => {
  beforeEach(() => {
    resetProviderCircuit();
  });

  it('completes when structured output returns done + goalStateReached', async () => {
    const llm = createMockLLM([
      createResponse({ action: 'done', response: 'done', goalStateReached: true }),
    ]);
    const toolRegistry = createToolRegistry();
    const agent = createAgent(llm, toolRegistry);

    const result = await Effect.runPromise(
      agent.run({
        globalContext: new ContextWindow('session-agent-1', 200_000),
        workItem: createTestWorkItem(),
        cwd: process.cwd(),
      })
    );

    expect(result.success).toBe(true);
    expect(result.terminationReason).toBe('goal_state_reached');
    expect(typeof result.response).toBe('string');
  });

  it('stops immediately when runControl state is cancelling', async () => {
    const llm = createMockLLM([
      createResponse({ action: 'continue', response: 'still working', goalStateReached: false }),
    ]);
    const toolRegistry = createToolRegistry();
    const agent = createAgent(llm, toolRegistry);

    const result = await Effect.runPromise(
      agent.run({
        globalContext: new ContextWindow('session-agent-2', 200_000),
        workItem: createTestWorkItem(),
        cwd: process.cwd(),
        runControl: {
          execution: {
            requestId: 'req-agent-cancel',
            runId: 'req-agent-cancel',
            workItemId: 'work-agent-cancel',
            attempt: 1,
          },
          control: {
            state: 'cancelling',
            cancellation: {
              requestedAt: Date.now(),
              requestedBy: 'system',
              reason: 'cancel for test',
              scope: 'run',
            },
          },
        },
      })
    );

    expect(result.success).toBe(false);
    expect(result.terminationReason).toBe('user_stopped');
    expect(result.error).toContain('cancel');
  });

  it('executes tool calls with Effect-native stream flow', async () => {
    const llm = createMockLLM([
      createResponse({
        action: 'continue',
        response: '',
        goalStateReached: false,
        toolCalls: [{ id: 'call_1', name: 'SleepTool', arguments: { ms: 1 } }],
      }),
      createResponse({ action: 'done', response: 'all done', goalStateReached: true }),
    ]);
    const toolRegistry = createToolRegistry();
    const agent = createAgent(llm, toolRegistry);

    const result = await Effect.runPromise(
      agent.run({
        globalContext: new ContextWindow('session-agent-3', 200_000),
        workItem: createTestWorkItem(),
        cwd: process.cwd(),
      })
    );

    expect(result.success).toBe(true);
    expect(result.metrics.toolCallsMade).toBeGreaterThan(0);
    expect(result.terminationReason).toBe('goal_state_reached');
  });
});
