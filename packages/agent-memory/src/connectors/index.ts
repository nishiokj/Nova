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
  // Mappers
  githubMappers,
  getGitHubMapper,
  getGitHubEntityTypes,
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
  // Mappers
  gmailMappers,
  getGmailMapper,
  getGmailEntityTypes,
} from './gmail/index.js'
