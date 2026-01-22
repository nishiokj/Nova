/**
 * Database Connection Management
 *
 * Uses postgres.js for connection pooling and type-safe queries.
 * Supports both connection string and individual parameters.
 */

import postgres from 'postgres'
import type { Sql } from 'postgres'

export interface DatabaseConfig {
  /** Connection string (postgres://...) */
  connectionString?: string
  /** Host (default: localhost) */
  host?: string
  /** Port (default: 5432) */
  port?: number
  /** Database name */
  database?: string
  /** Username */
  username?: string
  /** Password */
  password?: string
  /** Max connections in pool (default: 10) */
  max?: number
  /** Idle timeout in seconds (default: 30) */
  idleTimeout?: number
  /** Connect timeout in seconds (default: 10) */
  connectTimeout?: number
  /** Enable SSL (default: false for local, true for remote) */
  ssl?: boolean | 'require' | 'prefer'
  /** Schema to use (default: public) */
  schema?: string
  /** Embedding dimension for vector columns (default: 1536) */
  embeddingDimension?: number
}

export interface Database {
  /** The postgres.js SQL template tag */
  sql: Sql
  /** Configuration used to create this connection */
  config: DatabaseConfig
  /** Close all connections in the pool */
  close(): Promise<void>
  /** Check if the database is reachable */
  ping(): Promise<boolean>
}

/**
 * Create a database connection pool.
 *
 * @example
 * ```ts
 * // Using connection string
 * const db = createDatabase({ connectionString: 'postgres://localhost/mydb' })
 *
 * // Using individual parameters
 * const db = createDatabase({
 *   host: 'localhost',
 *   database: 'agent_memory',
 *   username: 'postgres',
 *   password: 'secret'
 * })
 *
 * // Query
 * const rows = await db.sql`SELECT * FROM users`
 *
 * // Close when done
 * await db.close()
 * ```
 */
export function createDatabase(config: DatabaseConfig): Database {
  const sql = config.connectionString
    ? postgres(config.connectionString, {
        max: config.max ?? 10,
        idle_timeout: config.idleTimeout ?? 30,
        connect_timeout: config.connectTimeout ?? 10,
        ssl: config.ssl,
      })
    : postgres({
        host: config.host ?? 'localhost',
        port: config.port ?? 5432,
        database: config.database ?? 'agent_memory',
        username: config.username ?? 'postgres',
        password: config.password ?? '',
        max: config.max ?? 10,
        idle_timeout: config.idleTimeout ?? 30,
        connect_timeout: config.connectTimeout ?? 10,
        ssl: config.ssl,
      })

  return {
    sql,
    config,

    async close() {
      await sql.end()
    },

    async ping() {
      try {
        await sql`SELECT 1`
        return true
      } catch {
        return false
      }
    },
  }
}

/**
 * Create a database connection from environment variables.
 *
 * Supports:
 * - DATABASE_URL (connection string)
 * - PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
 * - AGENT_MEMORY_DB_* variants
 */
export function createDatabaseFromEnv(): Database {
  const env = process.env

  // Check for connection string first
  const connectionString =
    env.DATABASE_URL || env.AGENT_MEMORY_DATABASE_URL || env.POSTGRES_URL

  if (connectionString) {
    return createDatabase({
      connectionString,
      max: env.AGENT_MEMORY_DB_MAX ? parseInt(env.AGENT_MEMORY_DB_MAX, 10) : undefined,
      embeddingDimension: env.AGENT_MEMORY_EMBEDDING_DIM
        ? parseInt(env.AGENT_MEMORY_EMBEDDING_DIM, 10)
        : undefined,
    })
  }

  // Fall back to individual parameters
  return createDatabase({
    host: env.PGHOST || env.AGENT_MEMORY_DB_HOST || 'localhost',
    port: env.PGPORT
      ? parseInt(env.PGPORT, 10)
      : env.AGENT_MEMORY_DB_PORT
        ? parseInt(env.AGENT_MEMORY_DB_PORT, 10)
        : 5432,
    database: env.PGDATABASE || env.AGENT_MEMORY_DB_NAME || 'agent_memory',
    username: env.PGUSER || env.AGENT_MEMORY_DB_USER || 'postgres',
    password: env.PGPASSWORD || env.AGENT_MEMORY_DB_PASSWORD || '',
    max: env.AGENT_MEMORY_DB_MAX ? parseInt(env.AGENT_MEMORY_DB_MAX, 10) : 10,
    embeddingDimension: env.AGENT_MEMORY_EMBEDDING_DIM
      ? parseInt(env.AGENT_MEMORY_EMBEDDING_DIM, 10)
      : 1536,
  })
}

export type { Sql }
