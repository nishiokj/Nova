#!/usr/bin/env bun
import { Client } from 'pg'
import { parse } from 'pg-connection-string'

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/jesus'

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

async function main() {
  const query = process.argv.slice(2).join(' ')

  if (!query) {
    console.error('Usage: bun run scripts/sql-cli.ts "<SQL_QUERY>"')
    console.error('Example: bun run scripts/sql-cli.ts "SELECT * FROM canonical_message LIMIT 10"')
    process.exit(1)
  }

  try {
    await client.connect()

    const result = await client.query(query)

    if (result.rows.length === 0) {
      console.log('No results.')
      return
    }

    // Display results as a table
    const columns = Object.keys(result.rows[0])
    const columnWidths = columns.map(col => Math.max(col.length, ...result.rows.map(row => String(row[col] ?? '').length)))

    // Print header
    console.log(columnWidths.map((width, i) => columns[i].padEnd(width)).join(' | '))
    console.log(columnWidths.map(width => '-'.repeat(width)).join('-+-'))

    // Print rows
    for (const row of result.rows) {
      console.log(columnWidths.map((width, i) => String(row[columns[i]] ?? '').padEnd(width)).join(' | '))
    }

    console.log(`\n${result.rows.length} row(s) returned.`)
  } catch (error) {
    console.error('Error executing query:', error instanceof Error ? error.message : error)
    process.exit(1)
  } finally {
    await client.end()
  }
}

main()
