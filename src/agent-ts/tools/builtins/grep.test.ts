/**
 * Comprehensive test suite for Grep Tool
 *
 * Goal: Find bugs, not just pass tests.
 * Focus areas:
 * - Regex pattern matching (valid and invalid patterns)
 * - Case sensitivity handling
 * - Directory traversal with exclusions
 * - Result formatting and truncation
 * - Single file vs directory search
 * - Line number accuracy
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { executeGrep } from './grep.js';

function createTempDir(): string {
  return join(tmpdir(), `grep-test-${randomBytes(8).toString('hex')}`);
}

describe('executeGrep', () => {
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

  describe('Basic pattern matching', () => {
    it('should find simple string pattern', async () => {
      await writeFile(join(tempDir, 'test.ts'), 'function hello() {\n  return "world";\n}');

      const result = await executeGrep({ pattern: 'hello', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('test.ts');
      expect(result.output).toContain('hello');
    });

    it('should find multiple matches in same file', async () => {
      await writeFile(
        join(tempDir, 'multi.ts'),
        'const foo = 1;\nconst foobar = 2;\nconst bazfoo = 3;'
      );

      const result = await executeGrep({ pattern: 'foo', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      // Should find 3 matches
      const lines = result.output.split('\n').filter((l) => l.includes('foo'));
      expect(lines.length).toBe(3);
    });

    it('should find matches across multiple files', async () => {
      await writeFile(join(tempDir, 'a.ts'), 'pattern here');
      await writeFile(join(tempDir, 'b.ts'), 'also pattern');
      await writeFile(join(tempDir, 'c.ts'), 'no match');

      const result = await executeGrep({ pattern: 'pattern', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('a.ts');
      expect(result.output).toContain('b.ts');
      expect(result.output).not.toContain('c.ts');
    });

    it('should report no matches found', async () => {
      await writeFile(join(tempDir, 'test.ts'), 'nothing to find here');

      const result = await executeGrep({ pattern: 'xyz123', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('No matches found');
    });
  });

  describe('Regex patterns', () => {
    it('should support regex wildcards', async () => {
      await writeFile(join(tempDir, 'regex.ts'), 'foo123bar\nfoo456bar\nfooxyzbar');

      const result = await executeGrep({ pattern: 'foo.*bar', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.metadata?.matchCount).toBe(3);
    });

    it('should support character classes', async () => {
      await writeFile(join(tempDir, 'class.ts'), 'cat\nhat\nbat\nrat');

      const result = await executeGrep({ pattern: '[chb]at', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('cat');
      expect(result.output).toContain('hat');
      expect(result.output).toContain('bat');
      expect(result.output).not.toContain(':4:'); // rat is on line 4
    });

    it('should support anchors (^ and $)', async () => {
      await writeFile(
        join(tempDir, 'anchor.ts'),
        'start of line\nmiddle start\nend of line\nline end'
      );

      const result = await executeGrep({ pattern: '^start', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain(':1:');
      expect(result.output).not.toContain(':2:'); // "middle start" shouldn't match
    });

    it('should return error for invalid regex', async () => {
      await writeFile(join(tempDir, 'test.ts'), 'content');

      const result = await executeGrep({ pattern: '[invalid', cwd: tempDir });

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('Invalid regex');
    });

    it('should support quantifiers (+, *, ?)', async () => {
      await writeFile(join(tempDir, 'quant.ts'), 'color\ncolour\ncolouur\nclr');

      const result = await executeGrep({ pattern: 'colou?r', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('color');
      expect(result.output).toContain('colour');
      expect(result.output).not.toContain('clr');
    });

    it('should support alternation (|)', async () => {
      await writeFile(join(tempDir, 'alt.ts'), 'dog\ncat\nbird\nfish');

      const result = await executeGrep({ pattern: 'dog|cat', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('dog');
      expect(result.output).toContain('cat');
      expect(result.output).not.toContain('bird');
    });

    it('should support word boundaries', async () => {
      await writeFile(join(tempDir, 'word.ts'), 'log\nlogging\nblog\nlogical');

      const result = await executeGrep({ pattern: '\\blog\\b', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain(':1:');
      // Only exact "log" should match, not "logging", "blog", "logical"
    });
  });

  describe('Case sensitivity', () => {
    it('should be case insensitive by default', async () => {
      await writeFile(join(tempDir, 'case.ts'), 'Hello\nhello\nHELLO');

      const result = await executeGrep({ pattern: 'hello', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.metadata?.matchCount).toBe(3);
    });

    it('should respect caseSensitive=true', async () => {
      await writeFile(join(tempDir, 'case.ts'), 'Hello\nhello\nHELLO');

      const result = await executeGrep({
        pattern: 'hello',
        cwd: tempDir,
        caseSensitive: true,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.metadata?.matchCount).toBe(1);
      expect(result.output).toContain(':2:'); // Only line 2 "hello"
    });

    it('should handle mixed case in regex character classes', async () => {
      await writeFile(join(tempDir, 'mixed.ts'), 'Abc\nabc\nABC');

      const result = await executeGrep({
        pattern: '[A-Z]bc',
        cwd: tempDir,
        caseSensitive: true,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('Abc');
      expect(result.output).not.toContain(':2:'); // 'abc' shouldn't match
    });
  });

  describe('Directory traversal', () => {
    it('should search recursively in subdirectories', async () => {
      await mkdir(join(tempDir, 'src', 'components'), { recursive: true });
      await writeFile(join(tempDir, 'root.ts'), 'pattern');
      await writeFile(join(tempDir, 'src', 'index.ts'), 'pattern');
      await writeFile(join(tempDir, 'src', 'components', 'Button.ts'), 'pattern');

      const result = await executeGrep({ pattern: 'pattern', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('root.ts');
      expect(result.output).toContain('src/index.ts');
      expect(result.output).toContain('src/components/Button.ts');
    });

    it('should skip node_modules', async () => {
      await mkdir(join(tempDir, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(join(tempDir, 'node_modules', 'pkg', 'index.js'), 'pattern');
      await writeFile(join(tempDir, 'src.ts'), 'pattern');

      const result = await executeGrep({ pattern: 'pattern', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('src.ts');
      expect(result.output).not.toContain('node_modules');
    });

    it('should skip __pycache__', async () => {
      await mkdir(join(tempDir, '__pycache__'), { recursive: true });
      await writeFile(join(tempDir, '__pycache__', 'module.cpython-39.pyc'), 'pattern');
      await writeFile(join(tempDir, 'module.py'), 'pattern');

      const result = await executeGrep({ pattern: 'pattern', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).not.toContain('__pycache__');
    });

    it('should skip .git directory', async () => {
      await mkdir(join(tempDir, '.git', 'objects'), { recursive: true });
      await writeFile(join(tempDir, '.git', 'config'), 'pattern');
      await writeFile(join(tempDir, 'source.ts'), 'pattern');

      const result = await executeGrep({ pattern: 'pattern', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).not.toContain('.git');
    });

    it('should skip binary file extensions', async () => {
      await writeFile(join(tempDir, 'source.py'), 'pattern');
      await writeFile(join(tempDir, 'compiled.pyc'), 'pattern');
      await writeFile(join(tempDir, 'binary.so'), 'pattern');

      const result = await executeGrep({ pattern: 'pattern', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('source.py');
      expect(result.output).not.toContain('.pyc');
      expect(result.output).not.toContain('.so');
    });
  });

  describe('Path scoping', () => {
    it('should search specific path when provided', async () => {
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await mkdir(join(tempDir, 'lib'), { recursive: true });
      await writeFile(join(tempDir, 'src', 'file.ts'), 'pattern');
      await writeFile(join(tempDir, 'lib', 'file.ts'), 'pattern');

      const result = await executeGrep({
        pattern: 'pattern',
        cwd: tempDir,
        path: 'src',
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('src/file.ts');
      expect(result.output).not.toContain('lib');
    });

    it('should search single file when path is a file', async () => {
      await writeFile(join(tempDir, 'target.ts'), 'pattern\npattern');
      await writeFile(join(tempDir, 'other.ts'), 'pattern');

      const result = await executeGrep({
        pattern: 'pattern',
        cwd: tempDir,
        path: 'target.ts',
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('target.ts');
      expect(result.output).not.toContain('other.ts');
    });

    it('should handle absolute path', async () => {
      await writeFile(join(tempDir, 'absolute.ts'), 'pattern');

      const result = await executeGrep({
        pattern: 'pattern',
        cwd: '/some/other/dir',
        path: tempDir,
      });

      expect(result.isSuccess).toBe(true);
    });
  });

  describe('Result formatting', () => {
    it('should include file path, line number, and content', async () => {
      await writeFile(join(tempDir, 'format.ts'), 'line 1\nmatch here\nline 3');

      const result = await executeGrep({ pattern: 'match', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toMatch(/format\.ts:2:.*match here/);
    });

    it('should show correct line numbers', async () => {
      await writeFile(
        join(tempDir, 'lines.ts'),
        'no\nno\nno\nfound\nno\nfound\nno'
      );

      const result = await executeGrep({ pattern: 'found', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain(':4:');
      expect(result.output).toContain(':6:');
    });

    it('should truncate long lines at 200 characters', async () => {
      const longLine = 'x'.repeat(300) + 'pattern' + 'y'.repeat(300);
      await writeFile(join(tempDir, 'long.ts'), longLine);

      const result = await executeGrep({ pattern: 'pattern', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      // Line should be truncated
      const lineContent = result.output.split(':').slice(2).join(':');
      expect(lineContent.length).toBeLessThanOrEqual(201); // 200 + newline
    });
  });

  describe('Result truncation', () => {
    it('should respect maxResults parameter', async () => {
      // Create file with many matches
      const lines = Array(50).fill('pattern').join('\n');
      await writeFile(join(tempDir, 'many.ts'), lines);

      const result = await executeGrep({
        pattern: 'pattern',
        cwd: tempDir,
        maxResults: 5,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.metadata?.matchCount).toBe(5);
      expect(result.metadata?.truncated).toBe(true);
      expect(result.output).toContain('[truncated at 5 results]');
    });

    it('should not truncate when under maxResults', async () => {
      await writeFile(join(tempDir, 'few.ts'), 'pattern\npattern\npattern');

      const result = await executeGrep({
        pattern: 'pattern',
        cwd: tempDir,
        maxResults: 10,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.metadata?.truncated).toBe(false);
      expect(result.output).not.toContain('truncated');
    });

    it('should default to 20 maxResults', async () => {
      const lines = Array(30).fill('pattern').join('\n');
      await writeFile(join(tempDir, 'default.ts'), lines);

      const result = await executeGrep({ pattern: 'pattern', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.metadata?.matchCount).toBe(20);
      expect(result.metadata?.truncated).toBe(true);
    });
  });

  describe('Context handling', () => {
    it('should use context.workdirOverride when cwd not provided', async () => {
      await writeFile(join(tempDir, 'context.ts'), 'pattern');

      const result = await executeGrep(
        { pattern: 'pattern' },
        { workdirOverride: tempDir }
      );

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('context.ts');
    });

    it('should prefer args.cwd over context.workdirOverride', async () => {
      await mkdir(join(tempDir, 'a'), { recursive: true });
      await mkdir(join(tempDir, 'b'), { recursive: true });
      await writeFile(join(tempDir, 'a', 'file.ts'), 'pattern');
      await writeFile(join(tempDir, 'b', 'file.ts'), 'other');

      const result = await executeGrep(
        { pattern: 'pattern', cwd: join(tempDir, 'a') },
        { workdirOverride: join(tempDir, 'b') }
      );

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('file.ts');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty files', async () => {
      await writeFile(join(tempDir, 'empty.ts'), '');

      const result = await executeGrep({ pattern: 'anything', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('No matches found');
    });

    it('should handle files with only whitespace', async () => {
      await writeFile(join(tempDir, 'whitespace.ts'), '   \n\n   \n');

      const result = await executeGrep({ pattern: 'content', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('No matches found');
    });

    it('should handle empty directory', async () => {
      const result = await executeGrep({ pattern: 'anything', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('No matches found');
    });

    it('should handle files with Unicode content', async () => {
      await writeFile(join(tempDir, 'unicode.ts'), '日本語 pattern 中文');

      const result = await executeGrep({ pattern: 'pattern', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('unicode.ts');
    });

    it('should handle pattern with special regex chars that need escaping', async () => {
      await writeFile(join(tempDir, 'special.ts'), 'const x = foo.bar()');

      // User wants literal "foo.bar" but . is regex wildcard
      const result = await executeGrep({ pattern: 'foo\\.bar', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('foo.bar');
    });

    it('BUG CANDIDATE: global regex lastIndex not always reset', async () => {
      // The implementation uses global regex with test()
      // If lastIndex isn't reset properly, alternating matches can fail
      await writeFile(
        join(tempDir, 'lastindex.ts'),
        'pattern\npattern\npattern\npattern'
      );

      const result = await executeGrep({
        pattern: 'pattern',
        cwd: tempDir,
        maxResults: 100,
      });

      expect(result.isSuccess).toBe(true);
      // Should find all 4 matches
      expect(result.metadata?.matchCount).toBe(4);
    });

    it('should handle very long files efficiently', async () => {
      // Create a file with many lines
      const lines = Array(10000)
        .fill(null)
        .map((_, i) => (i === 5000 ? 'needle' : 'haystack'))
        .join('\n');
      await writeFile(join(tempDir, 'large.ts'), lines);

      const startTime = Date.now();
      const result = await executeGrep({ pattern: 'needle', cwd: tempDir });
      const duration = Date.now() - startTime;

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('needle');
      // Should complete reasonably quickly
      expect(duration).toBeLessThan(5000);
    });

    it('should handle binary content in text files gracefully', async () => {
      // File with some binary-like content
      const content = 'text\x00binary\x01content\npattern';
      await writeFile(join(tempDir, 'mixed.ts'), content);

      const result = await executeGrep({ pattern: 'pattern', cwd: tempDir });

      // Should still work, though content may be garbled
      expect(result.isSuccess).toBe(true);
    });
  });

  describe('Metadata validation', () => {
    it('should include pattern in metadata', async () => {
      await writeFile(join(tempDir, 'meta.ts'), 'pattern');

      // Use a pattern that will match so metadata is populated
      const result = await executeGrep({ pattern: 'pattern', cwd: tempDir });

      expect(result.metadata?.pattern).toBe('pattern');
    });

    it('should record correct tool name', async () => {
      await writeFile(join(tempDir, 'tool.ts'), 'content');

      const result = await executeGrep({ pattern: 'content', cwd: tempDir });

      expect(result.toolName).toBe('Grep');
    });

    it('should record duration', async () => {
      await writeFile(join(tempDir, 'time.ts'), 'content');

      const result = await executeGrep({ pattern: 'content', cwd: tempDir });

      expect(result.durationMs).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
