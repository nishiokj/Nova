/**
 * Connectors Module
 *
 * Connector implementations for external services.
 *
 * @module connectors
 */

// GitHub Connector
export {
  // Connector
  GitHubConnector,
  createGitHubConnector,
  type GitHubConnectorConfig,
  // Schemas
  GitHubUserSchema,
  GitHubAuthenticatedUserSchema,
  GitHubRepoSchema,
  GitHubLabelSchema,
  GitHubMilestoneSchema,
  GitHubIssueSchema,
  GitHubPullRequestSchema,
  GitHubCommentSchema,
  GitHubNotificationSchema,
  GitHubNotificationSubjectSchema,
  GitHubIssueEventSchema,
  GitHubPullRequestEventSchema,
  GitHubIssueCommentEventSchema,
  type GitHubUser,
  type GitHubAuthenticatedUser,
  type GitHubRepo,
  type GitHubLabel,
  type GitHubMilestone,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubComment,
  type GitHubNotification,
  type GitHubNotificationSubject,
  type GitHubIssueEvent,
  type GitHubPullRequestEvent,
  type GitHubIssueCommentEvent,
  // Transformations
  githubTransforms,
  userTransform,
  issueTransform,
  pullRequestTransform,
  commentTransform,
  notificationTransform,
} from './github/index.js'

// Gmail Connector
export {
  // Connector
  GmailConnector,
  createGmailConnector,
  type GmailConnectorConfig,
  // Schemas
  GmailMessageSchema,
  GmailMessageHeaderSchema,
  GmailMessagePartSchema,
  GmailMessageListSchema,
  GmailThreadSchema,
  GmailHistoryRecordSchema,
  GmailHistoryResponseSchema,
  GmailProfileSchema,
  GmailNotificationSchema,
  PubSubPushEnvelopeSchema,
  type GmailMessage,
  type GmailMessageHeader,
  type GmailMessagePart,
  type GmailMessageList,
  type GmailThread,
  type GmailHistoryRecord,
  type GmailHistoryResponse,
  type GmailProfile,
  type GmailNotification,
  type PubSubPushEnvelope,
  // Transformations
  gmailTransforms,
  gmailMessageTransform,
  gmailThreadTransform,
} from './gmail/index.js'

// Telegram Connector (real-time harness bridge)
export {
  TelegramConnector,
  createTelegramConnector,
  type TelegramConnectorConfig,
  type TelegramUpdate,
  type TelegramMessage,
  type TelegramUser,
  type TelegramChat,
  type PendingRequest,
  type ChatSession,
} from './telegram/index.js'

// Coding Agent Session Connectors
export {
  // Base
  CodingAgentSessionConnector,
  type CodingAgentSessionConfig,
  type SessionFile,
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
  // Claude Connector
  ClaudeSessionConnector,
  createClaudeSessionConnector,
  type ClaudeSessionConnectorConfig,
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
  // Rex Connector
  RexSessionConnector,
  createRexSessionConnector,
  type RexSessionConnectorConfig,
  RexUserMessageSchema,
  RexAssistantMessageSchema,
  RexSummaryMessageSchema,
  RexSessionMessageSchema,
  type RexUserMessage,
  type RexAssistantMessage,
  type RexSummaryMessage,
  type RexSessionMessage,
  // Transformations
  claudeSessionTransform,
  claudeMessageTransform,
  codingSessionTransforms,
} from './coding-sessions/index.js'
