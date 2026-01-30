#!/usr/bin/env bun
/**
 * Derived Task: Conversation Digests
 *
 * Creates or updates conversation digests from canonical conversations.
 * Uses derived_processing_log for idempotence and staleness detection.
 */

import { createHash } from 'node:crypto'
import type { DerivedRunContext, DerivedRunResult, DerivedMetadataSchema } from '../src/derived/runner.js'
import { generateCanonicalId } from '../src/ids.js'
import { stableStringify } from '../src/stable-stringify.js'

export const metadata: DerivedMetadataSchema = {
  fields: {
    maxConversations: { type: 'number', default: 500, description: 'Max conversations per run' },
    summaryMaxLength: { type: 'number', default: 280, description: 'Max summary length' },
    processorVersion: { type: 'string', default: 'v1', description: 'Digest processor version' },
    modelVersion: { type: 'string', default: 'local', description: 'Model version used' },
  },
}

function computeConfigHash(input: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex').slice(0, 16)
}

function buildSummary(fields: Array<string | null | undefined>, maxLength: number): string {
  const raw = fields.find((value) => value && value.trim().length > 0)?.trim() || ''
  const base = raw.length > 0 ? raw.replace(/\s+/g, ' ') : 'Conversation summary unavailable'
  if (base.length <= maxLength) return base
  return base.slice(0, Math.max(0, maxLength - 3)) + '...'
}

export async function run(ctx: DerivedRunContext): Promise<DerivedRunResult> {
  const { sql, task, job, processingLog, logger } = ctx

  const config = task.metadata as Record<string, unknown> | undefined
  const maxConversations = (config?.maxConversations as number) ?? 500
  const summaryMaxLength = (config?.summaryMaxLength as number) ?? 280
  const processorVersion = (config?.processorVersion as string) ?? 'v1'
  const modelVersion = (config?.modelVersion as string) ?? 'local'

  const configHash = computeConfigHash({ maxConversations, summaryMaxLength, processorVersion, modelVersion })

  logger.info(`Conversation digest run (job: ${job.id}, limit: ${maxConversations})`)

  const processedMap = await processingLog.findProcessedEntityIds(configHash, 'conversation')

  const rows = await sql<Array<{
    id: string
    updated_at: Date
    source_timestamp: Date | null
    display_text: string | null
    title: string | null
    subject: string | null
  }>>`
    SELECT
      id,
      updated_at,
      source_timestamp,
      display_text,
      data->>'title' as title,
      data->>'subject' as subject
    FROM canonical_conversation
    ORDER BY source_timestamp DESC NULLS LAST, updated_at DESC
    LIMIT ${maxConversations}
  `

  let processed = 0
  let skipped = 0
  let failed = 0

  const logEntries: Array<{
    entityId: string
    entityType: 'conversation'
    configHash: string
    status: 'success' | 'failed'
    error?: string
    entityUpdatedAt?: Date
  }> = []

  for (const row of rows) {
    const entityUpdatedAt = row.source_timestamp ?? row.updated_at
    const prior = processedMap.get(row.id)
    if (prior?.entity_updated_at) {
      const prev = new Date(prior.entity_updated_at).getTime()
      if (entityUpdatedAt && prev >= entityUpdatedAt.getTime()) {
        skipped++
        continue
      }
    }

    try {
      const summary = buildSummary([row.display_text, row.title, row.subject], summaryMaxLength)
      const digestId = generateCanonicalId()

      await sql`
        INSERT INTO conversation_digests (
          id,
          conversation_id,
          summary,
          decisions,
          outcome,
          processor_version,
          model_version
        ) VALUES (
          ${digestId},
          ${row.id},
          ${summary},
          ${sql.json([])},
          ${null},
          ${processorVersion},
          ${modelVersion}
        )
        ON CONFLICT (conversation_id)
        DO UPDATE SET
          summary = EXCLUDED.summary,
          decisions = EXCLUDED.decisions,
          outcome = EXCLUDED.outcome,
          processor_version = EXCLUDED.processor_version,
          model_version = EXCLUDED.model_version,
          updated_at = NOW()
      `

      logEntries.push({
        entityId: row.id,
        entityType: 'conversation',
        configHash,
        status: 'success',
        entityUpdatedAt,
      })
      processed++
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(`Digest failed for conversation ${row.id}: ${message}`)
      logEntries.push({
        entityId: row.id,
        entityType: 'conversation',
        configHash,
        status: 'failed',
        error: message,
        entityUpdatedAt,
      })
      failed++
    }
  }

  if (logEntries.length > 0) {
    await processingLog.markBatch(logEntries)
  }

  logger.info(`Digest run complete: processed=${processed}, skipped=${skipped}, failed=${failed}`)

  return {
    metadata: {
      processed,
      skipped,
      failed,
      processorVersion,
      modelVersion,
      configHash,
    },
  }
}
