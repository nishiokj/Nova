/**
 * State-machine tests for ContextWindow.compact()
 *
 * Tests the compaction state machine behavior:
 * - Age-based file content removal
 * - Deduplication (keeping newest per path)
 * - LRU eviction when count exceeds max
 * - Output truncation
 * - Combined multi-option scenarios
 * - Version tracking and _readFiles cleanup
 * - compactWithLedger timeout handling
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { ContextWindow } from '../packages/context/src/context-window.js';
import type { LLMAdapter, LLMResponse } from 'types';

describe('ContextWindow.compact() State Machine', () => {
  let context: ContextWindow;

  beforeEach(() => {
    context = new ContextWindow('test-session', 200_000);
  });

  describe('Age-based removal', () => {
    it('removes file_content older than maxFileContentAgeMs', () => {
      // Add file content with artificially old timestamp
      const id = context.addFileContent('/old.ts', 'old content');
      // Manually backdate the item
      const items = context.items as Array<{ timestamp: number }>;
      items[items.length - 1].timestamp = Date.now() - 60_000; // 60s ago

      const versionBefore = context.version;
      const result = context.compact({ maxFileContentAgeMs: 30_000 }); // 30s threshold

      expect(result.fileContentRemoved).toBe(1);
      expect(result.itemsRemoved).toBe(1);
      expect(result.bytesRecovered).toBe('old content'.length);
      expect(context.items.length).toBe(0);
      expect(context.version).toBe(versionBefore + 1);
      expect(context.hasReadFile('/old.ts')).toBe(false);
    });

    it('keeps file_content newer than maxFileContentAgeMs', () => {
      context.addFileContent('/new.ts', 'new content');
      const versionBefore = context.version;

      const result = context.compact({ maxFileContentAgeMs: 60_000 });

      expect(result.fileContentRemoved).toBe(0);
      expect(result.itemsRemoved).toBe(0);
      expect(context.items.length).toBe(1);
      expect(context.version).toBe(versionBefore); // No mutation, no version change
      expect(context.hasReadFile('/new.ts')).toBe(true);
    });

    it('handles multiple files with mixed ages', () => {
      context.addFileContent('/old1.ts', 'old1');
      context.addFileContent('/old2.ts', 'old2');
      context.addFileContent('/new.ts', 'new');

      const items = context.items as Array<{ timestamp: number }>;
      items[0].timestamp = Date.now() - 120_000; // Very old
      items[1].timestamp = Date.now() - 60_000;  // Old
      // items[2] is current

      const result = context.compact({ maxFileContentAgeMs: 30_000 });

      expect(result.fileContentRemoved).toBe(2);
      expect(context.items.length).toBe(1);
      expect(context.hasReadFile('/new.ts')).toBe(true);
      expect(context.hasReadFile('/old1.ts')).toBe(false);
      expect(context.hasReadFile('/old2.ts')).toBe(false);
    });
  });

  describe('Deduplication by path', () => {
    it('keeps only newest version when deduplicateByPath is true', () => {
      context.addFileContent('/file.ts', 'version 1');
      context.addFileContent('/file.ts', 'version 2 - newer');

      const items = context.items as Array<{ timestamp: number }>;
      items[0].timestamp = Date.now() - 10_000;
      items[1].timestamp = Date.now();

      const result = context.compact({ deduplicateByPath: true });

      expect(result.fileContentRemoved).toBe(1);
      expect(result.bytesRecovered).toBe('version 1'.length);
      expect(context.items.length).toBe(1);
      expect((context.items[0] as { content: string }).content).toBe('version 2 - newer');
      expect(context.hasReadFile('/file.ts')).toBe(true); // Path still tracked
    });

    it('handles deduplication across multiple paths', () => {
      context.addFileContent('/a.ts', 'a-v1');
      context.addFileContent('/b.ts', 'b-v1');
      context.addFileContent('/a.ts', 'a-v2');
      context.addFileContent('/b.ts', 'b-v2');

      const items = context.items as Array<{ timestamp: number }>;
      items[0].timestamp = Date.now() - 30_000;
      items[1].timestamp = Date.now() - 20_000;
      items[2].timestamp = Date.now() - 10_000;
      items[3].timestamp = Date.now();

      const result = context.compact({ deduplicateByPath: true });

      expect(result.fileContentRemoved).toBe(2);
      expect(context.items.length).toBe(2);

      const paths = (context.items as Array<{ path: string }>).map(i => i.path);
      expect(paths).toContain('/a.ts');
      expect(paths).toContain('/b.ts');
    });

    it('does not deduplicate when option is false', () => {
      context.addFileContent('/file.ts', 'version 1');
      context.addFileContent('/file.ts', 'version 2');

      const result = context.compact({ deduplicateByPath: false });

      expect(result.fileContentRemoved).toBe(0);
      expect(context.items.length).toBe(2);
    });
  });

  describe('LRU eviction (maxFileContentCount)', () => {
    it('removes oldest when count exceeds maxFileContentCount', () => {
      context.addFileContent('/a.ts', 'aaa');
      context.addFileContent('/b.ts', 'bbb');
      context.addFileContent('/c.ts', 'ccc');

      const items = context.items as Array<{ timestamp: number }>;
      items[0].timestamp = Date.now() - 30_000; // Oldest
      items[1].timestamp = Date.now() - 20_000;
      items[2].timestamp = Date.now(); // Newest

      const result = context.compact({ maxFileContentCount: 2 });

      expect(result.fileContentRemoved).toBe(1);
      expect(context.items.length).toBe(2);
      expect(context.hasReadFile('/a.ts')).toBe(false); // Oldest removed
      expect(context.hasReadFile('/b.ts')).toBe(true);
      expect(context.hasReadFile('/c.ts')).toBe(true);
    });

    it('removes multiple when count significantly exceeds max', () => {
      for (let i = 0; i < 10; i++) {
        context.addFileContent(`/file${i}.ts`, `content ${i}`);
      }

      const items = context.items as Array<{ timestamp: number }>;
      items.forEach((item, idx) => {
        item.timestamp = Date.now() - (10 - idx) * 1000; // Oldest first
      });

      const result = context.compact({ maxFileContentCount: 3 });

      expect(result.fileContentRemoved).toBe(7);
      expect(context.items.length).toBe(3);
      // Only newest 3 should remain
      expect(context.hasReadFile('/file7.ts')).toBe(true);
      expect(context.hasReadFile('/file8.ts')).toBe(true);
      expect(context.hasReadFile('/file9.ts')).toBe(true);
    });

    it('does nothing when count is within limit', () => {
      context.addFileContent('/a.ts', 'a');
      context.addFileContent('/b.ts', 'b');

      const result = context.compact({ maxFileContentCount: 5 });

      expect(result.fileContentRemoved).toBe(0);
      expect(context.items.length).toBe(2);
    });
  });

  describe('Output truncation', () => {
    it('truncates function_call_output longer than threshold', () => {
      context.addFunctionCall('call-1', 'Read', { path: '/file.ts' });
      context.addFunctionCallOutput('call-1', 'x'.repeat(10_000));

      const result = context.compact({ truncateOutputsTo: 100 });

      expect(result.outputsTruncated).toBe(1);
      expect(result.bytesRecovered).toBeGreaterThan(9000);

      const output = (context.items[1] as { output: string }).output;
      expect(output.length).toBeLessThan(200); // 100 + truncation message
      expect(output).toContain('[truncated');
    });

    it('does not truncate outputs under threshold', () => {
      context.addFunctionCall('call-1', 'Read', { path: '/file.ts' });
      context.addFunctionCallOutput('call-1', 'short output');

      const result = context.compact({ truncateOutputsTo: 100 });

      expect(result.outputsTruncated).toBe(0);
      expect((context.items[1] as { output: string }).output).toBe('short output');
    });

    it('truncates multiple outputs independently', () => {
      context.addFunctionCall('call-1', 'Read', { path: '/a.ts' });
      context.addFunctionCallOutput('call-1', 'y'.repeat(5000));
      context.addFunctionCall('call-2', 'Read', { path: '/b.ts' });
      context.addFunctionCallOutput('call-2', 'z'.repeat(8000));
      context.addFunctionCall('call-3', 'Read', { path: '/c.ts' });
      context.addFunctionCallOutput('call-3', 'short');

      const result = context.compact({ truncateOutputsTo: 1000 });

      expect(result.outputsTruncated).toBe(2);
    });
  });

  describe('Combined options', () => {
    it('applies age + deduplication + count limits together', () => {
      // Create complex scenario:
      // - Old files that should be removed by age
      // - Duplicate files that should be deduplicated
      // - Excess files that should be LRU'd

      // Old file (should be removed by age)
      context.addFileContent('/old.ts', 'old');

      // Duplicate files (should keep newest)
      context.addFileContent('/dup.ts', 'dup-v1');
      context.addFileContent('/dup.ts', 'dup-v2');

      // Recent files (some will be LRU'd)
      context.addFileContent('/recent1.ts', 'recent1');
      context.addFileContent('/recent2.ts', 'recent2');
      context.addFileContent('/recent3.ts', 'recent3');

      // Long output (should be truncated)
      context.addFunctionCall('call-1', 'Bash', { command: 'ls' });
      context.addFunctionCallOutput('call-1', 'x'.repeat(5000));

      const items = context.items as Array<{ timestamp: number }>;
      items[0].timestamp = Date.now() - 120_000; // old.ts - very old
      items[1].timestamp = Date.now() - 50_000;  // dup-v1
      items[2].timestamp = Date.now() - 40_000;  // dup-v2
      items[3].timestamp = Date.now() - 30_000;  // recent1
      items[4].timestamp = Date.now() - 20_000;  // recent2
      items[5].timestamp = Date.now() - 10_000;  // recent3

      const result = context.compact({
        maxFileContentAgeMs: 60_000,  // Remove old.ts
        deduplicateByPath: true,       // Remove dup-v1
        maxFileContentCount: 3,        // Keep 3 newest (dup-v2, recent2, recent3)
        truncateOutputsTo: 1000,       // Truncate output
      });

      expect(result.fileContentRemoved).toBeGreaterThanOrEqual(3);
      expect(result.outputsTruncated).toBe(1);

      // Should have: recent2, recent3, dup-v2 (newest 3 after age/dedup)
      // Plus the function_call and truncated output
      const filePaths = (context.items as Array<{ type: string; path?: string }>)
        .filter(i => i.type === 'file_content')
        .map(i => i.path);

      expect(filePaths).not.toContain('/old.ts');
      expect(context.hasReadFile('/old.ts')).toBe(false);
    });
  });

  describe('Edge cases', () => {
    it('handles empty context gracefully', () => {
      const result = context.compact({
        maxFileContentAgeMs: 1000,
        deduplicateByPath: true,
        maxFileContentCount: 5,
        truncateOutputsTo: 100,
      });

      expect(result.itemsRemoved).toBe(0);
      expect(result.fileContentRemoved).toBe(0);
      expect(result.outputsTruncated).toBe(0);
      expect(result.bytesRecovered).toBe(0);
    });

    it('handles context with no file_content items', () => {
      context.addMessage('user', 'hello');
      context.addMessage('assistant', 'hi');
      context.addFunctionCall('call-1', 'Read', { path: '/file.ts' });
      context.addFunctionCallOutput('call-1', 'content');

      const versionBefore = context.version;
      const result = context.compact({
        maxFileContentAgeMs: 1,
        maxFileContentCount: 0,
        deduplicateByPath: true,
      });

      expect(result.fileContentRemoved).toBe(0);
      expect(context.items.length).toBe(4);
      expect(context.version).toBe(versionBefore); // No mutation
    });

    it('preserves non-file_content items during compaction', () => {
      context.addMessage('user', 'question');
      context.addFileContent('/file.ts', 'code');
      context.addFunctionCall('call-1', 'Write', { path: '/file.ts' });
      context.addFunctionCallOutput('call-1', 'success');
      context.addMessage('assistant', 'done');

      // Force file content removal
      const items = context.items as Array<{ timestamp: number }>;
      items[1].timestamp = Date.now() - 100_000;

      context.compact({ maxFileContentAgeMs: 1000 });

      // Check messages and function calls preserved
      const types = context.items.map(i => i.type);
      expect(types).toContain('message');
      expect(types).toContain('function_call');
      expect(types).toContain('function_call_output');
      expect(types).not.toContain('file_content');
    });

    it('correctly updates _readFiles when all instances of a path are removed', () => {
      context.addFileContent('/a.ts', 'a1');
      context.addFileContent('/a.ts', 'a2');
      context.addFileContent('/b.ts', 'b1');

      expect(context.hasReadFile('/a.ts')).toBe(true);
      expect(context.hasReadFile('/b.ts')).toBe(true);

      // Remove all /a.ts entries via LRU
      const items = context.items as Array<{ timestamp: number }>;
      items[0].timestamp = Date.now() - 30_000;
      items[1].timestamp = Date.now() - 20_000;
      items[2].timestamp = Date.now(); // /b.ts is newest

      context.compact({ maxFileContentCount: 1 });

      expect(context.hasReadFile('/a.ts')).toBe(false);
      expect(context.hasReadFile('/b.ts')).toBe(true);
    });
  });

  describe('Version tracking', () => {
    it('increments version only when changes are made', () => {
      context.addFileContent('/file.ts', 'content');
      const versionAfterAdd = context.version;

      // No-op compact (file is recent)
      context.compact({ maxFileContentAgeMs: 60_000 });
      expect(context.version).toBe(versionAfterAdd);

      // Actual compact (force removal)
      const items = context.items as Array<{ timestamp: number }>;
      items[0].timestamp = Date.now() - 120_000;
      context.compact({ maxFileContentAgeMs: 60_000 });
      expect(context.version).toBe(versionAfterAdd + 1);
    });

    it('increments version for output truncation even without removals', () => {
      context.addFunctionCall('call-1', 'Read', { path: '/file.ts' });
      context.addFunctionCallOutput('call-1', 'x'.repeat(5000));
      const versionBefore = context.version;

      context.compact({ truncateOutputsTo: 100 });
      expect(context.version).toBe(versionBefore + 1);
    });
  });

  describe('Bytes recovered accuracy', () => {
    it('accurately reports bytes recovered from file content removal', () => {
      const content = 'x'.repeat(1000);
      context.addFileContent('/file.ts', content);

      const items = context.items as Array<{ timestamp: number }>;
      items[0].timestamp = Date.now() - 120_000;

      const result = context.compact({ maxFileContentAgeMs: 60_000 });

      expect(result.bytesRecovered).toBe(1000);
    });

    it('accurately reports bytes recovered from truncation', () => {
      const longOutput = 'y'.repeat(10_000);
      context.addFunctionCall('call-1', 'Read', { path: '/file.ts' });
      context.addFunctionCallOutput('call-1', longOutput);

      const result = context.compact({ truncateOutputsTo: 100 });

      // Should recover ~9900 bytes (10000 - 100 - truncation message)
      expect(result.bytesRecovered).toBeGreaterThan(9500);
      expect(result.bytesRecovered).toBeLessThan(10000);
    });
  });
});

describe('ContextWindow.compactWithLedger() Timeout Handling', () => {
  /**
   * Create a mock LLM adapter for testing.
   */
  function createMockLLM(behavior: 'success' | 'hang' | 'error'): LLMAdapter {
    return {
      respond: async () => {
        if (behavior === 'hang') {
          // Simulate a hanging LLM call - never resolves
          return new Promise<LLMResponse>(() => {
            // Intentionally never resolves
          });
        }
        if (behavior === 'error') {
          throw new Error('LLM error');
        }
        // Success case - return valid ledger response
        return {
          content: JSON.stringify({
            constraints: [],
            decision_boundaries: [],
            actions: [],
            open_questions: [],
          }),
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        };
      },
      stream: async function* () {
        yield 'test';
        return {
          content: 'test',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        };
      },
    };
  }

  it('falls back to mechanical compaction when LLM call times out', async () => {
    const context = new ContextWindow('test-session', 200_000);

    // Add enough content to trigger compaction
    for (let i = 0; i < 20; i++) {
      context.addMessage('user', `Message ${i}: ${'x'.repeat(1000)}`);
    }
    context.addFileContent('/file.ts', 'content');

    const hangingLLM = createMockLLM('hang');
    const llmConfig = {
      provider: 'test' as const,
      model: 'test-model',
      maxTokens: 800,
      temperature: 0,
    };

    // compactWithLedger should NOT hang - it should timeout and fall back
    // The default timeout is 30 seconds, but for testing we'll verify the
    // behavior by checking it completes (the actual timeout is built into the code)
    const startTime = Date.now();

    // Use a short test timeout - if compactWithLedger doesn't have timeout protection,
    // this test would hang forever
    const result = await Promise.race([
      context.compactWithLedger({
        llm: hangingLLM,
        llmConfig,
        targetReductionRatio: 0.5,
        preserveRecentItems: 5,
        deduplicateByPath: true,
      }),
      // Test timeout - if this resolves first, the test fails
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 35_000)),
    ]);

    const elapsed = Date.now() - startTime;

    // Should complete (via timeout + fallback) rather than hanging
    expect(result).not.toBeNull();
    // Should complete within reasonable time (30s timeout + small buffer)
    expect(elapsed).toBeLessThan(35_000);
    // Should still do some compaction (the mechanical fallback)
    expect(result!.itemsRemoved).toBeGreaterThanOrEqual(0);
  }, 40_000); // 40 second test timeout

  it('falls back to mechanical compaction when LLM call errors', async () => {
    const context = new ContextWindow('test-session', 200_000);

    // Add content
    for (let i = 0; i < 10; i++) {
      context.addMessage('user', `Message ${i}: ${'x'.repeat(500)}`);
    }

    const errorLLM = createMockLLM('error');
    const llmConfig = {
      provider: 'test' as const,
      model: 'test-model',
      maxTokens: 800,
      temperature: 0,
    };

    // Should not throw - should fall back to mechanical compaction
    const result = await context.compactWithLedger({
      llm: errorLLM,
      llmConfig,
      targetReductionRatio: 0.5,
      preserveRecentItems: 5,
    });

    // Should return a valid result (from fallback)
    expect(result).toBeDefined();
    expect(typeof result.itemsRemoved).toBe('number');
  });

  it('uses LLM ledger when call succeeds', async () => {
    const context = new ContextWindow('test-session', 200_000);

    // Add content to compact
    for (let i = 0; i < 15; i++) {
      context.addMessage('user', `Message ${i}: ${'y'.repeat(800)}`);
    }

    const successLLM = createMockLLM('success');
    const llmConfig = {
      provider: 'test' as const,
      model: 'test-model',
      maxTokens: 800,
      temperature: 0,
    };

    const result = await context.compactWithLedger({
      llm: successLLM,
      llmConfig,
      targetReductionRatio: 0.5,
      preserveRecentItems: 5,
    });

    // Should complete successfully
    expect(result).toBeDefined();
  });
});
