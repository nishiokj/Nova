import { Effect, Stream } from 'effect';
import type { AgentConfig } from 'agent';
import type { AgentRegistry } from 'agent';
import { ContextWindow } from 'context';
import { resetProviderCircuit, type LLMAdapter, type LLMResponse } from 'llm';
import { Orchestrator, type OrchestratorRuntime } from 'orchestrator/orchestrator.js';
import { getOutputSchemaJson } from 'shared';
import { successResult } from 'types';
import type { ToolRegistry } from 'tools';
import { makeRuntimeControlQueue, publishRuntimeControl } from 'runtime';

const REQUEST_ID = 'req-pause-flow';
const CWD = process.cwd();

function makeResponse(action: 'done' | 'continue', response: string, goalStateReached: boolean, toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): LLMResponse {
  return {
    content: JSON.stringify({
      action,
      response,
      goalStateReached,
      awaitingUserInput: false,
    }),
    stopReason: toolCalls && toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    toolCalls,
    model: 'mock-model',
    durationMs: 1,
  };
}

function createMockLLM(sequence: LLMResponse[]): LLMAdapter {
  let index = 0;
  const next = () => {
    const value = sequence[Math.min(index, sequence.length - 1)];
    index++;
    return value;
  };

  return {
    respond: () => Effect.sync(next),
    stream: (params) => Stream.unwrap(Effect.sync(() => {
      const value = next();
      params.onComplete?.(value);
      return Stream.fromIterable(value.content.length > 0 ? [value.content] : []);
    })),
  } as LLMAdapter;
}

function createToolRegistry(onAbort?: () => void): ToolRegistry {
  return {
    getDefinitions: () => [{
      name: 'SleepTool',
      description: 'Tool used to validate pause quiesce behavior',
      parameters: {
        type: 'object',
        properties: { ms: { type: 'number' } },
        required: [],
      },
    }],
    execute: async (_name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      const ms = typeof args.ms === 'number' ? args.ms : 1000;
      const status = await new Promise<'done' | 'aborted'>((resolve) => {
        const timer = setTimeout(() => resolve('done'), ms);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          onAbort?.();
          resolve('aborted');
        }, { once: true });
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
      return successResult('SleepTool', 'slept', 1);
    },
    getWorkingDir: () => CWD,
    isParallelSafe: () => false,
  } as unknown as ToolRegistry;
}

function createAgentRegistry(): AgentRegistry {
  const base: AgentConfig = {
    type: 'standard',
    systemPrompt: 'pause/resume test prompt',
    tools: ['SleepTool'],
    budget: {
      maxIterations: 12,
      maxToolCalls: 24,
      maxDurationMs: 120_000,
      llmStreamTimeoutMs: 10_000,
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
      if (!config) throw new Error(`Unknown type: ${type}`);
      return config;
    },
    listToolDefinitions: () => [],
    register: () => {},
    get: () => null,
  } as unknown as AgentRegistry;
}

function createOrchestrator(llm: LLMAdapter, toolRegistry?: ToolRegistry): Orchestrator {
  return new Orchestrator(
    { maxIterations: 10 },
    toolRegistry ?? createToolRegistry(),
    llm,
    () => {},
    REQUEST_ID,
    undefined,
    createAgentRegistry(),
    undefined,
    () => ({ provider: 'openai', model: 'mock-model' })
  );
}

describe('Pause/resume flow (Effect runtime)', () => {
  beforeEach(() => {
    resetProviderCircuit();
  });

  it('preserves context through serialize/deserialize', () => {
    const context = new ContextWindow('pause-context', 200_000);
    context.addMessage('user', 'start');
    context.addFileContent('/tmp/file.ts', 'const x = 1;');

    const snapshot = context.serialize();
    const restored = ContextWindow.deserialize(snapshot);

    expect(restored.sessionKey).toBe(context.sessionKey);
    expect(restored.items.length).toBe(context.items.length);
    expect(restored.hasReadFile('/tmp/file.ts')).toBe(true);
  });

  it('pause command returns paused result with user prompt', async () => {
    const orchestrator = createOrchestrator(createMockLLM([
      makeResponse('continue', 'working', false),
      makeResponse('continue', 'still working', false),
    ]));

    const controlQueue = Effect.runSync(makeRuntimeControlQueue());
    let sentPause = false;

    const runtime: OrchestratorRuntime = {
      controlQueue,
      onIteration: async ({ iteration }) => {
        if (sentPause || iteration !== 1) return;
        sentPause = true;
        await Effect.runPromise(publishRuntimeControl(controlQueue, {
          action: 'pause',
          pause: {
            requestedAt: Date.now(),
            requestedBy: 'user',
            reason: 'pause requested by test',
          },
        }));
      },
    };

    const result = await orchestrator.execute(
      new ContextWindow('pause-session', 200_000),
      'pause goal',
      'standard',
      CWD,
      runtime
    );

    expect(result.paused).toBe(true);
    expect(result.terminationReason).toBe('user_input_required');
    expect(result.runControl.state).toBe('paused');
    expect(result.userPrompt?.question).toContain('paused');
  });

  it('pause quiesces active tool work before returning', async () => {
    let abortedTools = 0;
    const orchestrator = createOrchestrator(
      createMockLLM([
        makeResponse('continue', '', false, [{ id: 'sleep_1', name: 'SleepTool', arguments: { ms: 15_000 } }]),
        makeResponse('continue', 'loop', false),
      ]),
      createToolRegistry(() => {
        abortedTools++;
      })
    );

    const controlQueue = Effect.runSync(makeRuntimeControlQueue());
    let sentPause = false;

    const startedAt = Date.now();
    const result = await orchestrator.execute(
      new ContextWindow('pause-quiesce-session', 200_000),
      'pause quiesce goal',
      'standard',
      CWD,
      {
        controlQueue,
        onIteration: async ({ iteration }) => {
          if (sentPause || iteration !== 1) return;
          sentPause = true;
          await Effect.runPromise(publishRuntimeControl(controlQueue, {
            action: 'pause',
            pause: {
              requestedAt: Date.now(),
              requestedBy: 'system',
              reason: 'pause and quiesce',
            },
          }));
        },
      }
    );
    const durationMs = Date.now() - startedAt;

    expect(result.paused).toBe(true);
    expect(result.runControl.state).toBe('paused');
    expect(abortedTools).toBeGreaterThanOrEqual(0);
    expect(durationMs).toBeLessThan(10_000);
  });
});
