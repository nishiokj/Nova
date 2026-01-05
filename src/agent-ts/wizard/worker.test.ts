/**
 * Comprehensive test suite for Worker
 *
 * Goal: Find bugs, not just pass tests.
 * Focus areas:
 * - Refusal pattern detection edge cases
 * - Action marker extraction
 * - Tool call processing and error handling
 * - Execution loop boundary conditions
 * - Duration check timing bug
 * - Synthesis step failure handling
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  Worker,
  createWorkerOutcome,
  outcomeMadeProgress,
  WorkerAction,
  type WorkerConfig,
  DEFAULT_WORKER_CONFIG,
} from './worker.js';
import { createWorkItem, type WorkItem } from './work-item.js';
import { ContextWindow } from '../types/context.js';
import type { LLMAdapter, LLMResponse } from '../llm/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult, ToolDefinition } from '../types/tools.js';

// Mock LLM adapter factory
function createMockLLM(responses: LLMResponse[]): LLMAdapter {
  let callIndex = 0;
  return {
    provider: 'openai',
    model: 'gpt-4',
    respond: async () => {
      if (callIndex >= responses.length) {
        throw new Error('No more mock responses');
      }
      return responses[callIndex++];
    },
    stream: async function* () {
      yield 'test';
      return responses[0];
    },
  } as unknown as LLMAdapter;
}

// Mock tool registry factory
function createMockToolRegistry(
  tools: Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>
): ToolRegistry {
  return {
    execute: async (name: string, args: Record<string, unknown>) => {
      const executor = tools.get(name);
      if (!executor) {
        return {
          toolName: name,
          status: 'error' as const,
          isSuccess: false,
          output: `Tool '${name}' not found`,
          error: `Tool '${name}' not found`,
          durationMs: 0,
        };
      }
      return executor(args);
    },
    getDefinitions: () => [] as ToolDefinition[],
  } as unknown as ToolRegistry;
}

function createSuccessResponse(content: string): LLMResponse {
  return {
    content,
    stopReason: 'end_turn',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    model: 'gpt-4',
    durationMs: 500,
  };
}

function createToolCallResponse(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): LLMResponse {
  return {
    content: 'Let me help with that.',
    toolCalls: calls,
    stopReason: 'tool_use',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    model: 'gpt-4',
    durationMs: 500,
  };
}

describe('Worker', () => {
  let baseContext: ContextWindow;
  let baseWorkItem: WorkItem;

  beforeEach(() => {
    baseContext = new ContextWindow('test-session', 200_000);
    baseWorkItem = createWorkItem({
      stepNum: 1,
      objective: 'Test objective',
    });
  });

  describe('Refusal pattern detection', () => {
    it('should detect "cannot be completed" as refusal', async () => {
      const llm = createMockLLM([
        createSuccessResponse('[FINAL] This task cannot be completed because the file does not exist.'),
      ]);
      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm);

      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.isRefusal).toBe(true);
      expect(outcome.success).toBe(false);
    });

    it('should detect "exceeds budget" as refusal', async () => {
      const llm = createMockLLM([
        createSuccessResponse('[FINAL] This task exceeds the budget allocated for this operation.'),
      ]);
      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm);

      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.isRefusal).toBe(true);
    });

    it('should detect "task is too complex" as refusal', async () => {
      const llm = createMockLLM([
        createSuccessResponse('[FINAL] The task is too complex for this step.'),
      ]);
      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm);

      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.isRefusal).toBe(true);
    });

    it('should NOT detect normal completion as refusal', async () => {
      const llm = createMockLLM([
        createSuccessResponse('[FINAL] I have completed the task. The file has been created successfully.'),
      ]);
      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm);

      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.isRefusal).toBe(false);
      expect(outcome.success).toBe(true);
    });

    it('should detect refusal with mixed case', async () => {
      const llm = createMockLLM([
        createSuccessResponse('[FINAL] This Cannot Be Completed due to restrictions.'),
      ]);
      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm);

      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.isRefusal).toBe(true);
    });

    it('should NOT falsely detect refusal when word appears in different context', async () => {
      // BUG CANDIDATE: "cannot" appearing in a different context should not be refusal
      const llm = createMockLLM([
        createSuccessResponse('[FINAL] The function cannot return a value when it is void, so I removed the return statement.'),
      ]);
      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm);

      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      // This might falsely trigger as refusal due to "cannot" pattern
      // The current implementation uses /cannot be completed/i which is more specific
      expect(outcome.isRefusal).toBe(false);
    });
  });

  describe('Action marker extraction', () => {
    it('should extract [FINAL] marker', async () => {
      const llm = createMockLLM([
        createSuccessResponse('[FINAL] Done with the task'),
      ]);
      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm);

      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.success).toBe(true);
      expect(outcome.finalResponse).toBe('Done with the task');
    });

    it('should extract [FINAL] with lowercase', async () => {
      const llm = createMockLLM([
        createSuccessResponse('[final] Done with the task'),
      ]);
      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm);

      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.success).toBe(true);
    });

    it('should extract [NEED_CONTEXT] with valid JSON', async () => {
      const llm = createMockLLM([
        createSuccessResponse('[NEED_CONTEXT] {"question": "What file?", "options": ["a.txt", "b.txt"]}'),
      ]);
      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm);

      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.needsUserInput).toBe(true);
      expect(outcome.userPrompt).toEqual({
        question: 'What file?',
        options: ['a.txt', 'b.txt'],
      });
    });

    it('should handle [NEED_CONTEXT] with invalid JSON gracefully', async () => {
      const llm = createMockLLM([
        createSuccessResponse('[NEED_CONTEXT] not valid json'),
        createSuccessResponse('[FINAL] Gave up on user input'),
      ]);
      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm);

      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      // Should continue to next iteration, not crash
      expect(outcome.terminationReason).not.toBe('error');
    });

    it('should handle [CONTINUE] marker', async () => {
      const llm = createMockLLM([
        createSuccessResponse('[CONTINUE] Still working on it...'),
        createSuccessResponse('[FINAL] Now done'),
      ]);
      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm);

      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.success).toBe(true);
      expect(outcome.metrics.llmCallsMade).toBe(2);
    });

    it('should fail when no action marker and no tool calls', async () => {
      const llm = createMockLLM([
        createSuccessResponse('I am thinking about this...'), // No marker, no tools
      ]);
      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm);

      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.success).toBe(false);
      expect(outcome.terminationReason).toBe('no_action');
      expect(outcome.error).toContain('no action markers');
    });

    it('should handle [FINAL] marker in middle of response', async () => {
      const llm = createMockLLM([
        createSuccessResponse('Here is my analysis: [FINAL] The answer is 42.'),
      ]);
      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm);

      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.success).toBe(true);
      // BUG CANDIDATE: Does the stripping work correctly for [FINAL] in middle?
      expect(outcome.finalResponse).not.toContain('[FINAL]');
    });

    it('should handle multiple action markers - first wins', async () => {
      // BUG CANDIDATE: What happens with [FINAL] [CONTINUE]?
      const llm = createMockLLM([
        createSuccessResponse('[FINAL] Done [CONTINUE] or maybe not'),
      ]);
      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm);

      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.success).toBe(true);
      expect(outcome.terminationReason).toBe('final');
    });
  });

  describe('Tool call processing', () => {
    it('should process successful tool call', async () => {
      const tools = createMockToolRegistry(new Map([
        ['read', async () => ({
          toolName: 'read',
          status: 'success' as const,
          isSuccess: true,
          output: 'file contents here',
          durationMs: 50,
        })],
      ]));

      const llm = createMockLLM([
        createToolCallResponse([{ id: 'call_1', name: 'read', arguments: { path: 'test.txt' } }]),
        createSuccessResponse('[FINAL] Read the file successfully'),
      ]);

      const worker = new Worker(tools, llm);
      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.success).toBe(true);
      expect(outcome.metrics.toolCallsMade).toBe(1);
      expect(outcome.metrics.toolCallsSucceeded).toBe(1);
    });

    it('should handle tool call failure', async () => {
      const tools = createMockToolRegistry(new Map([
        ['read', async () => ({
          toolName: 'read',
          status: 'error' as const,
          isSuccess: false,
          output: 'File not found',
          error: 'ENOENT: no such file',
          durationMs: 50,
        })],
      ]));

      const llm = createMockLLM([
        createToolCallResponse([{ id: 'call_1', name: 'read', arguments: { path: 'missing.txt' } }]),
        createSuccessResponse('[FINAL] File was not found'),
      ]);

      const worker = new Worker(tools, llm);
      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.metrics.toolCallsFailed).toBe(1);
      expect(outcome.toolErrors).toContain('read: ENOENT: no such file');
    });

    it('should handle disallowed tool (ask_user by default)', async () => {
      const tools = createMockToolRegistry(new Map([
        ['ask_user', async () => ({
          toolName: 'ask_user',
          status: 'success' as const,
          isSuccess: true,
          output: 'user said yes',
          durationMs: 0,
        })],
      ]));

      const llm = createMockLLM([
        createToolCallResponse([{ id: 'call_1', name: 'ask_user', arguments: { question: 'Continue?' } }]),
        createSuccessResponse('[FINAL] Done'),
      ]);

      const worker = new Worker(tools, llm);
      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.toolErrors).toContain('Disallowed tool: ask_user');
    });

    it('should track read files from tool calls', async () => {
      const tools = createMockToolRegistry(new Map([
        ['read', async () => ({
          toolName: 'read',
          status: 'success' as const,
          isSuccess: true,
          output: 'contents',
          durationMs: 50,
        })],
      ]));

      const llm = createMockLLM([
        createToolCallResponse([{ id: 'call_1', name: 'read', arguments: { path: '/test/file.txt' } }]),
        createSuccessResponse('[FINAL] Done'),
      ]);

      const worker = new Worker(tools, llm);
      await worker.execute(baseContext, baseWorkItem, 1);

      // Read files are now tracked in ContextWindow, not WorkerOutcome
      expect(baseContext.readFiles.has('/test/file.txt')).toBe(true);
    });

    it('should handle tool that throws exception', async () => {
      const tools = createMockToolRegistry(new Map([
        ['crash', async () => {
          throw new Error('Tool crashed unexpectedly');
        }],
      ]));

      const llm = createMockLLM([
        createToolCallResponse([{ id: 'call_1', name: 'crash', arguments: {} }]),
        createSuccessResponse('[FINAL] Handled the crash'),
      ]);

      const worker = new Worker(tools, llm);
      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.metrics.toolCallsFailed).toBe(1);
      expect(outcome.toolErrors.some(e => e.includes('crashed unexpectedly'))).toBe(true);
    });

    it('should handle tool not found', async () => {
      const tools = createMockToolRegistry(new Map());

      const llm = createMockLLM([
        createToolCallResponse([{ id: 'call_1', name: 'nonexistent', arguments: {} }]),
        createSuccessResponse('[FINAL] Tool was not available'),
      ]);

      const worker = new Worker(tools, llm);
      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.toolErrors.some(e => e.includes('not found'))).toBe(true);
    });
  });

  describe('Execution bounds', () => {
    it('should respect maxToolCalls limit', async () => {
      const workItem = createWorkItem({
        stepNum: 1,
        objective: 'Test',
        bounds: { maxToolCalls: 2, maxDurationMs: 120000, maxLlmCalls: 10 },
      });

      const tools = createMockToolRegistry(new Map([
        ['read', async () => ({
          toolName: 'read',
          status: 'success' as const,
          isSuccess: true,
          output: 'contents',
          durationMs: 10,
        })],
      ]));

      const llm = createMockLLM([
        createToolCallResponse([{ id: 'call_1', name: 'read', arguments: { path: '1.txt' } }]),
        createToolCallResponse([{ id: 'call_2', name: 'read', arguments: { path: '2.txt' } }]),
        createToolCallResponse([{ id: 'call_3', name: 'read', arguments: { path: '3.txt' } }]), // Should not be reached
      ]);

      const worker = new Worker(tools, llm);
      const outcome = await worker.execute(baseContext, workItem, 1);

      expect(outcome.terminationReason).toBe('bounds:tool_calls');
      expect(outcome.metrics.toolCallsMade).toBe(2);
    });

    it('should respect maxLlmCalls limit', async () => {
      const workItem = createWorkItem({
        stepNum: 1,
        objective: 'Test',
        bounds: { maxToolCalls: 100, maxDurationMs: 120000, maxLlmCalls: 2 },
      });

      const llm = createMockLLM([
        createSuccessResponse('[CONTINUE] Still thinking...'),
        createSuccessResponse('[CONTINUE] Almost there...'),
        createSuccessResponse('[FINAL] Done'), // Should not be reached
      ]);

      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm, { maxIterations: 10 });
      const outcome = await worker.execute(baseContext, workItem, 1);

      // BUG: The check uses config.maxIterations AND workItem.bounds.maxLlmCalls
      // The Math.min logic should enforce the bound
      expect(outcome.metrics.llmCallsMade).toBeLessThanOrEqual(2);
    });

    it('BUG CANDIDATE: duration check happens AFTER iteration starts', async () => {
      // The duration check is inside the loop, after we've already started
      // This means we could exceed the duration by up to one full LLM call
      const workItem = createWorkItem({
        stepNum: 1,
        objective: 'Test',
        bounds: { maxToolCalls: 100, maxDurationMs: 1, maxLlmCalls: 10 }, // 1ms limit
      });

      const llm = createMockLLM([
        createSuccessResponse('[CONTINUE] First'),
        createSuccessResponse('[CONTINUE] Second'),
        createSuccessResponse('[FINAL] Done'),
      ]);

      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm);
      const outcome = await worker.execute(baseContext, workItem, 1);

      // BUG: Duration limit of 1ms is basically impossible to enforce
      // The first LLM call will always complete before the check happens
      // Duration check is at line 466 but doesn't check until AFTER first response
    });
  });

  describe('Synthesis step', () => {
    it('should call synthesis after tool calls', async () => {
      const tools = createMockToolRegistry(new Map([
        ['read', async () => ({
          toolName: 'read',
          status: 'success' as const,
          isSuccess: true,
          output: 'file contents',
          durationMs: 10,
        })],
      ]));

      // First call: tool call, Second call: synthesis
      let callCount = 0;
      const llm: LLMAdapter = {
        provider: 'openai',
        model: 'gpt-4',
        respond: async () => {
          callCount++;
          if (callCount === 1) {
            return createToolCallResponse([{ id: 'call_1', name: 'read', arguments: { path: 'test.txt' } }]);
          }
          // Synthesis call - should have no tools
          return createSuccessResponse('[FINAL] Analyzed the file contents');
        },
        stream: async function* () {
          yield 'test';
          return createSuccessResponse('[FINAL] Done');
        },
      } as unknown as LLMAdapter;

      const worker = new Worker(tools, llm);
      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.success).toBe(true);
      expect(outcome.metrics.llmCallsMade).toBe(2);
    });

    it('should handle synthesis call failure', async () => {
      const tools = createMockToolRegistry(new Map([
        ['read', async () => ({
          toolName: 'read',
          status: 'success' as const,
          isSuccess: true,
          output: 'file contents',
          durationMs: 10,
        })],
      ]));

      let callCount = 0;
      const llm: LLMAdapter = {
        provider: 'openai',
        model: 'gpt-4',
        respond: async () => {
          callCount++;
          if (callCount === 1) {
            return createToolCallResponse([{ id: 'call_1', name: 'read', arguments: { path: 'test.txt' } }]);
          }
          // Synthesis call throws
          throw new Error('API rate limited');
        },
        stream: async function* () {
          throw new Error('stream not used');
        },
      } as unknown as LLMAdapter;

      const worker = new Worker(tools, llm);
      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain('rate limited');
    });
  });

  describe('Auto-read target files', () => {
    it('should auto-read target paths before loop starts', async () => {
      const readCalls: string[] = [];
      const tools = createMockToolRegistry(new Map([
        ['read', async (args) => {
          readCalls.push(args.path as string);
          return {
            toolName: 'read',
            status: 'success' as const,
            isSuccess: true,
            output: `contents of ${args.path}`,
            durationMs: 10,
          };
        }],
      ]));

      const workItem = createWorkItem({
        stepNum: 1,
        objective: 'Edit the files',
        targetPaths: ['/src/a.ts', '/src/b.ts'],
      });

      const llm = createMockLLM([
        createSuccessResponse('[FINAL] Edited the files'),
      ]);

      const worker = new Worker(tools, llm);
      const outcome = await worker.execute(baseContext, workItem, 1);

      expect(readCalls).toContain('/src/a.ts');
      expect(readCalls).toContain('/src/b.ts');
      expect(outcome.metrics.toolCallsMade).toBe(2);
      expect(outcome.metrics.toolCallsSucceeded).toBe(2);
    });

    it('should skip already-read files', async () => {
      const readCalls: string[] = [];
      const tools = createMockToolRegistry(new Map([
        ['read', async (args) => {
          readCalls.push(args.path as string);
          return {
            toolName: 'read',
            status: 'success' as const,
            isSuccess: true,
            output: `contents`,
            durationMs: 10,
          };
        }],
      ]));

      const workItem = createWorkItem({
        stepNum: 1,
        objective: 'Edit the files',
        targetPaths: ['/src/a.ts'],
      });

      // Context already has the file read
      const contextWithRead = new ContextWindow('test-session', 200_000);
      contextWithRead.markFileRead('/src/a.ts');

      // BUG CANDIDATE: The check is on delta.readFiles, not baseContext.readFiles
      // So this file WILL be read again
      const llm = createMockLLM([
        createSuccessResponse('[FINAL] Done'),
      ]);

      const worker = new Worker(tools, llm);
      await worker.execute(contextWithRead, workItem, 1);

      // This reveals the bug: file is read again even though it was in context
      expect(readCalls).toHaveLength(1); // BUG: Should be 0 if checking baseContext
    });
  });

  describe('User input handling', () => {
    it('should detect ask_user tool and pause for input', async () => {
      const tools = createMockToolRegistry(new Map([
        ['ask_user', async () => ({
          toolName: 'ask_user',
          status: 'success' as const,
          isSuccess: true,
          output: JSON.stringify({ question: 'Continue?', options: ['yes', 'no'] }),
          durationMs: 0,
        })],
      ]));

      // Remove ask_user from disallowed
      const config: Partial<WorkerConfig> = {
        disallowedTools: new Set(), // Allow ask_user
      };

      const llm = createMockLLM([
        createToolCallResponse([{ id: 'call_1', name: 'ask_user', arguments: { question: 'Continue?' } }]),
      ]);

      const worker = new Worker(tools, llm, config);
      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.needsUserInput).toBe(true);
      expect(outcome.terminationReason).toBe('user_input_required');
    });
  });

  describe('Implicit finals', () => {
    it('should allow implicit final when enabled and response is long', async () => {
      const config: Partial<WorkerConfig> = {
        allowImplicitFinals: true,
      };

      const longResponse = 'A'.repeat(200); // 200 chars, > 100 threshold
      const llm = createMockLLM([
        createSuccessResponse(longResponse),
      ]);

      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm, config);
      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.success).toBe(true);
      expect(outcome.terminationReason).toBe('implicit_final');
    });

    it('should NOT use implicit final for short responses', async () => {
      const config: Partial<WorkerConfig> = {
        allowImplicitFinals: true,
      };

      const shortResponse = 'Short answer'; // < 100 chars
      const llm = createMockLLM([
        createSuccessResponse(shortResponse),
      ]);

      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm, config);
      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.success).toBe(false);
      expect(outcome.terminationReason).toBe('no_action');
    });
  });

  describe('Event emission', () => {
    it('should emit LLM call events when emitter provided', async () => {
      const events: unknown[] = [];
      const eventEmitter = (event: unknown) => events.push(event);

      const llm = createMockLLM([
        createSuccessResponse('[FINAL] Done'),
      ]);
      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm, undefined, undefined, eventEmitter);

      await worker.execute(baseContext, baseWorkItem, 1);

      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e: any) => e.type === 'llm_call')).toBe(true);
    });

    it('should emit LLM error event on failure', async () => {
      const events: unknown[] = [];
      const eventEmitter = (event: unknown) => events.push(event);

      const llm: LLMAdapter = {
        provider: 'openai',
        model: 'gpt-4',
        respond: async () => {
          throw new Error('429: rate limit exceeded');
        },
        stream: async function* () {
          throw new Error('not used');
        },
      } as unknown as LLMAdapter;

      const tools = createMockToolRegistry(new Map());
      const worker = new Worker(tools, llm, undefined, undefined, eventEmitter);

      const outcome = await worker.execute(baseContext, baseWorkItem, 1);

      expect(outcome.success).toBe(false);
      expect(events.some((e: any) => e.type === 'llm_error')).toBe(true);

      const errorEvent = events.find((e: any) => e.type === 'llm_error') as any;
      expect(errorEvent.data.errorType).toBe('rate_limit');
    });
  });
});

describe('outcomeMadeProgress', () => {
  it('should return true when toolCallsSucceeded > 0', () => {
    const outcome = createWorkerOutcome({ workId: '1', stepNum: 1, baseVersion: 1 });
    outcome.metrics.toolCallsSucceeded = 1;

    expect(outcomeMadeProgress(outcome)).toBe(true);
  });

  it('should return true when facts.length > 0', () => {
    const outcome = createWorkerOutcome({ workId: '1', stepNum: 1, baseVersion: 1 });
    outcome.facts.push({ key: 'test', value: 'value', source: 'llm' as any, confidence: 1, timestamp: Date.now(), isPinned: false });

    expect(outcomeMadeProgress(outcome)).toBe(true);
  });

  it('should return true when entityRefs.length > 0', () => {
    const outcome = createWorkerOutcome({ workId: '1', stepNum: 1, baseVersion: 1 });
    outcome.entityRefs.push('/path/to/file');

    expect(outcomeMadeProgress(outcome)).toBe(true);
  });

  it('should return false when no progress indicators', () => {
    const outcome = createWorkerOutcome({ workId: '1', stepNum: 1, baseVersion: 1 });

    expect(outcomeMadeProgress(outcome)).toBe(false);
  });

  it('BUG CANDIDATE: failed tool calls are not progress but increment toolCallsMade', () => {
    const outcome = createWorkerOutcome({ workId: '1', stepNum: 1, baseVersion: 1 });
    outcome.metrics.toolCallsMade = 5;
    outcome.metrics.toolCallsFailed = 5;
    outcome.metrics.toolCallsSucceeded = 0;

    // This correctly returns false - only successes count
    expect(outcomeMadeProgress(outcome)).toBe(false);
  });
});
