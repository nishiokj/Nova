// /**
//  * Context utilities for Worker prompts.
//  *
//  * NOTE: ContextWindow class has been moved to types/context.ts.
//  * This file now only contains buildSystemMessage() for Worker prompts.
//  */

// /**
//  * Build the system message for a work item.
//  */
// export function buildSystemMessage(
//   goal: string,
//   objective: string,
//   stepNum: number,
//   behavioralRules: string = '',
//   workspaceRoot: string = ''
// ): string {
//   const workspaceInfo = workspaceRoot
//     ? `\nWORKSPACE ROOT: ${workspaceRoot}\nAll file paths are relative to this workspace unless specified as absolute.\n`
//     : '';

//   return `You are an expert assistant executing a step in a plan.

// GOAL: ${goal}

// CURRENT STEP: Step ${stepNum}
// OBJECTIVE: ${objective}
// ${workspaceInfo}
// ${behavioralRules}

// IMPORTANT RESPONSE ACTIONS:
// - Set action to "final" when the objective is complete and provide your response
// - Set action to "need_context" when you need user input and include user_prompt details
// - Set action to "continue" when you need another iteration and explain next steps

// Always be concise and focused on the objective.`;
// }
