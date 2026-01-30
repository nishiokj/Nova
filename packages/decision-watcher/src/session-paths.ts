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
 * @deprecated Use workitemDir for new directory-based structure
 */
export function workitemPath(
  workingDir: string,
  sessionId: string,
  workId: string,
  date?: Date
): string {
  return path.join(workitemsDir(workingDir, sessionId, date), `${workId}.jsonl`);
}

// ============================================
// NEW WORKITEM DIRECTORY STRUCTURE
// ============================================

/**
 * Get the directory for a specific workitem.
 * New structure: .watcher/{YYYY-MM-DD}/{sessionId}/workitems/{workId}/
 */
export function workitemDir(
  workingDir: string,
  sessionId: string,
  workId: string,
  date?: Date
): string {
  return path.join(workitemsDir(workingDir, sessionId, date), workId);
}

/**
 * Get the semantic file path for a workitem.
 * Structure: .watcher/{YYYY-MM-DD}/{sessionId}/workitems/{workId}/semantic.json
 */
export function semanticPath(
  workingDir: string,
  sessionId: string,
  workId: string,
  date?: Date
): string {
  return path.join(workitemDir(workingDir, sessionId, workId, date), 'semantic.json');
}

/**
 * Get the path for a semantic snapshot.
 * Structure: .watcher/{YYYY-MM-DD}/{sessionId}/workitems/{workId}/semantic_v{NNN}.json
 */
export function semanticSnapshotPath(
  workingDir: string,
  sessionId: string,
  workId: string,
  auditSequence: number,
  date?: Date
): string {
  const versionStr = auditSequence.toString().padStart(3, '0');
  return path.join(workitemDir(workingDir, sessionId, workId, date), `semantic_v${versionStr}.json`);
}

/**
 * Get the log file path within the workitem directory.
 * Structure: .watcher/{YYYY-MM-DD}/{sessionId}/workitems/{workId}/log.jsonl
 */
export function workitemLogPath(
  workingDir: string,
  sessionId: string,
  workId: string,
  date?: Date
): string {
  return path.join(workitemDir(workingDir, sessionId, workId, date), 'log.jsonl');
}

/**
 * Get the diffs directory for a workitem.
 * Structure: .watcher/{YYYY-MM-DD}/{sessionId}/workitems/{workId}/diffs/
 */
export function diffsDir(
  workingDir: string,
  sessionId: string,
  workId: string,
  date?: Date
): string {
  return path.join(workitemDir(workingDir, sessionId, workId, date), 'diffs');
}

/**
 * Get the path for a specific diff file.
 * Structure: .watcher/{YYYY-MM-DD}/{sessionId}/workitems/{workId}/diffs/event_{N}.diff
 */
export function diffPath(
  workingDir: string,
  sessionId: string,
  workId: string,
  eventIndex: number,
  date?: Date
): string {
  const indexStr = eventIndex.toString().padStart(3, '0');
  return path.join(diffsDir(workingDir, sessionId, workId, date), `event_${indexStr}.diff`);
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
