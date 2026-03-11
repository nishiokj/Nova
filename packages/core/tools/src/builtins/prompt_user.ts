/**
 * PromptUser tool - Request user input with structured schema.
 *
 * This is a control-flow tool that signals the agent needs user input.
 * The executor returns immediately with a special marker - actual pausing
 * happens in the agent's processToolCalls when it detects this tool.
 */

import type { ToolResult } from 'types';
import { Effect } from 'effect';
import type { ToolExecutionError, ToolRegistrationOptions } from '../types.js';

/**
 * Option structure for user prompts.
 */
export interface PromptUserOption {
  label: string;
  description?: string;
}

/**
 * Single question in a multi-question prompt.
 */
export interface PromptUserQuestion {
  question: string;
  options?: (string | PromptUserOption)[];
  context?: string;
  multiSelect?: boolean;
  questionType?: 'multiple_choice' | 'multi_select' | 'fill_in_blank' | 'yes_no' | 'free_text';
}

/**
 * Arguments for PromptUser tool.
 */
export interface PromptUserArgs {
  questions: PromptUserQuestion[];
}

/**
 * Execute PromptUser tool.
 * Returns a special marker result - the actual pause logic is in the agent.
 */
export function executePromptUser(
  args: Record<string, unknown>
): ToolResult {
  // The tool itself doesn't "do" anything - it's a signal to the agent
  // to pause execution and request user input. The agent intercepts this
  // tool call and extracts the args to build UserPromptInfo.
  return {
    toolName: 'PromptUser',
    status: 'success',
    output: '__PROMPT_USER__',
    isSuccess: true,
    durationMs: 0,
    metadata: { isPromptUser: true, args },
  };
}

export function executePromptUserEffect(
  args: Record<string, unknown>
): Effect.Effect<ToolResult, ToolExecutionError> {
  return Effect.succeed({
    toolName: 'PromptUser',
    status: 'success',
    output: '__PROMPT_USER__',
    isSuccess: true,
    durationMs: 0,
    metadata: { isPromptUser: true, args },
  });
}

/**
 * PromptUser tool registration options.
 */
export const promptUserToolOptions: ToolRegistrationOptions = {
  name: 'PromptUser',
  description: 'Request input from the user. Use this when you need clarification, want to present options, or need the user to make a decision.',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'Questions to ask in sequence',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question text' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
              },
            },
            context: { type: 'string' },
            multiSelect: { type: 'boolean' },
            questionType: {
              type: 'string',
              enum: ['multiple_choice', 'multi_select', 'fill_in_blank', 'yes_no', 'free_text'],
            },
          },
          required: ['question'],
        },
      },
    },
    required: ['questions'],
  },
  required: ['questions'],
  executor: executePromptUserEffect,
  timeoutMs: 1000,
  readOnly: true,
  parallelizable: false,
  costHint: 'low',
};
