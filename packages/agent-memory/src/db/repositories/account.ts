/**
 * Account Repository
 *
 * CRUD operations for accounts table.
 * Manages connected accounts and their credentials.
 */

import type { ConnectorType } from '../../ids.js'
import { generateCanonicalId } from '../../ids.js'
import type { RepositoryContext } from './types.js'

export type AuthType = 'oauth2' | 'api_key' | 'basic' | 'token'

export interface Account {
  id: string
  connector: ConnectorType
  external_account_id: string
  display_name?: string
  email?: string
  auth_type: AuthType
  token_expires_at?: string
  is_active: boolean
  last_synced_at?: string
  sync_cursor?: string
  created_at: string
  updated_at: string
}

export interface AccountRow {
  id: string
  connector: string
  external_account_id: string
  display_name: string | null
  email: string | null
  auth_type: string
  credentials_encrypted: Buffer | null
  credentials_iv: Buffer | null
  token_expires_at: Date | null
  refresh_token_encrypted: Buffer | null
  is_active: boolean
  last_synced_at: Date | null
  sync_cursor: string | null
  created_at: Date
  updated_at: Date
}

function rowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    connector: row.connector as ConnectorType,
    external_account_id: row.external_account_id,
    display_name: row.display_name ?? undefined,
    email: row.email ?? undefined,
    auth_type: row.auth_type as AuthType,
    token_expires_at: row.token_expires_at?.toISOString(),
    is_active: row.is_active,
    last_synced_at: row.last_synced_at?.toISOString(),
    sync_cursor: row.sync_cursor ?? undefined,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

export interface AccountInput {
  connector: ConnectorType
  external_account_id: string
  display_name?: string
  email?: string
  auth_type: AuthType
}

export interface AccountCredentials {
  credentials_encrypted: Buffer
  credentials_iv: Buffer
  refresh_token_encrypted?: Buffer
  token_expires_at?: Date
}

export interface AccountRepository {
  findById(id: string): Promise<Account | null>
  findByConnector(connector: ConnectorType, externalId: string): Promise<Account | null>
  findAllByConnector(connector: ConnectorType): Promise<Account[]>
  findActive(): Promise<Account[]>
  create(input: AccountInput): Promise<Account>
  update(
    id: string,
    updates: Partial<Pick<Account, 'display_name' | 'email' | 'is_active'>>
  ): Promise<Account | null>
  updateCredentials(id: string, credentials: AccountCredentials): Promise<boolean>
  updateSyncState(id: string, cursor?: string): Promise<Account | null>
  deactivate(id: string): Promise<boolean>
  activate(id: string): Promise<boolean>
  delete(id: string): Promise<boolean>
  getCredentials(id: string): Promise<AccountCredentials | null>
}

export function createAccountRepository(ctx: RepositoryContext): AccountRepository {
  const { sql } = ctx

  return {
    async findById(id) {
      const [row] = await sql<AccountRow[]>`
        SELECT * FROM accounts WHERE id = ${id}
      `
      return row ? rowToAccount(row) : null
    },

    async findByConnector(connector, externalId) {
      const [row] = await sql<AccountRow[]>`
        SELECT * FROM accounts
        WHERE connector = ${connector} AND external_account_id = ${externalId}
      `
      return row ? rowToAccount(row) : null
    },

    async findAllByConnector(connector) {
      const rows = await sql<AccountRow[]>`
        SELECT * FROM accounts
        WHERE connector = ${connector}
        ORDER BY created_at DESC
      `
      return rows.map(rowToAccount)
    },

    async findActive() {
      const rows = await sql<AccountRow[]>`
        SELECT * FROM accounts
        WHERE is_active = true
        ORDER BY connector, created_at DESC
      `
      return rows.map(rowToAccount)
    },

    async create(input) {
      const id = generateCanonicalId()
      const now = new Date()

      const [row] = await sql<AccountRow[]>`
        INSERT INTO accounts (
          id, connector, external_account_id, display_name, email,
          auth_type, is_active, created_at, updated_at
        ) VALUES (
          ${id},
          ${input.connector},
          ${input.external_account_id},
          ${input.display_name ?? null},
          ${input.email ?? null},
          ${input.auth_type},
          true,
          ${now},
          ${now}
        )
        RETURNING *
      `

      return rowToAccount(row)
    },

    async update(id, updates) {
      const now = new Date()

      const [row] = await sql<AccountRow[]>`
        UPDATE accounts
        SET display_name = COALESCE(${updates.display_name ?? null}, display_name),
            email = COALESCE(${updates.email ?? null}, email),
            is_active = COALESCE(${updates.is_active ?? null}, is_active),
            updated_at = ${now}
        WHERE id = ${id}
        RETURNING *
      `

      return row ? rowToAccount(row) : null
    },

    async updateCredentials(id, credentials) {
      const now = new Date()

      const result = await sql`
        UPDATE accounts
        SET credentials_encrypted = ${credentials.credentials_encrypted},
            credentials_iv = ${credentials.credentials_iv},
            refresh_token_encrypted = ${credentials.refresh_token_encrypted ?? null},
            token_expires_at = ${credentials.token_expires_at ?? null},
            updated_at = ${now}
        WHERE id = ${id}
      `

      return result.count > 0
    },

    async updateSyncState(id, cursor) {
      const now = new Date()

      const [row] = await sql<AccountRow[]>`
        UPDATE accounts
        SET last_synced_at = ${now},
            sync_cursor = ${cursor ?? null},
            updated_at = ${now}
        WHERE id = ${id}
        RETURNING *
      `

      return row ? rowToAccount(row) : null
    },

    async deactivate(id) {
      const now = new Date()

      const result = await sql`
        UPDATE accounts
        SET is_active = false, updated_at = ${now}
        WHERE id = ${id}
      `

      return result.count > 0
    },

    async activate(id) {
      const now = new Date()

      const result = await sql`
        UPDATE accounts
        SET is_active = true, updated_at = ${now}
        WHERE id = ${id}
      `

      return result.count > 0
    },

    async delete(id) {
      const result = await sql`
        DELETE FROM accounts WHERE id = ${id}
      `
      return result.count > 0
    },

    async getCredentials(id) {
      const [row] = await sql<
        Pick<
          AccountRow,
          'credentials_encrypted' | 'credentials_iv' | 'refresh_token_encrypted' | 'token_expires_at'
        >[]
      >`
        SELECT credentials_encrypted, credentials_iv, refresh_token_encrypted, token_expires_at
        FROM accounts
        WHERE id = ${id}
      `

      if (!row || !row.credentials_encrypted || !row.credentials_iv) {
        return null
      }

      return {
        credentials_encrypted: row.credentials_encrypted,
        credentials_iv: row.credentials_iv,
        refresh_token_encrypted: row.refresh_token_encrypted ?? undefined,
        token_expires_at: row.token_expires_at ?? undefined,
      }
    },
  }
}
