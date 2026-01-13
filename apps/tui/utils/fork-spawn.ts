/**
 * Fork spawning utility: tmux auto-spawn + clipboard fallback.
 */

import { execSync } from 'child_process';

export interface ForkSpawnResult {
  success: boolean;
  autoSpawned: boolean;
  sessionKey: string;
  message: string;
  command?: string;
  error?: string;
}

function isInTmux(): boolean {
  return !!process.env.TMUX;
}

function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === 'darwin') {
      execSync(`printf '%s' "${text.replace(/"/g, '\\"')}" | pbcopy`, { stdio: 'pipe' });
      return true;
    }
    if (process.platform === 'linux') {
      try {
        execSync(`printf '%s' "${text.replace(/"/g, '\\"')}" | xclip -selection clipboard`, { stdio: 'pipe' });
        return true;
      } catch {
        try {
          execSync(`printf '%s' "${text.replace(/"/g, '\\"')}" | xsel --clipboard`, { stdio: 'pipe' });
          return true;
        } catch {
          return false;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function spawnForkedSession(
  sessionKey: string,
  workingDir: string,
  launcherPath: string
): ForkSpawnResult {
  const cmd = `bun run ${launcherPath} --session ${sessionKey}`;

  // Try tmux first
  if (isInTmux()) {
    try {
      execSync(`tmux split-window -h -c "${workingDir}" '${cmd}'`, { stdio: 'pipe' });
      return {
        success: true,
        autoSpawned: true,
        sessionKey,
        message: 'Forked in new tmux pane',
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      // tmux failed, fall through to manual with error info
      return {
        success: true,
        autoSpawned: false,
        sessionKey,
        message: 'Fork created - tmux failed, run command manually',
        command: `cd "${workingDir}" && ${cmd}`,
        error: errorMsg,
      };
    }
  }

  // Fallback: clipboard + instructions
  const fullCommand = `cd "${workingDir}" && ${cmd}`;
  const copied = copyToClipboard(fullCommand);

  return {
    success: true,
    autoSpawned: false,
    sessionKey,
    message: copied
      ? 'Fork created - command copied to clipboard'
      : 'Fork created - run command in new terminal',
    command: fullCommand,
  };
}
