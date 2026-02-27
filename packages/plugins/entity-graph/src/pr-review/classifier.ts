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
        for (const e of entities) {
          if (e.kind === 'file') continue
          results.push({ entity: e, changeKind: 'entity_added', fileStatus: 'added' })
        }
        break
      }

      case 'deleted': {
        const entities = await entitiesInFile(sql, fc.filepath)
        for (const e of entities) {
          if (e.kind === 'file') continue
          results.push({ entity: e, changeKind: 'entity_deleted', fileStatus: 'deleted' })
        }
        break
      }

      case 'renamed': {
        // Old path entities deleted, new path entities added
        if (fc.oldFilepath) {
          const oldEntities = await entitiesInFile(sql, fc.oldFilepath)
          for (const e of oldEntities) {
            if (e.kind === 'file') continue
            results.push({ entity: e, changeKind: 'entity_deleted', fileStatus: 'renamed' })
          }
        }
        const newEntities = await entitiesInFile(sql, fc.filepath)
        for (const e of newEntities) {
          if (e.kind === 'file') continue
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

/**
 * Infer the change kind for a modified entity based on hunk coverage.
 *
 * Heuristic: if the hunk touches only the first 3 lines of the entity
 * (where the signature typically lives), classify as signature_changed.
 * If the entity is exported, also flag export_changed.
 * Otherwise, body_changed.
 */
function inferChangeKind(
  entity: Entity,
  ranges: Array<{ startLine: number; endLine: number }>,
): ChangeKind {
  const sigEnd = (entity.startLine ?? 0) + 2 // signature ≈ first 3 lines

  const touchesSignature = ranges.some(
    r => r.startLine <= sigEnd && r.endLine >= (entity.startLine ?? 0),
  )

  const touchesBody = ranges.some(
    r => r.endLine > sigEnd,
  )

  // Export flag toggle is a special case
  if (entity.exported && touchesSignature && !touchesBody) {
    return 'signature_changed'
  }

  if (touchesSignature) {
    return 'signature_changed'
  }

  return 'body_changed'
}
