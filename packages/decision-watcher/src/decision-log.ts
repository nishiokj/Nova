/**
 * Decision Log
 *
 * Append-only JSONL log of every watcher invocation for auditability.
 * The watcher reads this with its Read tool to maintain session continuity.
 */

import fs from 'fs/promises';
import type { DecisionLogEntry } from './types.js';
import { sessionDir, decisionsLogPath } from './session-paths.js';

// ============================================
// DECISION LOG INTERFACE
// ============================================

export interface DecisionLog {
  /** Append a single entry to the log. */
  append(entry: DecisionLogEntry): Promise<void>;
  /** Read all entries. */
  readAll(): Promise<DecisionLogEntry[]>;
  /** Read the N most recent entries. */
  readRecent(n: number): Promise<DecisionLogEntry[]>;
  /** Get the log file path. */
  filePath(): string;
}

// ============================================
// IMPLEMENTATION
// ============================================

/**
 * Create a JSONL-based decision log for a session.
 * Path: .watcher/{YYYY-MM-DD}/{sessionId}/decisions.jsonl
 */
export async function createDecisionLog(
  workingDir: string,
  sessionId: string
): Promise<DecisionLog> {
  const dir = sessionDir(workingDir, sessionId);
  await fs.mkdir(dir, { recursive: true });

  const logPath = decisionsLogPath(workingDir, sessionId);

  // Ensure the file exists (touch)
  await fs.appendFile(logPath, '', 'utf-8');

  async function readAll(): Promise<DecisionLogEntry[]> {
    const content = await fs.readFile(logPath, 'utf-8');
    return parseJsonl(content);
  }

  return {
    async append(entry: DecisionLogEntry): Promise<void> {
      const line = JSON.stringify(entry) + '\n';
      await fs.appendFile(logPath, line, 'utf-8');
    },

    readAll,

    async readRecent(n: number): Promise<DecisionLogEntry[]> {
      const all = await readAll();
      return all.slice(-n);
    },

    filePath(): string {
      return logPath;
    },
  };
}

// ============================================
// HELPERS
// ============================================

function parseJsonl(content: string): DecisionLogEntry[] {
  const entries: DecisionLogEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}
