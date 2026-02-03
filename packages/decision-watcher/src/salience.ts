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
  'Evidence-first oversight — never allow without concrete evidence. If evidence is missing, report it and intervene.',
  'Accountability — the watcher is responsible for goal completion and system integrity. Create infra-fix work when the system fails you.',
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

/**
 * Observation entry for salience notes.
 */
export interface SalienceObservation {
  trigger: string;
  action: string;
  workId?: string;
  summary: string;
}

/**
 * Append an observation to the Session Notes section of the salience file.
 * Creates a timestamped note under the "## Session Notes" header.
 */
export async function appendSalienceObservation(
  salienceFilePath: string,
  observation: SalienceObservation
): Promise<void> {
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const workIdPart = observation.workId ? ` [${observation.workId.slice(0, 8)}]` : '';
  const note = `\n### ${timestamp}${workIdPart}\n**${observation.trigger}** → ${observation.action}\n${observation.summary}\n`;

  try {
    const content = await fs.readFile(salienceFilePath, 'utf-8');

    // Find the Session Notes section and remove the placeholder
    const placeholder = '_No notes yet. The watcher will append observations here._';
    let updatedContent: string;

    if (content.includes(placeholder)) {
      // Replace placeholder with first note
      updatedContent = content.replace(placeholder, note.trim());
    } else {
      // Append to end of file
      updatedContent = content.trimEnd() + note;
    }

    await fs.writeFile(salienceFilePath, updatedContent, 'utf-8');
  } catch (err) {
    // Log but don't throw - salience updates are non-critical
    console.warn('[SALIENCE] Failed to append observation:', err instanceof Error ? err.message : String(err));
  }
}
