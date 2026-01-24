/**
 * Coding Agent Session Connectors
 *
 * Connectors for ingesting session data from various coding agents.
 *
 * @module connectors/coding-sessions
 */

// Base
export { CodingAgentSessionConnector } from './base.js'

// Types
export {
  type CodingAgentSessionConfig,
  type SessionFile,
  type BackfillCursor,
  type IncrementalCursor,
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
} from './types.js'

// Claude Connector
export {
  ClaudeSessionConnector,
  createClaudeSessionConnector,
  type ClaudeSessionConnectorConfig,
  // Schemas
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
} from './claude.js'

// Rex Connector
export {
  RexSessionConnector,
  createRexSessionConnector,
  type RexSessionConnectorConfig,
  // Schemas
  RexUserMessageSchema,
  RexAssistantMessageSchema,
  RexSummaryMessageSchema,
  RexSessionMessageSchema,
  type RexUserMessage,
  type RexAssistantMessage,
  type RexSummaryMessage,
  type RexSessionMessage,
} from './rex.js'
