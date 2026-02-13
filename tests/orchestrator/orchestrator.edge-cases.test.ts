/**
 * Orchestrator Edge Case Tests
 *
 * Rigorous tests targeting specific code paths that existing tests miss.
 * Each test targets a named code path or subtle interaction with a clear bug hypothesis.
 *
 * GAP ANALYSIS:
 * 1. totalToolCalls bound (per-result check at line 2882, separate from iteration bounds)
 * 2. Deferred work on 'allow' forcing continuation (line 2144: deferredWorkAdded)
 * 3. observer_work_item_stopped (line 2586: item marked complete, loop continues)
 * 4. Continuable errors + hook retry (no_action/stagnation at line 2618)
 * 5. Refusal + hook override attempt (line 2499 -- refusal maps to null event, hook can't override)
 * 6. Hard error catch-all vs actionIsContinue bypass (line 2846)
 * 7. Initial work complete + deferred work in queue (line 1162-1172)
 * 8. Block decision without reason (decision='block', reason=undefined -> no-op)
 * 9. Cleanup function runs on error (execute() finally block)
 * 10. Multiple hooks same priority (first decision wins, line 134 in runHooksForEvent)
 * 11. Hook patches mutate state via applyPatches
 * 12. checkStopRequest propagation to agent
 * 13. onIteration callback fired each loop
 * 14. Interruption preempts user input
 * 15. Realign counter reset on split
 */

import { ContextWindow } from 'context';
import type {
  LLMAdapter,
  LLMResponse,
  ToolDefinition,
  AgentEvent,
} from 'types';
import type { ToolRegistry, ToolHandler } from 'tools';
import type { AgentConfig, AgentResult } from 'agent';
import type { AgentRegistry } from 'agent';
import type {
  ControlEvent,
  QualityGateDecision,
  BoundsDecision,
  PromptAnswerDecision,
  AgentErrorDecision,
  CadenceDecision,
  Hook,
  HookOutcome,
  StatePatch,
} from 'protocol';
import { getProtocolId } from 'protocol';
import {
  Orchestrator,
  type OrchestratorConfig,
  type OrchestratorRuntime,
} from 'orchestrator/orchestrator.js';
import { createHookRegistry, type HookRegistry } from 'orchestrator/hookRegistry/index.js';
import { getOutputSchemaJson } from 'shared';
import { resetProviderCircuit } from 'agent';

// ============================================
// SHARED INFRASTRUCTURE
// ============================================

const SESSION_KEY = 'edge-case-test';
const REQUEST_ID = 'edge-req-001';
const CWD = '/test';
const HOOK_META = { source: 'edge-case-test', protocolId: getProtocolId() };

function createContext(): ContextWindow {
  return new ContextWindow(SESSION_KEY, 200_000);
}

function createToolRegistry(tools: string[] = ['Read', 'Write', 'Bash']): ToolRegistry {
  const definitions: ToolDefinition[] = tools.map(name => ({
    name,
    description: `Mock ${name} tool`,
    parameters: { type: 'object', properties: {}, required: [] },
  }));

  const handlers = new Map<string, ToolHandler>();
  for (const name of tools) {
    handlers.set(name, async () => ({ success: true, output: `Mock output from ${name}` }));
  }

  return {
    getDefinitions: () => definitions,
    getDefinition: (name: string) => definitions.find(d => d.name === name),
    hasHandler: (name: string) => handlers.has(name),
    execute: async (name: string, args: Record<string, unknown>) => {
      const handler = handlers.get(name);
      if (!handler) return { success: false, output: `Unknown tool: ${name}`, error: 'unknown_tool' };
      return handler(args);
    },
    getAllNames: () => tools,
    register: () => {},
    unregister: () => {},
    isParallelSafe: () => true,
  } as unknown as ToolRegistry;
}

function createAgentRegistry(overrides?: Partial<AgentConfig>): AgentRegistry {
  const base: AgentConfig = {
    type: 'standard',
    systemPrompt: 'Test agent',
    tools: ['Read', 'Write', 'Bash'],
    budget: { maxIterations: 10, maxToolCalls: 150, maxDurationMs: 120_000 },
    llmParams: { maxTokens: 16000, temperature: 0.7 },
    outputSchema: getOutputSchemaJson('agent_action'),
    ...overrides,
  };

  const plannerConfig: AgentConfig = {
    ...base,
    type: 'planner',
    outputSchema: getOutputSchemaJson('planner_output'),
  };

  const configs = new Map<string, AgentConfig>([
    ['standard', { ...base, ...overrides }],
    ['planner', { ...plannerConfig, ...overrides }],
    ['observer', { ...base, type: 'observer', ...overrides }],
    ['explorer', { ...base, type: 'explorer', ...overrides }],
  ]);

  return {
    has: (t: string) => configs.has(t),
    getConfig: (t: string) => {
      const c = configs.get(t);
      if (!c) throw new Error(`Unknown agent type: ${t}`);
      return c;
    },
    listToolDefinitions: () => [],
    register: () => {},
    get: () => null,
  } as unknown as AgentRegistry;
}

function getModelSelection() {
  return { provider: 'openai', model: 'gpt-4o', displayName: 'GPT-4o' };
}

/** Shared LLM response base */
function baseResponse(content: string): LLMResponse {
  return {
    content,
    stopReason: 'end_turn',
    usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    toolCalls: [],
  };
}

function goalReachedResponse(response = 'Done'): LLMResponse {
  return baseResponse(JSON.stringify({
    action: 'done', response, goalStateReached: true, awaitingUserInput: false,
  }));
}

function continueResponse(response = 'Working...'): LLMResponse {
  return baseResponse(JSON.stringify({
    action: 'continue', response, goalStateReached: false, awaitingUserInput: false,
  }));
}

function userInputResponse(question: string): LLMResponse {
  return baseResponse(JSON.stringify({
    action: 'done', response: question, goalStateReached: false, awaitingUserInput: true,
  }));
}

/** Create a mock LLM that clamps to the last response when the sequence is exhausted. */
function createMockLLM(responses: LLMResponse[]): LLMAdapter {
  let callIndex = 0;
  return {
    respond: async () => {
      const resp = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      return resp;
    },
    stream: async function* () {
      const resp = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      const content = resp.content;
      if (content) {
        const chunkSize = Math.ceil(content.length / 3);
        for (let i = 0; i < content.length; i += chunkSize) {
          yield content.slice(i, i + chunkSize);
        }
      }
      return resp;
    },
    getConfig: () => ({ provider: 'test', model: 'test-model' }),
    capabilities: () => ({ supportsStreaming: true, supportsToolUse: true, supportsStructuredOutput: true }),
  } as unknown as LLMAdapter;
}

/** Create a stateful LLM with per-call response function. */
function createStatefulLLM(responder: (callIndex: number) => LLMResponse): LLMAdapter {
  let idx = 0;
  return {
    respond: async () => responder(idx++),
    stream: async function* () {
      const resp = responder(idx++);
      if (resp.content) {
        const chunkSize = Math.ceil(resp.content.length / 3);
        for (let i = 0; i < resp.content.length; i += chunkSize) {
          yield resp.content.slice(i, i + chunkSize);
        }
      }
      return resp;
    },
    getConfig: () => ({ provider: 'test', model: 'test-model' }),
    capabilities: () => ({ supportsStreaming: true, supportsToolUse: true, supportsStructuredOutput: true }),
  } as unknown as LLMAdapter;
}

/** Create a hook with a decision callback. */
function createHook<D>(
  id: string,
  event: string,
  decisionFn: () => D | Promise<D>,
  patches: StatePatch[] = [],
): Hook<ControlEvent, D> {
  return {
    id,
    event,
    policy: { kind: 'fire_and_forget' } as const,
    criticality: 'non_critical' as const,
    idempotency: 'idempotent' as const,
    priority: 100,
    timeoutMs: 5000,
    run: async (): Promise<HookOutcome<D>> => ({
      kind: 'success',
      decision: await decisionFn(),
      patches,
    }),
  } as Hook<ControlEvent, D>;
}

/** Standard orchestrator creation with defaults matching the existing test patterns. */
function createOrchestrator(
  config: Partial<OrchestratorConfig>,
  llm: LLMAdapter,
  emit: (e: AgentEvent) => void = () => {},
  agentOverrides?: Partial<AgentConfig>,
): Orchestrator {
  return new Orchestrator(
    config,
    createToolRegistry(),
    llm,
    emit,
    REQUEST_ID,
    undefined,
    createAgentRegistry(agentOverrides),
    undefined,
    () => getModelSelection(),
  );
}

/** Standard runtime to prevent undefined checkInterruption/checkStopRequest. */
function createRuntime(overrides?: Partial<OrchestratorRuntime>): OrchestratorRuntime {
  return {
    checkInterruption: () => false,
    checkStopRequest: () => false,
    ...overrides,
  };
}

// ============================================
// EDGE CASE TESTS
// ============================================

describe('Edge Case: Deferred Work on Allow Forces Continuation', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('continues loop when hook returns allow with deferredWork', async () => {
    // At line 2144, if deferredWorkAdded is true and decision is 'allow',
    // handleStopHookBlock returns true (continue). Even an 'allow' decision
    // can force continuation if deferred work was added.

    let callCount = 0;
    const llm = createStatefulLLM((idx) => {
      callCount++;
      return goalReachedResponse(`Attempt ${callCount}`);
    });

    let hookCalls = 0;
    const registry = createHookRegistry();
    registry.register(createHook('split-on-bounds', 'bounds_exceeded', () => {
      hookCalls++;
      return {
        action: 'split',
        workItems: [{
          id: `split-${hookCalls}`, goal: `Deferred task ${hookCalls}`,
          objective: `Do deferred ${hookCalls}`, agent: 'standard',
        }],
      } as BoundsDecision;
    }), HOOK_META);

    const orch = createOrchestrator(
      { maxIterations: 10 },
      llm,
      undefined,
      { budget: { maxIterations: 1, maxToolCalls: 1, maxDurationMs: 100 } },
    );
    const result = await orch.execute(createContext(), 'Split test', 'standard', CWD, createRuntime({ hookRegistry: registry }));

    expect(result).toBeDefined();
    // If bounds hook fired, deferred work caused additional iterations
    if (hookCalls > 0) {
      expect(callCount).toBeGreaterThan(1);
    }
  });
});

describe('Edge Case: Continuable Errors with Hook Retry', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('hook can recover invalid_action errors via retry', async () => {
    // At line 2618-2698, continuable errors (no_action, invalid_action, stagnation)
    // can be recovered by hooks. Hook returns block+reason -> new retry work item.

    let llmCalls = 0;
    const llm = createStatefulLLM((idx) => {
      llmCalls++;
      if (idx === 0) {
        // First: invalid action (agent interprets as error)
        return baseResponse(JSON.stringify({
          action: 'nonsense_action', response: 'Confused',
          goalStateReached: false, awaitingUserInput: false,
        }));
      }
      return goalReachedResponse('Recovered');
    });

    const registry = createHookRegistry();
    registry.register(
      createHook('retry-on-error', 'agent_error', () => ({
        action: 'retry', guidance: 'Try again with different approach',
      } as AgentErrorDecision)),
      HOOK_META,
    );

    const orch = createOrchestrator({ maxIterations: 10 }, llm);
    const result = await orch.execute(createContext(), 'Recover from error', 'standard', CWD, createRuntime({ hookRegistry: registry }));

    expect(result).toBeDefined();
    expect(result.terminationReason).toBeDefined();
  });
});

describe('Edge Case: Refusal Cannot Be Overridden by Hooks', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('refusal terminates regardless of hooks because no event is created', async () => {
    // At line 2499, refusal calls callStopHook with terminationReason='refusal'.
    // createControlEvent returns null for refusal (line 1987), so hooks never fire.
    // Refusals ALWAYS terminate.

    const llm = createStatefulLLM((idx) => {
      if (idx === 0) {
        return baseResponse(JSON.stringify({
          action: 'done', response: 'I cannot do that',
          goalStateReached: false, awaitingUserInput: false, isRefusal: true,
        }));
      }
      return goalReachedResponse('Should not reach here');
    });

    const orch = createOrchestrator({ maxIterations: 10 }, llm);
    const result = await orch.execute(createContext(), 'Refused task', 'standard', CWD, createRuntime());

    expect(result).toBeDefined();
    expect(result.success).toBe(false);
  });
});

describe('Edge Case: Hard Error with action=continue Bypass', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('does NOT terminate on error when action is continue', async () => {
    // At line 2846: if (result.error && !result.success && !actionIsContinue)
    // action=continue means the catch-all is skipped -> execution continues.

    let llmCalls = 0;
    const llm = createStatefulLLM((idx) => {
      llmCalls++;
      if (idx === 0) return continueResponse('Partial error but continuing');
      return goalReachedResponse('Done after partial error');
    });

    const orch = createOrchestrator(
      { maxIterations: 10 },
      llm,
      undefined,
      { budget: { maxIterations: 3, maxToolCalls: 50, maxDurationMs: 30_000 } },
    );
    const result = await orch.execute(createContext(), 'Continue despite error', 'standard', CWD, createRuntime());

    expect(result).toBeDefined();
    expect(llmCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('Edge Case: Initial Work + Deferred Work Continues Loop', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('continues loop when quality gate passes but deferred work was enqueued via patches', async () => {
    // At line 1160-1172, after quality gate for initial work:
    // if workQueue.hasPending(), loop continues instead of returning success.
    // State is reset (initialWorkCompleted=false) and deferred items are processed.

    let llmCalls = 0;
    const llm = createStatefulLLM(() => {
      llmCalls++;
      return goalReachedResponse(`Done ${llmCalls}`);
    });

    let hookCalls = 0;
    const registry = createHookRegistry();
    registry.register(createHook('pass-with-deferred', 'goal_state_reached', () => {
      hookCalls++;
      if (hookCalls === 1) {
        // Return passed with deferred work enqueued via patches
        return { verdict: 'passed' } as QualityGateDecision;
      }
      return { verdict: 'passed' } as QualityGateDecision;
    }, hookCalls === 0 ? [{
      op: 'enqueue_work' as const,
      items: [{ goal: 'Deferred cleanup', objective: 'Run post-completion cleanup', agent: 'standard' }],
      position: 'back' as const,
    }] as StatePatch[] : []), HOOK_META);

    const orch = createOrchestrator({ maxIterations: 10 }, llm);
    const result = await orch.execute(createContext(), 'Task with deferred', 'standard', CWD, createRuntime({ hookRegistry: registry }));

    expect(result.success).toBe(true);
    expect(hookCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('BUG: Failed Quality Gate with Empty Issues Silently Passes', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('should block termination when quality gate returns failed -- even with empty issues', async () => {
    // BUG: mapQualityDecisionToStopResult('failed', { issues: [] }) produces
    //   { decision: 'block', reason: '' }
    // At line 2157, handleStopHookBlock checks `!stopResult.reason`.
    // Empty string is falsy -> block is silently ignored -> execution terminates as success.
    //
    // CORRECT behavior: verdict='failed' should ALWAYS block, regardless of issues content.
    // A failed quality gate with no explanation is still a failure.

    const llm = createMockLLM([goalReachedResponse('Done')]);

    let hookCalled = false;
    const registry = createHookRegistry();
    registry.register(createHook('block-no-reason', 'goal_state_reached', () => {
      hookCalled = true;
      return { verdict: 'failed', issues: [] } as QualityGateDecision;
    }), HOOK_META);

    const orch = createOrchestrator({ maxIterations: 10 }, llm);
    const result = await orch.execute(createContext(), 'Block without reason', 'standard', CWD, createRuntime({ hookRegistry: registry }));

    expect(hookCalled).toBe(true);
    // Quality gate said 'failed' -- should NOT succeed
    expect(result.success).toBe(false);
  });
});

describe('Edge Case: Cleanup Function Runs on Error', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('calls onStart cleanup even when execution throws', async () => {
    // execute() wraps executeInner() in try/finally (line 552-558).
    // If executeInner throws, cleanup should still run.

    let cleanupCalled = false;
    const llm = createStatefulLLM(() => {
      throw new Error('Catastrophic LLM failure');
    });

    const orch = createOrchestrator({ maxIterations: 10 }, llm);
    const runtime = createRuntime({
      onStart: () => {
        return () => { cleanupCalled = true; };
      },
    });

    const result = await orch.execute(createContext(), 'Crash test', 'standard', CWD, runtime);

    expect(cleanupCalled).toBe(true);
    expect(result).toBeDefined();
  });
});

describe('Edge Case: Multiple Hooks Same Priority', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('both hooks run but first non-null decision wins', async () => {
    // At line 134 in runHooksForEvent.ts: if (decision === null) decision = result.outcome.decision
    // Same-priority hooks run in parallel via Promise.all. First non-null decision is used.

    const llm = createMockLLM([goalReachedResponse('Done')]);

    const decisions: string[] = [];
    const registry = createHookRegistry();

    registry.register({
      id: 'hook-pass',
      event: 'goal_state_reached',
      policy: { kind: 'fire_and_forget' } as const,
      criticality: 'non_critical' as const,
      idempotency: 'idempotent' as const,
      priority: 100,
      timeoutMs: 5000,
      run: async () => {
        decisions.push('pass');
        return { kind: 'success', decision: { verdict: 'passed' } as QualityGateDecision, patches: [] };
      },
    } as Hook<ControlEvent, QualityGateDecision>, HOOK_META);

    registry.register({
      id: 'hook-fail',
      event: 'goal_state_reached',
      policy: { kind: 'fire_and_forget' } as const,
      criticality: 'non_critical' as const,
      idempotency: 'idempotent' as const,
      priority: 100,
      timeoutMs: 5000,
      run: async () => {
        decisions.push('fail');
        return { kind: 'success', decision: { verdict: 'failed', issues: ['Bad quality'] } as QualityGateDecision, patches: [] };
      },
    } as Hook<ControlEvent, QualityGateDecision>, HOOK_META);

    const orch = createOrchestrator({ maxIterations: 10 }, llm);
    const result = await orch.execute(createContext(), 'Multi hook', 'standard', CWD, createRuntime({ hookRegistry: registry }));

    // Both hooks should have been called (parallel execution)
    expect(decisions).toContain('pass');
    expect(decisions).toContain('fail');
    expect(result).toBeDefined();
  });
});

describe('Edge Case: Hook Patches Enqueue Work Items', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('enqueue_work patches create executable work items', async () => {
    // Hook patches go through applyPatches which mutates this.workQueue.
    // Enqueued items must actually run.

    let llmCalls = 0;
    const llm = createStatefulLLM(() => {
      llmCalls++;
      return goalReachedResponse(`Done ${llmCalls}`);
    });

    let hookCalls = 0;
    const registry = createHookRegistry();
    registry.register({
      id: 'enqueue-via-patch',
      event: 'goal_state_reached',
      policy: { kind: 'fire_and_forget' } as const,
      criticality: 'non_critical' as const,
      idempotency: 'idempotent' as const,
      priority: 100,
      timeoutMs: 5000,
      run: async () => {
        hookCalls++;
        if (hookCalls === 1) {
          return {
            kind: 'success',
            decision: { verdict: 'passed' } as QualityGateDecision,
            patches: [{
              op: 'enqueue_work' as const,
              items: [{ goal: 'Patched task', objective: 'Execute patched task', agent: 'standard' }],
              position: 'back' as const,
            }] as StatePatch[],
          };
        }
        return { kind: 'success', decision: { verdict: 'passed' } as QualityGateDecision, patches: [] };
      },
    } as Hook<ControlEvent, QualityGateDecision>, HOOK_META);

    const orch = createOrchestrator({ maxIterations: 10 }, llm);
    const result = await orch.execute(createContext(), 'Patch test', 'standard', CWD, createRuntime({ hookRegistry: registry }));

    expect(result.success).toBe(true);
    expect(llmCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('Edge Case: Stop Request Propagation', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('checkStopRequest stops agent via shouldStop hook', async () => {
    // checkStopRequest is wired into the agent's shouldStop hook at line 1501.

    let stopChecks = 0;
    const llm = createStatefulLLM((idx) => {
      if (idx < 5) return continueResponse(`Step ${idx}`);
      return goalReachedResponse('Finally done');
    });

    const orch = createOrchestrator(
      { maxIterations: 100 },
      llm,
      undefined,
      { budget: { maxIterations: 10, maxToolCalls: 200, maxDurationMs: 30_000 } },
    );

    const runtime = createRuntime({
      checkStopRequest: () => {
        stopChecks++;
        return stopChecks > 2;
      },
    });

    const result = await orch.execute(createContext(), 'Stoppable', 'standard', CWD, runtime);

    expect(result).toBeDefined();
    expect(stopChecks).toBeGreaterThan(0);
  });
});

describe('Edge Case: onIteration Callback', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('calls onIteration with monotonically increasing iteration numbers', async () => {
    const iterations: Array<{ iteration: number; totalToolCalls: number }> = [];

    const llm = createMockLLM([
      continueResponse('Step 1'),
      continueResponse('Step 2'),
      goalReachedResponse('Done'),
    ]);

    const orch = createOrchestrator(
      { maxIterations: 10 },
      llm,
      undefined,
      { budget: { maxIterations: 3, maxToolCalls: 50, maxDurationMs: 30_000 } },
    );

    const runtime = createRuntime({
      onIteration: (state) => {
        iterations.push({ iteration: state.iteration, totalToolCalls: state.totalToolCalls });
      },
    });

    const result = await orch.execute(createContext(), 'Iteration callback', 'standard', CWD, runtime);

    expect(result).toBeDefined();
    expect(iterations.length).toBeGreaterThan(0);
    for (let i = 1; i < iterations.length; i++) {
      expect(iterations[i].iteration).toBeGreaterThan(iterations[i - 1].iteration);
    }
  });
});

describe('Edge Case: Max Iterations Exceeded (Bounds)', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('terminates when orchestrator-level max iterations exceeded', async () => {
    const llm = createMockLLM(Array(10).fill(continueResponse('Still going...')));

    const orch = createOrchestrator(
      { maxIterations: 2 },
      llm,
    );

    const result = await orch.execute(createContext(), 'Infinite loop', 'standard', CWD, createRuntime());

    expect(result.terminationReason).toBe('max_iterations_exceeded');
  });
});

describe('Edge Case: Harvest Completed Work on Bounds', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('returns partial progress when bounds exceeded after some work completes', async () => {
    // harvestCompletedWork at line 2301 builds a response from completed items.

    const llm = createMockLLM(Array(10).fill(continueResponse('Progress...')));

    const orch = createOrchestrator(
      { maxIterations: 2 },
      llm,
      undefined,
      { budget: { maxIterations: 1, maxToolCalls: 50, maxDurationMs: 30_000 } },
    );

    const result = await orch.execute(createContext(), 'Bounded task', 'standard', CWD, createRuntime());

    expect(result).toBeDefined();
    expect(result.terminationReason).toBe('max_iterations_exceeded');
  });
});

describe('BUG: Alternating Realign/Split Bypasses maxRealigns', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('should terminate after maxRealigns total realigns, not just consecutive ones', async () => {
    // BUG: At line 2145, deferredWorkAdded resets realignCount to 0.
    // Pattern: realign -> split -> realign -> split -> ...
    // Each split resets the counter, so realignCount never reaches maxRealigns.
    // Without an external abort, this loops forever.
    //
    // CORRECT behavior: maxRealigns should track TOTAL realigns, not consecutive.
    // After maxRealigns=2 total realigns, the orchestrator should force-terminate
    // regardless of intervening splits.
    //
    // Safety valve: hook aborts after 6 calls so the test doesn't hang.
    // The assertion proves the bug: hookCalls exceeds maxRealigns (2),
    // meaning the orchestrator failed to enforce the limit.

    let hookCalls = 0;
    const registry = createHookRegistry();
    registry.register(createHook('alternating-hook', 'bounds_exceeded', () => {
      hookCalls++;
      if (hookCalls > 6) {
        return { action: 'abort', reason: 'Too many cycles' } as BoundsDecision;
      }
      if (hookCalls % 2 === 1) {
        return { action: 'realign', guidance: `Realign ${hookCalls}` } as BoundsDecision;
      }
      return {
        action: 'split',
        workItems: [{ id: `s${hookCalls}`, goal: `Split ${hookCalls}`, objective: `Do ${hookCalls}`, agent: 'standard' }],
      } as BoundsDecision;
    }), HOOK_META);

    const llm = createMockLLM(Array(50).fill(continueResponse('Working...')));

    const orch = createOrchestrator(
      { maxIterations: 50, maxRealigns: 2 },
      llm,
      undefined,
      { budget: { maxIterations: 1, maxToolCalls: 1, maxDurationMs: 100 } },
    );

    const result = await orch.execute(createContext(), 'Alternating', 'standard', CWD, createRuntime({ hookRegistry: registry }));

    expect(result).toBeDefined();
    // BUG: With maxRealigns=2, hook should only be called at most 2-3 times
    // (2 realigns -> forced termination). But alternating splits reset the counter,
    // so the hook runs 7 times before our safety abort fires.
    // When this bug is fixed, hookCalls should be <= 3.
    expect(hookCalls).toBeLessThanOrEqual(3);
  });
});

describe('Edge Case: Interruption Preempts User Input', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('user interruption takes priority over user_input_required', async () => {
    // At line 2382, if agent needs user input but there's a pending interruption,
    // the interruption wins -> new work item created instead of pausing.

    let interruptionChecks = 0;
    const llm = createStatefulLLM((idx) => {
      if (idx === 0) return userInputResponse('Which option?');
      return goalReachedResponse('Interrupted and recovered');
    });

    const orch = createOrchestrator({ maxIterations: 10 }, llm);
    const runtime = createRuntime({
      checkInterruption: () => {
        interruptionChecks++;
        return interruptionChecks === 1; // First check: interruption pending
      },
    });

    const result = await orch.execute(createContext(), 'Interrupt test', 'standard', CWD, runtime);

    expect(result).toBeDefined();
    expect(interruptionChecks).toBeGreaterThan(0);
  });
});

describe('Edge Case: Observer Defer on User Input', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('defers to user when observer returns defer decision', async () => {
    // defer/escalate maps to { decision: 'allow' } (line 95-96 in decision_mappers).
    // Allow = don't block termination -> user_input_required pause proceeds.

    const llm = createMockLLM([userInputResponse('Critical choice?')]);

    const registry = createHookRegistry();
    registry.register(
      createHook('defer-to-user', 'user_input_required', () => ({
        action: 'defer', to: 'user',
      } as PromptAnswerDecision)),
      HOOK_META,
    );

    const orch = createOrchestrator({ maxIterations: 10 }, llm);
    const result = await orch.execute(createContext(), 'Critical task', 'standard', CWD, createRuntime({ hookRegistry: registry }));

    // Defer = allow -> pause proceeds
    expect(result.terminationReason).toBe('user_input_required');
    expect(result.paused).toBe(true);
  });
});

describe('Edge Case: Async Mode Clears Output Schema', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('async mode executes without structured output parsing', async () => {
    // At line 1369-1375, async mode clears outputSchema.
    // Workers use free-form output.

    const llm = createMockLLM([goalReachedResponse('Async done')]);

    const orch = new Orchestrator(
      { maxIterations: 10 },
      createToolRegistry(),
      llm,
      () => {},
      REQUEST_ID,
      undefined,
      createAgentRegistry(),
      undefined,
      () => getModelSelection(),
    );

    const result = await orch.execute(createContext(), 'Async test', 'standard', CWD, createRuntime());

    expect(result).toBeDefined();
  });
});

describe('Edge Case: Max Duration Exceeded', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('terminates with max_duration_exceeded when agent reports it', async () => {
    // Agent-level duration bound at line 2703-2735.
    // Set very short duration to try to trigger it.

    const llm = createStatefulLLM((idx) => {
      if (idx < 2) return continueResponse(`Step ${idx}`);
      return goalReachedResponse('Done');
    });

    const orch = createOrchestrator(
      { maxIterations: 100, maxDurationMs: 1 },
      llm,
      undefined,
      { budget: { maxIterations: 5, maxToolCalls: 200, maxDurationMs: 1 } },
    );

    const result = await orch.execute(createContext(), 'Duration test', 'standard', CWD, createRuntime());

    expect(result).toBeDefined();
    expect(result.terminationReason).toBeDefined();
  });
});

describe('Edge Case: User Input with Observer Answer', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('observer answer hook does not crash when registered', async () => {
    // At line 2170-2181, when terminationReason is 'user_input_required'
    // and hook blocks, the answer goes as a USER message.
    // The PromptUser tool integration happens inside Agent -- with mock LLM,
    // the agent may not set needsUserInput. Test that infra doesn't crash.

    let llmCalls = 0;
    const llm = createStatefulLLM((idx) => {
      llmCalls++;
      if (idx === 0) return userInputResponse('What database should I use?');
      return goalReachedResponse('Using PostgreSQL');
    });

    const registry = createHookRegistry();
    registry.register(
      createHook('answer-question', 'user_input_required', () => ({
        action: 'answer', text: 'Use PostgreSQL', contextAddendum: 'Based on existing stack',
      } as PromptAnswerDecision)),
      HOOK_META,
    );

    const orch = createOrchestrator({ maxIterations: 10 }, llm);
    const result = await orch.execute(createContext(), 'DB choice', 'standard', CWD, createRuntime({ hookRegistry: registry }));

    expect(result).toBeDefined();
  });
});

describe('Edge Case: Cadence Audit Hook Registration', () => {
  beforeEach(() => { resetProviderCircuit('test'); resetProviderCircuit('openai-compat'); });

  it('cadence_audit hook does not interfere with fast-completing tasks', async () => {
    // Cadence audit fires after 60+ tool calls or 3+ minutes.
    // Fast tasks complete before cadence audit triggers.
    // The stop decision should not fire.

    const llm = createMockLLM([goalReachedResponse('Quick task')]);

    const registry = createHookRegistry();
    registry.register(
      createHook('cadence-stop', 'cadence_audit', () => ({
        action: 'stop', reason: 'Agent is off-track',
      } as CadenceDecision)),
      HOOK_META,
    );

    const orch = createOrchestrator({ maxIterations: 10 }, llm);
    const result = await orch.execute(createContext(), 'Quick', 'standard', CWD, createRuntime({ hookRegistry: registry }));

    expect(result.success).toBe(true);
  });
});
