/**
 * Ripgrep helpers for fast filesystem searches.
 */

import { spawn } from 'child_process';

let rgAvailablePromise: Promise<boolean> | null = null;

export function canUseRipgrep(): Promise<boolean> {
  rgAvailablePromise ??= new Promise((resolve) => {
    const child = spawn('rg', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });

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

  const state = { lines: [] as string[], buffer: '', stderr: '', truncated: false, killed: false };
  const maxLines = options.maxLines;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (state.truncated) return;
    state.buffer += chunk;
    for (;;) {
      const newline = state.buffer.indexOf('\n');
      if (newline === -1) break;
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      if (line.length === 0 && state.buffer.length === 0) continue;
      state.lines.push(line);
      if (maxLines && state.lines.length >= maxLines && !state.killed) {
        state.truncated = true;
        state.killed = true;
        child.kill();
        return;
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    state.stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });

  if (!state.truncated && state.buffer.length > 0) {
    state.lines.push(state.buffer);
  }

  return {
    lines: state.lines,
    truncated: state.truncated,
    exitCode,
    stderr: state.stderr.trim(),
  };
}
