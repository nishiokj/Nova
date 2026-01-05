/**
 * Context utilities for Worker prompts.
 *
 * NOTE: ContextWindow class has been moved to types/context.ts.
 * This file now only contains buildSystemMessage() for Worker prompts.
 */

/**
 * Build the system message for a work item.
 */
export function buildSystemMessage(
  goal: string,
  objective: string,
  stepNum: number,
  behavioralRules: string = '',
  workspaceRoot: string = ''
): string {
  const workspaceInfo = workspaceRoot
    ? `\nWORKSPACE ROOT: ${workspaceRoot}\nAll file paths are relative to this workspace unless specified as absolute.\n`
    : '';

  return `You are an expert assistant executing a step in a plan.

GOAL: ${goal}

CURRENT STEP: Step ${stepNum}
OBJECTIVE: ${objective}
${workspaceInfo}
${behavioralRules}

IMPORTANT ACTION MARKERS:
- When you have completed the objective, output [FINAL] followed by your response
- If you need information from the user, output [NEED_CONTEXT] followed by a JSON: {"question": "...", "options": [...], "context": "..."}
- If you need to continue reasoning, output [CONTINUE] and explain your next steps

Always be concise and focused on the objective.`;
}
