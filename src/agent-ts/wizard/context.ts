/**
 * Context Window and Delta management.
 *
 * Ported from: src/harness/agent/wizard/context_window.py
 */

import type { Message } from '../types/llm.js';

// ============================================
// CONTEXT DELTA
// ============================================

/**
 * Local delta accumulated during Worker execution.
 * Worker NEVER mutates the base context directly.
 */
export interface ContextDelta {
  /** Messages accumulated during this work item */
  messages: Array<Record<string, unknown>>;
  /** Files read during this work item */
  readFiles: Set<string>;
}

/**
 * Create an empty context delta.
 */
export function createContextDelta(): ContextDelta {
  return {
    messages: [],
    readFiles: new Set(),
  };
}

/**
 * Add a message to the context delta.
 */
export function addDeltaMessage(
  delta: ContextDelta,
  message: Record<string, unknown>
): void {
  delta.messages.push(message);
}

/**
 * Merge delta messages with base context.
 */
export function mergeMessages(
  baseMessages: Array<Record<string, unknown>>,
  delta: ContextDelta,
  systemSuffix?: string
): Array<Record<string, unknown>> {
  const result = [...baseMessages, ...delta.messages];

  // Add system suffix if provided (for synthesis prompts)
  if (systemSuffix && result.length > 0 && result[0].role === 'system') {
    result[0] = {
      ...result[0],
      content: `${result[0].content}\n\n${systemSuffix}`,
    };
  }

  return result;
}

// ============================================
// CONTEXT WINDOW
// ============================================

/**
 * Context window for a work item.
 * Contains the system prompt, goal, and accumulated messages.
 */
export interface ContextWindow {
  /** System prompt with instructions */
  systemPrompt: string;
  /** Current goal/objective */
  goal: string;
  /** Step-specific objective */
  objective: string;
  /** Step number */
  stepNum: number;
  /** Base messages (read-only) */
  messages: Array<Record<string, unknown>>;
  /** Files already read in session */
  readFiles: Set<string>;
}

/**
 * Create a context window for a work item.
 */
export function createContextWindow(
  systemPrompt: string,
  goal: string,
  objective: string,
  stepNum: number,
  messages: Array<Record<string, unknown>> = [],
  readFiles: Set<string> = new Set()
): ContextWindow {
  return {
    systemPrompt,
    goal,
    objective,
    stepNum,
    messages,
    readFiles,
  };
}

/**
 * Build the system message for a work item.
 */
export function buildSystemMessage(
  goal: string,
  objective: string,
  stepNum: number,
  behavioralRules: string = ''
): string {
  return `You are an expert assistant executing a step in a plan.

GOAL: ${goal}

CURRENT STEP: Step ${stepNum}
OBJECTIVE: ${objective}

${behavioralRules}

IMPORTANT ACTION MARKERS:
- When you have completed the objective, output [FINAL] followed by your response
- If you need information from the user, output [NEED_CONTEXT] followed by a JSON: {"question": "...", "options": [...], "context": "..."}
- If you need to continue reasoning, output [CONTINUE] and explain your next steps

Always be concise and focused on the objective.`;
}

/**
 * Build a message containing file contents.
 */
export function buildFilesMessage(
  files: Array<{ path: string; content: string }>
): Record<string, unknown> | null {
  if (files.length === 0) {
    return null;
  }

  const parts = files.map(
    ({ path, content }) => `### File: ${path}\n\`\`\`\n${content}\n\`\`\``
  );

  return {
    role: 'user',
    content: `[AUTO-READ FILES]\n\n${parts.join('\n\n')}`,
  };
}

/**
 * Get messages from context window for LLM call.
 */
export function getContextMessages(
  context: ContextWindow,
  behavioralRules: string = ''
): Array<Record<string, unknown>> {
  const systemMessage = {
    role: 'system',
    content: buildSystemMessage(
      context.goal,
      context.objective,
      context.stepNum,
      behavioralRules
    ),
  };

  return [systemMessage, ...context.messages];
}
