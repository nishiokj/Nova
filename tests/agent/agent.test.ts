import { Effect, Stream } from 'effect';
import { Agent } from 'agent/agent.js';
import { AgentRegistry } from 'agent/agent-registry.js';
import type { AgentConfig, AgentTerminalResult, InternalHookEvent } from 'agent/types.js';
import { ContextWindow } from 'context';
import { resetProviderCircuit, type LLMAdapter, type LLMResponse } from 'llm';
import { getOutputSchemaJson } from 'shared';
import type { ToolRegistry } from 'tools';
import { createWorkItem, successResult } from 'types';

function response(
  action: 'done' | 'continue',
  text: string,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
): LLMResponse {
  return {
    content: JSON.stringify({
      action,
      response: text,
      goalStateReached: action === 'done',
      awaitingUserInput: false,
    }),
    stopReason: toolCalls?.length ? 'tool_use' : 'end_turn',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    toolCalls,
    model: 'mock-model',
    durationMs: 1,
  };
}

function mockLLM(nextResponse: LLMResponse, onStream?: () => void): LLMAdapter & { calls: number } {
  const adapter = {
    calls: 0,
    respond: () => Effect.succeed(nextResponse),
    stream: (params: Parameters<LLMAdapter['stream']>[0]) => Stream.unwrap(Effect.sync(() => {
      adapter.calls++;
      onStream?.();
      params.onComplete?.(nextResponse);
      return Stream.fromIterable([nextResponse.content]);
    })),
  };
  return adapter as LLMAdapter & { calls: number };
}

function toolRegistry(execute?: ToolRegistry['execute']): ToolRegistry & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getDefinitions: () => [{
      name: 'Read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }],
    getWorkingDir: () => process.cwd(),
    isParallelSafe: () => false,
    execute: async (name, args, options) => {
      calls.push(name);
      return execute
        ? execute(name, args, options)
        : successResult(name, 'file contents', 1);
    },
  } as unknown as ToolRegistry & { calls: string[] };
}

function config(type = 'standard', tools = ['Read']): AgentConfig {
  return {
    type,
    systemPrompt: 'test',
    tools,
    budget: { maxIterations: 0, maxToolCalls: 0, maxDurationMs: 0, llmStreamTimeoutMs: 1 },
    llmParams: { maxTokens: 1024, temperature: 0 },
    outputSchema: getOutputSchemaJson('agent_action'),
  };
}

function workItem() {
  return createWorkItem({
    goal: 'goal',
    objective: 'objective',
    agent: 'standard',
    bounds: { maxLlmCalls: 0, maxToolCalls: 0, maxDurationMs: 0 },
  });
}

function params(globalContext = new ContextWindow('session', 200_000)) {
  return {
    globalContext,
    workItem: workItem(),
    cwd: process.cwd(),
    turnPolicy: { iteration: 1, maxIterations: 2, allowToolCalls: true, toolCallLimit: 10 },
  };
}

function makeAgent(llm: LLMAdapter, registry: ToolRegistry, overrides: Partial<ConstructorParameters<typeof Agent>[1]> = {}) {
  return new Agent(config(), {
    llm,
    toolRegistry: registry,
    llmConfig: { provider: 'openai', model: 'mock-model', apiKey: 'test', contextWindow: 200_000 },
    ...overrides,
  });
}

describe('Agent.executeTurn single-turn cutover', () => {
  beforeEach(() => resetProviderCircuit());

  it('makes exactly one LLM request and returns explicit continuation after one tool batch', async () => {
    const llm = mockLLM(response('continue', 'working', [
      { id: 'read-1', name: 'Read', arguments: { path: '/tmp/a.ts' } },
    ]));
    const tools = toolRegistry();
    const result = await Effect.runPromise(makeAgent(llm, tools).executeTurn(params()));

    expect(llm.calls).toBe(1);
    expect(tools.calls).toEqual(['Read']);
    expect(result.status).toBe('continue');
    expect(result).not.toHaveProperty('terminationReason');
    expect(result.metrics.llmCallsMade).toBe(1);
  });

  it('executes no more tool calls than the Orchestrator allocation', async () => {
    const llm = mockLLM(response('continue', 'working', [
      { id: 'read-1', name: 'Read', arguments: { path: '/tmp/a.ts' } },
      { id: 'read-2', name: 'Read', arguments: { path: '/tmp/b.ts' } },
    ]));
    const tools = toolRegistry();
    const turnParams = params();
    turnParams.turnPolicy.toolCallLimit = 1;

    const result = await Effect.runPromise(makeAgent(llm, tools).executeTurn(turnParams));

    expect(tools.calls).toEqual(['Read']);
    expect(result.metrics.toolCallsMade).toBe(1);
  });

  it('does not enforce Agent config or WorkItem execution bounds', async () => {
    const llm = mockLLM(response('done', 'complete'));
    const result = await Effect.runPromise(makeAgent(llm, toolRegistry()).executeTurn(params()));

    expect(llm.calls).toBe(1);
    expect(result.status).toBe('terminal');
    if (result.status === 'terminal') expect(result.terminationReason).toBe('goal_state_reached');
  });

  it('obeys Orchestrator final-turn policy and never executes returned tools', async () => {
    const llm = mockLLM(response('continue', '', [
      { id: 'read-1', name: 'Read', arguments: { path: '/tmp/a.ts' } },
    ]));
    const tools = toolRegistry();
    const turnParams = params();
    turnParams.turnPolicy = { iteration: 2, maxIterations: 2, allowToolCalls: false, toolCallLimit: 0 };
    const result = await Effect.runPromise(makeAgent(llm, tools).executeTurn(turnParams));

    expect(llm.calls).toBe(1);
    expect(tools.calls).toEqual([]);
    expect(result.status).toBe('terminal');
    if (result.status === 'terminal') expect(result.terminationReason).toBe('invalid_action');
  });

  it('cancels before a turn without making an LLM request', async () => {
    const llm = mockLLM(response('done', 'should not run'));
    const controller = new AbortController();
    controller.abort();
    const result = await Effect.runPromise(makeAgent(llm, toolRegistry()).executeTurn({
      ...params(),
      signal: controller.signal,
    }));

    expect(llm.calls).toBe(0);
    expect(result.status).toBe('terminal');
    if (result.status === 'terminal') expect(result.terminationReason).toBe('user_stopped');
  });

  it('observes cancellation while the LLM request is in flight', async () => {
    const controller = new AbortController();
    const llm = mockLLM(response('done', 'ignored'), () => controller.abort());
    const result = await Effect.runPromise(makeAgent(llm, toolRegistry()).executeTurn({
      ...params(),
      signal: controller.signal,
    }));

    expect(llm.calls).toBe(1);
    expect(result.status).toBe('terminal');
    if (result.status === 'terminal') expect(result.terminationReason).toBe('user_stopped');
  });

  it('observes cancellation during a tool batch', async () => {
    const controller = new AbortController();
    const llm = mockLLM(response('continue', '', [
      { id: 'read-1', name: 'Read', arguments: { path: '/tmp/a.ts' } },
    ]));
    const tools = toolRegistry(async (name) => {
      controller.abort();
      return successResult(name, 'contents', 1);
    });
    const result = await Effect.runPromise(makeAgent(llm, tools).executeTurn({
      ...params(),
      signal: controller.signal,
    }));

    expect(llm.calls).toBe(1);
    expect(result.status).toBe('terminal');
    if (result.status === 'terminal') expect(result.terminationReason).toBe('user_stopped');
  });

  it('returns a fresh context delta and leaves global context unchanged', async () => {
    const global = new ContextWindow('global', 200_000);
    global.addMessage('user', 'existing input');
    const before = global.serialize();
    const llm = mockLLM(response('continue', '', [
      { id: 'read-1', name: 'Read', arguments: { path: '/tmp/a.ts' } },
    ]));
    const result = await Effect.runPromise(makeAgent(llm, toolRegistry()).executeTurn(params(global)));

    expect(global.serialize()).toEqual(before);
    expect(result.localContext).not.toBe(global);
    expect(result.localContext.hasReadFile('/tmp/a.ts')).toBe(true);
    expect(result.filesRead).toEqual(['/tmp/a.ts']);
  });

  it('delegates agent tools to the Orchestrator callback', async () => {
    const explorer = config('explorer', []);
    const registry = new AgentRegistry([explorer]);
    const llm = mockLLM(response('continue', '', [
      { id: 'agent-1', name: 'explorer', arguments: { objective: 'inspect code' } },
    ]));
    const delegatedContext = new ContextWindow('delegated', 200_000);
    const terminal: AgentTerminalResult = {
      status: 'terminal',
      success: true,
      response: 'delegated result',
      metrics: { llmCallsMade: 1, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 1 },
      filesRead: [], invalidatedPaths: [], toolErrors: [], localContext: delegatedContext,
      terminationReason: 'goal_state_reached', needsUserInput: false, isRefusal: false,
    };
    const delegate = vi.fn(() => Effect.succeed(terminal));
    const hooks: InternalHookEvent[] = [];
    const parent = new Agent(config('standard', ['explorer']), {
      llm,
      toolRegistry: toolRegistry(),
      agentRegistry: registry,
      executeAgentTool: delegate,
      internalHookQueue: { enqueue: (event) => hooks.push(event) },
      llmConfig: { provider: 'openai', model: 'mock-model', apiKey: 'test', contextWindow: 200_000 },
    });

    const result = await Effect.runPromise(parent.executeTurn(params()));
    expect(delegate).toHaveBeenCalledTimes(1);
    expect((delegate.mock.calls as unknown[][])[0]?.[0]).toMatchObject({ agentType: 'explorer', parentAgentType: 'standard' });
    expect(result.status).toBe('continue');
    expect(hooks.filter((event) => event.type === 'turn_completed')).toHaveLength(1);
    expect(hooks.filter((event) => event.type === 'agent_completed')).toHaveLength(0);
  });

  it('emits turn_completed once and agent_completed only for terminal turns', async () => {
    const events: InternalHookEvent[] = [];
    const queue = { enqueue: (event: InternalHookEvent) => events.push(event) };
    await Effect.runPromise(makeAgent(mockLLM(response('done', 'complete')), toolRegistry(), {
      internalHookQueue: queue,
    }).executeTurn(params()));

    expect(events.filter((event) => event.type === 'turn_completed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'agent_completed')).toHaveLength(1);
  });
});
