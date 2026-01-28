/**
 * Registered Connector Repository
 *
 * CRUD operations for the registered_connectors table.
 * Manages which connectors are active and their runtime configuration.
 */

import type { ConnectorType } from '../../ids.js'
import type { RepositoryContext } from './types.js'

// ============ Types ============

export interface RegisteredConnector {
  type: ConnectorType
  enabled: boolean
  config: Record<string, unknown>
  registered_at: string
  updated_at: string
}

export interface RegisteredConnectorRow {
  type: string
  enabled: boolean
  config: Record<string, unknown>
  registered_at: Date
  updated_at: Date
}

export interface RegisteredConnectorInput {
  type: ConnectorType
  enabled?: boolean
  config?: Record<string, unknown>
}

function rowToConnector(row: RegisteredConnectorRow): RegisteredConnector {
  return {
    type: row.type as ConnectorType,
    enabled: row.enabled,
    config: row.config,
    registered_at: row.registered_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

// ============ Repository ============

export interface RegisteredConnectorRepository {
  /** Find all registered connectors */
  findAll(): Promise<RegisteredConnector[]>
  /** Find only enabled connectors */
  findEnabled(): Promise<RegisteredConnector[]>
  /** Find connector by type */
  findByType(type: ConnectorType): Promise<RegisteredConnector | null>
  /** Register a new connector */
  register(input: RegisteredConnectorInput): Promise<RegisteredConnector>
  /** Update connector config */
  updateConfig(type: ConnectorType, config: Record<string, unknown>): Promise<RegisteredConnector | null>
  /** Enable or disable a connector */
  setEnabled(type: ConnectorType, enabled: boolean): Promise<RegisteredConnector | null>
  /** Unregister (delete) a connector */
  unregister(type: ConnectorType): Promise<boolean>
}

export function createRegisteredConnectorRepository(ctx: RepositoryContext): RegisteredConnectorRepository {
  const { sql } = ctx

  return {
    async findAll() {
      const rows = await sql<RegisteredConnectorRow[]>`
        SELECT * FROM registered_connectors
        ORDER BY type
      `
      return rows.map(rowToConnector)
    },

    async findEnabled() {
      const rows = await sql<RegisteredConnectorRow[]>`
        SELECT * FROM registered_connectors
        WHERE enabled = true
        ORDER BY type
      `
      return rows.map(rowToConnector)
    },

    async findByType(type) {
      const [row] = await sql<RegisteredConnectorRow[]>`
        SELECT * FROM registered_connectors WHERE type = ${type}
      `
      return row ? rowToConnector(row) : null
    },

    async register(input) {
      const now = new Date()
      const config = sql.json((input.config ?? {}) as any)
      const [row] = await sql<RegisteredConnectorRow[]>`
        INSERT INTO registered_connectors (type, enabled, config, registered_at, updated_at)
        VALUES (
          ${input.type},
          ${input.enabled ?? true},
          ${config},
          ${now},
          ${now}
        )
        ON CONFLICT (type) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          config = EXCLUDED.config,
          updated_at = ${now}
        RETURNING *
      `
      return rowToConnector(row)
    },

    async updateConfig(type, config) {
      const now = new Date()
      const [row] = await sql<RegisteredConnectorRow[]>`
        UPDATE registered_connectors
        SET config = ${sql.json(config as any)}, updated_at = ${now}
        WHERE type = ${type}
        RETURNING *
      `
      return row ? rowToConnector(row) : null
    },

    async setEnabled(type, enabled) {
      const now = new Date()
      const [row] = await sql<RegisteredConnectorRow[]>`
        UPDATE registered_connectors
        SET enabled = ${enabled}, updated_at = ${now}
        WHERE type = ${type}
        RETURNING *
      `
      return row ? rowToConnector(row) : null
    },

    async unregister(type) {
      const result = await sql`
        DELETE FROM registered_connectors WHERE type = ${type}
      `
      return result.count > 0
    },
  }
}
