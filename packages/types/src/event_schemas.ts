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
  'hook_call',
  'llm_call',
  'llm_error',
  'agent_bounds_hit',
  'memory_injected',
  'files_modified',
]);

/**
 * Orchestrator event types.
 */
export const OrchestratorEventTypeSchema = z.enum([
  'orchestration_started',
  'iteration_started',
  'iteration_completed',
  'runtime_script_created',
  'workitem_status',
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
  /** Optional session key for routing events to persistence */
  sessionKey: z.string().optional(),
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
  arguments: z.record(z.string(), z.unknown()),
  phase: ToolCallPhaseSchema,
  result: z.string().optional(),
  success: z.boolean().optional(),
  durationMs: z.number().optional(),
});

/**
 * Hook call phase.
 */
export const HookCallPhaseSchema = z.enum(['starting', 'completed']);

/**
 * Data for hook_call events.
 */
export const HookCallDataSchema = z.object({
  hookType: z.string(),
  phase: HookCallPhaseSchema,
  success: z.boolean().optional(),
  error: z.string().optional(),
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
 * Data for memory_injected event.
 */
export const MemoryInjectedDataSchema = z.object({
  query: z.string(),
  resultPreview: z.string().optional(),
  memoryContent: z.string().optional(),
  contextWithMemory: z.string().optional(),
  itemCount: z.number(),
  success: z.boolean(),
  iteration: z.number(),
  version: z.enum(['v1', 'v2']).optional(),
  latencyMs: z.number().optional(),
  coverage: z.record(z.string(), z.number()).optional(),
  discriminatorsIncluded: z.number().optional(),
  totalTokens: z.number().optional(),
  fallbackToV1: z.boolean().optional(),
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
 * Metrics for completed work items.
 */
export const WorkItemMetricsSchema = z.object({
  llmCallsMade: z.number(),
  toolCallsMade: z.number(),
  durationMs: z.number(),
});

/**
 * Work item status values.
 */
export const WorkItemStatusValueSchema = z.enum(['started', 'completed', 'failed', 'skipped']);

/**
 * Unified data for workitem_status events.
 */
export const WorkItemStatusDataSchema = z.object({
  workId: z.string(),
  objective: z.string(),
  delta: z.string().optional(),
  agent: z.string(),
  dependencies: z.array(z.string()),
  status: WorkItemStatusValueSchema,
  // Fields for 'completed' status
  response: z.string().optional(),
  metrics: WorkItemMetricsSchema.optional(),
  // Fields for 'failed' status
  error: z.string().optional(),
  toolErrors: z.array(z.string()).optional(),
  terminationReason: z.string().optional(),
  // Fields for 'skipped' status
  reason: z.string().optional(),
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
 * Hook call event.
 */
export const HookCallEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('hook_call'),
  data: HookCallDataSchema,
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
 * Memory injected event.
 */
export const MemoryInjectedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('memory_injected'),
  data: MemoryInjectedDataSchema,
});

/**
 * Agent bounds hit event.
 */
export const AgentBoundsHitEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('agent_bounds_hit'),
  data: z.record(z.string(), z.unknown()),
});

/**
 * Orchestration started event.
 */
export const OrchestrationStartedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('orchestration_started'),
  data: z.record(z.string(), z.unknown()),
});

/**
 * Iteration started event.
 */
export const IterationStartedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('iteration_started'),
  data: z.record(z.string(), z.unknown()),
});

/**
 * Iteration completed event.
 */
export const IterationCompletedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('iteration_completed'),
  data: z.record(z.string(), z.unknown()),
});

/**
 * Runtime script created event.
 */
export const RuntimeScriptCreatedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('runtime_script_created'),
  data: RuntimeScriptCreatedDataSchema,
});

/**
 * Unified work item status event.
 */
export const WorkItemStatusEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('workitem_status'),
  data: WorkItemStatusDataSchema,
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
  HookCallEventSchema,
  LLMCallEventSchema,
  LLMErrorEventSchema,
  MemoryInjectedEventSchema,
  AgentBoundsHitEventSchema,
  OrchestrationStartedEventSchema,
  IterationStartedEventSchema,
  IterationCompletedEventSchema,
  RuntimeScriptCreatedEventSchema,
  WorkItemStatusEventSchema,
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
export type HookCallPhase = z.infer<typeof HookCallPhaseSchema>;
export type LLMErrorType = z.infer<typeof LLMErrorTypeSchema>;

export type ToolCallData = z.infer<typeof ToolCallDataSchema>;
export type HookCallData = z.infer<typeof HookCallDataSchema>;
export type LLMCallData = z.infer<typeof LLMCallDataSchema>;
export type LLMErrorData = z.infer<typeof LLMErrorDataSchema>;
export type MemoryInjectedData = z.infer<typeof MemoryInjectedDataSchema>;
export type RuntimeScriptCreatedData = z.infer<typeof RuntimeScriptCreatedDataSchema>;
export type WorkItemStatusValue = z.infer<typeof WorkItemStatusValueSchema>;
export type WorkItemStatusData = z.infer<typeof WorkItemStatusDataSchema>;
export type GoalAchievedData = z.infer<typeof GoalAchievedDataSchema>;
export type GoalNotAchievedData = z.infer<typeof GoalNotAchievedDataSchema>;

export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;
export type HookCallEvent = z.infer<typeof HookCallEventSchema>;
export type LLMCallEvent = z.infer<typeof LLMCallEventSchema>;
export type LLMErrorEvent = z.infer<typeof LLMErrorEventSchema>;
export type MemoryInjectedEvent = z.infer<typeof MemoryInjectedEventSchema>;
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
