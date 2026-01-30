#!/usr/bin/env bun
/**
 * Derive test specs from entity_graph.entities.
 *
 * Usage:
 *   bun run scripts/derive-test-specs.ts --root /path/to/repo
 */

import { parseArgs } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createDatabaseFromEnv, createRepositoryContext } from '../src/db/index.js'
import { createTestSpecsRepository } from '../src/db/repositories/test-specs.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(__dirname, '../../../')

interface CliOptions {
  root: string
  limit?: number
  verbose: boolean
}

function parseCliArgs(): CliOptions {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', short: 'r' },
      limit: { type: 'string', short: 'l' },
      verbose: { type: 'boolean', short: 'v', default: false },
    },
    allowPositionals: false,
  })
  return {
    root: values.root ? resolve(values.root) : DEFAULT_ROOT,
    limit: values.limit ? Number(values.limit) : undefined,
    verbose: values.verbose ?? false,
  }
}

function isTestName(name: string): boolean {
  return /^(test|it|describe)/i.test(name)
}

function isTestFile(filepath: string): boolean {
  return /(^|\/)(test|tests|__tests__|specs)(\/|$)/i.test(filepath) ||
    /\.(test|spec)\./i.test(filepath)
}

function humanize(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\\-]+/g, ' ')
    .trim()
}

function extractAssertions(rawText: string): Array<{ type: string; target: string; matcher: string; expected: string }> {
  const assertions: Array<{ type: string; target: string; matcher: string; expected: string }> = []
  const expectRegex = /expect\\(([^)]+)\\)\\.(\\w+)\\(([^)]*)\\)/g
  let match: RegExpExecArray | null
  while ((match = expectRegex.exec(rawText)) !== null) {
    assertions.push({
      type: 'expect',
      target: match[1],
      matcher: match[2],
      expected: match[3],
    })
  }
  return assertions
}

function deterministicId(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function main() {
  const options = parseCliArgs()
  const db = createDatabaseFromEnv()
  const sql = db.sql
  const repo = createTestSpecsRepository(createRepositoryContext(sql))

  console.log(`[derive-test-specs] root=${options.root}`)

  const candidates = await sql<{
    id: string
    name: string
    filepath: string
    raw_text: string | null
    kind: string
  }[]>`
    SELECT id, name, filepath, raw_text, kind
    FROM entity_graph.entities
    WHERE kind = 'function'
      AND (
        name ILIKE 'test%' OR name ILIKE 'it%' OR name ILIKE 'describe%' OR
        filepath ILIKE '%/test/%' OR filepath ILIKE '%/tests/%' OR filepath ILIKE '%/__tests__/%' OR
        filepath ILIKE '%.test.%' OR filepath ILIKE '%.spec.%'
      )
  `

  const limited = options.limit ? candidates.slice(0, options.limit) : candidates
  let processed = 0

  for (const entity of limited) {
    if (!isTestName(entity.name) && !isTestFile(entity.filepath)) {
      continue
    }

    const rawText = entity.raw_text ?? ''
    const assertions = extractAssertions(rawText)

    const sameFileEntities = await sql<{
      id: string
      name: string
      kind: string
    }[]>`
      SELECT id, name, kind
      FROM entity_graph.entities
      WHERE filepath = ${entity.filepath}
        AND id != ${entity.id}
        AND kind != 'file'
    `

    const testsEntityIds = sameFileEntities
      .filter((e) => !isTestName(e.name))
      .map((e) => e.id)

    const id = deterministicId(`test_spec:${entity.id}`)
    await repo.upsert({
      id,
      entity_id: entity.id,
      test_name: entity.name,
      test_suite: null,
      description: humanize(entity.name),
      assertions,
      fixtures: null,
      tests_entity_ids: testsEntityIds,
      commit_hash: null,
    })

    processed++
  }

  console.log(`[derive-test-specs] upserted ${processed} test specs`)
  await db.close()
}

main().catch((err) => {
  console.error('[derive-test-specs] failed', err)
  process.exit(1)
})
