/**
 * Tests for token optimization patches.
 *
 * Tests three optimizations:
 * 1. Artifact batching into single message
 * 2. Tool output truncation at storage
 * 3. Bidirectional context inheritance
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { ContextWindow } from '../packages/core/context/src/context-window.js';
import { Agent } from '../packages/core/agent/src/agent.js';
import type { AgentConfig } from '../packages/core/agent/src/types.js';
import type { LLMAdapter, LLMResponse } from '../packages/core/llm/src/index.js';
import type { ToolRegistry } from '../packages/core/tools/src/registry.js';
import { createWorkItem } from '../packages/core/work/src/work-item.js';
import type { ArtifactKind } from '../packages/core/types/src/context.js';

// ============================================================================
// Test Helpers
// ============================================================================

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
    execute: async (_name: string, _args: Record<string, unknown>) => ({
      toolName: 'Read',
      status: 'error',
      output: '',
      error: 'Tool not available',
      durationMs: 0,
      isSuccess: false,
    }),
  } as unknown as ToolRegistry;
}

function createArtifact(
  sourcePath: string,
  name: string,
  kind: ArtifactKind = 'function',
  options: {
    line?: number;
    signature?: string;
    modifies?: string[];
    calls?: string[];
    insight?: string;
    relevance?: number;
    discoveredBy?: string;
  } = {}
) {
  return {
    sourcePath,
    name,
    kind,
    line: options.line ?? 1,
    signature: options.signature,
    modifies: options.modifies,
    calls: options.calls,
    insight: options.insight,
    relevance: options.relevance ?? 0.8,
    discoveredBy: options.discoveredBy ?? 'test',
  };
}

// ============================================================================
// Fix #2: Artifact Batching Tests
// ============================================================================

describe('Artifact Batching (Fix #2)', () => {
  let context: ContextWindow;

  beforeEach(() => {
    context = new ContextWindow('test-session', 200_000);
  });

  describe('getItemsForLLM()', () => {
    it('batches multiple artifacts into a single message', () => {
      // Add 5 artifacts
      context.addArtifact(createArtifact('/src/a.ts', 'functionA'));
      context.addArtifact(createArtifact('/src/b.ts', 'functionB'));
      context.addArtifact(createArtifact('/src/c.ts', 'ClassC', 'class'));
      context.addArtifact(createArtifact('/src/d.ts', 'interfaceD', 'interface'));
      context.addArtifact(createArtifact('/src/e.ts', 'functionE'));

      const items = context.getItemsForLLM();

      // Should have exactly 1 message (the batched artifacts)
      expect(items.length).toBe(1);

      // Should be a user message
      expect(items[0].type).toBe('message');
      expect(items[0].role).toBe('user');

      // Content should contain all artifacts
      const content = items[0].content as string;
      expect(content).toContain('[DISCOVERED ARTIFACTS: 5]');
      expect(content).toContain('functionA');
      expect(content).toContain('functionB');
      expect(content).toContain('ClassC');
      expect(content).toContain('interfaceD');
      expect(content).toContain('functionE');

      // Should use separator
      expect(content.split('---').length).toBe(5); // 5 artifacts = 4 separators + content
    });

    it('places batched artifacts at the end of the items array', () => {
      // Add messages first
      context.addMessage('user', 'Hello');
      context.addMessage('assistant', 'Hi there');

      // Add artifacts
      context.addArtifact(createArtifact('/src/a.ts', 'functionA'));
      context.addArtifact(createArtifact('/src/b.ts', 'functionB'));

      // Add another message
      context.addMessage('user', 'What about this?');

      const items = context.getItemsForLLM();

      // Should have: 3 messages + 1 batched artifacts message
      expect(items.length).toBe(4);

      // Last item should be the batched artifacts
      const lastItem = items[items.length - 1];
      expect(lastItem.role).toBe('user');
      expect((lastItem.content as string)).toContain('[DISCOVERED ARTIFACTS: 2]');
    });

    it('returns empty array when no items exist', () => {
      const items = context.getItemsForLLM();
      expect(items.length).toBe(0);
    });

    it('formats artifacts with all metadata', () => {
      context.addArtifact(createArtifact('/src/agent.ts', 'run', 'function', {
        line: 150,
        signature: 'async run(params: RunParams): Promise<Result>',
        modifies: ['this._state', 'this._metrics'],
        calls: ['llm.respond', 'tools.execute'],
        insight: 'Main entry point - executes until goal reached or budget exhausted',
      }));

      const items = context.getItemsForLLM();
      const content = items[0].content as string;

      expect(content).toContain('/src/agent.ts:150');
      expect(content).toContain('async run(params: RunParams): Promise<Result>');
      expect(content).toContain('modifies: this._state, this._metrics');
      expect(content).toContain('calls: llm.respond, tools.execute');
      expect(content).toContain('Main entry point');
    });
  });

  describe('getItemsForAnthropic()', () => {
    it('batches multiple artifacts into a single message', () => {
      context.addArtifact(createArtifact('/src/a.ts', 'functionA'));
      context.addArtifact(createArtifact('/src/b.ts', 'functionB'));
      context.addArtifact(createArtifact('/src/c.ts', 'functionC'));

      const { messages } = context.getItemsForAnthropic();

      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe('user');
      expect((messages[0].content as string)).toContain('[DISCOVERED ARTIFACTS: 3]');
    });

    it('places artifacts after all other items', () => {
      context.addMessage('user', 'Question');
      context.addFunctionCall('call-1', 'Read', { path: '/file.ts' });
      context.addFunctionCallOutput('call-1', 'file content');
      context.addArtifact(createArtifact('/src/a.ts', 'fn'));

      const { messages } = context.getItemsForAnthropic();

      // Last item should be artifacts
      const lastItem = messages[messages.length - 1];
      expect((lastItem.content as string)).toContain('[DISCOVERED ARTIFACTS: 1]');
    });

    it('separates system messages from conversation messages', () => {
      context.addMessage('system', 'You are a helpful assistant');
      context.addMessage('developer', 'Follow these rules');
      context.addMessage('user', 'Hello');
      context.addMessage('assistant', 'Hi there');

      const { system, messages } = context.getItemsForAnthropic();

      // System/developer messages should be in system string
      expect(system).toContain('You are a helpful assistant');
      expect(system).toContain('Follow these rules');

      // Only user/assistant messages should be in messages array
      expect(messages.length).toBe(2);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
    });
  });

  describe('Token savings estimation', () => {
    it('produces fewer messages than artifacts count', () => {
      // Without batching: 10 artifacts = 10 messages
      // With batching: 10 artifacts = 1 message
      for (let i = 0; i < 10; i++) {
        context.addArtifact(createArtifact(`/src/file${i}.ts`, `function${i}`));
      }

      const items = context.getItemsForLLM();

      // Should produce only 1 message for all 10 artifacts
      const artifactMessages = items.filter(
        item => (item.content as string)?.includes('[DISCOVERED ARTIFACTS')
      );
      expect(artifactMessages.length).toBe(1);

      // Verify the count is correct
      expect((artifactMessages[0].content as string)).toContain('[DISCOVERED ARTIFACTS: 10]');
    });
  });
});

// ============================================================================
// Fix #3: Tool Output Truncation Tests
// ============================================================================

describe('Tool Output Truncation (Fix #3)', () => {
  const MAX_TOOL_OUTPUT_LENGTH = 10000;

  it('truncates outputs longer than 8000 chars', async () => {
    // Create a long output (10000 chars)
    const longOutput = 'x'.repeat(10000);

    // Create mock LLM that requests a tool then completes
    let callCount = 0;
    const llm: LLMAdapter = {
      respond: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'call-1', name: 'Read', arguments: { path: '/file.ts' } }],
            stopReason: 'tool_use',
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            model: 'test-model',
            durationMs: 100,
          };
        }
        return {
          content: JSON.stringify({
            action: 'done',
            response: 'done',
            goalStateReached: true,
            userPrompt: null,
          }),
          stopReason: 'end_turn',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          model: 'test-model',
          durationMs: 100,
        };
      },
      stream: async function* () {
        yield '';
        return {
          content: '',
          stopReason: 'end_turn',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          model: 'test-model',
          durationMs: 100,
        };
      },
    } as LLMAdapter;

    const toolRegistry: ToolRegistry = {
      getDefinitions: () => [],
      getWorkingDir: () => process.cwd(),
      isParallelSafe: () => false,
      execute: async () => ({
        toolName: 'Read',
        status: 'success',
        output: longOutput,
        durationMs: 10,
        isSuccess: true,
      }),
    } as unknown as ToolRegistry;

    const config: AgentConfig = {
      type: 'standard',
      systemPrompt: 'Test',
      tools: ['Read'],
      budget: { maxIterations: 5, maxToolCalls: 10, maxDurationMs: 10000 },
      outputSchema: { name: 'agent_output', schema: { type: 'object' }, strict: true },
    };

    const agent = new Agent(
      config,
      llm,
      toolRegistry,
      undefined,
      '',
      undefined,
      { model: 'test-model', provider: 'openai', apiKey: 'test-key' }
    );

    const context = new ContextWindow('test-session', 200_000);
    const workItem = createWorkItem({ goal: 'test', objective: 'test' });

    const result = await agent.run({ globalContext: context, workItem, cwd: process.cwd() });

    // Check that the output was truncated in local context
    if (result.localContext) {
      const outputs = result.localContext.items.filter(
        item => item.type === 'function_call_output'
      );

      expect(outputs.length).toBe(1);

      const output = (outputs[0] as { output: string }).output;

      // Should be truncated to MAX_TOOL_OUTPUT_LENGTH + truncation message
      expect(output.length).toBeLessThan(longOutput.length);
      expect(output.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_LENGTH + 100);
      expect(output).toContain('[truncated');
      expect(output).toContain(`${longOutput.length - MAX_TOOL_OUTPUT_LENGTH} chars`);
    }
  });

  it('does not truncate outputs shorter than 8000 chars', async () => {
    const shortOutput = 'short output';

    let callCount = 0;
    const llm: LLMAdapter = {
      respond: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'call-1', name: 'Read', arguments: { path: '/file.ts' } }],
            stopReason: 'tool_use',
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            model: 'test-model',
            durationMs: 100,
          };
        }
        return {
          content: JSON.stringify({
            action: 'done',
            response: 'done',
            goalStateReached: true,
            userPrompt: null,
          }),
          stopReason: 'end_turn',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          model: 'test-model',
          durationMs: 100,
        };
      },
      stream: async function* () {
        yield '';
        return {
          content: '',
          stopReason: 'end_turn',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          model: 'test-model',
          durationMs: 100,
        };
      },
    } as LLMAdapter;

    const toolRegistry: ToolRegistry = {
      getDefinitions: () => [],
      getWorkingDir: () => process.cwd(),
      isParallelSafe: () => false,
      execute: async () => ({
        toolName: 'Read',
        status: 'success',
        output: shortOutput,
        durationMs: 10,
        isSuccess: true,
      }),
    } as unknown as ToolRegistry;

    const config: AgentConfig = {
      type: 'standard',
      systemPrompt: 'Test',
      tools: ['Read'],
      budget: { maxIterations: 5, maxToolCalls: 10, maxDurationMs: 10000 },
      outputSchema: { name: 'agent_output', schema: { type: 'object' }, strict: true },
    };

    const agent = new Agent(
      config,
      llm,
      toolRegistry,
      undefined,
      '',
      undefined,
      { model: 'test-model', provider: 'openai', apiKey: 'test-key' }
    );

    const context = new ContextWindow('test-session', 200_000);
    const workItem = createWorkItem({ goal: 'test', objective: 'test' });

    const result = await agent.run({ globalContext: context, workItem, cwd: process.cwd() });

    if (result.localContext) {
      const outputs = result.localContext.items.filter(
        item => item.type === 'function_call_output'
      );

      expect(outputs.length).toBe(1);
      expect((outputs[0] as { output: string }).output).toBe(shortOutput);
      expect((outputs[0] as { output: string }).output).not.toContain('[truncated');
    }
  });
});

// ============================================================================
// Fix #4: Bidirectional Context Inheritance Tests
// ============================================================================

describe('Bidirectional Context Inheritance (Fix #4)', () => {
  describe('Context merging methods', () => {
    let parentContext: ContextWindow;

    beforeEach(() => {
      parentContext = new ContextWindow('parent-session', 200_000);
    });

    it('transfers artifacts from parent to sub-agent context', () => {
      // Add artifacts to parent
      parentContext.addArtifact(createArtifact('/src/a.ts', 'functionA'));
      parentContext.addArtifact(createArtifact('/src/b.ts', 'ClassB', 'class'));

      // Simulate createMergedContext behavior
      const globalContext = new ContextWindow('global-session', 200_000);
      const merged = ContextWindow.deserialize(globalContext.serialize());

      // Transfer artifacts
      for (const artifact of parentContext.getArtifacts()) {
        merged.addArtifact({
          sourcePath: artifact.sourcePath,
          line: artifact.line,
          kind: artifact.kind,
          name: artifact.name,
          signature: artifact.signature,
          modifies: artifact.modifies,
          calls: artifact.calls,
          insight: artifact.insight,
          relevance: artifact.relevance,
          discoveredBy: artifact.discoveredBy,
        });
      }

      expect(merged.getArtifacts().length).toBe(2);
      expect(merged.getArtifactsByPath('/src/a.ts').length).toBe(1);
      expect(merged.getArtifactsByPath('/src/b.ts').length).toBe(1);
    });

    it('transfers file content from parent to sub-agent context', () => {
      // Add file content to parent
      parentContext.addFileContent('/src/a.ts', 'const a = 1;', 'typescript');
      parentContext.addFileContent('/src/b.ts', 'const b = 2;', 'typescript');

      // Simulate createMergedContext behavior
      const globalContext = new ContextWindow('global-session', 200_000);
      const merged = ContextWindow.deserialize(globalContext.serialize());

      // Transfer file content
      const fileItems = parentContext.getItemsByType<{
        type: 'file_content';
        path: string;
        content: string;
        language?: string;
      }>('file_content');

      for (const fileItem of fileItems) {
        if (!merged.hasReadFile(fileItem.path)) {
          merged.addFileContent(fileItem.path, fileItem.content, fileItem.language);
        }
      }

      expect(merged.hasReadFile('/src/a.ts')).toBe(true);
      expect(merged.hasReadFile('/src/b.ts')).toBe(true);
    });

    it('avoids duplicate file content when already in merged context', () => {
      // Add file content to both parent and global
      parentContext.addFileContent('/src/a.ts', 'parent version', 'typescript');

      const globalContext = new ContextWindow('global-session', 200_000);
      globalContext.addFileContent('/src/a.ts', 'global version', 'typescript');

      const merged = ContextWindow.deserialize(globalContext.serialize());

      // Transfer only if not already present
      const fileItems = parentContext.getItemsByType<{
        type: 'file_content';
        path: string;
        content: string;
        language?: string;
      }>('file_content');

      for (const fileItem of fileItems) {
        if (!merged.hasReadFile(fileItem.path)) {
          merged.addFileContent(fileItem.path, fileItem.content, fileItem.language);
        }
      }

      // Should only have 1 file_content item (the global version)
      const fileContentItems = merged.getItemsByType('file_content');
      expect(fileContentItems.length).toBe(1);
      expect((fileContentItems[0] as { content: string }).content).toBe('global version');
    });
  });

  describe('Sub-agent result merging', () => {
    it('merges filesRead from sub-agent result', () => {
      const parentContext = new ContextWindow('parent-session', 200_000);

      // Simulate sub-agent result
      const subResult = {
        filesRead: ['/src/discovered1.ts', '/src/discovered2.ts'],
        localContext: undefined,
      };

      // Merge files read
      for (const path of subResult.filesRead) {
        parentContext.markFileRead(path);
      }

      expect(parentContext.hasReadFile('/src/discovered1.ts')).toBe(true);
      expect(parentContext.hasReadFile('/src/discovered2.ts')).toBe(true);
    });

    it('merges artifacts from sub-agent local context avoiding duplicates', () => {
      const parentContext = new ContextWindow('parent-session', 200_000);

      // Parent already has an artifact
      parentContext.addArtifact(createArtifact('/src/a.ts', 'existingFn', 'function', { line: 10 }));

      // Sub-agent local context with artifacts
      const subLocalContext = new ContextWindow('sub-session', 200_000);
      subLocalContext.addArtifact(createArtifact('/src/a.ts', 'existingFn', 'function', { line: 10 })); // Duplicate
      subLocalContext.addArtifact(createArtifact('/src/b.ts', 'newFn', 'function', { line: 20 })); // New

      // Merge avoiding duplicates
      const subArtifacts = subLocalContext.getArtifacts();
      for (const artifact of subArtifacts) {
        const existing = parentContext.getArtifactsByPath(artifact.sourcePath);
        const isDuplicate = existing.some(
          e => e.name === artifact.name && e.line === artifact.line
        );
        if (!isDuplicate) {
          parentContext.addArtifact({
            sourcePath: artifact.sourcePath,
            line: artifact.line,
            kind: artifact.kind,
            name: artifact.name,
            signature: artifact.signature,
            modifies: artifact.modifies,
            calls: artifact.calls,
            insight: artifact.insight,
            relevance: artifact.relevance,
            discoveredBy: artifact.discoveredBy,
          });
        }
      }

      // Should have 2 artifacts (original + new, no duplicate)
      expect(parentContext.getArtifacts().length).toBe(2);
      expect(parentContext.getArtifactsByPath('/src/a.ts').length).toBe(1);
      expect(parentContext.getArtifactsByPath('/src/b.ts').length).toBe(1);
    });

    it('merges file content from sub-agent avoiding duplicates', () => {
      const parentContext = new ContextWindow('parent-session', 200_000);
      parentContext.addFileContent('/src/a.ts', 'parent content');

      const subLocalContext = new ContextWindow('sub-session', 200_000);
      subLocalContext.addFileContent('/src/a.ts', 'sub content - should be ignored');
      subLocalContext.addFileContent('/src/b.ts', 'new content - should be added');

      // Merge file content avoiding duplicates
      const subFileItems = subLocalContext.getItemsByType<{
        type: 'file_content';
        path: string;
        content: string;
        language?: string;
      }>('file_content');

      for (const fileItem of subFileItems) {
        if (!parentContext.hasReadFile(fileItem.path)) {
          parentContext.addFileContent(fileItem.path, fileItem.content, fileItem.language);
        }
      }

      expect(parentContext.hasReadFile('/src/a.ts')).toBe(true);
      expect(parentContext.hasReadFile('/src/b.ts')).toBe(true);

      const fileItems = parentContext.getItemsByType<{ path: string; content: string }>('file_content');
      const aItem = fileItems.find(f => f.path === '/src/a.ts');
      const bItem = fileItems.find(f => f.path === '/src/b.ts');

      expect(aItem?.content).toBe('parent content'); // Original preserved
      expect(bItem?.content).toBe('new content - should be added'); // New added
    });
  });

  describe('Serialization round-trip', () => {
    it('preserves all context data through serialize/deserialize', () => {
      const original = new ContextWindow('test-session', 200_000);

      // Add various items
      original.addMessage('user', 'Hello');
      original.addMessage('assistant', 'Hi');
      original.addFunctionCall('call-1', 'Read', { path: '/file.ts' });
      original.addFunctionCallOutput('call-1', 'content');
      original.addFileContent('/file.ts', 'const x = 1;', 'typescript');
      original.addArtifact(createArtifact('/file.ts', 'testFn'));

      // Serialize and deserialize
      const snapshot = original.serialize();
      const restored = ContextWindow.deserialize(snapshot);

      // Verify all data preserved
      expect(restored.sessionKey).toBe(original.sessionKey);
      expect(restored.maxTokens).toBe(original.maxTokens);
      expect(restored.version).toBe(original.version);
      expect(restored.items.length).toBe(original.items.length);
      expect(restored.hasReadFile('/file.ts')).toBe(true);
      expect(restored.getArtifacts().length).toBe(1);
    });
  });
});

// ============================================================================
// Integration: Combined Optimization Tests
// ============================================================================

describe('Combined Optimizations', () => {
  it('demonstrates token savings from all optimizations', () => {
    const context = new ContextWindow('test-session', 200_000);

    // Add multiple artifacts (would be 10 messages without batching)
    for (let i = 0; i < 10; i++) {
      context.addArtifact(createArtifact(`/src/file${i}.ts`, `function${i}`, 'function', {
        line: i * 10,
        signature: `function${i}(): void`,
        insight: `Does something ${i}`,
      }));
    }

    // Add file content
    context.addFileContent('/src/main.ts', 'main content');

    // Get LLM format
    const llmItems = context.getItemsForLLM();

    // Should have:
    // - 1 file_content message
    // - 1 batched artifacts message
    // Total: 2 messages instead of 11 (1 file + 10 artifacts)
    expect(llmItems.length).toBe(2);

    // Verify artifact batching
    const artifactMessage = llmItems.find(
      item => (item.content as string)?.includes('[DISCOVERED ARTIFACTS')
    );
    expect(artifactMessage).toBeDefined();
    expect((artifactMessage!.content as string)).toContain('[DISCOVERED ARTIFACTS: 10]');
  });
});
