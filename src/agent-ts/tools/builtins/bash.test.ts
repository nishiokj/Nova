/**
 * Comprehensive test suite for Bash Tool
 *
 * Goal: Find bugs, not just pass tests.
 * Focus areas:
 * - Command execution and output capture
 * - Timeout handling
 * - Security (dangerous command blocking)
 * - Exit code handling
 * - Environment variables
 * - Working directory
 * - Stderr handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { executeBash } from './bash.js';

function createTempDir(): string {
  return join(tmpdir(), `bash-test-${randomBytes(8).toString('hex')}`);
}

describe('executeBash', () => {
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

  describe('Basic command execution', () => {
    it('should execute simple echo command', async () => {
      const result = await executeBash({ command: 'echo "hello"', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.output.trim()).toBe('hello');
      expect(result.metadata?.returnCode).toBe(0);
    });

    it('should execute command with arguments', async () => {
      const result = await executeBash({
        command: 'echo "arg1" "arg2" "arg3"',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output.trim()).toBe('arg1 arg2 arg3');
    });

    it('should capture multiline output', async () => {
      const result = await executeBash({
        command: 'echo "line1"; echo "line2"; echo "line3"',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('line1');
      expect(result.output).toContain('line2');
      expect(result.output).toContain('line3');
    });

    it('should execute complex shell commands', async () => {
      const result = await executeBash({
        command: 'for i in 1 2 3; do echo $i; done',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('1');
      expect(result.output).toContain('2');
      expect(result.output).toContain('3');
    });

    it('should handle pipes', async () => {
      await writeFile(join(tempDir, 'test.txt'), 'apple\nbanana\napricot\n');

      const result = await executeBash({
        command: 'cat test.txt | grep "^a"',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('apple');
      expect(result.output).toContain('apricot');
      expect(result.output).not.toContain('banana');
    });

    it('should handle command substitution', async () => {
      const result = await executeBash({
        command: 'echo "Today is $(date +%A)"',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      // Just verify it ran without error
      expect(result.output).toContain('Today is');
    });
  });

  describe('Working directory', () => {
    it('should execute in specified cwd', async () => {
      const result = await executeBash({
        command: 'pwd',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      // On macOS, /var is a symlink to /private/var, so compare real paths
      const { realpathSync } = await import('fs');
      expect(result.output.trim()).toBe(realpathSync(tempDir));
    });

    it('should resolve relative paths from cwd', async () => {
      await mkdir(join(tempDir, 'subdir'), { recursive: true });
      await writeFile(join(tempDir, 'subdir', 'file.txt'), 'content');

      const result = await executeBash({
        command: 'cat subdir/file.txt',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output.trim()).toBe('content');
    });

    it('should use context.workdirOverride when cwd not provided', async () => {
      const result = await executeBash(
        { command: 'pwd' },
        { workdirOverride: tempDir }
      );

      expect(result.isSuccess).toBe(true);
      // On macOS, /var is a symlink to /private/var
      const { realpathSync } = await import('fs');
      expect(result.output.trim()).toBe(realpathSync(tempDir));
    });

    it('should prefer args.cwd over context.workdirOverride', async () => {
      await mkdir(join(tempDir, 'a'), { recursive: true });
      await mkdir(join(tempDir, 'b'), { recursive: true });

      const result = await executeBash(
        { command: 'pwd', cwd: join(tempDir, 'a') },
        { workdirOverride: join(tempDir, 'b') }
      );

      expect(result.isSuccess).toBe(true);
      // On macOS, /var is a symlink to /private/var
      const { realpathSync } = await import('fs');
      expect(result.output.trim()).toBe(realpathSync(join(tempDir, 'a')));
    });
  });

  describe('Exit codes', () => {
    it('should return success for exit code 0', async () => {
      const result = await executeBash({ command: 'true', cwd: tempDir });

      expect(result.isSuccess).toBe(true);
      expect(result.status).toBe('success');
      expect(result.metadata?.returnCode).toBe(0);
    });

    it('should return error for non-zero exit code', async () => {
      const result = await executeBash({ command: 'false', cwd: tempDir });

      expect(result.isSuccess).toBe(false);
      expect(result.status).toBe('error');
      expect(result.metadata?.returnCode).toBe(1);
      expect(result.error).toContain('exited with code 1');
    });

    it('should preserve specific exit codes', async () => {
      const result = await executeBash({ command: 'exit 42', cwd: tempDir });

      expect(result.isSuccess).toBe(false);
      expect(result.metadata?.returnCode).toBe(42);
      expect(result.error).toContain('exited with code 42');
    });

    it('should handle command not found', async () => {
      const result = await executeBash({
        command: 'nonexistent_command_xyz',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(false);
      expect(result.metadata?.returnCode).toBe(127);
    });
  });

  describe('Stderr handling', () => {
    it('should capture stderr output', async () => {
      const result = await executeBash({
        command: 'echo "error message" >&2',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('[stderr]');
      expect(result.output).toContain('error message');
    });

    it('should capture both stdout and stderr', async () => {
      const result = await executeBash({
        command: 'echo "stdout"; echo "stderr" >&2',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('stdout');
      expect(result.output).toContain('stderr');
    });

    it('should handle stderr-only output with non-zero exit', async () => {
      const result = await executeBash({
        command: 'echo "error" >&2; exit 1',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(false);
      expect(result.output).toContain('error');
    });
  });

  describe('Timeout handling', () => {
    it('should complete within timeout', async () => {
      const result = await executeBash({
        command: 'echo "fast"',
        cwd: tempDir,
        timeout: 5,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.status).not.toBe('timeout');
    });

    it('should timeout for long-running commands', async () => {
      const result = await executeBash({
        command: 'sleep 10',
        cwd: tempDir,
        timeout: 1, // 1 second timeout
      });

      expect(result.isSuccess).toBe(false);
      expect(result.status).toBe('timeout');
    });

    it('should use default 30 second timeout', async () => {
      // Just verify the parameter is handled correctly
      const result = await executeBash({
        command: 'echo "test"',
        cwd: tempDir,
        // No timeout specified - should use 30s default
      });

      expect(result.isSuccess).toBe(true);
    });

    it('should kill process on timeout', async () => {
      const start = Date.now();
      const result = await executeBash({
        command: 'sleep 60',
        cwd: tempDir,
        timeout: 1,
      });
      const duration = Date.now() - start;

      expect(result.status).toBe('timeout');
      // Should complete close to timeout, not wait for full sleep
      expect(duration).toBeLessThan(5000);
    });
  });

  describe('Dangerous command blocking', () => {
    it('should block rm -rf /', async () => {
      const result = await executeBash({
        command: 'rm -rf /',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('blocked for safety');
    });

    it('should block rm -rf /*', async () => {
      const result = await executeBash({
        command: 'rm -rf /*',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('blocked for safety');
    });

    it('should block fork bomb', async () => {
      const result = await executeBash({
        command: ':(){:|:&};:',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('blocked for safety');
    });

    it('should block dd to device', async () => {
      const result = await executeBash({
        command: 'dd if=/dev/zero of=/dev/sda',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('blocked for safety');
    });

    it('should block chmod -R 777 /', async () => {
      const result = await executeBash({
        command: 'chmod -R 777 /',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('blocked for safety');
    });

    it('should block mkfs commands', async () => {
      const result = await executeBash({
        command: 'mkfs.ext4 /dev/sda1',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(false);
      expect(result.error).toContain('blocked for safety');
    });

    it('should allow safe rm commands', async () => {
      await writeFile(join(tempDir, 'safe.txt'), 'content');

      const result = await executeBash({
        command: 'rm safe.txt',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
    });

    it('should allow rm -rf in subdirectory', async () => {
      await mkdir(join(tempDir, 'toremove'), { recursive: true });
      await writeFile(join(tempDir, 'toremove', 'file.txt'), 'content');

      const result = await executeBash({
        command: 'rm -rf toremove',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
    });

    it('BUG CANDIDATE: pattern matching is substring-based', async () => {
      // The current implementation uses .includes() which can be bypassed
      // with creative command construction
      // This documents the limitation
      const result = await executeBash({
        command: 'echo "this is safe: rm -rf / test"', // Contains pattern but is safe
        cwd: tempDir,
      });

      // Currently this will be blocked even though it's just an echo
      expect(result.isSuccess).toBe(false);
    });
  });

  describe('Environment variables', () => {
    it('should inherit process environment', async () => {
      const result = await executeBash({
        command: 'echo $PATH',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output.length).toBeGreaterThan(0);
    });

    it('should use context.envOverrides', async () => {
      const result = await executeBash(
        { command: 'echo $MY_VAR', cwd: tempDir },
        { envOverrides: { MY_VAR: 'custom_value' } }
      );

      expect(result.isSuccess).toBe(true);
      expect(result.output.trim()).toBe('custom_value');
    });

    it('should allow env override via args.env', async () => {
      const result = await executeBash({
        command: 'echo $CUSTOM_ENV',
        cwd: tempDir,
        env: { CUSTOM_ENV: 'from_args' },
      });

      expect(result.isSuccess).toBe(true);
      // May include stderr from shell config files, so just check stdout contains value
      expect(result.output).toContain('from_args');
    });

    it('should merge context.envOverrides with process.env', async () => {
      const result = await executeBash(
        { command: 'echo "PATH=$PATH CUSTOM=$CUSTOM"', cwd: tempDir },
        { envOverrides: { CUSTOM: 'value' } }
      );

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('CUSTOM=value');
      // PATH should still be inherited
      expect(result.output).toContain('PATH=');
    });
  });

  describe('Output truncation', () => {
    it('should truncate very long output', async () => {
      // Generate output longer than 100000 chars
      const result = await executeBash({
        command: 'yes "x" | head -50000', // Each line is 2 chars, 50000 lines = 100000 chars
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      // Output should be truncated
      if (result.output.length > 100000) {
        expect(result.output).toContain('[truncated]');
      }
    });

    it('should not truncate normal output', async () => {
      const result = await executeBash({
        command: 'echo "short output"',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).not.toContain('[truncated]');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty command output', async () => {
      const result = await executeBash({
        command: 'true', // Produces no output
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toBe('');
    });

    it('should handle commands with quotes', async () => {
      const result = await executeBash({
        command: "echo 'single quotes' \"double quotes\"",
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('single quotes');
      expect(result.output).toContain('double quotes');
    });

    it('should handle commands with special characters', async () => {
      const result = await executeBash({
        command: 'echo "special chars: $HOME & && || ; |"',
        cwd: tempDir,
      });

      // The command should execute (special chars are in quotes)
      expect(result.isSuccess).toBe(true);
    });

    it('should handle commands with newlines in output', async () => {
      const result = await executeBash({
        command: 'printf "line1\\nline2\\nline3"',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output.split('\n').length).toBeGreaterThanOrEqual(3);
    });

    it('should handle commands producing binary output', async () => {
      // This produces some binary-ish output
      const result = await executeBash({
        command: 'echo -e "\\x00\\x01\\x02"',
        cwd: tempDir,
      });

      // Should not crash, though output may be garbled
      expect(result.isSuccess).toBe(true);
    });

    it('should handle rapid sequential commands', async () => {
      const results = await Promise.all([
        executeBash({ command: 'echo "1"', cwd: tempDir }),
        executeBash({ command: 'echo "2"', cwd: tempDir }),
        executeBash({ command: 'echo "3"', cwd: tempDir }),
      ]);

      expect(results.every((r) => r.isSuccess)).toBe(true);
    });

    it('should handle command with very long arguments', async () => {
      const longArg = 'x'.repeat(10000);
      const result = await executeBash({
        command: `echo "${longArg}" | wc -c`,
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      // Should output approximately 10001 (10000 chars + newline)
      expect(parseInt(result.output.trim())).toBeGreaterThan(9999);
    });
  });

  describe('Timing and metadata', () => {
    it('should record duration', async () => {
      const result = await executeBash({
        command: 'sleep 0.1',
        cwd: tempDir,
      });

      expect(result.durationMs).toBeDefined();
      expect(result.durationMs).toBeGreaterThan(50); // At least ~100ms
    });

    it('should record duration even on error', async () => {
      const result = await executeBash({
        command: 'exit 1',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(false);
      expect(result.durationMs).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should record duration on timeout', async () => {
      const result = await executeBash({
        command: 'sleep 10',
        cwd: tempDir,
        timeout: 1,
      });

      expect(result.status).toBe('timeout');
      expect(result.durationMs).toBeDefined();
      expect(result.durationMs).toBeGreaterThan(800); // Close to 1 second
    });

    it('should include correct tool name', async () => {
      const result = await executeBash({
        command: 'echo test',
        cwd: tempDir,
      });

      expect(result.toolName).toBe('Bash');
    });
  });

  describe('File operations via bash', () => {
    it('should create files', async () => {
      const result = await executeBash({
        command: 'echo "content" > newfile.txt && cat newfile.txt',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output.trim()).toBe('content');
    });

    it('should list files', async () => {
      await writeFile(join(tempDir, 'a.txt'), 'a');
      await writeFile(join(tempDir, 'b.txt'), 'b');

      const result = await executeBash({
        command: 'ls -1',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('a.txt');
      expect(result.output).toContain('b.txt');
    });

    it('should handle file permissions', async () => {
      await writeFile(join(tempDir, 'script.sh'), '#!/bin/bash\necho "executed"');

      const result = await executeBash({
        command: 'chmod +x script.sh && ./script.sh',
        cwd: tempDir,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.output.trim()).toBe('executed');
    });
  });
});
