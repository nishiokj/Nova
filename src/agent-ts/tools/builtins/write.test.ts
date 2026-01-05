/**
 * Comprehensive test suite for Write and Edit Tools
 *
 * Goal: Find bugs, not just pass tests.
 * Focus areas:
 * - Write: File creation, directory creation, atomic writes, existing file handling
 * - Edit: String replacement, uniqueness check, replaceAll, edge cases
 * - Both: Path resolution, error handling, metadata
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, readFile, rm, stat, access } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { executeWrite, executeEdit } from './write.js';

function createTempDir(): string {
  return join(tmpdir(), `write-test-${randomBytes(8).toString('hex')}`);
}

describe('executeWrite', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = createTempDir();
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Basic file creation', () => {
    it('should create a new file with content', async () => {
      const result = await executeWrite({
        path: 'new.txt',
        cwd: tempDir,
        content: 'Hello, World!',
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('Successfully wrote');

      const content = await readFile(join(tempDir, 'new.txt'), 'utf-8');
      expect(content).toBe('Hello, World!');
    });

    it('should create file with multiline content', async () => {
      const multiline = 'line1\nline2\nline3';
      const result = await executeWrite({
        path: 'multiline.txt',
        cwd: tempDir,
        content: multiline,
      });

      expect(result.isSuccess).toBe(true);
      const content = await readFile(join(tempDir, 'multiline.txt'), 'utf-8');
      expect(content).toBe(multiline);
    });

    it('should create file with Unicode content', async () => {
      const unicode = '日本語 🎉 émojis';
      const result = await executeWrite({
        path: 'unicode.txt',
        cwd: tempDir,
        content: unicode,
      });

      expect(result.isSuccess).toBe(true);
      const content = await readFile(join(tempDir, 'unicode.txt'), 'utf-8');
      expect(content).toBe(unicode);
    });

    it('should create empty file', async () => {
      const result = await executeWrite({
        path: 'empty.txt',
        cwd: tempDir,
        content: '',
      });

      expect(result.isSuccess).toBe(true);
      const content = await readFile(join(tempDir, 'empty.txt'), 'utf-8');
      expect(content).toBe('');
    });
  });

  describe('Directory creation', () => {
    it('should create parent directories if needed', async () => {
      const result = await executeWrite({
        path: 'a/b/c/deep.txt',
        cwd: tempDir,
        content: 'deep content',
      });

      expect(result.isSuccess).toBe(true);
      const content = await readFile(join(tempDir, 'a/b/c/deep.txt'), 'utf-8');
      expect(content).toBe('deep content');
    });

    it('should work when parent directory exists', async () => {
      await mkdir(join(tempDir, 'existing'), { recursive: true });

      const result = await executeWrite({
        path: 'existing/file.txt',
        cwd: tempDir,
        content: 'content',
      });

      expect(result.isSuccess).toBe(true);
    });
  });

  describe('Existing file handling', () => {
    it('should fail if file already exists', async () => {
      await writeFile(join(tempDir, 'existing.txt'), 'old content');

      const result = await executeWrite({
        path: 'existing.txt',
        cwd: tempDir,
        content: 'new content',
      });

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('already exists');
      expect(result.error).toContain('Use Edit');

      // Original content should be unchanged
      const content = await readFile(join(tempDir, 'existing.txt'), 'utf-8');
      expect(content).toBe('old content');
    });
  });

  describe('Atomic writes', () => {
    it('should indicate atomic write in metadata', async () => {
      const result = await executeWrite({
        path: 'atomic.txt',
        cwd: tempDir,
        content: 'content',
      });

      expect(result.isSuccess).toBe(true);
      expect(result.metadata?.atomic).toBe(true);
    });

    it('should not leave temp files on success', async () => {
      await executeWrite({
        path: 'success.txt',
        cwd: tempDir,
        content: 'content',
      });

      const { readdir } = await import('fs/promises');
      const files = await readdir(tempDir);

      // Should only have the target file, no .tmp files
      expect(files.filter((f) => f.includes('.tmp'))).toHaveLength(0);
    });

    it('BUG CANDIDATE: temp file cleanup on failure', async () => {
      // If writeFile succeeds but rename fails, temp file should be cleaned
      // This is hard to test without mocking, but documents the behavior
      const result = await executeWrite({
        path: 'test.txt',
        cwd: tempDir,
        content: 'content',
      });

      // Normal case should succeed
      expect(result.isSuccess).toBe(true);
    });
  });

  describe('Path resolution', () => {
    it('should resolve relative paths from cwd', async () => {
      const result = await executeWrite({
        path: 'relative.txt',
        cwd: tempDir,
        content: 'content',
      });

      expect(result.isSuccess).toBe(true);
      expect(result.metadata?.path).toBe(resolve(tempDir, 'relative.txt'));
    });

    it('should handle absolute paths', async () => {
      const absolutePath = join(tempDir, 'absolute.txt');

      const result = await executeWrite({
        path: absolutePath,
        cwd: '/some/other/dir',
        content: 'content',
      });

      expect(result.isSuccess).toBe(true);
      const content = await readFile(absolutePath, 'utf-8');
      expect(content).toBe('content');
    });

    it('should use context.workdirOverride when cwd not provided', async () => {
      const result = await executeWrite(
        { path: 'context.txt', content: 'from context' },
        { workdirOverride: tempDir }
      );

      expect(result.isSuccess).toBe(true);
      const content = await readFile(join(tempDir, 'context.txt'), 'utf-8');
      expect(content).toBe('from context');
    });
  });

  describe('Error handling', () => {
    it('should return error when content is missing', async () => {
      const result = await executeWrite({
        path: 'nocontent.txt',
        cwd: tempDir,
        // content is missing
      } as any);

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('content');
    });

    it('should return error when content is null', async () => {
      const result = await executeWrite({
        path: 'null.txt',
        cwd: tempDir,
        content: null as any,
      });

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('content');
    });
  });

  describe('Metadata', () => {
    it('should include bytesWritten in metadata', async () => {
      const content = 'Hello, World!';
      const result = await executeWrite({
        path: 'meta.txt',
        cwd: tempDir,
        content,
      });

      expect(result.metadata?.bytesWritten).toBe(content.length);
    });

    it('should include action=write in metadata', async () => {
      const result = await executeWrite({
        path: 'action.txt',
        cwd: tempDir,
        content: 'content',
      });

      expect(result.metadata?.action).toBe('write');
    });

    it('should record duration', async () => {
      const result = await executeWrite({
        path: 'timed.txt',
        cwd: tempDir,
        content: 'content',
      });

      expect(result.durationMs).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should include correct tool name', async () => {
      const result = await executeWrite({
        path: 'name.txt',
        cwd: tempDir,
        content: 'content',
      });

      expect(result.toolName).toBe('Write');
    });
  });
});

describe('executeEdit', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = createTempDir();
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Basic string replacement', () => {
    it('should replace single occurrence', async () => {
      await writeFile(join(tempDir, 'test.txt'), 'Hello, World!');

      const result = await executeEdit({
        path: 'test.txt',
        cwd: tempDir,
        oldString: 'World',
        newString: 'Universe',
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('Replaced 1 occurrence');

      const content = await readFile(join(tempDir, 'test.txt'), 'utf-8');
      expect(content).toBe('Hello, Universe!');
    });

    it('should preserve surrounding content', async () => {
      await writeFile(join(tempDir, 'preserve.txt'), 'before TARGET after');

      const result = await executeEdit({
        path: 'preserve.txt',
        cwd: tempDir,
        oldString: 'TARGET',
        newString: 'REPLACED',
      });

      expect(result.isSuccess).toBe(true);
      const content = await readFile(join(tempDir, 'preserve.txt'), 'utf-8');
      expect(content).toBe('before REPLACED after');
    });

    it('should handle multiline replacements', async () => {
      await writeFile(join(tempDir, 'multi.txt'), 'line1\nold\nline3');

      const result = await executeEdit({
        path: 'multi.txt',
        cwd: tempDir,
        oldString: 'old',
        newString: 'new',
      });

      expect(result.isSuccess).toBe(true);
      const content = await readFile(join(tempDir, 'multi.txt'), 'utf-8');
      expect(content).toBe('line1\nnew\nline3');
    });

    it('should handle replacing with empty string (deletion)', async () => {
      await writeFile(join(tempDir, 'delete.txt'), 'keep this remove this');

      const result = await executeEdit({
        path: 'delete.txt',
        cwd: tempDir,
        oldString: 'remove this',
        newString: '',
      });

      expect(result.isSuccess).toBe(true);
      const content = await readFile(join(tempDir, 'delete.txt'), 'utf-8');
      expect(content).toBe('keep this ');
    });

    it('should handle inserting text (empty oldString replacement)', async () => {
      // Note: This might not be the intended use case
      // An empty oldString would match at position 0
      await writeFile(join(tempDir, 'insert.txt'), 'existing');

      const result = await executeEdit({
        path: 'insert.txt',
        cwd: tempDir,
        oldString: '',
        newString: 'prefix',
      });

      // Empty string should fail validation
      expect(result.isSuccess).toBe(false);
    });
  });

  describe('Uniqueness checking', () => {
    it('should fail when oldString appears multiple times', async () => {
      await writeFile(join(tempDir, 'multi.txt'), 'foo bar foo baz foo');

      const result = await executeEdit({
        path: 'multi.txt',
        cwd: tempDir,
        oldString: 'foo',
        newString: 'replaced',
      });

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('3 times');
      expect(result.error).toContain('not unique');

      // File should be unchanged
      const content = await readFile(join(tempDir, 'multi.txt'), 'utf-8');
      expect(content).toBe('foo bar foo baz foo');
    });

    it('should provide context snippet for non-unique matches', async () => {
      await writeFile(join(tempDir, 'context.txt'), 'prefix foo suffix and more foo here');

      const result = await executeEdit({
        path: 'context.txt',
        cwd: tempDir,
        oldString: 'foo',
        newString: 'bar',
      });

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('First occurrence near');
    });

    it('should suggest using replaceAll for non-unique matches', async () => {
      await writeFile(join(tempDir, 'suggest.txt'), 'a a');

      const result = await executeEdit({
        path: 'suggest.txt',
        cwd: tempDir,
        oldString: 'a',
        newString: 'b',
      });

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('replaceAll');
    });
  });

  describe('replaceAll option', () => {
    it('should replace all occurrences when replaceAll=true', async () => {
      await writeFile(join(tempDir, 'all.txt'), 'foo bar foo baz foo');

      const result = await executeEdit({
        path: 'all.txt',
        cwd: tempDir,
        oldString: 'foo',
        newString: 'replaced',
        replaceAll: true,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('Replaced 3 occurrence');
      expect(result.metadata?.replacements).toBe(3);

      const content = await readFile(join(tempDir, 'all.txt'), 'utf-8');
      expect(content).toBe('replaced bar replaced baz replaced');
    });

    it('should work with replaceAll when only one occurrence', async () => {
      await writeFile(join(tempDir, 'one.txt'), 'just one foo here');

      const result = await executeEdit({
        path: 'one.txt',
        cwd: tempDir,
        oldString: 'foo',
        newString: 'bar',
        replaceAll: true,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.metadata?.replacements).toBe(1);
    });
  });

  describe('String not found', () => {
    it('should return error when oldString not found', async () => {
      await writeFile(join(tempDir, 'notfound.txt'), 'some content here');

      const result = await executeEdit({
        path: 'notfound.txt',
        cwd: tempDir,
        oldString: 'nonexistent',
        newString: 'replacement',
      });

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('not found');

      // File should be unchanged
      const content = await readFile(join(tempDir, 'notfound.txt'), 'utf-8');
      expect(content).toBe('some content here');
    });

    it('should suggest verifying whitespace', async () => {
      await writeFile(join(tempDir, 'whitespace.txt'), 'content  here');

      const result = await executeEdit({
        path: 'whitespace.txt',
        cwd: tempDir,
        oldString: 'content here', // Missing double space
        newString: 'new',
      });

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('whitespace');
    });
  });

  describe('File not found', () => {
    it('should return error for non-existent file', async () => {
      const result = await executeEdit({
        path: 'missing.txt',
        cwd: tempDir,
        oldString: 'old',
        newString: 'new',
      });

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('not found');
      expect(result.error).toContain('Use Write');
    });
  });

  describe('Whitespace handling', () => {
    it('should match exact whitespace', async () => {
      await writeFile(join(tempDir, 'ws.txt'), 'a  b'); // Two spaces

      const result = await executeEdit({
        path: 'ws.txt',
        cwd: tempDir,
        oldString: 'a  b', // Two spaces
        newString: 'a b', // One space
      });

      expect(result.isSuccess).toBe(true);
      const content = await readFile(join(tempDir, 'ws.txt'), 'utf-8');
      expect(content).toBe('a b');
    });

    it('should preserve indentation', async () => {
      await writeFile(join(tempDir, 'indent.txt'), '    function foo() {\n    }');

      const result = await executeEdit({
        path: 'indent.txt',
        cwd: tempDir,
        oldString: '    function foo()',
        newString: '    function bar()',
      });

      expect(result.isSuccess).toBe(true);
      const content = await readFile(join(tempDir, 'indent.txt'), 'utf-8');
      expect(content).toBe('    function bar() {\n    }');
    });

    it('should handle tabs vs spaces', async () => {
      await writeFile(join(tempDir, 'tabs.txt'), '\tindented');

      const result = await executeEdit({
        path: 'tabs.txt',
        cwd: tempDir,
        oldString: '\tindented',
        newString: '  indented', // Replace tab with spaces
      });

      expect(result.isSuccess).toBe(true);
      const content = await readFile(join(tempDir, 'tabs.txt'), 'utf-8');
      expect(content).toBe('  indented');
    });

    it('should handle newline differences (CR vs LF vs CRLF)', async () => {
      await writeFile(join(tempDir, 'crlf.txt'), 'line1\r\nline2');

      const result = await executeEdit({
        path: 'crlf.txt',
        cwd: tempDir,
        oldString: 'line1\r\nline2',
        newString: 'line1\nline2', // Convert to LF
      });

      expect(result.isSuccess).toBe(true);
      const content = await readFile(join(tempDir, 'crlf.txt'), 'utf-8');
      expect(content).toBe('line1\nline2');
    });
  });

  describe('Edge cases', () => {
    it('should handle replacing entire file content', async () => {
      await writeFile(join(tempDir, 'entire.txt'), 'old content');

      const result = await executeEdit({
        path: 'entire.txt',
        cwd: tempDir,
        oldString: 'old content',
        newString: 'new content',
      });

      expect(result.isSuccess).toBe(true);
      const content = await readFile(join(tempDir, 'entire.txt'), 'utf-8');
      expect(content).toBe('new content');
    });

    it('should handle very long replacement strings', async () => {
      await writeFile(join(tempDir, 'long.txt'), 'short');

      const longString = 'x'.repeat(100000);
      const result = await executeEdit({
        path: 'long.txt',
        cwd: tempDir,
        oldString: 'short',
        newString: longString,
      });

      expect(result.isSuccess).toBe(true);
      const content = await readFile(join(tempDir, 'long.txt'), 'utf-8');
      expect(content).toBe(longString);
    });

    it('should handle special characters in oldString', async () => {
      await writeFile(join(tempDir, 'special.txt'), 'price: $100.00');

      const result = await executeEdit({
        path: 'special.txt',
        cwd: tempDir,
        oldString: '$100.00',
        newString: '$200.00',
      });

      expect(result.isSuccess).toBe(true);
      const content = await readFile(join(tempDir, 'special.txt'), 'utf-8');
      expect(content).toBe('price: $200.00');
    });

    it('should handle regex-like patterns literally', async () => {
      // The edit uses indexOf, not regex, so special chars are literal
      await writeFile(join(tempDir, 'regex.txt'), 'foo.*bar');

      const result = await executeEdit({
        path: 'regex.txt',
        cwd: tempDir,
        oldString: '.*',
        newString: '-',
      });

      expect(result.isSuccess).toBe(true);
      const content = await readFile(join(tempDir, 'regex.txt'), 'utf-8');
      expect(content).toBe('foo-bar');
    });

    it('BUG CANDIDATE: newString containing oldString could create infinite loop', async () => {
      // When using replaceAll with split/join, this is safe
      // But documents the consideration
      await writeFile(join(tempDir, 'contains.txt'), 'foo bar');

      const result = await executeEdit({
        path: 'contains.txt',
        cwd: tempDir,
        oldString: 'foo',
        newString: 'foofoo', // Contains oldString
        replaceAll: true,
      });

      expect(result.isSuccess).toBe(true);
      // Should only replace original occurrences
      const content = await readFile(join(tempDir, 'contains.txt'), 'utf-8');
      expect(content).toBe('foofoo bar');
    });
  });

  describe('Atomic writes', () => {
    it('should indicate atomic write in metadata', async () => {
      await writeFile(join(tempDir, 'atomic.txt'), 'original');

      const result = await executeEdit({
        path: 'atomic.txt',
        cwd: tempDir,
        oldString: 'original',
        newString: 'edited',
      });

      expect(result.metadata?.atomic).toBe(true);
    });
  });

  describe('Path resolution', () => {
    it('should resolve relative paths from cwd', async () => {
      await mkdir(join(tempDir, 'subdir'), { recursive: true });
      await writeFile(join(tempDir, 'subdir', 'file.txt'), 'old');

      const result = await executeEdit({
        path: 'subdir/file.txt',
        cwd: tempDir,
        oldString: 'old',
        newString: 'new',
      });

      expect(result.isSuccess).toBe(true);
      expect(result.metadata?.path).toBe(resolve(tempDir, 'subdir/file.txt'));
    });

    it('should use context.workdirOverride', async () => {
      await writeFile(join(tempDir, 'context.txt'), 'original');

      const result = await executeEdit(
        { path: 'context.txt', oldString: 'original', newString: 'edited' },
        { workdirOverride: tempDir }
      );

      expect(result.isSuccess).toBe(true);
    });
  });

  describe('Metadata', () => {
    it('should include bytesWritten', async () => {
      await writeFile(join(tempDir, 'bytes.txt'), 'short');

      const result = await executeEdit({
        path: 'bytes.txt',
        cwd: tempDir,
        oldString: 'short',
        newString: 'longer string',
      });

      expect(result.metadata?.bytesWritten).toBe('longer string'.length);
    });

    it('should include action=edit', async () => {
      await writeFile(join(tempDir, 'action.txt'), 'old');

      const result = await executeEdit({
        path: 'action.txt',
        cwd: tempDir,
        oldString: 'old',
        newString: 'new',
      });

      expect(result.metadata?.action).toBe('edit');
    });

    it('should include replacements count', async () => {
      await writeFile(join(tempDir, 'count.txt'), 'a a a');

      const result = await executeEdit({
        path: 'count.txt',
        cwd: tempDir,
        oldString: 'a',
        newString: 'b',
        replaceAll: true,
      });

      expect(result.metadata?.replacements).toBe(3);
    });

    it('should record duration', async () => {
      await writeFile(join(tempDir, 'time.txt'), 'content');

      const result = await executeEdit({
        path: 'time.txt',
        cwd: tempDir,
        oldString: 'content',
        newString: 'new',
      });

      expect(result.durationMs).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should have correct tool name', async () => {
      await writeFile(join(tempDir, 'name.txt'), 'content');

      const result = await executeEdit({
        path: 'name.txt',
        cwd: tempDir,
        oldString: 'content',
        newString: 'new',
      });

      expect(result.toolName).toBe('Edit');
    });
  });

  describe('Error handling', () => {
    it('should fail when oldString is missing', async () => {
      await writeFile(join(tempDir, 'missing.txt'), 'content');

      const result = await executeEdit({
        path: 'missing.txt',
        cwd: tempDir,
        newString: 'new',
      } as any);

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('oldString');
    });

    it('should fail when newString is missing', async () => {
      await writeFile(join(tempDir, 'missing.txt'), 'content');

      const result = await executeEdit({
        path: 'missing.txt',
        cwd: tempDir,
        oldString: 'content',
      } as any);

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('newString');
    });
  });
});
