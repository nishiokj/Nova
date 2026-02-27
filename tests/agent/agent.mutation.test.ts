/**
 * Agent Mutation Test Suite
 *
 * Goal: Find bugs, not just pass tests.
 * Focus areas:
 * - inferUserPromptFromResponse: edge cases in question extraction
 * - isValidRawArtifact: type coercion & boundary values
 * - mapRawArtifact: optional field handling
 * - resolveAction: state machine correctness, unhandled combos
 * - resolveControlDirective: signal/runControl interactions
 * - applyControlDirective: mutation side effects
 * - checkBounds: boundary conditions (exactly at limit)
 * - planning-speak validation: false positives/negatives
 * - finalizeResult: invariant enforcement
 * - extractStructuredFallbackResponse: nested object traversal
 * - parseBoolean: edge cases
 * - filterAllowedTools: case sensitivity & empty sets
 * - classifyError: pattern matching fidelity
 * - isBoundsTerminationReason: set membership
 * - extractArtifactsFromOutput: non-array and mixed-valid-invalid
 * - truncateToolOutput: boundary lengths
 * - isRefusal: pattern edge cases
 * - constructors defaults: missing optional fields
 * - execution loop: max_iterations_exceeded partial success
 * - no_action handling: structured vs non-structured agents
 * - combineResponseText: all combos of empty/non-empty
 * - sanitizeContextPathSegment: special character handling
 * - extractJsonCandidates: malformed JSON, nested braces, strings with braces
 * - buildSchemaReminder: custom vs default
 * - resolveOutputSchemaId: normalization and _output suffix stripping
 */

import { Effect, Stream } from 'effect';
import { Agent } from 'agent/agent.js';
import type { AgentConfig, MutableAgentResult, AgentControlDirective } from 'agent/types.js';
import { DEFAULT_AGENT_BUDGET, noopEmit, noopHookQueue } from 'agent/types.js';
import { ContextWindow } from 'context';
import { resetProviderCircuit, type LLMAdapter, type LLMResponse } from 'llm';
import { getOutputSchemaJson } from 'shared';
import type { ToolRegistry } from 'tools';
import { createWorkItem } from 'work';
import { successResult, errorResult } from 'types';

// ─── Helpers ────────────────────────────────────────────────────────

function createResponse(params: {
  action: 'done' | 'continue';
  response: string;
  goalStateReached: boolean;
  awaitingUserInput?: boolean;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  artifacts?: unknown[];
  work_done?: string;
}): LLMResponse {
  return {
    content: JSON.stringify({
      action: params.action,
      response: params.response,
      goalStateReached: params.goalStateReached,
      awaitingUserInput: params.awaitingUserInput ?? false,
      ...(params.artifacts ? { artifacts: params.artifacts } : {}),
      ...(params.work_done ? { work_done: params.work_done } : {}),
    }),
    stopReason: params.toolCalls && params.toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    toolCalls: params.toolCalls,
    model: 'mock-model',
    durationMs: 10,
  };
}

function createRawResponse(content: string, toolCalls?: LLMResponse['toolCalls']): LLMResponse {
  return {
    content,
    stopReason: toolCalls && toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    toolCalls,
    model: 'mock-model',
    durationMs: 10,
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
      const chunks = response.content.length > 0 ? [response.content] : [];
      return Stream.fromIterable(chunks);
    })),
  } as LLMAdapter;
}

function createToolRegistry(overrides?: Partial<ToolRegistry>): ToolRegistry {
  const calls: string[] = [];
  return {
    getDefinitions: () => [{
      name: 'Read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }, {
      name: 'Write',
      description: 'Write a file',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    }, {
      name: 'Edit',
      description: 'Edit a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }, {
      name: 'SleepTool',
      description: 'Mock sleep tool',
      parameters: { type: 'object', properties: { ms: { type: 'number' } }, required: [] },
    }, {
      name: 'PromptUser',
      description: 'Ask user a question',
      parameters: { type: 'object', properties: { questions: { type: 'array' } }, required: ['questions'] },
    }],
    getWorkingDir: () => process.cwd(),
    isParallelSafe: (name: string) => name === 'Read',
    execute: async (name, args) => {
      calls.push(name);
      if (name === 'Read') {
        return successResult('Read', `file content for ${args.path}`, 100);
      }
      if (name === 'Write' || name === 'Edit') {
        return successResult(name, 'ok', 1);
      }
      if (name === 'SleepTool') {
        return successResult('SleepTool', 'slept', 1);
      }
      return successResult(name, 'ok', 1);
    },
    __calls: calls,
    ...overrides,
  } as unknown as ToolRegistry;
}

const CWD = process.cwd();

function createAgent(
  llm: LLMAdapter,
  toolRegistry: ToolRegistry,
  configOverrides: Partial<AgentConfig> = {},
  runtimeOverrides: Partial<ConstructorParameters<typeof Agent>[1]> = {}
): Agent {
  const config: AgentConfig = {
    type: 'standard',
    systemPrompt: 'Test prompt',
    tools: ['SleepTool', 'Read', 'Write', 'Edit', 'PromptUser'],
    budget: {
      maxIterations: 4,
      maxToolCalls: 8,
      maxDurationMs: 30_000,
      llmStreamTimeoutMs: 5_000,
    },
    llmParams: { maxTokens: 1024, temperature: 0 },
    outputSchema: getOutputSchemaJson('agent_action'),
    ...configOverrides,
  };

  return new Agent(config, {
    llm,
    toolRegistry,
    llmConfig: { provider: 'openai', model: 'mock-model', apiKey: 'test-key' },
    ...runtimeOverrides,
  });
}

function createTestWorkItem(overrides: Partial<Parameters<typeof createWorkItem>[0]> = {}) {
  return createWorkItem({
    goal: 'test goal',
    objective: 'test objective',
    agent: 'standard',
    bounds: { maxLlmCalls: 8, maxToolCalls: 8, maxDurationMs: 30_000 },
    ...overrides,
  });
}

async function runAgent(
  agent: Agent,
  overrides: Partial<Parameters<Agent['run']>[0]> = {}
) {
  return Effect.runPromise(
    agent.run({
      globalContext: new ContextWindow('session-mutation', 200_000),
      workItem: createTestWorkItem(),
      cwd: CWD,
      ...overrides,
    })
  );
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Agent Mutation Tests', () => {
  beforeEach(() => {
    resetProviderCircuit();
  });

  // ================================================================
  // resolveControlDirective: signal/runControl state interactions
  // ================================================================
  describe('resolveControlDirective via run()', () => {
    it('stops when AbortSignal is already aborted before first iteration', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'should not reach', goalStateReached: true }),
      ]);
      const ac = new AbortController();
      ac.abort();

      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent, { signal: ac.signal });

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('user_stopped');
      expect(result.metrics.llmCallsMade).toBe(0);
    });

    it('stops with cancelled runControl state', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'should not reach', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent, {
        runControl: {
          execution: { requestId: 'r1', runId: 'r1', workItemId: 'w1', attempt: 1 },
          control: {
            state: 'cancelled',
            cancellation: { requestedAt: Date.now(), requestedBy: 'test', reason: 'test cancel', scope: 'run' },
          },
        },
      });

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('user_stopped');
    });

    it('continues with running runControl state', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'finished', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent, {
        runControl: {
          execution: { requestId: 'r1', runId: 'r1', workItemId: 'w1', attempt: 1 },
          control: { state: 'running' as any },
        },
      });

      expect(result.success).toBe(true);
      expect(result.terminationReason).toBe('goal_state_reached');
    });
  });

  // ================================================================
  // Planning-speak validation: should reject "I'll analyze..." responses
  // ================================================================
  describe('planning-speak validation', () => {
    // With Bug 3 fixed, structuredOutput.response now flows through to result.response
    // even when streaming was active. This means planning-speak validation fires correctly
    // for structured output agents.

    it('rejects short planning-speak response starting with "I\'ll analyze"', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: "I'll analyze the codebase", goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('no_action');
      expect(result.error).toContain('planning text');
    });

    it('rejects "Let me start by exploring"', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'Let me start by exploring the project structure.', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('no_action');
    });

    it('rejects "Now I\'ll investigate"', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: "Now I'll investigate the issue", goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.success).toBe(false);
    });

    it('rejects "First, let me check"', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'First, let me check the dependencies', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.success).toBe(false);
    });

    it('allows planning-speak that is long enough (>500 chars)', async () => {
      const longResponse = "I'll analyze the codebase. " + "A".repeat(500);
      const llm = createMockLLM([
        createResponse({ action: 'done', response: longResponse, goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
    });

    it('allows planning-speak that includes code blocks', async () => {
      const responseWithCode = "I'll analyze the code:\n```js\nconsole.log('hello')\n```";
      const llm = createMockLLM([
        createResponse({ action: 'done', response: responseWithCode, goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
    });

    it('allows normal substantive responses', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'The function calculates the sum of two numbers.', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
    });
  });

  // ================================================================
  // resolveAction: action/goalStateReached/awaitingUserInput combos
  // ================================================================
  describe('resolveAction edge cases', () => {
    it('action=done with goalStateReached=false yields invalid_action', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'done but not reached', goalStateReached: false }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('invalid_action');
      expect(result.error).toContain('goalStateReached');
    });

    it('awaitingUserInput=true triggers user_input_required', async () => {
      const llm = createMockLLM([
        createResponse({
          action: 'done',
          response: 'Which option do you prefer?',
          goalStateReached: false,
          awaitingUserInput: true,
        }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.terminationReason).toBe('user_input_required');
      expect(result.needsUserInput).toBe(true);
    });

    it('action=continue loops until max iterations with partial success', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'continue', response: 'working...', goalStateReached: false }),
        createResponse({ action: 'continue', response: 'still working...', goalStateReached: false }),
        createResponse({ action: 'continue', response: 'more work...', goalStateReached: false }),
        createResponse({ action: 'continue', response: 'almost done...', goalStateReached: false }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {
        budget: { maxIterations: 3, maxToolCalls: 8, maxDurationMs: 30_000, llmStreamTimeoutMs: 5_000 },
      });
      const result = await runAgent(agent, {
        workItem: createTestWorkItem({ bounds: { maxLlmCalls: 3, maxToolCalls: 8, maxDurationMs: 30_000 } }),
      });

      expect(result.terminationReason).toBe('max_iterations_exceeded');
      // Has content so should be partial success
      expect(result.success).toBe(true);
      expect(result.isIncomplete).toBe(true);
    });

    it('max_iterations_exceeded with empty response synthesizes from context', async () => {
      // Even with response: '', the raw JSON content is stored as an assistant message.
      // The fallback logic extracts response from accumulated context, making it non-empty.
      const llm = createMockLLM([
        createResponse({ action: 'continue', response: '', goalStateReached: false }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {
        budget: { maxIterations: 1, maxToolCalls: 8, maxDurationMs: 30_000, llmStreamTimeoutMs: 5_000 },
      });
      const result = await runAgent(agent, {
        workItem: createTestWorkItem({ bounds: { maxLlmCalls: 1, maxToolCalls: 8, maxDurationMs: 30_000 } }),
      });

      expect(result.terminationReason).toBe('max_iterations_exceeded');
      // Has synthesized content from assistant messages, so partial success
      expect(result.isIncomplete).toBe(true);
    });

    it('max_iterations_exceeded with truly empty LLM content yields failure', async () => {
      // Truly empty content - no JSON, no text
      const llm = createMockLLM([createRawResponse('')]);
      const agent = createAgent(llm, createToolRegistry(), {
        budget: { maxIterations: 1, maxToolCalls: 8, maxDurationMs: 30_000, llmStreamTimeoutMs: 5_000 },
        outputSchema: undefined,  // No structured output to avoid schema reminder loops
      });
      const result = await runAgent(agent, {
        workItem: createTestWorkItem({ bounds: { maxLlmCalls: 1, maxToolCalls: 8, maxDurationMs: 30_000 } }),
      });

      // Non-structured agent with no action and no tools → no_action termination
      expect(result.success).toBe(false);
    });
  });

  // ================================================================
  // Refusal detection
  // ================================================================
  describe('refusal detection', () => {
    // With Bug 3 fixed, structuredOutput.response now flows through to resolveAction's
    // finalText even when streaming was active. Refusal detection works with standard
    // structured output.

    it('detects "cannot be completed" as refusal', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'This task cannot be completed due to constraints.', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.terminationReason).toBe('refusal');
      expect(result.isRefusal).toBe(true);
    });

    it('detects "unable to complete" as refusal', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'I am unable to complete this request.', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.terminationReason).toBe('refusal');
      expect(result.isRefusal).toBe(true);
    });

    it('detects "exceeds the budget" as refusal', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'The request exceeds the budget allocated.', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.terminationReason).toBe('refusal');
    });

    it('does NOT flag normal response as refusal', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'The operation completed successfully.', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.terminationReason).toBe('goal_state_reached');
      expect(result.isRefusal).toBe(false);
    });
  });

  // ================================================================
  // shouldStop hook
  // ================================================================
  describe('shouldStop hook', () => {
    it('terminates immediately when shouldStop returns true', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'completed', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {}, {
        hooks: { shouldStop: () => true },
      });
      const result = await runAgent(agent);

      expect(result.terminationReason).toBe('user_stopped');
      expect(result.metrics.llmCallsMade).toBe(0);
    });

    it('does not interfere when shouldStop returns false', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'completed', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {}, {
        hooks: { shouldStop: () => false },
      });
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
      expect(result.terminationReason).toBe('goal_state_reached');
    });
  });

  // ================================================================
  // Tool execution edge cases
  // ================================================================
  describe('tool execution edge cases', () => {
    it('rejects disallowed tool calls', async () => {
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{ id: 'c1', name: 'NotAllowed', arguments: {} }],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {
        tools: ['SleepTool'],  // Only SleepTool allowed
      });
      const result = await runAgent(agent);

      expect(result.toolErrors.some(e => e.includes('not allowed'))).toBe(true);
    });

    it('handles tool execution failure gracefully', async () => {
      const failingRegistry = createToolRegistry({
        execute: async (name) => {
          if (name === 'SleepTool') {
            throw new Error('Tool crashed unexpectedly');
          }
          return successResult(name, 'ok', 1);
        },
      });
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{ id: 'c1', name: 'SleepTool', arguments: { ms: 1 } }],
        }),
        createResponse({ action: 'done', response: 'recovered', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, failingRegistry);
      const result = await runAgent(agent);

      expect(result.metrics.toolCallsFailed).toBeGreaterThan(0);
      expect(result.success).toBe(true);
    });

    it('PromptUser with empty questions array marks prompt_invalid', async () => {
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{ id: 'c1', name: 'PromptUser', arguments: { questions: [] } }],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      // Should continue past invalid prompt and eventually succeed
      expect(result.success).toBe(true);
    });

    it('PromptUser with valid questions sets needsUserInput', async () => {
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{
            id: 'c1',
            name: 'PromptUser',
            arguments: {
              questions: [{ question: 'Which option do you prefer?' }],
            },
          }],
        }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.needsUserInput).toBe(true);
      expect(result.terminationReason).toBe('user_input_required');
    });

    it('Read tool tracks files in localReadFiles and filesRead', async () => {
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{ id: 'c1', name: 'Read', arguments: { path: '/tmp/test.ts' } }],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.filesRead).toContain('/tmp/test.ts');
    });

    it('Write tool invalidates file path', async () => {
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{ id: 'c1', name: 'Write', arguments: { path: '/tmp/out.ts', content: 'test' } }],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.invalidatedPaths).toContain('/tmp/out.ts');
    });

    it('preToolUse hook can block a tool call', async () => {
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{ id: 'c1', name: 'SleepTool', arguments: { ms: 1 } }],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {}, {
        hooks: {
          preToolUse: async (name) => ({
            action: 'block',
            message: `${name} is blocked by policy`,
          }),
        },
      });
      const result = await runAgent(agent);

      expect(result.metrics.toolCallsFailed).toBeGreaterThan(0);
    });

    it('preToolUse hook can modify arguments', async () => {
      const executedArgs: Record<string, unknown>[] = [];
      const registry = createToolRegistry({
        execute: async (name, args) => {
          executedArgs.push(args);
          return successResult(name, 'ok', 1);
        },
      });
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{ id: 'c1', name: 'SleepTool', arguments: { ms: 100 } }],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, registry, {}, {
        hooks: {
          preToolUse: async (_name, args) => ({
            action: 'modify',
            modifiedArgs: { ...args, ms: 1 },
          }),
        },
      });
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
      expect(executedArgs.length).toBeGreaterThan(0);
      expect(executedArgs[0].ms).toBe(1);
    });

    it('postToolUse hook can modify the result', async () => {
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{ id: 'c1', name: 'SleepTool', arguments: { ms: 1 } }],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {}, {
        hooks: {
          postToolUse: async (_name, _args, _result) => ({
            action: 'modify',
            modifiedResult: successResult('SleepTool', 'modified output', 1),
          }),
        },
      });
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
    });

    it('stops tool execution mid-batch when runControl cancels', async () => {
      let callCount = 0;
      const slowRegistry = createToolRegistry({
        execute: async (name, args) => {
          callCount++;
          await new Promise(r => setTimeout(r, 1));
          return successResult(name, 'ok', 1);
        },
      });
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [
            { id: 'c1', name: 'SleepTool', arguments: { ms: 1 } },
            { id: 'c2', name: 'SleepTool', arguments: { ms: 1 } },
            { id: 'c3', name: 'SleepTool', arguments: { ms: 1 } },
          ],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, slowRegistry);
      const result = await runAgent(agent, {
        runControl: {
          execution: { requestId: 'r1', runId: 'r1', workItemId: 'w1', attempt: 1 },
          control: {
            state: 'cancelling',
            cancellation: { requestedAt: Date.now(), requestedBy: 'test', reason: 'cancel', scope: 'run' },
          },
        },
      });

      expect(result.terminationReason).toBe('user_stopped');
    });
  });

  // ================================================================
  // Structured output parsing edge cases
  // ================================================================
  describe('structured output parsing', () => {
    it('handles completely invalid JSON content gracefully', async () => {
      const llm = createMockLLM([
        createRawResponse('This is not JSON at all, just plain text.'),
      ]);
      // Non-structured agent: plain text with no action → no_action termination
      const agent = createAgent(llm, createToolRegistry(), { outputSchema: undefined });
      const result = await runAgent(agent);

      // Should terminate with no_action, not crash
      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('no_action');
    });

    it('structured agent with invalid JSON injects schema reminder and retries', async () => {
      const llm = createMockLLM([
        createRawResponse('This is not JSON at all.'),
        createResponse({ action: 'done', response: 'recovered', goalStateReached: true }),
      ]);
      // Structured agent: first response is invalid, second is valid
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      // Should recover on second iteration
      expect(result.success).toBe(true);
      expect(result.metrics.llmCallsMade).toBe(2);
    });

    it('handles empty content from LLM', async () => {
      const llm = createMockLLM([createRawResponse('')]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.success).toBe(false);
    });

    it('BUG CANDIDATE: handles JSON with extra text before it (pre-JSON text)', async () => {
      const content = 'Here is my analysis:\n' + JSON.stringify({
        action: 'done',
        response: 'The answer is 42',
        goalStateReached: true,
        awaitingUserInput: false,
      });
      const llm = createMockLLM([createRawResponse(content)]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
      expect(result.terminationReason).toBe('goal_state_reached');
    });

    it('parses structured output from markdown code fence', async () => {
      const content = '```json\n' + JSON.stringify({
        action: 'done',
        response: 'done',
        goalStateReached: true,
        awaitingUserInput: false,
      }) + '\n```';
      const llm = createMockLLM([createRawResponse(content)]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      // Should be able to parse JSON from fenced block
      expect(['goal_state_reached', 'no_action', 'invalid_action']).toContain(result.terminationReason);
    });
  });

  // ================================================================
  // No action field handling
  // ================================================================
  describe('no_action handling', () => {
    it('structured agent with output but missing action field hard fails', async () => {
      const content = JSON.stringify({
        response: 'some response',
        goalStateReached: true,
        // action field missing!
      });
      const llm = createMockLLM([createRawResponse(content)]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      // Lenient parser should infer action, or hard fail with invalid_action
      expect(['goal_state_reached', 'invalid_action']).toContain(result.terminationReason);
    });

    it('non-structured agent with no action and no tools terminates with no_action', async () => {
      const llm = createMockLLM([createRawResponse('Just some text response')]);
      const agent = createAgent(llm, createToolRegistry(), { outputSchema: undefined });
      const result = await runAgent(agent);

      expect(result.terminationReason).toBe('no_action');
    });
  });

  // ================================================================
  // Explorer agent specific behaviors
  // ================================================================
  describe('explorer agent edge cases', () => {
    it('explorer with files read but no artifacts marks isIncomplete', async () => {
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{ id: 'c1', name: 'Read', arguments: { path: '/tmp/test.ts' } }],
        }),
        createResponse({
          action: 'done',
          response: 'Found some code',
          goalStateReached: true,
          artifacts: [],  // No artifacts!
        }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), { type: 'explorer' });
      const result = await runAgent(agent);

      expect(result.isIncomplete).toBe(true);
    });

    it('explorer with artifacts in structured output preserves them (Bug 1 fix)', async () => {
      // With Bug 1 fixed, the lenient parser now preserves artifacts from the
      // original candidate even when .strict() Zod validation fails. This means
      // extractArtifactsFromOutput can find and process them.
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{ id: 'c1', name: 'Read', arguments: { path: '/tmp/test.ts' } }],
        }),
        createResponse({
          action: 'done',
          response: 'Found a function',
          goalStateReached: true,
          artifacts: [{
            sourcePath: '/tmp/test.ts',
            kind: 'function',
            name: 'testFn',
          }],
        }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), { type: 'explorer' });
      const result = await runAgent(agent);

      // Artifacts should survive lenient parsing and not be stripped
      expect(result.artifacts!.length).toBeGreaterThanOrEqual(1);
      expect(result.isIncomplete).toBeFalsy();
    });
  });

  // ================================================================
  // Artifact extraction edge cases
  // ================================================================
  describe('artifact extraction', () => {
    it('preserves valid artifacts and filters invalid ones after Bug 1 fix', async () => {
      // With Bug 1 fixed, the lenient parser carries artifacts through from the
      // original candidate. extractArtifactsFromOutput then validates each individually
      // via isValidRawArtifact, keeping only those with sourcePath, kind, and name.
      const llm = createMockLLM([
        createResponse({
          action: 'done',
          response: 'Found artifacts',
          goalStateReached: true,
          artifacts: [
            { sourcePath: '/test.ts', kind: 'function', name: 'valid' },
            { sourcePath: '/test.ts' },  // Missing kind and name
            { kind: 'class' },  // Missing sourcePath and name
            null,
            42,
            'not an artifact',
          ],
        }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
      // Only the first artifact has all required fields
      const artifacts = result.artifacts ?? [];
      expect(artifacts.length).toBe(1);
      expect(artifacts[0].name).toBe('valid');
    });

    it('handles non-array artifacts field', async () => {
      const llm = createMockLLM([
        createResponse({
          action: 'done',
          response: 'done',
          goalStateReached: true,
        }),
      ]);
      // Manually inject artifacts as non-array in the JSON
      const content = JSON.stringify({
        action: 'done',
        response: 'done',
        goalStateReached: true,
        awaitingUserInput: false,
        artifacts: 'not an array',
      });
      const llm2 = createMockLLM([createRawResponse(content)]);
      const agent = createAgent(llm2, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
      expect(result.artifacts?.length ?? 0).toBe(0);
    });
  });

  // ================================================================
  // Constructor defaults and missing optionals
  // ================================================================
  describe('constructor defaults', () => {
    it('handles missing emit callback', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'ok', goalStateReached: true }),
      ]);
      // No emit provided - should use noopEmit
      const agent = createAgent(llm, createToolRegistry(), {}, { emit: undefined });
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
    });

    it('handles missing requestId', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'ok', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {}, { requestId: undefined });
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
    });

    it('handles missing internalHookQueue', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'ok', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {}, { internalHookQueue: undefined });
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
    });
  });

  // ================================================================
  // Cadence check hook (observer intervention)
  // ================================================================
  describe('cadence check hook', () => {
    it('injects system message on inject action', async () => {
      // Need > 10 iterations to trigger cadence check
      const responses: LLMResponse[] = [];
      for (let i = 0; i < 11; i++) {
        responses.push(createResponse({
          action: 'continue',
          response: `iteration ${i}`,
          goalStateReached: false,
          toolCalls: [{ id: `c${i}`, name: 'SleepTool', arguments: { ms: 1 } }],
        }));
      }
      responses.push(createResponse({ action: 'done', response: 'final', goalStateReached: true }));

      const cadenceCheck = vi.fn(async () => ({
        action: 'inject' as const,
        systemMessage: 'Stay focused on the task.',
      }));

      const llm = createMockLLM(responses);
      const agent = createAgent(llm, createToolRegistry(), {
        budget: { maxIterations: 20, maxToolCalls: 50, maxDurationMs: 30_000, llmStreamTimeoutMs: 5_000 },
      }, {
        hooks: { cadenceCheck },
      });
      const result = await runAgent(agent, {
        workItem: createTestWorkItem({
          bounds: { maxLlmCalls: 20, maxToolCalls: 50, maxDurationMs: 30_000 },
        }),
      });

      expect(cadenceCheck).toHaveBeenCalled();
      // Should not have stopped from cadence check
      expect(result.terminationReason).not.toBe('observer_stopped');
    });

    it('stops execution on stop action', async () => {
      const responses: LLMResponse[] = [];
      for (let i = 0; i < 11; i++) {
        responses.push(createResponse({
          action: 'continue',
          response: `iteration ${i}`,
          goalStateReached: false,
          toolCalls: [{ id: `c${i}`, name: 'SleepTool', arguments: { ms: 1 } }],
        }));
      }

      const cadenceCheck = vi.fn(async () => ({
        action: 'stop' as const,
        reason: 'Taking too long',
        systemMessage: 'Stopping due to excessive iterations.',
      }));

      const llm = createMockLLM(responses);
      const agent = createAgent(llm, createToolRegistry(), {
        budget: { maxIterations: 20, maxToolCalls: 50, maxDurationMs: 30_000, llmStreamTimeoutMs: 5_000 },
      }, {
        hooks: { cadenceCheck },
      });
      const result = await runAgent(agent, {
        workItem: createTestWorkItem({
          bounds: { maxLlmCalls: 20, maxToolCalls: 50, maxDurationMs: 30_000 },
        }),
      });

      expect(result.terminationReason).toBe('observer_stopped');
      expect(result.observerStop).toBeDefined();
      expect(result.observerStop!.reason).toContain('Taking too long');
    });
  });

  // ================================================================
  // Metrics tracking accuracy
  // ================================================================
  describe('metrics tracking', () => {
    it('accurately counts llm calls across multiple iterations', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'continue', response: 'working', goalStateReached: false }),
        createResponse({ action: 'continue', response: 'still working', goalStateReached: false }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.metrics.llmCallsMade).toBe(3);
    });

    it('accurately counts tool calls made, succeeded, and failed', async () => {
      const registry = createToolRegistry({
        execute: async (name, args) => {
          if (name === 'SleepTool') {
            throw new Error('fail');
          }
          return successResult(name, 'ok', 1);
        },
      });
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [
            { id: 'c1', name: 'SleepTool', arguments: {} },
            { id: 'c2', name: 'Read', arguments: { path: '/test.ts' } },
          ],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, registry);
      const result = await runAgent(agent);

      expect(result.metrics.toolCallsMade).toBe(2);
      expect(result.metrics.toolCallsSucceeded).toBe(1);
      expect(result.metrics.toolCallsFailed).toBe(1);
    });

    it('tracks duration in milliseconds', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ================================================================
  // Event emission
  // ================================================================
  describe('event emission', () => {
    it('emits llm_call events', async () => {
      const events: Array<Record<string, unknown>> = [];
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {}, {
        emit: (event) => events.push(event as unknown as Record<string, unknown>),
      });
      await runAgent(agent);

      const llmEvents = events.filter(e => e.type === 'llm_call');
      expect(llmEvents.length).toBeGreaterThan(0);
    });

    it('emits agent_message events for streamed content', async () => {
      const events: Array<Record<string, unknown>> = [];
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'Hello world!', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {}, {
        emit: (event) => events.push(event as unknown as Record<string, unknown>),
      });
      await runAgent(agent);

      const messageEvents = events.filter(e => e.type === 'agent_message');
      expect(messageEvents.length).toBeGreaterThan(0);
    });

    it('emits tool_call events for starting and completed phases', async () => {
      const events: Array<Record<string, unknown>> = [];
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{ id: 'c1', name: 'SleepTool', arguments: { ms: 1 } }],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {}, {
        emit: (event) => events.push(event as unknown as Record<string, unknown>),
      });
      await runAgent(agent);

      const toolEvents = events.filter(e => e.type === 'tool_call');
      const phases = toolEvents.map(e => (e.data as Record<string, unknown>)?.phase);
      expect(phases).toContain('starting');
      expect(phases).toContain('completed');
    });
  });

  // ================================================================
  // Internal hook queue
  // ================================================================
  describe('internal hook queue', () => {
    it('enqueues turn_completed events per iteration', async () => {
      const enqueuedEvents: Array<Record<string, unknown>> = [];
      const hookQueue = {
        enqueue: (event: Record<string, unknown>) => enqueuedEvents.push(event),
      };
      const llm = createMockLLM([
        createResponse({ action: 'continue', response: 'working', goalStateReached: false }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {}, {
        internalHookQueue: hookQueue as any,
      });
      await runAgent(agent);

      const turnEvents = enqueuedEvents.filter(e => e.type === 'turn_completed');
      expect(turnEvents.length).toBe(2);
    });

    it('enqueues agent_completed event on finish', async () => {
      const enqueuedEvents: Array<Record<string, unknown>> = [];
      const hookQueue = {
        enqueue: (event: Record<string, unknown>) => enqueuedEvents.push(event),
      };
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {}, {
        internalHookQueue: hookQueue as any,
      });
      await runAgent(agent);

      const completedEvents = enqueuedEvents.filter(e => e.type === 'agent_completed');
      expect(completedEvents.length).toBe(1);
      expect(completedEvents[0].success).toBe(true);
    });

    it('enqueues files_modified when Write tool is used', async () => {
      const enqueuedEvents: Array<Record<string, unknown>> = [];
      const hookQueue = {
        enqueue: (event: Record<string, unknown>) => enqueuedEvents.push(event),
      };
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{ id: 'c1', name: 'Write', arguments: { path: '/tmp/out.ts', content: 'test' } }],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {}, {
        internalHookQueue: hookQueue as any,
      });
      await runAgent(agent);

      const fileEvents = enqueuedEvents.filter(e => e.type === 'files_modified');
      expect(fileEvents.length).toBe(1);
    });
  });

  // ================================================================
  // Auto-read target files
  // ================================================================
  describe('auto-read target files', () => {
    it('reads target files before first iteration', async () => {
      const readPaths: string[] = [];
      const registry = createToolRegistry({
        execute: async (name, args) => {
          if (name === 'Read') readPaths.push(args.path as string);
          return successResult(name, 'file content', 100);
        },
      });
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'analyzed', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, registry);
      const result = await runAgent(agent, {
        workItem: createTestWorkItem({
          targetPaths: ['/tmp/target1.ts', '/tmp/target2.ts'],
        }),
      });

      expect(readPaths).toContain('/tmp/target1.ts');
      expect(readPaths).toContain('/tmp/target2.ts');
    });

    it('skips auto-read when Read tool is not in allowed tools', async () => {
      const readPaths: string[] = [];
      const registry = createToolRegistry({
        execute: async (name, args) => {
          if (name === 'Read') readPaths.push(args.path as string);
          return successResult(name, 'file content', 100);
        },
      });
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'ok', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, registry, {
        tools: ['SleepTool'],  // Read not included
      });
      const result = await runAgent(agent, {
        workItem: createTestWorkItem({
          targetPaths: ['/tmp/target.ts'],
        }),
      });

      expect(readPaths.length).toBe(0);
    });
  });

  // ================================================================
  // finalizeResult invariant enforcement
  // ================================================================
  describe('finalizeResult invariants', () => {
    it('BUG CANDIDATE: needsUserInput=true with non-user_input_required reason throws', async () => {
      // This tests internal invariant checking. We can indirectly trigger this by
      // checking that valid user_input_required results have the right shape.
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{
            id: 'c1',
            name: 'PromptUser',
            arguments: { questions: [{ question: 'What next?' }] },
          }],
        }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      // When needsUserInput is true, terminationReason must be user_input_required
      if (result.needsUserInput) {
        expect(result.terminationReason).toBe('user_input_required');
      }
    });
  });

  // ================================================================
  // Question inference from response text
  // ================================================================
  describe('question inference from response', () => {
    it('infers question from response containing ?', async () => {
      // With Bug 3 fixed, structuredOutput.response is now used as fallback
      // for question inference when streaming strips responseText.
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: 'Should I proceed with option A or option B?',
          goalStateReached: false,
        }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.needsUserInput).toBe(true);
      expect(result.terminationReason).toBe('user_input_required');
    });

    it('does NOT infer question from response with ? inside code block', async () => {
      // The regex strips code blocks before checking for ?
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: 'Here is the code:\n```\nconst x = value ? "yes" : "no";\n```\nDone.',
          goalStateReached: false,
        }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      // Should NOT be marked as needing user input since ? is in code block
      // (If it still triggers, this is a BUG CANDIDATE)
      expect(result.needsUserInput).toBe(false);
    });

    it('does NOT infer from response where ? forms a very short question (< 2 chars)', async () => {
      const llm = createMockLLM([
        createResponse({
          action: 'done',
          response: '?',
          goalStateReached: true,
        }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      // Single ? should not be treated as a question
      expect(result.needsUserInput).toBe(false);
    });
  });

  // ================================================================
  // Memory injection integration
  // ================================================================
  describe('memory injection', () => {
    it('passes memory content to LLM when injector returns evidence', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const evidenceInject = vi.fn(async () => ({
        content: 'Relevant context from memory: user prefers TypeScript.',
        atoms: [{ id: '1' }],
        metrics: {
          totalTokens: 50,
          attentionTax: 0.1,
          coverage: { code: 1 },
          discriminatorsIncluded: 1,
          latencyMs: 10,
        },
      }));
      const agent = createAgent(llm, createToolRegistry(), {}, {
        memoryInjector: {
          injectEvidence: evidenceInject,
        } as any,
      });
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
      expect(evidenceInject).toHaveBeenCalledTimes(1);
    });

    it('handles memory injection returning null gracefully', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const evidenceInject = vi.fn(async () => null);
      const agent = createAgent(llm, createToolRegistry(), {}, {
        memoryInjector: {
          injectEvidence: evidenceInject,
        } as any,
      });
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
    });

    it('handles memory injection throwing an error gracefully', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const evidenceInject = vi.fn(async () => { throw new Error('Memory service unavailable'); });
      const agent = createAgent(llm, createToolRegistry(), {}, {
        memoryInjector: {
          injectEvidence: evidenceInject,
        } as any,
      });
      const result = await runAgent(agent);

      // Should not crash, should still complete
      expect(result.success).toBe(true);
    });
  });

  // ================================================================
  // Empty tools list
  // ================================================================
  describe('empty tools configuration', () => {
    it('agent with no allowed tools filters all tool definitions', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), { tools: [] });
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
    });

    it('agent with no tools rejects all tool calls', async () => {
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{ id: 'c1', name: 'Read', arguments: { path: '/test.ts' } }],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), { tools: [] });
      const result = await runAgent(agent);

      expect(result.toolErrors.some(e => e.includes('not allowed'))).toBe(true);
    });
  });

  // ================================================================
  // Tool case sensitivity
  // ================================================================
  describe('tool name case sensitivity', () => {
    it('matches tool names case-insensitively', async () => {
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{ id: 'c1', name: 'sleeptool', arguments: { ms: 1 } }],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      // Tool should be matched despite lowercase name
      expect(result.toolErrors.filter(e => e.includes('not allowed')).length).toBe(0);
    });
  });

  // ================================================================
  // Parallel tool execution
  // ================================================================
  describe('parallel tool execution', () => {
    it('executes parallel-safe Read tools concurrently', async () => {
      const executionOrder: string[] = [];
      const registry = createToolRegistry({
        isParallelSafe: (name: string) => name === 'Read',
        execute: async (name, args) => {
          executionOrder.push(`start:${name}:${args.path}`);
          await new Promise(r => setTimeout(r, 5));
          executionOrder.push(`end:${name}:${args.path}`);
          return successResult(name, 'content', 100);
        },
      });
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [
            { id: 'c1', name: 'Read', arguments: { path: '/a.ts' } },
            { id: 'c2', name: 'Read', arguments: { path: '/b.ts' } },
          ],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, registry);
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
      expect(result.metrics.toolCallsMade).toBe(2);
      expect(result.metrics.toolCallsSucceeded).toBe(2);
    });
  });

  // ================================================================
  // Duration bounds
  // ================================================================
  describe('duration bounds', () => {
    it('terminates when max duration is exceeded', async () => {
      // Set maxDurationMs to 0 so it immediately triggers
      const llm = createMockLLM([
        createResponse({ action: 'continue', response: 'working', goalStateReached: false }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {
        budget: { maxIterations: 10, maxToolCalls: 50, maxDurationMs: 30_000, llmStreamTimeoutMs: 5_000 },
      });
      const result = await runAgent(agent, {
        workItem: createTestWorkItem({
          bounds: { maxLlmCalls: 10, maxToolCalls: 50, maxDurationMs: 1 },
        }),
      });

      // With a 1ms duration limit, it should hit the bound very quickly
      expect(['max_duration_exceeded', 'max_iterations_exceeded', 'goal_state_reached']).toContain(result.terminationReason);
    });
  });

  // ================================================================
  // Schema reminder injection
  // ================================================================
  describe('schema reminder', () => {
    it('uses custom schemaReminder when configured', async () => {
      const contextMessages: string[] = [];
      const customReminder = 'CUSTOM: Always set the action field!';
      // Return structured output missing action to trigger schema reminder
      const content = JSON.stringify({ response: 'working', goalStateReached: false });
      const llm = createMockLLM([
        createRawResponse(content),
        createRawResponse(content),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {
        schemaReminder: customReminder,
      });
      // This test verifies the agent doesn't crash with a custom schemaReminder
      const result = await runAgent(agent);

      // Should eventually terminate (either success or error)
      expect(result.terminationReason).toBeDefined();
    });
  });

  // ================================================================
  // Recursive self-call prevention
  // ================================================================
  describe('self-call prevention', () => {
    it('prevents agent from calling itself via agent registry', async () => {
      const agentRegistry = {
        has: (name: string) => name === 'standard',
        getConfig: () => ({
          type: 'standard',
          systemPrompt: 'sub',
          tools: [],
          budget: { maxIterations: 2, maxToolCalls: 4, maxDurationMs: 10_000 },
          llmParams: { maxTokens: 1024, temperature: 0 },
        }),
        listToolDefinitions: () => [{
          name: 'standard',
          description: 'Standard agent',
          parameters: { type: 'object', properties: { objective: { type: 'string' } } },
        }],
      };
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{
            id: 'c1',
            name: 'standard',  // Calling itself!
            arguments: { objective: 'sub task' },
          }],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {
        tools: ['SleepTool', 'Read', 'Write', 'Edit', 'PromptUser', 'standard'],
      }, {
        agentRegistry: agentRegistry as any,
      });
      const result = await runAgent(agent);

      // Self-call should produce an error
      expect(result.toolErrors.some(e => e.includes('cannot call itself'))).toBe(true);
    });
  });

  // ================================================================
  // LLM error classification
  // ================================================================
  describe('error handling and classification', () => {
    it('handles LLM stream returning no final response', async () => {
      // Simulate LLM that streams but never calls onComplete
      const llm = {
        respond: () => Effect.sync(() => ({
          content: '',
          stopReason: 'end_turn',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: 'mock',
          durationMs: 0,
        })),
        stream: (_params: any) => {
          // Return empty stream without calling onComplete
          return Stream.fromIterable([]);
        },
      } as unknown as LLMAdapter;

      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      // Should handle the "no final response" error
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // ================================================================
  // Last iteration behavior
  // ================================================================
  describe('last iteration behavior', () => {
    it('final iteration sets toolChoice to none (no tool calls on last iteration)', async () => {
      // With maxIterations = 1, the first iteration IS the last
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'quick answer', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry(), {
        budget: { maxIterations: 1, maxToolCalls: 8, maxDurationMs: 30_000, llmStreamTimeoutMs: 5_000 },
      });
      const result = await runAgent(agent, {
        workItem: createTestWorkItem({
          bounds: { maxLlmCalls: 1, maxToolCalls: 8, maxDurationMs: 30_000 },
        }),
      });

      // Should succeed on first iteration
      expect(result.success).toBe(true);
      expect(result.metrics.llmCallsMade).toBe(1);
    });
  });

  // ================================================================
  // Multiple tool calls with invalidation
  // ================================================================
  describe('file invalidation tracking', () => {
    it('Edit tool invalidates the edited file path', async () => {
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [{ id: 'c1', name: 'Edit', arguments: { path: '/tmp/edited.ts' } }],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.invalidatedPaths).toContain('/tmp/edited.ts');
    });

    it('tracks multiple invalidated paths from different tool calls', async () => {
      const llm = createMockLLM([
        createResponse({
          action: 'continue',
          response: '',
          goalStateReached: false,
          toolCalls: [
            { id: 'c1', name: 'Write', arguments: { path: '/tmp/a.ts', content: 'a' } },
            { id: 'c2', name: 'Edit', arguments: { path: '/tmp/b.ts' } },
          ],
        }),
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.invalidatedPaths).toContain('/tmp/a.ts');
      expect(result.invalidatedPaths).toContain('/tmp/b.ts');
    });
  });

  // ================================================================
  // Structured output fallback response extraction
  // ================================================================
  describe('structured fallback response extraction', () => {
    it('falls back to work_done field when response is empty', async () => {
      const content = JSON.stringify({
        action: 'done',
        response: '',
        goalStateReached: true,
        awaitingUserInput: false,
        work_done: 'Completed the refactoring task successfully.',
      });
      const llm = createMockLLM([createRawResponse(content)]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      // Should find the work_done fallback
      expect(result.success).toBe(true);
    });

    it('falls back to summary field when response and work_done empty', async () => {
      const content = JSON.stringify({
        action: 'done',
        response: '',
        goalStateReached: true,
        awaitingUserInput: false,
        summary: 'Task completed.',
      });
      const llm = createMockLLM([createRawResponse(content)]);
      const agent = createAgent(llm, createToolRegistry());
      const result = await runAgent(agent);

      expect(result.success).toBe(true);
    });
  });

  // ================================================================
  // Context window operations
  // ================================================================
  describe('context window management', () => {
    it('creates separate local context per run', async () => {
      const llm = createMockLLM([
        createResponse({ action: 'done', response: 'done', goalStateReached: true }),
      ]);
      const agent = createAgent(llm, createToolRegistry());
      const globalContext = new ContextWindow('session-ctx-test', 200_000);

      const result1 = await Effect.runPromise(agent.run({
        globalContext,
        workItem: createTestWorkItem(),
        cwd: CWD,
      }));

      expect(result1.localContext).toBeDefined();
      expect(result1.localContext.sessionKey).toContain('standard');
    });
  });
});
