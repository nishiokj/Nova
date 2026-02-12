/**
 * GitHub Connector Tests
 */

import { z } from 'zod'
import { generateCanonicalId } from 'agent-memory/ids.js'
import type { SourceItem } from 'agent-memory/sync/types.js'
import {
  // Schemas
  GitHubUserSchema,
  GitHubIssueSchema,
  GitHubPullRequestSchema,
  GitHubCommentSchema,
  GitHubNotificationSchema,
  GitHubLabelSchema,
  GitHubMilestoneSchema,
  GitHubRepoSchema,
  GitHubIssueEventSchema,
  GitHubPullRequestEventSchema,
  GitHubIssueCommentEventSchema,
  type GitHubUser,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubComment,
  type GitHubNotification,
} from 'agent-memory/connectors/github/schemas.js'
import {
  GitHubConnector,
  createGitHubConnector,
  type GitHubConnectorConfig,
} from 'agent-memory/connectors/github/index.js'
import { noopLogger } from 'agent-memory/connector/sdk/connector.js'

// ============ Test Fixtures ============

const mockUser: GitHubUser = {
  id: 12345,
  login: 'testuser',
  node_id: 'MDQ6VXNlcjEyMzQ1',
  avatar_url: 'https://avatars.githubusercontent.com/u/12345',
  html_url: 'https://github.com/testuser',
  type: 'User',
  name: 'Test User',
  email: 'test@example.com',
  bio: 'Software developer',
  company: 'Test Corp',
  created_at: '2020-01-01T00:00:00Z',
  updated_at: '2024-01-15T10:30:00Z',
}

const mockLabel = {
  id: 1,
  name: 'bug',
  color: 'd73a4a',
  description: 'Something is not working',
}

const mockRepo = {
  id: 123456,
  node_id: 'R_123',
  name: 'repo',
  full_name: 'owner/repo',
  private: false,
  owner: {
    id: mockUser.id,
    login: mockUser.login,
    avatar_url: mockUser.avatar_url,
    html_url: mockUser.html_url,
    type: mockUser.type,
  },
  html_url: 'https://github.com/owner/repo',
  description: 'Test repository',
  fork: false,
  url: 'https://api.github.com/repos/owner/repo',
  created_at: '2020-01-01T00:00:00Z',
  updated_at: '2024-01-15T10:00:00Z',
  pushed_at: '2024-01-15T09:00:00Z',
  default_branch: 'main',
}

const mockIssue: GitHubIssue = {
  id: 67890,
  node_id: 'I_123',
  number: 42,
  title: 'Test Issue',
  body: 'This is a test issue description',
  state: 'open',
  locked: false,
  user: {
    id: mockUser.id,
    login: mockUser.login,
    avatar_url: mockUser.avatar_url,
    html_url: mockUser.html_url,
    type: mockUser.type,
  },
  labels: [mockLabel],
  assignee: null,
  assignees: [],
  milestone: null,
  comments: 5,
  created_at: '2024-01-10T12:00:00Z',
  updated_at: '2024-01-15T14:30:00Z',
  closed_at: null,
  html_url: 'https://github.com/owner/repo/issues/42',
  repository_url: 'https://api.github.com/repos/owner/repo',
}

const mockClosedIssue: GitHubIssue = {
  ...mockIssue,
  id: 67891,
  number: 43,
  state: 'closed',
  state_reason: 'completed',
  closed_at: '2024-01-14T10:00:00Z',
}

const mockPullRequest: GitHubPullRequest = {
  ...mockIssue,
  id: 99999,
  number: 100,
  title: 'Test PR',
  body: 'This is a test pull request',
  html_url: 'https://github.com/owner/repo/pull/100',
  merged: false,
  draft: false,
  head: {
    ref: 'feature-branch',
    sha: 'abc123',
    repo: {
      id: 1,
      name: 'repo',
      full_name: 'owner/repo',
      owner: {
        id: mockUser.id,
        login: mockUser.login,
        avatar_url: mockUser.avatar_url,
        html_url: mockUser.html_url,
        type: mockUser.type,
      },
    },
  },
  base: {
    ref: 'main',
    sha: 'def456',
    repo: {
      id: 1,
      name: 'repo',
      full_name: 'owner/repo',
      owner: {
        id: mockUser.id,
        login: mockUser.login,
        avatar_url: mockUser.avatar_url,
        html_url: mockUser.html_url,
        type: mockUser.type,
      },
    },
  },
  additions: 50,
  deletions: 20,
  changed_files: 3,
}

const mockComment: GitHubComment = {
  id: 11111,
  node_id: 'IC_123',
  html_url: 'https://github.com/owner/repo/issues/42#issuecomment-11111',
  body: 'This is a test comment on the issue.',
  user: {
    id: mockUser.id,
    login: mockUser.login,
    avatar_url: mockUser.avatar_url,
    html_url: mockUser.html_url,
    type: mockUser.type,
  },
  created_at: '2024-01-11T08:00:00Z',
  updated_at: '2024-01-11T08:00:00Z',
  issue_url: 'https://api.github.com/repos/owner/repo/issues/42',
}

const mockNotification: GitHubNotification = {
  id: '22222',
  unread: true,
  reason: 'mention',
  updated_at: '2024-01-15T09:00:00Z',
  last_read_at: null,
  subject: {
    title: 'Test Issue',
    url: 'https://api.github.com/repos/owner/repo/issues/42',
    latest_comment_url: 'https://api.github.com/repos/owner/repo/issues/comments/11111',
    type: 'Issue',
  },
  repository: {
    id: 1,
    name: 'repo',
    full_name: 'owner/repo',
    owner: {
      id: mockUser.id,
      login: mockUser.login,
      avatar_url: mockUser.avatar_url,
      html_url: mockUser.html_url,
      type: mockUser.type,
    },
    html_url: 'https://github.com/owner/repo',
    private: false,
    description: 'Test repository',
  },
  url: 'https://api.github.com/notifications/threads/22222',
  subscription_url: 'https://api.github.com/notifications/threads/22222/subscription',
}

// ============ Schema Tests ============

describe('GitHub Schemas', () => {
  describe('GitHubUserSchema', () => {
    it('should validate a valid user', () => {
      const result = GitHubUserSchema.safeParse(mockUser)
      expect(result.success).toBe(true)
    })

    it('should reject invalid user', () => {
      const result = GitHubUserSchema.safeParse({ invalid: true })
      expect(result.success).toBe(false)
    })

    it('should handle minimal user representation', () => {
      const minimal = {
        id: 1,
        login: 'user',
        avatar_url: 'https://example.com/avatar.png',
        html_url: 'https://github.com/user',
        type: 'User',
      }
      const result = GitHubUserSchema.safeParse(minimal)
      expect(result.success).toBe(true)
    })
  })

  describe('GitHubIssueSchema', () => {
    it('should validate a valid issue', () => {
      const result = GitHubIssueSchema.safeParse(mockIssue)
      expect(result.success).toBe(true)
    })

    it('should validate a closed issue with state_reason', () => {
      const result = GitHubIssueSchema.safeParse(mockClosedIssue)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.state_reason).toBe('completed')
      }
    })

    it('should validate an issue with pull_request field', () => {
      const issueWithPr = {
        ...mockIssue,
        pull_request: {
          url: 'https://api.github.com/repos/owner/repo/pulls/42',
          html_url: 'https://github.com/owner/repo/pull/42',
          diff_url: 'https://github.com/owner/repo/pull/42.diff',
          patch_url: 'https://github.com/owner/repo/pull/42.patch',
        },
      }
      const result = GitHubIssueSchema.safeParse(issueWithPr)
      expect(result.success).toBe(true)
    })
  })

  describe('GitHubPullRequestSchema', () => {
    it('should validate a valid pull request', () => {
      const result = GitHubPullRequestSchema.safeParse(mockPullRequest)
      expect(result.success).toBe(true)
    })

    it('should validate a merged pull request', () => {
      const merged = {
        ...mockPullRequest,
        merged: true,
        merged_at: '2024-01-15T12:00:00Z',
        state: 'closed',
      }
      const result = GitHubPullRequestSchema.safeParse(merged)
      expect(result.success).toBe(true)
    })

    it('should validate a draft pull request', () => {
      const draft = {
        ...mockPullRequest,
        draft: true,
      }
      const result = GitHubPullRequestSchema.safeParse(draft)
      expect(result.success).toBe(true)
    })
  })

  describe('GitHubCommentSchema', () => {
    it('should validate a valid comment', () => {
      const result = GitHubCommentSchema.safeParse(mockComment)
      expect(result.success).toBe(true)
    })

    it('should validate a review comment', () => {
      const reviewComment = {
        ...mockComment,
        pull_request_review_id: 12345,
        path: 'src/index.ts',
        line: 42,
        commit_id: 'abc123def456',
      }
      const result = GitHubCommentSchema.safeParse(reviewComment)
      expect(result.success).toBe(true)
    })
  })

  describe('GitHubNotificationSchema', () => {
    it('should validate a valid notification', () => {
      const result = GitHubNotificationSchema.safeParse(mockNotification)
      expect(result.success).toBe(true)
    })

    it('should validate different notification reasons', () => {
      const reasons = ['assign', 'author', 'comment', 'mention', 'review_requested']
      for (const reason of reasons) {
        const notification = { ...mockNotification, reason }
        const result = GitHubNotificationSchema.safeParse(notification)
        expect(result.success).toBe(true)
      }
    })
  })

  describe('Webhook Event Schemas', () => {
    it('should validate issue event', () => {
      const event = {
        action: 'opened',
        issue: mockIssue,
        repository: mockRepo,
        sender: {
          id: mockUser.id,
          login: mockUser.login,
          avatar_url: mockUser.avatar_url,
          html_url: mockUser.html_url,
          type: mockUser.type,
        },
      }
      const result = GitHubIssueEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should validate pull request event', () => {
      const event = {
        action: 'opened',
        number: 100,
        pull_request: mockPullRequest,
        repository: mockRepo,
        sender: {
          id: mockUser.id,
          login: mockUser.login,
          avatar_url: mockUser.avatar_url,
          html_url: mockUser.html_url,
          type: mockUser.type,
        },
      }
      const result = GitHubPullRequestEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should validate issue comment event', () => {
      const event = {
        action: 'created',
        issue: mockIssue,
        comment: mockComment,
        repository: mockRepo,
        sender: {
          id: mockUser.id,
          login: mockUser.login,
          avatar_url: mockUser.avatar_url,
          html_url: mockUser.html_url,
          type: mockUser.type,
        },
      }
      const result = GitHubIssueCommentEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })
  })
})

// ============ Connector Tests ============

describe('GitHubConnector', () => {
  let connector: GitHubConnector

  beforeEach(() => {
    connector = createGitHubConnector({}, { logger: noopLogger })
  })

  describe('constructor', () => {
    it('should create connector with correct type', () => {
      expect(connector.type).toBe('github')
      expect(connector.displayName).toBe('GitHub')
    })

    it('should have correct capabilities', () => {
      expect(connector.capabilities.supportsBackfill).toBe(true)
      expect(connector.capabilities.supportsIncrementalSync).toBe(true)
      expect(connector.capabilities.supportsWebhook).toBe(true)
      expect(connector.capabilities.supportsWrite).toBe(true)
    })

    it('should support all entity types', () => {
      expect(connector.capabilities.supportedEntityTypes).toContain('user')
      expect(connector.capabilities.supportedEntityTypes).toContain('issue')
      expect(connector.capabilities.supportedEntityTypes).toContain('pull_request')
      expect(connector.capabilities.supportedEntityTypes).toContain('comment')
      expect(connector.capabilities.supportedEntityTypes).toContain('notification')
    })

    it('should use OAuth provider auth config', () => {
      expect(connector.authConfig.type).toBe('oauth2_provider')
      expect((connector.authConfig as any).provider).toBe('github')
    })

    it('should accept custom API base URL', () => {
      const enterpriseConfig: GitHubConnectorConfig = {
        apiBaseUrl: 'https://github.mycompany.com/api/v3',
      }
      const enterpriseConnector = createGitHubConnector(enterpriseConfig, { logger: noopLogger })
      expect(enterpriseConnector).toBeDefined()
    })

  })

  describe('getAuthorizationUrl', () => {
    it('should throw because OAuth URLs are handled by the provider registry', () => {
      const state = 'random-state-123'
      const redirectUri = 'https://myapp.com/callback'

      expect(() => connector.getAuthorizationUrl(state, redirectUri)).toThrow(
        'github connector does not support OAuth2'
      )
    })
  })

  describe('getSourceSchema', () => {
    it('should return schema for known entity types', () => {
      expect(connector.getSourceSchema('user')).toBeDefined()
      expect(connector.getSourceSchema('issue')).toBeDefined()
      expect(connector.getSourceSchema('pull_request')).toBeDefined()
      expect(connector.getSourceSchema('comment')).toBeDefined()
      expect(connector.getSourceSchema('notification')).toBeDefined()
    })

    it('should return undefined for unknown entity type', () => {
      expect(connector.getSourceSchema('unknown')).toBeUndefined()
    })
  })

  describe('hasCapability', () => {
    it('should return true for supported capabilities', () => {
      expect(connector.hasCapability('supportsBackfill')).toBe(true)
      expect(connector.hasCapability('supportsIncrementalSync')).toBe(true)
      expect(connector.hasCapability('supportsWebhook')).toBe(true)
      expect(connector.hasCapability('supportsWrite')).toBe(true)
    })
  })

  describe('supportsEntityType', () => {
    it('should return true for supported entity types', () => {
      expect(connector.supportsEntityType('user')).toBe(true)
      expect(connector.supportsEntityType('issue')).toBe(true)
    })

    it('should return false for unsupported entity types', () => {
      expect(connector.supportsEntityType('unknown')).toBe(false)
    })
  })

  describe('parseWebhookPayload', () => {
    it('should parse issue webhook event', async () => {
      const event = {
        eventType: 'issues',
        payload: {
          action: 'opened',
          issue: mockIssue,
          repository: mockRepo,
          sender: {
            id: mockUser.id,
            login: mockUser.login,
            avatar_url: mockUser.avatar_url,
            html_url: mockUser.html_url,
            type: mockUser.type,
          },
        },
        headers: { 'x-github-event': 'issues' },
        receivedAt: new Date(),
      }

      const items = await connector.parseWebhookPayload(event)

      expect(items).toHaveLength(1)
      expect(items[0].entity_type).toBe('issue')
      expect(items[0].source_id).toBe(String(mockIssue.id))
    })

    it('should parse pull request webhook event', async () => {
      const event = {
        eventType: 'pull_request',
        payload: {
          action: 'opened',
          number: 100,
          pull_request: mockPullRequest,
          repository: mockRepo,
          sender: {
            id: mockUser.id,
            login: mockUser.login,
            avatar_url: mockUser.avatar_url,
            html_url: mockUser.html_url,
            type: mockUser.type,
          },
        },
        headers: { 'x-github-event': 'pull_request' },
        receivedAt: new Date(),
      }

      const items = await connector.parseWebhookPayload(event)

      expect(items).toHaveLength(1)
      expect(items[0].entity_type).toBe('pull_request')
    })

    it('should parse issue comment webhook event', async () => {
      const event = {
        eventType: 'issue_comment',
        payload: {
          action: 'created',
          issue: mockIssue,
          comment: mockComment,
          repository: mockRepo,
          sender: {
            id: mockUser.id,
            login: mockUser.login,
            avatar_url: mockUser.avatar_url,
            html_url: mockUser.html_url,
            type: mockUser.type,
          },
        },
        headers: { 'x-github-event': 'issue_comment' },
        receivedAt: new Date(),
      }

      const items = await connector.parseWebhookPayload(event)

      expect(items).toHaveLength(1)
      expect(items[0].entity_type).toBe('comment')
    })

    it('should return empty array for unknown event type', async () => {
      const event = {
        eventType: 'unknown_event',
        payload: {},
        headers: { 'x-github-event': 'unknown_event' },
        receivedAt: new Date(),
      }

      const items = await connector.parseWebhookPayload(event)
      expect(items).toHaveLength(0)
    })
  })

  describe('verifyWebhookSignature', () => {
    it('should verify valid signature', async () => {
      const secret = 'test-secret'
      const payload = JSON.stringify({ test: 'data' })

      // Compute expected signature
      const crypto = await import('crypto')
      const expectedSignature = 'sha256=' + crypto.createHmac('sha256', secret)
        .update(payload)
        .digest('hex')

      const event = {
        eventType: 'issues',
        payload,
        headers: { 'x-hub-signature-256': expectedSignature },
        receivedAt: new Date(),
      }

      const result = await connector.verifyWebhookSignature(event, secret)
      expect(result.valid).toBe(true)
    })

    it('should reject invalid signature', async () => {
      const event = {
        eventType: 'issues',
        payload: { test: 'data' },
        headers: { 'x-hub-signature-256': 'sha256=invalid' },
        receivedAt: new Date(),
      }

      const result = await connector.verifyWebhookSignature(event, 'secret')
      expect(result.valid).toBe(false)
    })

    it('should reject missing signature', async () => {
      const event = {
        eventType: 'issues',
        payload: { test: 'data' },
        headers: {},
        receivedAt: new Date(),
      }

      const result = await connector.verifyWebhookSignature(event, 'secret')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('No')
    })
  })
})

// ============ Factory Tests ============

describe('createGitHubConnector', () => {
  it('should create a GitHubConnector instance', () => {
    const connector = createGitHubConnector({}, { logger: noopLogger })

    expect(connector).toBeInstanceOf(GitHubConnector)
    expect(connector.type).toBe('github')
  })
})
