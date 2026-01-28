/**
 * Rex Session Connector
 *
 * Connector for ingesting Rex coding agent session data from local files.
 * Path must be configured explicitly.
 *
 * @module connectors/coding-sessions/rex
 */

import { z } from 'zod'
import type { ConnectorType } from '../../ids.js'
import type { SourceItem } from '../../sync/types.js'
import type { TransformationRegistry } from '../../transform/registry.js'
import { CodingAgentSessionConnector } from './base.js'
import {
  RexSessionMessageSchema,
  type RexSessionMessage,
} from './schemas.js'
import { rexTransforms } from './transforms.js'

// ============ Configuration ============

export interface RexSessionConnectorConfig {
  /** Base path to Rex sessions directory (required) */
  sessionsPath: string
  /** Specific project folders to sync (default: all) */
  projectFilter?: string[]
  /** Maximum sessions to fetch per page (default: 10) */
  pageSize?: number
}

// ============ Rex Session Connector ============

export class RexSessionConnector extends CodingAgentSessionConnector {
  readonly type: ConnectorType = 'rex_sessions'
  readonly displayName = 'Rex Sessions'

  constructor(config: RexSessionConnectorConfig) {
    if (!config.sessionsPath) {
      throw new Error('RexSessionConnector requires sessionsPath to be configured')
    }

    super({
      sessionsPath: config.sessionsPath,
      projectFilter: config.projectFilter,
      pageSize: config.pageSize,
      includeFileHistory: false,
    })
  }

  protected getSessionMessageSchema(): z.ZodSchema {
    return RexSessionMessageSchema
  }

  protected messageToSourceItem(
    msg: unknown,
    sessionId: string,
    project: string
  ): SourceItem | null {
    const message = msg as RexSessionMessage

    let entityType: string
    let sourceId: string
    let sourceTimestamp: string

    switch (message.type) {
      case 'user':
      case 'assistant':
        entityType = 'session_message'
        sourceId = message.id
        sourceTimestamp = message.timestamp
        break
      case 'summary':
        entityType = 'session_summary'
        sourceId = `summary:${message.session_id}`
        sourceTimestamp = message.created_at
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
          agent: 'rex',
        },
      },
      source_timestamp: sourceTimestamp,
    }
  }

  /**
   * Register Rex session transformations with a registry.
   */
  registerTransforms(registry: TransformationRegistry): void {
    for (const transform of rexTransforms) {
      registry.register(transform as any)
    }
  }
}

// ============ Factory ============

export function createRexSessionConnector(
  config: RexSessionConnectorConfig
): RexSessionConnector {
  return new RexSessionConnector(config)
}
