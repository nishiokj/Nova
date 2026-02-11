/**
 * Entity Graph Queries
 *
 * Pre-built query functions for querying the entity graph.
 * All accept a postgres Sql instance and return typed results.
 */

import type { Sql } from 'postgres'
import type { Entity, EntityKind, GraphStats } from './types.js'

// --- Row type from Postgres ---

interface EntityRow {
  id: string
  kind: string
  name: string
  filepath: string
  start_line: number | null
  end_line: number | null
  exported: boolean
  async: boolean
  raw_text: string | null
}

function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    kind: row.kind as EntityKind,
    name: row.name,
    filepath: row.filepath,
    startLine: row.start_line,
    endLine: row.end_line,
    exported: row.exported,
    async: row.async,
    rawText: row.raw_text,
  }
}

// --- Query Functions ---

/**
 * Get all entities defined in a file.
 */
export async function entitiesInFile(sql: Sql, filepath: string): Promise<Entity[]> {
  const rows = await sql<EntityRow[]>`
    SELECT * FROM entity_graph.entities WHERE filepath = ${filepath}
    ORDER BY start_line ASC NULLS LAST
  `
  return rows.map(rowToEntity)
}

/**
 * Get an entity by its composite ID.
 */
export async function entityById(sql: Sql, id: string): Promise<Entity | null> {
  const [row] = await sql<EntityRow[]>`
    SELECT * FROM entity_graph.entities WHERE id = ${id}
  `
  return row ? rowToEntity(row) : null
}

/**
 * Find all entities that import from a given file.
 * Returns the entities (typically file entities) that have import edges
 * pointing to entities within the target file.
 */
export async function importersOfFile(sql: Sql, filepath: string): Promise<Entity[]> {
  const rows = await sql<EntityRow[]>`
    SELECT DISTINCT e.* FROM entity_graph.entities e
    JOIN entity_graph.imports i ON i.importer_id = e.id
    WHERE i.imported_id IN (
      SELECT id FROM entity_graph.entities WHERE filepath = ${filepath}
    )
  `
  return rows.map(rowToEntity)
}

/**
 * Find all entities that call a given function/method.
 */
export async function callersOf(sql: Sql, entityId: string): Promise<Entity[]> {
  const rows = await sql<EntityRow[]>`
    SELECT DISTINCT e.* FROM entity_graph.entities e
    JOIN entity_graph.calls c ON c.caller_id = e.id
    WHERE c.callee_id = ${entityId}
  `
  return rows.map(rowToEntity)
}

/**
 * Find all entities that use a given type/interface.
 */
export async function usersOf(sql: Sql, entityId: string): Promise<Entity[]> {
  const rows = await sql<EntityRow[]>`
    SELECT DISTINCT e.* FROM entity_graph.entities e
    JOIN entity_graph.uses u ON u.user_id = e.id
    WHERE u.used_id = ${entityId}
  `
  return rows.map(rowToEntity)
}

/**
 * Compute the blast radius for a file change.
 * Returns all filepaths transitively affected by changes to the given file,
 * following imports, calls, uses, extends, and implements edges up to maxDepth hops.
 */
export async function blastRadius(
  sql: Sql,
  filepath: string,
  maxDepth: number = 1,
): Promise<string[]> {
  const rows = await sql<{ filepath: string }[]>`
    WITH RECURSIVE affected AS (
      -- Seed: entities in the changed file
      SELECT id, filepath, 0 AS depth
      FROM entity_graph.entities
      WHERE filepath = ${filepath}

      UNION

      -- Recurse: entities that depend on already-affected entities
      SELECT DISTINCT e.id, e.filepath, a.depth + 1
      FROM affected a
      JOIN (
        SELECT importer_id AS dependent_id, imported_id AS dependency_id FROM entity_graph.imports
        UNION ALL
        SELECT caller_id, callee_id FROM entity_graph.calls
        UNION ALL
        SELECT user_id, used_id FROM entity_graph.uses
        UNION ALL
        SELECT child_id, parent_id FROM entity_graph.extends
        UNION ALL
        SELECT implementor_id, interface_id FROM entity_graph.implements
      ) edges ON edges.dependency_id = a.id
      JOIN entity_graph.entities e ON e.id = edges.dependent_id
      WHERE a.depth < ${maxDepth}
    )
    SELECT DISTINCT filepath FROM affected
    WHERE filepath != ${filepath}
  `
  return rows.map(r => r.filepath)
}

/**
 * Find dependents of a specific entity, filtered by kind.
 * Uses kind-specific edge lookups for targeted queries.
 */
export async function dependentsOf(
  sql: Sql,
  entityId: string,
  entityKind: EntityKind
): Promise<Entity[]> {
  let rows: EntityRow[]

  switch (entityKind) {
    case 'file':
      // Who imports entities from this file?
      rows = await sql<EntityRow[]>`
        SELECT DISTINCT e.* FROM entity_graph.entities e
        JOIN entity_graph.imports i ON i.importer_id = e.id
        WHERE i.imported_id = ${entityId}
      `
      break

    case 'function':
    case 'method':
      // Who calls this?
      rows = await sql<EntityRow[]>`
        SELECT DISTINCT e.* FROM entity_graph.entities e
        JOIN entity_graph.calls c ON c.caller_id = e.id
        WHERE c.callee_id = ${entityId}
      `
      break

    case 'type':
    case 'interface':
      // Who uses, imports, or implements this?
      rows = await sql<EntityRow[]>`
        SELECT DISTINCT e.* FROM entity_graph.entities e
        WHERE e.id IN (
          SELECT user_id FROM entity_graph.uses WHERE used_id = ${entityId}
          UNION
          SELECT implementor_id FROM entity_graph.implements WHERE interface_id = ${entityId}
          UNION
          SELECT importer_id FROM entity_graph.imports WHERE imported_id = ${entityId}
        )
      `
      break

    case 'class':
      // Who extends, imports, or uses this?
      rows = await sql<EntityRow[]>`
        SELECT DISTINCT e.* FROM entity_graph.entities e
        WHERE e.id IN (
          SELECT child_id FROM entity_graph.extends WHERE parent_id = ${entityId}
          UNION
          SELECT importer_id FROM entity_graph.imports WHERE imported_id = ${entityId}
        )
      `
      break

    default:
      rows = []
  }

  return rows.map(rowToEntity)
}

/**
 * Find exported entities with no inbound references.
 * These are candidates for dead code — exported but never imported,
 * called, used, extended, or implemented by anything in the graph.
 * Excludes 'file' entities (files are structural, not "exports").
 */
export async function unusedExports(sql: Sql, filepath?: string): Promise<Entity[]> {
  const rows = filepath
    ? await sql<EntityRow[]>`
        SELECT e.* FROM entity_graph.entities e
        WHERE e.exported = true
          AND e.kind != 'file'
          AND e.filepath = ${filepath}
          AND NOT EXISTS (SELECT 1 FROM entity_graph.imports WHERE imported_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM entity_graph.calls WHERE callee_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM entity_graph.uses WHERE used_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM entity_graph.extends WHERE parent_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM entity_graph.implements WHERE interface_id = e.id)
        ORDER BY e.filepath, e.start_line ASC NULLS LAST
      `
    : await sql<EntityRow[]>`
        SELECT e.* FROM entity_graph.entities e
        WHERE e.exported = true
          AND e.kind != 'file'
          AND NOT EXISTS (SELECT 1 FROM entity_graph.imports WHERE imported_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM entity_graph.calls WHERE callee_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM entity_graph.uses WHERE used_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM entity_graph.extends WHERE parent_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM entity_graph.implements WHERE interface_id = e.id)
        ORDER BY e.filepath, e.start_line ASC NULLS LAST
      `
  return rows.map(rowToEntity)
}

/**
 * Get aggregate stats for the entity graph.
 */
export async function graphStats(sql: Sql): Promise<GraphStats> {
  const [counts] = await sql<[{
    entities: string
    imports: string
    calls: string
    uses: string
    owns: string
    extends: string
    implements: string
    file_leases: string
  }]>`
    SELECT
      (SELECT count(*) FROM entity_graph.entities)::text AS entities,
      (SELECT count(*) FROM entity_graph.imports)::text AS imports,
      (SELECT count(*) FROM entity_graph.calls)::text AS calls,
      (SELECT count(*) FROM entity_graph.uses)::text AS uses,
      (SELECT count(*) FROM entity_graph.owns)::text AS owns,
      (SELECT count(*) FROM entity_graph.extends)::text AS extends,
      (SELECT count(*) FROM entity_graph.implements)::text AS implements,
      (SELECT count(*) FROM entity_graph.file_leases)::text AS file_leases
  `

  return {
    entities: parseInt(counts.entities, 10),
    imports: parseInt(counts.imports, 10),
    calls: parseInt(counts.calls, 10),
    uses: parseInt(counts.uses, 10),
    owns: parseInt(counts.owns, 10),
    extends: parseInt(counts.extends, 10),
    implements: parseInt(counts.implements, 10),
    fileLeases: parseInt(counts.file_leases, 10),
  }
}
