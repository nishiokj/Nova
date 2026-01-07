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
    behavioralRules: string = '',
    workspaceRoot: string = '',
    constraints?: {
      iteration?: number;
      maxIterations?: number;
      toolCallsUsed?: number;
      maxToolCalls?: number;
      elapsedMs?: number;
      maxDurationMs?: number;
    }
  ): string {
    const workspaceInfo = workspaceRoot
      ? `\nWORKSPACE ROOT: ${workspaceRoot}\nAll file paths are relative to this workspace unless specified as absolute.\n`
      : '';
    const constraintsInfo = constraints ? formatConstraints(constraints) : '';

    return `You are an expert assistant executing a step in a plan.

  GOAL: ${goal}

  OBJECTIVE: ${objective}
  ${workspaceInfo}
  ${behavioralRules}${constraintsInfo ? `\n${constraintsInfo}` : ''}

  IMPORTANT RESPONSE ACTIONS:
  - Set action to "final" when the objective is complete and provide your response
  - Set action to "need_context" when you need user input and include user_prompt details
  - Set action to "continue" when you need another iteration and explain next steps

  Always be concise and focused on the objective.`;
  }

  function formatConstraints(constraints: {
    iteration?: number;
    maxIterations?: number;
    toolCallsUsed?: number;
    maxToolCalls?: number;
    elapsedMs?: number;
    maxDurationMs?: number;
  }): string {
    const lines: string[] = [];
    if (typeof constraints.iteration === 'number' && typeof constraints.maxIterations === 'number') {
      lines.push(`- Iteration: ${constraints.iteration} of ${constraints.maxIterations}`);
    }
    if (typeof constraints.toolCallsUsed === 'number' && typeof constraints.maxToolCalls === 'number') {
      lines.push(`- Tool calls used: ${constraints.toolCallsUsed} of ${constraints.maxToolCalls}`);
    } else if (typeof constraints.maxToolCalls === 'number') {
      lines.push(`- Max tool calls: ${constraints.maxToolCalls}`);
    }
    if (typeof constraints.elapsedMs === 'number' && typeof constraints.maxDurationMs === 'number') {
      lines.push(`- Elapsed time: ${constraints.elapsedMs}ms of ${constraints.maxDurationMs}ms`);
    } else if (typeof constraints.maxDurationMs === 'number') {
      lines.push(`- Max duration: ${constraints.maxDurationMs}ms`);
    }
    if (lines.length === 0) return '';
    return `  CONSTRAINTS:\n  ${lines.join('\n  ')}`;
  }
