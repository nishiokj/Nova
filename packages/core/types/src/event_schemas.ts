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
  'run_control_requested',
  'run_control_applied',
  'run_control_rejected',
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
// RUN CONTROL SCHEMAS
// ============================================

export const RunControlStateSchema = z.enum([
  'running',
  'cancelling',
  'cancelled',
]);

export const RunControlActionSchema = z.enum(['cancel']);
export const RunControlScopeSchema = z.enum(['run', 'work_item', 'tool']);
export const RunControlSourceSchema = z.enum(['user', 'system', 'policy']);

export const RunCancellationMetadataSchema = z.object({
  requestedAt: z.number(),
  requestedBy: RunControlSourceSchema.optional(),
  reason: z.string().optional(),
  scope: RunControlScopeSchema.optional(),
  targetWorkIds: z.array(z.string()).optional(),
});

export const RunControlTargetSchema = z.object({
  scope: RunControlScopeSchema,
  runId: z.string().optional(),
  workItemIds: z.array(z.string()).optional(),
});

export const RunControlRequestedDataSchema = z.object({
  action: RunControlActionSchema,
  source: RunControlSourceSchema,
  target: RunControlTargetSchema,
  stateBefore: RunControlStateSchema,
  cancellation: RunCancellationMetadataSchema.optional(),
});

export const RunControlAppliedDataSchema = RunControlRequestedDataSchema.extend({
  stateAfter: RunControlStateSchema,
});

export const RunControlRejectedDataSchema = RunControlRequestedDataSchema.extend({
  reason: z.string(),
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
const MemoryInjectionCandidateSchema = z.object({
  doc_id: z.string(),
  chunk_id: z.string().nullable(),
  source_type: z.enum(['file', 'symbol', 'summary', 'tool_output', 'web']),
  scores: z.object({
    embedding_score: z.number().nullable(),
    bm25_score: z.number().nullable(),
    heuristic_score: z.number().nullable(),
    reranker_score: z.number().nullable(),
  }),
  token_size: z.number(),
  freshness: z.string().nullable(),
  scope: z.string().nullable(),
});

export const MemoryInjectionTrainingSignalSchema = z.object({
  retrieval_id: z.string(),
  query: z.object({
    raw: z.string(),
    state_summary: z.string(),
  }),
  candidate_list: z.array(MemoryInjectionCandidateSchema),
  selected_set: z.array(MemoryInjectionCandidateSchema),
  budget: z.object({
    max_tokens: z.number(),
    k: z.number(),
    max_items: z.number(),
    filters: z.record(z.string(), z.unknown()).nullable(),
    min_coverage: z.record(z.string(), z.number()),
  }),
  run_id: z.string().nullable(),
  session_id: z.string(),
  work_item_id: z.string().nullable(),
});

export const MemoryInjectedDataSchema = z.object({
  query: z.string(),
  resultPreview: z.string().optional(),
  memoryContent: z.string().optional(),
  contextWithMemory: z.string().optional(),
  itemCount: z.number(),
  success: z.boolean(),
  iteration: z.number(),
  latencyMs: z.number().optional(),
  coverage: z.record(z.string(), z.number()).optional(),
  discriminatorsIncluded: z.number().optional(),
  totalTokens: z.number().optional(),
  trainingSignal: MemoryInjectionTrainingSignalSchema.optional(),
}).strict();
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
 * Run control requested event.
 */
export const RunControlRequestedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('run_control_requested'),
  data: RunControlRequestedDataSchema,
});

/**
 * Run control applied event.
 */
export const RunControlAppliedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('run_control_applied'),
  data: RunControlAppliedDataSchema,
});

/**
 * Run control rejected event.
 */
export const RunControlRejectedEventSchema = BaseEventFieldsSchema.extend({
  type: z.literal('run_control_rejected'),
  data: RunControlRejectedDataSchema,
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
  RunControlRequestedEventSchema,
  RunControlAppliedEventSchema,
  RunControlRejectedEventSchema,
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
export type RunControlState = z.infer<typeof RunControlStateSchema>;
export type RunControlAction = z.infer<typeof RunControlActionSchema>;
export type RunControlScope = z.infer<typeof RunControlScopeSchema>;
export type RunControlSource = z.infer<typeof RunControlSourceSchema>;

export type ToolCallData = z.infer<typeof ToolCallDataSchema>;
export type HookCallData = z.infer<typeof HookCallDataSchema>;
export type LLMCallData = z.infer<typeof LLMCallDataSchema>;
export type LLMErrorData = z.infer<typeof LLMErrorDataSchema>;
export type MemoryInjectionTrainingSignal = z.infer<typeof MemoryInjectionTrainingSignalSchema>;
export type MemoryInjectedData = z.infer<typeof MemoryInjectedDataSchema>;
export type RunCancellationMetadata = z.infer<typeof RunCancellationMetadataSchema>;
export type RunControlTarget = z.infer<typeof RunControlTargetSchema>;
export type RunControlRequestedData = z.infer<typeof RunControlRequestedDataSchema>;
export type RunControlAppliedData = z.infer<typeof RunControlAppliedDataSchema>;
export type RunControlRejectedData = z.infer<typeof RunControlRejectedDataSchema>;
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
export type RunControlRequestedEvent = z.infer<typeof RunControlRequestedEventSchema>;
export type RunControlAppliedEvent = z.infer<typeof RunControlAppliedEventSchema>;
export type RunControlRejectedEvent = z.infer<typeof RunControlRejectedEventSchema>;
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
