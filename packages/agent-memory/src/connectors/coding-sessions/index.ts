/**
 * Coding Agent Session Connectors
 *
 * Connectors for ingesting session data from coding agents (Claude Code, Rex).
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
  // Rex schemas
  RexUserMessageSchema,
  RexAssistantMessageSchema,
  RexSummaryMessageSchema,
  RexSessionMessageSchema,
  type RexUserMessage,
  type RexAssistantMessage,
  type RexSummaryMessage,
  type RexSessionMessage,
} from './schemas.js'

// ============ Claude Connector ============

export {
  ClaudeSessionConnector,
  createClaudeSessionConnector,
  type ClaudeSessionConnectorConfig,
} from './claude.js'

// ============ Rex Connector ============

export {
  RexSessionConnector,
  createRexSessionConnector,
  type RexSessionConnectorConfig,
} from './rex.js'

// ============ Transformations ============

export {
  claudeSessionTransform,
  claudeMessageTransform,
  transforms as codingSessionTransforms,
} from './transforms.js'
