/**
 * Salience File
 *
 * Maintains a session-scoped markdown file that anchors the watcher's reasoning.
 * Contains: session ID, goal, mode, timestamp, and operating principles.
 * The watcher reads this file with its Read tool to stay grounded.
 */

import fs from 'fs/promises';
import {
  sessionDir,
  saliencePath as getSaliencePath,
  workitemsDir,
} from './session-paths.js';

// ============================================
// PATH HELPERS (re-exported for compatibility)
// ============================================

/**
 * Get the directory for a watcher session's artifacts.
 */
export function salienceDir(workingDir: string, sessionId: string): string {
  return sessionDir(workingDir, sessionId);
}

/**
 * Get the salience file path for a session.
 */
export function salienceFilePath(workingDir: string, sessionId: string): string {
  return getSaliencePath(workingDir, sessionId);
}

// ============================================
// CONTENT GENERATION
// ============================================

export interface SalienceParams {
  sessionId: string;
  goal: string;
  mode: 'async' | 'interactive';
  principles?: string[];
}

const DEFAULT_PRINCIPLES = [
  'Surface ambiguity aggressively — implicit boundaries and shared ownership are questions, not silent choices.',
  'Establish invariants — record what decisions imply. Make boundaries and contracts explicit.',
  'Separation of concerns is non-negotiable — detect and address concern-mixing.',
  'Minimal intervention — only act with clear benefit.',
  'One work item = one git commit. Keep units of work atomic and reviewable.',
];

/**
 * Generate salience file content as markdown.
 */
export function createSalienceContent(params: SalienceParams): string {
  const { sessionId, goal, mode, principles = DEFAULT_PRINCIPLES } = params;
  const timestamp = new Date().toISOString();

  const lines = [
    `# Watcher Salience — ${sessionId}`,
    '',
    `**Goal**: ${goal}`,
    `**Mode**: ${mode}`,
    `**Created**: ${timestamp}`,
    '',
    '## Operating Principles',
    '',
    ...principles.map((p, i) => `${i + 1}. ${p}`),
    '',
    '## Session Notes',
    '',
    '_No notes yet. The watcher will append observations here._',
    '',
  ];

  return lines.join('\n');
}

// ============================================
// FILE I/O
// ============================================

/**
 * Write the salience file to disk, creating directories as needed.
 * Also creates the workitems subdirectory.
 * Returns the file path.
 */
export async function writeSalienceFile(
  workingDir: string,
  params: SalienceParams
): Promise<string> {
  const dir = salienceDir(workingDir, params.sessionId);
  await fs.mkdir(dir, { recursive: true });

  // Also create workitems subdirectory
  const workitemsPath = workitemsDir(workingDir, params.sessionId);
  await fs.mkdir(workitemsPath, { recursive: true });

  const filePath = salienceFilePath(workingDir, params.sessionId);
  const content = createSalienceContent(params);
  await fs.writeFile(filePath, content, 'utf-8');

  return filePath;
}
