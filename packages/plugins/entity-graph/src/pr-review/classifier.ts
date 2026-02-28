/**
 * Entity Change Classifier
 *
 * Given a set of FileChanges and the entity graph, resolves which entities
 * were affected and classifies the nature of each change.
 */

import type { Sql } from 'postgres'
import type { Entity } from '../types.js'
import { entitiesInFile, entitiesAtLines } from '../queries.js'
import type { FileChange, EntityChange, ChangeKind } from './types.js'

/**
 * Classify entity-level changes from file-level diff data.
 *
 * - added files   → all entities are 'entity_added'
 * - deleted files  → all entities are 'entity_deleted'
 * - modified files → entities overlapping hunks are classified by hunk analysis
 * - renamed files  → entities in old path are 'entity_deleted', new path 'entity_added'
 */
export async function classifyChanges(
  sql: Sql,
  fileChanges: FileChange[],
): Promise<EntityChange[]> {
  const results: EntityChange[] = []

  for (const fc of fileChanges) {
    switch (fc.status) {
      case 'added': {
        const entities = await entitiesInFile(sql, fc.filepath)
        const nonFile = entities.filter(e => e.kind !== 'file')
        if (nonFile.length === 0) {
          results.push({
            entity: syntheticFileEntity(fc.filepath),
            changeKind: 'entity_added',
            fileStatus: 'added',
          })
          break
        }
        for (const e of nonFile) {
          results.push({ entity: e, changeKind: 'entity_added', fileStatus: 'added' })
        }
        break
      }

      case 'deleted': {
        const entities = await entitiesInFile(sql, fc.filepath)
        const nonFile = entities.filter(e => e.kind !== 'file')
        if (nonFile.length === 0) {
          results.push({
            entity: syntheticFileEntity(fc.filepath),
            changeKind: 'entity_deleted',
            fileStatus: 'deleted',
          })
          break
        }
        for (const e of nonFile) {
          results.push({ entity: e, changeKind: 'entity_deleted', fileStatus: 'deleted' })
        }
        break
      }

      case 'renamed': {
        // Old path entities deleted, new path entities added
        if (fc.oldFilepath) {
          const oldEntities = await entitiesInFile(sql, fc.oldFilepath)
          const oldNonFile = oldEntities.filter(e => e.kind !== 'file')
          if (oldNonFile.length === 0) {
            results.push({
              entity: syntheticFileEntity(fc.oldFilepath),
              changeKind: 'entity_deleted',
              fileStatus: 'renamed',
            })
          }
          for (const e of oldNonFile) {
            results.push({ entity: e, changeKind: 'entity_deleted', fileStatus: 'renamed' })
          }
        }
        const newEntities = await entitiesInFile(sql, fc.filepath)
        const newNonFile = newEntities.filter(e => e.kind !== 'file')
        if (newNonFile.length === 0) {
          results.push({
            entity: syntheticFileEntity(fc.filepath),
            changeKind: 'entity_added',
            fileStatus: 'renamed',
          })
          break
        }
        for (const e of newNonFile) {
          results.push({ entity: e, changeKind: 'entity_added', fileStatus: 'renamed' })
        }
        break
      }

      case 'modified': {
        if (fc.hunks.length === 0) break

        const ranges = fc.hunks.map(h => ({
          startLine: h.newStart,
          endLine: h.newStart + Math.max(h.newCount - 1, 0),
        }))

        const touched = await entitiesAtLines(sql, fc.filepath, ranges)
        for (const entity of touched) {
          const kind = inferChangeKind(entity, ranges)
          results.push({ entity, changeKind: kind, fileStatus: 'modified' })
        }
        break
      }
    }
  }

  return results
}

function syntheticFileEntity(filepath: string): Entity {
  return {
    id: `file:${filepath}:${filepath}`,
    kind: 'file',
    name: filepath,
    filepath,
    startLine: null,
    endLine: null,
    exported: false,
    async: false,
    rawText: null,
  }
}

/**
 * Infer the change kind for a modified entity based on hunk coverage.
 *
 * Heuristic:
 * - Export line = first line of the entity (where `export` keyword lives)
 * - Signature zone = first 3 lines (declaration, params, return type)
 * - Everything after = body
 *
 * If an exported entity's hunk touches only the export line and nothing
 * deeper, classify as export_changed (module boundary risk).
 * If the hunk touches the signature zone, classify as signature_changed.
 * Otherwise, body_changed.
 */
function inferChangeKind(
  entity: Entity,
  ranges: Array<{ startLine: number; endLine: number }>,
): ChangeKind {
  const start = entity.startLine ?? 0
  const exportLine = start          // `export function foo(` lives here
  const sigEnd = start + 2          // signature ≈ first 3 lines

  const touchesExportLine = ranges.some(
    r => r.startLine <= exportLine && r.endLine >= exportLine,
  )

  const touchesSignature = ranges.some(
    r => r.startLine <= sigEnd && r.endLine >= start,
  )

  const touchesBeyondExportLine = ranges.some(
    r => r.endLine > exportLine,
  )

  // Exported entity, hunk only on the export/declaration line itself
  if (entity.exported && touchesExportLine && !touchesBeyondExportLine) {
    return 'export_changed'
  }

  if (touchesSignature) {
    return 'signature_changed'
  }

  return 'body_changed'
}
