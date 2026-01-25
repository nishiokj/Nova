#!/usr/bin/env bun
/**
 * Database Migration Script
 *
 * Runs all pending migrations in order.
 *
 * Usage:
 *   bun run packages/agent-memory/scripts/migrate.ts
 */

import postgres from 'postgres'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Load .env from project root
await loadEnvFile(join(import.meta.dir, '../../../.env'))

async function loadEnvFile(path: string): Promise<void> {
  try {
    const content = await readFile(path, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const match = trimmed.match(/^([^=]+)=(.*)$/)
      if (match) {
        const key = match[1].trim()
        let value = match[2].trim()
        // Remove surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        if (!(key in process.env)) {
          process.env[key] = value
        }
      }
    }
  } catch {
    // .env file not found, continue with existing env
  }
}

const MIGRATIONS_DIR = join(import.meta.dir, '../src/db/migrations')

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is required')
    process.exit(1)
  }

  console.log('📦 Connecting to database...')
  const sql = postgres(databaseUrl, { max: 1 })

  try {
    // Check if schema_migrations table exists
    const tableExists = await sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'schema_migrations'
      ) as exists
    `

    let appliedVersions: Set<number> = new Set()
    if (tableExists[0].exists) {
      const applied = await sql`SELECT version FROM schema_migrations ORDER BY version`
      appliedVersions = new Set(applied.map(r => r.version))
      console.log(`✓ Found ${appliedVersions.size} applied migrations`)
    } else {
      console.log('✓ No migrations applied yet')
    }

    // Get migration files
    const files = await readdir(MIGRATIONS_DIR)
    const migrations = files
      .filter(f => f.endsWith('.sql'))
      .map(f => ({
        filename: f,
        version: parseInt(f.split('_')[0], 10),
        path: join(MIGRATIONS_DIR, f),
      }))
      .sort((a, b) => a.version - b.version)

    // Run pending migrations
    let applied = 0
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        continue
      }

      console.log(`\n🔄 Running migration: ${migration.filename}`)
      const content = await readFile(migration.path, 'utf-8')

      await sql.unsafe(content)
      applied++
      console.log(`✓ Migration ${migration.version} complete`)
    }

    if (applied === 0) {
      console.log('\n✅ Database is up to date')
    } else {
      console.log(`\n✅ Applied ${applied} migration(s)`)
    }

  } catch (error) {
    console.error('❌ Migration failed:', error)
    process.exit(1)
  } finally {
    await sql.end()
  }
}

main()
