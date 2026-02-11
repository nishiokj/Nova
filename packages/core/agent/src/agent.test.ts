/**
 * Minimal tests for Agent primitive.
 */

import { describe, it, expect } from 'bun:test';
import { Agent } from './agent.js';
import type { AgentConfig } from './types.js';
import { ContextWindow } from 'context';
import { createWorkItem } from 'work';
import type { LLMAdapter, LLMResponse } from 'llm';
import type { ToolRegistry } from 'tools';
import { successResult } from 'types';

function createMockLLM(response: LLMResponse): LLMAdapter {
  return {
    respond: async () => response,
    stream: async function* () {
      yield response.content;
      return response;
    },
  } as LLMAdapter;
}

function createMockToolRegistry(): ToolRegistry {
  return {
    getDefinitions: () => [],
    getWorkingDir: () => process.cwd(),
    isParallelSafe: () => false,
    execute: async (_name: string, _args: Record<string, unknown>, _options?: { cwd?: string }) => ({
      toolName: 'Read',
      status: 'error',
      output: '',
      error: 'Tool not available',
      durationMs: 0,
      isSuccess: false,
    }),
  } as unknown as ToolRegistry;
}

function createReadToolRegistry(output: string): ToolRegistry {
  return {
    getDefinitions: () => [],
    getWorkingDir: () => process.cwd(),
    isParallelSafe: () => false,
    execute: async (name: string, _args: Record<string, unknown>, _options?: { cwd?: string }) => {
      if (name.toLowerCase() !== 'read') {
        return {
          toolName: name,
          status: 'error',
          output: '',
          error: 'Tool not available',
          durationMs: 0,
          isSuccess: false,
        };
      }
      return successResult('Read', output, 1);
    },
  } as unknown as ToolRegistry;
}

describe('Agent', () => {
  it('returns response when structured output action is done', async () => {
    const llm = createMockLLM({
      content: JSON.stringify({
        action: 'done',
        response: 'done',
        goalStateReached: true,
        userPrompt: null,
      }),
      stopReason: 'end_turn',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: 'test-model',
      durationMs: 1,
    });

    const config: AgentConfig = {
      type: 'standard',
      systemPrompt: 'Test prompt',
      tools: [],
      budget: { maxIterations: 2, maxToolCalls: 0, maxDurationMs: 1000 },
      outputSchema: { name: 'agent_action_output', schema: { type: 'object' }, strict: true, schemaId: 'agent_action' },
    };

    const agent = new Agent(config, {
      llm,
      toolRegistry: createMockToolRegistry(),
      llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
    });
    const context = new ContextWindow('test-session', 200_000);
    const workItem = createWorkItem({ goal: 'test', objective: 'test' });

    const result = await agent.run({ globalContext: context, workItem, cwd: process.cwd() });

    expect(result.success).toBe(true);
    expect(result.response).toBe('done');
  });

  it('preserves watcher stop_work_item structured output', async () => {
    const llm = createMockLLM({
      content: JSON.stringify({
        action: 'done',
        response: 'Stopping work item for review',
        goalStateReached: true,
        awaitingUserInput: false,
        watcherAction: 'stop_work_item',
        reason: 'Insufficient evidence to justify completion',
        escalationId: 'esc_test_123',
      }),
      stopReason: 'end_turn',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: 'test-model',
      durationMs: 1,
    });

    const config: AgentConfig = {
      type: 'watcher',
      systemPrompt: 'Watcher test prompt',
      tools: [],
      budget: { maxIterations: 2, maxToolCalls: 0, maxDurationMs: 1000 },
      outputSchema: { name: 'watcher_action_output', schema: { type: 'object' }, strict: true, schemaId: 'watcher_action' },
    };

    const agent = new Agent(config, {
      llm,
      toolRegistry: createMockToolRegistry(),
      llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
    });
    const context = new ContextWindow('test-session', 200_000);
    const workItem = createWorkItem({ goal: 'test', objective: 'test' });

    const result = await agent.run({ globalContext: context, workItem, cwd: process.cwd() });
    expect(result.success).toBe(true);
    expect(result.structuredOutput?.watcherAction).toBe('stop_work_item');
    expect(result.structuredOutput?.escalationId).toBe('esc_test_123');
  });

  it('falls back to structured work_done when response is empty', async () => {
    const emitted: Array<{ type: string; data: Record<string, unknown> }> = [];
    const llm = createMockLLM({
      content: JSON.stringify({
        action: 'done',
        response: '',
        goalStateReached: true,
        handoffSpec: null,
        awaitingUserInput: false,
        work_done: 'Implemented the requested change.',
      }),
      stopReason: 'end_turn',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: 'test-model',
      durationMs: 1,
    });

    const config: AgentConfig = {
      type: 'standard',
      systemPrompt: 'Test prompt',
      tools: [],
      budget: { maxIterations: 2, maxToolCalls: 0, maxDurationMs: 1000 },
      outputSchema: { name: 'goal_driven_output', schema: { type: 'object' }, strict: true, schemaId: 'goal_driven' },
    };

    const agent = new Agent(config, {
      llm,
      toolRegistry: createMockToolRegistry(),
      emit: (event) => {
        emitted.push({ type: event.type, data: event.data as Record<string, unknown> });
      },
      llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
    });
    const context = new ContextWindow('test-session', 200_000);
    const workItem = createWorkItem({ goal: 'test', objective: 'test' });

    const result = await agent.run({ globalContext: context, workItem, cwd: process.cwd() });

    expect(result.success).toBe(true);
    expect(result.response).toBe('Implemented the requested change.');
    expect(
      emitted.some((event) =>
        event.type === 'agent_message'
        && typeof event.data.message === 'string'
        && event.data.message.includes('Implemented the requested change.')
      )
    ).toBe(true);
  });

  describe('Bounds Checking', () => {
    it('emits agent_bounds_hit event and terminates with max_tool_calls_exceeded', async () => {
      const events: Array<{ type: string; data: unknown }> = [];
      let callId = 0;

      const config: AgentConfig = {
        type: 'standard',
        systemPrompt: 'Test prompt',
        tools: ['Read'],
        budget: { maxIterations: 10, maxToolCalls: 5, maxDurationMs: 10000 },
        outputSchema: { name: 'goal_driven_output', schema: { type: 'object' }, strict: true, schemaId: 'goal_driven' },
      };

      let readCount = 0;
      const agent = new Agent(config, {
        llm: {
          respond: async () => ({
            content: '',
            toolCalls: [
              { id: `call_${++callId}`, name: 'Read', arguments: { path: 'file.txt' } },
            ],
            stopReason: 'tool_use',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: 'test-model',
            durationMs: 1,
          }),
          stream: async function* () {
            yield '';
            return {
              content: '',
              toolCalls: [
                { id: `call_${++callId}`, name: 'Read', arguments: { path: 'file.txt' } },
              ],
              stopReason: 'tool_use',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: 'test-model',
              durationMs: 1,
            };
          },
        } as LLMAdapter,
        toolRegistry: {
          getDefinitions: () => [],
          getWorkingDir: () => process.cwd(),
          isParallelSafe: () => false,
          execute: async (name: string) => {
            if (name.toLowerCase() !== 'read') {
              return {
                toolName: name,
                status: 'error',
                output: '',
                error: 'Tool not available',
                durationMs: 0,
                isSuccess: false,
              };
            }
            readCount++;
            // Distinct outputs avoid stagnation and let bounds logic surface.
            return successResult('Read', `file content ${readCount}`, 1);
          },
        } as unknown as ToolRegistry,
        emit: (event) => {
          events.push({ type: event.type, data: event.data });
        },
        llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
      });

      const context = new ContextWindow('test-session', 200_000);
      const workItem = createWorkItem({ goal: 'test', objective: 'test', bounds: { maxLlmCalls: 10, maxToolCalls: 3, maxDurationMs: 10000 } });

      const result = await agent.run({ globalContext: context, workItem, cwd: process.cwd() });

      expect(result.success).toBe(true); // Partial success due to captured content
      expect(result.isIncomplete).toBe(true);
      expect(result.terminationReason).toBe('max_tool_calls_exceeded');
      expect(result.metrics.toolCallsMade).toBe(3);

      // Verify agent_bounds_hit event was emitted
      const boundsHitEvents = events.filter(e => e.type === 'agent_bounds_hit');
      expect(boundsHitEvents.length).toBeGreaterThan(0);
      const toolCallsEvent = boundsHitEvents.find(e =>
        typeof e.data === 'object' &&
        e.data !== null &&
        (e.data as { boundType: string }).boundType === 'tool_calls'
      );
      expect(toolCallsEvent).toBeDefined();
      expect((toolCallsEvent!.data as { current: number; max: number }).current).toBe(3);
      expect((toolCallsEvent!.data as { current: number; max: number }).max).toBe(3);
    });

    it('emits agent_bounds_hit event and terminates with max_duration_exceeded', async () => {
      const events: Array<{ type: string; data: unknown }> = [];
      let callId = 0;

      const config: AgentConfig = {
        type: 'standard',
        systemPrompt: 'Test prompt',
        tools: ['Read'],
        budget: { maxIterations: 10, maxToolCalls: 100, maxDurationMs: 500 },
        outputSchema: { name: 'goal_driven_output', schema: { type: 'object' }, strict: true, schemaId: 'goal_driven' },
      };

      const agent = new Agent(config, {
        llm: {
          respond: async () => ({
            content: '',
            toolCalls: [
              { id: `call_${++callId}`, name: 'Read', arguments: { path: 'file.txt' } },
            ],
            stopReason: 'tool_use',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: 'test-model',
            durationMs: 1,
          }),
          stream: async function* () {
            // Simulate slow LLM responses to exceed duration bound
            await new Promise(resolve => setTimeout(resolve, 200));
            yield '';
            return {
              content: '',
              toolCalls: [
                { id: `call_${++callId}`, name: 'Read', arguments: { path: 'file.txt' } },
              ],
              stopReason: 'tool_use',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: 'test-model',
              durationMs: 1,
            };
          },
        } as LLMAdapter,
        toolRegistry: createReadToolRegistry('file content'),
        emit: (event) => {
          events.push({ type: event.type, data: event.data });
        },
        llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
      });

      const context = new ContextWindow('test-session', 200_000);
      const workItem = createWorkItem({ goal: 'test', objective: 'test', bounds: { maxLlmCalls: 10, maxToolCalls: 100, maxDurationMs: 300 } });

      const result = await agent.run({ globalContext: context, workItem, cwd: process.cwd() });

      expect(result.success).toBe(true); // Partial success due to content
      expect(result.isIncomplete).toBe(true);
      expect(result.terminationReason).toBe('max_duration_exceeded');
      expect(result.metrics.durationMs).toBeGreaterThanOrEqual(300);

      // Verify agent_bounds_hit event was emitted for duration
      const boundsHitEvents = events.filter(e => e.type === 'agent_bounds_hit');
      const durationEvent = boundsHitEvents.find(e =>
        typeof e.data === 'object' &&
        e.data !== null &&
        (e.data as { boundType: string }).boundType === 'duration'
      );
      expect(durationEvent).toBeDefined();
      expect((durationEvent!.data as { current: number }).current).toBeGreaterThanOrEqual(300);
      expect((durationEvent!.data as { max: number }).max).toBe(300);
    });

    it('terminates with max_tool_calls_exceeded when no content is captured', async () => {
      let callId = 0;

      const config: AgentConfig = {
        type: 'standard',
        systemPrompt: 'Test prompt',
        tools: ['Read'],
        budget: { maxIterations: 10, maxToolCalls: 3, maxDurationMs: 10000 },
        outputSchema: { name: 'goal_driven_output', schema: { type: 'object' }, strict: true, schemaId: 'goal_driven' },
      };

      const agent = new Agent(config, {
        llm: {
          respond: async () => ({
            content: '',
            toolCalls: [
              { id: `call_${++callId}`, name: 'Read', arguments: { path: 'file.txt' } },
            ],
            stopReason: 'tool_use',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: 'test-model',
            durationMs: 1,
          }),
          stream: async function* () {
            yield '';
            return {
              content: '',
              toolCalls: [
                { id: `call_${++callId}`, name: 'Read', arguments: { path: 'file.txt' } },
              ],
              stopReason: 'tool_use',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: 'test-model',
              durationMs: 1,
            };
          },
        } as LLMAdapter,
        toolRegistry: createReadToolRegistry(''),
        llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
      });

      const context = new ContextWindow('test-session', 200_000);
      const workItem = createWorkItem({ goal: 'test', objective: 'test', bounds: { maxLlmCalls: 10, maxToolCalls: 2, maxDurationMs: 10000 } });

      const result = await agent.run({ globalContext: context, workItem, cwd: process.cwd() });

      // On bounds termination, agent synthesizes a partial response from tool history.
      expect(result.success).toBe(true);
      expect(result.isIncomplete).toBe(true);
      expect(result.terminationReason).toBe('max_tool_calls_exceeded');
      expect(result.response).toContain('Exploration incomplete. Tools called:');
    });
  });

  describe('Stagnation Detection', () => {
    it('halts on repeated identical tool calls without progress', async () => {
      let callId = 0;
      const config: AgentConfig = {
        type: 'standard',
        systemPrompt: 'Test prompt',
        tools: ['Read'],
        budget: { maxIterations: 5, maxToolCalls: 10, maxDurationMs: 1000 },
        outputSchema: { name: 'goal_driven_output', schema: { type: 'object' }, strict: true, schemaId: 'goal_driven' },
      };

      const agent = new Agent(config, {
        llm: {
          respond: async () => ({
            content: '',
            toolCalls: [
              { id: `call_${++callId}`, name: 'Read', arguments: { path: 'README.md' } },
            ],
            stopReason: 'tool_use',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: 'test-model',
            durationMs: 1,
          }),
          stream: async function* () {
            yield '';
            return {
              content: '',
              toolCalls: [
                { id: `call_${++callId}`, name: 'Read', arguments: { path: 'README.md' } },
              ],
              stopReason: 'tool_use',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: 'test-model',
              durationMs: 1,
            };
          },
        } as LLMAdapter,
        toolRegistry: createReadToolRegistry('file contents'),
        llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
      });
      const context = new ContextWindow('test-session', 200_000);
      const workItem = createWorkItem({ goal: 'test', objective: 'test' });

      const result = await agent.run({ globalContext: context, workItem, cwd: process.cwd() });

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('stagnation');
      expect(result.error).toContain('Repeated identical tool call');
    });

    it('does not trigger stagnation when tool outputs differ', async () => {
      let callId = 0;
      let readCount = 0;

      const config: AgentConfig = {
        type: 'standard',
        systemPrompt: 'Test prompt',
        tools: ['Read'],
        budget: { maxIterations: 10, maxToolCalls: 10, maxDurationMs: 10000 },
        outputSchema: { name: 'goal_driven_output', schema: { type: 'object' }, strict: true, schemaId: 'goal_driven' },
      };

      const agent = new Agent(config, {
        llm: {
          respond: async () => ({
            content: '',
            toolCalls: [
              { id: `call_${++callId}`, name: 'Read', arguments: { path: 'file.txt' } },
            ],
            stopReason: 'tool_use',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: 'test-model',
            durationMs: 1,
          }),
          stream: async function* () {
            yield '';
            return {
              content: '',
              toolCalls: [
                { id: `call_${++callId}`, name: 'Read', arguments: { path: 'file.txt' } },
              ],
              stopReason: 'tool_use',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: 'test-model',
              durationMs: 1,
            };
          },
        } as LLMAdapter,
        toolRegistry: {
          getDefinitions: () => [],
          getWorkingDir: () => process.cwd(),
          isParallelSafe: () => false,
          execute: async (name: string, _args: Record<string, unknown>) => {
            if (name.toLowerCase() !== 'read') {
              return {
                toolName: name,
                status: 'error',
                output: '',
                error: 'Tool not available',
                durationMs: 0,
                isSuccess: false,
              };
            }
            // Return different output each time to prevent stagnation
            readCount++;
            return successResult('Read', `Content v${readCount}`, 1);
          },
        } as unknown as ToolRegistry,
        llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
      });

      const context = new ContextWindow('test-session', 200_000);
      const workItem = createWorkItem({ goal: 'test', objective: 'test', bounds: { maxLlmCalls: 5, maxToolCalls: 5, maxDurationMs: 10000 } });

      const result = await agent.run({ globalContext: context, workItem, cwd: process.cwd() });

      // Should not terminate with stagnation - different outputs should prevent it
      expect(result.terminationReason).not.toBe('stagnation');
    });

    it('does not trigger stagnation when tool arguments differ', async () => {
      let callId = 0;

      const config: AgentConfig = {
        type: 'standard',
        systemPrompt: 'Test prompt',
        tools: ['Read'],
        budget: { maxIterations: 10, maxToolCalls: 10, maxDurationMs: 10000 },
        outputSchema: { name: 'goal_driven_output', schema: { type: 'object' }, strict: true, schemaId: 'goal_driven' },
      };

      const agent = new Agent(config, {
        llm: {
          respond: async () => ({
            content: '',
            toolCalls: [
              { id: `call_${++callId}`, name: 'Read', arguments: { path: `file${callId}.txt` } },
            ],
            stopReason: 'tool_use',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: 'test-model',
            durationMs: 1,
          }),
          stream: async function* () {
            yield '';
            return {
              content: '',
              toolCalls: [
                { id: `call_${++callId}`, name: 'Read', arguments: { path: `file${callId}.txt` } },
              ],
              stopReason: 'tool_use',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: 'test-model',
              durationMs: 1,
            };
          },
        } as LLMAdapter,
        toolRegistry: createReadToolRegistry('same content'),
        llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
      });

      const context = new ContextWindow('test-session', 200_000);
      const workItem = createWorkItem({ goal: 'test', objective: 'test', bounds: { maxLlmCalls: 5, maxToolCalls: 5, maxDurationMs: 10000 } });

      const result = await agent.run({ globalContext: context, workItem, cwd: process.cwd() });

      // Should not terminate with stagnation - different arguments should prevent it
      expect(result.terminationReason).not.toBe('stagnation');
    });

    it('triggers stagnation on tool call with error (same error message)', async () => {
      let callId = 0;

      const config: AgentConfig = {
        type: 'standard',
        systemPrompt: 'Test prompt',
        tools: ['Write'],
        budget: { maxIterations: 10, maxToolCalls: 10, maxDurationMs: 10000 },
        outputSchema: { name: 'goal_driven_output', schema: { type: 'object' }, strict: true, schemaId: 'goal_driven' },
      };

      const agent = new Agent(config, {
        llm: {
          respond: async () => ({
            content: '',
            toolCalls: [
              { id: `call_${++callId}`, name: 'Write', arguments: { path: '/readonly/file.txt', content: 'test' } },
            ],
            stopReason: 'tool_use',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: 'test-model',
            durationMs: 1,
          }),
          stream: async function* () {
            yield '';
            return {
              content: '',
              toolCalls: [
                { id: `call_${++callId}`, name: 'Write', arguments: { path: '/readonly/file.txt', content: 'test' } },
              ],
              stopReason: 'tool_use',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: 'test-model',
              durationMs: 1,
            };
          },
        } as LLMAdapter,
        toolRegistry: {
          getDefinitions: () => [],
          getWorkingDir: () => process.cwd(),
          isParallelSafe: () => false,
          execute: async (name: string, _args: Record<string, unknown>) => {
            // Always return the same error
            return {
              toolName: name,
              status: 'error',
              output: '',
              error: 'Permission denied: readonly filesystem',
              durationMs: 0,
              isSuccess: false,
            };
          },
        } as unknown as ToolRegistry,
        llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
      });

      const context = new ContextWindow('test-session', 200_000);
      const workItem = createWorkItem({ goal: 'test', objective: 'test' });

      const result = await agent.run({ globalContext: context, workItem, cwd: process.cwd() });

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('stagnation');
      expect(result.error).toContain('Repeated identical tool call');
    });
  });

  describe('Edge Cases', () => {
    it('rejects done action when goalStateReached is false', async () => {
      const llm = createMockLLM({
        content: JSON.stringify({
          action: 'done',
          response: 'Finished',
          goalStateReached: false,
          awaitingUserInput: false,
          handoffSpec: null,
        }),
        stopReason: 'end_turn',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: 'test-model',
        durationMs: 1,
      });

      const agent = new Agent({
        type: 'standard',
        systemPrompt: 'Test prompt',
        tools: [],
        budget: { maxIterations: 2, maxToolCalls: 0, maxDurationMs: 1000 },
        outputSchema: { name: 'goal_driven_output', schema: { type: 'object' }, strict: true, schemaId: 'goal_driven' },
      }, {
        llm,
        toolRegistry: createMockToolRegistry(),
        llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
      });

      const result = await agent.run({
        globalContext: new ContextWindow('test-session', 200_000),
        workItem: createWorkItem({ goal: 'test', objective: 'test' }),
        cwd: process.cwd(),
      });

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('invalid_action');
      expect(result.error).toContain('goalStateReached');
    });

    it('does not infer user input when action is done and goalStateReached is true', async () => {
      const llm = createMockLLM({
        content: JSON.stringify({
          action: 'done',
          response: 'Should I proceed? No, already complete.',
          goalStateReached: true,
          awaitingUserInput: false,
          handoffSpec: null,
        }),
        stopReason: 'end_turn',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: 'test-model',
        durationMs: 1,
      });

      const agent = new Agent({
        type: 'standard',
        systemPrompt: 'Test prompt',
        tools: [],
        budget: { maxIterations: 2, maxToolCalls: 0, maxDurationMs: 1000 },
        outputSchema: { name: 'goal_driven_output', schema: { type: 'object' }, strict: true, schemaId: 'goal_driven' },
      }, {
        llm,
        toolRegistry: createMockToolRegistry(),
        llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
      });

      const result = await agent.run({
        globalContext: new ContextWindow('test-session', 200_000),
        workItem: createWorkItem({ goal: 'test', objective: 'test' }),
        cwd: process.cwd(),
      });

      expect(result.success).toBe(true);
      expect(result.needsUserInput).toBe(false);
      expect(result.terminationReason).toBe('goal_state_reached');
    });

    it('flags planning-speak as invalid even after done action', async () => {
      const llm = createMockLLM({
        content: JSON.stringify({
          action: 'done',
          response: "I'll analyze the codebase next and report back.",
          goalStateReached: true,
          awaitingUserInput: false,
          handoffSpec: null,
        }),
        stopReason: 'end_turn',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: 'test-model',
        durationMs: 1,
      });

      const agent = new Agent({
        type: 'standard',
        systemPrompt: 'Test prompt',
        tools: [],
        budget: { maxIterations: 2, maxToolCalls: 0, maxDurationMs: 1000 },
        outputSchema: { name: 'goal_driven_output', schema: { type: 'object' }, strict: true, schemaId: 'goal_driven' },
      }, {
        llm,
        toolRegistry: createMockToolRegistry(),
        llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
      });

      const result = await agent.run({
        globalContext: new ContextWindow('test-session', 200_000),
        workItem: createWorkItem({ goal: 'test', objective: 'test' }),
        cwd: process.cwd(),
      });

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('no_action');
      expect(result.error).toContain('planning text');
    });

    it('fails explorer agents that read files but produce zero artifacts', async () => {
      let streamCalls = 0;
      const agent = new Agent({
        type: 'explorer',
        systemPrompt: 'Explorer test prompt',
        tools: ['Read'],
        budget: { maxIterations: 3, maxToolCalls: 3, maxDurationMs: 1000 },
        outputSchema: { name: 'goal_driven_output', schema: { type: 'object' }, strict: true, schemaId: 'goal_driven' },
      }, {
        llm: {
          respond: async () => ({
            content: '',
            stopReason: 'end_turn',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: 'test-model',
            durationMs: 1,
          }),
          stream: async function* () {
            streamCalls++;
            yield '';
            if (streamCalls === 1) {
              return {
                content: '',
                toolCalls: [{ id: 'r1', name: 'Read', arguments: { path: 'README.md' } }],
                stopReason: 'tool_use',
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
                model: 'test-model',
                durationMs: 1,
              };
            }
            return {
              content: JSON.stringify({
                action: 'done',
                response: 'done',
                goalStateReached: true,
                awaitingUserInput: false,
                handoffSpec: null,
              }),
              stopReason: 'end_turn',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: 'test-model',
              durationMs: 1,
            };
          },
        } as LLMAdapter,
        toolRegistry: createReadToolRegistry('export const x = 1;'),
        llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
      });

      const result = await agent.run({
        globalContext: new ContextWindow('test-session', 200_000),
        workItem: createWorkItem({ goal: 'test', objective: 'find symbols' }),
        cwd: process.cwd(),
      });

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('invalid_action');
      expect(result.filesRead.length).toBeGreaterThan(0);
      expect(result.error).toContain('extracted 0 artifacts');
    });

    it('allows tool names case-insensitively and executes canonical tool', async () => {
      let streamCalls = 0;
      const executedNames: string[] = [];

      const config: AgentConfig = {
        type: 'standard',
        systemPrompt: 'Test prompt',
        tools: ['Read'],
        budget: { maxIterations: 3, maxToolCalls: 3, maxDurationMs: 10000 },
        outputSchema: { name: 'goal_driven_output', schema: { type: 'object' }, strict: true, schemaId: 'goal_driven' },
      };

      const agent = new Agent(config, {
        llm: {
          respond: async () => ({
            content: '',
            stopReason: 'end_turn',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: 'test-model',
            durationMs: 1,
          }),
          stream: async function* () {
            streamCalls++;
            yield '';
            if (streamCalls === 1) {
              return {
                content: '',
                toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'README.md' } }],
                stopReason: 'tool_use',
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
                model: 'test-model',
                durationMs: 1,
              };
            }
            return {
              content: JSON.stringify({
                action: 'done',
                response: 'done',
                goalStateReached: true,
                handoffSpec: null,
                awaitingUserInput: false,
              }),
              stopReason: 'end_turn',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: 'test-model',
              durationMs: 1,
            };
          },
        } as LLMAdapter,
        toolRegistry: {
          getDefinitions: () => [],
          getWorkingDir: () => process.cwd(),
          isParallelSafe: () => false,
          execute: async (name: string) => {
            executedNames.push(name);
            return successResult('Read', 'file-content', 1);
          },
        } as unknown as ToolRegistry,
        llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
      });

      const context = new ContextWindow('test-session', 200_000);
      const workItem = createWorkItem({ goal: 'test', objective: 'test' });
      const result = await agent.run({ globalContext: context, workItem, cwd: process.cwd() });

      expect(result.success).toBe(true);
      expect(result.terminationReason).toBe('goal_state_reached');
      expect(executedNames).toEqual(['Read']);
    });

    it('leniently infers action when structured output omits action', async () => {
      const llm = createMockLLM({
        content: JSON.stringify({
          response: 'I forgot action',
          goalStateReached: true,
          awaitingUserInput: false,
          handoffSpec: null,
        }),
        stopReason: 'end_turn',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: 'test-model',
        durationMs: 1,
      });

      const agent = new Agent({
        type: 'standard',
        systemPrompt: 'Test prompt',
        tools: [],
        budget: { maxIterations: 2, maxToolCalls: 0, maxDurationMs: 1000 },
        outputSchema: { name: 'goal_driven_output', schema: { type: 'object' }, strict: true, schemaId: 'goal_driven' },
      }, {
        llm,
        toolRegistry: createMockToolRegistry(),
        llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
      });

      const result = await agent.run({
        globalContext: new ContextWindow('test-session', 200_000),
        workItem: createWorkItem({ goal: 'test', objective: 'test' }),
        cwd: process.cwd(),
      });

      // Lenient parser infers action=done when goalStateReached=true.
      expect(result.success).toBe(true);
      expect(result.terminationReason).toBe('goal_state_reached');
      expect(result.response).toBe('I forgot action');
    });

    it('infers user_input_required from conversational question text', async () => {
      const llm = createMockLLM({
        content: 'I need one clarification before continuing. Which environment should I target?',
        stopReason: 'end_turn',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: 'test-model',
        durationMs: 1,
      });

      const agent = new Agent({
        type: 'standard',
        systemPrompt: 'Test prompt',
        tools: [],
        budget: { maxIterations: 2, maxToolCalls: 0, maxDurationMs: 1000 },
      }, {
        llm,
        toolRegistry: createMockToolRegistry(),
        llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
      });

      const result = await agent.run({
        globalContext: new ContextWindow('test-session', 200_000),
        workItem: createWorkItem({ goal: 'test', objective: 'test' }),
        cwd: process.cwd(),
      });

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('user_input_required');
      expect(result.needsUserInput).toBe(true);
      expect(result.userPrompt?.question).toContain('?');
    });

    it('marks refusal when done response matches refusal patterns', async () => {
      const llm = createMockLLM({
        content: JSON.stringify({
          action: 'done',
          response: 'This cannot be completed within the current budget.',
          goalStateReached: true,
          handoffSpec: null,
          awaitingUserInput: false,
        }),
        stopReason: 'end_turn',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: 'test-model',
        durationMs: 1,
      });

      const agent = new Agent({
        type: 'standard',
        systemPrompt: 'Test prompt',
        tools: [],
        budget: { maxIterations: 2, maxToolCalls: 0, maxDurationMs: 1000 },
        outputSchema: { name: 'goal_driven_output', schema: { type: 'object' }, strict: true, schemaId: 'goal_driven' },
      }, {
        llm,
        toolRegistry: createMockToolRegistry(),
        llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
      });

      const result = await agent.run({
        globalContext: new ContextWindow('test-session', 200_000),
        workItem: createWorkItem({ goal: 'test', objective: 'test' }),
        cwd: process.cwd(),
      });

      expect(result.success).toBe(false);
      expect(result.isRefusal).toBe(true);
      expect(result.terminationReason).toBe('refusal');
      expect(result.error).toContain('refused');
    });

    it('terminates immediately when maxToolCalls is zero', async () => {
      const llm = createMockLLM({
        content: 'should never be called',
        stopReason: 'end_turn',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: 'test-model',
        durationMs: 1,
      });

      const agent = new Agent({
        type: 'standard',
        systemPrompt: 'Test prompt',
        tools: [],
        budget: { maxIterations: 2, maxToolCalls: 5, maxDurationMs: 1000 },
      }, {
        llm,
        toolRegistry: createMockToolRegistry(),
        llmConfig: { model: 'test-model', provider: 'openai', apiKey: 'test-key' },
      });

      const result = await agent.run({
        globalContext: new ContextWindow('test-session', 200_000),
        workItem: createWorkItem({ goal: 'test', objective: 'test', bounds: { maxLlmCalls: 5, maxToolCalls: 0, maxDurationMs: 1000 } }),
        cwd: process.cwd(),
      });

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('max_tool_calls_exceeded');
      expect(result.metrics.llmCallsMade).toBe(0);
      expect(result.error).toContain('max_tool_calls_exceeded');
    });
  });
});
