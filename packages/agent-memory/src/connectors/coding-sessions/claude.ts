/**
 * Claude Session Connector
 *
 * Connector for ingesting Claude Code session data from local JSONL files.
 * Reads from ~/.claude/projects/ by default.
 *
 * @module connectors/coding-sessions/claude
 */

import { join } from 'path'
import { homedir } from 'os'
import { z } from 'zod'
import type { ConnectorType } from '../../ids.js'
import type { SourceItem } from '../../sync/types.js'
import type { TransformationRegistry } from '../../transform/registry.js'
import { CodingAgentSessionConnector } from './base.js'
import {
  ClaudeSessionMessageSchema,
  type ClaudeSessionMessage,
} from './schemas.js'
import { transforms } from './transforms.js'

// ============ Configuration ============

export interface ClaudeSessionConnectorConfig {
  /** Base path to Claude projects directory (default: ~/.claude/projects) */
  projectsPath?: string
  /** Specific project folders to sync (default: all) */
  projectFilter?: string[]
  /** Maximum sessions to fetch per page (default: 10) */
  pageSize?: number
  /** Include file history snapshots (default: false) */
  includeFileHistory?: boolean
}

const DEFAULT_CLAUDE_PROJECTS_PATH = join(homedir(), '.claude', 'projects')

// ============ Claude Session Connector ============

export class ClaudeSessionConnector extends CodingAgentSessionConnector {
  readonly type: ConnectorType = 'claude_sessions'
  readonly displayName = 'Claude Code Sessions'

  constructor(config: ClaudeSessionConnectorConfig = {}) {
    super({
      sessionsPath: config.projectsPath ?? DEFAULT_CLAUDE_PROJECTS_PATH,
      projectFilter: config.projectFilter,
      pageSize: config.pageSize,
      includeFileHistory: config.includeFileHistory,
    })
  }

  protected getSessionMessageSchema(): z.ZodSchema {
    return ClaudeSessionMessageSchema
  }

  protected messageToSourceItem(
    msg: unknown,
    sessionId: string,
    project: string
  ): SourceItem | null {
    const message = msg as ClaudeSessionMessage

    let entityType: string
    let sourceId: string
    let sourceTimestamp: string

    switch (message.type) {
      case 'user':
      case 'assistant':
        entityType = 'session_message'
        sourceId = message.uuid
        sourceTimestamp = message.timestamp
        break
      case 'summary':
        entityType = 'session_summary'
        sourceId = `summary:${message.leafUuid}`
        sourceTimestamp = new Date().toISOString()
        break
      case 'file-history-snapshot':
        entityType = 'file_history'
        sourceId = `snapshot:${message.messageId}`
        sourceTimestamp = message.snapshot.timestamp
        break
      default:
        return null
    }

    return {
      source_id: sourceId,
      entity_type: entityType,
      raw_data: {
        ...message,
        _meta: {
          sessionId,
          project,
          agent: 'claude',
        },
      },
      source_timestamp: sourceTimestamp,
    }
  }

  /**
   * Register Claude session transformations with a registry.
   */
  registerTransforms(registry: TransformationRegistry): void {
    for (const transform of transforms) {
      registry.register(transform as any)
    }
  }
}

// ============ Factory ============

export function createClaudeSessionConnector(
  config?: ClaudeSessionConnectorConfig
): ClaudeSessionConnector {
  return new ClaudeSessionConnector(config)
}
