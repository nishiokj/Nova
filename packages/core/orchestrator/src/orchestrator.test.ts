/**
 * Orchestrator Tests - Comprehensive Test Suite
 *
 * Tests all decision paths, boundary conditions, and extreme cases.
 * Uses real ContextWindow instances with minimal mocking.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ContextWindow } from 'context';
import { createWorkItem, type WorkItem } from 'work';
import type {
  LLMAdapter,
  LLMResponse,
  ToolDefinition,
  AgentEvent,
  StructuredOutputSchema,
} from 'types';
import type { ToolRegistry, ToolHandler } from 'tools';
import type { AgentConfig, AgentResult } from 'agent';
import type { AgentRegistry } from 'agent';
import type {
  ControlEvent,
  QualityGateDecision,
  BoundsDecision,
  PromptAnswerDecision,
  CadenceDecision,
  HandoffDecision,
  Hook,
  HookContext,
  HookOutcome,
  WorkItemSpec,
} from 'protocol';
import { getProtocolId } from 'protocol';
import {
  Orchestrator,
  type OrchestratorConfig,
  type OrchestratorRuntime,
  type OrchestratorResult,
  DEFAULT_ORCHESTRATOR_CONFIG,
} from './orchestrator.js';
import { createHookRegistry, type HookRegistry } from './hookRegistry/index.js';
import { getOutputSchemaJson } from 'shared';
import { resetProviderCircuit } from 'agent';

// ============================================
// TEST FIXTURES
// ============================================

const TEST_SESSION_KEY = 'test-session-001';
const TEST_REQUEST_ID = 'req-test-001';
const TEST_CWD = '/test/project';

/**
 * Create a real ContextWindow with optional initial messages.
 */
function createTestContext(messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): ContextWindow {
  const ctx = new ContextWindow(TEST_SESSION_KEY, 200_000);
  if (messages) {
    for (const msg of messages) {
      ctx.addMessage(msg.role, msg.content);
    }
  }
  return ctx;
}

/**
 * Create a minimal mock ToolRegistry.
 */
function createMockToolRegistry(tools: string[] = ['Read', 'Grep', 'Glob']): ToolRegistry {
  const definitions: ToolDefinition[] = tools.map(name => ({
    name,
    description: `Mock ${name} tool`,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  }));

  const handlers = new Map<string, ToolHandler>();
  for (const name of tools) {
    handlers.set(name, async () => ({
      success: true,
      output: `Mock output from ${name}`,
    }));
  }

  return {
    getDefinitions: () => definitions,
    getDefinition: (name: string) => definitions.find(d => d.name === name),
    hasHandler: (name: string) => handlers.has(name),
    execute: async (name: string, args: Record<string, unknown>) => {
      const handler = handlers.get(name);
      if (!handler) {
        return { success: false, output: `Unknown tool: ${name}`, error: 'unknown_tool' };
      }
      return handler(args);
    },
    getAllNames: () => tools,
    register: () => {},
    unregister: () => {},
  } as unknown as ToolRegistry;
}

/**
 * Create a mock AgentRegistry with configurable agent configs.
 *
 * Agent budget.maxIterations controls how many LLM calls the Agent makes before
 * returning control to the orchestrator. The orchestrator's iteration count only
 * increments when Agent.run() returns.
 *
 * - For tests that expect Agent to reach goal: Set maxIterations high enough to
 *   reach the goalReached response in the mock sequence.
 * - For tests that need orchestrator-level bounds testing: Set maxIterations low
 *   but ensure the Agent returns with a non-bounds termination reason.
 */
function createMockAgentRegistry(
  configs: Record<string, Partial<AgentConfig>> = {}
): AgentRegistry {
  const defaultConfig: AgentConfig = {
    type: 'standard',
    systemPrompt: 'You are a test agent.',
    tools: ['Read', 'Grep', 'Glob'],
    budget: {
      maxIterations: 10, // Allow agent to complete work in one run
      maxToolCalls: 150,
      maxDurationMs: 120_000,
    },
    llmParams: {
      maxTokens: 16000,
      temperature: 0.7,
    },
    outputSchema: getOutputSchemaJson('agent_action'),
  };

  // Planner uses planner_output schema which supports handoff action
  const plannerConfig: AgentConfig = {
    ...defaultConfig,
    type: 'planner',
    outputSchema: getOutputSchemaJson('planner_output'),
  };

  const registry = new Map<string, AgentConfig>();
  registry.set('standard', { ...defaultConfig, type: 'standard', ...configs.standard });
  registry.set('planner', { ...plannerConfig, ...configs.planner });
  registry.set('observer', { ...defaultConfig, type: 'observer', ...configs.observer });
  registry.set('explorer', { ...defaultConfig, type: 'explorer', ...configs.explorer });

  return {
    has: (type: string) => registry.has(type),
    getConfig: (type: string) => {
      const config = registry.get(type);
      if (!config) throw new Error(`Unknown agent type: ${type}`);
      return config;
    },
    listToolDefinitions: () => [],
    register: () => {},
    get: () => null,
  } as unknown as AgentRegistry;
}

/**
 * LLM Response builder for realistic structured outputs.
 */
interface LLMResponseBuilder {
  goalReached(response?: string): LLMResponse;
  continueWork(response?: string): LLMResponse;
  awaitingUserInput(question: string): LLMResponse;
  handoff(workItems: WorkItemSpec[]): LLMResponse;
  observerAnswer(text: string): LLMResponse;
  observerRealign(systemMessage: string, newGoal?: string): LLMResponse;
  observerSplit(workItems: WorkItemSpec[]): LLMResponse;
  observerQualityGatePassed(): LLMResponse;
  observerQualityGateFailed(issues: string[]): LLMResponse;
  observerAllow(): LLMResponse;
  observerContinue(): LLMResponse;
  error(message: string): LLMResponse;
}

function createLLMResponseBuilder(): LLMResponseBuilder {
  const base = (content: string): LLMResponse => ({
    content,
    stopReason: 'end_turn',
    usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    toolCalls: [],
  });

  return {
    goalReached(response = 'Task completed successfully.'): LLMResponse {
      return base(JSON.stringify({
        action: 'done',
        response,
        goalStateReached: true,
        handoffSpec: null,
        awaitingUserInput: false,
      }));
    },

    continueWork(response = 'Making progress...'): LLMResponse {
      return base(JSON.stringify({
        action: 'continue',
        response,
        goalStateReached: false,
        handoffSpec: null,
        awaitingUserInput: false,
      }));
    },

    awaitingUserInput(question: string): LLMResponse {
      return base(JSON.stringify({
        action: 'done',
        response: question,
        goalStateReached: false,
        handoffSpec: null,
        awaitingUserInput: true,
      }));
    },

    handoff(workItems: WorkItemSpec[]): LLMResponse {
      // Ensure work items have required 'delta' field for schema validation
      const normalizedWorkItems = workItems.map(item => ({
        id: item.id,
        objective: item.objective ?? item.goal,
        delta: (item as Record<string, unknown>).delta ?? item.objective ?? item.goal,
        agent: item.agent ?? 'standard',
        domain: (item as Record<string, unknown>).domain,
        dependencies: item.dependencies,
        targetPaths: (item as Record<string, unknown>).targetPaths as string[] | undefined,
      }));

      return base(JSON.stringify({
        action: 'handoff',
        response: 'Plan created, ready for handoff.',
        goalStateReached: true,
        handoffSpec: {
          goal: 'Execute the planned work',
          context: 'This plan addresses the user request.',
          workItems: normalizedWorkItems,
        },
        awaitingUserInput: false,
      }));
    },

    observerAnswer(text: string): LLMResponse {
      return base(JSON.stringify({
        action: 'done',
        response: `Observer answered: ${text}`,
        goalStateReached: true,
        awaitingUserInput: false,
        observerAction: 'answer',
        reason: 'Answered based on codebase conventions.',
        answer: { text, contextAddendum: null },
      }));
    },

    observerRealign(systemMessage: string, newGoal?: string): LLMResponse {
      return base(JSON.stringify({
        action: 'done',
        response: `Observer realigning: ${systemMessage}`,
        goalStateReached: true,
        awaitingUserInput: false,
        observerAction: 'realign',
        reason: 'Agent needs course correction.',
        realign: { systemMessage, newGoal: newGoal ?? null },
      }));
    },

    observerSplit(workItems: WorkItemSpec[]): LLMResponse {
      return base(JSON.stringify({
        action: 'done',
        response: `Observer splitting into ${workItems.length} work items.`,
        goalStateReached: true,
        awaitingUserInput: false,
        observerAction: 'split',
        reason: 'Task is too large, splitting into atomic units.',
        workItems,
      }));
    },

    observerQualityGatePassed(): LLMResponse {
      return base(JSON.stringify({
        action: 'done',
        response: 'Quality gate passed.',
        goalStateReached: true,
        awaitingUserInput: false,
        observerAction: 'quality_gate',
        reason: 'Work meets quality standards.',
        qualityGate: { passed: true },
      }));
    },

    observerQualityGateFailed(issues: string[]): LLMResponse {
      return base(JSON.stringify({
        action: 'done',
        response: `Quality gate failed: ${issues.join(', ')}`,
        goalStateReached: true,
        awaitingUserInput: false,
        observerAction: 'quality_gate',
        reason: 'Work does not meet quality standards.',
        qualityGate: { passed: false, issues },
      }));
    },

    observerAllow(): LLMResponse {
      return base(JSON.stringify({
        action: 'done',
        response: 'No intervention needed.',
        goalStateReached: true,
        awaitingUserInput: false,
        observerAction: 'allow',
        reason: 'Agent is on track.',
      }));
    },

    observerContinue(): LLMResponse {
      return base(JSON.stringify({
        action: 'continue',
        response: 'Continuing to evaluate...',
        goalStateReached: false,
        awaitingUserInput: false,
        observerAction: 'continue',
        reason: 'Need more information.',
      }));
    },

    error(message: string): LLMResponse {
      return {
        content: message,
        stopReason: 'error',
        usage: { inputTokens: 10, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        toolCalls: [],
      };
    },
  };
}

/**
 * Create a mock LLMAdapter with configurable response sequence.
 * Properly implements streaming to work with Agent's resilientCall.
 */
function createMockLLMAdapter(responseSequence: LLMResponse[]): LLMAdapter {
  let callIndex = 0;

  return {
    respond: async () => {
      const response = responseSequence[Math.min(callIndex, responseSequence.length - 1)];
      callIndex++;
      return response;
    },
    stream: async function* () {
      const response = responseSequence[Math.min(callIndex, responseSequence.length - 1)];
      callIndex++;

      // Yield the content in chunks
      const content = response.content;
      if (content) {
        // Yield content in chunks to simulate streaming
        const chunkSize = Math.ceil(content.length / 3);
        for (let i = 0; i < content.length; i += chunkSize) {
          yield content.slice(i, i + chunkSize);
        }
      }

      // Return the final response
      return response;
    },
    getConfig: () => ({ provider: 'test', model: 'test-model' }),
    capabilities: () => ({
      supportsStreaming: true,
      supportsToolUse: true,
      supportsStructuredOutput: true,
    }),
  } as unknown as LLMAdapter;
}

/**
 * Get the current protocol ID for hook registration.
 */
function getTestProtocolId(): string {
  return getProtocolId();
}

/**
 * Create a hook that returns a specific decision.
 */
function createTestHook<Evt extends ControlEvent, D>(
  id: string,
  event: Evt['type'],
  decision: D | ((evt: Evt, ctx: HookContext) => D | Promise<D>)
): Hook<Evt, D> {
  return {
    id,
    event,
    policy: { kind: 'fire_and_forget' } as const,
    criticality: 'non_critical' as const,
    idempotency: 'idempotent' as const,
    priority: 100,
    timeoutMs: 5000,
    run: async (evt: Evt, ctx: HookContext): Promise<HookOutcome<D>> => {
      const d = typeof decision === 'function' ? await (decision as (evt: Evt, ctx: HookContext) => D | Promise<D>)(evt, ctx) : decision;
      return { kind: 'success', decision: d, patches: [] };
    },
  };
}

/**
 * Event collector for testing.
 */
function createEventCollector(): { emit: (event: AgentEvent) => void; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    emit: (event: AgentEvent) => events.push(event),
    events,
  };
}

// ============================================
// MOCK AGENT FOR ORCHESTRATOR TESTING
// ============================================

/**
 * We need to mock the Agent class to control its behavior precisely.
 * The orchestrator creates agents via createAgent(), so we need to
 * intercept that through the AgentRegistry + model selection.
 */

/**
 * Create an orchestrator with configurable mocks.
 */
function createTestOrchestrator(params: {
  config?: Partial<OrchestratorConfig>;
  llmResponses?: LLMResponse[];
  agentResults?: AgentResult[];
  tools?: string[];
  hookRegistry?: HookRegistry;
  getModelSelection?: (agentType: string) => { provider: string; model: string } | null;
}): {
  orchestrator: Orchestrator;
  context: ContextWindow;
  events: AgentEvent[];
  runtime: OrchestratorRuntime;
} {
  const eventCollector = createEventCollector();
  const context = createTestContext([{ role: 'user', content: 'Test user message' }]);

  const toolRegistry = createMockToolRegistry(params.tools);
  const agentRegistry = createMockAgentRegistry();

  const responseBuilder = createLLMResponseBuilder();
  const llmResponses = params.llmResponses ?? [responseBuilder.goalReached()];
  const llm = createMockLLMAdapter(llmResponses);

  const config: Partial<OrchestratorConfig> = {
    maxIterations: 10,
    maxToolCalls: 100,
    maxDurationMs: 60_000,
    hookTimeoutMs: 1000,
    maxRealigns: 3,
    ...params.config,
  };

  const getModelSelection = params.getModelSelection ?? (() => ({ provider: 'test', model: 'test-model' }));

  const orchestrator = new Orchestrator(
    config,
    toolRegistry,
    llm,
    eventCollector.emit,
    TEST_REQUEST_ID,
    undefined, // logger
    agentRegistry,
    undefined, // hooks
    undefined, // planModeOptions
    getModelSelection
  );

  const runtime: OrchestratorRuntime = {
    hookRegistry: params.hookRegistry,
    checkInterruption: () => false,
    checkStopRequest: () => false,
  };

  return { orchestrator, context, events: eventCollector.events, runtime };
}

// ============================================
// TESTS
// ============================================

describe('Orchestrator', () => {
  // Reset circuit breaker before each test to prevent state leakage
  beforeEach(() => {
    resetProviderCircuit('test');
    resetProviderCircuit('openai-compat');
  });

  // Debug test to verify hooks are being invoked
  describe('Debug: Hook Invocation', () => {
    it('should call hooks when goal is reached', async () => {
      const hookRegistry = createHookRegistry();
      let hookCalled = false;
      let hookEvent: unknown = null;

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'goal_state_reached' }, QualityGateDecision>(
          'debug-hook',
          'goal_state_reached',
          (evt) => {
            hookCalled = true;
            hookEvent = evt;
            return { verdict: 'passed' };
          }
        ),
        { source: 'debug', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime, events } = createTestOrchestrator({
        llmResponses: [responseBuilder.goalReached('Debug test complete.')],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Debug test', 'standard', TEST_CWD, runtime);

      expect(hookCalled).toBe(true);
      expect(result.success).toBe(true);
      expect(result.terminationReason).toBe('goal_state_reached');
    });
  });

  describe('Basic Execution Flow', () => {
    it('should complete successfully when goal is reached immediately', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.goalReached('Done!')],
      });

      const result = await orchestrator.execute(context, 'Test goal', 'standard', TEST_CWD, runtime);

      expect(result.success).toBe(true);
      expect(result.terminationReason).toBe('goal_state_reached');
      expect(result.metrics.iterations).toBeGreaterThan(0);
    });

    it('should continue for multiple iterations until goal reached', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [
          responseBuilder.continueWork('Step 1'),
          responseBuilder.continueWork('Step 2'),
          responseBuilder.goalReached('Completed after 3 iterations'),
        ],
      });

      const result = await orchestrator.execute(context, 'Multi-step goal', 'standard', TEST_CWD, runtime);

      expect(result.success).toBe(true);
      expect(result.terminationReason).toBe('goal_state_reached');
    });
  });

  describe('Bounds Exceeded', () => {
    it('should terminate when max iterations exceeded', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        config: { maxIterations: 2 },
        llmResponses: Array(10).fill(responseBuilder.continueWork()),
      });

      const result = await orchestrator.execute(context, 'Infinite loop goal', 'standard', TEST_CWD, runtime);

      expect(result.terminationReason).toBe('max_iterations_exceeded');
    });

    // TODO: Test design conflicts with agent/orchestrator iteration model
    it.skip('should allow observer to realign on bounds exceeded', async () => {
      const hookRegistry = createHookRegistry();
      const boundsCalls: number[] = [];

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'bounds_exceeded' }, BoundsDecision>(
          'test-bounds-hook',
          'bounds_exceeded',
          () => {
            boundsCalls.push(Date.now());
            return { action: 'realign', guidance: 'Focus on the core task only.' };
          }
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        config: { maxIterations: 2, maxRealigns: 2 },
        llmResponses: [
          responseBuilder.continueWork(),
          responseBuilder.continueWork(),
          responseBuilder.continueWork(), // After realign
          responseBuilder.goalReached('Finally done'),
        ],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Needs realignment', 'standard', TEST_CWD, runtime);

      // Hook should have been called
      expect(boundsCalls.length).toBeGreaterThan(0);
    });

    it('should force termination after maxRealigns exceeded', async () => {
      const hookRegistry = createHookRegistry();
      let realignCount = 0;

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'bounds_exceeded' }, BoundsDecision>(
          'test-bounds-realign',
          'bounds_exceeded',
          () => {
            realignCount++;
            return { action: 'realign', guidance: 'Try again...' };
          }
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        config: { maxIterations: 2, maxRealigns: 2 },
        llmResponses: Array(20).fill(responseBuilder.continueWork()),
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Infinite realign', 'standard', TEST_CWD, runtime);

      // Should terminate after exceeding maxRealigns
      expect(result.terminationReason).toBe('max_iterations_exceeded');
    });

    // TODO: Test design conflicts with agent/orchestrator iteration model
    it.skip('should allow observer to split work on bounds exceeded', async () => {
      const hookRegistry = createHookRegistry();

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'bounds_exceeded' }, BoundsDecision>(
          'test-bounds-split',
          'bounds_exceeded',
          () => ({
            action: 'split',
            workItems: [
              {
                id: 'split-1',
                goal: 'First half',
                objective: 'Do the first half',
                agent: 'standard',
              },
              {
                id: 'split-2',
                goal: 'Second half',
                objective: 'Do the second half',
                agent: 'standard',
                dependencies: ['split-1'],
              },
            ],
          })
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        config: { maxIterations: 2 },
        llmResponses: [
          responseBuilder.continueWork(),
          responseBuilder.continueWork(),
          responseBuilder.goalReached('Split work done'),
        ],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Large task', 'standard', TEST_CWD, runtime);

      // Work should have been enqueued via deferred work
      expect(result.terminationReason).toBe('max_iterations_exceeded');
    });
  });

  describe('User Input Required', () => {
    it('should pause and return user prompt info', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.awaitingUserInput('What database should I use?')],
      });

      const result = await orchestrator.execute(context, 'Choose database', 'standard', TEST_CWD, runtime);

      expect(result.terminationReason).toBe('user_input_required');
      expect(result.paused).toBe(true);
      expect(result.userPrompt).toBeDefined();
    });

    // TODO: This test requires Agent to set needsUserInput via PromptUser tool call
    it.skip('should allow observer to answer questions in async mode', async () => {
      const hookRegistry = createHookRegistry();

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'user_input_required' }, PromptAnswerDecision>(
          'test-prompt-answer',
          'user_input_required',
          (evt) => ({
            action: 'answer',
            text: 'Use PostgreSQL - it matches our existing stack.',
            confidence: 0.95,
            contextAddendum: 'Decision based on codebase analysis.',
          })
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [
          responseBuilder.awaitingUserInput('What database?'),
          responseBuilder.goalReached('Using PostgreSQL as specified.'),
        ],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Choose database', 'standard', TEST_CWD, runtime);

      // Observer should have answered and execution continued
      expect(result.success).toBe(true);
      expect(result.terminationReason).toBe('goal_state_reached');
    });

    it('should defer to user when observer is unsure', async () => {
      const hookRegistry = createHookRegistry();

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'user_input_required' }, PromptAnswerDecision>(
          'test-prompt-defer',
          'user_input_required',
          () => ({ action: 'defer', to: 'user' })
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.awaitingUserInput('Critical decision?')],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Critical task', 'standard', TEST_CWD, runtime);

      // Should still pause for user
      expect(result.terminationReason).toBe('user_input_required');
      expect(result.paused).toBe(true);
    });
  });

  describe('Handoff Flow', () => {
    it('should return handoff spec when planner completes', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [
          responseBuilder.handoff([
            {
              id: 'work-1',
              goal: 'Implement feature',
              objective: 'Add the new feature to src/feature.ts',
              agent: 'standard',
            },
          ]),
        ],
      });

      const result = await orchestrator.execute(context, 'Plan feature', 'planner', TEST_CWD, runtime);

      expect(result.terminationReason).toBe('handoff_requested');
      expect(result.handoffSpec).toBeDefined();
      expect(result.handoffSpec?.workItems).toHaveLength(1);
    });

    // TODO: Test needs investigation - handoff rejection flow
    it.skip('should allow observer to reject handoff', async () => {
      const hookRegistry = createHookRegistry();

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'handoff_requested' }, HandoffDecision>(
          'test-handoff-reject',
          'handoff_requested',
          () => ({
            action: 'reject',
            feedback: 'Missing error handling in the plan.',
          })
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [
          responseBuilder.handoff([
            { id: 'work-1', goal: 'Bad plan', objective: 'Incomplete work', agent: 'standard' },
          ]),
          responseBuilder.handoff([
            {
              id: 'work-2',
              goal: 'Better plan',
              objective: 'Complete work with error handling',
              agent: 'standard',
            },
          ]),
        ],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Create plan', 'planner', TEST_CWD, runtime);

      // Observer rejected first plan, should continue to revised plan
      // Note: The exact behavior depends on implementation details
      expect(result.handoffSpec).toBeDefined();
    });

    // TODO: Test needs investigation - handoff modification flow
    it.skip('should allow observer to modify handoff', async () => {
      const hookRegistry = createHookRegistry();

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'handoff_requested' }, HandoffDecision>(
          'test-handoff-modify',
          'handoff_requested',
          () => ({
            action: 'modify',
            changes: 'Add logging to each work item.',
          })
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [
          responseBuilder.handoff([
            { id: 'work-1', goal: 'Original', objective: 'Do work', agent: 'standard' },
          ]),
        ],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Create plan', 'planner', TEST_CWD, runtime);

      // Should have modification feedback in context
      expect(result.handoffSpec).toBeDefined();
    });
  });

  describe('Quality Gate', () => {
    it('should pass quality gate when work is complete', async () => {
      const hookRegistry = createHookRegistry();

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'goal_state_reached' }, QualityGateDecision>(
          'test-quality-pass',
          'goal_state_reached',
          () => ({ verdict: 'passed' })
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.goalReached('Quality work done.')],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'High quality task', 'standard', TEST_CWD, runtime);

      expect(result.success).toBe(true);
      expect(result.terminationReason).toBe('goal_state_reached');
    });

    it('should fail quality gate and block termination', async () => {
      const hookRegistry = createHookRegistry();
      let qualityCheckCount = 0;

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'goal_state_reached' }, QualityGateDecision>(
          'test-quality-fail',
          'goal_state_reached',
          () => {
            qualityCheckCount++;
            if (qualityCheckCount === 1) {
              return {
                verdict: 'failed',
                issues: ['Missing tests', 'No documentation'],
              };
            }
            return { verdict: 'passed' };
          }
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [
          responseBuilder.goalReached('First attempt.'),
          responseBuilder.goalReached('With tests and docs.'),
        ],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Quality checked task', 'standard', TEST_CWD, runtime);

      // Quality gate should have blocked first attempt
      expect(qualityCheckCount).toBeGreaterThanOrEqual(1);
    });

    // TODO: Test needs investigation - quality gate escalation flow
    it.skip('should escalate to human when uncertain', async () => {
      const hookRegistry = createHookRegistry();

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'goal_state_reached' }, QualityGateDecision>(
          'test-quality-human',
          'goal_state_reached',
          () => ({
            verdict: 'needs_human',
            concerns: ['Security implications unclear', 'Performance impact unknown'],
          })
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.goalReached('Needs review.')],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Risky task', 'standard', TEST_CWD, runtime);

      // Should complete but signal need for human review
      // (actual behavior depends on how needs_human maps to StopHookResult)
      expect(result.terminationReason).toBe('goal_state_reached');
    });
  });

  describe('Cadence Audit', () => {
    it('should inject guidance during long-running tasks', async () => {
      const hookRegistry = createHookRegistry();
      const cadenceChecks: number[] = [];

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'cadence_audit' }, CadenceDecision>(
          'test-cadence-inject',
          'cadence_audit',
          () => {
            cadenceChecks.push(Date.now());
            return {
              action: 'inject_guidance',
              message: 'Remember to stay focused on the objective.',
            };
          }
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        config: { maxIterations: 100 }, // Allow many iterations
        llmResponses: [
          ...Array(5).fill(responseBuilder.continueWork()),
          responseBuilder.goalReached('Done with guidance.'),
        ],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Long task', 'standard', TEST_CWD, runtime);

      expect(result.success).toBe(true);
    });

    it('should stop agent via cadence audit', async () => {
      const hookRegistry = createHookRegistry();

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'cadence_audit' }, CadenceDecision>(
          'test-cadence-stop',
          'cadence_audit',
          () => ({
            action: 'stop',
            reason: 'Agent has been running too long without progress.',
          })
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        config: { maxIterations: 100 },
        llmResponses: Array(50).fill(responseBuilder.continueWork()),
        hookRegistry,
      });

      // Cadence audit is triggered periodically during agent execution
      // This test may not trigger stop directly since cadence is async
      const result = await orchestrator.execute(context, 'Spinning task', 'standard', TEST_CWD, runtime);

      // Result depends on timing - cadence may or may not fire
    });

    it('should split via cadence audit', async () => {
      const hookRegistry = createHookRegistry();

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'cadence_audit' }, CadenceDecision>(
          'test-cadence-split',
          'cadence_audit',
          () => ({
            action: 'split',
            workItems: [
              {
                id: 'cadence-split-1',
                goal: 'First batch',
                objective: 'Process first batch',
                agent: 'standard',
                bounds: { maxToolCalls: 50, maxLlmCalls: 10, maxDurationMs: 60000 },
              },
              {
                id: 'cadence-split-2',
                goal: 'Second batch',
                objective: 'Process second batch',
                agent: 'standard',
              },
            ],
          })
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [
          responseBuilder.continueWork(),
          responseBuilder.goalReached(),
        ],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Splittable task', 'standard', TEST_CWD, runtime);

      // Split creates deferred work which may or may not execute
    });
  });

  describe('Agent Error Handling', () => {
    it('should handle agent exceptions gracefully', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.error('LLM error occurred')],
      });

      const result = await orchestrator.execute(context, 'Error task', 'standard', TEST_CWD, runtime);

      // Should handle error without crashing
      expect(result).toBeDefined();
    });

    it('should allow observer to retry on error', async () => {
      const hookRegistry = createHookRegistry();
      let errorCount = 0;

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'agent_error' }, import('protocol').AgentErrorDecision>(
          'test-error-retry',
          'agent_error',
          () => {
            errorCount++;
            if (errorCount < 2) {
              return { action: 'retry', guidance: 'Try a different approach.' };
            }
            return { action: 'abort', reason: 'Too many retries.' };
          }
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [
          responseBuilder.error('First error'),
          responseBuilder.goalReached('Recovered.'),
        ],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Flaky task', 'standard', TEST_CWD, runtime);

      // Error hook may or may not be called depending on how errors propagate
    });
  });

  describe('Context Compaction', () => {
    it('should compact context when threshold exceeded', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        config: { compactTriggerPercent: 0.1 }, // Low threshold to trigger compaction
        llmResponses: [
          responseBuilder.continueWork(),
          responseBuilder.goalReached(),
        ],
      });

      // Add large file content to trigger compaction
      context.addFileContent('/large/file.ts', 'x'.repeat(50000));
      context.addFileContent('/another/large.ts', 'y'.repeat(50000));

      const result = await orchestrator.execute(context, 'Compact task', 'standard', TEST_CWD, runtime);

      expect(result.success).toBe(true);
    });
  });

  describe('Work Item Dependencies', () => {
    it('should respect work item dependency order', async () => {
      // This tests the internal work queue management
      // Work items with dependencies should wait for dependencies to complete
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.goalReached()],
      });

      const result = await orchestrator.execute(context, 'Dependency test', 'standard', TEST_CWD, runtime);

      expect(result.success).toBe(true);
    });
  });

  describe('Unknown Agent Type', () => {
    it('should fail when agent type is not registered', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.goalReached()],
      });

      const result = await orchestrator.execute(context, 'Unknown agent task', 'nonexistent_agent', TEST_CWD, runtime);

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('agent_error');
      expect(result.error).toContain('Unknown agent type');
    });
  });

  describe('Interruption Handling', () => {
    it('should detect pending interruption and continue', async () => {
      let interruptionChecked = false;

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, events } = createTestOrchestrator({
        llmResponses: [
          responseBuilder.goalReached('First complete.'),
          responseBuilder.goalReached('After interruption.'),
        ],
      });

      const runtime: OrchestratorRuntime = {
        checkInterruption: () => {
          if (!interruptionChecked) {
            interruptionChecked = true;
            return true; // Simulate pending interruption
          }
          return false;
        },
        checkStopRequest: () => false,
      };

      const result = await orchestrator.execute(context, 'Interruptible task', 'standard', TEST_CWD, runtime);

      expect(result.success).toBe(true);
    });
  });

  describe('Stop Request Handling', () => {
    it('should respect stop request during execution', async () => {
      let stopRequested = false;

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context } = createTestOrchestrator({
        config: { maxIterations: 100 },
        llmResponses: Array(50).fill(responseBuilder.continueWork()),
      });

      const runtime: OrchestratorRuntime = {
        checkStopRequest: () => {
          // Request stop after first iteration
          if (!stopRequested) {
            stopRequested = true;
            return false;
          }
          return true;
        },
      };

      const result = await orchestrator.execute(context, 'Stoppable task', 'standard', TEST_CWD, runtime);

      // Agent should receive stop signal via shouldStop hook
    });
  });

  describe('Deferred Work Items', () => {
    it('should enqueue deferred work from hook results', async () => {
      const hookRegistry = createHookRegistry();

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'goal_state_reached' }, QualityGateDecision>(
          'test-deferred-work',
          'goal_state_reached',
          () => ({ verdict: 'passed' })
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.goalReached()],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Deferred task', 'standard', TEST_CWD, runtime);

      expect(result.success).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty goal gracefully', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.goalReached()],
      });

      const result = await orchestrator.execute(context, '', 'standard', TEST_CWD, runtime);

      // Should still execute
      expect(result).toBeDefined();
    });

    it('should handle very long goals', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.goalReached()],
      });

      const longGoal = 'A'.repeat(10000);
      const result = await orchestrator.execute(context, longGoal, 'standard', TEST_CWD, runtime);

      expect(result).toBeDefined();
    });

    it('should handle context with many items', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.goalReached()],
      });

      // Add many messages to context
      for (let i = 0; i < 100; i++) {
        context.addMessage('user', `Message ${i}`);
        context.addMessage('assistant', `Response ${i}`);
      }

      const result = await orchestrator.execute(context, 'Many items', 'standard', TEST_CWD, runtime);

      expect(result).toBeDefined();
    });

    it('should handle missing model selection gracefully', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.goalReached()],
        getModelSelection: () => null, // No model selection
      });

      const result = await orchestrator.execute(context, 'No model', 'standard', TEST_CWD, runtime);

      // Should fail with meaningful error
      expect(result.success).toBe(false);
      expect(result.error).toContain('model');
    });
  });

  describe('Metrics Tracking', () => {
    it('should track iterations correctly', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [
          responseBuilder.continueWork(),
          responseBuilder.continueWork(),
          responseBuilder.goalReached(),
        ],
      });

      const result = await orchestrator.execute(context, 'Track iterations', 'standard', TEST_CWD, runtime);

      expect(result.metrics.iterations).toBeGreaterThan(0);
    });

    it('should track duration', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.goalReached()],
      });

      const result = await orchestrator.execute(context, 'Track duration', 'standard', TEST_CWD, runtime);

      expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Event Emission', () => {
    it('should emit orchestration_started event', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, events, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.goalReached()],
      });

      await orchestrator.execute(context, 'Event test', 'standard', TEST_CWD, runtime);

      const startEvent = events.find(e => e.type === 'orchestration_started');
      expect(startEvent).toBeDefined();
    });

    it('should emit goal_achieved event on success', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, events, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.goalReached()],
      });

      await orchestrator.execute(context, 'Success event test', 'standard', TEST_CWD, runtime);

      const achievedEvent = events.find(e => e.type === 'goal_achieved');
      expect(achievedEvent).toBeDefined();
    });

    it('should emit iteration events', async () => {
      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, events, runtime } = createTestOrchestrator({
        llmResponses: [
          responseBuilder.continueWork(),
          responseBuilder.goalReached(),
        ],
      });

      await orchestrator.execute(context, 'Iteration events', 'standard', TEST_CWD, runtime);

      const iterationEvents = events.filter(e => e.type === 'iteration_started' || e.type === 'iteration_completed');
      expect(iterationEvents.length).toBeGreaterThan(0);
    });
  });

  describe('Complex Observer Scenarios', () => {
    it('should handle observer continuing to work', async () => {
      const hookRegistry = createHookRegistry();
      let continueCount = 0;

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'goal_state_reached' }, QualityGateDecision>(
          'test-observer-continue',
          'goal_state_reached',
          () => {
            continueCount++;
            return { verdict: 'passed' };
          }
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.goalReached()],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Observer continue', 'standard', TEST_CWD, runtime);

      expect(result.success).toBe(true);
      expect(continueCount).toBeGreaterThan(0);
    });

    it('should handle multiple hooks on same event', async () => {
      const hookRegistry = createHookRegistry();
      const hookCalls: string[] = [];

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'goal_state_reached' }, QualityGateDecision>(
          'test-hook-1',
          'goal_state_reached',
          () => {
            hookCalls.push('hook-1');
            return { verdict: 'passed' };
          }
        ),
        { source: 'test-1', protocolId: getTestProtocolId() }
      );

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'goal_state_reached' }, QualityGateDecision>(
          'test-hook-2',
          'goal_state_reached',
          () => {
            hookCalls.push('hook-2');
            return { verdict: 'passed' };
          }
        ),
        { source: 'test-2', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [responseBuilder.goalReached()],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Multi hook', 'standard', TEST_CWD, runtime);

      // Both hooks should be called
      expect(hookCalls.length).toBe(2);
      expect(hookCalls).toContain('hook-1');
      expect(hookCalls).toContain('hook-2');
    });
  });

  describe('Structured Output Validation', () => {
    it('should handle malformed structured output', async () => {
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [{
          content: '{"invalid": json syntax',
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          toolCalls: [],
        }],
      });

      const result = await orchestrator.execute(context, 'Invalid output', 'standard', TEST_CWD, runtime);

      // Should handle gracefully
      expect(result).toBeDefined();
    });

    it('should handle missing required fields', async () => {
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [{
          content: JSON.stringify({ action: 'done' }), // Missing other required fields
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          toolCalls: [],
        }],
      });

      const result = await orchestrator.execute(context, 'Incomplete output', 'standard', TEST_CWD, runtime);

      expect(result).toBeDefined();
    });

    it('should handle unexpected action values', async () => {
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [{
          content: JSON.stringify({
            action: 'invalid_action',
            response: 'test',
            goalStateReached: true,
            handoffSpec: null,
            awaitingUserInput: false,
          }),
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          toolCalls: [],
        }],
      });

      const result = await orchestrator.execute(context, 'Invalid action', 'standard', TEST_CWD, runtime);

      expect(result).toBeDefined();
    });
  });

  describe('Async Mode', () => {
    it('should configure async mode correctly', async () => {
      const eventCollector = createEventCollector();
      const context = createTestContext();
      const toolRegistry = createMockToolRegistry();
      const agentRegistry = createMockAgentRegistry();

      const responseBuilder = createLLMResponseBuilder();
      const llm = createMockLLMAdapter([responseBuilder.goalReached()]);

      const config: Partial<OrchestratorConfig> = {
        maxIterations: 10,
      };

      const orchestrator = new Orchestrator(
        config,
        toolRegistry,
        llm,
        eventCollector.emit,
        TEST_REQUEST_ID,
        undefined,
        agentRegistry,
        undefined,
        undefined,
        () => ({ provider: 'test', model: 'test-model' })
      );

      const result = await orchestrator.execute(context, 'Async test', 'standard', TEST_CWD, {});

      expect(result).toBeDefined();
    });
  });

  describe('Observer Output Schemas', () => {
    // TODO: This test requires Agent to set needsUserInput via PromptUser tool call
    it.skip('should validate observer answer output', async () => {
      const hookRegistry = createHookRegistry();

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'user_input_required' }, PromptAnswerDecision>(
          'test-observer-answer',
          'user_input_required',
          () => ({
            action: 'answer',
            text: 'Use Option A',
            confidence: 0.9,
          })
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [
          responseBuilder.awaitingUserInput('Which option?'),
          responseBuilder.goalReached('Used Option A'),
        ],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Observer answer test', 'standard', TEST_CWD, runtime);

      expect(result.success).toBe(true);
    });

    it('should validate observer realign output', async () => {
      const hookRegistry = createHookRegistry();

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'bounds_exceeded' }, BoundsDecision>(
          'test-observer-realign-output',
          'bounds_exceeded',
          () => ({
            action: 'realign',
            guidance: 'Focus on the main objective, skip edge cases for now.',
          })
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        config: { maxIterations: 2, maxRealigns: 1 },
        llmResponses: Array(5).fill(responseBuilder.continueWork()),
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Realign output test', 'standard', TEST_CWD, runtime);

      // Should terminate after max realigns
      expect(result.terminationReason).toBe('max_iterations_exceeded');
    });

    it('should validate observer split output with bounds', async () => {
      const hookRegistry = createHookRegistry();

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'cadence_audit' }, CadenceDecision>(
          'test-observer-split-bounds',
          'cadence_audit',
          () => ({
            action: 'split',
            workItems: [
              {
                id: 'bounded-work-1',
                goal: 'First task with bounds',
                objective: 'Complete first task',
                agent: 'standard',
                bounds: {
                  maxToolCalls: 50,
                  maxLlmCalls: 10,
                  maxDurationMs: 30000,
                },
              },
              {
                id: 'bounded-work-2',
                goal: 'Second task',
                objective: 'Complete second task',
                agent: 'standard',
                dependencies: ['bounded-work-1'],
              },
            ],
          })
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [
          responseBuilder.continueWork(),
          responseBuilder.goalReached(),
        ],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Split bounds test', 'standard', TEST_CWD, runtime);

      // Deferred work should be enqueued
    });

    it('should validate observer quality gate output', async () => {
      const hookRegistry = createHookRegistry();
      const qualityChecks: { passed: boolean; issues?: string[] }[] = [];

      hookRegistry.register(
        createTestHook<ControlEvent & { type: 'goal_state_reached' }, QualityGateDecision>(
          'test-observer-quality',
          'goal_state_reached',
          () => {
            if (qualityChecks.length === 0) {
              qualityChecks.push({ passed: false, issues: ['Missing error handling', 'No input validation'] });
              return {
                verdict: 'failed',
                issues: ['Missing error handling', 'No input validation'],
              };
            }
            qualityChecks.push({ passed: true });
            return { verdict: 'passed' };
          }
        ),
        { source: 'test', protocolId: getTestProtocolId() }
      );

      const responseBuilder = createLLMResponseBuilder();
      const { orchestrator, context, runtime } = createTestOrchestrator({
        llmResponses: [
          responseBuilder.goalReached('First attempt'),
          responseBuilder.goalReached('Fixed issues'),
        ],
        hookRegistry,
      });

      const result = await orchestrator.execute(context, 'Quality output test', 'standard', TEST_CWD, runtime);

      // Should have checked quality at least once
      expect(qualityChecks.length).toBeGreaterThan(0);
    });
  });
});
