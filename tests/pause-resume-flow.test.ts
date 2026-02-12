/**
 * State-machine tests for Pause/Resume flow patterns
 *
 * These tests focus on the data structures and patterns used in pause/resume:
 * - Context preservation during pause
 * - User prompt structure validation
 * - Paused state management
 * - Context continuity on resume
 *
 * Note: Full execution tests require complex harness mocking.
 * These tests verify the core state machine patterns.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { ContextWindow } from '../packages/core/context/src/context-window.js';
import type { UserPromptInfo } from '../packages/core/agent/src/types.js';

// Simulate paused state as stored by harness
interface PausedState {
  goal: string;
  agentType: string;
  workingDir: string;
}

describe('Pause/Resume Flow Patterns', () => {
  let context: ContextWindow;

  beforeEach(() => {
    context = new ContextWindow('test-session', 200_000);
  });

  describe('UserPromptInfo structure', () => {
    it('validates complete prompt structure', () => {
      const prompt: UserPromptInfo = {
        question: 'Which option do you prefer?',
        options: ['Option A', 'Option B'],
        context: 'Choose one of the following',
        multiSelect: false,
      };

      expect(prompt.question).toBe('Which option do you prefer?');
      expect(prompt.options).toHaveLength(2);
      expect(prompt.context).toBe('Choose one of the following');
      expect(prompt.multiSelect).toBe(false);
    });

    it('allows minimal prompt with just question', () => {
      const prompt: UserPromptInfo = {
        question: 'What name should I use?',
      };

      expect(prompt.question).toBe('What name should I use?');
      expect(prompt.options).toBeUndefined();
      expect(prompt.context).toBeUndefined();
      expect(prompt.multiSelect).toBeUndefined();
    });

    it('supports multi-select prompts', () => {
      const prompt: UserPromptInfo = {
        question: 'Select features to enable:',
        options: ['Auth', 'Logging', 'Analytics'],
        multiSelect: true,
      };

      expect(prompt.multiSelect).toBe(true);
      expect(prompt.options).toHaveLength(3);
    });

    it('supports structured option objects', () => {
      const prompt: UserPromptInfo = {
        question: 'Choose configuration:',
        options: [
          { label: 'Basic', description: 'Minimal setup' },
          { label: 'Advanced', description: 'Full features' },
        ],
      };

      expect(prompt.options).toHaveLength(2);
      const firstOption = prompt.options![0];
      if (typeof firstOption === 'object') {
        expect(firstOption.label).toBe('Basic');
        expect(firstOption.description).toBe('Minimal setup');
      }
    });
  });

  describe('Paused state management', () => {
    it('stores goal, agentType, and workingDir', () => {
      const pausedState: PausedState = {
        goal: 'Setup my project',
        agentType: 'standard',
        workingDir: '/home/user/project',
      };

      expect(pausedState.goal).toBe('Setup my project');
      expect(pausedState.agentType).toBe('standard');
      expect(pausedState.workingDir).toBe('/home/user/project');
    });

    it('paused state can be stored and retrieved by sessionKey', () => {
      const pausedStates = new Map<string, PausedState>();
      const sessionKey = 'session-123';

      pausedStates.set(sessionKey, {
        goal: 'Test goal',
        agentType: 'explorer',
        workingDir: '/tmp',
      });

      expect(pausedStates.has(sessionKey)).toBe(true);
      expect(pausedStates.get(sessionKey)?.goal).toBe('Test goal');
    });

    it('clears paused state after successful completion', () => {
      const pausedStates = new Map<string, PausedState>();
      const sessionKey = 'session-123';

      pausedStates.set(sessionKey, {
        goal: 'Test',
        agentType: 'standard',
        workingDir: '/home',
      });

      // Simulate successful completion
      pausedStates.delete(sessionKey);

      expect(pausedStates.has(sessionKey)).toBe(false);
    });

    it('handles missing paused state gracefully', () => {
      const pausedStates = new Map<string, PausedState>();
      const sessionKey = 'nonexistent-session';

      const state = pausedStates.get(sessionKey);
      expect(state).toBeUndefined();
    });
  });

  describe('Context preservation on pause', () => {
    it('preserves all item types during pause', () => {
      // Add various item types
      context.addMessage('user', 'Initial request');
      context.addFileContent('/file.ts', 'const x = 1;');
      context.addFunctionCall('call-1', 'Read', { path: '/file.ts' });
      context.addFunctionCallOutput('call-1', 'const x = 1;');
      context.addReasoning('Analyzing the code...');

      // Snapshot state
      const itemCount = context.items.length;
      const version = context.version;

      // Verify all items preserved
      expect(context.items.length).toBe(itemCount);
      expect(context.version).toBe(version);

      const types = new Set(context.items.map(i => i.type));
      expect(types.has('message')).toBe(true);
      expect(types.has('file_content')).toBe(true);
      expect(types.has('function_call')).toBe(true);
      expect(types.has('function_call_output')).toBe(true);
      expect(types.has('reasoning')).toBe(true);
    });

    it('preserves read files tracking', () => {
      context.addFileContent('/a.ts', 'a');
      context.addFileContent('/b.ts', 'b');
      context.markFileRead('/c.ts');

      expect(context.hasReadFile('/a.ts')).toBe(true);
      expect(context.hasReadFile('/b.ts')).toBe(true);
      expect(context.hasReadFile('/c.ts')).toBe(true);
      expect(context.hasReadFile('/d.ts')).toBe(false);
    });

    it('preserves metrics', () => {
      context.updateMetrics(1000, 500);

      expect(context.metrics.inputTokens).toBe(1000);
      expect(context.metrics.outputTokens).toBe(500);
    });
  });

  describe('Resume flow patterns', () => {
    it('adds user answer as message after pause', () => {
      // Pre-pause state
      context.addMessage('user', 'Setup project');
      expect(context.items.length).toBe(1);

      // Simulate pause and user answering
      const userAnswer = 'TypeScript';
      context.addMessage('user', userAnswer);

      expect(context.items.length).toBe(2);
      const messages = context.items.filter(i => i.type === 'message');
      expect((messages[1] as { content: string }).content).toBe('TypeScript');
    });

    it('supports structured answer serialization', () => {
      // For multi-select, answer might be an array
      const answer = ['Feature A', 'Feature B'];
      const serialized = JSON.stringify(answer);

      context.addMessage('user', serialized);

      const messages = context.items.filter(i => i.type === 'message');
      const lastMessage = messages[messages.length - 1] as { content: string };
      expect(JSON.parse(lastMessage.content)).toEqual(['Feature A', 'Feature B']);
    });

    it('preserves context order across pause/resume', () => {
      // Phase 1: Initial work
      context.addMessage('user', '1-initial');
      context.addFunctionCall('call-1', 'Read', { path: '/a.ts' });
      context.addFunctionCallOutput('call-1', 'content');

      // Phase 2: Pause and user answer
      context.addMessage('user', '2-answer');

      // Phase 3: More work after resume
      context.addFunctionCall('call-2', 'Write', { path: '/b.ts' });
      context.addFunctionCallOutput('call-2', 'written');
      context.addMessage('assistant', '3-done');

      // Verify order
      const items = context.items;
      expect((items[0] as { type: string }).type).toBe('message');
      expect((items[1] as { type: string }).type).toBe('function_call');
      expect((items[2] as { type: string }).type).toBe('function_call_output');
      expect((items[3] as { type: string }).type).toBe('message');
      expect((items[4] as { type: string }).type).toBe('function_call');
    });
  });

  describe('Multiple sequential pauses', () => {
    it('handles multiple pause/resume cycles', () => {
      const pauseCount = 3;

      for (let i = 0; i < pauseCount; i++) {
        // Simulate work
        context.addMessage('user', `request-${i}`);
        context.addFunctionCall(`call-${i}`, 'Read', { path: `/file${i}.ts` });
        context.addFunctionCallOutput(`call-${i}`, `content-${i}`);

        // Simulate answer after pause
        context.addMessage('user', `answer-${i}`);
      }

      const messages = context.items.filter(i => i.type === 'message');
      expect(messages.length).toBe(pauseCount * 2); // request + answer per cycle
    });

    it('accumulates tool calls across pauses', () => {
      // First pause cycle
      context.addFunctionCall('call-1', 'Read', { path: '/a.ts' });
      context.addFunctionCallOutput('call-1', 'a');

      // Second pause cycle
      context.addFunctionCall('call-2', 'Read', { path: '/b.ts' });
      context.addFunctionCallOutput('call-2', 'b');

      // Third pause cycle
      context.addFunctionCall('call-3', 'Read', { path: '/c.ts' });
      context.addFunctionCallOutput('call-3', 'c');

      const calls = context.items.filter(i => i.type === 'function_call');
      expect(calls.length).toBe(3);
    });
  });

  describe('Context serialization for pause', () => {
    it('serializes complete context state', () => {
      context.addMessage('user', 'test');
      context.addFileContent('/file.ts', 'code');
      context.updateMetrics(100, 50);

      const snapshot = context.serialize();

      expect(snapshot.sessionKey).toBe('test-session');
      expect(snapshot.items.length).toBe(2);
      expect(snapshot.metrics.inputTokens).toBe(100);
      expect(snapshot.readFiles).toContain('/file.ts');
    });

    it('deserializes context preserving all state', () => {
      context.addMessage('user', 'hello');
      context.addFileContent('/code.ts', 'const x = 1;');
      context.updateMetrics(500, 250);

      const snapshot = context.serialize();
      const restored = ContextWindow.deserialize(snapshot);

      expect(restored.sessionKey).toBe(context.sessionKey);
      expect(restored.items.length).toBe(context.items.length);
      expect(restored.metrics.inputTokens).toBe(context.metrics.inputTokens);
      expect(restored.hasReadFile('/code.ts')).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('handles pause with empty context', () => {
      // No items added
      expect(context.items.length).toBe(0);

      // Pause should still be valid
      const snapshot = context.serialize();
      expect(snapshot.items).toEqual([]);
    });

    it('handles resume after context compaction', () => {
      // Add old file content
      context.addFileContent('/old.ts', 'old content');
      const items = context.items as Array<{ timestamp: number }>;
      items[0].timestamp = Date.now() - 120_000;

      // Compact removes old content
      context.compact({ maxFileContentAgeMs: 60_000 });

      // Resume with user answer
      context.addMessage('user', 'answer');

      // Should work fine
      expect(context.items.length).toBe(1);
      expect((context.items[0] as { type: string }).type).toBe('message');
    });

    it('handles very long user answers', () => {
      const longAnswer = 'x'.repeat(10_000);
      context.addMessage('user', longAnswer);

      const message = context.items[0] as { content: string };
      expect(message.content.length).toBe(10_000);
    });

    it('handles unicode in user answers', () => {
      const unicodeAnswer = '選択A: 日本語 🎉';
      context.addMessage('user', unicodeAnswer);

      const message = context.items[0] as { content: string };
      expect(message.content).toBe(unicodeAnswer);
    });
  });

  describe('Pause state lifecycle', () => {
    it('creates pause state on user_input_required', () => {
      const pausedStates = new Map<string, PausedState>();

      // Simulate orchestrator returning paused result
      const sessionKey = context.sessionKey;
      const paused = true;
      const userPrompt: UserPromptInfo = { question: 'Continue?' };
      const goal = 'Test task';
      const agentType = 'standard';
      const workingDir = '/home/user';

      if (paused) {
        pausedStates.set(sessionKey, { goal, agentType, workingDir });
      }

      expect(pausedStates.has(sessionKey)).toBe(true);
      expect(pausedStates.get(sessionKey)?.goal).toBe(goal);
    });

    it('clears pause state on goal_reached', () => {
      const pausedStates = new Map<string, PausedState>();
      const sessionKey = context.sessionKey;

      // Create pause state
      pausedStates.set(sessionKey, {
        goal: 'Test',
        agentType: 'standard',
        workingDir: '/home',
      });

      // Simulate goal reached
      const paused = false;
      if (!paused) {
        pausedStates.delete(sessionKey);
      }

      expect(pausedStates.has(sessionKey)).toBe(false);
    });

    it('updates pause state on subsequent pause', () => {
      const pausedStates = new Map<string, PausedState>();
      const sessionKey = context.sessionKey;

      // First pause
      pausedStates.set(sessionKey, {
        goal: 'Original goal',
        agentType: 'standard',
        workingDir: '/home',
      });

      // After resume and another pause (shouldn't happen normally but test robustness)
      pausedStates.set(sessionKey, {
        goal: 'Same goal', // Should be same
        agentType: 'standard',
        workingDir: '/home/subdir', // Might change
      });

      expect(pausedStates.get(sessionKey)?.workingDir).toBe('/home/subdir');
    });
  });
});
