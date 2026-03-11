/**
 * Entity Graph Queries
 *
 * Pre-built query functions for querying the entity graph.
 * All accept a postgres Sql instance and return typed results.
 */

import type { Sql } from 'postgres'
import type {
  Entity,
  EntityKind,
  EdgeType,
  GraphStats,
  IndexedTestCase,
  IndexedTestCaseAssertion,
  IndexedTestCaseCall,
  IndexedTestCaseImport,
  IndexedTestCaseMock,
  IndexedTestCaseSeamOverride,
} from './types.js'

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
  params_text: string | null
  return_text: string | null
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
    paramsText: row.params_text ?? null,
    returnText: row.return_text ?? null,
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
 * Find entities whose line ranges overlap any of the given ranges.
 * Bridges git diff hunks to the entity graph.
 */
export async function entitiesAtLines(
  sql: Sql,
  filepath: string,
  ranges: Array<{ startLine: number; endLine: number }>,
): Promise<Entity[]> {
  if (ranges.length === 0) return []

  // Build OR clause for overlapping ranges:
  // entity overlaps range when entity.start_line <= range.end AND entity.end_line >= range.start
  const conditions = ranges
    .map((_, i) => `(e.start_line <= $${i * 2 + 3} AND e.end_line >= $${i * 2 + 2})`)
    .join(' OR ')

  const params: (string | number)[] = [filepath]
  for (const r of ranges) {
    params.push(r.startLine, r.endLine)
  }

  const query = `
    SELECT DISTINCT e.* FROM entity_graph.entities e
    WHERE e.filepath = $1
      AND e.kind != 'file'
      AND (${conditions})
    ORDER BY e.start_line ASC NULLS LAST
  `
  const rows = await sql.unsafe<EntityRow[]>(query, params)
  return rows.map(rowToEntity)
}

/**
 * Entity-level blast radius. Given specific entity IDs, walk dependency edges
 * and return each affected entity with its depth and the edge type that linked it.
 */
export interface BlastRadiusEntry {
  entity: Entity
  depth: number
  via: EdgeType
  seedId: string
}

export async function entityBlastRadius(
  sql: Sql,
  entityIds: string[],
  maxDepth: number = 2,
): Promise<BlastRadiusEntry[]> {
  if (entityIds.length === 0) return []

  const rows = await sql<Array<EntityRow & { depth: number; via: string; seed_id: string }>>`
    WITH RECURSIVE affected AS (
      SELECT id, kind, name, filepath, start_line, end_line, exported, async, raw_text,
             0 AS depth, 'seed' AS via, id AS seed_id
      FROM entity_graph.entities
      WHERE id = ANY(${entityIds})

      UNION

      SELECT DISTINCT e.id, e.kind, e.name, e.filepath, e.start_line, e.end_line,
             e.exported, e.async, e.raw_text,
             a.depth + 1, edges.edge_type, a.seed_id
      FROM affected a
      JOIN (
        SELECT importer_id AS dependent_id, imported_id AS dependency_id, 'imports' AS edge_type FROM entity_graph.imports
        UNION ALL
        SELECT caller_id, callee_id, 'calls' FROM entity_graph.calls
        UNION ALL
        SELECT user_id, used_id, 'uses' FROM entity_graph.uses
        UNION ALL
        SELECT child_id, parent_id, 'extends' FROM entity_graph.extends
        UNION ALL
        SELECT implementor_id, interface_id, 'implements' FROM entity_graph.implements
      ) edges ON edges.dependency_id = a.id
      JOIN entity_graph.entities e ON e.id = edges.dependent_id
      WHERE a.depth < ${maxDepth}
    ),
    ranked AS (
      SELECT *,
             ROW_NUMBER() OVER (PARTITION BY id, seed_id ORDER BY depth ASC, via ASC) AS rn
      FROM affected
      WHERE via != 'seed'
    )
    SELECT * FROM ranked
    WHERE rn = 1
    ORDER BY depth ASC, filepath ASC
  `

  return rows.map(row => ({
    entity: rowToEntity(row),
    depth: row.depth,
    via: row.via as EdgeType,
    seedId: row.seed_id,
  }))
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

// --- Test Health Queries ---

/**
 * Call tree node returned by callTreeFrom.
 */
export interface CallTreeRow {
  entity: Entity
  depth: number
  sameModule: boolean
  injected: boolean
}

/**
 * Walk `calls` edges downward from a boundary entity, producing the full call tree.
 * Unlike blast radius (upward), this walks downward from an entry point.
 */
export async function callTreeFrom(
  sql: Sql,
  entityId: string,
  maxDepth: number = 10,
): Promise<CallTreeRow[]> {
  const rows = await sql<Array<EntityRow & { depth: number; root_filepath: string; injected: boolean }>>`
    WITH RECURSIVE call_tree AS (
      SELECT
        e.id, e.kind, e.name, e.filepath, e.start_line, e.end_line,
        e.exported, e.async, e.raw_text, e.params_text, e.return_text,
        0 AS depth,
        e.filepath AS root_filepath,
        false AS injected
      FROM entity_graph.entities e
      WHERE e.id = ${entityId}

      UNION

      SELECT DISTINCT
        callee.id, callee.kind, callee.name, callee.filepath,
        callee.start_line, callee.end_line, callee.exported, callee.async,
        callee.raw_text, callee.params_text, callee.return_text,
        ct.depth + 1,
        ct.root_filepath,
        callee.filepath != ct.root_filepath AS injected
      FROM call_tree ct
      JOIN entity_graph.calls c ON c.caller_id = ct.id
      JOIN entity_graph.entities callee ON callee.id = c.callee_id
      WHERE ct.depth < ${maxDepth}
    ),
    ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY depth ASC) AS rn
      FROM call_tree
      WHERE depth > 0
    )
    SELECT * FROM ranked WHERE rn = 1
    ORDER BY depth ASC, filepath ASC
  `

  return rows.map(row => ({
    entity: rowToEntity(row),
    depth: row.depth,
    sameModule: row.filepath === row.root_filepath,
    injected: row.injected,
  }))
}

/**
 * Boundary info returned by the boundaries query.
 */
export interface BoundaryRow {
  entity: Entity
  fanIn: number
}

/**
 * List all boundaries — exported entities with external callers/importers.
 * Optionally filtered to a file. Ordered by fan-in descending.
 */
export async function boundaries(
  sql: Sql,
  filepath?: string,
): Promise<BoundaryRow[]> {
  const rows = await sql<Array<EntityRow & { fan_in: string }>>`
    SELECT
      e.*,
      (
        SELECT COUNT(DISTINCT caller.filepath)
        FROM entity_graph.calls c
        JOIN entity_graph.entities caller ON caller.id = c.caller_id
        WHERE c.callee_id = e.id AND caller.filepath != e.filepath
      ) +
      (
        SELECT COUNT(DISTINCT imp.filepath)
        FROM entity_graph.imports i
        JOIN entity_graph.entities imp ON imp.id = i.importer_id
        JOIN entity_graph.entities target_file ON target_file.id = i.imported_id
        WHERE target_file.filepath = e.filepath
          AND i.symbol = e.name
          AND imp.filepath != e.filepath
      ) AS fan_in
    FROM entity_graph.entities e
    WHERE e.exported = true
      AND e.kind IN ('function', 'method', 'class')
      AND (${filepath ?? null}::text IS NULL OR e.filepath = ${filepath ?? null})
      AND (
        EXISTS (SELECT 1 FROM entity_graph.calls c
                JOIN entity_graph.entities caller ON caller.id = c.caller_id
                WHERE c.callee_id = e.id AND caller.filepath != e.filepath)
        OR EXISTS (SELECT 1 FROM entity_graph.imports i
                   JOIN entity_graph.entities imp ON imp.id = i.importer_id
                   JOIN entity_graph.entities target_file ON target_file.id = i.imported_id
                   WHERE target_file.filepath = e.filepath
                     AND i.symbol = e.name
                     AND imp.filepath != e.filepath)
      )
    ORDER BY fan_in DESC, e.filepath, e.start_line
  `

  return rows.map(row => ({
    entity: rowToEntity(row),
    fanIn: parseInt(row.fan_in, 10),
  }))
}

/**
 * Env var info returned by envVarsInTree.
 */
export interface EnvVarRow {
  varName: string
  accessor: string
  entityId: string
  filepath: string
  line: number | null
}

/**
 * Find all env vars read anywhere in a boundary's call tree.
 */
export async function envVarsInTree(
  sql: Sql,
  entityId: string,
  maxDepth: number = 10,
): Promise<EnvVarRow[]> {
  const rows = await sql<Array<{ var_name: string; accessor: string; entity_id: string; filepath: string; line: number | null }>>`
    WITH RECURSIVE call_tree AS (
      SELECT e.id, e.filepath, 0 AS depth
      FROM entity_graph.entities e
      WHERE e.id = ${entityId}

      UNION

      SELECT DISTINCT callee.id, callee.filepath, ct.depth + 1
      FROM call_tree ct
      JOIN entity_graph.calls c ON c.caller_id = ct.id
      JOIN entity_graph.entities callee ON callee.id = c.callee_id
      WHERE ct.depth < ${maxDepth}
    )
    SELECT DISTINCT er.var_name, er.accessor, er.entity_id, er.filepath, er.line
    FROM call_tree ct
    JOIN entity_graph.env_reads er ON er.entity_id = ct.id
    ORDER BY er.var_name
  `

  return rows.map(r => ({
    varName: r.var_name,
    accessor: r.accessor,
    entityId: r.entity_id,
    filepath: r.filepath,
    line: r.line,
  }))
}

/**
 * Dep info returned by depsOf.
 */
export interface DepRow {
  paramName: string
  paramType: string | null
  position: number
}

/**
 * Get the injectable dependencies of a boundary — constructor params for classes,
 * function params for functions/methods.
 */
export async function depsOf(
  sql: Sql,
  entityId: string,
): Promise<DepRow[]> {
  // Determine entity kind to pick the right table
  const [entity] = await sql<[{ kind: string }?]>`
    SELECT kind FROM entity_graph.entities WHERE id = ${entityId}
  `
  if (!entity) return []

  if (entity.kind === 'class') {
    // Constructor deps
    const rows = await sql<Array<{ param_name: string; param_type: string | null; position: number }>>`
      SELECT param_name, param_type, position
      FROM entity_graph.constructor_deps
      WHERE class_id = ${entityId}
      ORDER BY position
    `
    return rows.map(r => ({ paramName: r.param_name, paramType: r.param_type, position: r.position }))
  }

  // Function/method deps
  const rows = await sql<Array<{ param_name: string; param_type: string | null; position: number }>>`
    SELECT param_name, param_type, position
    FROM entity_graph.function_deps
    WHERE function_id = ${entityId}
    ORDER BY position
  `
  return rows.map(r => ({ paramName: r.param_name, paramType: r.param_type, position: r.position }))
}

/**
 * Find test files that import a boundary's module.
 * Test files are identified by naming convention: *.test.ts, *.spec.ts, __tests__/, test_*.
 */
export async function testFilesFor(
  sql: Sql,
  entityId: string,
): Promise<Entity[]> {
  const rows = await sql<EntityRow[]>`
    SELECT DISTINCT tf.*
    FROM entity_graph.entities tf
    WHERE tf.kind = 'file'
      AND (
        tf.filepath LIKE '%.test.ts'
        OR tf.filepath LIKE '%.test.tsx'
        OR tf.filepath LIKE '%.spec.ts'
        OR tf.filepath LIKE '%.spec.tsx'
        OR tf.filepath LIKE '%.test.js'
        OR tf.filepath LIKE '%.test.jsx'
        OR tf.filepath LIKE '%.spec.js'
        OR tf.filepath LIKE '%.spec.jsx'
        OR tf.filepath LIKE '%/__tests__/%'
        OR tf.filepath LIKE '%test_%'
      )
      AND EXISTS (
        SELECT 1 FROM entity_graph.imports i
        WHERE i.importer_id = tf.id
          AND i.imported_id IN (
            SELECT id FROM entity_graph.entities WHERE filepath = (
              SELECT filepath FROM entity_graph.entities WHERE id = ${entityId}
            )
          )
      )
  `
  return rows.map(rowToEntity)
}

export interface IndexedTestFactsBundle {
  testCases: IndexedTestCase[]
  testCaseImports: IndexedTestCaseImport[]
  testCaseCalls: IndexedTestCaseCall[]
  testCaseAssertions: IndexedTestCaseAssertion[]
  testCaseMocks: IndexedTestCaseMock[]
  testCaseSeamOverrides: IndexedTestCaseSeamOverride[]
}

export async function indexedTestFactsForFiles(
  sql: Sql,
  filepaths: string[],
): Promise<IndexedTestFactsBundle> {
  if (filepaths.length === 0) {
    return {
      testCases: [],
      testCaseImports: [],
      testCaseCalls: [],
      testCaseAssertions: [],
      testCaseMocks: [],
      testCaseSeamOverrides: [],
    }
  }

  const testCases = await sql<Array<{
    id: string
    filepath: string
    name: string
    line_start: number
    line_end: number
  }>>`
    SELECT id, filepath, name, line_start, line_end
    FROM entity_graph.test_cases
    WHERE filepath = ANY(${filepaths})
    ORDER BY filepath ASC, line_start ASC, line_end ASC
  `

  const testCaseIds = testCases.map(row => row.id)
  if (testCaseIds.length === 0) {
    return {
      testCases: [],
      testCaseImports: [],
      testCaseCalls: [],
      testCaseAssertions: [],
      testCaseMocks: [],
      testCaseSeamOverrides: [],
    }
  }

  const [testCaseImports, testCaseCalls, testCaseAssertions, testCaseMocks, testCaseSeamOverrides] = await Promise.all([
    sql<Array<{
      test_case_id: string
      local_name: string
      imported_name: string
      resolved_path: string | null
      is_prod: boolean
    }>>`
      SELECT test_case_id, local_name, imported_name, resolved_path, is_prod
      FROM entity_graph.test_case_imports
      WHERE test_case_id = ANY(${testCaseIds})
      ORDER BY test_case_id ASC, local_name ASC, imported_name ASC
    `,
    sql<Array<{
      test_case_id: string
      kind: string
      symbol: string
      resolved_path: string | null
      line: number
    }>>`
      SELECT test_case_id, kind, symbol, resolved_path, line
      FROM entity_graph.test_case_calls
      WHERE test_case_id = ANY(${testCaseIds})
      ORDER BY test_case_id ASC, line ASC
    `,
    sql<Array<{
      test_case_id: string
      kind: string
      target_symbol: string | null
      resolved_path: string | null
      line: number
    }>>`
      SELECT test_case_id, kind, target_symbol, resolved_path, line
      FROM entity_graph.test_case_assertions
      WHERE test_case_id = ANY(${testCaseIds})
      ORDER BY test_case_id ASC, line ASC
    `,
    sql<Array<{
      test_case_id: string
      kind: string
      api: string
      target: string | null
      line: number
    }>>`
      SELECT test_case_id, kind, api, target, line
      FROM entity_graph.test_case_mocks
      WHERE test_case_id = ANY(${testCaseIds})
      ORDER BY test_case_id ASC, line ASC
    `,
    sql<Array<{
      test_case_id: string
      kind: string
      target: string
      line: number
    }>>`
      SELECT test_case_id, kind, target, line
      FROM entity_graph.test_case_seam_overrides
      WHERE test_case_id = ANY(${testCaseIds})
      ORDER BY test_case_id ASC, line ASC
    `,
  ])

  return {
    testCases: testCases.map(row => ({
      id: row.id,
      filepath: row.filepath,
      name: row.name,
      lineStart: row.line_start,
      lineEnd: row.line_end,
    })),
    testCaseImports: testCaseImports.map(row => ({
      testCaseId: row.test_case_id,
      localName: row.local_name,
      importedName: row.imported_name,
      resolvedPath: row.resolved_path,
      isProd: row.is_prod,
    })),
    testCaseCalls: testCaseCalls.map(row => ({
      testCaseId: row.test_case_id,
      kind: row.kind as IndexedTestCaseCall['kind'],
      symbol: row.symbol,
      resolvedPath: row.resolved_path,
      line: row.line,
    })),
    testCaseAssertions: testCaseAssertions.map(row => ({
      testCaseId: row.test_case_id,
      kind: row.kind as IndexedTestCaseAssertion['kind'],
      targetSymbol: row.target_symbol,
      resolvedPath: row.resolved_path,
      line: row.line,
    })),
    testCaseMocks: testCaseMocks.map(row => ({
      testCaseId: row.test_case_id,
      kind: row.kind as IndexedTestCaseMock['kind'],
      api: row.api,
      target: row.target,
      line: row.line,
    })),
    testCaseSeamOverrides: testCaseSeamOverrides.map(row => ({
      testCaseId: row.test_case_id,
      kind: row.kind as IndexedTestCaseSeamOverride['kind'],
      target: row.target,
      line: row.line,
    })),
  }
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
