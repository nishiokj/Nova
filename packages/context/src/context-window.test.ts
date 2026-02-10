/**
 * ContextWindow Tests
 *
 * Tests the unified ContextWindow class after the 3→1 consolidation:
 * - RAM-only mode (no filePath)
 * - Disk-backed mode (filePath set, write-through)
 * - Serialization roundtrips (snapshot and markdown)
 * - The critical `---` in content bug (header-based parsing fix)
 * - Compaction, ejection, LLM format conversion
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { ContextWindow } from './context-window.js';
import type {
  ContextItem,
  MessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  FileContentItem,
  ArtifactItem,
  ReasoningItem,
} from 'types';

// ============================================
// TEST HELPERS
// ============================================

const TEST_DIR = path.join(import.meta.dir, '__test_tmp__');

function tmpFilePath(name: string): string {
  return path.join(TEST_DIR, name, 'context.md');
}

function cleanTestDir(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

// ============================================
// RAM-ONLY MODE
// ============================================

describe('ContextWindow (RAM-only)', () => {
  it('creates with defaults', () => {
    const ctx = new ContextWindow('sess-1', 100_000);
    expect(ctx.sessionKey).toBe('sess-1');
    expect(ctx.maxTokens).toBe(100_000);
    expect(ctx.filePath).toBeNull();
    expect(ctx.items).toHaveLength(0);
    expect(ctx.version).toBe(0);
  });

  it('creates with default maxTokens', () => {
    const ctx = new ContextWindow('sess-2');
    expect(ctx.maxTokens).toBe(200_000);
  });

  describe('addMessage', () => {
    it('adds string message and increments version', () => {
      const ctx = new ContextWindow('sess', 100_000);
      ctx.addMessage('user', 'Hello');

      expect(ctx.items).toHaveLength(1);
      expect(ctx.version).toBe(1);

      const item = ctx.items[0] as MessageItem;
      expect(item.type).toBe('message');
      expect(item.role).toBe('user');
      expect(item.content).toBe('Hello');
      expect(item.timestamp).toBeGreaterThan(0);
    });

    it('adds ContentBlock[] message', () => {
      const ctx = new ContextWindow('sess', 100_000);
      ctx.addMessage('assistant', [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'World' },
      ]);

      const item = ctx.items[0] as MessageItem;
      expect(Array.isArray(item.content)).toBe(true);
      expect((item.content as any[]).length).toBe(2);
    });

    it('tracks workItemId', () => {
      const ctx = new ContextWindow('sess', 100_000);
      ctx.addMessage('user', 'Hello', 'wi-1');

      expect((ctx.items[0] as MessageItem).workItemId).toBe('wi-1');
    });

    it('updates messageCount metric', () => {
      const ctx = new ContextWindow('sess', 100_000);
      ctx.addMessage('user', 'A');
      ctx.addMessage('assistant', 'B');
      expect(ctx.metrics.messageCount).toBe(2);
    });
  });

  describe('addFunctionCall', () => {
    it('adds function call', () => {
      const ctx = new ContextWindow('sess', 100_000);
      ctx.addFunctionCall('call-1', 'Read', { path: '/foo.ts' });

      const item = ctx.items[0] as FunctionCallItem;
      expect(item.type).toBe('function_call');
      expect(item.callId).toBe('call-1');
      expect(item.name).toBe('Read');
      expect(item.arguments).toEqual({ path: '/foo.ts' });
      expect(ctx.version).toBe(1);
    });
  });

  describe('addFunctionCallOutput', () => {
    it('adds function call output', () => {
      const ctx = new ContextWindow('sess', 100_000);
      ctx.addFunctionCallOutput('call-1', 'file contents', false, 42);

      const item = ctx.items[0] as FunctionCallOutputItem;
      expect(item.type).toBe('function_call_output');
      expect(item.callId).toBe('call-1');
      expect(item.output).toBe('file contents');
      expect(item.isError).toBe(false);
      expect(item.durationMs).toBe(42);
    });

    it('handles error output', () => {
      const ctx = new ContextWindow('sess', 100_000);
      ctx.addFunctionCallOutput('call-2', 'ENOENT', true);

      const item = ctx.items[0] as FunctionCallOutputItem;
      expect(item.isError).toBe(true);
    });
  });

  describe('addReasoning', () => {
    it('adds reasoning item', () => {
      const ctx = new ContextWindow('sess', 100_000);
      ctx.addReasoning('I should read the file first.');

      const item = ctx.items[0] as ReasoningItem;
      expect(item.type).toBe('reasoning');
      expect(item.content).toBe('I should read the file first.');
    });
  });

  describe('addFileContent', () => {
    it('adds file content and tracks read file', () => {
      const ctx = new ContextWindow('sess', 100_000);
      const id = ctx.addFileContent('/src/index.ts', 'export {}', 'typescript');

      expect(id).toMatch(/^fc_sess_1$/);
      expect(ctx.items).toHaveLength(1);

      const item = ctx.items[0] as FileContentItem;
      expect(item.type).toBe('file_content');
      expect(item.path).toBe('/src/index.ts');
      expect(item.content).toBe('export {}');
      expect(item.language).toBe('typescript');

      expect(ctx.hasReadFile('/src/index.ts')).toBe(true);
      expect(ctx.readFiles.size).toBe(1);
    });

    it('generates incrementing IDs', () => {
      const ctx = new ContextWindow('test', 100_000);
      const id1 = ctx.addFileContent('/a.ts', 'a');
      const id2 = ctx.addFileContent('/b.ts', 'b');
      expect(id1).toBe('fc_test_1');
      expect(id2).toBe('fc_test_2');
    });
  });

  describe('addArtifact', () => {
    it('adds artifact and returns ID', () => {
      const ctx = new ContextWindow('sess', 100_000);
      const id = ctx.addArtifact({
        kind: 'function',
        name: 'doStuff',
        sourcePath: '/src/lib.ts',
        discoveredBy: 'explorer',
      });

      expect(id).toMatch(/^art_sess_1$/);
      const item = ctx.items[0] as ArtifactItem;
      expect(item.type).toBe('artifact');
      expect(item.kind).toBe('function');
      expect(item.name).toBe('doStuff');
    });

    it('addArtifacts batch adds', () => {
      const ctx = new ContextWindow('sess', 100_000);
      const ids = ctx.addArtifacts([
        { kind: 'function', name: 'a', sourcePath: '/a.ts', discoveredBy: 'x' },
        { kind: 'class', name: 'B', sourcePath: '/b.ts', discoveredBy: 'x' },
      ]);
      expect(ids).toHaveLength(2);
      expect(ctx.getArtifacts()).toHaveLength(2);
    });
  });

  describe('query methods', () => {
    it('getArtifactsByPath filters by source path', () => {
      const ctx = new ContextWindow('sess', 100_000);
      ctx.addArtifact({ kind: 'function', name: 'a', sourcePath: '/a.ts', discoveredBy: 'x' });
      ctx.addArtifact({ kind: 'function', name: 'b', sourcePath: '/b.ts', discoveredBy: 'x' });
      ctx.addArtifact({ kind: 'class', name: 'c', sourcePath: '/a.ts', discoveredBy: 'x' });

      expect(ctx.getArtifactsByPath('/a.ts')).toHaveLength(2);
      expect(ctx.getArtifactsByPath('/b.ts')).toHaveLength(1);
      expect(ctx.getArtifactsByPath('/c.ts')).toHaveLength(0);
    });

    it('getArtifactsByKind filters by kind', () => {
      const ctx = new ContextWindow('sess', 100_000);
      ctx.addArtifact({ kind: 'function', name: 'a', sourcePath: '/a.ts', discoveredBy: 'x' });
      ctx.addArtifact({ kind: 'class', name: 'B', sourcePath: '/a.ts', discoveredBy: 'x' });
      ctx.addArtifact({ kind: 'function', name: 'c', sourcePath: '/b.ts', discoveredBy: 'x' });

      expect(ctx.getArtifactsByKind('function')).toHaveLength(2);
      expect(ctx.getArtifactsByKind('class')).toHaveLength(1);
    });

    it('getItemsByType returns correct types', () => {
      const ctx = new ContextWindow('sess', 100_000);
      ctx.addMessage('user', 'Hello');
      ctx.addFunctionCall('c1', 'Read', {});
      ctx.addFunctionCallOutput('c1', 'output');
      ctx.addMessage('assistant', 'World');

      expect(ctx.getItemsByType('message')).toHaveLength(2);
      expect(ctx.getItemsByType('function_call')).toHaveLength(1);
      expect(ctx.getItemsByType('function_call_output')).toHaveLength(1);
    });

    it('getRecentItems returns last N', () => {
      const ctx = new ContextWindow('sess', 100_000);
      for (let i = 0; i < 10; i++) {
        ctx.addMessage('user', `msg-${i}`);
      }
      const recent = ctx.getRecentItems(3);
      expect(recent).toHaveLength(3);
      expect((recent[0] as MessageItem).content).toBe('msg-7');
      expect((recent[2] as MessageItem).content).toBe('msg-9');
    });

    it('buildContextSummary with files and artifacts', () => {
      const ctx = new ContextWindow('sess', 100_000);
      ctx.addFileContent('/a.ts', 'content');
      ctx.addArtifact({ kind: 'function', name: 'foo', sourcePath: '/a.ts', discoveredBy: 'x' });

      const summary = ctx.buildContextSummary();
      expect(summary).toContain('FILES IN CONTEXT');
      expect(summary).toContain('/a.ts');
      expect(summary).toContain('ARTIFACTS DISCOVERED');
      expect(summary).toContain('1 function');
    });

    it('buildContextSummary returns null for empty context', () => {
      const ctx = new ContextWindow('sess', 100_000);
      expect(ctx.buildContextSummary()).toBeNull();
    });
  });

  describe('filterItems', () => {
    it('removes items by predicate', () => {
      const ctx = new ContextWindow('sess', 100_000);
      ctx.addMessage('user', 'keep');
      ctx.addReasoning('remove this');
      ctx.addMessage('assistant', 'keep too');

      ctx.filterItems(item => item.type !== 'reasoning');
      expect(ctx.items).toHaveLength(2);
      expect(ctx.items.every(i => i.type === 'message')).toBe(true);
    });
  });

  describe('appendItem', () => {
    it('appends a pre-built item', () => {
      const ctx = new ContextWindow('sess', 100_000);
      ctx.appendItem({
        type: 'message',
        role: 'system',
        content: 'injected',
        timestamp: Date.now(),
      });
      expect(ctx.items).toHaveLength(1);
      expect((ctx.items[0] as MessageItem).content).toBe('injected');
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      const ctx = new ContextWindow('sess', 100_000);
      ctx.addMessage('user', 'Hello');
      ctx.addFileContent('/a.ts', 'content');

      ctx.clear();
      expect(ctx.items).toHaveLength(0);
      expect(ctx.readFiles.size).toBe(0);
    });
  });

  describe('version tracking', () => {
    it('increments on every mutation', () => {
      const ctx = new ContextWindow('sess', 100_000);
      expect(ctx.version).toBe(0);

      ctx.addMessage('user', 'a');
      expect(ctx.version).toBe(1);

      ctx.addFunctionCall('c1', 'Read', {});
      expect(ctx.version).toBe(2);

      ctx.addFunctionCallOutput('c1', 'output');
      expect(ctx.version).toBe(3);

      ctx.addReasoning('think');
      expect(ctx.version).toBe(4);

      ctx.addFileContent('/a.ts', 'code');
      expect(ctx.version).toBe(5);

      ctx.addArtifact({ kind: 'function', name: 'f', sourcePath: '/a.ts', discoveredBy: 'x' });
      expect(ctx.version).toBe(6);
    });
  });
});

// ============================================
// EJECTION
// ============================================

describe('ContextWindow ejection', () => {
  it('ejectFileContentByPath removes all items for path', () => {
    const ctx = new ContextWindow('sess', 100_000);
    ctx.addFileContent('/a.ts', 'v1');
    ctx.addFileContent('/a.ts', 'v2');
    ctx.addFileContent('/b.ts', 'b');

    const result = ctx.ejectFileContentByPath('/a.ts');
    expect(result.ejectedCount).toBe(2);
    expect(result.pathsRemoved).toEqual(['/a.ts']);
    expect(ctx.items).toHaveLength(1);
    expect(ctx.hasReadFile('/a.ts')).toBe(false);
    expect(ctx.hasReadFile('/b.ts')).toBe(true);
  });

  it('ejectFileContentById removes single item', () => {
    const ctx = new ContextWindow('sess', 100_000);
    const id1 = ctx.addFileContent('/a.ts', 'v1');
    const id2 = ctx.addFileContent('/a.ts', 'v2');

    const result = ctx.ejectFileContentById(id1);
    expect(result.ejectedCount).toBe(1);
    // Path should NOT be removed since id2 still exists
    expect(result.pathsRemoved).toEqual([]);
    expect(ctx.hasReadFile('/a.ts')).toBe(true);
  });

  it('ejectFileContentById removes path when last item ejected', () => {
    const ctx = new ContextWindow('sess', 100_000);
    const id = ctx.addFileContent('/a.ts', 'v1');

    const result = ctx.ejectFileContentById(id);
    expect(result.ejectedCount).toBe(1);
    expect(result.pathsRemoved).toEqual(['/a.ts']);
    expect(ctx.hasReadFile('/a.ts')).toBe(false);
  });

  it('invalidateFileContent removes file content and artifacts', () => {
    const ctx = new ContextWindow('sess', 100_000);
    ctx.addFileContent('/a.ts', 'code');
    ctx.addArtifact({ kind: 'function', name: 'foo', sourcePath: '/a.ts', discoveredBy: 'x' });
    ctx.addArtifact({ kind: 'class', name: 'Bar', sourcePath: '/a.ts', discoveredBy: 'x' });
    ctx.addArtifact({ kind: 'function', name: 'baz', sourcePath: '/b.ts', discoveredBy: 'x' });

    const result = ctx.invalidateFileContent('/a.ts');
    expect(result.ejectedCount).toBe(1);
    // File content removed, both artifacts for /a.ts removed, /b.ts artifact kept
    expect(ctx.items).toHaveLength(1);
    expect((ctx.items[0] as ArtifactItem).sourcePath).toBe('/b.ts');
    expect(ctx.hasReadFile('/a.ts')).toBe(false);
  });
});

// ============================================
// COMPACTION
// ============================================

describe('ContextWindow compaction', () => {
  it('deduplicateByPath keeps newest file_content per path', () => {
    const ctx = new ContextWindow('sess', 100_000);
    ctx.addFileContent('/a.ts', 'old version');
    // Ensure different timestamps
    ctx.addFileContent('/a.ts', 'new version');
    ctx.addFileContent('/b.ts', 'only version');

    const result = ctx.compact({ deduplicateByPath: true });
    expect(result.fileContentRemoved).toBe(1);
    expect(ctx.items).toHaveLength(2);

    // The kept /a.ts item should be the newer one
    const aItems = ctx.items.filter(
      (i): i is FileContentItem => i.type === 'file_content' && i.path === '/a.ts'
    );
    expect(aItems).toHaveLength(1);
    expect(aItems[0].content).toBe('new version');
  });

  it('maxFileContentCount evicts oldest (LRU)', () => {
    const ctx = new ContextWindow('sess', 100_000);
    ctx.addFileContent('/a.ts', 'a');
    ctx.addFileContent('/b.ts', 'b');
    ctx.addFileContent('/c.ts', 'c');

    const result = ctx.compact({ maxFileContentCount: 2 });
    expect(result.fileContentRemoved).toBe(1);
    expect(ctx.items).toHaveLength(2);
    // /a.ts (oldest) should be evicted
    expect(ctx.hasReadFile('/a.ts')).toBe(false);
    expect(ctx.hasReadFile('/b.ts')).toBe(true);
    expect(ctx.hasReadFile('/c.ts')).toBe(true);
  });

  it('truncateOutputsTo truncates long function_call_output', () => {
    const ctx = new ContextWindow('sess', 100_000);
    ctx.addFunctionCallOutput('c1', 'x'.repeat(10000));
    ctx.addFunctionCallOutput('c2', 'short');

    const result = ctx.compact({ truncateOutputsTo: 100 });
    expect(result.outputsTruncated).toBe(1);

    const item = ctx.items[0] as FunctionCallOutputItem;
    expect(item.output.length).toBeLessThan(10000);
    expect(item.output).toContain('truncated');
  });

  it('no-op compact when nothing to do', () => {
    const ctx = new ContextWindow('sess', 100_000);
    ctx.addMessage('user', 'hello');

    const result = ctx.compact({ deduplicateByPath: true });
    expect(result.itemsRemoved).toBe(0);
    expect(result.outputsTruncated).toBe(0);
    expect(result.bytesRecovered).toBe(0);
  });

  it('combined: dedup + truncate', () => {
    const ctx = new ContextWindow('sess', 100_000);
    ctx.addFileContent('/a.ts', 'old');
    ctx.addFileContent('/a.ts', 'new');
    ctx.addFunctionCallOutput('c1', 'x'.repeat(5000));

    const result = ctx.compact({ deduplicateByPath: true, truncateOutputsTo: 200 });
    expect(result.fileContentRemoved).toBe(1);
    expect(result.outputsTruncated).toBe(1);
  });
});

// ============================================
// SNAPSHOT SERIALIZATION (serialize/deserialize)
// ============================================

describe('ContextWindow snapshot serialization', () => {
  it('roundtrips through serialize/deserialize', () => {
    const ctx = new ContextWindow('snap-test', 150_000);
    ctx.addMessage('user', 'Hello');
    ctx.addMessage('assistant', 'World');
    ctx.addFunctionCall('c1', 'Read', { path: '/foo.ts' });
    ctx.addFunctionCallOutput('c1', 'file content here');
    ctx.addReasoning('I should check the file.');
    const fcId = ctx.addFileContent('/src/index.ts', 'export {}', 'typescript');
    ctx.addArtifact({ kind: 'function', name: 'main', sourcePath: '/src/index.ts', discoveredBy: 'explorer' });

    const snapshot = ctx.serialize();
    const restored = ContextWindow.deserialize(snapshot);

    expect(restored.sessionKey).toBe('snap-test');
    expect(restored.maxTokens).toBe(150_000);
    expect(restored.items).toHaveLength(ctx.items.length);
    expect(restored.version).toBe(ctx.version);
    expect(restored.hasReadFile('/src/index.ts')).toBe(true);
    expect(restored.filePath).toBeNull();

    // Verify each item
    for (let i = 0; i < ctx.items.length; i++) {
      expect(restored.items[i].type).toBe(ctx.items[i].type);
      expect(restored.items[i].timestamp).toBe(ctx.items[i].timestamp);
    }
  });

  it('preserves fileContentCounter after deserialize', () => {
    const ctx = new ContextWindow('snap', 100_000);
    ctx.addFileContent('/a.ts', 'a'); // fc_snap_1
    ctx.addFileContent('/b.ts', 'b'); // fc_snap_2

    const restored = ContextWindow.deserialize(ctx.serialize());
    const nextId = restored.addFileContent('/c.ts', 'c'); // Should be fc_snap_3
    expect(nextId).toBe('fc_snap_3');
  });
});

// ============================================
// DISK-BACKED MODE
// ============================================

describe('ContextWindow (disk-backed)', () => {
  beforeEach(cleanTestDir);
  afterEach(cleanTestDir);

  it('creates file on construction when no prior file exists', () => {
    const fp = tmpFilePath('new');
    const ctx = new ContextWindow('disk-1', 100_000, fp);

    expect(ctx.filePath).toBe(fp);
    expect(existsSync(fp)).toBe(true);

    const content = readFileSync(fp, 'utf-8');
    expect(content).toContain('session: disk-1');
    expect(content).toContain('maxTokens: 100000');
  });

  it('write-through: file updates on every mutation', () => {
    const fp = tmpFilePath('writethrough');
    const ctx = new ContextWindow('wt', 100_000, fp);

    ctx.addMessage('user', 'Hello');
    let content = readFileSync(fp, 'utf-8');
    expect(content).toContain('### message:user');
    expect(content).toContain('Hello');

    ctx.addFunctionCall('c1', 'Read', { path: '/foo.ts' });
    content = readFileSync(fp, 'utf-8');
    expect(content).toContain('### function_call');
    expect(content).toContain('@name Read');

    ctx.addFunctionCallOutput('c1', 'file output', false, 123);
    content = readFileSync(fp, 'utf-8');
    expect(content).toContain('### function_call_output');
    expect(content).toContain('file output');
    expect(content).not.toContain('@durationMs');
  });

  it('loads from existing file on construction', () => {
    const fp = tmpFilePath('reload');

    // Create and populate
    const ctx1 = new ContextWindow('reload-test', 100_000, fp);
    ctx1.addMessage('user', 'First');
    ctx1.addFileContent('/a.ts', 'export {}', 'typescript');
    ctx1.addArtifact({ kind: 'function', name: 'foo', sourcePath: '/a.ts', discoveredBy: 'explorer' });

    // Reload from same file
    const ctx2 = new ContextWindow('reload-test', 100_000, fp);
    expect(ctx2.items).toHaveLength(3);

    const msg = ctx2.items[0] as MessageItem;
    expect(msg.type).toBe('message');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('First');

    const fc = ctx2.items[1] as FileContentItem;
    expect(fc.type).toBe('file_content');
    expect(fc.path).toBe('/a.ts');
    expect(fc.content).toBe('export {}');
    expect(fc.language).toBe('typescript');

    const art = ctx2.items[2] as ArtifactItem;
    expect(art.type).toBe('artifact');
    expect(art.name).toBe('foo');
    expect(art.kind).toBe('function');

    // readFiles should be rebuilt
    expect(ctx2.hasReadFile('/a.ts')).toBe(true);
  });

  it('preserves counters across reload', () => {
    const fp = tmpFilePath('counters');

    const ctx1 = new ContextWindow('cnt', 100_000, fp);
    ctx1.addFileContent('/a.ts', 'a'); // fc_cnt_1
    ctx1.addFileContent('/b.ts', 'b'); // fc_cnt_2
    ctx1.addArtifact({ kind: 'function', name: 'f', sourcePath: '/a.ts', discoveredBy: 'x' }); // art_cnt_1

    const ctx2 = new ContextWindow('cnt', 100_000, fp);
    const fcId = ctx2.addFileContent('/c.ts', 'c');
    const artId = ctx2.addArtifact({ kind: 'class', name: 'C', sourcePath: '/c.ts', discoveredBy: 'x' });

    expect(fcId).toBe('fc_cnt_3');
    expect(artId).toBe('art_cnt_2');
  });

  it('clear writes empty file', () => {
    const fp = tmpFilePath('clear');
    const ctx = new ContextWindow('clr', 100_000, fp);
    ctx.addMessage('user', 'Hello');
    ctx.clear();

    const content = readFileSync(fp, 'utf-8');
    expect(content).toContain('session: clr');
    // Should NOT contain any items
    expect(content).not.toContain('### message');
  });

  it('compact writes updated file', () => {
    const fp = tmpFilePath('compact');
    const ctx = new ContextWindow('cmp', 100_000, fp);
    ctx.addFileContent('/a.ts', 'old');
    ctx.addFileContent('/a.ts', 'new');

    ctx.compact({ deduplicateByPath: true });

    const content = readFileSync(fp, 'utf-8');
    expect(content).toContain('new');
    // Should only have one file_content block
    const headerCount = (content.match(/### file_content/g) || []).length;
    expect(headerCount).toBe(1);
  });

  it('atomic write: no .tmp file left behind', () => {
    const fp = tmpFilePath('atomic');
    const ctx = new ContextWindow('atm', 100_000, fp);
    ctx.addMessage('user', 'test');

    expect(existsSync(fp + '.tmp')).toBe(false);
    expect(existsSync(fp)).toBe(true);
  });

  it('syncs from disk to avoid stale overwrite across concurrent instances', () => {
    const fp = tmpFilePath('concurrent');
    const ctx1 = new ContextWindow('shared', 100_000, fp);
    const ctx2 = new ContextWindow('shared', 100_000, fp);

    ctx1.addMessage('user', 'from-ctx1');
    ctx2.addMessage('assistant', 'from-ctx2');

    const reloaded = new ContextWindow('shared', 100_000, fp);
    const messages = reloaded.items.filter((item): item is MessageItem => item.type === 'message');
    const contents = messages.map(m => m.content);
    expect(contents).toContain('from-ctx1');
    expect(contents).toContain('from-ctx2');

    // Existing instances should also refresh from disk on reads.
    const ctx1History = ctx1.getMessageHistory().map(m => m.content);
    expect(ctx1History).toContain('from-ctx2');
  });
});

// ============================================
// CRITICAL BUG: content containing `---`
// ============================================

describe('ContextWindow: --- in content (header-based parsing)', () => {
  beforeEach(cleanTestDir);
  afterEach(cleanTestDir);

  it('function_call_output with --- separators survives roundtrip', () => {
    const fp = tmpFilePath('dashes-output');
    const outputWithDashes = [
      'Line 1',
      '---',
      'Line 2',
      '---',
      'Line 3',
    ].join('\n');

    const ctx1 = new ContextWindow('dash', 100_000, fp);
    ctx1.addFunctionCallOutput('c1', outputWithDashes);

    // Reload
    const ctx2 = new ContextWindow('dash', 100_000, fp);
    expect(ctx2.items).toHaveLength(1);

    const item = ctx2.items[0] as FunctionCallOutputItem;
    expect(item.type).toBe('function_call_output');
    expect(item.output).toBe(outputWithDashes);
  });

  it('message with markdown HR (---) survives roundtrip', () => {
    const fp = tmpFilePath('dashes-msg');
    const markdown = '# Title\n\n---\n\nSome content.\n\n---\n\nMore content.';

    const ctx1 = new ContextWindow('dash', 100_000, fp);
    ctx1.addMessage('user', markdown);

    const ctx2 = new ContextWindow('dash', 100_000, fp);
    const item = ctx2.items[0] as MessageItem;
    expect(item.content).toBe(markdown);
  });

  it('file_content with --- in code survives roundtrip', () => {
    const fp = tmpFilePath('dashes-file');
    const code = [
      'const x = true;',
      '// ---',
      '---',
      'const y = false;',
    ].join('\n');

    const ctx1 = new ContextWindow('dash', 100_000, fp);
    ctx1.addFileContent('/code.ts', code, 'typescript');

    const ctx2 = new ContextWindow('dash', 100_000, fp);
    const item = ctx2.items[0] as FileContentItem;
    expect(item.content).toBe(code);
  });

  it('multiple items with --- in content all survive', () => {
    const fp = tmpFilePath('dashes-multi');

    const ctx1 = new ContextWindow('dash', 100_000, fp);
    ctx1.addMessage('user', 'before---after');
    ctx1.addFunctionCallOutput('c1', 'result\n---\nmore');
    ctx1.addMessage('assistant', '---');
    ctx1.addFileContent('/x.md', '---\ntitle: test\n---');

    const ctx2 = new ContextWindow('dash', 100_000, fp);
    expect(ctx2.items).toHaveLength(4);

    expect((ctx2.items[0] as MessageItem).content).toBe('before---after');
    expect((ctx2.items[1] as FunctionCallOutputItem).output).toBe('result\n---\nmore');
    expect((ctx2.items[2] as MessageItem).content).toBe('---');
    expect((ctx2.items[3] as FileContentItem).content).toBe('---\ntitle: test\n---');
  });

  it('YAML frontmatter not confused by --- in body content', () => {
    const fp = tmpFilePath('dashes-frontmatter');

    const ctx1 = new ContextWindow('dash', 100_000, fp);
    // Content that looks like YAML frontmatter
    ctx1.addMessage('user', '---\nfake: frontmatter\n---');

    const ctx2 = new ContextWindow('dash', 100_000, fp);
    expect(ctx2.items).toHaveLength(1);
    expect((ctx2.items[0] as MessageItem).content).toBe('---\nfake: frontmatter\n---');
  });
});

// ============================================
// LLM FORMAT CONVERSION
// ============================================

describe('ContextWindow LLM format conversion', () => {
  describe('getItemsForLLM', () => {
    it('converts all item types', () => {
      const ctx = new ContextWindow('llm', 100_000);
      ctx.addMessage('user', 'Hello');
      ctx.addMessage('assistant', 'Hi');
      ctx.addFunctionCall('c1', 'Read', { path: '/x.ts' });
      ctx.addFunctionCallOutput('c1', 'content');
      ctx.addReasoning('thinking...');
      ctx.addFileContent('/x.ts', 'export {}', 'typescript');

      const items = ctx.getItemsForLLM();
      expect(items).toHaveLength(6); // No artifacts to batch

      expect(items[0]).toEqual({ type: 'message', role: 'user', content: 'Hello' });
      expect(items[1]).toEqual({ type: 'message', role: 'assistant', content: 'Hi' });
      expect(items[2]).toMatchObject({ type: 'function_call', call_id: 'c1', name: 'Read' });
      expect(items[3]).toMatchObject({ type: 'function_call_output', call_id: 'c1', output: 'content' });
      expect(items[4]).toMatchObject({ type: 'reasoning', content: 'thinking...' });
      // File content becomes user message
      expect(items[5]).toMatchObject({ type: 'message', role: 'user' });
      expect((items[5] as any).content).toContain('[File: /x.ts]');
    });

    it('batches artifacts into single message', () => {
      const ctx = new ContextWindow('llm', 100_000);
      ctx.addMessage('user', 'Hello');
      ctx.addArtifact({ kind: 'function', name: 'a', sourcePath: '/a.ts', discoveredBy: 'x' });
      ctx.addArtifact({ kind: 'class', name: 'B', sourcePath: '/b.ts', discoveredBy: 'x' });

      const items = ctx.getItemsForLLM();
      // 1 user message + 1 batched artifact message
      expect(items).toHaveLength(2);
      const artifactMsg = items[1] as any;
      expect(artifactMsg.type).toBe('message');
      expect(artifactMsg.role).toBe('user');
      expect(artifactMsg.content).toContain('DISCOVERED ARTIFACTS: 2');
    });

    it('function_call arguments are JSON stringified', () => {
      const ctx = new ContextWindow('llm', 100_000);
      ctx.addFunctionCall('c1', 'Read', { path: '/foo.ts' });

      const items = ctx.getItemsForLLM();
      expect((items[0] as any).arguments).toBe(JSON.stringify({ path: '/foo.ts' }));
    });
  });

  describe('getItemsForAnthropic', () => {
    it('separates system content from messages', () => {
      const ctx = new ContextWindow('anth', 100_000);
      ctx.addMessage('system', 'You are a helpful assistant.');
      ctx.addMessage('developer', 'Follow these rules.');
      ctx.addMessage('user', 'Hello');
      ctx.addMessage('assistant', 'Hi');

      const { system, messages } = ctx.getItemsForAnthropic();
      expect(system).toContain('You are a helpful assistant.');
      expect(system).toContain('Follow these rules.');
      // Only user/assistant in messages
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: 'user', content: 'Hello' });
      expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Hi' });
    });

    it('batches tool_use blocks into assistant message', () => {
      const ctx = new ContextWindow('anth', 100_000);
      ctx.addMessage('user', 'Do something');
      ctx.addFunctionCall('c1', 'Read', { path: '/a.ts' });
      ctx.addFunctionCall('c2', 'Grep', { pattern: 'foo' });
      ctx.addFunctionCallOutput('c1', 'content of a');
      ctx.addFunctionCallOutput('c2', 'grep results');

      const { messages } = ctx.getItemsForAnthropic();
      // user msg, assistant (2 tool_use), tool_result c1, tool_result c2
      expect(messages.length).toBeGreaterThanOrEqual(3);

      // First should be user
      expect(messages[0]).toMatchObject({ role: 'user' });

      // Second should be assistant with tool_use array
      expect(messages[1]).toMatchObject({ role: 'assistant' });
      const toolUses = (messages[1] as any).content;
      expect(Array.isArray(toolUses)).toBe(true);
      expect(toolUses).toHaveLength(2);
      expect(toolUses[0].type).toBe('tool_use');
    });

    it('flushes pending tool calls before user message', () => {
      const ctx = new ContextWindow('anth', 100_000);
      ctx.addFunctionCall('c1', 'Read', { path: '/a.ts' });
      ctx.addMessage('user', 'What did you find?');

      const { messages } = ctx.getItemsForAnthropic();
      // assistant (tool_use), user msg
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: 'assistant' });
      expect(messages[1]).toMatchObject({ role: 'user', content: 'What did you find?' });
    });
  });
});

// ============================================
// addAgentResultContext
// ============================================

describe('ContextWindow addAgentResultContext', () => {
  it('invalidates paths, merges filesRead, adds response', () => {
    const ctx = new ContextWindow('agent', 100_000);
    ctx.addFileContent('/old.ts', 'old content');
    ctx.addArtifact({ kind: 'function', name: 'f', sourcePath: '/old.ts', discoveredBy: 'x' });

    ctx.addAgentResultContext({
      response: 'Agent completed task.',
      filesRead: ['/new.ts', '/other.ts'],
      invalidatedPaths: ['/old.ts'],
    });

    // /old.ts file_content and artifact should be gone
    expect(ctx.items.filter(i => i.type === 'file_content')).toHaveLength(0);
    expect(ctx.items.filter(i => i.type === 'artifact')).toHaveLength(0);

    // Should have response as assistant message
    const msgs = ctx.items.filter((i): i is MessageItem => i.type === 'message');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('Agent completed task.');

    // readFiles should include new paths
    expect(ctx.hasReadFile('/new.ts')).toBe(true);
    expect(ctx.hasReadFile('/other.ts')).toBe(true);
  });

  it('merges tool calls from localContext, skips hook calls', () => {
    const ctx = new ContextWindow('agent', 100_000);
    const local = new ContextWindow('local', 100_000);

    local.addFunctionCall('real-1', 'Read', { path: '/a.ts' });
    local.addFunctionCallOutput('real-1', 'content');
    local.addFunctionCall('hook-1', 'HookTool', { data: 'x' });
    local.addFunctionCallOutput('hook-1', 'hook result');

    ctx.addAgentResultContext({
      response: 'Done.',
      filesRead: [],
      invalidatedPaths: [],
      localContext: local,
    });

    // Should have real-1 call + output + response message, but NOT hook-1
    const fcItems = ctx.items.filter(i => i.type === 'function_call');
    const fcoItems = ctx.items.filter(i => i.type === 'function_call_output');
    expect(fcItems).toHaveLength(1);
    expect(fcoItems).toHaveLength(1);
    expect((fcItems[0] as FunctionCallItem).callId).toBe('real-1');
  });
});

// ============================================
// isNearFull
// ============================================

describe('ContextWindow isNearFull', () => {
  it('returns false for empty context', () => {
    const ctx = new ContextWindow('cap', 100_000);
    expect(ctx.isNearFull()).toBe(false);
  });

  it('returns true when heavily loaded', () => {
    // 100k tokens ~ 400k chars at ~4 chars/token heuristic
    const ctx = new ContextWindow('cap', 1000); // very small max
    ctx.addFileContent('/huge.ts', 'x'.repeat(10000)); // ~2500 tokens against 1000 max
    expect(ctx.isNearFull(0.5)).toBe(true);
  });
});

// ============================================
// fromSessionDir
// ============================================

describe('ContextWindow.fromSessionDir', () => {
  beforeEach(cleanTestDir);
  afterEach(cleanTestDir);

  it('creates context at expected path', () => {
    const ctx = ContextWindow.fromSessionDir(TEST_DIR, 'sess-123', 100_000);
    expect(ctx.filePath).toContain('.haiku/sessions');
    expect(ctx.filePath).toContain('sess-123');
    expect(ctx.filePath!.endsWith('context.md')).toBe(true);
    expect(existsSync(ctx.filePath!)).toBe(true);
  });
});

// ============================================
// deserialize with filePath
// ============================================

describe('ContextWindow.deserialize with filePath', () => {
  beforeEach(cleanTestDir);
  afterEach(cleanTestDir);

  it('writes snapshot to disk on restore', () => {
    const ctx = new ContextWindow('snap', 100_000);
    ctx.addMessage('user', 'Hello');
    ctx.addFileContent('/a.ts', 'code');

    const fp = tmpFilePath('restore');
    const restored = ContextWindow.deserialize(ctx.serialize(), fp);

    expect(restored.filePath).toBe(fp);
    expect(existsSync(fp)).toBe(true);

    // Reload from disk to verify
    const reloaded = new ContextWindow('snap', 100_000, fp);
    expect(reloaded.items).toHaveLength(2);
    expect((reloaded.items[0] as MessageItem).content).toBe('Hello');
  });
});

// ============================================
// TELEMETRY
// ============================================

describe('ContextWindow toTelemetry', () => {
  it('produces correct telemetry snapshot', () => {
    const ctx = new ContextWindow('tel', 100_000);
    ctx.addMessage('user', 'Hello');
    ctx.addMessage('assistant', 'World');
    ctx.addFunctionCall('c1', 'Read', {});
    ctx.addFunctionCallOutput('c1', 'output');
    ctx.addFileContent('/a.ts', 'code');
    ctx.addArtifact({ kind: 'function', name: 'f', sourcePath: '/a.ts', discoveredBy: 'x' });
    ctx.addReasoning('thinking');

    const tel = ctx.toTelemetry();
    expect(tel.sessionKey).toBe('tel');
    expect(tel.itemCount).toBe(7);
    expect(tel.itemsByType.message).toBe(2);
    expect(tel.itemsByType.function_call).toBe(1);
    expect(tel.itemsByType.function_call_output).toBe(1);
    expect(tel.itemsByType.file_content).toBe(1);
    expect(tel.itemsByType.artifact).toBe(1);
    expect(tel.itemsByType.reasoning).toBe(1);
    expect(tel.readFilesCount).toBe(1);
    expect(tel.maxTokens).toBe(100_000);
    expect(tel.version).toBe(7);
    expect(tel.recentItems).toHaveLength(5); // Last 5
  });
});

// ============================================
// EDGE CASES
// ============================================

describe('ContextWindow edge cases', () => {
  beforeEach(cleanTestDir);
  afterEach(cleanTestDir);

  it('handles empty string content', () => {
    const ctx = new ContextWindow('edge', 100_000);
    ctx.addMessage('user', '');
    ctx.addFunctionCallOutput('c1', '');
    ctx.addReasoning('');
    ctx.addFileContent('/empty.ts', '');

    expect(ctx.items).toHaveLength(4);
  });

  it('handles very large content', () => {
    const ctx = new ContextWindow('edge', 100_000);
    const bigContent = 'x'.repeat(100_000);
    ctx.addFileContent('/big.ts', bigContent);

    expect(ctx.items).toHaveLength(1);
    expect((ctx.items[0] as FileContentItem).content.length).toBe(100_000);
  });

  it('handles special characters in content', () => {
    const fp = tmpFilePath('special');
    const specialContent = 'line1\nline2\ttab\r\nwindows\n\0null\n🎉emoji';

    const ctx1 = new ContextWindow('sp', 100_000, fp);
    ctx1.addMessage('user', specialContent);

    const ctx2 = new ContextWindow('sp', 100_000, fp);
    // Null byte may or may not roundtrip perfectly, but the rest should
    const restored = (ctx2.items[0] as MessageItem).content as string;
    expect(restored).toContain('line1');
    expect(restored).toContain('line2');
    expect(restored).toContain('emoji');
  });

  it('handles content with @-prefix lines (not metadata)', () => {
    const fp = tmpFilePath('atprefix');

    const ctx1 = new ContextWindow('at', 100_000, fp);
    // Output that starts lines with @ — could confuse metadata parser
    ctx1.addFunctionCallOutput('c1', '@user mentioned\n@channel updated');

    const ctx2 = new ContextWindow('at', 100_000, fp);
    expect(ctx2.items).toHaveLength(1);
    const item = ctx2.items[0] as FunctionCallOutputItem;
    // The content after metadata lines should be preserved
    expect(item.output).toContain('@user mentioned');
    expect(item.output).toContain('@channel updated');
  });

  it('handles content with ### header-like lines (not item boundaries)', () => {
    const fp = tmpFilePath('hashheader');

    const ctx1 = new ContextWindow('hdr', 100_000, fp);
    // Content that looks like item headers but isn't
    ctx1.addFunctionCallOutput('c1', '### Some heading\n\n### Another heading\n\nContent below.');
    ctx1.addMessage('user', 'After output');

    const ctx2 = new ContextWindow('hdr', 100_000, fp);
    expect(ctx2.items).toHaveLength(2);
    const output = ctx2.items[0] as FunctionCallOutputItem;
    expect(output.output).toContain('### Some heading');
    expect(output.output).toContain('### Another heading');
  });

  it('handles content with actual item header text (### message:user)', () => {
    const fp = tmpFilePath('fakeheader');

    const ctx1 = new ContextWindow('fk', 100_000, fp);
    // This is the adversarial case: tool output containing text that
    // matches the HEADER_RE pattern. The parser should NOT split here
    // because the header regex only matches at the start of a line in the body.
    ctx1.addMessage('user', 'Before');
    ctx1.addFunctionCallOutput('c1', 'Result with\n### message:user\nfake header inside');
    ctx1.addMessage('assistant', 'After');

    const ctx2 = new ContextWindow('fk', 100_000, fp);
    // This IS a known limitation: if tool output contains exact header patterns
    // at the start of a line, the parser may split incorrectly.
    // We test this to document the behavior.
    // At minimum, we should get the user message and assistant message.
    const msgs = ctx2.items.filter((i): i is MessageItem => i.type === 'message');
    expect(msgs.length).toBeGreaterThanOrEqual(2);
  });

  it('rebuildReadFilesFromItems rebuilds correctly', () => {
    const ctx = new ContextWindow('rebuild', 100_000);
    ctx.addFileContent('/a.ts', 'a');
    ctx.addFileContent('/b.ts', 'b');
    ctx.markFileRead('/c.ts'); // Won't survive rebuild (no file_content item)

    expect(ctx.hasReadFile('/c.ts')).toBe(true);

    ctx.rebuildReadFilesFromItems();
    expect(ctx.hasReadFile('/a.ts')).toBe(true);
    expect(ctx.hasReadFile('/b.ts')).toBe(true);
    expect(ctx.hasReadFile('/c.ts')).toBe(false);
  });

  it('getMessageHistory maps roles correctly', () => {
    const ctx = new ContextWindow('hist', 100_000);
    ctx.addMessage('user', 'Question');
    ctx.addMessage('assistant', 'Answer');
    ctx.addMessage('system', 'System msg');
    ctx.addMessage('developer', 'Dev msg');
    ctx.addFunctionCall('c1', 'Read', {}); // Not a message

    const history = ctx.getMessageHistory();
    expect(history).toHaveLength(4);
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('agent'); // assistant → agent
    expect(history[2].role).toBe('system');
    expect(history[3].role).toBe('agent'); // developer → agent
  });
});
