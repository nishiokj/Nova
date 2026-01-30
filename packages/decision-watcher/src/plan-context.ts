/**
 * Plan Context
 *
 * Captures context discovered during planning for handoff to worker agents.
 * Written after planning completes so workers don't need to re-explore.
 *
 * Path: .watcher/{YYYY-MM-DD}/{sessionId}/plan-context.md
 */

import fs from 'fs/promises';
import type { HandoffSpec } from 'protocol';
import { planContextPath, sessionDir } from './session-paths.js';

// ============================================
// TYPES
// ============================================

export interface PlanContextData {
  /** Plan ID for correlation */
  planId: string;
  /** Session ID */
  sessionId: string;
  /** The original goal */
  goal: string;
  /** Key files discovered during planning with their purpose */
  keyFiles: KeyFile[];
  /** Architecture understanding gained */
  architecture?: string;
  /** Constraints identified during planning */
  constraints: string[];
  /** Q&A decisions made (questions asked and answers received) */
  qaDecisions: QADecision[];
  /** Additional notes from planning */
  notes?: string;
  /** Timestamp of plan creation */
  createdAt: string;
}

export interface KeyFile {
  /** File path */
  path: string;
  /** Why this file matters */
  purpose: string;
  /** Key exports/functions relevant to the plan */
  keyExports?: string[];
}

export interface QADecision {
  /** Question that was asked */
  question: string;
  /** Answer received */
  answer: string;
  /** Impact on implementation */
  impact?: string;
}

// ============================================
// MARKDOWN GENERATION
// ============================================

/**
 * Generate markdown content for the plan context file.
 */
export function generatePlanContextMarkdown(data: PlanContextData): string {
  const lines: string[] = [
    `# Plan Context: ${data.planId}`,
    '',
    `**Goal**: ${data.goal}`,
    `**Session**: ${data.sessionId}`,
    `**Created**: ${data.createdAt}`,
    '',
    '---',
    '',
    '> **For Worker Agents**: Read this file before starting your WorkItem.',
    '> It contains context discovered during planning so you don\'t need to re-explore.',
    '',
  ];

  // Key Files section
  lines.push('## Key Files');
  lines.push('');
  if (data.keyFiles.length > 0) {
    for (const file of data.keyFiles) {
      lines.push(`### \`${file.path}\``);
      lines.push(file.purpose);
      if (file.keyExports?.length) {
        lines.push('');
        lines.push('Key exports:');
        for (const exp of file.keyExports) {
          lines.push(`- \`${exp}\``);
        }
      }
      lines.push('');
    }
  } else {
    lines.push('_No key files identified._');
    lines.push('');
  }

  // Architecture section
  if (data.architecture) {
    lines.push('## Architecture');
    lines.push('');
    lines.push(data.architecture);
    lines.push('');
  }

  // Constraints section
  lines.push('## Constraints');
  lines.push('');
  if (data.constraints.length > 0) {
    for (const constraint of data.constraints) {
      lines.push(`- ${constraint}`);
    }
  } else {
    lines.push('_No constraints identified._');
  }
  lines.push('');

  // Q&A Decisions section
  lines.push('## Q&A Decisions');
  lines.push('');
  if (data.qaDecisions.length > 0) {
    for (const qa of data.qaDecisions) {
      lines.push(`**Q**: ${qa.question}`);
      lines.push(`**A**: ${qa.answer}`);
      if (qa.impact) {
        lines.push(`**Impact**: ${qa.impact}`);
      }
      lines.push('');
    }
  } else {
    lines.push('_No Q&A decisions recorded._');
    lines.push('');
  }

  // Notes section
  if (data.notes) {
    lines.push('## Additional Notes');
    lines.push('');
    lines.push(data.notes);
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================
// FILE I/O
// ============================================

/**
 * Write the plan context file to disk.
 * Returns the file path.
 */
export async function writePlanContext(
  workingDir: string,
  data: PlanContextData
): Promise<string> {
  const dir = sessionDir(workingDir, data.sessionId);
  await fs.mkdir(dir, { recursive: true });

  const filePath = planContextPath(workingDir, data.sessionId);
  const content = generatePlanContextMarkdown(data);
  await fs.writeFile(filePath, content, 'utf-8');

  return filePath;
}

/**
 * Read the plan context file.
 * Returns null if the file doesn't exist.
 */
export async function readPlanContext(
  workingDir: string,
  sessionId: string
): Promise<string | null> {
  const filePath = planContextPath(workingDir, sessionId);
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Check if a plan context file exists for a session.
 */
export async function hasPlanContext(
  workingDir: string,
  sessionId: string
): Promise<boolean> {
  const filePath = planContextPath(workingDir, sessionId);
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a minimal plan context from a handoff spec.
 * Used when the planning agent completes with a handoff spec.
 */
export function buildPlanContextFromHandoff(
  sessionId: string,
  goal: string,
  handoffSpec: HandoffSpec
): PlanContextData {
  const planId = `plan-${Date.now().toString(36)}`;

  // Extract work items from spec if available
  const workItems = handoffSpec.workItems ?? [];

  // Build key files from targetPaths
  const keyFiles: KeyFile[] = [];
  for (const item of workItems) {
    if (item.targetPaths) {
      for (const path of item.targetPaths) {
        if (!keyFiles.find(f => f.path === path)) {
          keyFiles.push({
            path,
            purpose: `Target for: ${item.objective ?? 'unknown'}`,
          });
        }
      }
    }
  }

  return {
    planId,
    sessionId,
    goal: handoffSpec.goal ?? goal,
    keyFiles,
    constraints: [],
    qaDecisions: [],
    notes: handoffSpec.context || undefined,
    createdAt: new Date().toISOString(),
  };
}
