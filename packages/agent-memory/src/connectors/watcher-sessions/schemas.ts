/**
 * Watcher Sessions Schemas
 *
 * Zod schemas for watcher decision and work log entries.
 *
 * @module connectors/watcher-sessions/schemas
 */

import { z } from 'zod'
import {
  isWatcherActionType,
  isWatcherTrigger,
  type WatcherActionType,
  type WatcherTrigger,
} from 'protocol'

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
  issues: z.array(z.string()).optional(),
  checks: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
    message: z.string().optional(),
  })).optional(),
}).nullable()

export type QualityGate = z.infer<typeof QualityGateSchema>

const LEGACY_TRIGGER_MAP: Record<string, WatcherTrigger> = {
  work_complete: 'work_item_completed',
  error: 'agent_error',
}

const LEGACY_ACTION_MAP: Record<string, WatcherActionType> = {
  pause: 'continue',
  escalate: 'stop_work_item',
}

function normalizeWatcherTrigger(value: string): WatcherTrigger | null {
  const normalized = value.trim().toLowerCase()
  const mapped = LEGACY_TRIGGER_MAP[normalized] ?? normalized
  return isWatcherTrigger(mapped) ? mapped : null
}

function normalizeWatcherAction(value: string): WatcherActionType | null {
  const normalized = value.trim().toLowerCase()
  const mapped = LEGACY_ACTION_MAP[normalized] ?? normalized
  return isWatcherActionType(mapped) ? mapped : null
}

const WatcherTriggerSchema = z.string().transform((value, ctx) => {
  const normalized = normalizeWatcherTrigger(value)
  if (!normalized) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid watcher trigger: ${value}`,
    })
    return z.NEVER
  }
  return normalized
})

const WatcherActionSchema = z.string().transform((value, ctx) => {
  const normalized = normalizeWatcherAction(value)
  if (!normalized) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid watcher action: ${value}`,
    })
    return z.NEVER
  }
  return normalized
})

// ============ Decision Entry ============

export const DecisionEntrySchema = z.object({
  timestamp: z.string(),
  trigger: WatcherTriggerSchema,
  watcherAction: WatcherActionSchema,
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
