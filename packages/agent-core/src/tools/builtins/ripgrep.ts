/**
 * Ripgrep helpers for fast filesystem searches.
 */

import { spawn } from 'child_process';

let rgAvailablePromise: Promise<boolean> | null = null;

export function canUseRipgrep(): Promise<boolean> {
  if (!rgAvailablePromise) {
    rgAvailablePromise = new Promise((resolve) => {
      const child = spawn('rg', ['--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }

  return rgAvailablePromise;
}

export interface RipgrepRunOptions {
  cwd: string;
  maxLines?: number;
}

export interface RipgrepRunResult {
  lines: string[];
  truncated: boolean;
  exitCode: number | null;
  stderr: string;
}

export async function runRipgrepLines(
  args: string[],
  options: RipgrepRunOptions
): Promise<RipgrepRunResult> {
  const child = spawn('rg', args, {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const lines: string[] = [];
  let buffer = '';
  let stderr = '';
  let truncated = false;
  let killed = false;
  const maxLines = options.maxLines;

  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (truncated) return;
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length === 0 && buffer.length === 0) continue;
        lines.push(line);
        if (maxLines && lines.length >= maxLines && !killed) {
          truncated = true;
          killed = true;
          child.kill();
          return;
        }
      }
    });
  }

  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
  }

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });

  if (!truncated && buffer.length > 0) {
    lines.push(buffer);
  }

  return {
    lines,
    truncated,
    exitCode,
    stderr: stderr.trim(),
  };
}
