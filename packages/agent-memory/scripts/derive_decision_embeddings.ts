#!/usr/bin/env bun
/**
 * Derived Task: Backfill Embeddings for Coding Decisions
 *
 * Reads coding_decisions rows that lack embeddings and generates them
 * via the Gemini Embeddings API (text-embedding-004, 768 dimensions).
 */

import { createHash } from 'node:crypto'
import { GoogleGenAI } from '@google/genai'
import type { DerivedRunContext, DerivedRunResult, DerivedMetadataSchema } from '../src/derived/runner.js'

export const metadata: DerivedMetadataSchema = {
  fields: {
    limit: { type: 'number', default: 500, description: 'Max decisions to embed per run' },
  },
}

const EMBEDDING_MODEL = 'text-embedding-004'
const EMBEDDING_DIMENSIONS = 768
const BATCH_SIZE = 100
const MAX_DECISIONS = 500

const CONFIG_VERSION = 'v1'
const CONFIG_HASH = createHash('sha256')
  .update(`${CONFIG_VERSION}:${EMBEDDING_MODEL}:${EMBEDDING_DIMENSIONS}:decision`)
  .digest('hex')
  .slice(0, 16)

function buildEmbeddingText(row: {
  decision: string
  rationale: string
  alternatives_considered: string
  tradeoffs: string
  scope: string
  category: string
}): string {
  const parts = [
    row.decision,
    row.rationale ? `Rationale: ${row.rationale}` : '',
    row.alternatives_considered ? `Alternatives: ${row.alternatives_considered}` : '',
    row.tradeoffs ? `Tradeoffs: ${row.tradeoffs}` : '',
    row.scope ? `Scope: ${row.scope}` : '',
    row.category ? `Category: ${row.category}` : '',
  ].filter(Boolean)

  return parts.join('\n')
}

interface DecisionRow {
  id: string
  decision: string
  rationale: string
  alternatives_considered: string
  tradeoffs: string
  scope: string
  category: string
  created_at: Date
}

export async function run(ctx: DerivedRunContext): Promise<DerivedRunResult> {
  const { sql, processingLog, logger } = ctx
  const config = ctx.task.metadata as Record<string, unknown> | undefined
  const limit = (config?.limit as number) ?? MAX_DECISIONS

  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not set')
  }

  const client = new GoogleGenAI({ apiKey })

  logger.info(`Backfilling decision embeddings (model=${EMBEDDING_MODEL}, dims=${EMBEDDING_DIMENSIONS}, limit=${limit})`)

  const allDecisions = await sql<DecisionRow[]>`
    SELECT id, decision, rationale, alternatives_considered, tradeoffs,
           scope, category, created_at
    FROM coding_decisions
    WHERE embedding IS NULL
    ORDER BY created_at DESC
    LIMIT ${limit}
  `

  if (allDecisions.length === 0) {
    logger.info('No decisions need embeddings.')
    return { metadata: { total: 0, processed: 0, skipped: 0 } }
  }

  const processedMap = await processingLog.findProcessedEntityIds(CONFIG_HASH, 'coding_decision')
  const decisions = allDecisions.filter((d) => {
    const entry = processedMap.get(d.id)
    if (!entry) return true
    if (entry.entity_updated_at && d.created_at.toISOString() > entry.entity_updated_at) return true
    return false
  })

  const skipped = allDecisions.length - decisions.length
  logger.info(`${allDecisions.length} without embeddings, ${decisions.length} to process, ${skipped} skipped`)

  if (decisions.length === 0) {
    const stats = await processingLog.getStats(CONFIG_HASH)
    return { metadata: { total: allDecisions.length, processed: 0, skipped, processingLog: stats } }
  }

  let successCount = 0
  let failCount = 0
  const logEntries: Array<{
    entityId: string
    entityType: 'coding_decision'
    configHash: string
    status: 'success' | 'failed'
    error?: string
    entityUpdatedAt?: Date
  }> = []

  for (let i = 0; i < decisions.length; i += BATCH_SIZE) {
    const batch = decisions.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(decisions.length / BATCH_SIZE)

    logger.info(`Batch ${batchNum}/${totalBatches}: ${batch.length} decision(s)`)

    const texts = batch.map(buildEmbeddingText)

    try {
      const response = await client.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: texts,
      })

      const embeddings = response.embeddings ?? []

      for (let j = 0; j < batch.length; j++) {
        const dec = batch[j]
        const embedding = embeddings[j]?.values

        if (!embedding || embedding.length === 0) {
          logger.warn(`No embedding returned for ${dec.id}`)
          failCount++
          logEntries.push({
            entityId: dec.id,
            entityType: 'coding_decision',
            configHash: CONFIG_HASH,
            status: 'failed',
            error: 'No embedding returned',
            entityUpdatedAt: dec.created_at,
          })
          continue
        }

        if (embedding.length !== EMBEDDING_DIMENSIONS) {
          logger.warn(`Dimension mismatch for ${dec.id}: got ${embedding.length}, expected ${EMBEDDING_DIMENSIONS}`)
          failCount++
          logEntries.push({
            entityId: dec.id,
            entityType: 'coding_decision',
            configHash: CONFIG_HASH,
            status: 'failed',
            error: `Dimension mismatch: got ${embedding.length}, expected ${EMBEDDING_DIMENSIONS}`,
            entityUpdatedAt: dec.created_at,
          })
          continue
        }

        const vectorLiteral = `[${embedding.join(',')}]`
        await sql`
          UPDATE coding_decisions
          SET embedding = ${vectorLiteral}::vector
          WHERE id = ${dec.id}
        `

        successCount++
        logEntries.push({
          entityId: dec.id,
          entityType: 'coding_decision',
          configHash: CONFIG_HASH,
          status: 'success',
          entityUpdatedAt: dec.created_at,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`Batch ${batchNum} failed: ${message}`)
      failCount += batch.length

      for (const dec of batch) {
        logEntries.push({
          entityId: dec.id,
          entityType: 'coding_decision',
          configHash: CONFIG_HASH,
          status: 'failed',
          error: message,
          entityUpdatedAt: dec.created_at,
        })
      }
    }
  }

  if (logEntries.length > 0) {
    await processingLog.markBatch(logEntries)
    logger.info(`Logged ${logEntries.length} processing results`)
  }

  const stats = await processingLog.getStats(CONFIG_HASH)

  logger.info(`Done: ${successCount} embedded, ${failCount} failed`)

  return {
    metadata: {
      total: allDecisions.length,
      processed: decisions.length,
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
