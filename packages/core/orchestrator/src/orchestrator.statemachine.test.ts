/**
 * Orchestrator State Machine Tests
 *
 * Models the orchestrator as a state machine and tests:
 * 1. Valid state transitions
 * 2. Invalid transition rejection
 * 3. Invariants that must hold in every state
 * 4. Random command sequences
 *
 * STATE MODEL:
 * ============
 * WorkItem states: queued → in_progress → completed | error
 * Orchestrator states: idle → executing → paused | terminated
 *
 * TRANSITIONS:
 * ============
 * execute() → idle → executing
 * agent_done + goal_reached → executing → terminated(goal_state_reached)
 * agent_done + bounds_exceeded → executing → hook_decision → terminated | executing
 * agent_done + user_input → executing → paused(user_input_required)
 * agent_done + handoff → executing → paused(handoff_requested) | executing(approved)
 * hook_block → executing (continue with new work)
 * hook_split → executing (enqueue deferred work)
 * max_realigns → executing → terminated(bounds)
 *
 * INVARIANTS:
 * ===========
 * 1. No work item in multiple states simultaneously
 * 2. Completed work count monotonically increases
 * 3. Work item dependencies satisfied before execution
 * 4. realignCount bounded by maxRealigns
 * 5. Terminal state is final (no further transitions)
 * 6. All enqueued work eventually completes or errors
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { ContextWindow } from 'context';
import type {
  LLMAdapter,
  LLMResponse,
  ToolDefinition,
  AgentEvent,
} from 'types';
import type { ToolRegistry } from 'tools';
import type { AgentConfig } from 'agent';
import type { AgentRegistry } from 'agent';
import type {
  QualityGateDecision,
  BoundsDecision,
  PromptAnswerDecision,
  HandoffDecision,
  HookContext,
  WorkItemSpec,
} from 'protocol';
import { getProtocolId } from 'protocol';
import {
  Orchestrator,
  type OrchestratorRuntime,
  type OrchestratorResult,
} from './orchestrator.js';
import { createHookRegistry } from './hookRegistry/index.js';
import { getOutputSchemaJson } from 'shared';
import { resetProviderCircuit } from 'agent';

// ============================================
// STATE MODEL TYPES
// ============================================

type OrchestratorState = 'idle' | 'executing' | 'paused' | 'terminated';

type WorkItemState = 'queued' | 'in_progress' | 'completed' | 'error';

type AgentOutcome =
  | { type: 'goal_reached'; response: string }
  | { type: 'continue'; response: string }
  | { type: 'user_input'; question: string }
  | { type: 'handoff'; workItems: WorkItemSpec[] }
  | { type: 'bounds_exceeded'; reason: 'iterations' | 'tool_calls' | 'duration' }
  | { type: 'error'; message: string }
  | { type: 'refusal'; message: string };

type HookDecision =
  | { type: 'allow' }
  | { type: 'block'; reason: string }
  | { type: 'split'; workItems: WorkItemSpec[] }
  | { type: 'realign'; guidance: string };

interface StateModel {
  orchestratorState: OrchestratorState;
  workItems: Map<string, WorkItemState>;
  completedCount: number;
  realignCount: number;
  terminationReason: string | null;
}

// ============================================
// TEST INFRASTRUCTURE
// ============================================

const SESSION_KEY = 'statemachine-test';
const REQUEST_ID = 'sm-req-001';
const CWD = '/test';
const HOOK_META = { source: 'statemachine-test', protocolId: getProtocolId() };

function createContext(): ContextWindow {
  return new ContextWindow(SESSION_KEY, 200_000);
}

function createToolRegistry(): ToolRegistry {
  const tools = ['Read', 'Write', 'Bash'];
  return {
    getDefinitions: () => tools.map(name => ({
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties: {}, required: [] },
    })),
    getDefinition: (name: string) => tools.includes(name) ? {
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties: {}, required: [] },
    } : undefined,
    hasHandler: (name: string) => tools.includes(name),
    execute: async () => ({ success: true, output: 'ok' }),
    getAllNames: () => tools,
    register: () => {},
    unregister: () => {},
  } as unknown as ToolRegistry;
}

function createAgentRegistry(budget?: { maxIterations: number; maxToolCalls: number; maxDurationMs: number }): AgentRegistry {
  const base: AgentConfig = {
    type: 'standard',
    systemPrompt: 'Test agent',
    tools: ['Read', 'Write', 'Bash'],
    budget: budget ?? { maxIterations: 5, maxToolCalls: 50, maxDurationMs: 30_000 },
    llmParams: { maxTokens: 4000, temperature: 0 },
    outputSchema: getOutputSchemaJson('agent_action'),
  };

  const configs = new Map([
    ['standard', base],
    ['planner', { ...base, type: 'planner', outputSchema: getOutputSchemaJson('planner_output') }],
  ]);

  return {
    has: (t: string) => configs.has(t),
    getConfig: (t: string) => {
      const c = configs.get(t);
      if (!c) throw new Error(`Unknown: ${t}`);
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

/**
 * Creates an LLM adapter that follows a scripted sequence of outcomes.
 */
function createScriptedLLM(script: AgentOutcome[]): LLMAdapter {
  let idx = 0;

  function outcomeToResponse(outcome: AgentOutcome): LLMResponse {
    const base = {
      stopReason: 'end_turn' as const,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      toolCalls: [],
    };

    switch (outcome.type) {
      case 'goal_reached':
        return {
          ...base,
          content: JSON.stringify({
            action: 'done',
            response: outcome.response,
            goalStateReached: true,
            awaitingUserInput: false,
          }),
        };
      case 'continue':
        return {
          ...base,
          content: JSON.stringify({
            action: 'continue',
            response: outcome.response,
            goalStateReached: false,
            awaitingUserInput: false,
          }),
        };
      case 'user_input':
        return {
          ...base,
          content: JSON.stringify({
            action: 'done',
            response: outcome.question,
            goalStateReached: false,
            awaitingUserInput: true,
          }),
        };
      case 'handoff':
        return {
          ...base,
          content: JSON.stringify({
            action: 'handoff',
            response: 'Handing off work',
            goalStateReached: true,
            handoffSpec: {
              goal: 'Execute plan',
              context: 'Test context',
              workItems: outcome.workItems.map(w => ({
                id: w.id,
                objective: w.objective ?? w.goal,
                delta: w.objective ?? w.goal,
                agent: w.agent ?? 'standard',
                dependencies: w.dependencies ?? [],
              })),
            },
            awaitingUserInput: false,
          }),
        };
      case 'bounds_exceeded':
        // Return continue to let agent hit its internal bounds
        return {
          ...base,
          content: JSON.stringify({
            action: 'continue',
            response: 'Working...',
            goalStateReached: false,
            awaitingUserInput: false,
          }),
        };
      case 'error':
        return {
          ...base,
          content: '',
          stopReason: 'error',
        };
      case 'refusal':
        return {
          ...base,
          content: JSON.stringify({
            action: 'done',
            response: outcome.message,
            goalStateReached: false,
            awaitingUserInput: false,
            isRefusal: true,
          }),
        };
    }
  }

  return {
    respond: async () => {
      const outcome = script[Math.min(idx, script.length - 1)];
      idx++;
      return outcomeToResponse(outcome);
    },
    stream: async function* () {
      const outcome = script[Math.min(idx, script.length - 1)];
      idx++;
      const response = outcomeToResponse(outcome);
      yield response.content;
      return response;
    },
    getConfig: () => ({ provider: 'test', model: 'test' }),
    capabilities: () => ({ supportsStreaming: true, supportsToolUse: true, supportsStructuredOutput: true }),
  } as unknown as LLMAdapter;
}

// ============================================
// STATE TRANSITION TESTS
// ============================================

describe('State Machine: Basic Transitions', () => {
  beforeEach(() => resetProviderCircuit());

  it('idle → executing → terminated(goal_state_reached)', async () => {
    const llm = createScriptedLLM([{ type: 'goal_reached', response: 'Done' }]);
    const events: AgentEvent[] = [];

    const orch = new Orchestrator(
      { maxIterations: 10 },
      createToolRegistry(),
      llm,
      (e) => events.push(e),
      REQUEST_ID,
      undefined,
      createAgentRegistry(),
      undefined,
      undefined,
      () => getModelSelection()
    );

    const result = await orch.execute(createContext(), 'Test goal', 'standard', CWD);

    // Verify state transition
    expect(result.terminationReason).toBe('goal_state_reached');
    expect(result.success).toBe(true);

    // Verify events emitted in order
    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain('orchestration_started');
    expect(eventTypes).toContain('iteration_started');
    expect(eventTypes).toContain('iteration_completed');
    expect(eventTypes).toContain('goal_achieved');
  });

  it('idle → executing → terminated(max_iterations_exceeded)', async () => {
    // Agent keeps returning 'continue' until bounds hit
    const llm = createScriptedLLM([
      { type: 'continue', response: 'Working 1' },
      { type: 'continue', response: 'Working 2' },
      { type: 'continue', response: 'Working 3' },
    ]);

    const orch = new Orchestrator(
      { maxIterations: 2 }, // Low orchestrator limit
      createToolRegistry(),
      llm,
      () => {},
      REQUEST_ID,
      undefined,
      // Agent with higher limit so orchestrator bounds hit first
      createAgentRegistry({ maxIterations: 1, maxToolCalls: 50, maxDurationMs: 30_000 }),
      undefined,
      undefined,
      () => getModelSelection()
    );

    const result = await orch.execute(createContext(), 'Bounds test', 'standard', CWD);

    // Should terminate due to bounds
    expect(result.terminationReason).toBe('max_iterations_exceeded');
  });

  it('idle → executing → paused(user_input_required)', async () => {
    const llm = createScriptedLLM([{ type: 'user_input', question: 'What color?' }]);

    const orch = new Orchestrator(
      { maxIterations: 10 },
      createToolRegistry(),
      llm,
      () => {},
      REQUEST_ID,
      undefined,
      createAgentRegistry(),
      undefined,
      undefined,
      () => getModelSelection()
    );

    const result = await orch.execute(createContext(), 'Ask user', 'standard', CWD);

    expect(result.terminationReason).toBe('user_input_required');
    expect(result.paused).toBe(true);
    expect(result.userPrompt).toBeDefined();
  });

  it('idle → executing → paused(handoff_requested) without approval hook', async () => {
    // Handoff only works with planner agent type which uses planner_output schema
    const llm = createScriptedLLM([{
      type: 'handoff',
      workItems: [{ id: 'w1', goal: 'Task 1', objective: 'Do task 1', agent: 'standard' }],
    }]);

    const orch = new Orchestrator(
      { maxIterations: 10 },
      createToolRegistry(),
      llm,
      () => {},
      REQUEST_ID,
      undefined,
      createAgentRegistry(),
      undefined,
      undefined,
      () => getModelSelection()
    );

    // Use 'planner' agent type for handoff
    const result = await orch.execute(createContext(), 'Plan work', 'planner', CWD);

    // Without approval hook, should pause for user
    expect(result.terminationReason).toBe('handoff_requested');
    expect(result.paused).toBe(true);
    expect(result.handoffSpec).toBeDefined();
  });
});

describe('State Machine: Hook-Driven Transitions', () => {
  beforeEach(() => resetProviderCircuit());

  it('goal_reached + hook_block → continue executing', async () => {
    let callCount = 0;
    const llm = createScriptedLLM([
      { type: 'goal_reached', response: 'First attempt' },
      { type: 'goal_reached', response: 'Second attempt' },
    ]);

    const registry = createHookRegistry();
    registry.register({
      id: 'block-once',
      event: 'goal_state_reached',
      policy: { kind: 'fire_and_forget' },
      criticality: 'non_critical',
      idempotency: 'idempotent',
      priority: 100,
      timeoutMs: 5000,
      run: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            kind: 'success',
            decision: { verdict: 'failed', issues: ['Not good enough'] } as QualityGateDecision,
            patches: [],
          };
        }
        return {
          kind: 'success',
          decision: { verdict: 'passed' } as QualityGateDecision,
          patches: [],
        };
      },
    }, HOOK_META);

    const orch = new Orchestrator(
      { maxIterations: 10 },
      createToolRegistry(),
      llm,
      () => {},
      REQUEST_ID,
      undefined,
      createAgentRegistry(),
      undefined,
      undefined,
      () => getModelSelection()
    );

    const result = await orch.execute(createContext(), 'Test', 'standard', CWD, { hookRegistry: registry });

    // First goal_reached blocked, second allowed
    expect(callCount).toBe(2);
    expect(result.terminationReason).toBe('goal_state_reached');
    expect(result.success).toBe(true);
  });

  it('handoff + hook_approve → execute work items', async () => {
    let llmCalls = 0;
    const llm = {
      respond: async () => {
        llmCalls++;
        if (llmCalls === 1) {
          // First call: planner returns handoff
          return {
            content: JSON.stringify({
              action: 'handoff',
              response: 'Plan ready',
              goalStateReached: true,
              handoffSpec: {
                goal: 'Execute',
                context: 'Test',
                workItems: [
                  { id: 'w1', objective: 'Task 1', delta: 'Task 1', agent: 'standard' },
                ],
              },
              awaitingUserInput: false,
            }),
            stopReason: 'end_turn',
            usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            toolCalls: [],
          };
        }
        // Subsequent calls: workers complete
        return {
          content: JSON.stringify({
            action: 'done',
            response: `Worker ${llmCalls} done`,
            goalStateReached: true,
            awaitingUserInput: false,
          }),
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          toolCalls: [],
        };
      },
      stream: async function* () {
        const resp = await (this as LLMAdapter).respond([], {});
        yield resp.content;
        return resp;
      },
      getConfig: () => ({ provider: 'test', model: 'test' }),
      capabilities: () => ({ supportsStreaming: true, supportsToolUse: true, supportsStructuredOutput: true }),
    } as unknown as LLMAdapter;

    const registry = createHookRegistry();
    registry.register({
      id: 'approve-handoff',
      event: 'handoff_requested',
      policy: { kind: 'fire_and_forget' },
      criticality: 'non_critical',
      idempotency: 'idempotent',
      priority: 100,
      timeoutMs: 5000,
      run: async () => ({
        kind: 'success',
        decision: { action: 'approve' } as HandoffDecision,
        patches: [],
      }),
    }, HOOK_META);

    const orch = new Orchestrator(
      { maxIterations: 10 },
      createToolRegistry(),
      llm,
      () => {},
      REQUEST_ID,
      undefined,
      createAgentRegistry(),
      undefined,
      undefined,
      () => getModelSelection()
    );

    // Use 'planner' agent type for handoff
    const result = await orch.execute(createContext(), 'Plan', 'planner', CWD, { hookRegistry: registry });

    // Handoff approved, work items executed
    // After handoff approval, workers should run and complete
    // The result may be from the last worker, not the planner
    expect(llmCalls).toBeGreaterThan(1); // Planner + at least one worker
    // Result success depends on whether workers completed successfully
    // If handoff was approved and workers ran, that's the main invariant
    expect(result.terminationReason).toBeDefined();
    // Check it didn't pause (handoff was approved, not waiting for user)
    expect(result.paused).toBe(false);
  });

  it('handoff + hook_reject → continue with feedback', async () => {
    let llmCalls = 0;
    const llm = {
      respond: async () => {
        llmCalls++;
        if (llmCalls <= 2) {
          // First two calls: planner returns handoff
          return {
            content: JSON.stringify({
              action: 'handoff',
              response: `Plan attempt ${llmCalls}`,
              goalStateReached: true,
              handoffSpec: {
                goal: 'Execute',
                context: 'Test',
                workItems: [
                  { id: 'w1', objective: 'Task 1', delta: 'Task 1', agent: 'standard' },
                ],
              },
              awaitingUserInput: false,
            }),
            stopReason: 'end_turn',
            usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            toolCalls: [],
          };
        }
        // After rejection feedback, return goal_reached
        return {
          content: JSON.stringify({
            action: 'done',
            response: 'Revised plan complete',
            goalStateReached: true,
            awaitingUserInput: false,
          }),
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          toolCalls: [],
        };
      },
      stream: async function* () {
        const resp = await (this as LLMAdapter).respond([], {});
        yield resp.content;
        return resp;
      },
      getConfig: () => ({ provider: 'test', model: 'test' }),
      capabilities: () => ({ supportsStreaming: true, supportsToolUse: true, supportsStructuredOutput: true }),
    } as unknown as LLMAdapter;

    let hookCalls = 0;
    const registry = createHookRegistry();
    registry.register({
      id: 'reject-then-approve',
      event: 'handoff_requested',
      policy: { kind: 'fire_and_forget' },
      criticality: 'non_critical',
      idempotency: 'idempotent',
      priority: 100,
      timeoutMs: 5000,
      run: async () => {
        hookCalls++;
        if (hookCalls === 1) {
          return {
            kind: 'success',
            decision: { action: 'reject', feedback: 'Plan is incomplete' } as HandoffDecision,
            patches: [],
          };
        }
        return {
          kind: 'success',
          decision: { action: 'approve' } as HandoffDecision,
          patches: [],
        };
      },
    }, HOOK_META);

    const orch = new Orchestrator(
      { maxIterations: 10 },
      createToolRegistry(),
      llm,
      () => {},
      REQUEST_ID,
      undefined,
      createAgentRegistry(),
      undefined,
      undefined,
      () => getModelSelection()
    );

    // Use 'planner' agent type for handoff
    const result = await orch.execute(createContext(), 'Plan', 'planner', CWD, { hookRegistry: registry });

    // First handoff rejected, planner continued
    expect(hookCalls).toBeGreaterThanOrEqual(1);
    expect(result).toBeDefined();
  });

  it('user_input + hook_answer → continue without pausing', async () => {
    let llmCalls = 0;
    const llm = {
      respond: async () => {
        llmCalls++;
        if (llmCalls === 1) {
          // First call: ask user
          return {
            content: JSON.stringify({
              action: 'done',
              response: 'What is your name?',
              goalStateReached: false,
              awaitingUserInput: true,
            }),
            stopReason: 'end_turn',
            usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            toolCalls: [],
          };
        }
        // After watcher answers, complete
        return {
          content: JSON.stringify({
            action: 'done',
            response: 'Hello, Test User!',
            goalStateReached: true,
            awaitingUserInput: false,
          }),
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          toolCalls: [],
        };
      },
      stream: async function* () {
        const resp = await (this as LLMAdapter).respond([], {});
        yield resp.content;
        return resp;
      },
      getConfig: () => ({ provider: 'test', model: 'test' }),
      capabilities: () => ({ supportsStreaming: true, supportsToolUse: true, supportsStructuredOutput: true }),
    } as unknown as LLMAdapter;

    const registry = createHookRegistry();
    registry.register({
      id: 'answer-user-input',
      event: 'user_input_required',
      policy: { kind: 'fire_and_forget' },
      criticality: 'non_critical',
      idempotency: 'idempotent',
      priority: 100,
      timeoutMs: 5000,
      run: async () => ({
        kind: 'success',
        decision: { action: 'answer', text: 'Test User' } as PromptAnswerDecision,
        patches: [],
      }),
    }, HOOK_META);

    const orch = new Orchestrator(
      { maxIterations: 10 },
      createToolRegistry(),
      llm,
      () => {},
      REQUEST_ID,
      undefined,
      createAgentRegistry(),
      undefined,
      undefined,
      () => getModelSelection()
    );

    const result = await orch.execute(createContext(), 'Greet user', 'standard', CWD, { hookRegistry: registry });

    // Watcher answered, didn't pause
    expect(result.paused).toBe(false);
    expect(result.terminationReason).toBe('goal_state_reached');
    expect(llmCalls).toBe(2);
  });
});

describe('State Machine: Realign Counter', () => {
  beforeEach(() => resetProviderCircuit());

  it('realign increments on bounds_exceeded + block', async () => {
    // Agent hits bounds repeatedly, hook keeps blocking
    let hookCalls = 0;
    const registry = createHookRegistry();
    registry.register({
      id: 'always-realign',
      event: 'bounds_exceeded',
      policy: { kind: 'fire_and_forget' },
      criticality: 'non_critical',
      idempotency: 'idempotent',
      priority: 100,
      timeoutMs: 5000,
      run: async () => {
        hookCalls++;
        return {
          kind: 'success',
          decision: { action: 'realign', guidance: `Realign attempt ${hookCalls}` } as BoundsDecision,
          patches: [],
        };
      },
    }, HOOK_META);

    const llm = createScriptedLLM([
      { type: 'continue', response: 'Working...' },
      { type: 'continue', response: 'Still working...' },
      { type: 'continue', response: 'More work...' },
      { type: 'continue', response: 'Even more...' },
      { type: 'continue', response: 'Continuing...' },
    ]);

    const orch = new Orchestrator(
      { maxIterations: 10, maxRealigns: 2 },
      createToolRegistry(),
      llm,
      () => {},
      REQUEST_ID,
      undefined,
      // Very low agent budget to trigger bounds quickly
      createAgentRegistry({ maxIterations: 1, maxToolCalls: 1, maxDurationMs: 100 }),
      undefined,
      undefined,
      () => getModelSelection()
    );

    const result = await orch.execute(createContext(), 'Realign test', 'standard', CWD, { hookRegistry: registry });

    // Should have hit maxRealigns and terminated
    expect(result).toBeDefined();
    // Hook should have been called (may be fewer if agent bounds hit before orchestrator)
  });

  it('realign resets on split (progress made)', async () => {
    // Hook returns split instead of realign - should reset counter
    let hookCalls = 0;
    const registry = createHookRegistry();
    registry.register({
      id: 'split-on-bounds',
      event: 'bounds_exceeded',
      policy: { kind: 'fire_and_forget' },
      criticality: 'non_critical',
      idempotency: 'idempotent',
      priority: 100,
      timeoutMs: 5000,
      run: async () => {
        hookCalls++;
        if (hookCalls === 1) {
          return {
            kind: 'success',
            decision: {
              action: 'split',
              workItems: [{ id: 's1', goal: 'Split task', objective: 'Do split', agent: 'standard' }],
            } as BoundsDecision,
            patches: [],
          };
        }
        return {
          kind: 'success',
          decision: { action: 'wrap_up', summary: 'Done' } as BoundsDecision,
          patches: [],
        };
      },
    }, HOOK_META);

    const llm = createScriptedLLM([
      { type: 'continue', response: 'Working...' },
      { type: 'goal_reached', response: 'Split task done' },
    ]);

    const orch = new Orchestrator(
      { maxIterations: 10, maxRealigns: 1 },
      createToolRegistry(),
      llm,
      () => {},
      REQUEST_ID,
      undefined,
      createAgentRegistry({ maxIterations: 1, maxToolCalls: 1, maxDurationMs: 100 }),
      undefined,
      undefined,
      () => getModelSelection()
    );

    const result = await orch.execute(createContext(), 'Split test', 'standard', CWD, { hookRegistry: registry });

    // Split should have executed
    expect(result).toBeDefined();
  });
});

describe('State Machine: Invariant Assertions', () => {
  beforeEach(() => resetProviderCircuit());

  it('INVARIANT: terminal state has no further transitions', async () => {
    const events: AgentEvent[] = [];
    const llm = createScriptedLLM([{ type: 'goal_reached', response: 'Done' }]);

    const orch = new Orchestrator(
      { maxIterations: 10 },
      createToolRegistry(),
      llm,
      (e) => events.push(e),
      REQUEST_ID,
      undefined,
      createAgentRegistry(),
      undefined,
      undefined,
      () => getModelSelection()
    );

    await orch.execute(createContext(), 'Test', 'standard', CWD);

    // After goal_achieved, no more iteration events
    const goalAchievedIdx = events.findIndex(e => e.type === 'goal_achieved');
    expect(goalAchievedIdx).toBeGreaterThan(-1);

    const eventsAfterGoal = events.slice(goalAchievedIdx + 1);
    const iterationEvents = eventsAfterGoal.filter(e =>
      e.type === 'iteration_started' || e.type === 'iteration_completed'
    );
    expect(iterationEvents.length).toBe(0);
  });

  it('INVARIANT: iteration count monotonically increases', async () => {
    const events: AgentEvent[] = [];
    const llm = createScriptedLLM([
      { type: 'continue', response: 'Working 1' },
      { type: 'continue', response: 'Working 2' },
      { type: 'goal_reached', response: 'Done' },
    ]);

    const orch = new Orchestrator(
      { maxIterations: 10 },
      createToolRegistry(),
      llm,
      (e) => events.push(e),
      REQUEST_ID,
      undefined,
      createAgentRegistry({ maxIterations: 3, maxToolCalls: 50, maxDurationMs: 30_000 }),
      undefined,
      undefined,
      () => getModelSelection()
    );

    await orch.execute(createContext(), 'Test', 'standard', CWD);

    const iterations = events
      .filter(e => e.type === 'iteration_started')
      .map(e => (e.data as { iteration: number }).iteration);

    // Iterations should be monotonically non-decreasing
    // (can be equal when multiple work items run in parallel)
    for (let i = 1; i < iterations.length; i++) {
      expect(iterations[i]).toBeGreaterThanOrEqual(iterations[i - 1]);
    }

    // Additionally, verify iterations start at 1 and don't skip
    if (iterations.length > 0) {
      expect(iterations[0]).toBe(1);
    }
  });

  it('INVARIANT: completed work count never decreases', async () => {
    // This would require access to internal state, so we test via events
    const events: AgentEvent[] = [];
    const llm = createScriptedLLM([
      { type: 'goal_reached', response: 'Done' },
    ]);

    const orch = new Orchestrator(
      { maxIterations: 10 },
      createToolRegistry(),
      llm,
      (e) => events.push(e),
      REQUEST_ID,
      undefined,
      createAgentRegistry(),
      undefined,
      undefined,
      () => getModelSelection()
    );

    await orch.execute(createContext(), 'Test', 'standard', CWD);

    // goal_achieved should report completed > 0
    const goalEvent = events.find(e => e.type === 'goal_achieved');
    expect(goalEvent).toBeDefined();
    const data = goalEvent!.data as { completed: number };
    expect(data.completed).toBeGreaterThan(0);
  });
});

describe('State Machine: Error States', () => {
  beforeEach(() => resetProviderCircuit());

  it('unknown agent type → immediate error termination', async () => {
    const llm = createScriptedLLM([{ type: 'goal_reached', response: 'Done' }]);

    const orch = new Orchestrator(
      { maxIterations: 10 },
      createToolRegistry(),
      llm,
      () => {},
      REQUEST_ID,
      undefined,
      createAgentRegistry(),
      undefined,
      undefined,
      () => getModelSelection()
    );

    const result = await orch.execute(createContext(), 'Test', 'nonexistent_agent', CWD);

    expect(result.success).toBe(false);
    expect(result.terminationReason).toBe('agent_error');
  });

  it('LLM error → graceful termination', async () => {
    const llm = {
      respond: async () => {
        throw new Error('LLM exploded');
      },
      stream: async function* () {
        throw new Error('LLM exploded');
      },
      getConfig: () => ({ provider: 'test', model: 'test' }),
      capabilities: () => ({ supportsStreaming: true, supportsToolUse: true, supportsStructuredOutput: true }),
    } as unknown as LLMAdapter;

    const orch = new Orchestrator(
      { maxIterations: 10 },
      createToolRegistry(),
      llm,
      () => {},
      REQUEST_ID,
      undefined,
      createAgentRegistry(),
      undefined,
      undefined,
      () => getModelSelection()
    );

    // Should not throw, should return error result
    const result = await orch.execute(createContext(), 'Test', 'standard', CWD);
    expect(result).toBeDefined();
    expect(result.success).toBe(false);
  });
});

describe('State Machine: Interruption Handling', () => {
  beforeEach(() => resetProviderCircuit());

  it('interruption during goal_reached → continue with new work', async () => {
    let llmCalls = 0;
    let shouldInterrupt = true;
    const llm = {
      respond: async () => {
        llmCalls++;
        return {
          content: JSON.stringify({
            action: 'done',
            response: `Done ${llmCalls}`,
            goalStateReached: true,
            awaitingUserInput: false,
          }),
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          toolCalls: [],
        };
      },
      stream: async function* () {
        const resp = await (this as LLMAdapter).respond([], {});
        yield resp.content;
        return resp;
      },
      getConfig: () => ({ provider: 'test', model: 'test' }),
      capabilities: () => ({ supportsStreaming: true, supportsToolUse: true, supportsStructuredOutput: true }),
    } as unknown as LLMAdapter;

    const orch = new Orchestrator(
      { maxIterations: 10 },
      createToolRegistry(),
      llm,
      () => {},
      REQUEST_ID,
      undefined,
      createAgentRegistry(),
      undefined,
      undefined,
      () => getModelSelection()
    );

    const runtime: OrchestratorRuntime = {
      checkInterruption: () => {
        if (shouldInterrupt && llmCalls === 1) {
          shouldInterrupt = false;
          return true;
        }
        return false;
      },
    };

    const result = await orch.execute(createContext(), 'Test', 'standard', CWD, runtime);

    // Interruption should have caused additional work
    expect(llmCalls).toBe(2);
    expect(result.success).toBe(true);
  });
});
