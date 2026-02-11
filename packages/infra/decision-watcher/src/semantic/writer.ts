/**
 * Semantic File Writer
 *
 * Non-blocking writer for semantic workItem files with:
 * - Per-workId mutex to prevent overlapping writes
 * - Versioning (snapshot before overwrite)
 * - Schema validation before write
 * - Error file generation on validation failure
 *
 * Writes are fire-and-forget from the watcher's perspective - the decision
 * is returned immediately while the semantic file write happens asynchronously.
 */

import fs from 'fs/promises';
import path from 'path';
import {
  SemanticFileStateSchema,
  ValidSemanticFileSchema,
  type SemanticOutput,
  type ValidSemanticFile,
  type FailedSemanticFile,
  type InitialSemanticFile,
  type SemanticFileState,
} from './schemas.js';
import {
  workitemDir,
  semanticPath,
  semanticSnapshotPath,
} from '../session-paths.js';

// ============================================
// WRITE CONFIG
// ============================================

export interface SemanticWriteConfig {
  workingDir: string;
  sessionId: string;
  workId: string;
  date?: Date;
}

// ============================================
// WRITE MUTEX
// ============================================

/**
 * Per-workId write locks to prevent overlapping writes.
 * If a cadence audit fires while a previous write is in progress,
 * the new write waits for the previous one to complete.
 */
const writeLocks = new Map<string, Promise<void>>();

function getLockKey(config: SemanticWriteConfig): string {
  return `${config.sessionId}:${config.workId}`;
}

async function acquireWriteLock(config: SemanticWriteConfig): Promise<void> {
  const key = getLockKey(config);
  const existing = writeLocks.get(key);
  if (existing) {
    await existing;
  }
}

function setWriteLock(config: SemanticWriteConfig, promise: Promise<void>): void {
  const key = getLockKey(config);
  writeLocks.set(key, promise);
}

function releaseWriteLock(config: SemanticWriteConfig): void {
  const key = getLockKey(config);
  writeLocks.delete(key);
}

// ============================================
// ASYNC (FIRE-AND-FORGET) WRITE
// ============================================

/**
 * Write semantic file asynchronously (fire-and-forget).
 * This is the main entry point called from watcher-agent after decision is determined.
 *
 * The write happens in setImmediate to ensure it doesn't block the decision return.
 * If the write fails or validation fails, an error file is written instead.
 */
export function writeSemanticFileAsync(
  config: SemanticWriteConfig,
  semantic: SemanticOutput,
  workItemCreated: string
): void {
  setImmediate(async () => {
    await acquireWriteLock(config);

    const writePromise = (async () => {
      try {
        await writeSemanticFile(config, semantic, workItemCreated);
      } catch (err) {
        console.error(
          `[SemanticWriter] Write failed for ${config.workId}:`,
          err instanceof Error ? err.message : String(err)
        );
        try {
          await writeSemanticError(
            config,
            semantic.meta.auditSequence,
            err instanceof Error ? err : new Error(String(err))
          );
        } catch (errWriteErr) {
          console.error(
            `[SemanticWriter] Error file write also failed:`,
            errWriteErr instanceof Error ? errWriteErr.message : String(errWriteErr)
          );
        }
      }
    })();

    setWriteLock(config, writePromise);

    try {
      await writePromise;
    } finally {
      releaseWriteLock(config);
    }
  });
}

// ============================================
// SEMANTIC FILE WRITE
// ============================================

/**
 * Write semantic file with versioning.
 * - Validates content against schema
 * - Creates snapshot of current version before overwrite
 * - Writes new version to semantic.json
 */
async function writeSemanticFile(
  config: SemanticWriteConfig,
  semantic: SemanticOutput,
  workItemCreated: string
): Promise<void> {
  const dir = workitemDir(config.workingDir, config.sessionId, config.workId, config.date);
  const filePath = semanticPath(config.workingDir, config.sessionId, config.workId, config.date);

  // Ensure directory exists
  await fs.mkdir(dir, { recursive: true });

  // Build valid semantic file content
  const content: ValidSemanticFile = {
    _state: 'valid',
    meta: {
      workId: config.workId,
      created: workItemCreated,
      lastAudit: new Date().toISOString(),
      auditSequence: semantic.meta.auditSequence,
      logPosition: semantic.meta.logPosition,
      totalEvents: semantic.meta.totalEvents,
    },
    stateAndProgress: semantic.stateAndProgress,
    decisionContext: semantic.decisionContext,
    crossReferences: semantic.crossReferences,
  };

  // Validate against schema
  const result = ValidSemanticFileSchema.safeParse(content);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Validation failed: ${issues}`);
  }

  // Snapshot current version (if exists) before overwrite
  try {
    const existing = await fs.readFile(filePath, 'utf-8');
    const existingData = JSON.parse(existing) as SemanticFileState;

    // Only snapshot if it's a valid semantic file
    if (existingData._state === 'valid') {
      const snapshotPath = semanticSnapshotPath(
        config.workingDir,
        config.sessionId,
        config.workId,
        existingData.meta.auditSequence,
        config.date
      );
      await fs.writeFile(snapshotPath, existing, 'utf-8');
    }
  } catch {
    // No existing file or invalid JSON - skip snapshot
  }

  // Write new version
  await fs.writeFile(filePath, JSON.stringify(content, null, 2), 'utf-8');
}

// ============================================
// ERROR FILE WRITE
// ============================================

/**
 * Write error file when semantic generation fails.
 * Preserves the previous valid version as a snapshot.
 */
async function writeSemanticError(
  config: SemanticWriteConfig,
  auditSequence: number,
  error: Error
): Promise<void> {
  const dir = workitemDir(config.workingDir, config.sessionId, config.workId, config.date);
  const filePath = semanticPath(config.workingDir, config.sessionId, config.workId, config.date);

  // Ensure directory exists
  await fs.mkdir(dir, { recursive: true });

  // Try to find previous valid version for reference
  let previousValidVersion: number | undefined;
  try {
    const existing = await fs.readFile(filePath, 'utf-8');
    const existingData = JSON.parse(existing) as SemanticFileState;
    if (existingData._state === 'valid') {
      previousValidVersion = existingData.meta.auditSequence;

      // Snapshot the valid version before overwriting with error
      const snapshotPath = semanticSnapshotPath(
        config.workingDir,
        config.sessionId,
        config.workId,
        existingData.meta.auditSequence,
        config.date
      );
      await fs.writeFile(snapshotPath, existing, 'utf-8');
    } else if (existingData._state === 'failed' && existingData.previousValidVersion !== undefined) {
      previousValidVersion = existingData.previousValidVersion;
    }
  } catch {
    // No existing file or invalid JSON
  }

  const content: FailedSemanticFile = {
    _state: 'failed',
    meta: {
      workId: config.workId,
      auditSequence,
      timestamp: new Date().toISOString(),
    },
    error: error.stack ?? error.message,
    previousValidVersion,
  };

  await fs.writeFile(filePath, JSON.stringify(content, null, 2), 'utf-8');
}

// ============================================
// INITIAL FILE WRITE
// ============================================

/**
 * Write initial semantic file when workItem is created.
 * This provides a placeholder until the first audit generates full content.
 */
export async function writeInitialSemanticFile(
  config: SemanticWriteConfig,
  objective: string
): Promise<void> {
  const dir = workitemDir(config.workingDir, config.sessionId, config.workId, config.date);
  const filePath = semanticPath(config.workingDir, config.sessionId, config.workId, config.date);

  // Ensure directory exists
  await fs.mkdir(dir, { recursive: true });

  const content: InitialSemanticFile = {
    _state: 'initial',
    meta: {
      workId: config.workId,
      created: new Date().toISOString(),
      objective,
    },
  };

  await fs.writeFile(filePath, JSON.stringify(content, null, 2), 'utf-8');
}

// ============================================
// READ SEMANTIC FILE
// ============================================

/**
 * Read and parse semantic file.
 * Returns null if file doesn't exist.
 */
export async function readSemanticFile(
  config: SemanticWriteConfig
): Promise<SemanticFileState | null> {
  const filePath = semanticPath(config.workingDir, config.sessionId, config.workId, config.date);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);

    // Validate against schema
    const result = SemanticFileStateSchema.safeParse(data);
    if (!result.success) {
      console.warn(`[SemanticWriter] Invalid semantic file for ${config.workId}:`, result.error.message);
      return null;
    }

    return result.data;
  } catch {
    return null;
  }
}

/**
 * Read semantic file only if valid.
 * Returns null if file doesn't exist or isn't in valid state.
 */
export async function readValidSemanticFile(
  config: SemanticWriteConfig
): Promise<ValidSemanticFile | null> {
  const state = await readSemanticFile(config);
  if (state?._state === 'valid') {
    return state;
  }
  return null;
}

// ============================================
// FORMAT FOR INJECTION
// ============================================

/**
 * Format valid semantic file content for injection into agent prompt.
 */
export function formatSemanticForInjection(semantic: ValidSemanticFile): string {
  const sections: string[] = [];

  sections.push(`## Semantic Context (WorkItem: ${semantic.meta.workId})`);
  sections.push('');
  sections.push(`*Last audit: ${semantic.meta.lastAudit} (sequence ${semantic.meta.auditSequence})*`);
  sections.push('');

  // State & Progress
  sections.push('### Current State');
  sections.push('');
  sections.push(`**Objective**: ${semantic.stateAndProgress.objective}`);
  sections.push('');

  if (semantic.stateAndProgress.currentState.length > 0) {
    sections.push('| Component | Status | Location |');
    sections.push('|-----------|--------|----------|');
    for (const cs of semantic.stateAndProgress.currentState) {
      const statusIcon = cs.status === 'complete' ? '✓' :
        cs.status === 'partial' ? '⚠' :
          cs.status === 'blocked' ? '✗' : '○';
      sections.push(`| ${cs.component} | ${statusIcon} ${cs.status} | ${cs.location ?? '-'} |`);
    }
    sections.push('');
  }

  // Changes made
  if (semantic.stateAndProgress.changesMade.length > 0) {
    sections.push('### Changes Made');
    sections.push('');
    for (const change of semantic.stateAndProgress.changesMade) {
      sections.push(`- **${change.file}**: ${change.summary}`);
      sections.push(`  *Rationale*: ${change.rationale}`);
    }
    sections.push('');
  }

  // Gap analysis
  if (semantic.stateAndProgress.gapAnalysis.length > 0) {
    sections.push('### Gap Analysis');
    sections.push('');
    for (const gap of semantic.stateAndProgress.gapAnalysis) {
      sections.push(`- **Required**: ${gap.required}`);
      sections.push(`  **Current**: ${gap.current}`);
      if (gap.blocker) sections.push(`  **Blocker**: ${gap.blocker}`);
    }
    sections.push('');
  }

  // Reasoning trace
  if (semantic.stateAndProgress.reasoningTrace.length > 0) {
    sections.push('### Reasoning Trace');
    sections.push('');
    for (let i = 0; i < semantic.stateAndProgress.reasoningTrace.length; i++) {
      sections.push(`${i + 1}. ${semantic.stateAndProgress.reasoningTrace[i]}`);
    }
    sections.push('');
  }

  // Blockers
  if (semantic.stateAndProgress.blockers.length > 0) {
    sections.push('### Blockers');
    sections.push('');
    for (const blocker of semantic.stateAndProgress.blockers) {
      sections.push(`- ${blocker}`);
    }
    sections.push('');
  }

  // Trade-offs
  if (semantic.decisionContext.tradeoffs.length > 0) {
    sections.push('### Trade-off Analysis');
    sections.push('');
    for (const tradeoff of semantic.decisionContext.tradeoffs) {
      sections.push(`#### ${tradeoff.title}`);
      sections.push('');
      sections.push('**Options:**');
      for (const opt of tradeoff.options) {
        sections.push(`- **${opt.id}**: ${opt.description}`);
      }
      sections.push('');
      if (tradeoff.considerations.length > 0) {
        sections.push('**Considerations:**');
        for (const c of tradeoff.considerations) {
          sections.push(`- ${c}`);
        }
        sections.push('');
      }
      if (tradeoff.assessment) {
        sections.push(`**Assessment**: ${tradeoff.assessment}`);
        sections.push('');
      }
    }
  }

  return sections.join('\n');
}
