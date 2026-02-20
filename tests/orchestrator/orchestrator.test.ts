import { Effect, Stream } from 'effect';
import type { AgentConfig } from 'agent';
import type { AgentRegistry } from 'agent';
import { ContextWindow } from 'context';
import { resetProviderCircuit, type LLMAdapter, type LLMResponse } from 'llm';
import {
  Orchestrator,
  type OrchestratorRuntime,
} from 'orchestrator/orchestrator.js';
import { getOutputSchemaJson } from 'shared';
import { successResult } from 'types';
import type { ToolRegistry } from 'tools';
import { makeRuntimeControlQueue, publishRuntimeControl } from 'runtime';

const REQUEST_ID = 'req-orch-1';
const CWD = process.cwd();

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
      return Stream.fromIterable(response.content.length > 0 ? [response.content] : []);
    })),
  } as LLMAdapter;
}

function createToolRegistry(): ToolRegistry {
  return {
    getDefinitions: () => [{
      name: 'SleepTool',
      description: 'Sleep tool',
      parameters: {
        type: 'object',
        properties: { ms: { type: 'number' } },
        required: [],
      },
    }],
    execute: async (_name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      const ms = typeof args.ms === 'number' ? args.ms : 1;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, ms);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
      return successResult('SleepTool', 'ok', 1);
    },
    getWorkingDir: () => CWD,
    isParallelSafe: () => false,
  } as unknown as ToolRegistry;
}

function createAgentRegistry(): AgentRegistry {
  const base: AgentConfig = {
    type: 'standard',
    systemPrompt: 'orchestrator test prompt',
    tools: ['SleepTool'],
    budget: {
      maxIterations: 10,
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
      if (!config) {
        throw new Error(`Missing config for ${type}`);
      }
      return config;
    },
    listToolDefinitions: () => [],
    register: () => {},
    get: () => null,
  } as unknown as AgentRegistry;
}

function createOrchestrator(llm: LLMAdapter): Orchestrator {
  return new Orchestrator(
    { maxIterations: 8 },
    createToolRegistry(),
    llm,
    () => {},
    REQUEST_ID,
    undefined,
    createAgentRegistry(),
    undefined,
    () => ({ provider: 'openai', model: 'mock-model' })
  );
}

describe('Orchestrator (Effect runtime)', () => {
  beforeEach(() => {
    resetProviderCircuit();
  });

  it('completes a basic goal with Effect-native LLM stream', async () => {
    const llm = createMockLLM([
      createResponse({ action: 'done', response: 'goal complete', goalStateReached: true }),
    ]);
    const orchestrator = createOrchestrator(llm);

    const result = await Effect.runPromise(orchestrator.execute(
      new ContextWindow('orch-session-1', 200_000),
      'complete goal',
      'standard',
      CWD
    ));

    expect(result.success).toBe(true);
    expect(result.terminationReason).toBe('goal_state_reached');
    expect(result.runControl.state).toBe('running');
  });

  it('pauses through runtime control queue and returns paused result', async () => {
    const llm = createMockLLM([
      createResponse({ action: 'continue', response: 'working', goalStateReached: false }),
      createResponse({ action: 'continue', response: 'still working', goalStateReached: false }),
    ]);
    const orchestrator = createOrchestrator(llm);
    const controlQueue = Effect.runSync(makeRuntimeControlQueue());

    let pauseSent = false;
    const runtime: OrchestratorRuntime = {
      controlQueue,
      onIteration: async ({ iteration }) => {
        if (pauseSent || iteration !== 1) return;
        pauseSent = true;
        await Effect.runPromise(publishRuntimeControl(controlQueue, {
          action: 'pause',
          pause: {
            requestedAt: Date.now(),
            requestedBy: 'system',
            reason: 'pause for test',
          },
        }));
      },
    };

    const result = await Effect.runPromise(orchestrator.execute(
      new ContextWindow('orch-session-2', 200_000),
      'pause goal',
      'standard',
      CWD,
      runtime
    ));

    expect(result.paused).toBe(true);
    expect(result.terminationReason).toBe('user_input_required');
    expect(result.runControl.state).toBe('paused');
    expect(result.pauseMetadata?.reason).toBe('pause for test');
  });

  it('cancels through runtime control queue and returns quiesced cancellation', async () => {
    const llm = createMockLLM([
      createResponse({
        action: 'continue',
        response: '',
        goalStateReached: false,
        toolCalls: [{ id: 'sleep_1', name: 'SleepTool', arguments: { ms: 500 } }],
      }),
      createResponse({ action: 'continue', response: 'should not complete normally', goalStateReached: false }),
    ]);
    const orchestrator = createOrchestrator(llm);
    const controlQueue = Effect.runSync(makeRuntimeControlQueue());

    let cancelSent = false;
    const runtime: OrchestratorRuntime = {
      controlQueue,
      onIteration: async ({ iteration }) => {
        if (cancelSent || iteration !== 1) return;
        cancelSent = true;
        await Effect.runPromise(publishRuntimeControl(controlQueue, {
          action: 'cancel',
          cancellation: {
            requestedAt: Date.now(),
            requestedBy: 'system',
            reason: 'cancel for test',
            scope: 'run',
          },
        }));
      },
    };

    const result = await Effect.runPromise(orchestrator.execute(
      new ContextWindow('orch-session-3', 200_000),
      'cancel goal',
      'standard',
      CWD,
      runtime
    ));

    expect(result.terminationReason).toBe('user_stopped');
    expect(result.runControl.state).toBe('cancelled');
    expect(result.cancellationMetadata?.reason).toBe('cancel for test');
  });
});
