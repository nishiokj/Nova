/**
 * GitHub API Response Schemas
 *
 * Zod schemas for validating GitHub API responses.
 * Based on GitHub REST API v3.
 *
 * @module connectors/github/schemas
 */

import { z } from 'zod'

// ============ Common Types ============

/**
 * GitHub User (minimal representation)
 */
export const GitHubUserSchema = z.object({
  id: z.number(),
  login: z.string(),
  node_id: z.string().optional(),
  avatar_url: z.string().url(),
  html_url: z.string().url(),
  type: z.enum(['User', 'Organization', 'Bot']),
  name: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  bio: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  blog: z.string().nullable().optional(),
  twitter_username: z.string().nullable().optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
})

export type GitHubUser = z.infer<typeof GitHubUserSchema>

/**
 * GitHub User (full representation from /user endpoint)
 */
export const GitHubAuthenticatedUserSchema = GitHubUserSchema.extend({
  email: z.string().email().nullable(),
  name: z.string().nullable(),
  two_factor_authentication: z.boolean().optional(),
  plan: z.object({
    name: z.string(),
    space: z.number(),
    private_repos: z.number(),
    collaborators: z.number(),
  }).optional(),
})

export type GitHubAuthenticatedUser = z.infer<typeof GitHubAuthenticatedUserSchema>

// ============ Repository ============

/**
 * GitHub Repository (partial)
 */
export const GitHubRepoSchema = z.object({
  id: z.number(),
  node_id: z.string().optional(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  owner: GitHubUserSchema.pick({
    id: true,
    login: true,
    avatar_url: true,
    html_url: true,
    type: true,
  }),
  html_url: z.string().url(),
  description: z.string().nullable(),
  fork: z.boolean(),
  url: z.string().url(),
  created_at: z.string(),
  updated_at: z.string(),
  pushed_at: z.string().nullable(),
  default_branch: z.string(),
  archived: z.boolean().optional(),
  disabled: z.boolean().optional(),
  visibility: z.string().optional(),
  language: z.string().nullable().optional(),
  topics: z.array(z.string()).optional(),
})

export type GitHubRepo = z.infer<typeof GitHubRepoSchema>

// ============ Issues ============

/**
 * GitHub Label
 */
export const GitHubLabelSchema = z.object({
  id: z.number(),
  node_id: z.string().optional(),
  name: z.string(),
  color: z.string(),
  description: z.string().nullable().optional(),
})

export type GitHubLabel = z.infer<typeof GitHubLabelSchema>

/**
 * GitHub Milestone
 */
export const GitHubMilestoneSchema = z.object({
  id: z.number(),
  node_id: z.string().optional(),
  number: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  due_on: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  closed_at: z.string().datetime().nullable(),
})

export type GitHubMilestone = z.infer<typeof GitHubMilestoneSchema>

/**
 * GitHub Issue
 */
export const GitHubIssueSchema = z.object({
  id: z.number(),
  node_id: z.string().optional(),
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  state_reason: z.enum(['completed', 'reopened', 'not_planned']).nullable().optional(),
  locked: z.boolean(),
  user: GitHubUserSchema.pick({
    id: true,
    login: true,
    avatar_url: true,
    html_url: true,
    type: true,
  }).nullable(),
  labels: z.array(GitHubLabelSchema),
  assignee: GitHubUserSchema.pick({
    id: true,
    login: true,
    avatar_url: true,
    html_url: true,
    type: true,
  }).nullable(),
  assignees: z.array(GitHubUserSchema.pick({
    id: true,
    login: true,
    avatar_url: true,
    html_url: true,
    type: true,
  })).optional(),
  milestone: GitHubMilestoneSchema.nullable().optional(),
  comments: z.number(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  closed_at: z.string().datetime().nullable(),
  html_url: z.string().url(),
  repository_url: z.string().url().optional(),
  // Pull requests have this field
  pull_request: z.object({
    url: z.string().url(),
    html_url: z.string().url(),
    diff_url: z.string().url(),
    patch_url: z.string().url(),
    merged_at: z.string().datetime().nullable().optional(),
  }).optional(),
})

export type GitHubIssue = z.infer<typeof GitHubIssueSchema>

// ============ Pull Requests ============

/**
 * GitHub Pull Request (extends issue with PR-specific fields)
 */
export const GitHubPullRequestSchema = GitHubIssueSchema.omit({ pull_request: true }).extend({
  merged: z.boolean().optional(),
  mergeable: z.boolean().nullable().optional(),
  merged_at: z.string().datetime().nullable().optional(),
  merged_by: GitHubUserSchema.pick({
    id: true,
    login: true,
    avatar_url: true,
    html_url: true,
    type: true,
  }).nullable().optional(),
  draft: z.boolean().optional(),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: GitHubRepoSchema.pick({
      id: true,
      name: true,
      full_name: true,
      owner: true,
    }).nullable(),
  }),
  base: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: GitHubRepoSchema.pick({
      id: true,
      name: true,
      full_name: true,
      owner: true,
    }).nullable(),
  }),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  changed_files: z.number().optional(),
  commits: z.number().optional(),
  review_comments: z.number().optional(),
})

export type GitHubPullRequest = z.infer<typeof GitHubPullRequestSchema>

// ============ Comments ============

/**
 * GitHub Issue/PR Comment
 */
export const GitHubCommentSchema = z.object({
  id: z.number(),
  node_id: z.string().optional(),
  html_url: z.string().url(),
  body: z.string(),
  user: GitHubUserSchema.pick({
    id: true,
    login: true,
    avatar_url: true,
    html_url: true,
    type: true,
  }).nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  issue_url: z.string().url().optional(),
  // For review comments
  pull_request_review_id: z.number().optional(),
  path: z.string().optional(),
  position: z.number().nullable().optional(),
  line: z.number().nullable().optional(),
  commit_id: z.string().optional(),
})

export type GitHubComment = z.infer<typeof GitHubCommentSchema>

// ============ Notifications ============

/**
 * GitHub Notification Subject
 */
export const GitHubNotificationSubjectSchema = z.object({
  title: z.string(),
  url: z.string().url().nullable(),
  latest_comment_url: z.string().url().nullable(),
  type: z.enum(['Issue', 'PullRequest', 'Commit', 'Release', 'Discussion', 'CheckSuite', 'RepositoryVulnerabilityAlert']),
})

export type GitHubNotificationSubject = z.infer<typeof GitHubNotificationSubjectSchema>

/**
 * GitHub Notification
 */
export const GitHubNotificationSchema = z.object({
  id: z.string(),
  unread: z.boolean(),
  reason: z.enum([
    'assign', 'author', 'comment', 'ci_activity', 'invitation',
    'manual', 'mention', 'review_requested', 'security_alert',
    'state_change', 'subscribed', 'team_mention',
  ]),
  updated_at: z.string().datetime(),
  last_read_at: z.string().datetime().nullable(),
  subject: GitHubNotificationSubjectSchema,
  repository: GitHubRepoSchema.pick({
    id: true,
    name: true,
    full_name: true,
    owner: true,
    html_url: true,
    private: true,
    description: true,
  }),
  url: z.string().url(),
  subscription_url: z.string().url(),
})

export type GitHubNotification = z.infer<typeof GitHubNotificationSchema>

// ============ Webhook Events ============

/**
 * GitHub Webhook Issue Event
 */
export const GitHubIssueEventSchema = z.object({
  action: z.enum(['opened', 'edited', 'deleted', 'pinned', 'unpinned', 'closed', 'reopened', 'assigned', 'unassigned', 'labeled', 'unlabeled', 'locked', 'unlocked', 'transferred', 'milestoned', 'demilestoned']),
  issue: GitHubIssueSchema,
  repository: GitHubRepoSchema,
  sender: GitHubUserSchema.pick({
    id: true,
    login: true,
    avatar_url: true,
    html_url: true,
    type: true,
  }),
})

export type GitHubIssueEvent = z.infer<typeof GitHubIssueEventSchema>

/**
 * GitHub Webhook Pull Request Event
 */
export const GitHubPullRequestEventSchema = z.object({
  action: z.enum(['opened', 'edited', 'closed', 'reopened', 'assigned', 'unassigned', 'review_requested', 'review_request_removed', 'labeled', 'unlabeled', 'synchronize', 'ready_for_review', 'converted_to_draft', 'locked', 'unlocked']),
  number: z.number(),
  pull_request: GitHubPullRequestSchema,
  repository: GitHubRepoSchema,
  sender: GitHubUserSchema.pick({
    id: true,
    login: true,
    avatar_url: true,
    html_url: true,
    type: true,
  }),
})

export type GitHubPullRequestEvent = z.infer<typeof GitHubPullRequestEventSchema>

/**
 * GitHub Webhook Comment Event
 */
export const GitHubIssueCommentEventSchema = z.object({
  action: z.enum(['created', 'edited', 'deleted']),
  issue: GitHubIssueSchema,
  comment: GitHubCommentSchema,
  repository: GitHubRepoSchema,
  sender: GitHubUserSchema.pick({
    id: true,
    login: true,
    avatar_url: true,
    html_url: true,
    type: true,
  }),
})

export type GitHubIssueCommentEvent = z.infer<typeof GitHubIssueCommentEventSchema>
