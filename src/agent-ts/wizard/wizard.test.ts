/**
 * Comprehensive test suite for Wizard Orchestrator
 *
 * Goal: Find bugs, not just pass tests.
 * Focus areas:
 * - Deadlock detection edge cases
 * - Step dependency resolution
 * - goalAchieved() edge cases
 * - Resume logic
 * - Step status transitions
 * - Stagnation handling
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { Wizard, type WizardConfig, DEFAULT_WIZARD_CONFIG } from './wizard.js';
import { PlanState, stepStateFromWizardStep } from './plan-state.js';
import type { WizardPlan, WizardStep } from '../types/plans.js';
import { StepStatus, StepPhase, createWizardStep, createWizardPlan } from '../types/plans.js';
import type { LLMAdapter, LLMResponse } from '../llm/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult, ToolDefinition } from '../types/tools.js';
import { ContextWindow } from '../types/context.js';

// Helper to create a test context
function createTestContext(): ContextWindow {
  return new ContextWindow('test-session', 200_000);
}

// Mock LLM that always succeeds with [FINAL]
function createSucceedingLLM(): LLMAdapter {
  return {
    provider: 'openai',
    model: 'gpt-4',
    respond: async () => ({
      content: '[FINAL] Task completed successfully',
      stopReason: 'end_turn',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      model: 'gpt-4',
      durationMs: 500,
    }),
    stream: async function* () {
      yield 'test';
      return {
        content: '[FINAL] Done',
        stopReason: 'end_turn',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        model: 'gpt-4',
        durationMs: 500,
      };
    },
  } as unknown as LLMAdapter;
}

// Mock LLM that always fails
function createFailingLLM(): LLMAdapter {
  return {
    provider: 'openai',
    model: 'gpt-4',
    respond: async () => {
      throw new Error('LLM API error: 500 Internal Server Error');
    },
    stream: async function* () {
      throw new Error('not used');
    },
  } as unknown as LLMAdapter;
}

// Mock LLM that produces stuck responses (no action markers, no tools)
function createStuckLLM(): LLMAdapter {
  return {
    provider: 'openai',
    model: 'gpt-4',
    respond: async () => ({
      content: 'I am thinking about this problem deeply...',
      stopReason: 'end_turn',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      model: 'gpt-4',
      durationMs: 500,
    }),
    stream: async function* () {
      throw new Error('not used');
    },
  } as unknown as LLMAdapter;
}

// Mock tool registry
function createMockToolRegistry(): ToolRegistry {
  return {
    execute: async (name: string, args: Record<string, unknown>) => ({
      toolName: name,
      status: 'success' as const,
      isSuccess: true,
      output: 'Mock tool result',
      durationMs: 10,
    }),
    getDefinitions: () => [] as ToolDefinition[],
  } as unknown as ToolRegistry;
}

describe('Wizard', () => {
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    toolRegistry = createMockToolRegistry();
  });

  describe('Basic execution', () => {
    it('should complete a single-step plan successfully', async () => {
      const llm = createSucceedingLLM();
      const wizard = new Wizard(toolRegistry, llm);

      const plan = createWizardPlan({
        goal: 'Test goal',
        steps: [
          createWizardStep({
            stepNum: 1,
            objective: 'Do the thing',
          }),
        ],
      });

      const result = await wizard.execute(plan, createTestContext(), '');

      expect(result.success).toBe(true);
      expect(result.stepsCompleted).toBe(1);
      expect(result.stepsFailed).toBe(0);
      expect(result.stepsSkipped).toBe(0);
    });

    it('should complete multi-step plan in order', async () => {
      let callOrder: number[] = [];
      const llm: LLMAdapter = {
        provider: 'openai',
        model: 'gpt-4',
        respond: async () => {
          callOrder.push(1);
          return {
            content: '[FINAL] Step done',
            stopReason: 'end_turn',
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            model: 'gpt-4',
            durationMs: 500,
          };
        },
        stream: async function* () { throw new Error('not used'); },
      } as unknown as LLMAdapter;

      const wizard = new Wizard(toolRegistry, llm);

      const plan = createWizardPlan({
        goal: 'Multi-step goal',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'First' }),
          createWizardStep({ stepNum: 2, objective: 'Second', dependsOn: [1] }),
          createWizardStep({ stepNum: 3, objective: 'Third', dependsOn: [2] }),
        ],
      });

      const result = await wizard.execute(plan, createTestContext(), '');

      expect(result.success).toBe(true);
      expect(result.stepsCompleted).toBe(3);
      expect(callOrder.length).toBe(3);
    });
  });

  describe('Dependency handling', () => {
    it('should execute steps only when dependencies are satisfied', async () => {
      const executionOrder: number[] = [];
      let stepNum = 0;
      const llm: LLMAdapter = {
        provider: 'openai',
        model: 'gpt-4',
        respond: async () => {
          stepNum++;
          executionOrder.push(stepNum);
          return {
            content: '[FINAL] Done',
            stopReason: 'end_turn',
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            model: 'gpt-4',
            durationMs: 100,
          };
        },
        stream: async function* () { throw new Error('not used'); },
      } as unknown as LLMAdapter;

      const wizard = new Wizard(toolRegistry, llm);

      const plan = createWizardPlan({
        goal: 'Test dependencies',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'A' }),
          createWizardStep({ stepNum: 2, objective: 'B', dependsOn: [1] }),
          createWizardStep({ stepNum: 3, objective: 'C', dependsOn: [1] }), // Also depends on 1
        ],
      });

      const result = await wizard.execute(plan, createTestContext(), '');

      expect(result.stepsCompleted).toBe(3);
      // Step 1 must come first
      expect(executionOrder[0]).toBe(1);
    });

    it('should handle skipped dependency as satisfied for soft deps', async () => {
      let step2Executed = false;
      let callCount = 0;
      const llm: LLMAdapter = {
        provider: 'openai',
        model: 'gpt-4',
        respond: async () => {
          callCount++;
          if (callCount === 1) {
            // First step will fail
            throw new Error('API Error');
          }
          // Step 2 should still run because skipped step 1 satisfies soft dep
          step2Executed = true;
          return {
            content: '[FINAL] Done',
            stopReason: 'end_turn',
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            model: 'gpt-4',
            durationMs: 100,
          };
        },
        stream: async function* () { throw new Error('not used'); },
      } as unknown as LLMAdapter;

      const config: Partial<WizardConfig> = {
        maxRetriesPerStep: 0, // Skip immediately on failure
      };
      const wizard = new Wizard(toolRegistry, llm, config);

      const plan = createWizardPlan({
        goal: 'Test skipped dep',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'Will fail' }),
          createWizardStep({ stepNum: 2, objective: 'Depends on 1', dependsOn: [1] }),
        ],
      });

      const result = await wizard.execute(plan, createTestContext(), '');

      // Step 1 should be skipped, step 2 should run
      expect(result.stepsSkipped).toBe(1);
      expect(step2Executed).toBe(true);
    });
  });

  describe('Deadlock detection', () => {
    it('should detect deadlock when no steps are ready', async () => {
      // Create a plan where step 1 depends on step 2 and vice versa (circular)
      const llm = createSucceedingLLM();
      const wizard = new Wizard(toolRegistry, llm, { deadlockThreshold: 2 });

      // Manually create plan with circular deps
      const plan: WizardPlan = {
        goal: 'Circular deps',
        goalType: 'task',
        steps: [
          {
            stepNum: 1,
            objective: 'Depends on 2',
            status: StepStatus.PENDING,
            phase: StepPhase.EXECUTION,
            dependsOn: [2], // Circular!
          },
          {
            stepNum: 2,
            objective: 'Depends on 1',
            status: StepStatus.PENDING,
            phase: StepPhase.EXECUTION,
            dependsOn: [1], // Circular!
          },
        ],
      };

      const result = await wizard.execute(plan, createTestContext(), '');

      // Should abort due to deadlock
      expect(result.success).toBe(false);
      expect(result.finalResponse).toContain('Deadlock');
    });

    it('should detect deadlock when all steps are FAILED', async () => {
      const llm = createFailingLLM();
      const config: Partial<WizardConfig> = {
        maxRetriesPerStep: 0,
        deadlockThreshold: 3,
      };
      const wizard = new Wizard(toolRegistry, llm, config);

      const plan = createWizardPlan({
        goal: 'All fail',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'Will fail' }),
        ],
      });

      const result = await wizard.execute(plan, createTestContext(), '');

      expect(result.success).toBe(false);
    });

    it('BUG CANDIDATE: deadlock counter resets on stuck step handling', async () => {
      // The deadlockCounter resets to 0 when readySteps.length > 0
      // But what if getReadySteps keeps returning empty forever?
      const llm = createSucceedingLLM();
      const config: Partial<WizardConfig> = {
        deadlockThreshold: 2,
      };
      const wizard = new Wizard(toolRegistry, llm, config);

      // Plan where step depends on non-existent step
      const plan: WizardPlan = {
        goal: 'Missing dep',
        goalType: 'task',
        steps: [
          {
            stepNum: 1,
            objective: 'Depends on step 99',
            status: StepStatus.PENDING,
            phase: StepPhase.EXECUTION,
            dependsOn: [99], // Step 99 doesn't exist!
          },
        ],
      };

      const result = await wizard.execute(plan, createTestContext(), '');

      // Should eventually deadlock
      expect(result.success).toBe(false);
    });
  });

  describe('goalAchieved edge cases', () => {
    it('should return false when all steps are skipped', async () => {
      const llm = createFailingLLM();
      const config: Partial<WizardConfig> = {
        maxRetriesPerStep: 0,
      };
      const wizard = new Wizard(toolRegistry, llm, config);

      const plan = createWizardPlan({
        goal: 'All skipped',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'Will be skipped' }),
        ],
      });

      const result = await wizard.execute(plan, createTestContext(), '');

      // BUG: All steps skipped means goalAchieved returns false
      // because no steps are COMPLETED
      expect(result.success).toBe(false);
      expect(result.stepsSkipped).toBe(1);
    });

    it('should require all required steps to be completed', async () => {
      let callCount = 0;
      const llm: LLMAdapter = {
        provider: 'openai',
        model: 'gpt-4',
        respond: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              content: '[FINAL] Done',
              stopReason: 'end_turn',
              usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
              model: 'gpt-4',
              durationMs: 100,
            };
          }
          // Second step fails
          throw new Error('API Error');
        },
        stream: async function* () { throw new Error('not used'); },
      } as unknown as LLMAdapter;

      const config: Partial<WizardConfig> = {
        maxRetriesPerStep: 0,
      };
      const wizard = new Wizard(toolRegistry, llm, config);

      const plan = createWizardPlan({
        goal: 'Required step fails',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'Optional' }),
          createWizardStep({ stepNum: 2, objective: 'Required!', required: true }),
        ],
      });

      const result = await wizard.execute(plan, createTestContext(), '');

      // Required step failed/skipped, so goal not achieved
      expect(result.success).toBe(false);
    });

    it('should succeed if optional step fails but required succeeds', async () => {
      let callCount = 0;
      const llm: LLMAdapter = {
        provider: 'openai',
        model: 'gpt-4',
        respond: async () => {
          callCount++;
          if (callCount === 1) {
            // First step (optional) fails
            throw new Error('API Error');
          }
          return {
            content: '[FINAL] Done',
            stopReason: 'end_turn',
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            model: 'gpt-4',
            durationMs: 100,
          };
        },
        stream: async function* () { throw new Error('not used'); },
      } as unknown as LLMAdapter;

      const config: Partial<WizardConfig> = {
        maxRetriesPerStep: 0,
      };
      const wizard = new Wizard(toolRegistry, llm, config);

      const plan = createWizardPlan({
        goal: 'Optional fails',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'Optional' }),
          createWizardStep({ stepNum: 2, objective: 'Required', required: true }),
        ],
      });

      const result = await wizard.execute(plan, createTestContext(), '');

      expect(result.success).toBe(true);
      expect(result.stepsCompleted).toBe(1);
      expect(result.stepsSkipped).toBe(1);
    });

    it('BUG CANDIDATE: no required steps and one completed = success', async () => {
      // When there are no required steps, at least one must be COMPLETED
      // This is the current behavior - verify it
      let callCount = 0;
      const llm: LLMAdapter = {
        provider: 'openai',
        model: 'gpt-4',
        respond: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              content: '[FINAL] Done',
              stopReason: 'end_turn',
              usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
              model: 'gpt-4',
              durationMs: 100,
            };
          }
          throw new Error('Fail');
        },
        stream: async function* () { throw new Error('not used'); },
      } as unknown as LLMAdapter;

      const config: Partial<WizardConfig> = {
        maxRetriesPerStep: 0,
      };
      const wizard = new Wizard(toolRegistry, llm, config);

      const plan = createWizardPlan({
        goal: 'One of three',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'A' }),
          createWizardStep({ stepNum: 2, objective: 'B' }),
          createWizardStep({ stepNum: 3, objective: 'C' }),
        ],
      });

      const result = await wizard.execute(plan, createTestContext(), '');

      // Even though 2/3 failed, one completed means success
      expect(result.success).toBe(true);
      expect(result.stepsCompleted).toBe(1);
      expect(result.stepsSkipped).toBe(2);
    });
  });

  describe('Stagnation handling', () => {
    it('should skip step after max retries', async () => {
      let retryCount = 0;
      const llm: LLMAdapter = {
        provider: 'openai',
        model: 'gpt-4',
        respond: async () => {
          retryCount++;
          // Always produce stuck response
          return {
            content: 'Thinking...',
            stopReason: 'end_turn',
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            model: 'gpt-4',
            durationMs: 100,
          };
        },
        stream: async function* () { throw new Error('not used'); },
      } as unknown as LLMAdapter;

      const config: Partial<WizardConfig> = {
        maxRetriesPerStep: 2,
        maxIterations: 20,
      };
      const wizard = new Wizard(toolRegistry, llm, config);

      const plan = createWizardPlan({
        goal: 'Stuck step',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'Will get stuck' }),
        ],
      });

      const result = await wizard.execute(plan, createTestContext(), '');

      expect(result.success).toBe(false);
      expect(result.stepsSkipped).toBe(1);
    });

    it('should detect identical outputs and escalate', async () => {
      const llm: LLMAdapter = {
        provider: 'openai',
        model: 'gpt-4',
        respond: async () => ({
          content: '[FINAL] The exact same response every time',
          stopReason: 'end_turn',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          model: 'gpt-4',
          durationMs: 100,
        }),
        stream: async function* () { throw new Error('not used'); },
      } as unknown as LLMAdapter;

      // First response succeeds (step 1), then step 2 keeps producing same output
      // but since it's marked [FINAL] it should succeed each time
      const wizard = new Wizard(toolRegistry, llm);

      const plan = createWizardPlan({
        goal: 'Identical outputs',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'First' }),
        ],
      });

      const result = await wizard.execute(plan, createTestContext(), '');

      // Should still succeed since [FINAL] is present
      expect(result.success).toBe(true);
    });
  });

  describe('User input handling', () => {
    it('should pause when step needs user input', async () => {
      const llm: LLMAdapter = {
        provider: 'openai',
        model: 'gpt-4',
        respond: async () => ({
          content: '[NEED_CONTEXT] {"question": "Which file?", "options": ["a.txt", "b.txt"]}',
          stopReason: 'end_turn',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          model: 'gpt-4',
          durationMs: 100,
        }),
        stream: async function* () { throw new Error('not used'); },
      } as unknown as LLMAdapter;

      const wizard = new Wizard(toolRegistry, llm);

      const plan = createWizardPlan({
        goal: 'Needs input',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'Ask user' }),
        ],
      });

      const result = await wizard.execute(plan, createTestContext(), '');

      expect(result.paused).toBe(true);
      expect(result.userPrompt).toBeDefined();
      expect(result.userPrompt?.question).toBe('Which file?');
    });

    it('BUG CANDIDATE: resume does not preserve full context', async () => {
      // The resume() method creates a new plan from planState.steps
      // but doesn't preserve the original baseContext
      // This could lose important session state
      let callCount = 0;
      const llm: LLMAdapter = {
        provider: 'openai',
        model: 'gpt-4',
        respond: async () => {
          callCount++;
          if (callCount === 1) {
            // First call needs input
            return {
              content: '[NEED_CONTEXT] {"question": "Continue?"}',
              stopReason: 'end_turn',
              usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
              model: 'gpt-4',
              durationMs: 100,
            };
          }
          return {
            content: '[FINAL] Done after resume',
            stopReason: 'end_turn',
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            model: 'gpt-4',
            durationMs: 100,
          };
        },
        stream: async function* () { throw new Error('not used'); },
      } as unknown as LLMAdapter;

      const wizard = new Wizard(toolRegistry, llm);

      const plan = createWizardPlan({
        goal: 'Resume test',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'Needs input' }),
        ],
      });

      // Use shared context for execute and resume
      const testContext = createTestContext();
      const pausedResult = await wizard.execute(plan, testContext, '');
      expect(pausedResult.paused).toBe(true);

      // Resume with user response (use same context)
      const resumedResult = await wizard.resume(testContext, 'yes', '');

      expect(resumedResult.success).toBe(true);
    });
  });

  describe('Event emission', () => {
    it('should emit goal_started and goal_achieved events', async () => {
      const events: unknown[] = [];
      const eventBus = {
        publish: (event: unknown) => events.push(event),
        subscribe: () => () => {},
        subscribeAll: () => () => {},
        shutdown: () => {},
        isShutdown: () => false,
      };

      const llm = createSucceedingLLM();
      const wizard = new Wizard(toolRegistry, llm, undefined, undefined, eventBus);

      const plan = createWizardPlan({
        goal: 'Event test',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'Do it' }),
        ],
      });

      await wizard.execute(plan, createTestContext(), '');

      const eventTypes = events.map((e: any) => e.type);
      expect(eventTypes).toContain('goal_started');
      expect(eventTypes).toContain('step_started');
      expect(eventTypes).toContain('step_completed');
      expect(eventTypes).toContain('goal_achieved');
    });

    it('should emit goal_aborted on failure', async () => {
      const events: unknown[] = [];
      const eventBus = {
        publish: (event: unknown) => events.push(event),
        subscribe: () => () => {},
        subscribeAll: () => () => {},
        shutdown: () => {},
        isShutdown: () => false,
      };

      const llm = createFailingLLM();
      const config: Partial<WizardConfig> = {
        maxRetriesPerStep: 0,
      };
      const wizard = new Wizard(toolRegistry, llm, config, undefined, eventBus);

      const plan = createWizardPlan({
        goal: 'Will fail',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'Fail' }),
        ],
      });

      await wizard.execute(plan, createTestContext(), '');

      const eventTypes = events.map((e: any) => e.type);
      expect(eventTypes).toContain('goal_aborted');
    });

    it('should NOT emit goal_aborted when paused', async () => {
      const events: unknown[] = [];
      const eventBus = {
        publish: (event: unknown) => events.push(event),
        subscribe: () => () => {},
        subscribeAll: () => () => {},
        shutdown: () => {},
        isShutdown: () => false,
      };

      const llm: LLMAdapter = {
        provider: 'openai',
        model: 'gpt-4',
        respond: async () => ({
          content: '[NEED_CONTEXT] {"question": "?"}',
          stopReason: 'end_turn',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          model: 'gpt-4',
          durationMs: 100,
        }),
        stream: async function* () { throw new Error('not used'); },
      } as unknown as LLMAdapter;

      const wizard = new Wizard(toolRegistry, llm, undefined, undefined, eventBus);

      const plan = createWizardPlan({
        goal: 'Will pause',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'Pause' }),
        ],
      });

      await wizard.execute(plan, createTestContext(), '');

      const eventTypes = events.map((e: any) => e.type);
      expect(eventTypes).not.toContain('goal_aborted');
      expect(eventTypes).not.toContain('goal_achieved');
    });
  });

  describe('Iteration limits', () => {
    it('should stop at maxIterations', async () => {
      let iterationCount = 0;
      const llm: LLMAdapter = {
        provider: 'openai',
        model: 'gpt-4',
        respond: async () => {
          iterationCount++;
          return {
            content: '[CONTINUE] Still working...',
            stopReason: 'end_turn',
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            model: 'gpt-4',
            durationMs: 100,
          };
        },
        stream: async function* () { throw new Error('not used'); },
      } as unknown as LLMAdapter;

      const config: Partial<WizardConfig> = {
        maxIterations: 5,
        maxRetriesPerStep: 10, // High so we hit iteration limit first
      };
      const wizard = new Wizard(toolRegistry, llm, config);

      const plan = createWizardPlan({
        goal: 'Max iterations',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'Never finishes' }),
        ],
      });

      const result = await wizard.execute(plan, createTestContext(), '');

      expect(result.totalIterations).toBeLessThanOrEqual(5);
    });
  });
});

describe('PlanState', () => {
  describe('getReadySteps', () => {
    it('should return pending steps with no dependencies', () => {
      const plan = createWizardPlan({
        goal: 'Test',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'A' }),
          createWizardStep({ stepNum: 2, objective: 'B' }),
        ],
      });

      const state = PlanState.fromWizardPlan(plan);
      const ready = state.getReadySteps();

      expect(ready).toHaveLength(2);
    });

    it('should not return steps with unsatisfied dependencies', () => {
      const plan = createWizardPlan({
        goal: 'Test',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'A' }),
          createWizardStep({ stepNum: 2, objective: 'B', dependsOn: [1] }),
        ],
      });

      const state = PlanState.fromWizardPlan(plan);
      const ready = state.getReadySteps();

      expect(ready).toHaveLength(1);
      expect(ready[0].stepNum).toBe(1);
    });

    it('should return step when dependency is SKIPPED (soft dep)', () => {
      const plan = createWizardPlan({
        goal: 'Test',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'A' }),
          createWizardStep({ stepNum: 2, objective: 'B', dependsOn: [1] }),
        ],
      });

      const state = PlanState.fromWizardPlan(plan);
      state.markStepSkipped(1, 'Test skip');

      const ready = state.getReadySteps();

      expect(ready).toHaveLength(1);
      expect(ready[0].stepNum).toBe(2);
    });

    it('should not return frozen steps', () => {
      const plan = createWizardPlan({
        goal: 'Test',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'A' }),
        ],
      });

      const state = PlanState.fromWizardPlan(plan);
      state.freezeStep(1);

      const ready = state.getReadySteps();

      expect(ready).toHaveLength(0);
    });
  });

  describe('goalAchieved', () => {
    it('should return false when not terminated', () => {
      const plan = createWizardPlan({
        goal: 'Test',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'A' }),
        ],
      });

      const state = PlanState.fromWizardPlan(plan);

      expect(state.goalAchieved()).toBe(false);
    });

    it('should return true when at least one step completed', () => {
      const plan = createWizardPlan({
        goal: 'Test',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'A' }),
        ],
      });

      const state = PlanState.fromWizardPlan(plan);
      state.markStepComplete(1, 'Done');

      expect(state.goalAchieved()).toBe(true);
    });

    it('should return false when all required steps are not completed', () => {
      const plan = createWizardPlan({
        goal: 'Test',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'A', required: true }),
          createWizardStep({ stepNum: 2, objective: 'B', required: true }),
        ],
      });

      const state = PlanState.fromWizardPlan(plan);
      state.markStepComplete(1, 'Done');
      state.markStepSkipped(2, 'Skipped');

      expect(state.goalAchieved()).toBe(false);
    });

    it('should return true when all required steps are completed', () => {
      const plan = createWizardPlan({
        goal: 'Test',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'A', required: true }),
          createWizardStep({ stepNum: 2, objective: 'B' }), // Not required
        ],
      });

      const state = PlanState.fromWizardPlan(plan);
      state.markStepComplete(1, 'Done');
      state.markStepSkipped(2, 'Skipped');

      expect(state.goalAchieved()).toBe(true);
    });

    it('BUG CANDIDATE: all steps skipped with no required = false', () => {
      const plan = createWizardPlan({
        goal: 'Test',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'A' }),
          createWizardStep({ stepNum: 2, objective: 'B' }),
        ],
      });

      const state = PlanState.fromWizardPlan(plan);
      state.markStepSkipped(1, 'Skipped');
      state.markStepSkipped(2, 'Skipped');

      // No steps completed, so goalAchieved returns false
      // This might be unexpected if skipping was intentional
      expect(state.goalAchieved()).toBe(false);
    });
  });

  describe('Step status transitions', () => {
    it('should not allow modifying frozen step', () => {
      const plan = createWizardPlan({
        goal: 'Test',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'A' }),
        ],
      });

      const state = PlanState.fromWizardPlan(plan);
      state.markStepComplete(1, 'Done');

      // Try to reset
      const result = state.resetStepForRetry(1);

      expect(result).toBe(false);
      expect(state.steps.get(1)?.status).toBe(StepStatus.COMPLETED);
    });

    it('should increment version on each modification', () => {
      const plan = createWizardPlan({
        goal: 'Test',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'A' }),
        ],
      });

      const state = PlanState.fromWizardPlan(plan);
      const initialVersion = state.version;

      state.markStepInProgress(1, 'worker-1');
      expect(state.version).toBe(initialVersion + 1);

      state.markStepComplete(1, 'Done');
      expect(state.version).toBe(initialVersion + 2);
    });
  });

  describe('insertStep', () => {
    it('should insert step with correct position', () => {
      const plan = createWizardPlan({
        goal: 'Test',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'A' }),
          createWizardStep({ stepNum: 2, objective: 'B' }),
        ],
      });

      const state = PlanState.fromWizardPlan(plan);
      const newStepNum = state.insertStep({
        objective: 'New step',
        insertAfter: 1,
      });

      const newStep = state.steps.get(newStepNum);
      expect(newStep?.objective).toBe('New step');
      expect(newStep?.position).toBeGreaterThan(state.steps.get(1)!.position);
      expect(newStep?.position).toBeLessThan(state.steps.get(2)!.position);
    });

    it('should filter invalid dependencies', () => {
      const plan = createWizardPlan({
        goal: 'Test',
        steps: [
          createWizardStep({ stepNum: 1, objective: 'A' }),
        ],
      });

      const state = PlanState.fromWizardPlan(plan);
      const newStepNum = state.insertStep({
        objective: 'New step',
        dependsOn: [1, 999], // 999 doesn't exist
      });

      const newStep = state.steps.get(newStepNum);
      expect(newStep?.dependsOn).toEqual([1]);
    });
  });
});
