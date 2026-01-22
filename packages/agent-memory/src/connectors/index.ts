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
