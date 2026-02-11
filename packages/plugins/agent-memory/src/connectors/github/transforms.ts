/**
 * GitHub Transformations
 *
 * Transforms GitHub API responses into canonical entities using the new
 * Transformation interface (connect, collect, transform pattern).
 *
 * @module connectors/github/transforms
 */

import { generateCanonicalId, sourceRefToKey } from '../../ids.js'
import type { CanonicalSourceRef, Issue, Message, Notification } from '../../models/canonical.js'
import type { Transformation, TransformResult, TransformOutput, TransformContext } from '../../transform/types.js'
import {
  GitHubIssueSchema,
  GitHubPullRequestSchema,
  GitHubCommentSchema,
  GitHubNotificationSchema,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubComment,
  type GitHubNotification,
} from './schemas.js'

// ============ Helper Functions ============

/**
 * Create a source ref for a GitHub entity.
 */
function createSourceRef(
  accountId: string,
  entityType: string,
  sourceId: string,
  sourceVersion?: string
): CanonicalSourceRef {
  return {
    connector: 'github',
    account_id: accountId,
    entity_type: entityType,
    source_id: sourceId,
    source_version: sourceVersion,
    last_synced_at: new Date().toISOString(),
  }
}

/**
 * Create base entity fields.
 */
function createBaseEntity(id: string, sourceRef: CanonicalSourceRef) {
  const now = new Date().toISOString()
  return {
    id,
    created_at: now,
    updated_at: now,
    source_refs: [sourceRef],
  }
}

// ============ Issue Transformation ============

/**
 * Transforms GitHub Issue to canonical Issue.
 */
export const issueTransform: Transformation<GitHubIssue> = {
  id: 'github:issue:v1',
  name: 'GitHub Issue → Issue',
  source: {
    connector: 'github',
    entityType: 'issue',
  },
  inputSchema: GitHubIssueSchema,
  outputType: 'issue',
  transform(source: GitHubIssue, ctx: TransformContext): TransformResult {
    const sourceRef = createSourceRef(
      ctx.accountId,
      'issue',
      String(source.id),
      source.updated_at
    )

    // Determine status
    let status: Issue['status'] = 'open'
    if (source.state === 'closed') {
      status = source.state_reason === 'not_planned' ? 'cancelled' : 'closed'
    }

    const issue: Issue = {
      ...createBaseEntity(generateCanonicalId(), sourceRef),
      entity_type: 'issue',
      title: source.title,
      description: source.body ?? undefined,
      status,
      assignee_identity_ids: [],
      labels: source.labels.map(l => l.name),
      platform_url: source.html_url,
      due_at: source.milestone?.due_on ?? undefined,
      completed_at: source.closed_at ?? undefined,
      metadata: {
        github_number: source.number,
        github_comments: source.comments,
        github_locked: source.locked,
        github_milestone: source.milestone?.title,
      },
    }

    const primary: TransformOutput = {
      entityType: 'issue',
      data: issue,
      displayText: `#${source.number}: ${source.title}`,
      sourceRefKey: sourceRefToKey(sourceRef),
    }

    return {
      primary,
    }
  },
  onError: 'skip',
  enabled: true,
  version: 1,
}

// ============ Pull Request Transformation ============

/**
 * Transforms GitHub Pull Request to canonical Issue.
 */
export const pullRequestTransform: Transformation<GitHubPullRequest> = {
  id: 'github:pull_request:v1',
  name: 'GitHub Pull Request → Issue',
  source: {
    connector: 'github',
    entityType: 'pull_request',
  },
  inputSchema: GitHubPullRequestSchema,
  outputType: 'issue',
  transform(source: GitHubPullRequest, ctx: TransformContext): TransformResult {
    const sourceRef = createSourceRef(
      ctx.accountId,
      'pull_request',
      String(source.id),
      source.updated_at
    )

    // Determine status
    let status: Issue['status'] = 'open'
    if (source.merged) {
      status = 'closed'
    } else if (source.state === 'closed') {
      status = 'cancelled'
    } else if (source.draft) {
      status = 'in_progress'
    }

    const issue: Issue = {
      ...createBaseEntity(generateCanonicalId(), sourceRef),
      entity_type: 'issue',
      title: source.title,
      description: source.body ?? undefined,
      status,
      assignee_identity_ids: [],
      labels: source.labels.map(l => l.name),
      platform_url: source.html_url,
      completed_at: source.merged_at ?? source.closed_at ?? undefined,
      metadata: {
        github_number: source.number,
        github_pr: true,
        github_draft: source.draft,
        github_merged: source.merged,
        github_base_ref: source.base.ref,
        github_head_ref: source.head.ref,
        github_additions: source.additions,
        github_deletions: source.deletions,
        github_changed_files: source.changed_files,
      },
    }

    const primary: TransformOutput = {
      entityType: 'issue',
      data: issue,
      displayText: `PR #${source.number}: ${source.title}`,
      sourceRefKey: sourceRefToKey(sourceRef),
    }

    return {
      primary,
    }
  },
  onError: 'skip',
  enabled: true,
  version: 1,
}

// ============ Comment Transformation ============

/**
 * Transforms GitHub Comment to canonical Message.
 */
export const commentTransform: Transformation<GitHubComment> = {
  id: 'github:comment:v1',
  name: 'GitHub Comment → Message',
  source: {
    connector: 'github',
    entityType: 'comment',
  },
  inputSchema: GitHubCommentSchema,
  outputType: 'message',
  transform(source: GitHubComment, ctx: TransformContext): TransformResult {
    const sourceRef = createSourceRef(
      ctx.accountId,
      'comment',
      String(source.id),
      source.updated_at
    )

    const message: Message = {
      ...createBaseEntity(generateCanonicalId(), sourceRef),
      entity_type: 'message',
      body_text: source.body,
      sent_at: source.created_at,
      recipient_identity_ids: [],
      attachment_ids: [],
      labels: [],
      metadata: {
        github_html_url: source.html_url,
        github_issue_url: source.issue_url,
        github_review_id: source.pull_request_review_id,
        github_path: source.path,
        github_line: source.line,
      },
    }

    const primary: TransformOutput = {
      entityType: 'message',
      data: message,
      displayText: source.body.length > 100 ? source.body.substring(0, 100) + '...' : source.body,
      sourceRefKey: sourceRefToKey(sourceRef),
    }

    return {
      primary,
    }
  },
  onError: 'skip',
  enabled: true,
  version: 1,
}

// ============ Notification Transformation ============

/**
 * Transforms GitHub Notification to canonical Notification.
 */
export const notificationTransform: Transformation<GitHubNotification> = {
  id: 'github:notification:v1',
  name: 'GitHub Notification → Notification',
  source: {
    connector: 'github',
    entityType: 'notification',
  },
  inputSchema: GitHubNotificationSchema,
  outputType: 'notification',
  transform(source: GitHubNotification, ctx: TransformContext): TransformResult {
    const sourceRef = createSourceRef(
      ctx.accountId,
      'notification',
      source.id,
      source.updated_at
    )

    // Map GitHub reason to notification type
    const typeMapping: Record<string, string> = {
      assign: 'assignment',
      author: 'update',
      comment: 'comment',
      ci_activity: 'ci',
      invitation: 'invitation',
      manual: 'subscription',
      mention: 'mention',
      review_requested: 'review_request',
      security_alert: 'security',
      state_change: 'state_change',
      subscribed: 'subscription',
      team_mention: 'mention',
    }

    const notification: Notification = {
      ...createBaseEntity(generateCanonicalId(), sourceRef),
      entity_type: 'notification',
      notification_type: typeMapping[source.reason] ?? source.reason,
      title: source.subject.title,
      is_read: !source.unread,
      read_at: source.last_read_at ?? undefined,
      triggered_at: source.updated_at,
      related_entity_type: source.subject.type.toLowerCase(),
      metadata: {
        github_reason: source.reason,
        github_subject_type: source.subject.type,
        github_repo_name: source.repository.full_name,
        github_subject_url: source.subject.url,
      },
    }

    const primary: TransformOutput = {
      entityType: 'notification',
      data: notification,
      displayText: `[${source.repository.full_name}] ${source.subject.title}`,
      sourceRefKey: sourceRefToKey(sourceRef),
    }

    return { primary }
  },
  onError: 'skip',
  enabled: true,
  version: 1,
}

// ============ Export All Transformations ============

/**
 * All GitHub transformations.
 */
export const githubTransforms = [
  issueTransform,
  pullRequestTransform,
  commentTransform,
  notificationTransform,
] as const
