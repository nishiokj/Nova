/**
 * Work Log
 *
 * Append-only JSONL log of session-level agent activity.
 * The watcher reads this with its Read tool for session memory
 * without keeping everything in its context window.
 *
 * Mirrors the decision-log.ts pattern exactly.
 */

import fs from 'fs/promises';
import path from 'path';
import type { WorkLogEntry } from './types.js';

// ============================================
// WORK LOG INTERFACE
// ============================================

export interface WorkLog {
  /** Append a single entry to the log. */
  append(entry: WorkLogEntry): Promise<void>;
  /** Read all entries. */
  readAll(): Promise<WorkLogEntry[]>;
  /** Read the N most recent entries. */
  readRecent(n: number): Promise<WorkLogEntry[]>;
  /** Get the log file path. */
  filePath(): string;
}

// ============================================
// IMPLEMENTATION
// ============================================

/**
 * Create a JSONL-based work log for a session.
 * Path: .watcher/<sessionId>/work-log.jsonl
 */
export async function createWorkLog(
  workingDir: string,
  sessionId: string
): Promise<WorkLog> {
  const dir = path.join(workingDir, '.watcher', sessionId);
  await fs.mkdir(dir, { recursive: true });

  const logPath = path.join(dir, 'work-log.jsonl');

  // Ensure the file exists (touch)
  await fs.appendFile(logPath, '', 'utf-8');

  async function readAll(): Promise<WorkLogEntry[]> {
    const content = await fs.readFile(logPath, 'utf-8');
    return parseJsonl(content);
  }

  return {
    async append(entry: WorkLogEntry): Promise<void> {
      const line = JSON.stringify(entry) + '\n';
      await fs.appendFile(logPath, line, 'utf-8');
    },

    readAll,

    async readRecent(n: number): Promise<WorkLogEntry[]> {
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

function parseJsonl(content: string): WorkLogEntry[] {
  const entries: WorkLogEntry[] = [];
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
