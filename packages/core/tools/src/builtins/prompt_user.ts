/**
 * PromptUser tool - Request user input with structured schema.
 *
 * This is a control-flow tool that signals the agent needs user input.
 * The executor returns immediately with a special marker - actual pausing
 * happens in the agent's processToolCalls when it detects this tool.
 */

import type { ToolResult } from 'types';
import type { ToolRegistrationOptions } from '../types.js';

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
  options?: Array<string | PromptUserOption>;
  context?: string;
  multiSelect?: boolean;
  questionType?: 'multiple_choice' | 'multi_select' | 'fill_in_blank' | 'yes_no' | 'free_text';
}

/**
 * Arguments for PromptUser tool.
 */
export interface PromptUserArgs {
  question: string;
  options?: Array<string | PromptUserOption>;
  context?: string;
  multiSelect?: boolean;
  questionType?: 'multiple_choice' | 'multi_select' | 'fill_in_blank' | 'yes_no' | 'free_text';
  questions?: PromptUserQuestion[];
}

/**
 * Execute PromptUser tool.
 * Returns a special marker result - the actual pause logic is in the agent.
 */
export async function executePromptUser(
  args: Record<string, unknown>
): Promise<ToolResult> {
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

/**
 * PromptUser tool registration options.
 */
export const promptUserToolOptions: ToolRegistrationOptions = {
  name: 'PromptUser',
  description: 'Request input from the user. Use this when you need clarification, want to present options, or need the user to make a decision.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user',
      },
      options: {
        type: 'array',
        description: 'Optional list of choices for the user. Each option can be a string or an object with label and optional description.',
        items: {
          type: 'object',
          description: 'Option as string or {label, description?}',
          properties: {
            label: { type: 'string', description: 'Display text for the option' },
            description: { type: 'string', description: 'Additional context for the option' },
          },
        },
      },
      context: {
        type: 'string',
        description: 'Additional context to help the user understand the question',
      },
      multiSelect: {
        type: 'boolean',
        description: 'Whether the user can select multiple options (default: false)',
      },
      questionType: {
        type: 'string',
        enum: ['multiple_choice', 'multi_select', 'fill_in_blank', 'yes_no', 'free_text'],
        description: 'Type of question input expected',
      },
      questions: {
        type: 'array',
        description: 'Multiple questions to ask in sequence',
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
    required: ['question'],
  },
  required: ['question'],
  executor: executePromptUser,
  timeoutMs: 1000,
  readOnly: true,
  parallelizable: false,
  costHint: 'low',
};
