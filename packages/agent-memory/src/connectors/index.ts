/**
 * Connectors Module
 *
 * Connector implementations for external services.
 *
 * @module connectors
 */

// Connector Factory Registry (static lookup)
export {
  CONNECTOR_FACTORIES,
  getFactory,
  listFactoryTypes,
  hasFactory,
  createConnector,
  type ConnectorFactory,
  type ConnectorFactoryEntry,
  type LoadConnectorsResult,
} from './registry.js'

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
  type RequestState,
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

// iMessage Connector (macOS local)
export {
  // Connector
  IMessageConnector,
  createIMessageConnector,
  type IMessageConnectorConfig,
  // Schemas
  HandleRowSchema,
  ChatRowSchema,
  MessageRowSchema,
  AttachmentRowSchema,
  EnrichedMessageSchema,
  EnrichedChatSchema,
  IMessageSourceSchema,
  IChatSourceSchema,
  type HandleRow,
  type ChatRow,
  type MessageRow,
  type AttachmentRow,
  type EnrichedMessage,
  type EnrichedChat,
  type IMessageSource,
  type IChatSource,
  // Utilities
  macosTimestampToDate,
  macosTimestampToISOString,
  MACOS_EPOCH_OFFSET,
  // Transformations
  imessageMessageTransform,
  imessageChatTransform,
  imessageTransforms,
} from './imessage/index.js'

// Google Calendar Connector
export {
  // Connector
  GoogleCalendarConnector,
  createGoogleCalendarConnector,
  type GoogleCalendarConnectorConfig,
  // Schemas
  GoogleCalendarEventSchema,
  GoogleCalendarEventListSchema,
  GoogleCalendarListSchema,
  GoogleCalendarEntrySchema,
  GoogleCalendarAttendeeSchema,
  GoogleCalendarOrganizerSchema,
  GoogleCalendarDateTimeSchema,
  GoogleCalendarReminderSchema,
  GoogleCalendarNotificationSchema,
  GoogleCalendarConferenceDataSchema,
  type GoogleCalendarEvent,
  type GoogleCalendarEventList,
  type GoogleCalendarList,
  type GoogleCalendarEntry,
  type GoogleCalendarAttendee,
  type GoogleCalendarOrganizer,
  type GoogleCalendarDateTime,
  type GoogleCalendarReminder,
  type GoogleCalendarNotification,
  type GoogleCalendarConferenceData,
  // Transformations
  googleCalendarTransforms,
  googleCalendarEventTransform,
} from './google-calendar/index.js'

// Obsidian Connector
export {
  // Connector
  ObsidianConnector,
  createObsidianConnector,
  type ObsidianConnectorConfig,
  // Schemas
  ObsidianNoteRowSchema,
  ObsidianParsedNoteSchema,
  ObsidianVaultSchema,
  ObsidianNoteSourceSchema,
  type ObsidianNoteRow,
  type ObsidianParsedNote,
  type ObsidianVault,
  type ObsidianNoteSource,
  // Utilities
  unixTimestampToISOString,
  extractTitle,
  extractTags,
  extractInternalLinks,
  extractExternalLinks,
  extractHeadings,
  extractExcerpt,
  parseFrontmatter,
  countWords,
  countCharacters,
  // Transformations
  obsidianNoteTransform,
  obsidianTransforms,
} from './obsidian/index.js'

// Watcher Sessions Connector
export {
  // Connector
  WatcherSessionsConnector,
  createWatcherSessionsConnector,
  type WatcherSessionsConnectorConfig,
  // Schemas
  ExecutionMetricsSchema,
  QualityGateSchema,
  DecisionEntrySchema,
  WorkLogEntrySchema,
  WatcherDecisionSourceSchema,
  WatcherWorkLogSourceSchema,
  type ExecutionMetrics,
  type QualityGate,
  type DecisionEntry,
  type WorkLogEntry,
  type WatcherDecisionSource,
  type WatcherWorkLogSource,
  // Transformations (empty - uses derived task)
  watcherSessionsTransforms,
} from './watcher-sessions/index.js'
