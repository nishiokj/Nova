/**
 * Importable TUI entry point for standalone distribution builds.
 * Wraps the React/Ink rendering in a Promise that resolves on exit.
 */

import { render } from 'ink';
import { createElement } from 'react';

export interface TuiOptions {
  /** Initial prompt to send after connection */
  initialPrompt?: string;
  /** Path for UI logs */
  uiLogPath?: string;
  /** Enable voice mode */
  enableVoice?: boolean;
  /** Redact sensitive data in logs */
  redactLogs?: boolean;
  /** Log conversation transcripts */
  logTranscripts?: boolean;
  /** Resume a specific session */
  sessionKey?: string;
}

/**
 * Start the TUI and return a promise that resolves when the user exits.
 */
export async function startTui(options: TuiOptions = {}): Promise<void> {
  // Dynamically import to avoid loading React until needed
  const { App, parseArgs } = await import('./index.js');

  // Build argv from options
  const argv: string[] = [];
  if (options.uiLogPath) {
    argv.push('--ui-log', options.uiLogPath);
  }
  if (options.sessionKey) {
    argv.push('--session', options.sessionKey);
  }
  if (options.enableVoice === false) {
    argv.push('--no-voice');
  } else if (options.enableVoice === true) {
    argv.push('--voice');
  }
  if (options.redactLogs) {
    argv.push('--redact');
  }
  if (options.logTranscripts === false) {
    argv.push('--no-log-transcripts');
  }

  const appOptions = parseArgs(argv);

  return new Promise((resolve, reject) => {
    try {
      const { waitUntilExit } = render(
        createElement(App, {
          options: appOptions,
          initialPrompt: options.initialPrompt,
          onExit: resolve,
        })
      );

      waitUntilExit()
        .then(resolve)
        .catch(reject);
    } catch (error) {
      reject(error);
    }
  });
}
