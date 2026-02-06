/**
 * Protocol Schemas - Zod Validation
 *
 * Zod schemas for validating LLM output and external input.
 * These schemas are the source of truth for wire formats.
 */

import { z } from 'zod';

// ============================================
// TERMINATION SCHEMAS
// ============================================

export const TerminationReasonSchema = z.enum([
  'goal_state_reached',
  'user_input_required',
  'handoff_requested',
  'user_stopped',
  'max_iterations_exceeded',
  'max_tool_calls_exceeded',
  'max_duration_exceeded',
  'rate_limit',
  'circuit_open',
  'timeout',
  'agent_error',
  'invalid_action',
  'no_action',
  'refusal',
  'stagnation',
  'watcher_stopped',
  'watcher_work_item_stopped',
  'cadence_audit',
]);

// ============================================
// DECISION SCHEMAS
// ============================================

export const QualityGateDecisionSchema = z.discriminatedUnion('verdict', [
  z.object({ verdict: z.literal('passed') }),
  z.object({ verdict: z.literal('failed'), issues: z.array(z.string()) }),
  z.object({ verdict: z.literal('needs_human'), concerns: z.array(z.string()) }),
]);

export const BoundsDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('realign'), guidance: z.string() }),
  z.object({
    action: z.literal('split'),
    workItems: z.array(z.object({
      goal: z.string(),
      objective: z.string(),
      agent: z.string(),
      domain: z.string().optional(),
      dependencies: z.array(z.string()).optional(),
      targetPaths: z.array(z.string()).optional(),
    })),
  }),
  z.object({ action: z.literal('wrap_up'), summary: z.string() }),
  z.object({ action: z.literal('abort'), reason: z.string() }),
]);

export const PromptAnswerDecisionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('answer'),
    text: z.string(),
    confidence: z.number().min(0).max(1),
    contextAddendum: z.string().optional(),
  }),
  z.object({ action: z.literal('escalate'), reason: z.string() }),
  z.object({ action: z.literal('defer'), to: z.enum(['user', 'ops']) }),
]);

export const CadenceDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('continue') }),
  z.object({ action: z.literal('inject_guidance'), message: z.string() }),
  z.object({
    action: z.literal('realign'),
    guidance: z.string(),
    newWork: z.object({
      goal: z.string(),
      objective: z.string(),
      agent: z.string(),
    }).optional(),
  }),
  z.object({
    action: z.literal('split'),
    workItems: z.array(z.object({
      goal: z.string(),
      objective: z.string(),
      agent: z.string(),
    })),
  }),
  z.object({ action: z.literal('stop'), reason: z.string() }),
  z.object({
    action: z.literal('stop_work_item'),
    reason: z.string(),
    escalationId: z.string().optional(),
  }),
]);

export const AgentErrorDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retry'), guidance: z.string() }),
  z.object({ action: z.literal('abort'), reason: z.string() }),
  z.object({ action: z.literal('escalate'), to: z.enum(['user', 'ops']) }),
]);

export const HandoffDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('reject'), feedback: z.string() }),
  z.object({ action: z.literal('modify'), changes: z.string() }),
]);

export const WorkItemCompletedDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept'), summary: z.string() }),
  z.object({ action: z.literal('retry'), guidance: z.string() }),
  z.object({
    action: z.literal('split'),
    workItems: z.array(z.object({
      goal: z.string(),
      objective: z.string(),
      agent: z.string(),
    })),
  }),
  z.object({ action: z.literal('escalate'), to: z.enum(['user', 'ops']), reason: z.string() }),
]);

// ============================================
// PATCH SCHEMAS
// ============================================

export const WorkItemSpecSchema = z.object({
  id: z.string().min(1).optional(),
  goal: z.string().min(1),
  objective: z.string().min(1),
  agent: z.string().min(1),
  domain: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  targetPaths: z.array(z.string()).optional(),
  bounds: z.object({
    maxToolCalls: z.number().optional(),
    maxLlmCalls: z.number().optional(),
    maxDurationMs: z.number().optional(),
  }).optional(),
});

export const StatePatchSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('enqueue_work'),
    items: z.array(WorkItemSpecSchema).min(1),
    position: z.enum(['front', 'back']).optional(),
  }),
  z.object({
    op: z.literal('cancel_work'),
    workIds: z.array(z.string()).min(1),
    reason: z.string().min(1),
  }),
  z.object({
    op: z.literal('inject_message'),
    role: z.enum(['system', 'user']),
    content: z.string().min(1),
  }),
  z.object({
    op: z.literal('inject_guidance'),
    content: z.string().min(1),
  }),
  z.object({
    op: z.literal('reset_counter'),
    counter: z.enum(['realign', 'iteration', 'tool_calls']),
  }),
  z.object({
    op: z.literal('increment_counter'),
    counter: z.enum(['realign']),
  }),
  z.object({
    op: z.literal('set_termination'),
    reason: TerminationReasonSchema,
  }),
  z.object({ op: z.literal('clear_termination') }),
  z.object({ op: z.literal('force_continue') }),
  z.object({
    op: z.literal('set_metadata'),
    key: z.string().min(1),
    value: z.unknown(),
  }),
  z.object({
    op: z.literal('append_audit_log'),
    entry: z.object({
      timestamp: z.number(),
      source: z.string(),
      event: z.string(),
      details: z.record(z.string(), z.unknown()),
    }),
  }),
]);

// ============================================
// HOOK OUTCOME SCHEMAS
// ============================================

export const HookOutcomeSchema = <T extends z.ZodTypeAny>(decisionSchema: T) =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('success'),
      decision: decisionSchema,
      patches: z.array(StatePatchSchema).optional(),
    }),
    z.object({ kind: z.literal('skip'), reason: z.string() }),
    z.object({ kind: z.literal('deny'), reason: z.string() }),
    z.object({ kind: z.literal('retry'), error: z.string(), backoffMs: z.number() }),
    z.object({ kind: z.literal('timeout') }),
    z.object({ kind: z.literal('failed'), error: z.string() }),
  ]);

// ============================================
// WATCHER OUTPUT SCHEMA
// ============================================

/**
 * Schema for watcher LLM output.
 * This is what the watcher agent produces.
 */
export const WatcherOutputSchema = z.object({
  action: z.enum(['done', 'continue']),
  goalStateReached: z.boolean(),
  response: z.string(),
  watcherAction: z.object({
    action: z.enum(['answer', 'realign', 'split', 'create_work_item', 'stop_work_item', 'quality_gate', 'allow', 'continue']),
    reason: z.string(),
    escalationId: z.string().optional(),
    answer: z.object({
      text: z.string(),
      contextAddendum: z.string().optional(),
    }).optional(),
    realign: z.object({
      systemMessage: z.string(),
      newGoal: z.string().optional(),
    }).optional(),
    workItems: z.array(WorkItemSpecSchema).optional(),
    qualityGate: z.object({
      passed: z.boolean(),
      issues: z.array(z.string()).optional(),
    }).optional(),
  }),
});

// ============================================
// TYPE EXPORTS
// ============================================

export type TerminationReasonSchemaType = z.infer<typeof TerminationReasonSchema>;
export type QualityGateDecisionSchemaType = z.infer<typeof QualityGateDecisionSchema>;
export type BoundsDecisionSchemaType = z.infer<typeof BoundsDecisionSchema>;
export type PromptAnswerDecisionSchemaType = z.infer<typeof PromptAnswerDecisionSchema>;
export type CadenceDecisionSchemaType = z.infer<typeof CadenceDecisionSchema>;
export type AgentErrorDecisionSchemaType = z.infer<typeof AgentErrorDecisionSchema>;
export type HandoffDecisionSchemaType = z.infer<typeof HandoffDecisionSchema>;
export type WorkItemCompletedDecisionSchemaType = z.infer<typeof WorkItemCompletedDecisionSchema>;
export type StatePatchSchemaType = z.infer<typeof StatePatchSchema>;
export type WatcherOutputSchemaType = z.infer<typeof WatcherOutputSchema>;
