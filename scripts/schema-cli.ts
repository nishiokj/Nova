#!/usr/bin/env bun
import { Client } from 'pg'
import { parse } from 'pg-connection-string'

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/agent_memory'

// Parse connection string
const config = parse(DATABASE_URL)

// Create PostgreSQL client
const client = new Client({
  host: config.host || 'localhost',
  port: config.port ? parseInt(config.port) : 5432,
  database: config.database || 'jesus',
  user: config.user || 'postgres',
  password: config.password || 'postgres',
})

async function listTables() {
  const result = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `)

  console.log('Tables in database:')
  console.log('')
  for (const row of result.rows) {
    console.log(`  - ${row.table_name}`)
  }
  console.log(`\n${result.rows.length} table(s) found.`)
}

async function describeTable(tableName: string) {
  // Check if table exists
  const tableExists = await client.query(`
    SELECT COUNT(*) as count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = $1
  `, [tableName])

  if (parseInt(tableExists.rows[0].count) === 0) {
    console.error(`Table "${tableName}" not found.`)
    console.error('Run "bun run scripts/schema-cli.ts tables list" to see available tables.')
    process.exit(1)
  }

  // Get column information
  const columnsResult = await client.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName])

  console.log(`Table: ${tableName}`)
  console.log('')

  const colNameWidth = Math.max('Column'.length, ...columnsResult.rows.map(r => r.column_name.length))
  const typeWidth = Math.max('Type'.length, ...columnsResult.rows.map(r => r.data_type.length))

  console.log(`${'Column'.padEnd(colNameWidth)} | ${'Type'.padEnd(typeWidth)} | Nullable | Default`)
  console.log(`${'-'.repeat(colNameWidth)}-+-${'-'.repeat(typeWidth)}-+---------+--------`)

  for (const col of columnsResult.rows) {
    console.log(
      `${col.column_name.padEnd(colNameWidth)} | ${col.data_type.padEnd(typeWidth)} | ${col.is_nullable.padEnd(8)} | ${col.column_default ?? ''}`
    )
  }

  console.log(`\n${columnsResult.rows.length} column(s).`)

  // Show indexes
  const indexesResult = await client.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = $1 AND schemaname = 'public'
    ORDER BY indexname
  `, [tableName])

  if (indexesResult.rows.length > 0) {
    console.log('')
    console.log('Indexes:')
    for (const idx of indexesResult.rows) {
      console.log(`  - ${idx.indexname}`)
      console.log(`    ${idx.indexdef}`)
    }
  }

  // Show row count
  const countResult = await client.query(`SELECT COUNT(*) as count FROM ${tableName}`)
  console.log('')
  console.log(`Total rows: ${countResult.rows[0].count}`)
}

async function main() {
  const command = process.argv[2]
  const subcommand = process.argv[3]
  const tableName = process.argv[4]

  try {
    await client.connect()

    if (command === 'tables' && subcommand === 'list') {
      await listTables()
    } else if (command === 'tables' && subcommand === 'describe' && tableName) {
      await describeTable(tableName)
    } else if (command === 'tables' && subcommand === 'describe') {
      console.error('Usage: bun run scripts/schema-cli.ts tables describe <table_name>')
      process.exit(1)
    } else if (command === 'tables') {
      console.error('Usage: bun run scripts/schema-cli.ts tables <list|describe> [table_name]')
      process.exit(1)
    } else {
      console.error('Usage: bun run scripts/schema-cli.ts tables <list|describe> [table_name]')
      console.error('')
      console.error('Examples:')
      console.error('  bun run scripts/schema-cli.ts tables list                    # List all tables')
      console.error('  bun run scripts/schema-cli.ts tables describe canonical_message  # Show table schema')
      process.exit(1)
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error)
    process.exit(1)
  } finally {
    await client.end()
  }
}

main()
