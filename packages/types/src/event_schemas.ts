/**
 * Zod schemas for agent events.
 *
 * These schemas provide runtime validation for events flowing
 * through the event bus and JSONL-TCP connections.
 */

import { z } from 'zod';

// ============================================
// EVENT TYPE ENUMS
// ============================================

/**
 * Core agent event types.
 */
export const AgentCoreEventTypeSchema = z.enum([
  'tool_call',
  'llm_call',
  'llm_error',
  'agent_bounds_hit',
]);

/**
 * Orchestrator event types.
 */
export const OrchestratorEventTypeSchema = z.enum([
  'orchestration_started',
  'iteration_started',
  'iteration_completed',
  'runtime_script_created',
  'workitem_started',
  'workitem_completed',
  'workitem_failed',
  'workitem_skipped',
  'goal_achieved',
  'goal_not_achieved',
]);

/**
 * All event types.
 */
export const AgentEventTypeSchema = z.union([
  AgentCoreEventTypeSchema,
  OrchestratorEventTypeSchema,
]);

// ============================================
// BASE EVENT FIELDS
// ============================================

/**
 * Base fields present on all events.
 */
export const BaseEventFieldsSchema = z.object({
  /** REQUIRED: Correlates all events for a single request */
  requestId: z.string(),
  /** Optional run ID for per-run channels */
  runId: z.string().optional(),
  /** Unix timestamp in seconds */
  timestamp: z.number(),
  /** WorkItem ID if event is workitem-related */
  workItemId: z.string().optional(),
});

// ============================================
// EVENT DATA SCHEMAS
// ============================================

/**
 * Tool call phase.
 */
export const ToolCallPhaseSchema = z.enum(['starting', 'completed']);

/**
 * Data for tool_call events.
 */
export const ToolCallDataSchema = z.object({
  toolName: z.string(),
  arguments: z.record(z.unknown()),
  phase: ToolCallPhaseSchema,
  result: z.string().optional(),
  success: z.boolean().optional(),
  durationMs: z.number().optional(),
});

/**
 * Data for llm_call events.
 */
export const LLMCallDataSchema = z.object({
  agentType: z.string(),
  provider: z.string().optional(),
  promptPreview: z.string(),
  responsePreview: z.string(),
  totalTokens: z.number(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  durationMs: z.number(),
  model: z.string(),
  toolCallsCount: z.number(),
  toolNames: z.array(z.string()),
  messageCount: z.number(),
});

/**
 * LLM error type.
 */
export const LLMErrorTypeSchema = z.enum([
  'api_error',
  'rate_limit',
  'timeout',
  'validation',
  'circuit_open',
  'unknown',
]);

/**
 * Data for llm_error events.
 */
export const LLMErrorDataSchema = z.object({
  agentType: z.string(),
  provider: z.string(),
  model: z.string(),
  error: z.string(),
  errorType: LLMErrorTypeSchema,
});

/**
 * Work item summary in runtime script.
 */
export const WorkItemSummarySchema = z.object({
  workId: z.string(),
  objective: z.string(),
  delta: z.string().optional(),
  agent: z.string(),
  dependencies: z.array(z.string()),
});

/**
 * System context for runtime scripts.
 */
export const SystemContextSchema = z.object({
  packageManagers: z.array(z.string()),
  frameworks: z.array(z.string()),
  languages: z.array(z.string()),
});

/**
 * Data for runtime_script_created events.
 */
export const RuntimeScriptCreatedDataSchema = z.object({
  goal: z.string(),
  workItemCount: z.number(),
  workItems: z.array(WorkItemSummarySchema),
  systemContext: SystemContextSchema,
});

/**
 * Data for workitem_started events.
 */
export const WorkItemStartedDataSchema = z.object({
  workId: z.string(),
  objective: z.string(),
  delta: z.string().optional(),
  agent: z.string(),
  dependencies: z.array(z.string()),
});

/**
 * Metrics for completed work items.
 */
export const WorkItemMetricsSchema = z.object({
  llmCallsMade: z.number(),
  toolCallsMade: z.number(),
  durationMs: z.number(),
});

/**
 * Data for workitem_completed events.
 */
export const WorkItemCompletedDataSchema = z.object({
  workId: z.string(),
  objective: z.string(),
  response: z.string(),
  metrics: WorkItemMetricsSchema,
});

/**
 * Data for workitem_failed events.
 */
export const WorkItemFailedDataSchema = z.object({
  workId: z.string(),
  objective: z.string(),
  error: z.string(),
  toolErrors: z.array(z.string()).optional(),
  terminationReason: z.string(),
});

/**
 * Data for workitem_skipped events.
 */
export const WorkItemSkippedDataSchema = z.object({
  workId: z.string(),
  objective: z.string(),
  reason: z.string(),
});

/**
 * Data for goal_achieved events.
 */
export const GoalAchievedDataSchema = z.object({
  goal: z.string(),
  completed: z.number(),
  skipped: z.number(),
});

/**
 * Data for goal_not_achieved events.
 */
export const GoalNotAchievedDataSchema = z.object({
  goal: z.string(),
  reason: z.string(),
  completed: z.number(),
  failed: z.number(),
  skipped: z.number(),
});

// ============================================
// TYPED EVENT SCHEMAS (discriminated union)
// ============================================

/**
 * Tool call event.
 */
export const ToolCallEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('tool_call'),
  data: ToolCallDataSchema,
});

/**
 * LLM call event.
 */
export const LLMCallEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('llm_call'),
  data: LLMCallDataSchema,
});

/**
 * LLM error event.
 */
export const LLMErrorEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('llm_error'),
  data: LLMErrorDataSchema,
});

/**
 * Agent bounds hit event.
 */
export const AgentBoundsHitEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('agent_bounds_hit'),
  data: z.record(z.unknown()),
});

/**
 * Orchestration started event.
 */
export const OrchestrationStartedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('orchestration_started'),
  data: z.record(z.unknown()),
});

/**
 * Iteration started event.
 */
export const IterationStartedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('iteration_started'),
  data: z.record(z.unknown()),
});

/**
 * Iteration completed event.
 */
export const IterationCompletedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('iteration_completed'),
  data: z.record(z.unknown()),
});

/**
 * Runtime script created event.
 */
export const RuntimeScriptCreatedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('runtime_script_created'),
  data: RuntimeScriptCreatedDataSchema,
});

/**
 * Work item started event.
 */
export const WorkItemStartedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('workitem_started'),
  data: WorkItemStartedDataSchema,
});

/**
 * Work item completed event.
 */
export const WorkItemCompletedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('workitem_completed'),
  data: WorkItemCompletedDataSchema,
});

/**
 * Work item failed event.
 */
export const WorkItemFailedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('workitem_failed'),
  data: WorkItemFailedDataSchema,
});

/**
 * Work item skipped event.
 */
export const WorkItemSkippedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('workitem_skipped'),
  data: WorkItemSkippedDataSchema,
});

/**
 * Goal achieved event.
 */
export const GoalAchievedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('goal_achieved'),
  data: GoalAchievedDataSchema,
});

/**
 * Goal not achieved event.
 */
export const GoalNotAchievedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('goal_not_achieved'),
  data: GoalNotAchievedDataSchema,
});

/**
 * Discriminated union of all event types.
 */
export const AgentEventSchema = z.discriminatedUnion('type', [
  ToolCallEventSchema,
  LLMCallEventSchema,
  LLMErrorEventSchema,
  AgentBoundsHitEventSchema,
  OrchestrationStartedEventSchema,
  IterationStartedEventSchema,
  IterationCompletedEventSchema,
  RuntimeScriptCreatedEventSchema,
  WorkItemStartedEventSchema,
  WorkItemCompletedEventSchema,
  WorkItemFailedEventSchema,
  WorkItemSkippedEventSchema,
  GoalAchievedEventSchema,
  GoalNotAchievedEventSchema,
]);

// ============================================
// INFERRED TYPES
// ============================================

export type AgentCoreEventType = z.infer<typeof AgentCoreEventTypeSchema>;
export type OrchestratorEventType = z.infer<typeof OrchestratorEventTypeSchema>;
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;
export type ToolCallPhase = z.infer<typeof ToolCallPhaseSchema>;
export type LLMErrorType = z.infer<typeof LLMErrorTypeSchema>;

export type ToolCallData = z.infer<typeof ToolCallDataSchema>;
export type LLMCallData = z.infer<typeof LLMCallDataSchema>;
export type LLMErrorData = z.infer<typeof LLMErrorDataSchema>;
export type RuntimeScriptCreatedData = z.infer<typeof RuntimeScriptCreatedDataSchema>;
export type WorkItemStartedData = z.infer<typeof WorkItemStartedDataSchema>;
export type WorkItemCompletedData = z.infer<typeof WorkItemCompletedDataSchema>;
export type WorkItemFailedData = z.infer<typeof WorkItemFailedDataSchema>;
export type WorkItemSkippedData = z.infer<typeof WorkItemSkippedDataSchema>;
export type GoalAchievedData = z.infer<typeof GoalAchievedDataSchema>;
export type GoalNotAchievedData = z.infer<typeof GoalNotAchievedDataSchema>;

export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;
export type LLMCallEvent = z.infer<typeof LLMCallEventSchema>;
export type LLMErrorEvent = z.infer<typeof LLMErrorEventSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;

// ============================================
// VALIDATION FUNCTIONS
// ============================================

/**
 * Validate an event against the schema.
 * Returns the validated event or null on failure.
 */
export function parseEvent(event: unknown): AgentEvent | null {
  const result = AgentEventSchema.safeParse(event);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    console.warn(`[event] Invalid event: ${issues}`);
    return null;
  }
  return result.data;
}

/**
 * Check if an event is valid without returning the parsed value.
 */
export function isValidEvent(event: unknown): boolean {
  return AgentEventSchema.safeParse(event).success;
}
