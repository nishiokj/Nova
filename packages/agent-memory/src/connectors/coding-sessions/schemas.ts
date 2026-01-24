/**
 * Coding Agent Session Schemas
 *
 * Zod schemas for validating coding agent session JSONL files.
 * Supports Claude Code and Rex session formats.
 *
 * @module connectors/coding-sessions/schemas
 */

import { z } from 'zod'

// ============ Shared Content Blocks ============

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

export const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
})

export const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
})

export const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
})

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
])

export type ContentBlock = z.infer<typeof ContentBlockSchema>

// ============ Shared Message Content ============

export const MessageContentSchema = z.union([
  z.string(),
  z.array(ContentBlockSchema),
])

export type MessageContent = z.infer<typeof MessageContentSchema>

// ============ Shared Usage Info ============

export const UsageInfoSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation: z.object({
    ephemeral_5m_input_tokens: z.number().optional(),
    ephemeral_1h_input_tokens: z.number().optional(),
  }).optional(),
  service_tier: z.string().optional(),
})

export type UsageInfo = z.infer<typeof UsageInfoSchema>

// ============ Shared Tool Use Result ============

export const ToolUseResultSchema = z.object({
  mode: z.string().optional(),
  numFiles: z.number().optional(),
  filenames: z.array(z.string()).optional(),
  content: z.string().optional(),
  numLines: z.number().optional(),
})

export type ToolUseResult = z.infer<typeof ToolUseResultSchema>

// ============ Shared Thinking Metadata ============

export const ThinkingMetadataSchema = z.object({
  level: z.string().optional(),
  disabled: z.boolean().optional(),
  triggers: z.array(z.unknown()).optional(),
})

export type ThinkingMetadata = z.infer<typeof ThinkingMetadataSchema>

// ============================================================================
// CLAUDE CODE SCHEMAS
// ============================================================================

const ClaudeBaseMessageSchema = z.object({
  uuid: z.string(),
  parentUuid: z.string().nullable().optional(),
  sessionId: z.string(),
  timestamp: z.string(),
  isSidechain: z.boolean().optional(),
  userType: z.string().optional(),
  cwd: z.string().optional(),
  version: z.string().optional(),
  gitBranch: z.string().optional(),
  slug: z.string().optional(),
})

export const ClaudeUserMessageSchema = ClaudeBaseMessageSchema.extend({
  type: z.literal('user'),
  message: z.object({
    role: z.literal('user'),
    content: MessageContentSchema,
  }),
  toolUseResult: ToolUseResultSchema.optional(),
  thinkingMetadata: ThinkingMetadataSchema.optional(),
  todos: z.array(z.unknown()).optional(),
  isMeta: z.boolean().optional(),
})

export const ClaudeAssistantMessageSchema = ClaudeBaseMessageSchema.extend({
  type: z.literal('assistant'),
  message: z.object({
    id: z.string().optional(),
    model: z.string().optional(),
    type: z.literal('message').optional(),
    role: z.literal('assistant'),
    content: MessageContentSchema,
    stop_reason: z.string().nullable().optional(),
    stop_sequence: z.string().nullable().optional(),
    usage: UsageInfoSchema.optional(),
  }),
  requestId: z.string().optional(),
})

export const ClaudeSummaryMessageSchema = z.object({
  type: z.literal('summary'),
  summary: z.string(),
  leafUuid: z.string(),
})

export const ClaudeFileHistorySnapshotSchema = z.object({
  type: z.literal('file-history-snapshot'),
  messageId: z.string(),
  snapshot: z.object({
    messageId: z.string(),
    trackedFileBackups: z.record(z.unknown()),
    timestamp: z.string(),
  }),
  isSnapshotUpdate: z.boolean().optional(),
})

export const ClaudeSessionMessageSchema = z.discriminatedUnion('type', [
  ClaudeUserMessageSchema,
  ClaudeAssistantMessageSchema,
  ClaudeSummaryMessageSchema,
  ClaudeFileHistorySnapshotSchema,
])

export type ClaudeUserMessage = z.infer<typeof ClaudeUserMessageSchema>
export type ClaudeAssistantMessage = z.infer<typeof ClaudeAssistantMessageSchema>
export type ClaudeSummaryMessage = z.infer<typeof ClaudeSummaryMessageSchema>
export type ClaudeFileHistorySnapshot = z.infer<typeof ClaudeFileHistorySnapshotSchema>
export type ClaudeSessionMessage = z.infer<typeof ClaudeSessionMessageSchema>

// ============================================================================
// REX SCHEMAS
// ============================================================================

const RexBaseMessageSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  timestamp: z.string(),
  parent_id: z.string().nullable().optional(),
})

export const RexUserMessageSchema = RexBaseMessageSchema.extend({
  type: z.literal('user'),
  content: MessageContentSchema,
})

export const RexAssistantMessageSchema = RexBaseMessageSchema.extend({
  type: z.literal('assistant'),
  content: MessageContentSchema,
  model: z.string().optional(),
  tokens: z.object({
    input: z.number().optional(),
    output: z.number().optional(),
  }).optional(),
})

export const RexSummaryMessageSchema = z.object({
  type: z.literal('summary'),
  session_id: z.string(),
  summary: z.string(),
  created_at: z.string(),
})

export const RexSessionMessageSchema = z.discriminatedUnion('type', [
  RexUserMessageSchema,
  RexAssistantMessageSchema,
  RexSummaryMessageSchema,
])

export type RexUserMessage = z.infer<typeof RexUserMessageSchema>
export type RexAssistantMessage = z.infer<typeof RexAssistantMessageSchema>
export type RexSummaryMessage = z.infer<typeof RexSummaryMessageSchema>
export type RexSessionMessage = z.infer<typeof RexSessionMessageSchema>
