/**
 * Smoke test: Verify key classes can be instantiated with test configs.
 * Tests contracts are maintained - constructors accept expected shapes.
 * Exit 0 = pass, Exit 1 = fail
 */

import { Agent, ToolRegistry, ContextWindow, createToolRegistry, createWorkItem, AgentRegistry, buildAgentConfig } from '../../packages/agent-core/src/index.js';
import { GraphStore } from '../../packages/graphd/src/index.js';
import { BenchmarkRunner } from '../benchmark.js';
import { createLogger } from '../../packages/agent-core/src/shared/logger.js';
import type { LLMAdapter } from '../../packages/agent-core/src/types/llm.js';

const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    console.error(`[FAIL] ${name}:`, error);
    failures.push(name);
  }
}

// Mock LLM adapter for testing
function createMockLLM(): LLMAdapter {
  return {
    async respond() {
      return {
        content: [{ type: 'text', text: 'mock response' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
    async *stream() {
      yield { type: 'text' as const, text: 'mock' };
    },
  };
}

async function main(): Promise<void> {
  // Test ContextWindow instantiation
  test('ContextWindow instantiation', () => {
    const ctx = new ContextWindow('test-session', 100_000);
    if (!ctx) throw new Error('Failed to create ContextWindow');
    if (ctx.maxTokens !== 100_000) throw new Error('maxTokens not set correctly');
    if (ctx.sessionKey !== 'test-session') throw new Error('sessionKey not set correctly');
  });

  // Test ToolRegistry instantiation
  test('ToolRegistry instantiation', () => {
    const registry = createToolRegistry({
      workingDir: process.cwd(),
      repoRoot: process.cwd(),
      bashTimeoutMs: 5000,
      maxOutputLength: 10000,
    });
    if (!registry) throw new Error('Failed to create ToolRegistry');
    const tools = registry.list();
    if (tools.length === 0) throw new Error('No tools registered');
    const requiredTools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];
    for (const tool of requiredTools) {
      if (!tools.some((t) => t.name === tool)) {
        throw new Error(`Missing required tool: ${tool}`);
      }
    }
  });

  // Test WorkItem creation
  test('WorkItem creation', () => {
    const workItem = createWorkItem({
      goal: 'Test goal',
      successCriteria: ['criterion 1'],
    });
    if (!workItem.workId) throw new Error('WorkItem missing workId');
    if (workItem.goal !== 'Test goal') throw new Error('WorkItem goal mismatch');
  });

  // Test Agent instantiation
  test('Agent instantiation', () => {
    const config = buildAgentConfig(
      'standard',
      ['Read', 'Glob', 'Grep'],
      { maxIterations: 5, maxToolCalls: 10, maxDurationMs: 30000 }
    );
    const toolRegistry = createToolRegistry({
      workingDir: process.cwd(),
      repoRoot: process.cwd(),
      bashTimeoutMs: 5000,
      maxOutputLength: 10000,
    });
    const mockLLM = createMockLLM();
    const agent = new Agent(config, mockLLM, toolRegistry, () => {});
    if (!agent) throw new Error('Failed to create Agent');
  });

  // Test AgentRegistry instantiation
  test('AgentRegistry instantiation', () => {
    const config = buildAgentConfig(
      'standard',
      ['Read'],
      { maxIterations: 5, maxToolCalls: 10, maxDurationMs: 30000 }
    );
    const llmConfig = {
      provider: 'anthropic' as const,
      model: 'claude-3-5-sonnet-20241022',
      maxTokens: 4096,
    };
    const registry = new AgentRegistry([{ config, llm: llmConfig }]);
    if (!registry) throw new Error('Failed to create AgentRegistry');
    const retrieved = registry.getConfig('standard');
    if (!retrieved) throw new Error('Failed to retrieve agent config');
  });

  // Test GraphStore instantiation
  test('GraphStore instantiation', () => {
    const store = new GraphStore(':memory:');
    if (!store) throw new Error('Failed to create GraphStore');
    store.initialize();
    store.close();
  });

  // Test BenchmarkRunner instantiation
  test('BenchmarkRunner instantiation', () => {
    const store = new GraphStore(':memory:');
    store.initialize();
    const logger = createLogger({ backend: 'console', format: 'json', level: 'error' });
    const runner = new BenchmarkRunner('test-session', store, logger, []);
    if (!runner) throw new Error('Failed to create BenchmarkRunner');
    store.close();
  });

  // Test Logger instantiation
  test('Logger instantiation', () => {
    const logger = createLogger({ backend: 'console', format: 'json', level: 'info' });
    if (!logger) throw new Error('Failed to create Logger');
    if (typeof logger.info !== 'function') throw new Error('Logger missing info method');
    if (typeof logger.error !== 'function') throw new Error('Logger missing error method');
  });

  // Summary
  if (failures.length > 0) {
    console.error(`\n${failures.length} test(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }

  console.log(`\nAll ${8 - failures.length} tests passed`);
  process.exit(0);
}

main().catch((error) => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
