#!/usr/bin/env bun
/**
 * Derived Task: Entity Mentions
 *
 * Extracts project/goal mentions from conversation display text.
 * Concept extraction is intentionally disabled by default.
 */

import { createHash } from 'node:crypto'
import type { DerivedRunContext, DerivedRunResult, DerivedMetadataSchema } from '../src/derived/runner.js'
import { generateCanonicalId } from '../src/ids.js'
import { stableStringify } from '../src/stable-stringify.js'

export const metadata: DerivedMetadataSchema = {
  fields: {
    maxConversations: { type: 'number', default: 500, description: 'Max conversations per run' },
    extractConcepts: { type: 'boolean', default: false, description: 'Enable concept extraction (disabled by default)' },
  },
}

function computeConfigHash(input: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex').slice(0, 16)
}

function includesCaseInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

export async function run(ctx: DerivedRunContext): Promise<DerivedRunResult> {
  const { sql, task, job, processingLog, logger } = ctx

  const config = task.metadata as Record<string, unknown> | undefined
  const maxConversations = (config?.maxConversations as number) ?? 500
  const extractConcepts = (config?.extractConcepts as boolean) ?? false

  const configHash = computeConfigHash({ maxConversations, extractConcepts })

  logger.info(`Entity mentions run (job: ${job.id}, limit: ${maxConversations})`)

  const processedMap = await processingLog.findProcessedEntityIds(configHash, 'conversation')

  const projects = await sql<Array<{ id: string; name: string }>>`
    SELECT id, name FROM projects
  `
  const goals = await sql<Array<{ id: string; title: string }>>`
    SELECT id, title FROM goals
  `

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
  let mentionsWritten = 0

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
      const text = (row.display_text ?? row.title ?? row.subject ?? '').trim()
      const newMentions: Array<{
        id: string
        conversation_id: string
        entity_type: 'project' | 'goal'
        entity_id: string
        surface_form: string
        message_ids: string[]
        confidence: number
      }> = []

      if (text.length > 0) {
        for (const project of projects) {
          if (includesCaseInsensitive(text, project.name)) {
            newMentions.push({
              id: generateCanonicalId(),
              conversation_id: row.id,
              entity_type: 'project',
              entity_id: project.id,
              surface_form: project.name,
              message_ids: [],
              confidence: 0.9,
            })
          }
        }

        for (const goal of goals) {
          if (includesCaseInsensitive(text, goal.title)) {
            newMentions.push({
              id: generateCanonicalId(),
              conversation_id: row.id,
              entity_type: 'goal',
              entity_id: goal.id,
              surface_form: goal.title,
              message_ids: [],
              confidence: 0.9,
            })
          }
        }
      }

      if (extractConcepts) {
        // Placeholder: concept extraction is intentionally disabled by default.
        // Future implementations can add embedding-based mention extraction here.
      }

      await sql`
        DELETE FROM entity_mentions
        WHERE conversation_id = ${row.id}
          AND entity_type = ANY(${['project', 'goal']})
      `

      if (newMentions.length > 0) {
        const rowsToInsert = newMentions.map((mention) => ({
          id: mention.id,
          conversation_id: mention.conversation_id,
          entity_type: mention.entity_type,
          entity_id: mention.entity_id,
          surface_form: mention.surface_form,
          message_ids: mention.message_ids,
          confidence: mention.confidence,
          embedding: null,
        }))

        await sql`
          INSERT INTO entity_mentions ${sql(rowsToInsert)}
        `

        mentionsWritten += newMentions.length
      }

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
      logger.warn(`Mention extraction failed for conversation ${row.id}: ${message}`)
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

  logger.info(
    `Entity mentions run complete: processed=${processed}, skipped=${skipped}, failed=${failed}, mentions=${mentionsWritten}`
  )

  return {
    metadata: {
      processed,
      skipped,
      failed,
      mentionsWritten,
      configHash,
      extractConcepts,
    },
  }
}
