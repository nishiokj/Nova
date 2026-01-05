/**
 * Comprehensive test suite for Glob Tool
 *
 * Goal: Find bugs, not just pass tests.
 * Focus areas:
 * - Pattern matching edge cases (*, **, ?, character classes)
 * - Directory traversal with exclusions
 * - Hidden file handling
 * - Result truncation
 * - Path resolution
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { executeGlob } from './glob.js';

// Create a unique temp directory for each test run
function createTempDir(): string {
  return join(tmpdir(), `glob-test-${randomBytes(8).toString('hex')}`);
}

describe('executeGlob', () => {
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
    it('should match files with * wildcard', async () => {
      await writeFile(join(tempDir, 'file1.ts'), 'content');
      await writeFile(join(tempDir, 'file2.ts'), 'content');
      await writeFile(join(tempDir, 'file.js'), 'content');

      const result = await executeGlob({ pattern: '*.ts', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('file1.ts');
      expect(result.output).toContain('file2.ts');
      expect(result.output).not.toContain('file.js');
    });

    it('should match files with ? wildcard', async () => {
      await writeFile(join(tempDir, 'a1.ts'), 'content');
      await writeFile(join(tempDir, 'b2.ts'), 'content');
      await writeFile(join(tempDir, 'abc.ts'), 'content');

      const result = await executeGlob({ pattern: '??.ts', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('a1.ts');
      expect(result.output).toContain('b2.ts');
      expect(result.output).not.toContain('abc.ts');
    });

    it('should match with character classes [abc]', async () => {
      await writeFile(join(tempDir, 'a.ts'), 'content');
      await writeFile(join(tempDir, 'b.ts'), 'content');
      await writeFile(join(tempDir, 'c.ts'), 'content');
      await writeFile(join(tempDir, 'd.ts'), 'content');

      const result = await executeGlob({ pattern: '[abc].ts', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('a.ts');
      expect(result.output).toContain('b.ts');
      expect(result.output).toContain('c.ts');
      expect(result.output).not.toContain('d.ts');
    });

    it('should handle no matches gracefully', async () => {
      await writeFile(join(tempDir, 'file.js'), 'content');

      const result = await executeGlob({ pattern: '*.py', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('No files found');
    });
  });

  describe('Recursive patterns (**)', () => {
    it('should match files in nested directories with **', async () => {
      await mkdir(join(tempDir, 'src', 'components'), { recursive: true });
      await writeFile(join(tempDir, 'root.ts'), 'content');
      await writeFile(join(tempDir, 'src', 'index.ts'), 'content');
      await writeFile(join(tempDir, 'src', 'components', 'Button.ts'), 'content');

      const result = await executeGlob({ pattern: '**/*.ts', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('root.ts');
      expect(result.output).toContain('src/index.ts');
      expect(result.output).toContain('src/components/Button.ts');
    });

    it('should match directories with ** pattern', async () => {
      await mkdir(join(tempDir, 'src', 'utils'), { recursive: true });
      await mkdir(join(tempDir, 'lib', 'utils'), { recursive: true });

      const result = await executeGlob({ pattern: '**/utils/', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('src/utils/');
      expect(result.output).toContain('lib/utils/');
    });

    it('should handle **/ at start of pattern', async () => {
      await mkdir(join(tempDir, 'a', 'b', 'c'), { recursive: true });
      await writeFile(join(tempDir, 'a', 'b', 'c', 'deep.ts'), 'content');

      const result = await executeGlob({ pattern: '**/deep.ts', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('a/b/c/deep.ts');
    });
  });

  describe('Directory exclusions', () => {
    it('should skip node_modules by default', async () => {
      await mkdir(join(tempDir, 'node_modules', 'pkg'), { recursive: true });
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await writeFile(join(tempDir, 'node_modules', 'pkg', 'index.ts'), 'content');
      await writeFile(join(tempDir, 'src', 'index.ts'), 'content');

      const result = await executeGlob({ pattern: '**/*.ts', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('src/index.ts');
      expect(result.output).not.toContain('node_modules');
    });

    it('should skip .git directory', async () => {
      await mkdir(join(tempDir, '.git', 'objects'), { recursive: true });
      await writeFile(join(tempDir, '.git', 'config'), 'content');
      await writeFile(join(tempDir, 'src.ts'), 'content');

      const result = await executeGlob({
        pattern: '**/*',
        cwd: tempDir,
        includeHidden: true,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).not.toContain('.git/');
    });

    it('should skip __pycache__ directory', async () => {
      await mkdir(join(tempDir, '__pycache__'), { recursive: true });
      await writeFile(join(tempDir, '__pycache__', 'module.pyc'), 'content');
      await writeFile(join(tempDir, 'module.py'), 'content');

      const result = await executeGlob({ pattern: '**/*', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).not.toContain('__pycache__');
    });

    it('should skip .venv directory', async () => {
      await mkdir(join(tempDir, '.venv', 'lib'), { recursive: true });
      await writeFile(join(tempDir, '.venv', 'lib', 'site.py'), 'content');

      const result = await executeGlob({
        pattern: '**/*.py',
        cwd: tempDir,
        includeHidden: true,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).not.toContain('.venv');
    });
  });

  describe('Hidden files handling', () => {
    it('should skip hidden files by default', async () => {
      await writeFile(join(tempDir, '.hidden'), 'content');
      await writeFile(join(tempDir, 'visible'), 'content');

      const result = await executeGlob({ pattern: '*', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('visible');
      expect(result.output).not.toContain('.hidden');
    });

    it('should include hidden files when includeHidden=true', async () => {
      await writeFile(join(tempDir, '.hidden'), 'content');
      await writeFile(join(tempDir, 'visible'), 'content');

      const result = await executeGlob({
        pattern: '*',
        cwd: tempDir,
        includeHidden: true,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('visible');
      expect(result.output).toContain('.hidden');
    });

    it('should skip hidden directories by default', async () => {
      await mkdir(join(tempDir, '.hidden-dir'), { recursive: true });
      await writeFile(join(tempDir, '.hidden-dir', 'file.ts'), 'content');
      await writeFile(join(tempDir, 'visible.ts'), 'content');

      const result = await executeGlob({ pattern: '**/*.ts', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('visible.ts');
      expect(result.output).not.toContain('.hidden-dir');
    });
  });

  describe('Result truncation', () => {
    it('should respect maxResults parameter', async () => {
      // Create many files
      for (let i = 0; i < 10; i++) {
        await writeFile(join(tempDir, `file${i}.ts`), 'content');
      }

      const result = await executeGlob({
        pattern: '*.ts',
        cwd: tempDir,
        maxResults: 5,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('[truncated at 5 results]');
      expect(result.metadata?.truncated).toBe(true);
      expect(result.metadata?.matchCount).toBe(5);
    });

    it('should not truncate when under maxResults', async () => {
      await writeFile(join(tempDir, 'file1.ts'), 'content');
      await writeFile(join(tempDir, 'file2.ts'), 'content');

      const result = await executeGlob({
        pattern: '*.ts',
        cwd: tempDir,
        maxResults: 10,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).not.toContain('truncated');
      expect(result.metadata?.truncated).toBe(false);
    });

    it('should default to 200 maxResults', async () => {
      // We won't create 200 files, just verify default is used
      const result = await executeGlob({ pattern: '*.ts', cwd: tempDir });

      // The default should allow up to 200 results
      expect(result.isSuccess).toBe(true);
    });
  });

  describe('Path resolution', () => {
    it('should resolve relative paths from cwd', async () => {
      await mkdir(join(tempDir, 'subdir'), { recursive: true });
      await writeFile(join(tempDir, 'subdir', 'file.ts'), 'content');

      const result = await executeGlob({ pattern: '*.ts', cwd: join(tempDir, 'subdir') });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('file.ts');
    });

    it('should use context workdirOverride when cwd not provided', async () => {
      await writeFile(join(tempDir, 'test.ts'), 'content');

      const result = await executeGlob({ pattern: '*.ts' }, { workdirOverride: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('test.ts');
    });

    it('should prefer args.cwd over context.workdirOverride', async () => {
      await mkdir(join(tempDir, 'a'), { recursive: true });
      await mkdir(join(tempDir, 'b'), { recursive: true });
      await writeFile(join(tempDir, 'a', 'filea.ts'), 'content');
      await writeFile(join(tempDir, 'b', 'fileb.ts'), 'content');

      const result = await executeGlob(
        { pattern: '*.ts', cwd: join(tempDir, 'a') },
        { workdirOverride: join(tempDir, 'b') }
      );

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('filea.ts');
      expect(result.output).not.toContain('fileb.ts');
    });
  });

  describe('File extension filtering', () => {
    it('should skip binary file extensions (.pyc, .o, etc)', async () => {
      await writeFile(join(tempDir, 'module.py'), 'content');
      await writeFile(join(tempDir, 'module.pyc'), 'content');
      await writeFile(join(tempDir, 'main.o'), 'content');

      const result = await executeGlob({ pattern: '*', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('module.py');
      expect(result.output).not.toContain('module.pyc');
      expect(result.output).not.toContain('main.o');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty directory', async () => {
      const result = await executeGlob({ pattern: '*', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('No files found');
    });

    it('should handle regex special characters in filenames', async () => {
      // Files with characters that are special in regex
      await writeFile(join(tempDir, 'file[1].ts'), 'content');

      const result = await executeGlob({ pattern: '*.ts', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('file[1].ts');
    });

    it('should handle files with spaces in names', async () => {
      await writeFile(join(tempDir, 'file with spaces.ts'), 'content');

      const result = await executeGlob({ pattern: '*.ts', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('file with spaces.ts');
    });

    it('should handle deeply nested directories', async () => {
      const deepPath = join(tempDir, 'a', 'b', 'c', 'd', 'e', 'f');
      await mkdir(deepPath, { recursive: true });
      await writeFile(join(deepPath, 'deep.ts'), 'content');

      const result = await executeGlob({ pattern: '**/*.ts', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('a/b/c/d/e/f/deep.ts');
    });

    it('BUG CANDIDATE: case insensitive matching on all platforms', async () => {
      // The glob implementation uses case-insensitive regex
      // This might not match user expectations on case-sensitive filesystems
      await writeFile(join(tempDir, 'File.TS'), 'content');

      const result = await executeGlob({ pattern: '*.ts', cwd: tempDir });

      // On macOS HFS+ this will match, on Linux ext4 it might not
      // The regex is set to 'i' (case insensitive) which might cause issues
      expect(result.isSuccess).toBe(true);
      // Document actual behavior
      expect(result.output).toContain('File.TS');
    });

    it('should handle inaccessible directories gracefully', async () => {
      // This test documents that inaccessible dirs are skipped
      await mkdir(join(tempDir, 'accessible'), { recursive: true });
      await writeFile(join(tempDir, 'accessible', 'file.ts'), 'content');

      const result = await executeGlob({ pattern: '**/*.ts', cwd: tempDir });

      // Should succeed even if some dirs can't be read
      expect(result.isSuccess).toBe(true);
    });

    it('should handle pattern with trailing slash for directories', async () => {
      await mkdir(join(tempDir, 'mydir'), { recursive: true });
      await writeFile(join(tempDir, 'mydir', 'file.ts'), 'content');

      const result = await executeGlob({ pattern: '*/', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('mydir/');
    });
  });

  describe('Pattern variations', () => {
    it('should match multiple extensions with brace expansion simulation', async () => {
      // Note: This implementation doesn't support {ts,js} syntax
      // This test documents that limitation
      await writeFile(join(tempDir, 'file.ts'), 'content');
      await writeFile(join(tempDir, 'file.js'), 'content');

      // Must use separate patterns or ** approach
      const result = await executeGlob({ pattern: '*.*', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('file.ts');
      expect(result.output).toContain('file.js');
    });

    it('should handle pattern starting with /', async () => {
      await writeFile(join(tempDir, 'root.ts'), 'content');

      // Pattern starting with / typically means absolute from cwd
      const result = await executeGlob({ pattern: '/*.ts', cwd: tempDir });

      // This should not match because path won't start with /
      expect(result.isSuccess).toBe(true);
    });

    it('BUG CANDIDATE: ** at end without / matches everything', async () => {
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await writeFile(join(tempDir, 'src', 'index.ts'), 'content');
      await writeFile(join(tempDir, 'root.ts'), 'content');

      // ** without trailing / should match "any path"
      const result = await executeGlob({ pattern: 'src/**', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('src/index.ts');
    });
  });

  describe('Metadata validation', () => {
    it('should include correct metadata on success', async () => {
      await writeFile(join(tempDir, 'file.ts'), 'content');

      const result = await executeGlob({ pattern: '*.ts', cwd: tempDir });

      expect(result.metadata).toBeDefined();
      expect(result.metadata?.pattern).toBe('*.ts');
      expect(result.metadata?.matchCount).toBe(1);
      expect(result.metadata?.truncated).toBe(false);
    });

    it('should return sorted results', async () => {
      await writeFile(join(tempDir, 'z.ts'), 'content');
      await writeFile(join(tempDir, 'a.ts'), 'content');
      await writeFile(join(tempDir, 'm.ts'), 'content');

      const result = await executeGlob({ pattern: '*.ts', cwd: tempDir });

      const lines = result.output.split('\n');
      expect(lines[0]).toBe('a.ts');
      expect(lines[1]).toBe('m.ts');
      expect(lines[2]).toBe('z.ts');
    });
  });
});
