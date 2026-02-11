/**
 * Parse Pipeline
 *
 * Orchestrates parsing source files into entities/edges and persisting
 * them to Postgres. Uses provenance-based wipe-and-replace: when a file
 * is re-parsed, all its old entities and edges are deleted first.
 */

import { readFile } from 'fs/promises'
import fg from 'fast-glob'
import path from 'path'
import Parser from 'tree-sitter'
import type { Sql } from 'postgres'
import type { ParseResult, EntityGraphConfig, EdgeType, Edge } from './types.js'
import { languageForFile, createParser } from './parser/parser.js'
import { extract } from './parser/extractor.js'

// Language objects for query construction
import TypeScript from 'tree-sitter-typescript'
import JavaScript from 'tree-sitter-javascript'
import type { SupportedLanguage } from './parser/parser.js'

const { typescript: TSLanguage, tsx: TSXLanguage } = TypeScript

const LANGUAGE_OBJECTS: Record<SupportedLanguage, Parser.Language> = {
  typescript: TSLanguage as unknown as Parser.Language,
  tsx: TSXLanguage as unknown as Parser.Language,
  javascript: JavaScript as unknown as Parser.Language,
  jsx: JavaScript as unknown as Parser.Language,
}

// --- Edge table mapping ---

const EDGE_TABLE_MAP: Record<EdgeType, string> = {
  imports: 'entity_graph.imports',
  calls: 'entity_graph.calls',
  uses: 'entity_graph.uses',
  owns: 'entity_graph.owns',
  extends: 'entity_graph.extends',
  implements: 'entity_graph.implements',
}

// Column names per edge table
const EDGE_COLUMNS: Record<EdgeType, { source: string; target: string; extra?: string[] }> = {
  imports: { source: 'importer_id', target: 'imported_id', extra: ['symbol'] },
  calls: { source: 'caller_id', target: 'callee_id', extra: ['site_line'] },
  uses: { source: 'user_id', target: 'used_id' },
  owns: { source: 'owner_id', target: 'owned_id' },
  extends: { source: 'child_id', target: 'parent_id' },
  implements: { source: 'implementor_id', target: 'interface_id' },
}

/**
 * Parse a single source file into entities and edges.
 * Returns null if the file is not a supported language.
 */
export async function parseFile(filepath: string, sourceRoot: string): Promise<ParseResult | null> {
  const lang = languageForFile(filepath)
  if (!lang) return null

  const absPath = path.isAbsolute(filepath) ? filepath : path.resolve(sourceRoot, filepath)
  const relPath = path.relative(sourceRoot, absPath)

  let source: string
  try {
    source = await readFile(absPath, 'utf-8')
  } catch {
    return null
  }

  const parser = createParser(lang)
  const tree = parser.parse(source)
  const tsLanguage = LANGUAGE_OBJECTS[lang]

  return extract(tree, relPath, lang, tsLanguage, sourceRoot)
}

/**
 * Persist a ParseResult to Postgres.
 * Runs in a single transaction: deletes old entities/edges for the file,
 * then bulk-inserts the new ones.
 */
export async function persistParseResult(sql: Sql, result: ParseResult): Promise<void> {
  await sql.begin(async (tx) => {
    // 1. Wipe old contribution — SELECT old IDs, then pipeline all DELETEs
    const entityIds = await tx.unsafe(
      `SELECT id FROM entity_graph.entities WHERE filepath = $1`,
      [result.filepath]
    ) as { id: string }[]
    const ids = entityIds.map(r => r.id)

    if (ids.length > 0) {
      const idList = ids.map((_, i) => `$${i + 1}`).join(',')
      // Pipeline edge table deletes — both source and target sides
      await Promise.all([
        tx.unsafe(`DELETE FROM entity_graph.imports WHERE importer_id IN (${idList})`, ids),
        tx.unsafe(`DELETE FROM entity_graph.imports WHERE imported_id IN (${idList})`, ids),
        tx.unsafe(`DELETE FROM entity_graph.calls WHERE caller_id IN (${idList})`, ids),
        tx.unsafe(`DELETE FROM entity_graph.calls WHERE callee_id IN (${idList})`, ids),
        tx.unsafe(`DELETE FROM entity_graph.uses WHERE user_id IN (${idList})`, ids),
        tx.unsafe(`DELETE FROM entity_graph.uses WHERE used_id IN (${idList})`, ids),
        tx.unsafe(`DELETE FROM entity_graph.owns WHERE owner_id IN (${idList})`, ids),
        tx.unsafe(`DELETE FROM entity_graph.owns WHERE owned_id IN (${idList})`, ids),
        tx.unsafe(`DELETE FROM entity_graph.extends WHERE child_id IN (${idList})`, ids),
        tx.unsafe(`DELETE FROM entity_graph.extends WHERE parent_id IN (${idList})`, ids),
        tx.unsafe(`DELETE FROM entity_graph.implements WHERE implementor_id IN (${idList})`, ids),
        tx.unsafe(`DELETE FROM entity_graph.implements WHERE interface_id IN (${idList})`, ids),
      ])
    }
    await tx.unsafe(`DELETE FROM entity_graph.entities WHERE filepath = $1`, [result.filepath])

    // 2. Bulk insert entities — single multi-row VALUES statement
    if (result.entities.length > 0) {
      const ENTITY_COLS = 9
      const values = result.entities
        .map((_, i) => {
          const b = i * ENTITY_COLS
          return `(${Array.from({ length: ENTITY_COLS }, (_, j) => `$${b + j + 1}`).join(',')})`
        })
        .join(',')
      const params = result.entities.flatMap(e => [
        e.id, e.kind, e.name, e.filepath, e.startLine, e.endLine, e.exported, e.async, e.rawText,
      ])
      await tx.unsafe(
        `INSERT INTO entity_graph.entities (id, kind, name, filepath, start_line, end_line, exported, async, raw_text)
         VALUES ${values}
         ON CONFLICT (id) DO UPDATE SET
           kind = EXCLUDED.kind, name = EXCLUDED.name, filepath = EXCLUDED.filepath,
           start_line = EXCLUDED.start_line, end_line = EXCLUDED.end_line,
           exported = EXCLUDED.exported, async = EXCLUDED.async, raw_text = EXCLUDED.raw_text`,
        params,
      )
    }

    // 3. Bulk insert edges — one multi-row statement per edge type, pipelined
    const edgesByType = new Map<EdgeType, Edge[]>()
    for (const edge of result.edges) {
      const group = edgesByType.get(edge.type)
      if (group) group.push(edge)
      else edgesByType.set(edge.type, [edge])
    }

    const edgeInserts: Promise<unknown>[] = []
    for (const [type, edges] of edgesByType) {
      const table = EDGE_TABLE_MAP[type]
      const cols = EDGE_COLUMNS[type]
      if (!table || !cols) continue

      if (type === 'imports') {
        const values = edges.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(',')
        const params = edges.flatMap(e => [e.sourceId, e.targetId, (e.meta?.symbol as string) ?? null])
        edgeInserts.push(tx.unsafe(
          `INSERT INTO ${table} (${cols.source}, ${cols.target}, symbol) VALUES ${values} ON CONFLICT DO NOTHING`,
          params,
        ))
      } else if (type === 'calls') {
        const values = edges.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(',')
        const params = edges.flatMap(e => [e.sourceId, e.targetId, (e.meta?.siteLine as number) ?? null])
        edgeInserts.push(tx.unsafe(
          `INSERT INTO ${table} (${cols.source}, ${cols.target}, site_line) VALUES ${values} ON CONFLICT DO NOTHING`,
          params,
        ))
      } else {
        const values = edges.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(',')
        const params = edges.flatMap(e => [e.sourceId, e.targetId])
        edgeInserts.push(tx.unsafe(
          `INSERT INTO ${table} (${cols.source}, ${cols.target}) VALUES ${values} ON CONFLICT DO NOTHING`,
          params,
        ))
      }
    }
    await Promise.all(edgeInserts)
  })
}

/**
 * Delete all entities and edges contributed by a file.
 * Used before re-inserting updated parse results.
 */
export async function deleteFileContribution(sql: Sql, filepath: string): Promise<void> {
  // Get entity IDs from this file (needed to clean edge tables)
  const entityIds = await sql<{ id: string }[]>`
    SELECT id FROM entity_graph.entities WHERE filepath = ${filepath}
  `
  const ids = entityIds.map(r => r.id)

  if (ids.length > 0) {
    // Delete all edges where this file's entities appear as source or target
    await Promise.all([
      sql`DELETE FROM entity_graph.imports WHERE importer_id = ANY(${ids})`,
      sql`DELETE FROM entity_graph.imports WHERE imported_id = ANY(${ids})`,
      sql`DELETE FROM entity_graph.calls WHERE caller_id = ANY(${ids})`,
      sql`DELETE FROM entity_graph.calls WHERE callee_id = ANY(${ids})`,
      sql`DELETE FROM entity_graph.uses WHERE user_id = ANY(${ids})`,
      sql`DELETE FROM entity_graph.uses WHERE used_id = ANY(${ids})`,
      sql`DELETE FROM entity_graph.owns WHERE owner_id = ANY(${ids})`,
      sql`DELETE FROM entity_graph.owns WHERE owned_id = ANY(${ids})`,
      sql`DELETE FROM entity_graph.extends WHERE child_id = ANY(${ids})`,
      sql`DELETE FROM entity_graph.extends WHERE parent_id = ANY(${ids})`,
      sql`DELETE FROM entity_graph.implements WHERE implementor_id = ANY(${ids})`,
      sql`DELETE FROM entity_graph.implements WHERE interface_id = ANY(${ids})`,
    ])
  }

  // Delete the entities themselves
  await sql`DELETE FROM entity_graph.entities WHERE filepath = ${filepath}`
}

/** Number of files to parse + persist concurrently during full scan */
const PARSE_CONCURRENCY = 8

/**
 * Build the full entity graph by parsing all source files matching the config.
 * Processes files with a worker pool for parallelism.
 * Returns stats about the scan.
 */
export async function buildFullGraph(
  sql: Sql,
  config: EntityGraphConfig
): Promise<{ files: number; entities: number; edges: number; durationMs: number }> {
  const start = Date.now()

  const includePatterns = config.include ?? ['**/*.{ts,tsx,js,jsx}']
  const ignorePatterns = config.exclude ?? ['**/node_modules/**', '**/dist/**', '**/.git/**']

  const files = await fg(includePatterns, {
    cwd: config.sourceRoot,
    ignore: ignorePatterns,
    absolute: false,
    onlyFiles: true,
  })

  let totalEntities = 0
  let totalEdges = 0
  let idx = 0

  async function worker() {
    while (idx < files.length) {
      const file = files[idx++]
      const result = await parseFile(file, config.sourceRoot)
      if (result) {
        await persistParseResult(sql, result)
        totalEntities += result.entities.length
        totalEdges += result.edges.length
      }
    }
  }

  const workerCount = Math.min(PARSE_CONCURRENCY, files.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return {
    files: files.length,
    entities: totalEntities,
    edges: totalEdges,
    durationMs: Date.now() - start,
  }
}
