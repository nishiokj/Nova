/**
 * Coding Agent Session Connectors
 *
 * Connectors for ingesting session data from coding agents (Claude Code, Nova).
 *
 * @module connectors/coding-sessions
 */

// ============ Base ============

export {
  CodingAgentSessionConnector,
  type CodingAgentSessionConfig,
  type SessionFile,
} from './base.js'

// ============ Schemas ============

export {
  // Shared schemas
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ContentBlockSchema,
  MessageContentSchema,
  UsageInfoSchema,
  ToolUseResultSchema,
  ThinkingMetadataSchema,
  type ContentBlock,
  type MessageContent,
  type UsageInfo,
  type ToolUseResult,
  type ThinkingMetadata,
  // Claude schemas
  ClaudeUserMessageSchema,
  ClaudeAssistantMessageSchema,
  ClaudeSummaryMessageSchema,
  ClaudeFileHistorySnapshotSchema,
  ClaudeSessionMessageSchema,
  type ClaudeUserMessage,
  type ClaudeAssistantMessage,
  type ClaudeSummaryMessage,
  type ClaudeFileHistorySnapshot,
  type ClaudeSessionMessage,
  // Nova schemas
  NovaUserMessageSchema,
  NovaAssistantMessageSchema,
  NovaSummaryMessageSchema,
  NovaSessionMessageSchema,
  type NovaUserMessage,
  type NovaAssistantMessage,
  type NovaSummaryMessage,
  type NovaSessionMessage,
} from './schemas.js'

// ============ Claude Connector ============

export {
  ClaudeSessionConnector,
  createClaudeSessionConnector,
  type ClaudeSessionConnectorConfig,
} from './claude.js'

// ============ Nova Connector ============

export {
  NovaSessionConnector,
  createNovaSessionConnector,
  type NovaSessionConnectorConfig,
} from './nova.js'

// ============ Transformations ============

export {
  claudeSessionTransform,
  claudeMessageTransform,
  claudeSummaryTransform,
  transforms as codingSessionTransforms,
} from './transforms.js'
