/**
 * Bash tool - Execute shell commands.
 *
 * Ported from: src/harness/agent/tool_registry.py (_bash_execute)
 */

import { spawn } from 'child_process';
import { resolve } from 'path';
import type { ToolResult } from 'types';
import { successResult, errorResult, timeoutResult } from 'types';
import type { ToolExecutionContext, ToolRegistrationOptions } from '../types.js';
import { isDangerousCommand } from '../types.js';

/**
 * Execute a bash command.
 */
export async function executeBash(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const command = args.command as string;
  const cwd = context?.workdirOverride ?? process.cwd();
  const timeoutMs = ((args.timeout as number) ?? 30) * 1000;
  const env = (args.env as Record<string, string>) ?? {
    ...process.env,
    ...context?.envOverrides,
  };

  // Security check
  if (isDangerousCommand(command)) {
    return errorResult(
      'Bash',
      `Command blocked for safety: contains dangerous pattern`,
      0
    );
  }

  const startTime = Date.now();

  return new Promise((resolveResult) => {
    const resolvedCwd = resolve(cwd);

    const child = spawn('bash', ['-c', command], {
      cwd: resolvedCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;

      if (timedOut) {
        resolveResult(timeoutResult('Bash', durationMs));
        return;
      }

      // Truncate output if too long
      let output = stdout;
      if (stderr) {
        output += `\n[stderr]: ${stderr}`;
      }
      if (output.length > 100000) {
        output = output.slice(0, 100000) + '\n...[truncated]';
      }

      if (code !== 0) {
        resolveResult({
          toolName: 'Bash',
          status: 'error',
          output,
          error: `Command exited with code ${code}`,
          durationMs,
          isSuccess: false,
          metadata: { returnCode: code },
        });
        return;
      }

      resolveResult({
        ...successResult('Bash', output, durationMs),
        metadata: { returnCode: code },
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      resolveResult(errorResult('Bash', err.message, Date.now() - startTime));
    });
  });
}

/**
 * Bash tool registration options.
 */
export const bashToolOptions: ToolRegistrationOptions = {
  name: 'Bash',
  description: 'Run terminal commands, scripts, or git operations.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds (default: 30)',
      },
    },
    required: ['command'],
  },
  required: ['command'],
  executor: executeBash,
  timeoutMs: 30000,
  readOnly: false,
  parallelizable: false,
  costHint: 'standard',
};
