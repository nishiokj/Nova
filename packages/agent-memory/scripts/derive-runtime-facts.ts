#!/usr/bin/env bun
/**
 * Derive runtime facts from watcher workitem logs.
 *
 * Usage:
 *   bun run scripts/derive-runtime-facts.ts --root /path/to/repo
 */

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { dirname, resolve, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createDatabaseFromEnv, createRepositoryContext } from '../src/db/index.js'
import { createRuntimeFactsRepository } from '../src/db/repositories/runtime-facts.js'

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

function toPosixPath(path: string): string {
  return path.split('\\').join('/')
}

function sanitizeText(text: string): string {
  return text
    .replace(/(sk-|rk-|pk-|whsec_|ghp_|gho_|ya29\\.)[A-Za-z0-9_\\-]+/g, '$1REDACTED')
    .replace(/(Bearer\\s+)[A-Za-z0-9_\\-\\.]+/gi, '$1REDACTED')
    .replace(/([A-Z_]*KEY=)[^\\s]+/g, '$1REDACTED')
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeText(value)
  if (Array.isArray(value)) return value.map(sanitizeUnknown)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(obj)) {
      out[key] = sanitizeUnknown(val)
    }
    return out
  }
  return value
}

function looksLikePath(value: string): boolean {
  if (value.includes('://')) return false
  return (
    value.includes('/') ||
    value.includes('\\') ||
    /\\.(ts|tsx|js|jsx|json|md|yml|yaml|sql)$/i.test(value)
  )
}

function extractPaths(value: unknown): string[] {
  const paths: string[] = []
  const visit = (val: unknown) => {
    if (typeof val === 'string') {
      if (looksLikePath(val)) paths.push(val)
      return
    }
    if (Array.isArray(val)) {
      for (const item of val) visit(item)
      return
    }
    if (val && typeof val === 'object') {
      for (const item of Object.values(val as Record<string, unknown>)) {
        visit(item)
      }
    }
  }
  visit(value)
  return paths
}

function parseSessionInfo(relPath: string): { sessionId?: string; workId?: string } {
  const parts = toPosixPath(relPath).split('/')
  const watcherIdx = parts.indexOf('.watcher')
  if (watcherIdx === -1 || parts.length < watcherIdx + 4) return {}
  const sessionId = parts[watcherIdx + 2]
  const workId = parts[watcherIdx + 4]?.replace(/\\.jsonl$/, '')
  return { sessionId, workId }
}

function deterministicId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex')
}

async function globWorkitemLogs(root: string): Promise<string[]> {
  const glob = new Bun.Glob('.watcher/**/workitems/*.jsonl')
  const results: string[] = []
  for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
    results.push(toPosixPath(file))
  }
  return results
}

async function main() {
  const options = parseCliArgs()
  const db = createDatabaseFromEnv()
  const sql = db.sql
  const repo = createRuntimeFactsRepository(createRepositoryContext(sql))

  console.log(`[derive-runtime-facts] root=${options.root}`)

  const logFiles = await globWorkitemLogs(options.root)
  const limited = options.limit ? logFiles.slice(0, options.limit) : logFiles
  let processed = 0

  const entityCache = new Map<string, string[]>()
  const resolveEntityIds = async (relativePath: string): Promise<string[]> => {
    if (entityCache.has(relativePath)) return entityCache.get(relativePath) as string[]
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM entity_graph.entities WHERE filepath = ${relativePath}
    `
    const ids = rows.map((row) => row.id)
    entityCache.set(relativePath, ids)
    return ids
  }

  for (const relPath of limited) {
    const absPath = join(options.root, relPath)
    const content = await readFile(absPath, 'utf-8')
    const lines = content.split('\\n').filter((line) => line.trim().length > 0)
    let cwd = options.root
    const { sessionId, workId } = parseSessionInfo(relPath)

    for (const line of lines) {
      let entry: any
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }

      if (entry.type === 'init' && entry.cwd) {
        cwd = entry.cwd
      }

      if (entry.type === 'status' && entry.status === 'failed') {
        const rawMessage = entry.error ? String(entry.error) : 'Work item failed'
        const message = sanitizeText(rawMessage)
        const id = deterministicId(`status:${message}`)
        await repo.upsert({
          id,
          fact_type: 'error',
          message,
          sanitized_message: message,
          context: sanitizeUnknown({ workId, sessionId, status: entry.status }),
          related_entity_ids: [],
          session_id: sessionId ?? null,
        })
        processed++
      }

      if (entry.type === 'tool_call' && entry.success === false) {
        const rawMessage = entry.resultSummary
          ? `Tool ${entry.tool} failed: ${String(entry.resultSummary)}`
          : `Tool ${entry.tool} failed`
        const message = sanitizeText(rawMessage)
        const args = sanitizeUnknown(entry.args ?? {})
        const paths = extractPaths(entry.args ?? {})
        const relatedEntityIds: string[] = []

        for (const pathValue of paths) {
          const abs = pathValue.startsWith('/')
            ? pathValue
            : resolve(cwd, pathValue)
          const relativePath = toPosixPath(relative(options.root, abs))
          if (relativePath.startsWith('..')) continue
          const ids = await resolveEntityIds(relativePath)
          relatedEntityIds.push(...ids)
        }

        const id = deterministicId(`tool:${entry.tool}:${message}:${relatedEntityIds.sort().join(',')}`)
        await repo.upsert({
          id,
          fact_type: 'error',
          message,
          sanitized_message: message,
          context: args,
          related_entity_ids: Array.from(new Set(relatedEntityIds)),
          session_id: sessionId ?? null,
        })
        processed++
      }
    }
  }

  console.log(`[derive-runtime-facts] upserted ${processed} runtime facts`)
  await db.close()
}

main().catch((err) => {
  console.error('[derive-runtime-facts] failed', err)
  process.exit(1)
})
