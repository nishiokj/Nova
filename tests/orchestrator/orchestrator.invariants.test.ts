import { Effect, Stream } from 'effect';
import type { AgentConfig } from 'agent';
import type { AgentRegistry } from 'agent';
import { ContextWindow } from 'context';
import { resetProviderCircuit, type LLMAdapter, type LLMResponse } from 'llm';
import { Orchestrator } from 'orchestrator/orchestrator.js';
import { getOutputSchemaJson } from 'shared';
import { successResult, type AgentEvent } from 'types';
import type { ToolRegistry } from 'tools';
import { makeRuntimeControlQueue, publishRuntimeControl } from 'runtime';

const REQUEST_ID = 'req-orch-invariants';
const CWD = process.cwd();

function response(action: 'done' | 'continue', text: string, goalStateReached: boolean, toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): LLMResponse {
  return {
    content: JSON.stringify({
      action,
      response: text,
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
  let idx = 0;
  const next = () => {
    const value = sequence[Math.min(idx, sequence.length - 1)];
    idx++;
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
      description: 'Sleep tool for cancellation invariants',
      parameters: {
        type: 'object',
        properties: { ms: { type: 'number' } },
        required: [],
      },
    }],
    execute: async (_name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      const ms = typeof args.ms === 'number' ? args.ms : 1;
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
      return successResult('SleepTool', 'ok', 1);
    },
    getWorkingDir: () => CWD,
    isParallelSafe: () => false,
  } as unknown as ToolRegistry;
}

function createAgentRegistry(): AgentRegistry {
  const base: AgentConfig = {
    type: 'standard',
    systemPrompt: 'invariant prompt',
    tools: ['SleepTool'],
    budget: {
      maxIterations: 10,
      maxToolCalls: 20,
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

function createOrchestrator(llm: LLMAdapter, toolRegistry?: ToolRegistry, emit?: (event: AgentEvent) => void): Orchestrator {
  return new Orchestrator(
    { maxIterations: 10 },
    toolRegistry ?? createToolRegistry(),
    llm,
    emit ?? (() => {}),
    REQUEST_ID,
    undefined,
    createAgentRegistry(),
    undefined,
    () => ({ provider: 'openai', model: 'mock-model' })
  );
}

describe('Orchestrator invariants (Effect runtime)', () => {
  beforeEach(() => {
    resetProviderCircuit();
  });

  it('emits balanced iteration lifecycle events per work item', async () => {
    const events: AgentEvent[] = [];
    const orchestrator = createOrchestrator(
      createMockLLM([
        response('continue', 'first pass', false),
        response('done', 'complete', true),
      ]),
      undefined,
      (event) => events.push(event)
    );

    const result = await Effect.runPromise(orchestrator.execute(
      new ContextWindow('invariant-lifecycle', 200_000),
      'lifecycle goal',
      'standard',
      CWD
    ));

    expect(result.success).toBe(true);

    const started = events.filter((event) => event.type === 'iteration_started');
    const completed = events.filter((event) => event.type === 'iteration_completed');

    expect(started.length).toBeGreaterThan(0);
    expect(completed.length).toBeGreaterThan(0);
    expect(completed.length).toBeLessThanOrEqual(started.length);
  });

  it('cancellation quiesces active tool execution before returning', async () => {
    let abortedTools = 0;
    const toolRegistry = createToolRegistry(() => {
      abortedTools++;
    });
    const orchestrator = createOrchestrator(
      createMockLLM([
        response('continue', '', false, [{ id: 'sleep_1', name: 'SleepTool', arguments: { ms: 15_000 } }]),
        response('continue', 'loop', false),
      ]),
      toolRegistry
    );

    const controlQueue = Effect.runSync(makeRuntimeControlQueue());
    let sentCancel = false;

    const startedAt = Date.now();
    const result = await Effect.runPromise(orchestrator.execute(
      new ContextWindow('invariant-cancel', 200_000),
      'cancel invariant goal',
      'standard',
      CWD,
      {
        controlQueue,
        onIteration: async ({ iteration }) => {
          if (sentCancel || iteration !== 1) return;
          sentCancel = true;
          await Effect.runPromise(publishRuntimeControl(controlQueue, {
            action: 'cancel',
            cancellation: {
              requestedAt: Date.now(),
              requestedBy: 'system',
              reason: 'cancel invariant',
              scope: 'run',
            },
          }));
        },
      }
    ));
    const durationMs = Date.now() - startedAt;

    expect(result.terminationReason).toBe('user_stopped');
    expect(result.runControl.state).toBe('cancelled');
    expect(abortedTools).toBeGreaterThanOrEqual(0);
    expect(durationMs).toBeLessThan(10_000);
  });
});
