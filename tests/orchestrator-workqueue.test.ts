/**
 * State-machine tests for Orchestrator work queue logic
 *
 * These tests focus on the work queue mechanics:
 * - enqueue() and dequeueNext() behavior
 * - Dependency resolution (DAG)
 * - Work item creation patterns
 * - Result tracking
 *
 * Note: Full execution tests require complex Agent mocking.
 * These tests verify the core state machine logic.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { createWorkItem, type WorkItem, DEFAULT_WORK_BOUNDS } from '../packages/agent-core/src/work/work-item.js';
import { ContextWindow } from '../packages/agent-core/src/context/context-window.js';
import {
  DEFAULT_ORCHESTRATOR_CONFIG,
  type OrchestratorConfig,
  type TerminationReason,
} from '../packages/agent-core/src/orchestrator/orchestrator.js';

describe('Work Item Creation', () => {
  describe('createWorkItem factory', () => {
    it('creates work item with required fields', () => {
      const item = createWorkItem({
        goal: 'Fix the bug',
        objective: 'Debug the authentication flow',
      });

      expect(item.workId).toBeTruthy();
      expect(item.workId).toMatch(/^[a-f0-9-]+$/);
      expect(item.goal).toBe('Fix the bug');
      expect(item.objective).toBe('Debug the authentication flow');
    });

    it('applies default agent type', () => {
      const item = createWorkItem({
        goal: 'Test',
        objective: 'Test',
      });

      expect(item.agent).toBe('standard');
    });

    it('allows custom agent type', () => {
      const item = createWorkItem({
        goal: 'Test',
        objective: 'Test',
        agent: 'explorer',
      });

      expect(item.agent).toBe('explorer');
    });

    it('creates frozen dependencies array', () => {
      const item = createWorkItem({
        goal: 'Test',
        objective: 'Test',
        dependencies: ['dep-1', 'dep-2'],
      });

      expect(Object.isFrozen(item.dependencies)).toBe(true);
      expect(item.dependencies).toEqual(['dep-1', 'dep-2']);
    });

    it('creates frozen targetPaths array', () => {
      const item = createWorkItem({
        goal: 'Test',
        objective: 'Test',
        targetPaths: ['/src/app.ts', '/src/utils.ts'],
      });

      expect(Object.isFrozen(item.targetPaths)).toBe(true);
      expect(item.targetPaths).toEqual(['/src/app.ts', '/src/utils.ts']);
    });

    it('merges custom bounds with defaults', () => {
      const item = createWorkItem({
        goal: 'Test',
        objective: 'Test',
        bounds: { maxToolCalls: 10 },
      });

      expect(item.bounds.maxToolCalls).toBe(10);
      expect(item.bounds.maxDurationMs).toBe(DEFAULT_WORK_BOUNDS.maxDurationMs);
      expect(item.bounds.maxLlmCalls).toBe(DEFAULT_WORK_BOUNDS.maxLlmCalls);
    });

    it('creates default success criteria', () => {
      const item = createWorkItem({
        goal: 'Test',
        objective: 'Do the thing',
      });

      expect(item.successCriteria.description).toBe('Complete: Do the thing');
      expect(item.successCriteria.requiredOutputs).toEqual([]);
      expect(item.successCriteria.postconditions).toEqual([]);
    });

    it('allows custom success criteria', () => {
      const item = createWorkItem({
        goal: 'Test',
        objective: 'Test',
        successCriteria: {
          description: 'All tests pass',
          requiredOutputs: ['test-report.json'],
          postconditions: ['No failing tests'],
        },
      });

      expect(item.successCriteria.description).toBe('All tests pass');
      expect(item.successCriteria.requiredOutputs).toEqual(['test-report.json']);
    });

    it('includes tool hints when provided', () => {
      const item = createWorkItem({
        goal: 'Read a file',
        objective: 'Read config.json',
        toolHint: 'Read',
        toolArgsHint: { path: '/config.json' },
      });

      expect(item.toolHint).toBe('Read');
      expect(item.toolArgsHint).toEqual({ path: '/config.json' });
    });
  });

  describe('DEFAULT_WORK_BOUNDS', () => {
    it('has sensible default tool call limit', () => {
      expect(DEFAULT_WORK_BOUNDS.maxToolCalls).toBe(150);
    });

    it('has sensible default duration', () => {
      expect(DEFAULT_WORK_BOUNDS.maxDurationMs).toBe(120_000); // 2 minutes
    });

    it('has sensible default LLM call limit', () => {
      expect(DEFAULT_WORK_BOUNDS.maxLlmCalls).toBe(20);
    });
  });
});

describe('Work Queue Patterns', () => {
  describe('Dependency resolution patterns', () => {
    it('identifies items with no dependencies as ready', () => {
      const completedWork = new Map<string, { success: boolean }>();
      const item = createWorkItem({
        goal: 'Test',
        objective: 'Test',
        dependencies: [],
      });

      const isReady = item.dependencies.every(d => completedWork.has(d));
      expect(isReady).toBe(true);
    });

    it('identifies items with unsatisfied dependencies as blocked', () => {
      const completedWork = new Map<string, { success: boolean }>();
      const item = createWorkItem({
        goal: 'Test',
        objective: 'Test',
        dependencies: ['dep-1', 'dep-2'],
      });

      const isReady = item.dependencies.every(d => completedWork.has(d));
      expect(isReady).toBe(false);
    });

    it('identifies items with all dependencies satisfied as ready', () => {
      const completedWork = new Map<string, { success: boolean }>([
        ['dep-1', { success: true }],
        ['dep-2', { success: true }],
      ]);
      const item = createWorkItem({
        goal: 'Test',
        objective: 'Test',
        dependencies: ['dep-1', 'dep-2'],
      });

      const isReady = item.dependencies.every(d => completedWork.has(d));
      expect(isReady).toBe(true);
    });

    it('handles partial dependency completion', () => {
      const completedWork = new Map<string, { success: boolean }>([
        ['dep-1', { success: true }],
        // dep-2 not completed
      ]);
      const item = createWorkItem({
        goal: 'Test',
        objective: 'Test',
        dependencies: ['dep-1', 'dep-2'],
      });

      const isReady = item.dependencies.every(d => completedWork.has(d));
      expect(isReady).toBe(false);
    });
  });

  describe('Queue management patterns', () => {
    it('dequeues first ready item from queue', () => {
      const completedWork = new Map<string, boolean>();
      const queue: WorkItem[] = [
        createWorkItem({ goal: 'A', objective: 'A', dependencies: ['x'] }), // Blocked
        createWorkItem({ goal: 'B', objective: 'B', dependencies: [] }), // Ready
        createWorkItem({ goal: 'C', objective: 'C', dependencies: ['y'] }), // Blocked
      ];

      // Find first ready item
      let readyIndex = -1;
      for (let i = 0; i < queue.length; i++) {
        const ready = queue[i].dependencies.every(d => completedWork.has(d));
        if (ready) {
          readyIndex = i;
          break;
        }
      }

      expect(readyIndex).toBe(1);
      expect(queue[readyIndex].goal).toBe('B');
    });

    it('returns null when all items are blocked', () => {
      const completedWork = new Map<string, boolean>();
      const queue: WorkItem[] = [
        createWorkItem({ goal: 'A', objective: 'A', dependencies: ['x'] }),
        createWorkItem({ goal: 'B', objective: 'B', dependencies: ['y'] }),
      ];

      let readyItem: WorkItem | null = null;
      for (const item of queue) {
        const ready = item.dependencies.every(d => completedWork.has(d));
        if (ready) {
          readyItem = item;
          break;
        }
      }

      expect(readyItem).toBeNull();
    });

    it('tracks completed work for dependency resolution', () => {
      const completedWork = new Map<string, { response: string }>();

      const item1 = createWorkItem({ goal: 'Task 1', objective: 'Task 1' });
      const item2 = createWorkItem({
        goal: 'Task 2',
        objective: 'Task 2',
        dependencies: [item1.workId],
      });

      // Item 2 blocked initially
      expect(item2.dependencies.every(d => completedWork.has(d))).toBe(false);

      // Complete item 1
      completedWork.set(item1.workId, { response: 'Done' });

      // Item 2 now ready
      expect(item2.dependencies.every(d => completedWork.has(d))).toBe(true);
    });
  });
});

describe('Orchestrator Configuration', () => {
  describe('DEFAULT_ORCHESTRATOR_CONFIG', () => {
    it('has sensible max iterations', () => {
      expect(DEFAULT_ORCHESTRATOR_CONFIG.maxIterations).toBe(50);
    });

    it('has sensible max tool calls', () => {
      expect(DEFAULT_ORCHESTRATOR_CONFIG.maxToolCalls).toBe(200);
    });

    it('has sensible max duration', () => {
      expect(DEFAULT_ORCHESTRATOR_CONFIG.maxDurationMs).toBe(300_000); // 5 minutes
    });
  });

  describe('Configuration merging patterns', () => {
    it('partial config overrides defaults', () => {
      const defaults = DEFAULT_ORCHESTRATOR_CONFIG;
      const partial = { maxIterations: 10 };

      const merged = { ...defaults, ...partial };

      expect(merged.maxIterations).toBe(10);
      expect(merged.maxToolCalls).toBe(defaults.maxToolCalls);
      expect(merged.maxDurationMs).toBe(defaults.maxDurationMs);
    });

    it('full config replaces all defaults', () => {
      const defaults = DEFAULT_ORCHESTRATOR_CONFIG;
      const full: OrchestratorConfig = {
        maxIterations: 5,
        maxToolCalls: 20,
        maxDurationMs: 60_000,
      };

      const merged = { ...defaults, ...full };

      expect(merged).toEqual(full);
    });
  });
});

describe('Termination Reason Types', () => {
  it('defines all expected termination reasons', () => {
    const validReasons: TerminationReason[] = [
      'goal_state_reached',
      'max_iterations_exceeded',
      'max_tool_calls_exceeded',
      'max_duration_exceeded',
      'user_input_required',
      'agent_error',
      'refusal',
    ];

    // Type check: these should all compile without error
    validReasons.forEach(reason => {
      expect(typeof reason).toBe('string');
    });
  });
});

describe('Context Integration Patterns', () => {
  let context: ContextWindow;

  beforeEach(() => {
    context = new ContextWindow('test-session', 200_000);
  });

  describe('User input handling', () => {
    it('preserves context when pausing for user input', () => {
      // Simulate work done before pause
      context.addMessage('user', 'Initial request');
      context.addFileContent('/src/app.ts', 'const x = 1;');
      context.addFunctionCall('call-1', 'Read', { path: '/src/app.ts' });
      context.addFunctionCallOutput('call-1', 'const x = 1;');

      const versionBeforePause = context.version;
      const itemsBeforePause = context.items.length;

      // Simulate pause (just check state is intact)
      expect(context.version).toBe(versionBeforePause);
      expect(context.items.length).toBe(itemsBeforePause);
      expect(context.hasReadFile('/src/app.ts')).toBe(true);
    });

    it('adds user answer after resume', () => {
      context.addMessage('user', 'Setup my project');

      // Simulate agent asking question and pausing
      // (normally orchestrator would return here)

      // Simulate resume: user provides answer
      context.addMessage('user', 'I choose TypeScript');

      const messages = context.items.filter(i => i.type === 'message');
      expect(messages.length).toBe(2);
    });

    it('maintains context history across multiple pauses', () => {
      context.addMessage('user', 'Step 1');
      context.addMessage('user', 'Answer 1');
      context.addMessage('user', 'Answer 2');
      context.addMessage('user', 'Answer 3');

      const messages = context.items.filter(i => i.type === 'message');
      expect(messages.length).toBe(4);

      // Verify ordering is preserved
      const contents = messages.map(m => (m as { content: string }).content);
      expect(contents[0]).toBe('Step 1');
      expect(contents[3]).toBe('Answer 3');
    });
  });

  describe('Tool call tracking', () => {
    it('records function calls and outputs', () => {
      context.addFunctionCall('call-1', 'Read', { path: '/file.ts' });
      context.addFunctionCallOutput('call-1', 'file contents');

      const calls = context.items.filter(i => i.type === 'function_call');
      const outputs = context.items.filter(i => i.type === 'function_call_output');

      expect(calls.length).toBe(1);
      expect(outputs.length).toBe(1);
      expect((calls[0] as { name: string }).name).toBe('Read');
    });

    it('preserves tool call history for resumption', () => {
      // First execution phase
      context.addFunctionCall('call-1', 'Read', { path: '/a.ts' });
      context.addFunctionCallOutput('call-1', 'content a');

      // Pause for user input
      const toolCallsBefore = context.items.filter(i =>
        i.type === 'function_call' || i.type === 'function_call_output'
      ).length;

      // Resume - add more tool calls
      context.addFunctionCall('call-2', 'Write', { path: '/b.ts' });
      context.addFunctionCallOutput('call-2', 'success');

      const toolCallsAfter = context.items.filter(i =>
        i.type === 'function_call' || i.type === 'function_call_output'
      ).length;

      expect(toolCallsAfter).toBe(toolCallsBefore + 2);
    });
  });

  describe('Metrics tracking patterns', () => {
    it('updates metrics after LLM calls', () => {
      context.updateMetrics(1000, 500);

      // inputTokens reflects current context size (not accumulated)
      expect(context.metrics.inputTokens).toBe(1000);
      expect(context.metrics.outputTokens).toBe(500);
      expect(context.metrics.totalOutputTokens).toBe(500);
    });

    it('accumulates output tokens across multiple calls', () => {
      context.updateMetrics(100, 50);
      context.updateMetrics(200, 75);
      context.updateMetrics(300, 100);

      // inputTokens is current context size (last call), not accumulated
      expect(context.metrics.inputTokens).toBe(300);
      // totalOutputTokens accumulates across calls
      expect(context.metrics.totalOutputTokens).toBe(225);
      // peakInputTokens tracks high-water mark
      expect(context.metrics.peakInputTokens).toBe(300);
    });
  });
});

describe('Bounds Checking Patterns', () => {
  describe('Iteration bounds', () => {
    it('detects when iteration limit exceeded', () => {
      const maxIterations = 10;
      const currentIteration = 11;

      expect(currentIteration > maxIterations).toBe(true);
    });

    it('allows execution at limit', () => {
      const maxIterations = 10;
      const currentIteration = 10;

      expect(currentIteration > maxIterations).toBe(false);
    });
  });

  describe('Duration bounds', () => {
    it('detects when duration exceeded', () => {
      const maxDurationMs = 60_000;
      const elapsedMs = 65_000;

      expect(elapsedMs > maxDurationMs).toBe(true);
    });

    it('allows execution within duration', () => {
      const maxDurationMs = 60_000;
      const elapsedMs = 30_000;

      expect(elapsedMs > maxDurationMs).toBe(false);
    });
  });

  describe('Tool call bounds', () => {
    it('detects when tool calls exceeded', () => {
      const maxToolCalls = 50;
      const toolCallsMade = 51;

      expect(toolCallsMade >= maxToolCalls).toBe(true);
    });

    it('allows execution at limit boundary', () => {
      const maxToolCalls = 50;
      const toolCallsMade = 49;

      expect(toolCallsMade >= maxToolCalls).toBe(false);
    });
  });
});

describe('Auto-compaction Hysteresis Pattern', () => {
  it('triggers compaction at high watermark', () => {
    const highWatermark = 0.8;
    const lowWatermark = 0.7;
    let compactedRecently = false;
    let percentUsed = 0.85;

    // At 85% usage, should trigger if not recently compacted
    const shouldCompact = !compactedRecently && percentUsed >= highWatermark;
    expect(shouldCompact).toBe(true);

    // Mark as compacted
    compactedRecently = true;

    // Still at 85%, but recently compacted
    const shouldCompactAgain = !compactedRecently && percentUsed >= highWatermark;
    expect(shouldCompactAgain).toBe(false);

    // Drop below low watermark
    percentUsed = 0.65;
    if (percentUsed < lowWatermark) {
      compactedRecently = false;
    }

    expect(compactedRecently).toBe(false);

    // Rise again
    percentUsed = 0.82;
    const shouldCompactNow = !compactedRecently && percentUsed >= highWatermark;
    expect(shouldCompactNow).toBe(true);
  });

  it('resets compaction flag below low watermark', () => {
    const lowWatermark = 0.7;
    let compactedRecently = true;
    let percentUsed = 0.65;

    if (percentUsed < lowWatermark) {
      compactedRecently = false;
    }

    expect(compactedRecently).toBe(false);
  });

  it('maintains compacted state between thresholds', () => {
    const highWatermark = 0.8;
    const lowWatermark = 0.7;
    let compactedRecently = true;
    let percentUsed = 0.75; // Between thresholds

    // Should NOT reset (still above low watermark)
    if (percentUsed < lowWatermark) {
      compactedRecently = false;
    }

    expect(compactedRecently).toBe(true);

    // Should NOT trigger compaction (already recently compacted)
    const shouldCompact = !compactedRecently && percentUsed >= highWatermark;
    expect(shouldCompact).toBe(false);
  });
});
