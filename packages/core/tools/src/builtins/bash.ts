/**
 * Bash tool - Execute shell commands.
 *
 * Ported from: src/harness/agent/tool_registry.py (_bash_execute)
 */

import { spawn } from 'child_process';
import { resolve } from 'path';
import { Effect } from 'effect';
import type { ToolResult } from 'types';
import { successResult, errorResult, timeoutResult } from 'types';
import type {
  ToolExecutionContext,
  ToolExecutionError,
  ToolRegistrationOptions,
} from '../types.js';
import { isDangerousCommand, toToolExecutionError } from '../types.js';

/**
 * Truncate output if it exceeds maximum length.
 */
function truncateOutput(output: string, maxLength = 100000): string {
  return output.length > maxLength
    ? output.slice(0, maxLength) + '\n...[truncated]'
    : output;
}

/**
 * Execute a bash command.
 */
export function executeBashEffect(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Effect.Effect<ToolResult, ToolExecutionError> {
  const command = args.command as string;
  const cwd = context?.workdirOverride ?? process.cwd();
  const timeoutMs = Math.max(1000, ((args.timeout as number) ?? 30) * 1000);
  // Environment is not cached - each call uses fresh values from process.env and context
  // This scales safely across multiple users/requests (no shared state)
  const env = ((args.env as Record<string, string>) ?? {
    ...process.env,
    ...context?.envOverrides,
  }) as NodeJS.ProcessEnv;

  // Security check (bypassed in dangerous mode)
  if (!context?.dangerousMode && isDangerousCommand(command)) {
    return Effect.succeed(
      errorResult(
        'Bash',
        `Command blocked for safety: contains dangerous pattern`,
        0
      )
    );
  }

  const resolvedCwd = resolve(cwd);

  const runEffect = Effect.scoped(
    Effect.acquireRelease(
      Effect.try({
        try: () =>
          spawn('bash', ['-c', command], {
            cwd: resolvedCwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
          }),
        catch: (error) =>
          toToolExecutionError(error, 'execution_error', {
            toolName: 'Bash',
            command,
            cwd: resolvedCwd,
          }),
      }),
      (child) =>
        Effect.sync(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }).pipe(Effect.ignore)
    ).pipe(
      Effect.flatMap((child) =>
        Effect.async<ToolResult>((resume) => {
          const startTime = Date.now();
          let stdout = '';
          let stderr = '';

          const onStdout = (data: Buffer) => {
            stdout += data.toString();
          };
          const onStderr = (data: Buffer) => {
            stderr += data.toString();
          };
          const onError = (err: Error) => {
            resume(Effect.succeed(errorResult('Bash', err.message, Date.now() - startTime)));
          };
          const onClose = (code: number | null) => {
            const durationMs = Date.now() - startTime;
            let output = stdout;
            if (stderr) {
              output += `\n[stderr]: ${stderr}`;
            }
            output = truncateOutput(output);

            if (code !== 0) {
              resume(
                Effect.succeed({
                  toolName: 'Bash',
                  status: 'error',
                  output,
                  error: `Command exited with code ${code}`,
                  durationMs,
                  isSuccess: false,
                  metadata: { returnCode: code },
                })
              );
              return;
            }

            resume(
              Effect.succeed({
                ...successResult('Bash', output, durationMs),
                metadata: { returnCode: code },
              })
            );
          };

          child.stdout.on('data', onStdout);
          child.stderr.on('data', onStderr);
          child.once('error', onError);
          child.once('close', onClose);

          return Effect.sync(() => {
            child.stdout.off('data', onStdout);
            child.stderr.off('data', onStderr);
            child.off('error', onError);
            child.off('close', onClose);
          });
        })
      )
    )
  );

  return runEffect.pipe(
    Effect.timeoutFail({
      duration: timeoutMs,
      onTimeout: () =>
        toToolExecutionError(
          { type: 'timeout', message: `Bash timed out after ${timeoutMs}ms` },
          'timeout',
          { toolName: 'Bash', command, timeoutMs }
        ),
    })
  );
}

export function executeBash(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const startTime = Date.now();
  return Effect.runPromise(
    executeBashEffect(args, context).pipe(
      Effect.catchAll((executionError) => {
        const durationMs = Date.now() - startTime;

        if (executionError.type === 'timeout') {
          return Effect.succeed(timeoutResult('Bash', durationMs));
        }

        if (executionError.type === 'cancelled' || executionError.type === 'paused') {
          return Effect.succeed({
            toolName: 'Bash',
            status: 'cancelled',
            output: executionError.message,
            error: executionError.message,
            durationMs,
            isSuccess: false,
            metadata: executionError.metadata,
          } as ToolResult);
        }

        const result = errorResult('Bash', executionError.message, durationMs);
        result.metadata = executionError.metadata;
        return Effect.succeed(result);
      })
    )
  );
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
        description: 'Timeout in seconds (minimum: 1, default: 30)',
        minimum: 1,
      },
    },
    required: ['command'],
  },
  required: ['command'],
  executor: executeBashEffect,
  timeoutMs: 30000,
  readOnly: false,
  parallelizable: false,
  costHint: 'standard',
};
