/**
 * Derived Processing Log Repository
 *
 * Tracks which entities have been processed by derived tasks.
 * Enables skip-already-processed, automatic retry of failures,
 * and reprocessing when config (prompt) changes via config_hash.
 */

import { generateCanonicalId } from '../../ids.js'
import type { RepositoryContext } from './types.js'

export interface DerivedProcessingLogRow {
  id: string
  task_id: string
  job_id: string
  entity_id: string
  entity_type: string
  config_hash: string
  status: string
  error: string | null
  entity_updated_at: Date | null
  processed_at: Date
}

export interface DerivedProcessingLogEntry {
  id: string
  task_id: string
  job_id: string
  entity_id: string
  entity_type: string
  config_hash: string
  status: 'success' | 'failed'
  error?: string
  entity_updated_at?: string
  processed_at: string
}

function rowToEntry(row: DerivedProcessingLogRow): DerivedProcessingLogEntry {
  return {
    id: row.id,
    task_id: row.task_id,
    job_id: row.job_id,
    entity_id: row.entity_id,
    entity_type: row.entity_type,
    config_hash: row.config_hash,
    status: row.status as 'success' | 'failed',
    error: row.error ?? undefined,
    entity_updated_at: row.entity_updated_at?.toISOString(),
    processed_at: row.processed_at.toISOString(),
  }
}

export interface MarkProcessedInput {
  taskId: string
  jobId: string
  entityId: string
  entityType: string
  configHash: string
  status: 'success' | 'failed'
  error?: string
  entityUpdatedAt?: Date
}

export interface ProcessingLogStats {
  total: number
  success: number
  failed: number
}

export interface DerivedProcessingLogRepository {
  markProcessed(input: MarkProcessedInput): Promise<DerivedProcessingLogEntry>
  markBatch(entries: MarkProcessedInput[]): Promise<void>
  findProcessedEntityIds(
    taskId: string,
    configHash: string,
    entityType: string
  ): Promise<Map<string, { entity_updated_at?: string }>>
  getStats(taskId: string, configHash: string): Promise<ProcessingLogStats>
}

export function createDerivedProcessingLogRepository(
  ctx: RepositoryContext
): DerivedProcessingLogRepository {
  const { sql } = ctx

  return {
    async markProcessed(input) {
      const id = generateCanonicalId()
      const now = new Date()

      const [row] = await sql<DerivedProcessingLogRow[]>`
        INSERT INTO derived_processing_log (
          id, task_id, job_id, entity_id, entity_type, config_hash,
          status, error, entity_updated_at, processed_at
        ) VALUES (
          ${id},
          ${input.taskId},
          ${input.jobId},
          ${input.entityId},
          ${input.entityType},
          ${input.configHash},
          ${input.status},
          ${input.error ?? null},
          ${input.entityUpdatedAt ?? null},
          ${now}
        )
        ON CONFLICT (task_id, entity_id, entity_type, config_hash)
        DO UPDATE SET
          job_id = EXCLUDED.job_id,
          status = EXCLUDED.status,
          error = EXCLUDED.error,
          entity_updated_at = EXCLUDED.entity_updated_at,
          processed_at = EXCLUDED.processed_at
        RETURNING *
      `

      return rowToEntry(row)
    },

    async markBatch(entries) {
      if (entries.length === 0) return

      const rows = entries.map((e) => ({
        id: generateCanonicalId(),
        task_id: e.taskId,
        job_id: e.jobId,
        entity_id: e.entityId,
        entity_type: e.entityType,
        config_hash: e.configHash,
        status: e.status,
        error: e.error ?? null,
        entity_updated_at: e.entityUpdatedAt ?? null,
        processed_at: new Date(),
      }))

      await sql`
        INSERT INTO derived_processing_log ${sql(rows)}
        ON CONFLICT (task_id, entity_id, entity_type, config_hash)
        DO UPDATE SET
          job_id = EXCLUDED.job_id,
          status = EXCLUDED.status,
          error = EXCLUDED.error,
          entity_updated_at = EXCLUDED.entity_updated_at,
          processed_at = EXCLUDED.processed_at
      `
    },

    async findProcessedEntityIds(taskId, configHash, entityType) {
      const rows = await sql<{ entity_id: string; entity_updated_at: Date | null }[]>`
        SELECT entity_id, entity_updated_at
        FROM derived_processing_log
        WHERE task_id = ${taskId}
          AND config_hash = ${configHash}
          AND entity_type = ${entityType}
          AND status = 'success'
      `

      const map = new Map<string, { entity_updated_at?: string }>()
      for (const row of rows) {
        map.set(row.entity_id, {
          entity_updated_at: row.entity_updated_at?.toISOString(),
        })
      }
      return map
    },

    async getStats(taskId, configHash) {
      const [row] = await sql<{ total: string; success: string; failed: string }[]>`
        SELECT
          COUNT(*)::text AS total,
          COUNT(*) FILTER (WHERE status = 'success')::text AS success,
          COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
        FROM derived_processing_log
        WHERE task_id = ${taskId}
          AND config_hash = ${configHash}
      `

      return {
        total: parseInt(row.total, 10),
        success: parseInt(row.success, 10),
        failed: parseInt(row.failed, 10),
      }
    },
  }
}
