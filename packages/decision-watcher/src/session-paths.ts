/**
 * Session Paths
 *
 * Centralized path generation for watcher session artifacts.
 * New structure: .watcher/{YYYY-MM-DD}/{sessionId}/
 *   - salience.md
 *   - decisions.jsonl
 *   - work-log.jsonl
 *   - plan-context.md (written after planning)
 *   - workitems/
 *     - {workId}.md
 */

import path from 'path';

// ============================================
// DATE HELPERS
// ============================================

/**
 * Get today's date in YYYY-MM-DD format.
 */
export function getDateString(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

// ============================================
// SESSION PATHS
// ============================================

/**
 * Get the day directory for a session.
 * Structure: .watcher/{YYYY-MM-DD}/
 */
export function dayDir(workingDir: string, date: Date = new Date()): string {
  return path.join(workingDir, '.watcher', getDateString(date));
}

/**
 * Get the session directory for watcher artifacts.
 * Structure: .watcher/{YYYY-MM-DD}/{sessionId}/
 */
export function sessionDir(workingDir: string, sessionId: string, date: Date = new Date()): string {
  return path.join(dayDir(workingDir, date), sessionId);
}

/**
 * Get the salience file path for a session.
 */
export function saliencePath(workingDir: string, sessionId: string, date?: Date): string {
  return path.join(sessionDir(workingDir, sessionId, date), 'salience.md');
}

/**
 * Get the decisions log path for a session.
 */
export function decisionsLogPath(workingDir: string, sessionId: string, date?: Date): string {
  return path.join(sessionDir(workingDir, sessionId, date), 'decisions.jsonl');
}

/**
 * Get the work log path for a session.
 */
export function workLogPath(workingDir: string, sessionId: string, date?: Date): string {
  return path.join(sessionDir(workingDir, sessionId, date), 'work-log.jsonl');
}

/**
 * Get the plan context file path for a session.
 * Written after planning completes with discovered context for workers.
 */
export function planContextPath(workingDir: string, sessionId: string, date?: Date): string {
  return path.join(sessionDir(workingDir, sessionId, date), 'plan-context.md');
}

// ============================================
// WORKITEM PATHS
// ============================================

/**
 * Get the workitems directory for a session.
 * Structure: .watcher/{YYYY-MM-DD}/{sessionId}/workitems/
 */
export function workitemsDir(workingDir: string, sessionId: string, date?: Date): string {
  return path.join(sessionDir(workingDir, sessionId, date), 'workitems');
}

/**
 * Get the path for a specific workitem's log file (JSONL format).
 * Structure: .watcher/{YYYY-MM-DD}/{sessionId}/workitems/{workId}.jsonl
 */
export function workitemPath(
  workingDir: string,
  sessionId: string,
  workId: string,
  date?: Date
): string {
  return path.join(workitemsDir(workingDir, sessionId, date), `${workId}.jsonl`);
}

/**
 * Get the path for a specific workitem's summary file (Markdown format).
 * Generated for human readability after completion.
 * Structure: .watcher/{YYYY-MM-DD}/{sessionId}/workitems/{workId}.md
 */
export function workitemSummaryPath(
  workingDir: string,
  sessionId: string,
  workId: string,
  date?: Date
): string {
  return path.join(workitemsDir(workingDir, sessionId, date), `${workId}.md`);
}

// ============================================
// LEGACY SUPPORT (for migration)
// ============================================

/**
 * Legacy session directory path (without date).
 * Used for backward compatibility during migration.
 * @deprecated Use sessionDir with date parameter
 */
export function legacySessionDir(workingDir: string, sessionId: string): string {
  return path.join(workingDir, '.watcher', sessionId);
}
