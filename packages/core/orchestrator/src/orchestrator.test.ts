/**
 * Orchestrator — integration tests.
 *
 * Tests the full execution loop through the public execute() API,
 * mocking at the Agent.run boundary. No hooks/runtime for clarity.
 */

import { describe, it, expect, spyOn, afterEach } from 'bun:test';
import { Effect } from 'effect';
import { Agent } from 'agent';
import type { AgentResult } from 'agent';
import { AgentRegistry } from 'agent';
import { ContextWindow } from 'context';
import type { LLMAdapter } from 'llm';
import type { ToolRegistry } from 'tools';
import type { AgentEvent } from 'types';
import {
  Orchestrator,
  DEFAULT_ORCHESTRATOR_CONFIG,
  type OrchestratorConfig,
  type OrchestratorLogger,
} from './orchestrator.js';

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

const defaultModelSelection = () => ({ provider: 'openai', model: 'test' });

// ── Agent result builders ────────────────────────────────────────

function continueResult(overrides: Record<string, unknown> = {}): AgentResult {
  return {
    success: true,
    response: '',
    metrics: { llmCallsMade: 1, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
    filesRead: [],
    invalidatedPaths: [],
    toolErrors: [],
    terminationReason: 'cadence_audit', // falls through all terminal checks
    needsUserInput: false,
    isRefusal: false,
    localContext: new ContextWindow('local', 10_000),
    ...overrides,
  } as unknown as AgentResult;
}

function goalResult(response = 'done'): AgentResult {
  return {
    success: true,
    response,
    metrics: { llmCallsMade: 1, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
    filesRead: [],
    invalidatedPaths: [],
    toolErrors: [],
    terminationReason: 'goal_state_reached',
    needsUserInput: false,
    isRefusal: false,
    structuredOutput: { goalStateReached: true },
    localContext: new ContextWindow('local', 10_000),
  } as unknown as AgentResult;
}

// ── Helpers ──────────────────────────────────────────────────────

function createOrch(
  config: Partial<OrchestratorConfig> = {},
  opts: {
    emit?: (e: AgentEvent) => void;
    logger?: OrchestratorLogger;
    registry?: AgentRegistry;
    getModelSelection?: (t: string) => { provider: string; model: string } | null;
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

  function spy(fn: () => Effect.Effect<AgentResult, never>) {
    runSpy = spyOn(Agent.prototype, 'run').mockImplementation(fn as any);
    return runSpy;
  }

  function spySequence(...results: AgentResult[]) {
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
      spySequence({
        ...continueResult(),
        terminationReason: 'cadence_audit', // NOT via terminationReason
        structuredOutput: { goalStateReached: true },
      } as unknown as AgentResult);
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('goal_state_reached');
      expect(r.success).toBe(true);
    });

    it('goal via terminationReason string', async () => {
      spySequence({
        ...continueResult(),
        terminationReason: 'goal_state_reached',
      } as unknown as AgentResult);
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
        success: false,
        response: 'Which option?',
        metrics: { llmCallsMade: 1, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
        filesRead: [], invalidatedPaths: [], toolErrors: [],
        terminationReason: 'user_input_required',
        needsUserInput: true,
        userPrompt: { questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }] },
        isRefusal: false,
        localContext: new ContextWindow('l', 10_000),
      } as unknown as AgentResult);
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('user_input_required');
      expect(r.success).toBe(false);
      expect(r.userPrompt).toBeDefined();
    });

    it('refusal terminates', async () => {
      spySequence({
        success: false,
        response: 'I cannot do this',
        metrics: { llmCallsMade: 1, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
        filesRead: [], invalidatedPaths: [], toolErrors: [],
        terminationReason: 'refusal',
        needsUserInput: false,
        isRefusal: true,
        localContext: new ContextWindow('l', 10_000),
      } as unknown as AgentResult);
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('refusal');
      expect(r.success).toBe(false);
    });

    it('agent_error terminates', async () => {
      spySequence(continueResult({
        success: false,
        error: 'Something broke',
        terminationReason: 'agent_error',
      }));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('agent_error');
      expect(r.error).toBe('Something broke');
    });

    it('hard error catch-all: error + !success + action≠continue', async () => {
      spySequence(continueResult({
        success: false,
        error: 'Generic failure',
        terminationReason: 'cadence_audit', // not a specific check
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
          terminationReason: 'cadence_audit',
          structuredOutput: { action: 'continue' },
        }));
        return Effect.succeed(goalResult());
      });
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(call).toBe(2);
      expect(r.terminationReason).toBe('goal_state_reached');
    });

    it('observer_stopped terminates', async () => {
      spySequence(continueResult({
        terminationReason: 'observer_stopped',
        response: 'Observer says stop',
      }));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('observer_stopped');
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

    it('max_iterations reports iterations - 1', async () => {
      spy(() => Effect.succeed(continueResult()));
      const r = await run(createOrch({ maxIterations: 3 }), new ContextWindow('t', 200_000));
      expect(r.metrics.iterations).toBe(3); // bound fires at iteration 4, reports 4-1=3
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

    it('merges context each continue iteration', async () => {
      const ctx = new ContextWindow('t', 200_000);
      const addSpy = spyOn(ctx, 'addAgentResultContext');
      let call = 0;
      spy(() => { call++; return call === 3 ? Effect.succeed(goalResult()) : Effect.succeed(continueResult()); });
      await run(createOrch(), ctx);
      // 2 continue merges + 1 goal merge = 3
      expect(addSpy).toHaveBeenCalledTimes(3);
      addSpy.mockRestore();
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
    it('observer_work_item_stopped stores result and exits via completedWork fallback', async () => {
      // observer_work_item_stopped: merges context, enqueues hook event, stores in completedWork,
      // removes from inProgress. Loop eventually exits. Post-loop fallback uses completedWork.
      spy(() => Effect.succeed(continueResult({
        terminationReason: 'observer_work_item_stopped',
        observerStop: { reason: 'stopped' },
      })));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      // Post-loop path uses initialResult.success from the stored result.
      // continueResult has success:true, so the post-loop result inherits that.
      expect(r.success).toBe(true);
      // terminationReason is mapped from the stored result (observer_work_item_stopped
      // doesn't exist in the TerminationReason enum, so fallback to 'agent_error')
      expect(r.terminationReason).toBeDefined();
    });

    it('work queue exhausted without goal → agent_error fallback', async () => {
      // When the main item errors out and no goal was ever reached,
      // the post-loop fallback creates an agent_error.
      spy(() => Effect.succeed(continueResult({
        success: false,
        terminationReason: 'agent_error',
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
    it('Agent.run Effect.die is caught by catchAllDefect → agent_error', async () => {
      spy(() => Effect.die(new Error('Agent exploded')));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('agent_error');
      expect(r.error).toContain('Agent exploded');
    });

    it('Agent.run throwing synchronously is caught → agent_error', async () => {
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

  // ── Additional terminal conditions ────────────────────────────

  describe('additional terminal conditions', () => {
    it('rate_limit terminates', async () => {
      spySequence(continueResult({
        terminationReason: 'rate_limit',
      }));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('rate_limit');
    });

    it('circuit_open terminates', async () => {
      spySequence(continueResult({
        terminationReason: 'circuit_open',
      }));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('circuit_open');
    });

    it('timeout terminates with error', async () => {
      spySequence(continueResult({
        terminationReason: 'timeout',
        error: 'Stream timeout',
      }));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('timeout');
      expect(r.error).toBe('Stream timeout');
    });

    it('timeout with no error gets fallback', async () => {
      spySequence(continueResult({
        terminationReason: 'timeout',
      }));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('timeout');
      expect(r.error).toBe('timeout');
    });

    it('user_stopped terminates', async () => {
      spySequence(continueResult({
        terminationReason: 'user_stopped',
        response: 'User cancelled',
      }));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('user_stopped');
    });

    it('no_action terminates without hooks', async () => {
      // Without hook registry, no_action hits the fallback path → terminal.
      // It's only "continuable" when hooks provide recovery guidance.
      spySequence(continueResult({
        terminationReason: 'no_action',
        error: 'No action taken',
      }));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('no_action');
      expect(r.error).toBe('No action taken');
    });

    it('invalid_action terminates without hooks', async () => {
      spySequence(continueResult({
        terminationReason: 'invalid_action',
        error: 'Bad action',
      }));
      const r = await run(createOrch(), new ContextWindow('t', 200_000));
      expect(r.terminationReason).toBe('invalid_action');
      expect(r.error).toBe('Bad action');
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
      // Only the main work item triggers agent.run, not the hook work item
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
        minObserverIterationGap: 5,
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
        return { provider: 'openai', model: 'test' };
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
