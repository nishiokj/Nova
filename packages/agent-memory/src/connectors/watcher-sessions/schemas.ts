/**
 * Watcher Sessions Schemas
 *
 * Zod schemas for watcher decision and work log entries.
 *
 * @module connectors/watcher-sessions/schemas
 */

import { z } from 'zod'

// ============ Execution Metrics ============

export const ExecutionMetricsSchema = z.object({
  toolCallsMade: z.number(),
  filesModified: z.array(z.string()),
  durationMs: z.number(),
  contextPercentUsed: z.number(),
})

export type ExecutionMetrics = z.infer<typeof ExecutionMetricsSchema>

// ============ Quality Gate ============

export const QualityGateSchema = z.object({
  passed: z.boolean().optional(),
  checks: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
    message: z.string().optional(),
  })).optional(),
}).nullable()

export type QualityGate = z.infer<typeof QualityGateSchema>

// ============ Decision Entry ============

export const DecisionEntrySchema = z.object({
  timestamp: z.string(),
  trigger: z.enum(['prompt_user', 'cadence_audit', 'bounds_exceeded', 'work_complete', 'error']),
  watcherAction: z.enum(['answer', 'allow', 'continue', 'realign', 'pause', 'escalate']),
  question: z.string().optional(),
  answer: z.string().optional(),
  rationale: z.string(),
  workItemId: z.string().optional(),
  executionMetrics: ExecutionMetricsSchema.optional(),
  qualityGate: QualityGateSchema.optional(),
})

export type DecisionEntry = z.infer<typeof DecisionEntrySchema>

// ============ Work Log Entry ============

export const WorkLogEntrySchema = z.object({
  timestamp: z.string(),
  type: z.enum(['session_start', 'watcher_note', 'agent_completed', 'files_modified', 'error']),
  workId: z.string().optional(),
  agentType: z.string().optional(),
  paths: z.array(z.string()).optional(),
  watcherNote: z.string().optional(),
  error: z.string().optional(),
})

export type WorkLogEntry = z.infer<typeof WorkLogEntrySchema>

// ============ Source Schemas (for SourceItem) ============

export const WatcherDecisionSourceSchema = z.object({
  session_id: z.string(),
  session_date: z.string(),
  timestamp: z.string(),
  trigger: z.string(),
  watcher_action: z.string(),
  question: z.string().nullable(),
  answer: z.string().nullable(),
  rationale: z.string(),
  work_item_id: z.string().nullable(),
  tool_calls_made: z.number().nullable(),
  files_modified: z.array(z.string()).nullable(),
  duration_ms: z.number().nullable(),
  context_percent_used: z.number().nullable(),
})

export type WatcherDecisionSource = z.infer<typeof WatcherDecisionSourceSchema>

export const WatcherWorkLogSourceSchema = z.object({
  session_id: z.string(),
  session_date: z.string(),
  timestamp: z.string(),
  type: z.string(),
  work_id: z.string().nullable(),
  agent_type: z.string().nullable(),
  paths: z.array(z.string()).nullable(),
  watcher_note: z.string().nullable(),
})

export type WatcherWorkLogSource = z.infer<typeof WatcherWorkLogSourceSchema>
