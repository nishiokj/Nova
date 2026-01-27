#!/usr/bin/env bun
/**
 * Derived Task: Preference Extraction from Canonical Conversations
 *
 * Reads canonical_conversation + canonical_message and uses Gemini to extract
 * user preferences from Claude and Rex session conversations.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { GoogleGenAI } from '@google/genai'
import type { DerivedRunContext, DerivedRunResult } from '../src/derived/runner.js'

// ============================================
// CONFIG
// ============================================

const OUTPUT_DIR = join(process.cwd(), 'derived_outputs', 'preferences')
const CHUNK_SIZE_BYTES = 300 * 1024
const MAX_CONVERSATIONS = 100
const GEMINI_MODEL = 'gemini-3-flash-preview'

const CATEGORIES = [
  'architecture',
  'code_style',
  'testing',
  'tooling',
  'performance',
  'security',
  'workflow',
  'documentation',
  'communication',
  'product',
  'naming',
  'ux',
] as const

// ============================================
// EXTRACTION PROMPT (versioned)
// ============================================

const PROMPT_VERSION = 'v2'

const EXTRACTION_PROMPT = `You are extracting user preferences from a Claude Code conversation transcript.

GOAL
Produce preference candidates that are useful for future decisions:
- High-signal (not noise / not one-off)
- Generalizable (survives domain/entity changes)
- Decision-steering (resolves ambiguity later)

IMPORTANT
Most "preferences" in coding chats are local conventions or situational instructions. Do NOT over-extract.
If you can't justify generalization, classify it as "local_convention" or "ignore" instead of forcing it into a durable principle.

OUTPUT
Return ONLY a valid JSON array. Each element MUST match this schema:

{
  "category": one of [${CATEGORIES.join(', ')}],
  "kind": "principle_candidate" | "local_convention" | "ignore",
  "preference": string,                       // imperative, concise
  "entity_free_formulation": string,          // same idea without project nouns (foo/bar test)
  "scope": string,                            // <= 12 words: where it applies
  "context": string,                          // 1-2 sentences max: nuance / depends / constraints
  "failure_mode_prevented": string,           // short: what breaks if ignored
  "signal_strength": "explicit" | "implicit",
  "evidence_count": number,                   // count DISTINCT moments (not rephrases)
  "evidence_notes": string[],                 // 1 short bullet per distinct moment
  "counterexample": string,                   // one plausible case where preference should NOT apply
  "confidence": "low" | "medium" | "high"
}

HARD CONSTRAINTS
- Emit at most 8 items with kind="principle_candidate". Scarcity forces abstraction.
- If you cannot produce a sensible entity_free_formulation, set kind="ignore".
- Naming/UI-only items are almost always "local_convention" unless they clearly prevent a recurring bug/failure mode.
- Do not output duplicates. If two items are basically the same, merge into one and combine evidence_notes.

WHAT COUNTS AS A PRINCIPLE_CANDIDATE (BURDEN OF PROOF)
Only set kind="principle_candidate" if at least ONE is true:
1) Repeated in 2+ distinct moments across the transcript (evidence_count >= 2), OR
2) Stated explicitly with tradeoff reasoning ("I prefer X because…"), OR
3) Tied to a concrete recurring failure mode (stale cache, race condition, infinite loop, data corruption, etc.) AND framed as a default rule.

Otherwise, use "local_convention" (if it might be useful sometimes) or "ignore" (if it's noise).

SIGNALS TO LOOK FOR
- Direct directives: "prefer X", "always Y", "never Z", "avoid W"
- Corrections: "no, do it this way", "don't add that", "remove this", "stop doing…"
- Repeated emphasis: "make sure", "remember", "again", recurring pattern across contexts
- Tradeoff reasoning: user explains WHY a choice is preferred
- Strong reactions tied to a pattern (not just "this sucks")

GENERALIZATION TESTS (APPLY BEFORE YOU EMIT)
1) Entity-erasure test:
   Replace domain terms and filenames with foo/bar. If it still makes sense, it can generalize.
2) Durability test:
   Would this still be a preference in 6 months on a different codebase?
3) Decision test:
   Would this preference help resolve an ambiguity in a future choice?
`

const PROMPT_HASH = createHash('sha256').update(EXTRACTION_PROMPT).digest('hex').slice(0, 16)

// ============================================
// HELPERS
// ============================================

type ExtractedPreference = {
  category?: string
  kind?: string
  preference?: string
  entity_free_formulation?: string
  scope?: string
  context?: string
  failure_mode_prevented?: string
  signal_strength?: string
  evidence_count?: number
  evidence_notes?: string[]
  counterexample?: string
  confidence?: string
  source?: {
    conversation_id: string
    connector: string
  }
}

function chunkByBytes(text: string, maxBytes: number): string[] {
  const lines = text.split('\n')
  const chunks: string[] = []
  let current: string[] = []
  let currentBytes = 0

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line + '\n', 'utf8')
    if (currentBytes + lineBytes > maxBytes && current.length > 0) {
      chunks.push(current.join('\n'))
      current = []
      currentBytes = 0
    }
    current.push(line)
    currentBytes += lineBytes
  }

  if (current.length > 0) {
    chunks.push(current.join('\n'))
  }

  return chunks
}

function extractJsonArray(text: string): ExtractedPreference[] | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return null
  const candidate = text.slice(start, end + 1)
  try {
    const parsed = JSON.parse(candidate)
    return Array.isArray(parsed) ? (parsed as ExtractedPreference[]) : null
  } catch {
    return null
  }
}

function normalizePreferenceKey(pref: ExtractedPreference): string {
  return (pref.preference ?? '').trim().toLowerCase()
}

function dedupePreferences(prefs: ExtractedPreference[]): ExtractedPreference[] {
  const seen = new Map<string, ExtractedPreference>()
  for (const pref of prefs) {
    const key = normalizePreferenceKey(pref)
    if (!key) continue
    if (!seen.has(key)) {
      seen.set(key, pref)
    }
  }
  return Array.from(seen.values())
}

function formatTranscript(messages: Array<{ role: string; text: string }>): string {
  return messages
    .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
    .join('\n')
}

function roleFromMessage(data: Record<string, unknown>): string {
  const metadata = data.metadata as Record<string, unknown> | undefined
  const role = typeof metadata?.role === 'string' ? metadata.role : undefined
  if (role) return role
  const labels = Array.isArray(data.labels) ? data.labels : []
  if (labels.includes('assistant')) return 'assistant'
  if (labels.includes('user')) return 'user'
  return 'unknown'
}

// ============================================
// MAIN RUNNER
// ============================================

export async function run(ctx: DerivedRunContext): Promise<DerivedRunResult> {
  const { sql, task, job, logger } = ctx
  const config = task.metadata as Record<string, unknown> | undefined
  const limit = (config?.limit as number) ?? MAX_CONVERSATIONS
  const maxChunks = (config?.max_chunks as number) ?? 12

  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not set')
  }

  logger.info(`Extracting preferences from conversations (limit=${limit})`)

  const conversations = await sql<{ id: string; data: Record<string, unknown>; source_ref_key: string }[]>`
    SELECT c.id, c.data, m.source_ref_key
    FROM canonical_conversation c
    JOIN entity_source_mappings m
      ON m.canonical_entity_id = c.id
     AND m.canonical_entity_type = 'conversation'
    WHERE m.source_ref_key LIKE 'claude_sessions:%'
       OR m.source_ref_key LIKE 'rex_sessions:%'
    ORDER BY c.updated_at DESC
    LIMIT ${limit}
  `

  if (conversations.length === 0) {
    logger.info('No matching conversations found.')
    return { metadata: { conversations: 0, preferences: 0 } }
  }

  const client = new GoogleGenAI({ apiKey })
  const allPreferences: ExtractedPreference[] = []
  let totalMessages = 0

  for (const convo of conversations) {
    const messages = await sql<{ data: Record<string, unknown> }[]>`
      SELECT data
      FROM canonical_message
      WHERE data->>'conversation_id' = ${convo.id}
      ORDER BY COALESCE(data->>'sent_at', data->>'received_at', data->>'created_at') ASC
    `

    if (messages.length === 0) continue
    totalMessages += messages.length

    const transcript = formatTranscript(
      messages
        .map((row) => row.data)
        .filter((data) => typeof data['body_text'] === 'string' && (data['body_text'] as string).trim().length > 0)
        .map((data) => ({
          role: roleFromMessage(data),
          text: data['body_text'] as string,
        }))
    )

    const chunks = chunkByBytes(transcript, CHUNK_SIZE_BYTES).slice(0, maxChunks)
    logger.info(`Conversation ${convo.id.slice(0, 8)}: ${chunks.length} chunk(s)`)

    for (const chunk of chunks) {
      const prompt = `${EXTRACTION_PROMPT}

TRANSCRIPT (chunk):
${chunk}
`

      const response = await client.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      })

      const text = response.text ?? ''
      const parsed = extractJsonArray(text)
      if (!parsed) {
        logger.warn(`Failed to parse JSON for conversation ${convo.id.slice(0, 8)}`)
        continue
      }

      for (const pref of parsed) {
        const connector = convo.source_ref_key.startsWith('claude_sessions:')
          ? 'claude_sessions'
          : convo.source_ref_key.startsWith('rex_sessions:')
            ? 'rex_sessions'
            : 'unknown'

        pref.source = {
          conversation_id: convo.id,
          connector,
        }
      }

      allPreferences.push(...parsed)
    }
  }

  const finalPreferences = dedupePreferences(allPreferences)

  await mkdir(OUTPUT_DIR, { recursive: true })
  const outputFile = join(OUTPUT_DIR, `preferences_${job.id}.json`)
  const output = {
    id: job.id,
    lineage: {
      model: GEMINI_MODEL,
      provider: 'google',
      promptVersion: PROMPT_VERSION,
      promptHash: PROMPT_HASH,
    },
    preferences: finalPreferences,
    meta: {
      extracted_at: new Date().toISOString(),
      conversations_processed: conversations.length,
      total_messages_analyzed: totalMessages,
      raw_preferences_found: allPreferences.length,
    },
  }

  await writeFile(outputFile, JSON.stringify(output, null, 2))
  logger.info(`Extraction written to ${outputFile}`)

  return {
    outputRef: outputFile,
    metadata: {
      conversations: conversations.length,
      messages: totalMessages,
      preferences: finalPreferences.length,
    },
  }
}
