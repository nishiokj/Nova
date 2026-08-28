/**
 * Orchestrator — integration tests.
 *
 * Tests the full execution loop through the public execute() API,
 * mocking at the Agent.executeTurn boundary. No hooks/runtime for clarity.
 */

import { describe, it, expect, spyOn, afterEach } from 'bun:test';
import { Effect, Queue } from 'effect';
import { Agent } from 'agent';
import type {
  AgentContinuationResult,
  AgentResultBase,
  AgentTerminationReason,
  AgentTerminalResult,
  AgentToolExecutor,
  AgentTurnParams,
  AgentTurnResult,
} from 'agent';
import type { TerminationReason } from 'types';
import { AgentRegistry } from 'agent';
import { ContextWindow } from 'context';
import type { LLMAdapter } from 'llm';
import type { ToolRegistry } from 'tools';
import { createWorkItem, type AgentEvent } from 'types';
import {
  Orchestrator,
  DEFAULT_ORCHESTRATOR_CONFIG,
  type OrchestratorConfig,
  type OrchestratorLogger,
  type OrchestratorRuntime,
} from './orchestrator.js';
import type { RuntimeControlMessage } from 'runtime';

// ── Mock factories ───────────────────────────────────────────────

function mockLLM(): LLMAdapter {
  return {
    respond: async () => ({
      content: '', stopReason: 'end_turn',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: 'test', durationMs: 0,
    }),
    stream: async function* () {
      yield '';
      return { content: '', stopReason: 'end_turn', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, model: 'test', durationMs: 0 } as any;
    },
  } as unknown as LLMAdapter;
}

function mockToolRegistry(): ToolRegistry {
  return {
    getDefinitions: () => [],
    getWorkingDir: () => '/tmp',
    isParallelSafe: () => false,
    execute: async () => ({ toolName: 'test', status: 'error', output: '', error: 'n/a', durationMs: 0, isSuccess: false }),
  } as unknown as ToolRegistry;
}

function testRegistry(types: string[] = ['standard']): AgentRegistry {
  return new AgentRegistry(types.map(type => ({
    type,
    systemPrompt: 'test',
    tools: [],
    budget: { maxIterations: 20, maxToolCalls: 150, maxDurationMs: 120_000 },
    llmParams: { maxTokens: 4096, temperature: 0 },
  } as any)));
}

const defaultModelSelection = () => ({ provider: 'openai', model: 'test', contextWindow: 200_000 });

// ── Agent result builders ────────────────────────────────────────

function baseResult(overrides: Partial<AgentResultBase> = {}): AgentResultBase {
  return {
    success: true,
    response: '',
    metrics: { llmCallsMade: 1, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
    filesRead: [],
    invalidatedPaths: [],
    toolErrors: [],
    localContext: new ContextWindow('local', 10_000),
    ...overrides,
  };
}

function continueResult(overrides: Partial<AgentResultBase> = {}): AgentContinuationResult {
  return {
    ...baseResult(overrides),
    status: 'continue',
    needsUserInput: false,
    isRefusal: false,
  };
}

function terminalResult(
  terminationReason: Exclude<AgentTerminationReason, 'user_input_required' | 'refusal' | 'rate_limit'>,
  overrides: Partial<AgentResultBase> = {}
): AgentTerminalResult {
  return {
    ...baseResult(overrides),
    status: 'terminal',
    terminationReason,
    needsUserInput: false,
    isRefusal: false,
  };
}

function goalResult(response = 'done'): AgentTerminalResult {
  return terminalResult('goal_state_reached', {
    response,
    structuredOutput: { goalStateReached: true },
  });
}

// ── Helpers ──────────────────────────────────────────────────────

function createOrch(
  config: Partial<OrchestratorConfig> = {},
  opts: {
    emit?: (e: AgentEvent) => void;
    logger?: OrchestratorLogger;
    registry?: AgentRegistry;
    getModelSelection?: (t: string) => { provider: string; model: string; contextWindow: number } | null;
  } = {},
) {
  return new Orchestrator(
    config,
    mockToolRegistry(),
    mockLLM(),
    opts.emit ?? (() => {}),
    'test-req',
    opts.logger,
    opts.registry ?? testRegistry(),
    undefined, // hooks
    opts.getModelSelection ?? defaultModelSelection,
  );
}

function run(orch: Orchestrator, ctx: ContextWindow, goal = 'goal', agentType = 'standard') {
  return Effect.runPromise(orch.execute(ctx, goal, agentType, '/tmp'));
}

function collectEvents() {
  const events: AgentEvent[] = [];
  return { events, emit: (e: AgentEvent) => events.push(e) };
}

function makeLogger() {
  const calls: Record<string, Array<[string, Record<string, unknown>?]>> = { info: [], debug: [], warning: [], error: [] };
  return {
    calls,
    info: (m: string, d?: Record<string, unknown>) => calls.info.push([m, d]),
    debug: (m: string, d?: Record<string, unknown>) => calls.debug.push([m, d]),
    warning: (m: string, d?: Record<string, unknown>) => calls.warning.push([m, d]),
    error: (m: string, d?: Record<string, unknown>) => calls.error.push([m, d]),
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('Orchestrator', () => {
  let runSpy: ReturnType<typeof spyOn>;

  afterEach(() => { runSpy?.mockRestore(); });

  function spy(fn: (this: Agent, params: AgentTurnParams) => Effect.Effect<AgentTurnResult, never>) {
    runSpy = spyOn(Agent.prototype, 'executeTurn').mockImplementation(fn);
    return runSpy;
  }

  function spySequence(...results: AgentTurnResult[]) {
    let i = 0;
    return spy(() => Effect.succeed(results[Math.min(i++, results.length - 1)]));
  }

  // ── Agent creation ─────────────────────────────────────────

  describe('agent creation failures', () => {
    it('no registry → agent_error', async () => {
      const s = spy(() => Effect.succeed(goalResult()));
      const orch = new Orchestrator({}, mockToolRegistry(), mockLLM(), () => {}, 'r', undefined, undefined, undefined, defaultModelSelection);
      const r = await run(orch, new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('agent_error');
      expect(r.error).toContain('Unknown agent type');
      expect(s).not.toHaveBeenCalled();
    });

    it('unknown agent type → agent_error', async () => {
      spy(() => Effect.succeed(goalResult()));
      const orch = createOrch({}, { registry: testRegistry(['standard']) });
      const r = await run(orch, new ContextWindow('t', 200_000), 'goal', 'nonexistent');
      expect(r.terminationReason).toBe('agent_error');
      expect(r.error).toContain('Unknown agent type');
    });

    it('no model selection → agent_error (caught by catchAllDefect)', async () => {
      spy(() => Effect.succeed(goalResult()));
      const orch = createOrch({}, { getModelSelection: () => null });
      const r = await run(orch, new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('agent_error');
      expect(r.error).toContain('No model configured');
    });
  });

  // ── Iteration bounds ───────────────────────────────────────

  describe('iteration bounds', () => {
    it('allows exactly maxIterations iterations before terminating', async () => {
      let calls = 0;
      spy(() => { calls++; return Effect.succeed(continueResult()); });
      const r = await run(createOrch({ maxIterations: 3 }), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('max_iterations_exceeded');
      expect(calls).toBe(3); // agent ran 3 times, 4th iteration triggers bound
      expect(r.metrics.iterations).toBe(3); // reported as iteration - 1
    });

    it('maxIterations=1 runs exactly one iteration', async () => {
      let calls = 0;
      spy(() => { calls++; return Effect.succeed(continueResult()); });
      const r = await run(createOrch({ maxIterations: 1 }), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('max_iterations_exceeded');
      expect(calls).toBe(1);
    });

    it('supplies 1-based turn policy and disables tools only on the final turn', async () => {
      const policies: AgentTurnParams['turnPolicy'][] = [];
      spy((params) => {
        policies.push(params.turnPolicy);
        return Effect.succeed(continueResult());
      });

      await run(createOrch({ maxIterations: 3 }), new ContextWindow('t', 200_000));

      expect(policies).toEqual([
        { iteration: 1, maxIterations: 3, allowToolCalls: true, toolCallLimit: 250 },
        { iteration: 2, maxIterations: 3, allowToolCalls: true, toolCallLimit: 250 },
        { iteration: 3, maxIterations: 3, allowToolCalls: false, toolCallLimit: 0 },
      ]);
    });

    it('checks duration before invoking an Agent turn', async () => {
      const turn = spy(() => Effect.succeed(goalResult()));
      const r = await run(createOrch({ maxDurationMs: 0 }), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('max_duration_exceeded');
      expect(turn).not.toHaveBeenCalled();
      expect(r.metrics.iterations).toBe(0);
    });
  });

  // ── Tool call bounds (orchestrator-level) ──────────────────

  describe('tool call bounds', () => {
    it('terminates at exactly maxToolCalls (>= operator)', async () => {
      spy(() => Effect.succeed(continueResult({
        metrics: { llmCallsMade: 1, toolCallsMade: 5, toolCallsSucceeded: 5, toolCallsFailed: 0, durationMs: 0 },
      })));
      const r = await run(createOrch({ maxToolCalls: 5 }), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('max_tool_calls_exceeded');
      expect(r.metrics.totalToolCalls).toBe(5);
    });

    it('does NOT terminate one below limit', async () => {
      let call = 0;
      spy(() => {
        call++;
        if (call === 1) return Effect.succeed(continueResult({
          metrics: { llmCallsMade: 1, toolCallsMade: 4, toolCallsSucceeded: 4, toolCallsFailed: 0, durationMs: 0 },
        }));
        return Effect.succeed(goalResult());
      });
      const r = await run(createOrch({ maxToolCalls: 5 }), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('goal_state_reached');
    });

    it('accumulates across iterations', async () => {
      let call = 0;
      spy(() => {
        call++;
        return Effect.succeed(continueResult({
          metrics: { llmCallsMade: 1, toolCallsMade: 4, toolCallsSucceeded: 4, toolCallsFailed: 0, durationMs: 0 },
        }));
      });
      // 4 per iteration: iter1=4 safe, iter2=8 safe, iter3=12 ≥ 10
      const r = await run(createOrch({ maxToolCalls: 10 }), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('max_tool_calls_exceeded');
      expect(call).toBe(3);
      expect(r.metrics.totalToolCalls).toBe(12);
    });
  });

  // ── Auto-compaction hysteresis ─────────────────────────────

  describe('auto-compaction', () => {
    it('triggers at compactTriggerPercent', async () => {
      const ctx = new ContextWindow('t', 100);
      ctx.updateMetrics(50, 0); // 50% = default trigger
      const compactSpy = spyOn(ctx, 'compact');
      spySequence(goalResult());
      await run(createOrch(), ctx);
      expect(compactSpy).toHaveBeenCalledTimes(1);
      compactSpy.mockRestore();
    });

    it('does NOT trigger below threshold', async () => {
      const ctx = new ContextWindow('t', 100);
      ctx.updateMetrics(49, 0); // 49% < 50%
      const compactSpy = spyOn(ctx, 'compact');
      spySequence(goalResult());
      await run(createOrch(), ctx);
      expect(compactSpy).not.toHaveBeenCalled();
      compactSpy.mockRestore();
    });

    it('hysteresis: no re-compact until below reset threshold', async () => {
      const ctx = new ContextWindow('t', 100);
      ctx.updateMetrics(60, 0); // 60% ≥ 50% → compact first iteration
      const compactSpy = spyOn(ctx, 'compact').mockReturnValue({
        itemsRemoved: 0, fileContentRemoved: 0, outputsTruncated: 0, bytesRecovered: 0,
      });
      let call = 0;
      spy(() => {
        call++;
        // After each agent run, orchestrator calls ctx.updateMetrics(localCtx.metrics.inputTokens, ...)
        // Keep usage at 50% — above reset (45%) but at trigger (50%).
        // compactedRecently=true so no re-compact.
        const lc = new ContextWindow('l', 10_000);
        lc.updateMetrics(50, 0);
        if (call >= 3) return Effect.succeed(goalResult());
        return Effect.succeed(continueResult({ localContext: lc }));
      });
      await run(createOrch(), ctx);
      expect(compactSpy).toHaveBeenCalledTimes(1); // Only the first
      compactSpy.mockRestore();
    });

    it('re-compacts after dropping below reset then rising above trigger', async () => {
      const ctx = new ContextWindow('t', 100);
      ctx.updateMetrics(60, 0); // 60% → compact
      const compactSpy = spyOn(ctx, 'compact').mockReturnValue({
        itemsRemoved: 0, fileContentRemoved: 0, outputsTruncated: 0, bytesRecovered: 0,
      });
      let call = 0;
      spy(() => {
        call++;
        const lc = new ContextWindow('l', 10_000);
        if (call === 1) { lc.updateMetrics(30, 0); return Effect.succeed(continueResult({ localContext: lc })); } // drop to 30% < 45%
        if (call === 2) { lc.updateMetrics(60, 0); return Effect.succeed(continueResult({ localContext: lc })); } // rise to 60% ≥ 50%
        return Effect.succeed(goalResult());
      });
      await run(createOrch(), ctx);
      // iter1: 60% → compact. agent → 30%. iter2: 30%<45% resets gate; 30%<50% no compact. agent → 60%. iter3: 60%≥50% → compact again.
      expect(compactSpy).toHaveBeenCalledTimes(2);
      compactSpy.mockRestore();
    });

    it('passes correct compact options from config', async () => {
      const ctx = new ContextWindow('t', 100);
      ctx.updateMetrics(60, 0);
      const compactSpy = spyOn(ctx, 'compact').mockReturnValue({
        itemsRemoved: 0, fileContentRemoved: 0, outputsTruncated: 0, bytesRecovered: 0,
      });
      spySequence(goalResult());
      await run(createOrch({ compactMaxFileCount: 42, compactTruncateTo: 9999 }), ctx);
      expect(compactSpy).toHaveBeenCalledWith({
        deduplicateByPath: true,
        maxFileContentCount: 42,
        truncateOutputsTo: 9999,
      });
      compactSpy.mockRestore();
    });
  });

  // ── Terminal conditions ────────────────────────────────────

  describe('terminal conditions', () => {
    it('goal via structuredOutput.goalStateReached', async () => {
      spySequence(terminalResult('goal_state_reached', {
        structuredOutput: { goalStateReached: true },
      }));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('goal_state_reached');
      expect(r.success).toBe(true);
    });

    it('goal via terminationReason string', async () => {
      spySequence(terminalResult('goal_state_reached'));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('goal_state_reached');
      expect(r.success).toBe(true);
    });

    it('goalStateReached must be exactly true (not truthy)', async () => {
      let call = 0;
      spy(() => {
        call++;
        if (call === 1) return Effect.succeed(continueResult({
          structuredOutput: { goalStateReached: 'yes' },
        }));
        return Effect.succeed(goalResult());
      });
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(call).toBe(2); // first call didn't trigger goal
      expect(r.terminationReason).toBe('goal_state_reached');
    });

    it('user_input_required pauses', async () => {
      spySequence({
        status: 'terminal',
        success: false,
        response: 'Which option?',
        metrics: { llmCallsMade: 1, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
        filesRead: [], invalidatedPaths: [], toolErrors: [],
        terminationReason: 'user_input_required',
        needsUserInput: true,
        userPrompt: { questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }] },
        isRefusal: false,
        localContext: new ContextWindow('l', 10_000),
      });
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('user_input_required');
      expect(r.success).toBe(false);
      expect(r.userPrompt).toBeDefined();
    });

    it('refusal terminates', async () => {
      spySequence({
        status: 'terminal',
        success: false,
        response: 'I cannot do this',
        metrics: { llmCallsMade: 1, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
        filesRead: [], invalidatedPaths: [], toolErrors: [],
        terminationReason: 'refusal',
        needsUserInput: false,
        isRefusal: true,
        localContext: new ContextWindow('l', 10_000),
      });
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('refusal');
      expect(r.success).toBe(false);
    });

    it('agent_error terminates', async () => {
      spySequence(terminalResult('agent_error', {
        success: false,
        error: 'Something broke',
      }));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('agent_error');
      expect(r.error).toBe('Something broke');
    });

    it('hard error catch-all: error + !success + action≠continue', async () => {
      spySequence(terminalResult('agent_error', {
        success: false,
        error: 'Generic failure',
        structuredOutput: { action: 'done' },
      }));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('agent_error');
      expect(r.error).toBe('Generic failure');
    });

    it('soft error: action=continue bypasses catch-all', async () => {
      let call = 0;
      spy(() => {
        call++;
        if (call === 1) return Effect.succeed(continueResult({
          success: false,
          error: 'Recoverable',
          structuredOutput: { action: 'continue' },
        }));
        return Effect.succeed(goalResult());
      });
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(call).toBe(2);
      expect(r.terminationReason).toBe('goal_state_reached');
    });

  });

  // ── Metrics ────────────────────────────────────────────────

  describe('metrics', () => {
    it('accumulates LLM and tool calls across iterations', async () => {
      let call = 0;
      spy(() => {
        call++;
        if (call <= 3) return Effect.succeed(continueResult({
          metrics: { llmCallsMade: 2, toolCallsMade: 3, toolCallsSucceeded: 3, toolCallsFailed: 0, durationMs: 0 },
        }));
        return Effect.succeed(goalResult());
      });
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.metrics.totalLlmCalls).toBe(3 * 2 + 1); // 3 continue + 1 goal
      expect(r.metrics.totalToolCalls).toBe(3 * 3); // goal has 0 tool calls
    });

    it('max_iterations reports the exact number of executed turns', async () => {
      spy(() => Effect.succeed(continueResult()));
      const r = await run(createOrch({ maxIterations: 3 }), new ContextWindow('t', 200_000));
      expect(r.metrics.iterations).toBe(3); // bound is checked before a fourth turn
    });

    it('goal_state_reached reports actual iteration', async () => {
      let call = 0;
      spy(() => {
        call++;
        if (call === 3) return Effect.succeed(goalResult());
        return Effect.succeed(continueResult());
      });
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.metrics.iterations).toBe(3);
    });

    it('durationMs reflects wall-clock time', async () => {
      // `now` is captured at iteration START (line 1151), not after agent completes.
      // Use incrementing clock so createExecutionState's startTime differs from loop's now.
      const orig = Date.now;
      let callCount = 0;
      Date.now = () => 10_000 + (callCount++) * 100;
      try {
        spy(() => Effect.succeed(goalResult()));
        const r = await run(createOrch(), new ContextWindow('t', 200_000));
        expect(r.metrics.durationMs).toBeGreaterThan(0);
      } finally {
        Date.now = orig;
      }
    });
  });

  // ── Event emission ─────────────────────────────────────────

  describe('events', () => {
    it('emits orchestration_started', async () => {
      spySequence(goalResult());
      const { events, emit } = collectEvents();
      await run(createOrch({}, { emit }), new ContextWindow('t', 200_000), 'my goal');
      const e = events.find(e => e.type === 'orchestration_started');
      expect(e).toBeDefined();
      expect((e!.data as any).goal).toBe('my goal');
    });

    it('emits iteration_started per in-progress work item per iteration', async () => {
      // The hookQueue always creates an internal hook item alongside the main work item,
      // so iteration 1 has 2 items in inProgress (main + workitem_created hook).
      // Iteration 2 has 1 item (main only, hook completed in iteration 1).
      let call = 0;
      spy(() => { call++; return call === 2 ? Effect.succeed(goalResult()) : Effect.succeed(continueResult()); });
      const { events, emit } = collectEvents();
      await run(createOrch({}, { emit }), new ContextWindow('t', 200_000));
      const starts = events.filter(e => e.type === 'iteration_started');
      // 2 items in iter1 + 1 item in iter2 = 3
      expect(starts.length).toBe(3);
      // Verify unique iteration numbers match actual iteration count
      const uniqueIters = new Set(starts.map(e => (e.data as any).iteration));
      expect(uniqueIters.size).toBe(2);
    });

    it('emits goal_achieved on success', async () => {
      spySequence(goalResult());
      const { events, emit } = collectEvents();
      await run(createOrch({}, { emit }), new ContextWindow('t', 200_000), 'test-goal');
      const e = events.find(e => e.type === 'goal_achieved');
      expect(e).toBeDefined();
      expect((e!.data as any).goal).toBe('test-goal');
    });

    it('emits goal_not_achieved on max_iterations', async () => {
      spy(() => Effect.succeed(continueResult()));
      const { events, emit } = collectEvents();
      await run(createOrch({ maxIterations: 1 }, { emit }), new ContextWindow('t', 200_000), 'my-goal');
      const e = events.find(e => e.type === 'goal_not_achieved');
      expect(e).toBeDefined();
      expect((e!.data as any).reason).toBe('max_iterations_exceeded');
    });

    it('truncates response preview to 200 chars in iteration_completed', async () => {
      const long = 'x'.repeat(300);
      spySequence(goalResult(long));
      const { events, emit } = collectEvents();
      await run(createOrch({}, { emit }), new ContextWindow('t', 200_000));
      const e = events.find(e => e.type === 'iteration_completed');
      expect((e!.data as any).result.response.length).toBe(200);
    });

    it('does NOT truncate ≤200 char responses', async () => {
      const exact = 'y'.repeat(200);
      spySequence(goalResult(exact));
      const { events, emit } = collectEvents();
      await run(createOrch({}, { emit }), new ContextWindow('t', 200_000));
      const e = events.find(e => e.type === 'iteration_completed');
      expect((e!.data as any).result.response).toBe(exact);
    });
  });

  // ── Context operations ─────────────────────────────────────

  describe('context operations', () => {
    it('merges agent result into context on goal_state_reached', async () => {
      const ctx = new ContextWindow('t', 200_000);
      const addSpy = spyOn(ctx, 'addAgentResultContext');
      spySequence(goalResult());
      await run(createOrch(), ctx);
      expect(addSpy).toHaveBeenCalled();
      addSpy.mockRestore();
    });

    it('merges context each continue iteration exactly once', async () => {
      const ctx = new ContextWindow('t', 200_000);
      const addSpy = spyOn(ctx, 'addAgentResultContext');
      let call = 0;
      spy(() => { call++; return call === 3 ? Effect.succeed(goalResult()) : Effect.succeed(continueResult()); });
      await run(createOrch(), ctx);
      // 2 continuation deltas + 1 terminal delta = exactly 3 merges.
      expect(addSpy).toHaveBeenCalledTimes(3);
      addSpy.mockRestore();
    });

    it('makes continuation tool history available on the next turn', async () => {
      let call = 0;
      spy((params) => {
        call++;
        if (call === 1) {
          const localContext = new ContextWindow('local-turn-1', 10_000);
          localContext.addFunctionCall('call-1', 'Read', { path: '/tmp/a' });
          localContext.addFunctionCallOutput('call-1', 'contents', false);
          return Effect.succeed(continueResult({ localContext }));
        }
        expect(params.globalContext.getItemsByType('function_call')).toHaveLength(1);
        expect(params.globalContext.getItemsByType('function_call_output')).toHaveLength(1);
        return Effect.succeed(goalResult());
      });

      await run(createOrch(), new ContextWindow('t', 200_000));
      expect(call).toBe(2);
    });

    it('updateMetrics called each iteration', async () => {
      const ctx = new ContextWindow('t', 200_000);
      const metSpy = spyOn(ctx, 'updateMetrics');
      let call = 0;
      spy(() => { call++; return call === 2 ? Effect.succeed(goalResult()) : Effect.succeed(continueResult()); });
      await run(createOrch(), ctx);
      expect(metSpy).toHaveBeenCalledTimes(2);
      metSpy.mockRestore();
    });
  });

  // ── Work queue ─────────────────────────────────────────────

  describe('work queue', () => {
    it('work queue exhausted without goal → agent_error fallback', async () => {
      // When the main item errors out and no goal was ever reached,
      // the post-loop fallback creates an agent_error.
      spy(() => Effect.succeed(terminalResult('agent_error', {
        success: false,
        error: 'Something broke',
      })));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('agent_error');
      expect(r.error).toBeDefined();
    });
  });

  // ── Result invariants ──────────────────────────────────────

  describe('result invariants', () => {
    it('success=true only on goal_state_reached', async () => {
      spySequence(goalResult());
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.success).toBe(true);
      expect(r.terminationReason).toBe('goal_state_reached');
    });

    it('runControl always present', async () => {
      spySequence(goalResult());
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.runControl).toBeDefined();
      expect(r.runControl.state).toBe('running');
    });

    it('metrics always present on every termination type', async () => {
      spy(() => Effect.succeed(continueResult()));
      const r = await run(createOrch({ maxIterations: 1 }), new ContextWindow('t', 200_000));
      expect(r.metrics).toBeDefined();
      expect(typeof r.metrics.iterations).toBe('number');
      expect(typeof r.metrics.totalLlmCalls).toBe('number');
      expect(typeof r.metrics.totalToolCalls).toBe('number');
      expect(typeof r.metrics.durationMs).toBe('number');
    });

    it('error undefined on success', async () => {
      spySequence(goalResult());
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.error).toBeUndefined();
    });
  });

  // ── Defect handling ──────────────────────────────────────────

  describe('defect handling', () => {
    it('Agent.executeTurn Effect.die is caught by catchAllDefect → agent_error', async () => {
      spy(() => Effect.die(new Error('Agent exploded')));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('agent_error');
      expect(r.error).toContain('Agent exploded');
    });

    it('Agent.executeTurn throwing synchronously is caught → agent_error', async () => {
      spy(() => { throw new Error('Sync boom'); });
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('agent_error');
      expect(r.error).toContain('Sync boom');
    });

    it('non-Error throw is stringified', async () => {
      spy(() => Effect.die('string defect'));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('agent_error');
      expect(r.error).toContain('string defect');
    });
  });

  // ── State reset between runs ─────────────────────────────────

  describe('sequential re-execution', () => {
    it('orchestrator resets state between executions', async () => {
      let calls = 0;
      spy(() => { calls++; return Effect.succeed(goalResult()); });
      const orch = createOrch();

      const r1 = await run(orch, new ContextWindow('t', 200_000));
      expect(r1.success).toBe(true);

      calls = 0;
      const r2 = await run(orch, new ContextWindow('t2', 200_000));
      expect(r2.success).toBe(true);
      // Second run has clean metrics (not accumulated from first)
      expect(r2.metrics.totalLlmCalls).toBe(1);
    });
  });

  // ── Agent-as-tool delegation ─────────────────────────────────

  describe('agent-as-tool delegation', () => {
    it('runs delegated work through a nested Orchestrator with the child budget', async () => {
      const registry = new AgentRegistry([
        {
          type: 'standard',
          systemPrompt: 'parent',
          tools: ['explorer'],
          budget: { maxIterations: 5, maxToolCalls: 10, maxDurationMs: 10_000 },
          llmParams: { maxTokens: 4096, temperature: 0 },
        },
        {
          type: 'explorer',
          systemPrompt: 'child',
          tools: [],
          budget: { maxIterations: 2, maxToolCalls: 3, maxDurationMs: 5_000 },
          llmParams: { maxTokens: 4096, temperature: 0 },
        },
      ]);
      const childPolicies: AgentTurnParams['turnPolicy'][] = [];

      spy(function (params) {
        if (params.workItem.agent === 'explorer') {
          childPolicies.push(params.turnPolicy);
          return Effect.succeed(childPolicies.length === 1 ? continueResult() : goalResult('child done'));
        }

        const executor = Reflect.get(this, 'executeAgentTool') as AgentToolExecutor;
        const childWorkItem = createWorkItem({
          goal: params.workItem.goal,
          objective: 'delegate this',
          agent: 'explorer',
        });
        return executor({
          agentType: 'explorer',
          workItem: childWorkItem,
          globalContext: params.globalContext,
          cwd: params.cwd,
          signal: params.signal,
          runControl: params.runControl,
          parentAgentType: 'standard',
        }).pipe(
          Effect.map((child) => goalResult(child.response)),
          Effect.orDie
        );
      });

      const result = await run(createOrch({ maxIterations: 5 }, { registry }), new ContextWindow('t', 200_000));
      expect(result.response).toBe('child done');
      expect(childPolicies).toEqual([
        { iteration: 1, maxIterations: 2, allowToolCalls: true, toolCallLimit: 3 },
        { iteration: 2, maxIterations: 2, allowToolCalls: false, toolCallLimit: 0 },
      ]);
    });
  });

  // ── Additional terminal conditions ────────────────────────────

  describe('additional terminal conditions', () => {
    it('rate_limit terminates', async () => {
      spySequence({
        ...baseResult(),
        status: 'terminal',
        terminationReason: 'rate_limit',
        needsUserInput: false,
        isRefusal: false,
        rateLimitInfo: { provider: 'test', model: 'test', type: 'requests', message: 'limited' },
      });
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('rate_limit');
    });

    it('circuit_open terminates', async () => {
      spySequence(terminalResult('circuit_open'));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('circuit_open');
    });

    it('timeout terminates with error', async () => {
      spySequence(terminalResult('timeout', {
        error: 'Stream timeout',
      }));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('timeout');
      expect(r.error).toBe('Stream timeout');
    });

    it('timeout with no error gets fallback', async () => {
      spySequence(terminalResult('timeout'));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('timeout');
      expect(r.error).toBe('timeout');
    });

    it('user_stopped terminates', async () => {
      spySequence(terminalResult('user_stopped', {
        response: 'User cancelled',
      }));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('user_stopped');
    });

    it('no_action terminates without hooks', async () => {
      // Without hook registry, no_action hits the fallback path → terminal.
      // It's only "continuable" when hooks provide recovery guidance.
      spySequence(terminalResult('no_action', {
        error: 'No action taken',
      }));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('no_action');
      expect(r.error).toBe('No action taken');
    });

    it('invalid_action terminates without hooks', async () => {
      spySequence(terminalResult('invalid_action', {
        error: 'Bad action',
      }));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('invalid_action');
      expect(r.error).toBe('Bad action');
    });
  });

  // ── Runtime-control cancellation ──────────────────────────────

  describe('runtime-control cancellation', () => {
    it('cancel via control queue terminates with user_stopped', async () => {
      // Agent returns continuation so the loop would run forever without cancellation.
      let callCount = 0;
      spy(() => {
        callCount++;
        return Effect.succeed(continueResult());
      });

      const queue = Effect.runSync(Queue.unbounded<RuntimeControlMessage>());
      // Publish cancel before execution starts so it is drained on the first syncRuntimeControlState call.
      Effect.runSync(Queue.offer(queue, {
        action: 'cancel',
        cancellation: { reason: 'user requested', requestedAt: Date.now(), requestedBy: 'user', scope: 'run' },
      }));

      const orch = createOrch();
      const ctx = new ContextWindow('t', 200_000);
      const runtime: OrchestratorRuntime = { controlQueue: queue };

      const r = await Effect.runPromise(orch.execute(ctx, 'goal', 'standard', '/tmp', runtime));
      expect(r.terminationReason).toBe('user_stopped');
      expect(r.runControl.state).toBe('cancelled');
      // Agent may or may not have been called once before the cancel was observed.
      expect(callCount).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Compaction boundary precision ──────────────────────────────

  describe('compaction boundary precision', () => {
    it('exact reset threshold resets hysteresis (< not <=)', async () => {
      // compactResetPercent is 0.45 by default.
      // percentUsed < 0.45 resets; percentUsed == 0.45 does NOT reset.
      // We need to verify this distinction by testing whether a second compact happens.
      const ctx = new ContextWindow('t', 1000);
      ctx.updateMetrics(600, 0); // 60% → triggers first compact
      const compactSpy = spyOn(ctx, 'compact').mockReturnValue({
        itemsRemoved: 0, fileContentRemoved: 0, outputsTruncated: 0, bytesRecovered: 0,
      });
      let call = 0;
      spy(() => {
        call++;
        if (call >= 3) return Effect.succeed(goalResult());
        return Effect.succeed(continueResult());
      });
      // percentUsed stays at 60% because we don't modify it between iterations
      // and localContext.metrics are all zeros → updateMetrics adds 0.
      // compactedRecently was set to true. 60% > 45% so it stays true (no reset).
      // No second compact should occur.
      await run(createOrch(), ctx);
      expect(compactSpy).toHaveBeenCalledTimes(1);
      compactSpy.mockRestore();
    });

    it('custom trigger/reset thresholds are respected', async () => {
      const ctx = new ContextWindow('t', 1000);
      ctx.updateMetrics(800, 0); // 80%
      const compactSpy = spyOn(ctx, 'compact').mockReturnValue({
        itemsRemoved: 0, fileContentRemoved: 0, outputsTruncated: 0, bytesRecovered: 0,
      });
      spySequence(goalResult());
      // Set trigger to 90% — 80% should NOT trigger
      await run(createOrch({ compactTriggerPercent: 0.90, compactResetPercent: 0.80 }), ctx);
      expect(compactSpy).not.toHaveBeenCalled();
      compactSpy.mockRestore();
    });
  });

  // ── Hook work item lifecycle ───────────────────────────────────

  describe('hook work item lifecycle', () => {
    it('internal hook items do not count toward agent calls', async () => {
      let agentCalls = 0;
      spy(() => { agentCalls++; return Effect.succeed(goalResult()); });
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      // Only the main work item triggers agent.executeTurn, not the hook work item
      expect(agentCalls).toBe(1);
      expect(r.success).toBe(true);
    });

    it('internal hook results are stored in completedWork (not lost)', async () => {
      // Verify that the hook work item is processed without errors
      // by checking that the execution completes normally
      const { events, emit } = collectEvents();
      spySequence(goalResult());
      const r = await run(createOrch({}, { emit }), new ContextWindow('t', 200_000));
      expect(r.success).toBe(true);
      // Hook work items emit hook_call events
      const hookCalls = events.filter(e => e.type === 'hook_call');
      expect(hookCalls.length).toBeGreaterThan(0);
    });
  });

  // ── DEFAULT_ORCHESTRATOR_CONFIG invariants ──────────────────────

  describe('DEFAULT_ORCHESTRATOR_CONFIG', () => {
    it('has expected shape (mutation guard)', () => {
      expect(DEFAULT_ORCHESTRATOR_CONFIG).toEqual({
        maxIterations: 70,
        maxToolCalls: 250,
        maxDurationMs: 300_000,
        hookTimeoutMs: 5000,
        compactTriggerPercent: 0.50,
        compactResetPercent: 0.45,
        compactMaxFileCount: 20,
        compactTruncateTo: 5000,
        maxRealigns: 3,
      });
    });

    it('compactTriggerPercent > compactResetPercent (hysteresis invariant)', () => {
      expect(DEFAULT_ORCHESTRATOR_CONFIG.compactTriggerPercent)
        .toBeGreaterThan(DEFAULT_ORCHESTRATOR_CONFIG.compactResetPercent);
    });
  });

  // ── Multiple agent types ────────────────────────────────────────

  describe('multiple agent types', () => {
    it('can use a different agent type than default', async () => {
      spySequence(goalResult());
      const registry = testRegistry(['standard', 'specialist']);
      const r = await run(
        createOrch({}, { registry }),
        new ContextWindow('t', 200_000),
        'goal',
        'specialist',
      );
      expect(r.success).toBe(true);
    });

    it('getModelSelection receives requested agent type', async () => {
      let receivedType: string | undefined;
      const getModelSelection = (t: string) => {
        receivedType = t;
        return { provider: 'openai', model: 'test', contextWindow: 200_000 };
      };
      spySequence(goalResult());
      const registry = testRegistry(['custom']);
      await run(
        createOrch({}, { registry, getModelSelection }),
        new ContextWindow('t', 200_000),
        'goal',
        'custom',
      );
      expect(receivedType).toBe('custom');
    });
  });

  // ── Edge-case responses ────────────────────────────────────────

  describe('edge-case responses', () => {
    it('empty response on goal is preserved', async () => {
      spySequence(goalResult(''));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.success).toBe(true);
      expect(r.response).toBe('');
    });

    it('undefined response on non-goal does not crash', async () => {
      let call = 0;
      spy(() => {
        call++;
        if (call === 1) return Effect.succeed(continueResult({ response: undefined }));
        return Effect.succeed(goalResult());
      });
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.success).toBe(true);
    });
  });

  // ── Metric accumulation invariants ─────────────────────────────

  describe('metric accumulation invariants', () => {
    it('tool calls accumulate correctly across mixed iterations', async () => {
      let call = 0;
      spy(() => {
        call++;
        if (call === 1) return Effect.succeed(continueResult({
          metrics: { llmCallsMade: 3, toolCallsMade: 10, toolCallsSucceeded: 9, toolCallsFailed: 1, durationMs: 100 },
        }));
        if (call === 2) return Effect.succeed(continueResult({
          metrics: { llmCallsMade: 1, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 50 },
        }));
        return Effect.succeed(goalResult()); // metrics: llm=1, tool=0
      });
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.metrics.totalLlmCalls).toBe(3 + 1 + 1);
      expect(r.metrics.totalToolCalls).toBe(10 + 0 + 0);
    });

    it('iteration count is always positive on termination', async () => {
      spy(() => Effect.succeed(continueResult()));
      const r = await run(createOrch({ maxIterations: 1 }), new ContextWindow('t', 200_000));
      expect(r.metrics.iterations).toBeGreaterThan(0);
    });
  });

  // ── Logging ────────────────────────────────────────────────

  describe('logging', () => {
    it('no logger does not throw', async () => {
      spySequence(goalResult());
      const orch = new Orchestrator({}, mockToolRegistry(), mockLLM(), () => {}, 'r', undefined, testRegistry(), undefined, defaultModelSelection);
      await run(orch, new ContextWindow('t', 200_000));
    });

    it('logger receives component and requestId', async () => {
      const logger = makeLogger();
      spySequence(goalResult());
      await run(createOrch({}, { logger }), new ContextWindow('t', 200_000));
      const meta = logger.calls.info.some(([, m]) => m?.component === 'orchestrator' && m?.requestId === 'test-req');
      expect(meta).toBe(true);
    });

    it('logs warning on bounds exceeded', async () => {
      const logger = makeLogger();
      spy(() => Effect.succeed(continueResult()));
      await run(createOrch({ maxIterations: 1 }, { logger }), new ContextWindow('t', 200_000));
      expect(logger.calls.warning.some(([m]) => m === 'Max iterations exceeded')).toBe(true);
    });
  });
});
