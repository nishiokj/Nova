/**
 * Watcher Skill - LLM-backed oversight agent for async multi-agent execution.
 *
 * The watcher intercepts orchestrator terminal conditions via the StopHookHandler
 * mechanism, runs as an agent with Bash/Read/Glob/Grep tools, and returns
 * structured WatcherAction output.
 */

import type { StructuredOutputSchema } from 'types';

// ============================================
// SCHEMA
// ============================================

/**
 * Structured output schema for watcher actions.
 * Matches the WatcherAction type in decision-watcher/src/types.ts.
 */
export const WATCHER_ACTION_SCHEMA: StructuredOutputSchema = {
  name: 'watcher_action',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      // Standard Agent protocol fields (required for Agent loop to work)
      action: {
        type: 'string',
        enum: ['done', 'continue'],
        description: 'Standard agent action: "done" when decision is ready, "continue" to keep using tools',
      },
      response: {
        type: ['string', 'null'],
        description: 'Human-readable summary of the watcher decision',
      },
      goalStateReached: {
        type: ['boolean', 'null'],
        description: 'Set to true when returning the watcher decision',
      },
      // Watcher-specific fields
      watcherAction: {
        type: 'string',
        enum: ['answer', 'realign', 'split', 'create_work_item', 'quality_gate', 'escalate', 'continue'],
        description: 'The watcher decision type',
      },
      reason: {
        type: 'string',
        description: 'Rationale for this decision',
      },
      answer: {
        type: ['object', 'null'],
        properties: {
          text: { type: 'string', description: 'The answer text to inject' },
          contextAddendum: { type: ['string', 'null'], description: 'Additional context to append' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      realign: {
        type: ['object', 'null'],
        properties: {
          systemMessage: { type: 'string', description: 'System message to inject into context' },
          newGoal: { type: ['string', 'null'], description: 'Replacement goal if the current one has drifted' },
        },
        required: ['systemMessage'],
        additionalProperties: false,
      },
      workItems: {
        type: ['array', 'null'],
        items: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'High-level goal for this work item' },
            objective: { type: 'string', description: 'Specific objective' },
            agent: { type: 'string', description: 'Agent type to use' },
            dependencies: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description: 'Work item IDs this depends on',
            },
            targetPaths: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description: 'File paths this work item should focus on',
            },
          },
          required: ['goal', 'objective', 'agent'],
          additionalProperties: false,
        },
        description: 'Work items to create (for split/create_work_item actions)',
      },
      qualityGate: {
        type: ['object', 'null'],
        properties: {
          passed: { type: 'boolean', description: 'Whether the quality gate passed' },
          issues: {
            type: ['array', 'null'],
            items: { type: 'string' },
            description: 'Issues found during quality check',
          },
        },
        required: ['passed'],
        additionalProperties: false,
      },
    },
    required: ['action', 'response', 'goalStateReached', 'watcherAction', 'reason', 'answer', 'realign', 'workItems', 'qualityGate'],
    additionalProperties: false,
  },
};
