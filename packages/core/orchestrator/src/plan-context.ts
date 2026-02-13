/**
 * Plan Context
 *
 * Captures planning discoveries for worker handoff.
 * Written after planning completes so workers don't need to re-explore.
 */

import fs from 'fs/promises';
import path from 'path';
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

/**
 * Get today's date in YYYY-MM-DD format.
 */
function getDateString(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

/**
 * Get the session directory for observer artifacts.
 * Structure: .observer/{YYYY-MM-DD}/{sessionId}/
 */
function sessionDir(workingDir: string, sessionId: string, date: Date = new Date()): string {
  return path.join(workingDir, '.observer', getDateString(date), sessionId);
}

/**
 * Get the plan context path for a session.
 */
function planContextPath(workingDir: string, sessionId: string, date?: Date): string {
  return path.join(sessionDir(workingDir, sessionId, date), 'plan-context.md');
}

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

  if (data.architecture) {
    lines.push('## Architecture');
    lines.push('');
    lines.push(data.architecture);
    lines.push('');
  }

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

  if (data.notes) {
    lines.push('## Additional Notes');
    lines.push('');
    lines.push(data.notes);
    lines.push('');
  }

  return lines.join('\n');
}

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

