/**
 * AgentHarness observer memory injector wiring tests
 */

import { describe, it, expect, mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let capturedRuntime: { memoryInjector?: unknown } | null = null;

mock.module('agent', () => ({
  Agent: class MockAgent {
    constructor(_config: unknown, runtime: { memoryInjector?: unknown }) {
      capturedRuntime = runtime;
    }

    async run() {
      return {
        success: true,
        response: '',
        structuredOutput: {
          action: 'done',
          goalStateReached: true,
          watcherAction: 'quality_gate',
          reason: 'ok',
          qualityGate: {
            passed: true,
          },
        },
        terminationReason: 'goal_state_reached',
      };
    }
  },
  AgentRegistry: class MockAgentRegistry {
    private configs: Array<{ type: string }>;

    constructor(configs: Array<{ type: string }>) {
      this.configs = configs;
    }

    has(name: string): boolean {
      return this.configs.some((config) => config.type === name);
    }

    getConfig(name: string) {
      return this.configs.find((config) => config.type === name);
    }

    listToolDefinitions() {
      return [];
    }
  },
  buildAgentConfig: (type: string, tools: string[] = [], budget: unknown, llmParams: unknown, outputSchema?: unknown) => ({
    type,
    tools,
    budget,
    llmParams,
    outputSchema,
    systemPrompt: '',
  }),
  getAgentPrompt: () => '',
  getPlanningPromptAddendum: () => '',
}));

mock.module('llm', () => ({
  createAdapter: () => ({ updateApiKey: () => {} }),
  hasCodexCredentials: () => false,
}));

import { AgentHarness } from './harness.js';
import type { FullHarnessConfig } from './config.js';

function createTestConfig(): FullHarnessConfig {
  const cwd = mkdtempSync(join(tmpdir(), 'harness-observer-'));
  return {
    agents: {
      observer: {
        llm: {
          provider: 'lmstudio',
          displayProvider: 'lmstudio',
          model: 'test-model',
          maxTokens: 1,
          temperature: 0,
          reasoning: { effort: 'none' },
        },
        budget: {
          maxIterations: 1,
          maxToolCalls: 0,
          maxDurationMs: 1000,
        },
        tools: [],
        outputSchema: {
          name: 'watcher_action',
          schema: { type: 'object' },
          strict: true,
        },
      },
    },
    defaultAgent: 'observer',
    tools: {
      workingDir: cwd,
      repoRoot: cwd,
      bashTimeoutMs: 1,
      maxOutputLength: 1,
    },
    graphd: {
      enabled: false,
      host: '127.0.0.1',
      port: 1,
      dbPath: '/tmp/graphd.db',
    },
    context: {
      maxTokens: 1000,
      sessionTtlMs: 1000,
      pauseTimeoutMs: 1000,
    },
    skills: {
      enabled: false,
      directory: 'config/skills',
      definitions: [],
    },
    hooks: {
      enabled: false,
      directory: 'config/hooks',
      definitions: [],
    },
    entityGraph: {
      enabled: false,
      leaseDurationSec: 60,
      startupScan: false,
      leaseWaitTimeoutMs: 1000,
    },
    auth: {
      enabled: false,
      host: '127.0.0.1',
      port: 1,
      sessionExpiryDays: null,
    },
    models: {
      available: [],
    },
    memory: {
      enabled: true,
      baseUrl: 'http://memory',
      timeoutMs: 1000,
    },
    dangerousMode: false,
  };
}

describe('AgentHarness observer memory injector wiring', () => {
  it('passes memoryInjector to observer Agent runtime', async () => {
    capturedRuntime = null;
    const config = createTestConfig();
    const harness = new AgentHarness(config);
    const sessionKey = 'session-test';

    const state = (harness as unknown as { getOrCreateSessionState: (key: string) => { store: { setModelSelection: (agentType: string, selection: { provider: string; model: string }) => void } } }).getOrCreateSessionState(sessionKey);
    state.store.setModelSelection('observer', { provider: 'lmstudio', model: 'test-model' });

    const { hookRegistry } = await harness.createWatcherHookRegistryForSession(
      sessionKey,
      'Observer objective',
      config.tools.workingDir
    );
    const hooks = hookRegistry.getHooks('goal_state_reached');
    expect(hooks.length).toBeGreaterThan(0);

    const metrics = {
      toolCallsMade: 0,
      llmCalls: 1,
      contextPercentUsed: 0.1,
      durationMs: 1,
      filesRead: [],
      filesModified: [],
      iterationCount: 1,
    };
    await hooks[0]!.run({
      type: 'goal_state_reached',
      timestamp: Date.now(),
      sessionKey,
      workId: 'work-1',
      response: 'done',
      filesModified: [],
      metrics,
    }, {
      sessionKey,
      workId: 'work-1',
      agentType: 'observer',
      iteration: 1,
      metrics,
      recentMessages: [],
      filesModified: [],
      objective: 'Observer objective',
      realignCount: 0,
    });

    const harnessMemory = (harness as unknown as { memoryInjector?: unknown }).memoryInjector;
    expect(harnessMemory).toBeTruthy();
    expect(capturedRuntime?.memoryInjector).toBe(harnessMemory);
  });
});
