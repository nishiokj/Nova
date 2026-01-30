/**
 * Conversational Memory Models
 *
 * Domain-specific schemas for conversational memory entities.
 * These are separate from canonical entities and live in dedicated tables.
 */

import { z } from 'zod'
import { UlidSchema } from '../ids.js'

// ============ Enums ============

export const MemoryEntityTypeSchema = z.enum([
  'project',
  'goal',
  'person',
  'issue',
  'concept',
])

export type MemoryEntityType = z.infer<typeof MemoryEntityTypeSchema>

export const MemoryStateSchema = z.enum([
  'missing',
  'queued',
  'processing',
  'ready',
  'stale',
  'failed',
])

export type MemoryState = z.infer<typeof MemoryStateSchema>

// ============ Project ============

export const ProjectSchema = z.object({
  id: UlidSchema,
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  status: z.enum(['active', 'paused', 'completed', 'abandoned']),
  repo_url: z.string().url().nullable().optional(),
  parent_project_id: UlidSchema.nullable().optional(),
  conversation_count: z.number().int().nonnegative().default(0),
  last_discussed_at: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
})

export type Project = z.infer<typeof ProjectSchema>

// ============ Goal ============

export const GoalSchema = z.object({
  id: UlidSchema,
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  status: z.enum(['active', 'paused', 'completed', 'failed', 'abandoned']),
  parent_goal_id: UlidSchema.nullable().optional(),
  project_id: UlidSchema.nullable().optional(),
  progress_notes: z.array(z.string()).default([]),
  target_date: z.string().datetime().nullable().optional(),
  completed_at: z.string().datetime().nullable().optional(),
  conversation_count: z.number().int().nonnegative().default(0),
  last_discussed_at: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
})

export type Goal = z.infer<typeof GoalSchema>

// ============ Conversation Digest ============

export const ConversationDigestDecisionSchema = z.object({
  description: z.string().min(1),
  message_id: UlidSchema,
  confidence: z.number().min(0).max(1),
})

export type ConversationDigestDecision = z.infer<typeof ConversationDigestDecisionSchema>

export const ConversationDigestSchema = z.object({
  id: UlidSchema,
  conversation_id: UlidSchema,
  summary: z.string().min(1),
  decisions: z.array(ConversationDigestDecisionSchema).default([]),
  outcome: z.enum(['resolved', 'ongoing', 'blocked', 'abandoned']).nullable().optional(),
  processor_version: z.string().min(1),
  model_version: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
})

export type ConversationDigest = z.infer<typeof ConversationDigestSchema>

// ============ Entity Mention ============

export const EntityMentionSchema = z.object({
  id: UlidSchema,
  conversation_id: UlidSchema,
  entity_type: MemoryEntityTypeSchema,
  entity_id: UlidSchema.nullable().optional(),
  surface_form: z.string().min(1),
  message_ids: z.array(UlidSchema).default([]),
  confidence: z.number().min(0).max(1),
  embedding: z.array(z.number()).optional(),
  created_at: z.string().datetime(),
})

export type EntityMention = z.infer<typeof EntityMentionSchema>
