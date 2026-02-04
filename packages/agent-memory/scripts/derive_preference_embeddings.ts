#!/usr/bin/env bun
/**
 * Derived Task: Backfill Embeddings for Coding Preferences
 *
 * Reads coding_preferences rows that lack embeddings and generates them
 * via the Gemini Embeddings API (text-embedding-004, 768 dimensions).
 *
 * Uses the processing ledger to skip already-processed preferences and
 * automatically retry failed ones on next run.
 */

import { createHash } from 'node:crypto'
import { GoogleGenAI } from '@google/genai'
import type { DerivedRunContext, DerivedRunResult, DerivedMetadataSchema } from '../src/derived/runner.js'

// ─── Metadata Schema ─────────────────────────────────────────────────────────

export const metadata: DerivedMetadataSchema = {
  fields: {
    limit: { type: 'number', default: 500, description: 'Max preferences to embed per run' },
  },
}

// ============================================
// CONFIG
// ============================================

const EMBEDDING_MODEL = 'text-embedding-004'
const EMBEDDING_DIMENSIONS = 768
const BATCH_SIZE = 100 // Gemini supports batching
const MAX_PREFERENCES = 500 // safety cap per run

const CONFIG_VERSION = 'v2' // bumped for Gemini switch
const CONFIG_HASH = createHash('sha256')
  .update(`${CONFIG_VERSION}:${EMBEDDING_MODEL}:${EMBEDDING_DIMENSIONS}`)
  .digest('hex')
  .slice(0, 16)

// ============================================
// HELPERS
// ============================================

/**
 * Build the text to embed for a preference.
 * Combines the key semantic fields into a single string that captures
 * meaning for similarity search.
 */
function buildEmbeddingText(row: {
  preference: string
  entity_free_formulation: string
  context: string
  scope: string
  category: string
  failure_mode_prevented: string
}): string {
  const parts = [
    row.preference,
    row.entity_free_formulation !== row.preference ? row.entity_free_formulation : '',
    row.context,
    row.scope ? `Scope: ${row.scope}` : '',
    row.failure_mode_prevented ? `Prevents: ${row.failure_mode_prevented}` : '',
    row.category ? `Category: ${row.category}` : '',
  ].filter(Boolean)

  return parts.join('\n')
}

// ============================================
// MAIN RUNNER
// ============================================

interface PreferenceRow {
  id: string
  preference: string
  entity_free_formulation: string
  context: string
  scope: string
  category: string
  failure_mode_prevented: string
  created_at: Date
}

export async function run(ctx: DerivedRunContext): Promise<DerivedRunResult> {
  const { sql, processingLog, logger } = ctx
  const config = ctx.task.metadata as Record<string, unknown> | undefined
  const limit = (config?.limit as number) ?? MAX_PREFERENCES

  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not set')
  }

  const client = new GoogleGenAI({ apiKey })

  logger.info(`Backfilling embeddings (model=${EMBEDDING_MODEL}, dims=${EMBEDDING_DIMENSIONS}, limit=${limit})`)

  // --- Fetch preferences needing embeddings ---
  const allPreferences = await sql<PreferenceRow[]>`
    SELECT id, preference, entity_free_formulation, context, scope,
           category, failure_mode_prevented, created_at
    FROM coding_preferences
    WHERE embedding IS NULL
    ORDER BY created_at DESC
    LIMIT ${limit}
  `

  if (allPreferences.length === 0) {
    logger.info('No preferences need embeddings.')
    return { metadata: { total: 0, processed: 0, skipped: 0 } }
  }

  // --- Filter via processing ledger ---
  const processedMap = await processingLog.findProcessedEntityIds(CONFIG_HASH, 'coding_preference')
  const preferences = allPreferences.filter((pref) => {
    const entry = processedMap.get(pref.id)
    if (!entry) return true // never processed
    if (entry.entity_updated_at && pref.created_at.toISOString() > entry.entity_updated_at) return true
    return false
  })

  const skipped = allPreferences.length - preferences.length
  logger.info(`${allPreferences.length} without embeddings, ${preferences.length} to process, ${skipped} skipped`)

  if (preferences.length === 0) {
    const stats = await processingLog.getStats(CONFIG_HASH)
    return { metadata: { total: allPreferences.length, processed: 0, skipped, processingLog: stats } }
  }

  // --- Process in batches ---
  let successCount = 0
  let failCount = 0
  const logEntries: Array<{
    entityId: string
    entityType: 'coding_preference'
    configHash: string
    status: 'success' | 'failed'
    error?: string
    entityUpdatedAt?: Date
  }> = []

  for (let i = 0; i < preferences.length; i += BATCH_SIZE) {
    const batch = preferences.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(preferences.length / BATCH_SIZE)

    logger.info(`Batch ${batchNum}/${totalBatches}: ${batch.length} preference(s)`)

    const texts = batch.map(buildEmbeddingText)

    try {
      // Gemini batch embedding - pass strings directly
      const response = await client.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: texts,
      })

      const embeddings = response.embeddings ?? []

      for (let j = 0; j < batch.length; j++) {
        const pref = batch[j]
        const embedding = embeddings[j]?.values

        if (!embedding || embedding.length === 0) {
          logger.warn(`No embedding returned for ${pref.id}`)
          failCount++
          logEntries.push({
            entityId: pref.id,
            entityType: 'coding_preference',
            configHash: CONFIG_HASH,
            status: 'failed',
            error: 'No embedding returned',
            entityUpdatedAt: pref.created_at,
          })
          continue
        }

        if (embedding.length !== EMBEDDING_DIMENSIONS) {
          logger.warn(`Dimension mismatch for ${pref.id}: got ${embedding.length}, expected ${EMBEDDING_DIMENSIONS}`)
          failCount++
          logEntries.push({
            entityId: pref.id,
            entityType: 'coding_preference',
            configHash: CONFIG_HASH,
            status: 'failed',
            error: `Dimension mismatch: got ${embedding.length}, expected ${EMBEDDING_DIMENSIONS}`,
            entityUpdatedAt: pref.created_at,
          })
          continue
        }

        const vectorLiteral = `[${embedding.join(',')}]`
        await sql`
          UPDATE coding_preferences
          SET embedding = ${vectorLiteral}::vector
          WHERE id = ${pref.id}
        `

        successCount++
        logEntries.push({
          entityId: pref.id,
          entityType: 'coding_preference',
          configHash: CONFIG_HASH,
          status: 'success',
          entityUpdatedAt: pref.created_at,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`Batch ${batchNum} failed: ${message}`)
      failCount += batch.length

      for (const pref of batch) {
        logEntries.push({
          entityId: pref.id,
          entityType: 'coding_preference',
          configHash: CONFIG_HASH,
          status: 'failed',
          error: message,
          entityUpdatedAt: pref.created_at,
        })
      }
    }
  }

  // --- Record processing results ---
  if (logEntries.length > 0) {
    await processingLog.markBatch(logEntries)
    logger.info(`Logged ${logEntries.length} processing results`)
  }

  const stats = await processingLog.getStats(CONFIG_HASH)

  logger.info(`Done: ${successCount} embedded, ${failCount} failed`)

  return {
    metadata: {
      total: allPreferences.length,
      processed: preferences.length,
      skipped,
      success: successCount,
      failed: failCount,
      lineage: {
        model: EMBEDDING_MODEL,
        provider: 'google',
        dimensions: EMBEDDING_DIMENSIONS,
        configVersion: CONFIG_VERSION,
        configHash: CONFIG_HASH,
      },
      processingLog: stats,
    },
  }
}
