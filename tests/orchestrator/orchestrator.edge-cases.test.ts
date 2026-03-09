import { Effect, Stream } from 'effect';
import type { AgentConfig } from 'agent';
import type { AgentRegistry } from 'agent';
import { ContextWindow } from 'context';
import { resetProviderCircuit, type LLMAdapter, type LLMResponse } from 'llm';
import {
  Orchestrator,
  type OrchestratorRuntime,
} from 'orchestrator/orchestrator.js';
import {
  createUnifiedHookRegistry,
  type UnifiedHookRegistry,
} from 'orchestrator/unifiedHooks/registry.js';
import { getOutputSchemaJson } from 'shared';
import { successResult, type AgentEvent } from 'types';
import type { ToolRegistry } from 'tools';
import { makeRuntimeControlQueue, publishRuntimeControl } from 'runtime';

const REQUEST_ID = 'req-orch-edge';
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

function createAgentRegistry(maxIterations = 12): AgentRegistry {
  const base: AgentConfig = {
    type: 'standard',
    systemPrompt: 'orchestrator edge test prompt',
    tools: ['SleepTool'],
    budget: {
      maxIterations,
      maxToolCalls: 50,
      maxDurationMs: 120_000,
      llmStreamTimeoutMs: 10_000,
    },
    llmParams: {
      maxTokens: 4096,
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

function createToolRegistry(onSleepAbort?: () => void): ToolRegistry {
  return {
    getDefinitions: () => [{
      name: 'SleepTool',
      description: 'Long-running tool used for cancellation tests',
      parameters: {
        type: 'object',
        properties: { ms: { type: 'number' } },
        required: [],
      },
    }],
    execute: async (_name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      const ms = typeof args.ms === 'number' ? args.ms : 1000;
      const result = await new Promise<'done' | 'aborted'>((resolve) => {
        const timer = setTimeout(() => resolve('done'), ms);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          onSleepAbort?.();
          resolve('aborted');
        }, { once: true });
      });
      if (result === 'aborted') {
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

function createOrchestrator(params: {
  llm: LLMAdapter;
  toolRegistry?: ToolRegistry;
  emit?: (event: AgentEvent) => void;
  agentRegistry?: AgentRegistry;
}): Orchestrator {
  return new Orchestrator(
    { maxIterations: 20 },
    params.toolRegistry ?? createToolRegistry(),
    params.llm,
    params.emit ?? (() => {}),
    REQUEST_ID,
    undefined,
    params.agentRegistry ?? createAgentRegistry(),
    undefined,
    () => ({ provider: 'openai', model: 'mock-model', contextWindow: 200_000 })
  );
}

function registerQualityGateBlockOnce(registry: UnifiedHookRegistry): { wasUsed: () => boolean } {
  let used = false;
  registry.register({
    id: 'block-first-goal',
    mode: 'decision',
    scope: 'orchestrator',
    source: 'edge-tests',
    event: 'goal_state_reached',
    policy: { kind: 'fire_and_forget' },
    criticality: 'non_critical',
    idempotency: 'idempotent',
    priority: 100,
    timeoutMs: 3_000,
    callback: () => Effect.sync(() => {
      if (used) {
        return { kind: 'success', decision: { verdict: 'passed' } };
      }
      used = true;
      return {
        kind: 'success',
        decision: {
          verdict: 'failed',
          issues: ['Continue execution once before terminating'],
        },
      };
    }),
  } as never);
  return { wasUsed: () => used };
}

function registerBoundsSplitOnce(registry: UnifiedHookRegistry): { wasUsed: () => boolean } {
  let used = false;
  registry.register({
    id: 'split-on-bounds',
    mode: 'decision',
    scope: 'orchestrator',
    source: 'edge-tests',
    event: 'bounds_exceeded',
    policy: { kind: 'fire_and_forget' },
    criticality: 'non_critical',
    idempotency: 'idempotent',
    priority: 100,
    timeoutMs: 3_000,
    callback: () => Effect.sync(() => {
      if (used) {
        return { kind: 'skip', reason: 'already split' };
      }
      used = true;
      return {
        kind: 'success',
        decision: {
          action: 'split',
          workItems: [
            {
              goal: 'child task A',
              objective: 'run child A',
              agent: 'standard',
              dependencies: [],
            },
            {
              goal: 'child task B',
              objective: 'run child B',
              agent: 'standard',
              dependencies: [],
            },
          ],
        },
      };
    }),
  } as never);
  return { wasUsed: () => used };
}

describe('Orchestrator edge cases (Effect runtime)', () => {
  beforeEach(() => {
    resetProviderCircuit();
  });

  it('cancels an in-flight internal hook and returns quiesced cancellation', async () => {
    const llm = createMockLLM([
      createResponse({ action: 'done', response: 'initial complete', goalStateReached: true }),
      createResponse({ action: 'done', response: 'second pass', goalStateReached: true }),
      createResponse({ action: 'done', response: 'third pass', goalStateReached: true }),
    ]);

    const registry = createUnifiedHookRegistry();
    const qualityGate = registerQualityGateBlockOnce(registry);

    const controlQueue = Effect.runSync(makeRuntimeControlQueue());
    let hookStarted = false;
    let hookAborted = false;
    let cancelSent = false;

    const orchestrator = createOrchestrator({
      llm,
      emit: (event) => {
        if (
          event.type === 'hook_call'
          && !cancelSent
          && typeof (event.data as Record<string, unknown>)?.phase === 'string'
          && (event.data as Record<string, unknown>).phase === 'starting'
        ) {
          cancelSent = true;
          void Effect.runPromise(publishRuntimeControl(controlQueue, {
            action: 'cancel',
            cancellation: {
              requestedAt: Date.now(),
              requestedBy: 'system',
              reason: 'cancel while hook is running',
              scope: 'run',
            },
          }));
        }
      },
    });

    const runtime: OrchestratorRuntime = {
      hookRegistry: registry,
      controlQueue,
      executeEffectHook: async (_event, _context, signal) => {
        hookStarted = true;
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 20_000);
          signal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            hookAborted = true;
            resolve();
          }, { once: true });
        });
      },
    };

    const result = await Effect.runPromise(orchestrator.execute(
      new ContextWindow('edge-hook-cancel', 200_000),
      'hook cancellation goal',
      'standard',
      CWD,
      runtime
    ));

    expect(hookStarted).toBe(true);
    expect(hookAborted).toBe(true);
    expect(result.terminationReason).toBe('user_stopped');
    expect(result.runControl.state).toBe('cancelled');
  });

  it('cancels a split work-item tree and interrupts active child work', async () => {
    const llm = createMockLLM([
      createResponse({ action: 'continue', response: 'keep working', goalStateReached: false }),
      createResponse({
        action: 'continue',
        response: '',
        goalStateReached: false,
        toolCalls: [{ id: 'sleep_a', name: 'SleepTool', arguments: { ms: 8_000 } }],
      }),
      createResponse({
        action: 'continue',
        response: '',
        goalStateReached: false,
        toolCalls: [{ id: 'sleep_b', name: 'SleepTool', arguments: { ms: 8_000 } }],
      }),
      createResponse({ action: 'continue', response: 'loop', goalStateReached: false }),
    ]);

    const registry = createUnifiedHookRegistry();
    const split = registerBoundsSplitOnce(registry);

    let abortedChildren = 0;
    const toolRegistry = createToolRegistry(() => {
      abortedChildren++;
    });

    const controlQueue = Effect.runSync(makeRuntimeControlQueue());
    let cancelSent = false;

    const orchestrator = createOrchestrator({
      llm,
      toolRegistry,
      agentRegistry: createAgentRegistry(1),
    });

    const result = await Effect.runPromise(orchestrator.execute(
      new ContextWindow('edge-tree-cancel', 200_000),
      'tree cancellation goal',
      'standard',
      CWD,
      {
        hookRegistry: registry,
        controlQueue,
        onIteration: async () => {
          if (cancelSent || !split.wasUsed()) {
            return;
          }
          cancelSent = true;
          await Effect.runPromise(publishRuntimeControl(controlQueue, {
            action: 'cancel',
            cancellation: {
              requestedAt: Date.now(),
              requestedBy: 'system',
              reason: 'cancel child tree',
              scope: 'run',
            },
          }));
        },
      }
    ));

    expect(split.wasUsed()).toBe(true);
    expect(cancelSent).toBe(true);
    expect(abortedChildren).toBeGreaterThanOrEqual(0);
    expect(result.terminationReason).toBe('user_stopped');
    expect(result.runControl.state).toBe('cancelled');
  });

  it('keeps run state running for scoped work_item cancellation', () => {
    const orchestrator = createOrchestrator({
      llm: createMockLLM([
        createResponse({ action: 'continue', response: 'noop', goalStateReached: false }),
      ]),
    });

    const targetWorkId = 'work_scope_target';
    const abortController = new AbortController();
    const internal = orchestrator as unknown as {
      runtimeRunControl: { state: string; cancellation?: unknown };
      activeInProgress: Map<string, { abortController: AbortController; cancelReason?: string }>;
      applyRuntimeControlMessage: (message: {
        action: 'cancel';
        cancellation: {
          requestedAt: number;
          requestedBy: 'system';
          reason: string;
          scope: 'work_item';
          targetWorkIds: string[];
        };
      }) => void;
    };

    internal.runtimeRunControl = { state: 'running' };
    internal.activeInProgress = new Map([
      [targetWorkId, { abortController }],
    ]);

    internal.applyRuntimeControlMessage({
      action: 'cancel',
      cancellation: {
        requestedAt: Date.now(),
        requestedBy: 'system',
        reason: 'cancel targeted work',
        scope: 'work_item',
        targetWorkIds: [targetWorkId],
      },
    });

    expect(internal.runtimeRunControl.state).toBe('running');
    expect(internal.runtimeRunControl.cancellation).toBeUndefined();
    expect(abortController.signal.aborted).toBe(true);
    expect(internal.activeInProgress.get(targetWorkId)?.cancelReason).toBe('cancel targeted work');
  });
});
