/**
 * GitHub Entity Mappers
 *
 * Transforms GitHub API responses into canonical entities.
 *
 * @module connectors/github/mappers
 */

import { generateCanonicalId, sourceRefToKey } from '../../ids.js'
import type { EntityMapper, MapperContext, MappedEntity } from '../../sync/types.js'
import type { Identity, Task, Message, Notification, EntityType } from '../../models/canonical.js'
import {
  GitHubUserSchema,
  GitHubIssueSchema,
  GitHubPullRequestSchema,
  GitHubCommentSchema,
  GitHubNotificationSchema,
  type GitHubUser,
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
): Identity['source_refs'][0] {
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
function createBaseEntity(id: string, sourceRef: Identity['source_refs'][0]) {
  const now = new Date().toISOString()
  return {
    id,
    created_at: now,
    updated_at: now,
    source_refs: [sourceRef],
  }
}

// ============ User Mapper ============

/**
 * Maps GitHub User to canonical Identity.
 */
export const userMapper: EntityMapper<GitHubUser> = {
  sourceEntityType: 'user',
  targetEntityType: 'identity',
  sourceSchema: GitHubUserSchema,

  map(source: GitHubUser, context: MapperContext): MappedEntity {
    const sourceRef = createSourceRef(
      context.accountId,
      'user',
      String(source.id),
      source.updated_at
    )

    const identity: Identity = {
      ...createBaseEntity(generateCanonicalId(), sourceRef),
      entity_type: 'identity',
      platform: 'github',
      platform_user_id: String(source.id),
      username: source.login,
      display_name: source.name ?? source.login,
      email: source.email ?? undefined,
      avatar_url: source.avatar_url,
      profile_url: source.html_url,
    }

    return {
      entityType: 'identity',
      data: identity,
      displayText: `${identity.display_name} (@${source.login})`,
      sourceRefKey: sourceRefToKey(sourceRef),
    }
  },
}

// ============ Issue Mapper ============

/**
 * Maps GitHub Issue to canonical Task.
 */
export const issueMapper: EntityMapper<GitHubIssue> = {
  sourceEntityType: 'issue',
  targetEntityType: 'task',
  sourceSchema: GitHubIssueSchema,

  map(source: GitHubIssue, context: MapperContext): MappedEntity | MappedEntity[] {
    const sourceRef = createSourceRef(
      context.accountId,
      'issue',
      String(source.id),
      source.updated_at
    )

    // Determine status
    let status: Task['status'] = 'open'
    if (source.state === 'closed') {
      status = source.state_reason === 'not_planned' ? 'cancelled' : 'closed'
    }

    const task: Task = {
      ...createBaseEntity(generateCanonicalId(), sourceRef),
      entity_type: 'task',
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

    const result: MappedEntity = {
      entityType: 'task',
      data: task,
      displayText: `#${source.number}: ${source.title}`,
      sourceRefKey: sourceRefToKey(sourceRef),
    }

    // Also map the issue creator as a related entity
    const relatedEntities: MappedEntity[] = []

    if (source.user) {
      const creatorContext: MapperContext = {
        ...context,
        sourceRef: {
          connector: 'github',
          account_id: context.accountId,
          entity_type: 'user',
          source_id: String(source.user.id),
        },
        envelope: context.envelope,
      }

      relatedEntities.push(
        userMapper.map(source.user as GitHubUser, creatorContext) as MappedEntity
      )
    }

    // Map assignees
    for (const assignee of source.assignees ?? []) {
      const assigneeContext: MapperContext = {
        ...context,
        sourceRef: {
          connector: 'github',
          account_id: context.accountId,
          entity_type: 'user',
          source_id: String(assignee.id),
        },
        envelope: context.envelope,
      }

      relatedEntities.push(
        userMapper.map(assignee as GitHubUser, assigneeContext) as MappedEntity
      )
    }

    if (relatedEntities.length > 0) {
      result.relatedEntities = relatedEntities
    }

    return result
  },
}

// ============ Pull Request Mapper ============

/**
 * Maps GitHub Pull Request to canonical Task.
 */
export const pullRequestMapper: EntityMapper<GitHubPullRequest> = {
  sourceEntityType: 'pull_request',
  targetEntityType: 'task',
  sourceSchema: GitHubPullRequestSchema,

  map(source: GitHubPullRequest, context: MapperContext): MappedEntity | MappedEntity[] {
    const sourceRef = createSourceRef(
      context.accountId,
      'pull_request',
      String(source.id),
      source.updated_at
    )

    // Determine status
    let status: Task['status'] = 'open'
    if (source.merged) {
      status = 'closed'
    } else if (source.state === 'closed') {
      status = 'cancelled'
    } else if (source.draft) {
      status = 'in_progress'
    }

    const task: Task = {
      ...createBaseEntity(generateCanonicalId(), sourceRef),
      entity_type: 'task',
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

    const result: MappedEntity = {
      entityType: 'task',
      data: task,
      displayText: `PR #${source.number}: ${source.title}`,
      sourceRefKey: sourceRefToKey(sourceRef),
    }

    // Map creator and assignees as related entities
    const relatedEntities: MappedEntity[] = []

    if (source.user) {
      const creatorContext: MapperContext = {
        ...context,
        sourceRef: {
          connector: 'github',
          account_id: context.accountId,
          entity_type: 'user',
          source_id: String(source.user.id),
        },
        envelope: context.envelope,
      }

      relatedEntities.push(
        userMapper.map(source.user as GitHubUser, creatorContext) as MappedEntity
      )
    }

    for (const assignee of source.assignees ?? []) {
      const assigneeContext: MapperContext = {
        ...context,
        sourceRef: {
          connector: 'github',
          account_id: context.accountId,
          entity_type: 'user',
          source_id: String(assignee.id),
        },
        envelope: context.envelope,
      }

      relatedEntities.push(
        userMapper.map(assignee as GitHubUser, assigneeContext) as MappedEntity
      )
    }

    if (relatedEntities.length > 0) {
      result.relatedEntities = relatedEntities
    }

    return result
  },
}

// ============ Comment Mapper ============

/**
 * Maps GitHub Comment to canonical Message.
 */
export const commentMapper: EntityMapper<GitHubComment> = {
  sourceEntityType: 'comment',
  targetEntityType: 'message',
  sourceSchema: GitHubCommentSchema,

  map(source: GitHubComment, context: MapperContext): MappedEntity | MappedEntity[] {
    const sourceRef = createSourceRef(
      context.accountId,
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

    const result: MappedEntity = {
      entityType: 'message',
      data: message,
      displayText: source.body.length > 100 ? source.body.substring(0, 100) + '...' : source.body,
      sourceRefKey: sourceRefToKey(sourceRef),
    }

    // Map comment author as related entity
    if (source.user) {
      const authorContext: MapperContext = {
        ...context,
        sourceRef: {
          connector: 'github',
          account_id: context.accountId,
          entity_type: 'user',
          source_id: String(source.user.id),
        },
        envelope: context.envelope,
      }

      result.relatedEntities = [
        userMapper.map(source.user as GitHubUser, authorContext) as MappedEntity,
      ]
    }

    return result
  },
}

// ============ Notification Mapper ============

/**
 * Maps GitHub Notification to canonical Notification.
 */
export const notificationMapper: EntityMapper<GitHubNotification> = {
  sourceEntityType: 'notification',
  targetEntityType: 'notification',
  sourceSchema: GitHubNotificationSchema,

  map(source: GitHubNotification, context: MapperContext): MappedEntity {
    const sourceRef = createSourceRef(
      context.accountId,
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

    return {
      entityType: 'notification',
      data: notification,
      displayText: `[${source.repository.full_name}] ${source.subject.title}`,
      sourceRefKey: sourceRefToKey(sourceRef),
    }
  },
}

// ============ Mapper Registry ============

/**
 * All GitHub entity mappers.
 */
export const githubMappers = {
  user: userMapper,
  issue: issueMapper,
  pull_request: pullRequestMapper,
  comment: commentMapper,
  notification: notificationMapper,
} as const

/**
 * Get a mapper by entity type.
 */
export function getGitHubMapper(entityType: string): EntityMapper | undefined {
  return githubMappers[entityType as keyof typeof githubMappers]
}

/**
 * Get all supported entity types.
 */
export function getGitHubEntityTypes(): string[] {
  return Object.keys(githubMappers)
}
