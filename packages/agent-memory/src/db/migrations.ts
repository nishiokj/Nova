/**
 * Migration System
 *
 * Forward-only migrations with versioning.
 * Migrations are stored in src/db/migrations/*.sql and applied in order.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from './connection.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, 'migrations')

export interface Migration {
  version: number
  filename: string
  description: string
  sql: string
}

export interface AppliedMigration {
  version: number
  applied_at: Date
  description: string | null
}

export interface MigrationResult {
  applied: Migration[]
  skipped: number[]
  current_version: number
}

/**
 * Parse migration filename to extract version number.
 * Expected format: 001_description.sql, 002_another.sql, etc.
 */
function parseMigrationFilename(filename: string): number | null {
  const match = filename.match(/^(\d+)_.*\.sql$/)
  return match ? parseInt(match[1], 10) : null
}

/**
 * Load all migration files from the migrations directory.
 */
export async function loadMigrations(): Promise<Migration[]> {
  const files = await readdir(MIGRATIONS_DIR)
  const migrations: Migration[] = []

  for (const file of files) {
    const version = parseMigrationFilename(file)
    if (version === null) continue

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8')

    // Extract description from first comment line
    const descMatch = sql.match(/^--\s*(?:Migration:\s*\d+_\w+\s*\n)?--\s*Description:\s*(.+)/m)
    const description = descMatch ? descMatch[1].trim() : file

    migrations.push({
      version,
      filename: file,
      description,
      sql,
    })
  }

  // Sort by version
  return migrations.sort((a, b) => a.version - b.version)
}

/**
 * Get all applied migrations from the database.
 */
export async function getAppliedMigrations(db: Database): Promise<AppliedMigration[]> {
  try {
    const rows = await db.sql<AppliedMigration[]>`
      SELECT version, applied_at, description
      FROM schema_migrations
      ORDER BY version ASC
    `
    return rows
  } catch (error) {
    // Table doesn't exist yet - return empty array
    if ((error as { code?: string }).code === '42P01') {
      return []
    }
    throw error
  }
}

/**
 * Get the current schema version.
 */
export async function getCurrentVersion(db: Database): Promise<number> {
  const applied = await getAppliedMigrations(db)
  return applied.length > 0 ? applied[applied.length - 1].version : 0
}

/**
 * Run pending migrations.
 *
 * @param db Database connection
 * @param options Migration options
 * @returns Result of migration run
 */
export async function migrate(
  db: Database,
  options: {
    /** Target version to migrate to (default: latest) */
    target?: number
    /** Dry run - don't actually apply migrations */
    dryRun?: boolean
    /** Callback for logging */
    onMigration?: (migration: Migration, status: 'applying' | 'applied' | 'skipped') => void
  } = {}
): Promise<MigrationResult> {
  const { target, dryRun = false, onMigration } = options

  const migrations = await loadMigrations()
  const applied = await getAppliedMigrations(db)
  const appliedVersions = new Set(applied.map((m) => m.version))

  const result: MigrationResult = {
    applied: [],
    skipped: [],
    current_version: applied.length > 0 ? applied[applied.length - 1].version : 0,
  }

  for (const migration of migrations) {
    // Skip if already applied
    if (appliedVersions.has(migration.version)) {
      result.skipped.push(migration.version)
      onMigration?.(migration, 'skipped')
      continue
    }

    // Skip if beyond target version
    if (target !== undefined && migration.version > target) {
      break
    }

    onMigration?.(migration, 'applying')

    if (!dryRun) {
      // Run migration in a transaction
      await db.sql.begin(async (tx) => {
        // Execute the migration SQL
        await tx.unsafe(migration.sql)

        // Record the migration as applied
        await tx.unsafe(
          `INSERT INTO schema_migrations (version, description)
           VALUES ($1, $2)
           ON CONFLICT (version) DO NOTHING`,
          [migration.version, migration.description]
        )
      })
    }

    result.applied.push(migration)
    result.current_version = migration.version
    onMigration?.(migration, 'applied')
  }

  return result
}

/**
 * Check if the database schema is up to date.
 */
export async function isSchemaUpToDate(db: Database): Promise<boolean> {
  const migrations = await loadMigrations()
  const currentVersion = await getCurrentVersion(db)
  const latestVersion = migrations.length > 0 ? migrations[migrations.length - 1].version : 0
  return currentVersion >= latestVersion
}

/**
 * Get pending migrations that haven't been applied yet.
 */
export async function getPendingMigrations(db: Database): Promise<Migration[]> {
  const migrations = await loadMigrations()
  const applied = await getAppliedMigrations(db)
  const appliedVersions = new Set(applied.map((m) => m.version))

  return migrations.filter((m) => !appliedVersions.has(m.version))
}
