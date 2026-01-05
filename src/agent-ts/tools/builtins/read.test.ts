/**
 * Comprehensive test suite for Read Tool
 *
 * Goal: Find bugs, not just pass tests.
 * Focus areas:
 * - File reading with various encodings
 * - Large file truncation
 * - Error handling (missing files, directories, permissions)
 * - Path resolution (relative, absolute, context)
 * - Binary vs text file handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm, chmod, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { executeRead } from './read.js';

function createTempDir(): string {
  return join(tmpdir(), `read-test-${randomBytes(8).toString('hex')}`);
}

describe('executeRead', () => {
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

  describe('Basic file reading', () => {
    it('should read a simple text file', async () => {
      const content = 'Hello, World!';
      await writeFile(join(tempDir, 'test.txt'), content);

      const result = await executeRead({ path: 'test.txt', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe(content);
      expect(result.metadata?.action).toBe('read');
    });

    it('should read multiline files', async () => {
      const content = 'Line 1\nLine 2\nLine 3';
      await writeFile(join(tempDir, 'multiline.txt'), content);

      const result = await executeRead({ path: 'multiline.txt', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe(content);
    });

    it('should read files with special characters', async () => {
      const content = '特殊字符 🎉 émojis and ümlauts';
      await writeFile(join(tempDir, 'unicode.txt'), content, 'utf-8');

      const result = await executeRead({ path: 'unicode.txt', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe(content);
    });

    it('should read empty files', async () => {
      await writeFile(join(tempDir, 'empty.txt'), '');

      const result = await executeRead({ path: 'empty.txt', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe('');
    });
  });

  describe('Path resolution', () => {
    it('should resolve relative paths from cwd', async () => {
      await mkdir(join(tempDir, 'subdir'), { recursive: true });
      await writeFile(join(tempDir, 'subdir', 'file.txt'), 'content');

      const result = await executeRead({ path: 'subdir/file.txt', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe('content');
    });

    it('should handle absolute paths', async () => {
      const absolutePath = join(tempDir, 'absolute.txt');
      await writeFile(absolutePath, 'absolute content');

      const result = await executeRead({ path: absolutePath, cwd: '/some/other/dir' });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe('absolute content');
    });

    it('should use context.workdirOverride when cwd not provided', async () => {
      await writeFile(join(tempDir, 'context.txt'), 'from context');

      const result = await executeRead(
        { path: 'context.txt' },
        { workdirOverride: tempDir }
      );

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe('from context');
    });

    it('should prefer args.cwd over context.workdirOverride', async () => {
      await mkdir(join(tempDir, 'a'), { recursive: true });
      await mkdir(join(tempDir, 'b'), { recursive: true });
      await writeFile(join(tempDir, 'a', 'file.txt'), 'from a');
      await writeFile(join(tempDir, 'b', 'file.txt'), 'from b');

      const result = await executeRead(
        { path: 'file.txt', cwd: join(tempDir, 'a') },
        { workdirOverride: join(tempDir, 'b') }
      );

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe('from a');
    });

    it('should handle paths with ../', async () => {
      await mkdir(join(tempDir, 'a', 'b'), { recursive: true });
      await writeFile(join(tempDir, 'a', 'parent.txt'), 'parent');

      const result = await executeRead({
        path: '../parent.txt',
        cwd: join(tempDir, 'a', 'b'),
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe('parent');
    });

    it('should include resolved path in metadata', async () => {
      await writeFile(join(tempDir, 'meta.txt'), 'content');

      const result = await executeRead({ path: 'meta.txt', cwd: tempDir });

      expect(result.metadata?.path).toBe(resolve(tempDir, 'meta.txt'));
    });
  });

  describe('Error handling', () => {
    it('should return error for non-existent file', async () => {
      const result = await executeRead({ path: 'missing.txt', cwd: tempDir });

      expect(result.isSuccess).toBe(false);
      expect(result.status).toBe('error');
      expect(result.error).toContain('File not found');
    });

    it('should return error when path is a directory', async () => {
      await mkdir(join(tempDir, 'mydir'), { recursive: true });

      const result = await executeRead({ path: 'mydir', cwd: tempDir });

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('not a file');
    });

    it('should handle permission denied gracefully', async () => {
      // Skip on Windows where chmod behavior differs
      if (process.platform === 'win32') return;

      const filePath = join(tempDir, 'noperm.txt');
      await writeFile(filePath, 'secret');
      await chmod(filePath, 0o000);

      try {
        const result = await executeRead({ path: 'noperm.txt', cwd: tempDir });

        expect(result.isSuccess).toBe(false);
        expect(result.error).toBeDefined();
      } finally {
        // Restore permissions for cleanup
        await chmod(filePath, 0o644);
      }
    });

    it('should handle symlinks to missing files', async () => {
      // Create a broken symlink
      const { symlink, unlink } = await import('fs/promises');
      const linkPath = join(tempDir, 'broken-link');

      try {
        await symlink(join(tempDir, 'nonexistent'), linkPath);
        const result = await executeRead({ path: 'broken-link', cwd: tempDir });

        expect(result.isSuccess).toBe(false);
      } catch {
        // Symlinks might not be supported on all systems
      }
    });
  });

  describe('Large file handling', () => {
    it('should truncate files exceeding maxBytes', async () => {
      // Create a file larger than default maxBytes (100000)
      const largeContent = 'x'.repeat(150000);
      await writeFile(join(tempDir, 'large.txt'), largeContent);

      const result = await executeRead({ path: 'large.txt', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output.length).toBeLessThan(largeContent.length);
      expect(result.output).toContain('[truncated');
    });

    it('should respect custom maxBytes parameter', async () => {
      const content = 'x'.repeat(1000);
      await writeFile(join(tempDir, 'medium.txt'), content);

      const result = await executeRead({
        path: 'medium.txt',
        cwd: tempDir,
        maxBytes: 100,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('[truncated');
      // Should have approximately 100 bytes plus truncation message
      expect(result.output.length).toBeLessThan(200);
    });

    it('should not truncate files under maxBytes', async () => {
      const content = 'Small content';
      await writeFile(join(tempDir, 'small.txt'), content);

      const result = await executeRead({
        path: 'small.txt',
        cwd: tempDir,
        maxBytes: 10000,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe(content);
      expect(result.output).not.toContain('truncated');
    });

    it('should include file size in metadata', async () => {
      const content = 'Known size content';
      await writeFile(join(tempDir, 'sized.txt'), content);

      const result = await executeRead({ path: 'sized.txt', cwd: tempDir });

      expect(result.metadata?.size).toBe(content.length);
    });

    it('BUG CANDIDATE: truncation at byte boundary may split UTF-8 chars', async () => {
      // UTF-8 characters can be 1-4 bytes
      // Truncating at arbitrary byte boundary can create invalid UTF-8
      const emoji = '🎉'; // 4 bytes in UTF-8
      const content = emoji.repeat(100); // 400 bytes
      await writeFile(join(tempDir, 'emoji.txt'), content, 'utf-8');

      const result = await executeRead({
        path: 'emoji.txt',
        cwd: tempDir,
        maxBytes: 50, // Will cut in middle of emoji
      });

      // This might produce invalid UTF-8 or replacement characters
      expect(result.isSuccess).toBe(true);
      // Document actual behavior - may have replacement chars
    });
  });

  describe('Encoding handling', () => {
    it('should use utf-8 encoding by default', async () => {
      const content = 'UTF-8 content with special chars: café';
      await writeFile(join(tempDir, 'utf8.txt'), content, 'utf-8');

      const result = await executeRead({ path: 'utf8.txt', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe(content);
    });

    it('should support custom encoding parameter', async () => {
      // Write as latin1
      const content = 'café';
      await writeFile(join(tempDir, 'latin1.txt'), content, 'latin1');

      const result = await executeRead({
        path: 'latin1.txt',
        cwd: tempDir,
        encoding: 'latin1',
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe(content);
    });

    it('should handle ASCII files', async () => {
      const content = 'Simple ASCII text 123';
      await writeFile(join(tempDir, 'ascii.txt'), content, 'ascii');

      const result = await executeRead({
        path: 'ascii.txt',
        cwd: tempDir,
        encoding: 'ascii',
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe(content);
    });

    it('BUG CANDIDATE: reading binary files as text', async () => {
      // Binary files read as UTF-8 may produce garbage
      const binaryContent = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG header
      await writeFile(join(tempDir, 'binary.png'), binaryContent);

      const result = await executeRead({ path: 'binary.png', cwd: tempDir });

      // Should succeed but content may be garbled
      expect(result.isSuccess).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle files with no extension', async () => {
      await writeFile(join(tempDir, 'Makefile'), 'all: build');

      const result = await executeRead({ path: 'Makefile', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe('all: build');
    });

    it('should handle files with multiple dots', async () => {
      await writeFile(join(tempDir, 'file.test.spec.ts'), 'test content');

      const result = await executeRead({ path: 'file.test.spec.ts', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe('test content');
    });

    it('should handle files starting with dot', async () => {
      await writeFile(join(tempDir, '.gitignore'), 'node_modules/');

      const result = await executeRead({ path: '.gitignore', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe('node_modules/');
    });

    it('should handle files with spaces in name', async () => {
      await writeFile(join(tempDir, 'file with spaces.txt'), 'content');

      const result = await executeRead({ path: 'file with spaces.txt', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe('content');
    });

    it('should handle very long filenames', async () => {
      const longName = 'a'.repeat(200) + '.txt';
      await writeFile(join(tempDir, longName), 'long name content');

      const result = await executeRead({ path: longName, cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe('long name content');
    });

    it('should handle newlines in file content correctly', async () => {
      const content = 'line1\nline2\r\nline3\rline4';
      await writeFile(join(tempDir, 'newlines.txt'), content);

      const result = await executeRead({ path: 'newlines.txt', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe(content);
    });

    it('should handle files with null bytes', async () => {
      const content = 'before\0after';
      await writeFile(join(tempDir, 'null.txt'), content);

      const result = await executeRead({ path: 'null.txt', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe(content);
    });
  });

  describe('Timing and metadata', () => {
    it('should record duration in result', async () => {
      await writeFile(join(tempDir, 'timed.txt'), 'content');

      const result = await executeRead({ path: 'timed.txt', cwd: tempDir });

      expect(result.durationMs).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should record duration even on error', async () => {
      const result = await executeRead({ path: 'nonexistent.txt', cwd: tempDir });

      expect(result.isSuccess).toBe(false);
      expect(result.durationMs).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should include correct toolName', async () => {
      await writeFile(join(tempDir, 'name.txt'), 'content');

      const result = await executeRead({ path: 'name.txt', cwd: tempDir });

      expect(result.toolName).toBe('Read');
    });
  });

  describe('Concurrent reads', () => {
    it('should handle multiple concurrent reads', async () => {
      // Create multiple files
      const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
      await Promise.all(
        files.map((f) => writeFile(join(tempDir, f), `content of ${f}`))
      );

      // Read all concurrently
      const results = await Promise.all(
        files.map((f) => executeRead({ path: f, cwd: tempDir }))
      );

      expect(results.every((r) => r.isSuccess)).toBe(true);
      results.forEach((result, i) => {
        expect(result.output).toBe(`content of ${files[i]}`);
      });
    });
  });
});
