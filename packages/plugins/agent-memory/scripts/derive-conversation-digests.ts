#!/usr/bin/env bun
/**
 * Derived Task: Conversation Digests
 *
 * Creates or updates conversation digests from canonical conversations.
 * Uses derived_processing_log for idempotence and staleness detection.
 */

import { createHash } from 'node:crypto'
import { GoogleGenAI } from '@google/genai'
import type { DerivedRunContext, DerivedRunResult, DerivedMetadataSchema } from '../src/derived/runner.js'
import { generateCanonicalId } from '../src/ids.js'
import { stableStringify } from '../src/stable-stringify.js'

export const metadata: DerivedMetadataSchema = {
  fields: {
    maxConversations: { type: 'number', default: 100, description: 'Max conversations per run' },
    summaryMaxLength: { type: 'number', default: 280, description: 'Max summary length' },
    processorVersion: { type: 'string', default: 'v1', description: 'Digest processor version' },
    modelVersion: { type: 'string', default: 'local', description: 'Model version used' },
    useLLM: { type: 'boolean', default: true, description: 'Use LLM to summarize when needed' },
    llmModel: { type: 'string', default: 'gemini-2.5-flash-lite', description: 'LLM model for summaries' },
    maxMessages: { type: 'number', default: 30, description: 'Max messages to include in summary prompt' },
    maxPromptChars: { type: 'number', default: 12000, description: 'Max characters for the summary prompt' },
    maxMessageChars: { type: 'number', default: 2000, description: 'Max characters per message in prompt' },
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

function isPlaceholderSummary(value: string | null | undefined): boolean {
  if (!value) return true
  const trimmed = value.trim()
  if (trimmed.length === 0) return true
  if (trimmed.startsWith('Session ')) return true
  // Slug-like fallback (e.g., "stateful-swinging-hamster")
  if (/^[a-z]+(?:-[a-z]+){1,}$/.test(trimmed)) return true
  return false
}

function isUnusableSummary(value: string | null | undefined): boolean {
  if (isPlaceholderSummary(value)) return true
  const trimmed = value?.trim().toLowerCase()
  if (!trimmed) return true
  if (trimmed.includes('conversation summary unavailable')) return true
  if (trimmed.startsWith('no relevant action')) return true
  if (trimmed.includes('too short to provide')) return true
  if (trimmed.includes('please provide a longer conversation')) return true
  return false
}

function buildSummaryPrompt(transcript: string, maxLength: number): string {
  return `You are creating a concise conversation summary for memory injection and entity surfacing.

GOAL
Produce a single 1-2 sentence summary that captures:
- the main task or problem
- concrete actions taken / changes made (files, components, systems)
- outcomes or artifacts produced
- key entities (projects, goals, issues, concepts) implied by the work

STYLE
- Start with an action verb (e.g., "Refactored...", "Implemented...", "Investigated...").
- Prefer concrete nouns and named components.
- No filler, no greetings, no bullets.
- Max length: ${maxLength} characters.

CONVERSATION TRANSCRIPT
${transcript}`
}

export async function run(ctx: DerivedRunContext): Promise<DerivedRunResult> {
  const { sql, task, job, processingLog, logger, report } = ctx

  const config = task.metadata as Record<string, unknown> | undefined
  const maxConversations = (config?.maxConversations as number) ?? 100
  const summaryMaxLength = (config?.summaryMaxLength as number) ?? 280
  const processorVersion = (config?.processorVersion as string) ?? 'v1'
  let modelVersion = (config?.modelVersion as string) ?? 'local'
  const useLLM = (config?.useLLM as boolean) ?? true
  const llmModel = (config?.llmModel as string) ?? 'gemini-2.5-flash-lite'
  const maxMessages = (config?.maxMessages as number) ?? 30
  const maxPromptChars = (config?.maxPromptChars as number) ?? 12000
  const maxMessageChars = (config?.maxMessageChars as number) ?? 2000

  if (useLLM && modelVersion === 'local') {
    modelVersion = llmModel
  }

  const configHash = computeConfigHash({
    maxConversations,
    summaryMaxLength,
    processorVersion,
    modelVersion,
    useLLM,
    llmModel,
    maxMessages,
    maxPromptChars,
    maxMessageChars,
  })

  logger.info(`Conversation digest run (job: ${job.id}, limit: ${maxConversations})`)

  // NOTE: Do not use derived_processing_log for skipping. We rely on
  // conversation_digests staleness checks in the SQL query instead.
  report.setModelVersion(modelVersion)

  const geminiApiKey = process.env.GEMINI_API_KEY
  const genAI = useLLM && geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null
  if (useLLM && !geminiApiKey) {
    throw new Error('GEMINI_API_KEY not set; refusing to generate placeholder summaries.')
  }

  const rows = await sql<Array<{
    id: string
    updated_at: Date
    source_timestamp: Date | null
    display_text: string | null
    title: string | null
    subject: string | null
    session_id: string | null
    connector: string | null
    digest_id: string | null
    digest_updated_at: Date | null
    digest_processor_version: string | null
    digest_model_version: string | null
    convo_ref_key: string | null
  }>>`
    SELECT
      c.id,
      c.updated_at,
      c.source_timestamp,
      c.display_text,
      c.data->>'title' as title,
      c.data->>'subject' as subject,
      c.data->'metadata'->>'session_id' as session_id,
      (c.data->'source_refs'->0->>'connector') as connector,
      d.id as digest_id,
      d.updated_at as digest_updated_at,
      d.processor_version as digest_processor_version,
      d.model_version as digest_model_version,
      CASE
        WHEN c.data->'source_refs'->0->>'connector' IS NOT NULL
          THEN (c.data->'source_refs'->0->>'connector')
            || ':' || (c.data->'source_refs'->0->>'account_id')
            || ':' || (c.data->'source_refs'->0->>'entity_type')
            || ':' || (c.data->'source_refs'->0->>'source_id')
        ELSE NULL
      END as convo_ref_key
    FROM canonical_conversation
    AS c
    LEFT JOIN conversation_digests d ON d.conversation_id = c.id
    WHERE
      d.id IS NULL
      OR d.updated_at < COALESCE(c.source_timestamp, c.updated_at)
      OR d.processor_version IS DISTINCT FROM ${processorVersion}
      OR d.model_version IS DISTINCT FROM ${modelVersion}
    ORDER BY COALESCE(c.source_timestamp, c.updated_at) DESC
    LIMIT ${maxConversations}
  `

  let processed = 0
  let skipped = 0
  let failed = 0
  let unusable = 0

  const logEntries: Array<{
    entityId: string
    entityType: 'conversation'
    configHash: string
    status: 'success' | 'failed'
    error?: string
    entityUpdatedAt?: Date
  }> = []

  report.setInputCount(rows.length)
  if (rows.length === 0) {
    report.markSkipped('no_candidates')
  }

  for (const row of rows) {
    const entityUpdatedAt = row.source_timestamp ?? row.updated_at
    try {
      let summary = buildSummary([row.display_text, row.title, row.subject], summaryMaxLength)

      if (useLLM && genAI) {
        try {
          const messages = row.convo_ref_key
            ? await sql<Array<{
                body: string | null
                role: string | null
                sent_at: string | null
              }>>`
                SELECT
                  data->>'body_text' as body,
                  data->'metadata'->>'role' as role,
                  data->>'sent_at' as sent_at
                FROM canonical_message
                WHERE data->'metadata'->>'conversation_source_ref_key' = ${row.convo_ref_key}
                ORDER BY (data->>'sent_at')::timestamptz ASC NULLS LAST
                LIMIT ${maxMessages}
              `
            : row.session_id
              ? await sql<Array<{
                  body: string | null
                  role: string | null
                  sent_at: string | null
                }>>`
                  SELECT
                    data->>'body_text' as body,
                    data->'metadata'->>'role' as role,
                    data->>'sent_at' as sent_at
                  FROM canonical_message
                  WHERE data->'metadata'->>'session_id' = ${row.session_id}
                  ORDER BY (data->>'sent_at')::timestamptz ASC NULLS LAST
                  LIMIT ${maxMessages}
                `
              : []
          /* eslint-disable @typescript-eslint/indent */
          /* eslint-enable @typescript-eslint/indent */
          const normalizedMessages = messages as Array<{
            body: string | null
            role: string | null
            sent_at: string | null
          }>

          const transcriptLines: string[] = []
          let chars = 0

          for (const msg of normalizedMessages) {
            const bodyRaw = (msg.body ?? '').trim()
            if (!bodyRaw) continue
            const role = (msg.role ?? 'unknown').toLowerCase()
            const body = bodyRaw.length > maxMessageChars ? `${bodyRaw.slice(0, maxMessageChars)}...` : bodyRaw
            const line = `${role}: ${body}`
            if (chars + line.length + 1 > maxPromptChars) break
            transcriptLines.push(line)
            chars += line.length + 1
          }

          if (transcriptLines.length > 0) {
            const prompt = buildSummaryPrompt(transcriptLines.join('\n'), summaryMaxLength)
            const response = await genAI.models.generateContent({
              model: llmModel,
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
            })
            const text = response.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
            if (text.trim()) {
              const candidate = buildSummary([text], summaryMaxLength)
              if (isUnusableSummary(candidate)) {
                logger.warn(`LLM summary unusable for conversation ${row.id}; skipping digest.`)
                logEntries.push({
                  entityId: row.id,
                  entityType: 'conversation',
                  configHash,
                  status: 'failed',
                  error: 'LLM summary unusable',
                  entityUpdatedAt,
                })
                failed++
                unusable++
                continue
              }
              summary = candidate
            }
          } else if (isPlaceholderSummary(summary)) {
            logger.warn(`No transcript found for conversation ${row.id}; skipping digest.`)
            logEntries.push({
              entityId: row.id,
              entityType: 'conversation',
              configHash,
              status: 'failed',
              error: 'No transcript found for conversation',
              entityUpdatedAt,
            })
            failed++
            unusable++
            continue
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.warn(`LLM summary failed for conversation ${row.id}: ${message}`)
          logEntries.push({
            entityId: row.id,
            entityType: 'conversation',
            configHash,
            status: 'failed',
            error: message,
            entityUpdatedAt,
          })
          failed++
          continue
        }
      }

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
      if (report) {
        report.addSample({ label: row.id, value: summary })
      }
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
  report.setOutputCount(processed)
  report.setOutputUnusableCount(unusable)

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
