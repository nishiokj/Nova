#!/usr/bin/env bun
/**
 * Derived Task: Preference Extraction from Canonical Conversations
 *
 * Reads canonical_conversation + canonical_message and uses Gemini to extract
 * user preferences from Claude and Rex session conversations.
 *
 * Mode selection (based on task.mode):
 *   - recurring: Gemini Batch API (50% cost reduction, checkpoint/resume)
 *   - once/event: Direct generateContent calls (immediate results, no polling)
 */

import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile, unlink } from 'node:fs/promises'
import { GoogleGenAI } from '@google/genai'
import type { DerivedRunContext, DerivedRunResult, DerivedMetadataSchema } from '../src/derived/runner.js'
import { generateCanonicalId } from '../src/ids.js'

// ─── Metadata Schema ─────────────────────────────────────────────────────────

export const metadata: DerivedMetadataSchema = {
  fields: {
    limit: { type: 'number', default: 50, description: 'Max conversations to process per run' },
    max_chunks: { type: 'number', default: 12, description: 'Max chunks per conversation transcript' },
  },
}

// ============================================
// CONFIG
// ============================================

const CHUNK_SIZE_BYTES = 300 * 1024
const MAX_CONVERSATIONS = 50
const GEMINI_MODEL = 'gemini-3-flash-preview'
const POLL_INTERVAL_MS = 30_000
const BATCH_TIMEOUT_MS = 2 * 60 * 60 * 1000 // 2 hours
const REQUEST_TIMEOUT_MS = 60_000 // 60s per generateContent call
const DIRECT_CONCURRENCY = 10
const PERSIST_BATCH_SIZE = 25 // Flush to DB after every N conversations

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

const PROMPT_VERSION = 'v3'

const EXTRACTION_PROMPT = `You are extracting user preferences AND explicit decisions from a Claude Code conversation transcript.

GOAL
Produce two kinds of output:
1. **Preferences**: recurring patterns, principles, and conventions that guide future choices.
2. **Decisions**: explicit choices made when presented with options (architecture, library, pattern, tradeoff).

IMPORTANT
Most "preferences" in coding chats are local conventions or situational instructions. Do NOT over-extract.
If you can't justify generalization, classify it as "local_convention" or "ignore" instead of forcing it into a durable principle.
Decisions are different: they capture a concrete choice that was made, even if it's one-off, as long as it involved alternatives.

OUTPUT
Return ONLY a valid JSON object with two arrays:

{
  "preferences": [ ... ],
  "decisions": [ ... ]
}

Each **preference** element MUST match this schema:

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

Each **decision** element MUST match this schema:

{
  "category": one of [${CATEGORIES.join(', ')}],
  "decision": string,                         // the explicit choice made
  "rationale": string,                        // why this was chosen
  "alternatives_considered": string,          // what was rejected
  "tradeoffs": string,                        // surfaced tradeoffs
  "scope": string,                            // where it applies
  "project_context": string,                  // project-level context
  "task_context": string,                     // task-level context
  "confidence": "low" | "medium" | "high",
  "signal_strength": "explicit" | "implicit",
  "reversibility": "easy" | "moderate" | "hard"
}

PREFERENCE HARD CONSTRAINTS
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

DECISION HARD CONSTRAINTS
- Only extract decisions where there was a clear choice between alternatives.
- The decision must be explicit (stated or enacted), not hypothetical.
- Include rationale and alternatives even if brief — "chose X over Y because Z" is enough.
- Emit at most 6 decisions per transcript chunk.

SIGNALS TO LOOK FOR (PREFERENCES)
- Direct directives: "prefer X", "always Y", "never Z", "avoid W"
- Corrections: "no, do it this way", "don't add that", "remove this", "stop doing…"
- Repeated emphasis: "make sure", "remember", "again", recurring pattern across contexts
- Tradeoff reasoning: user explains WHY a choice is preferred
- Strong reactions tied to a pattern (not just "this sucks")

SIGNALS TO LOOK FOR (DECISIONS)
- Explicit choices: "let's go with X", "use Y instead of Z", "I chose A because B"
- Architecture calls: choosing a pattern, library, data model, or API design
- Rejection of alternatives: "we could do X but Y is better because…"
- Tradeoff acknowledgment: "X is slower but simpler", "we sacrifice A for B"

GENERALIZATION TESTS (APPLY TO PREFERENCES BEFORE YOU EMIT)
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

type ExtractedDecision = {
  category?: string
  decision?: string
  rationale?: string
  alternatives_considered?: string
  tradeoffs?: string
  scope?: string
  project_context?: string
  task_context?: string
  confidence?: string
  signal_strength?: string
  reversibility?: string
  source?: {
    conversation_id: string
    connector: string
  }
}

interface ExtractedOutput {
  preferences: ExtractedPreference[]
  decisions: ExtractedDecision[]
}

export function chunkByBytes(text: string, maxBytes: number): string[] {
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

export function extractOutput(text: string): ExtractedOutput | null {
  // Try object format first: { "preferences": [...], "decisions": [...] }
  const objStart = text.indexOf('{')
  const objEnd = text.lastIndexOf('}')
  if (objStart !== -1 && objEnd > objStart) {
    try {
      const parsed = JSON.parse(text.slice(objStart, objEnd + 1))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          preferences: Array.isArray(parsed.preferences) ? parsed.preferences : [],
          decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
        }
      }
    } catch { /* fall through to legacy */ }
  }

  // Legacy fallback: bare JSON array → treat as preferences only
  const arrStart = text.indexOf('[')
  const arrEnd = text.lastIndexOf(']')
  if (arrStart === -1 || arrEnd === -1 || arrEnd <= arrStart) return null
  try {
    const parsed = JSON.parse(text.slice(arrStart, arrEnd + 1))
    if (Array.isArray(parsed)) {
      return { preferences: parsed as ExtractedPreference[], decisions: [] }
    }
  } catch { /* ignore */ }

  return null
}

export function normalizePreferenceKey(pref: ExtractedPreference): string {
  return (pref.preference ?? '').trim().toLowerCase()
}

export function dedupePreferences(prefs: ExtractedPreference[]): ExtractedPreference[] {
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

export function normalizeDecisionKey(d: ExtractedDecision): string {
  const cat = (d.category ?? '').trim().toLowerCase()
  const dec = (d.decision ?? '').trim().toLowerCase()
  const scope = (d.scope ?? '').trim().toLowerCase()
  return `${cat}::${dec}::${scope}`
}

export function dedupeDecisions(decisions: ExtractedDecision[]): ExtractedDecision[] {
  const seen = new Map<string, ExtractedDecision>()
  for (const d of decisions) {
    const key = normalizeDecisionKey(d)
    if (!d.decision?.trim()) continue
    if (!seen.has(key)) {
      seen.set(key, d)
    }
  }
  return Array.from(seen.values())
}

export function formatTranscript(messages: Array<{ role: string; text: string }>): string {
  return messages
    .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
    .join('\n')
}

/**
 * Unwrap potentially double-encoded JSONB data.
 * The data column may store a JSON string (double-encoded) or an array of versions.
 */
function unwrapData(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} }
  }
  if (Array.isArray(raw)) {
    const last = raw[raw.length - 1]
    return unwrapData(last)
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  return {}
}

export function roleFromMessage(data: Record<string, unknown>): string {
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

type RequestMeta = { key: string; conversationId: string; sourceRefKey: string }

const TERMINAL_STATES = new Set([
  'JOB_STATE_SUCCEEDED',
  'JOB_STATE_FAILED',
  'JOB_STATE_CANCELLED',
  'JOB_STATE_EXPIRED',
])

/**
 * Checkpoint data persisted to job metadata for crash recovery.
 * If the daemon dies while polling a Gemini batch, the next run
 * reads this and resumes polling instead of resubmitting.
 */
interface BatchCheckpoint {
  batchName: string
  requestMetas: RequestMeta[]
  conversationUpdatedAt: [string, string][] // [id, iso][]
  totalConversations: number
  skipped: number
  totalMessages: number
  totalRequests: number
}

// ============================================
// EXECUTION HELPERS
// ============================================

type Logger = DerivedRunContext['logger']

/**
 * Parse a single model response and accumulate results.
 * Returns true if parsing succeeded, false on failure.
 */
function processModelResponse(
  text: string,
  meta: RequestMeta,
  allPreferences: ExtractedPreference[],
  allDecisions: ExtractedDecision[],
  convoResults: Map<string, { success: boolean; error?: string }>,
  logger: Logger,
): boolean {
  const parsed = extractOutput(text)
  if (!parsed) {
    logger.warn(`Failed to parse JSON for key ${meta.key}`)
    convoResults.set(meta.conversationId, {
      success: false,
      error: 'Failed to parse JSON from model response',
    })
    return false
  }

  if (!convoResults.has(meta.conversationId) || convoResults.get(meta.conversationId)!.success) {
    convoResults.set(meta.conversationId, { success: true })
  }

  const connector = meta.sourceRefKey.startsWith('claude_sessions:')
    ? 'claude_sessions'
    : meta.sourceRefKey.startsWith('rex_sessions:')
      ? 'rex_sessions'
      : 'unknown'

  const source = { conversation_id: meta.conversationId, connector }
  for (const pref of parsed.preferences) pref.source = source
  for (const dec of parsed.decisions) dec.source = source
  allPreferences.push(...parsed.preferences)
  allDecisions.push(...parsed.decisions)
  return true
}

/** Poll a Gemini batch job until it reaches a terminal state. */
async function pollBatchToCompletion(
  client: GoogleGenAI,
  batchName: string,
  logger: Logger,
): Promise<any> {
  const startTime = Date.now()
  let current = await client.batches.get({ name: batchName })

  while (!TERMINAL_STATES.has(current.state!)) {
    if (Date.now() - startTime > BATCH_TIMEOUT_MS) {
      await client.batches.cancel({ name: current.name! }).catch(() => {})
      throw new Error(`Batch job ${current.name} timed out after ${BATCH_TIMEOUT_MS / 60_000}m`)
    }

    logger.info(`Batch ${current.name}: ${current.state}`)
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    current = await client.batches.get({ name: current.name! })
  }

  if (current.state !== 'JOB_STATE_SUCCEEDED') {
    throw new Error(`Batch job ${current.name} ended with state: ${current.state}`)
  }

  logger.info(`Batch ${current.name} succeeded`)
  return current
}

/** Download batch result file and parse each response line. */
async function downloadAndParseBatchResults(
  client: GoogleGenAI,
  batchResult: any,
  requestMetas: RequestMeta[],
  allPreferences: ExtractedPreference[],
  allDecisions: ExtractedDecision[],
  convoResults: Map<string, { success: boolean; error?: string }>,
  logger: Logger,
): Promise<number> {
  const resultFileName = batchResult.dest?.fileName
  if (!resultFileName) {
    throw new Error(`Batch job ${batchResult.name} succeeded but has no result file`)
  }

  const resultRaw = await client.files.download({ file: resultFileName })
  const resultText = Buffer.isBuffer(resultRaw) ? resultRaw.toString('utf-8') : String(resultRaw)
  const resultLines = resultText.trim().split('\n').filter(Boolean)

  const metaByKey = new Map(requestMetas.map(m => [m.key, m]))
  let parseFailures = 0

  for (const line of resultLines) {
    let result: Record<string, any>
    try {
      result = JSON.parse(line)
    } catch {
      parseFailures++
      continue
    }

    const meta = metaByKey.get(result.key)
    if (!meta) continue

    if (result.status && result.status.code && result.status.code !== 200) {
      logger.warn(`Request ${result.key} failed: ${result.status.message ?? result.status.code}`)
      parseFailures++
      convoResults.set(meta.conversationId, {
        success: false,
        error: `Batch request failed: ${result.status.message ?? result.status.code}`,
      })
      continue
    }

    const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    if (!processModelResponse(text, meta, allPreferences, allDecisions, convoResults, logger)) {
      parseFailures++
    }
  }

  if (parseFailures > 0) {
    logger.warn(`${parseFailures} result(s) failed to parse or had errors`)
  }

  return parseFailures
}

// ============================================
// PERSISTENCE HELPERS
// ============================================

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms)
    promise.then(
      (val) => { clearTimeout(timer); resolve(val) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

async function flushPreferences(sql: DerivedRunContext['sql'], prefs: ExtractedPreference[]): Promise<number> {
  const deduped = dedupePreferences(prefs)
  if (deduped.length === 0) return 0

  const rows = deduped.map((pref) => ({
    id: generateCanonicalId(),
    category: pref.category ?? 'unknown',
    kind: pref.kind ?? 'ignore',
    preference: pref.preference ?? '',
    entity_free_formulation: pref.entity_free_formulation ?? '',
    scope: pref.scope ?? '',
    context: pref.context ?? '',
    failure_mode_prevented: pref.failure_mode_prevented ?? '',
    signal_strength: pref.signal_strength ?? 'implicit',
    evidence_count: pref.evidence_count ?? 1,
    evidence_notes: JSON.stringify(pref.evidence_notes ?? []),
    counterexample: pref.counterexample ?? '',
    confidence: pref.confidence ?? 'low',
  }))

  await sql`
    INSERT INTO coding_preferences ${sql(rows)}
    ON CONFLICT (category, kind, preference, entity_free_formulation, scope)
    DO UPDATE SET
      context = EXCLUDED.context,
      failure_mode_prevented = EXCLUDED.failure_mode_prevented,
      signal_strength = EXCLUDED.signal_strength,
      evidence_count = EXCLUDED.evidence_count,
      evidence_notes = EXCLUDED.evidence_notes,
      counterexample = EXCLUDED.counterexample,
      confidence = EXCLUDED.confidence
  `
  return deduped.length
}

async function flushDecisions(sql: DerivedRunContext['sql'], decisions: ExtractedDecision[]): Promise<number> {
  const deduped = dedupeDecisions(decisions)
  if (deduped.length === 0) return 0

  const rows = deduped.map((d) => ({
    id: generateCanonicalId(),
    category: d.category ?? 'unknown',
    decision: d.decision ?? '',
    rationale: d.rationale ?? '',
    alternatives_considered: d.alternatives_considered ?? '',
    tradeoffs: d.tradeoffs ?? '',
    scope: d.scope ?? '',
    project_context: d.project_context ?? '',
    task_context: d.task_context ?? '',
    confidence: d.confidence ?? 'low',
    signal_strength: d.signal_strength ?? 'implicit',
    reversibility: d.reversibility ?? 'moderate',
  }))

  await sql`
    INSERT INTO coding_decisions ${sql(rows)}
    ON CONFLICT (category, decision, scope)
    DO UPDATE SET
      rationale = EXCLUDED.rationale,
      alternatives_considered = EXCLUDED.alternatives_considered,
      tradeoffs = EXCLUDED.tradeoffs,
      project_context = EXCLUDED.project_context,
      task_context = EXCLUDED.task_context,
      confidence = EXCLUDED.confidence,
      signal_strength = EXCLUDED.signal_strength,
      reversibility = EXCLUDED.reversibility
  `
  return deduped.length
}

// ============================================
// RUN
// ============================================

export async function run(ctx: DerivedRunContext): Promise<DerivedRunResult> {
  const { sql, task, job, processingLog, checkpoint, logger } = ctx
  const config = task.metadata as Record<string, unknown> | undefined
  const limit = (config?.limit as number) ?? MAX_CONVERSATIONS
  const maxChunks = (config?.max_chunks as number) ?? 12
  const useBatch = task.mode === 'recurring'

  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not set')
  }

  const client = new GoogleGenAI({ apiKey })

  // --- Shared result accumulators ---
  const allPreferences: ExtractedPreference[] = []
  const allDecisions: ExtractedDecision[] = []
  let parseFailures = 0
  const convoResults = new Map<string, { success: boolean; error?: string }>()
  let convoUpdatedAt = new Map<string, Date>()
  let totalConversations = 0
  let skipped = 0
  let totalMessages = 0
  let totalRequests = 0
  let totalPrefsWritten = 0
  let totalDecisionsWritten = 0
  let batchJobName: string | undefined
  let resumed = false

  // --- Check for batch checkpoint (batch mode only) ---
  const existing = useBatch
    ? ((job.metadata as Record<string, unknown> | undefined)?._checkpoint as BatchCheckpoint | undefined)
    : undefined

  if (useBatch && existing?.batchName) {
    // ===== BATCH RESUME PATH: skip fetching, go straight to polling =====
    logger.info(`Resuming from checkpoint: batch ${existing.batchName}`)
    resumed = true
    convoUpdatedAt = new Map(existing.conversationUpdatedAt.map(([id, iso]) => [id, new Date(iso)]))
    totalConversations = existing.totalConversations
    skipped = existing.skipped
    totalMessages = existing.totalMessages
    totalRequests = existing.totalRequests

    const batchResult = await pollBatchToCompletion(client, existing.batchName, logger)
    batchJobName = batchResult.name ?? undefined
    parseFailures = await downloadAndParseBatchResults(
      client, batchResult, existing.requestMetas,
      allPreferences, allDecisions, convoResults, logger,
    )
  } else {
    // ===== NORMAL PATH =====
    logger.info(`Extracting preferences via ${useBatch ? 'batch' : 'direct'} API (limit=${limit})`)

    // --- Phase 1: Fetch conversations ---
    const allConversations = await sql<{ id: string; data: Record<string, unknown>; source_ref_key: string; updated_at: Date }[]>`
      SELECT id, data, source_ref_key, updated_at FROM (
        SELECT DISTINCT ON (c.id) c.id, c.data, c.updated_at, m.source_ref_key
        FROM canonical_conversation c
        JOIN entity_source_mappings m
          ON m.canonical_entity_id = c.id
         AND m.canonical_entity_type = 'conversation'
        WHERE m.source_ref_key LIKE 'claude_sessions:%'
           OR m.source_ref_key LIKE 'rex_sessions:%'
        ORDER BY c.id, c.updated_at DESC
      ) sub
      ORDER BY sub.updated_at DESC
      LIMIT ${limit}
    `

    if (allConversations.length === 0) {
      logger.info('No matching conversations found.')
      return { metadata: { conversations: 0, skipped: 0, preferences: 0 } }
    }

    const processedMap = await processingLog.findProcessedEntityIds(PROMPT_HASH, 'conversation')
    const conversations = allConversations.filter((convo) => {
      const entry = processedMap.get(convo.id)
      if (!entry) return true
      if (entry.entity_updated_at && convo.updated_at.toISOString() > entry.entity_updated_at) return true
      return false
    })

    totalConversations = allConversations.length
    skipped = allConversations.length - conversations.length
    logger.info(`${allConversations.length} total, ${conversations.length} unprocessed/stale, ${skipped} skipped`)

    if (conversations.length === 0) {
      const stats = await processingLog.getStats(PROMPT_HASH)
      return { metadata: { conversations: allConversations.length, skipped, preferences: 0, processingLog: stats } }
    }

    convoUpdatedAt = new Map(conversations.map(c => [c.id, c.updated_at]))

    // --- Phase 2: Build chunks ---
    const requestMetas: RequestMeta[] = []
    const chunkPrompts = new Map<string, string>()

    for (const convo of conversations) {
      const messages = await sql<{ data: Record<string, unknown> }[]>`
        SELECT data
        FROM canonical_message
        WHERE CASE
          WHEN jsonb_typeof(data) = 'string' THEN (data #>> '{}')::jsonb->>'conversation_id'
          ELSE data->>'conversation_id'
        END = ${convo.id}
        ORDER BY created_at ASC
      `

      if (messages.length === 0) continue
      totalMessages += messages.length

      const transcript = formatTranscript(
        messages
          .map((row) => unwrapData(row.data))
          .filter((data) => typeof data['body_text'] === 'string' && (data['body_text'] as string).trim().length > 0)
          .map((data) => ({
            role: roleFromMessage(data),
            text: data['body_text'] as string,
          }))
      )

      const chunks = chunkByBytes(transcript, CHUNK_SIZE_BYTES).slice(0, maxChunks)
      logger.info(`Conversation ${convo.id.slice(0, 8)}: ${chunks.length} chunk(s)`)

      for (let i = 0; i < chunks.length; i++) {
        const key = `${convo.id}_chunk_${i}`
        requestMetas.push({ key, conversationId: convo.id, sourceRefKey: convo.source_ref_key })
        chunkPrompts.set(key, `${EXTRACTION_PROMPT}\n\nTRANSCRIPT (chunk):\n${chunks[i]}\n`)
      }
    }

    if (totalMessages === 0 && conversations.length > 0) {
      throw new Error(
        `Data anomaly: ${conversations.length} conversations found but 0 messages extracted. ` +
        `This likely indicates a message linking or JSONB encoding issue in canonical_message.`
      )
    }

    if (requestMetas.length === 0) {
      logger.info('No chunks to process.')
      return { metadata: { conversations: conversations.length, messages: totalMessages, preferences: 0 } }
    }

    totalRequests = requestMetas.length
    logger.info(`Processing ${totalRequests} request(s) via ${useBatch ? 'batch' : 'direct'} API`)

    // --- Phase 3: Execute ---
    if (useBatch) {
      // === BATCH: upload JSONL, create job, checkpoint, poll, download ===
      const jsonlLines = requestMetas.map((meta) =>
        JSON.stringify({
          key: meta.key,
          request: {
            contents: [{ role: 'user', parts: [{ text: chunkPrompts.get(meta.key) }] }],
          },
        })
      )

      const tmpFilePath = join(tmpdir(), `pref-batch-${Date.now()}.jsonl`)
      await writeFile(tmpFilePath, jsonlLines.join('\n') + '\n', 'utf8')

      let uploadedFile: { name?: string | null }
      try {
        uploadedFile = await client.files.upload({
          file: tmpFilePath,
          config: { mimeType: 'application/jsonl' },
        })
      } finally {
        await unlink(tmpFilePath).catch(() => {})
      }

      if (!uploadedFile.name) {
        throw new Error('File upload succeeded but returned no file name')
      }

      const batchJob = await client.batches.create({
        model: GEMINI_MODEL,
        src: uploadedFile.name,
        config: { displayName: `preferences-${job.id ?? Date.now()}` },
      })

      logger.info(`Batch job created: ${batchJob.name} (state: ${batchJob.state})`)

      await checkpoint({
        batchName: batchJob.name,
        requestMetas,
        conversationUpdatedAt: [...convoUpdatedAt].map(([id, d]) => [id, d.toISOString()]),
        totalConversations,
        skipped,
        totalMessages,
        totalRequests,
      })
      logger.info('Checkpoint saved — batch can be resumed after crash')

      const batchResult = await pollBatchToCompletion(client, batchJob.name!, logger)
      batchJobName = batchResult.name ?? undefined
      parseFailures = await downloadAndParseBatchResults(
        client, batchResult, requestMetas,
        allPreferences, allDecisions, convoResults, logger,
      )
    } else {
      // === DIRECT: batched persistence (process N conversations, flush, repeat) ===
      const chunksByConvo = new Map<string, RequestMeta[]>()
      for (const meta of requestMetas) {
        if (!chunksByConvo.has(meta.conversationId)) chunksByConvo.set(meta.conversationId, [])
        chunksByConvo.get(meta.conversationId)!.push(meta)
      }

      const convoList = [...chunksByConvo.entries()]
      const totalConvos = convoList.length
      let processedCount = 0

      // Process a single conversation, returning extracted data
      const processConversation = async (
        convoId: string,
        metas: RequestMeta[],
      ): Promise<{
        convoId: string
        prefs: ExtractedPreference[]
        decisions: ExtractedDecision[]
        success: boolean
        error?: string
        quotaExhausted: boolean
      }> => {
        const prefs: ExtractedPreference[] = []
        const decisions: ExtractedDecision[] = []
        let lastError: string | undefined
        let hasSuccess = false
        let quotaExhausted = false

        for (const meta of metas) {
          const promptText = chunkPrompts.get(meta.key)!
          try {
            const response = await withTimeout(
              client.models.generateContent({
                model: GEMINI_MODEL,
                contents: [{ role: 'user', parts: [{ text: promptText }] }],
              }),
              REQUEST_TIMEOUT_MS,
            )
            const text = response.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
            const localResults = new Map<string, { success: boolean; error?: string }>()
            if (processModelResponse(text, meta, prefs, decisions, localResults, logger)) {
              hasSuccess = true
            } else {
              parseFailures++
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            logger.warn(`Request ${meta.key} failed: ${msg}`)
            parseFailures++
            lastError = msg
            // Detect quota exhaustion (429) or resource exhausted errors
            if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota')) {
              quotaExhausted = true
              break // Stop processing this conversation's remaining chunks
            }
          }
        }

        return {
          convoId,
          prefs,
          decisions,
          success: hasSuccess || !lastError, // Success if any chunk succeeded or no errors
          error: lastError,
          quotaExhausted,
        }
      }

      // Process conversations in batches with persistence after each batch
      for (let batchStart = 0; batchStart < convoList.length; batchStart += PERSIST_BATCH_SIZE) {
        const batch = convoList.slice(batchStart, batchStart + PERSIST_BATCH_SIZE)
        const batchNum = Math.floor(batchStart / PERSIST_BATCH_SIZE) + 1
        const totalBatches = Math.ceil(convoList.length / PERSIST_BATCH_SIZE)

        logger.info(`Processing batch ${batchNum}/${totalBatches} (${batch.length} conversations)`)

        // Process batch in parallel (respecting concurrency limit)
        const batchResults = await Promise.all(
          batch.map(([convoId, metas]) => processConversation(convoId, metas))
        )

        // Collect all prefs/decisions from this batch
        const batchPrefs: ExtractedPreference[] = []
        const batchDecisions: ExtractedDecision[] = []
        const logEntries: Array<{
          entityId: string
          entityType: 'conversation'
          configHash: string
          status: 'success' | 'failed'
          error?: string
          entityUpdatedAt?: Date
        }> = []

        for (const result of batchResults) {
          batchPrefs.push(...result.prefs)
          batchDecisions.push(...result.decisions)
          logEntries.push({
            entityId: result.convoId,
            entityType: 'conversation',
            configHash: PROMPT_HASH,
            status: result.success ? 'success' : 'failed',
            error: result.error,
            entityUpdatedAt: convoUpdatedAt.get(result.convoId),
          })
        }

        // Flush batch results to DB
        const nPrefs = await flushPreferences(sql, batchPrefs)
        const nDecs = await flushDecisions(sql, batchDecisions)
        totalPrefsWritten += nPrefs
        totalDecisionsWritten += nDecs

        // Mark all conversations in batch as processed
        if (logEntries.length > 0) {
          await processingLog.markBatch(logEntries)
        }

        processedCount += batch.length
        const successCount = batchResults.filter(r => r.success).length
        const quotaHit = batchResults.some(r => r.quotaExhausted)

        logger.info(
          `Batch ${batchNum}/${totalBatches} complete: ${successCount}/${batch.length} succeeded, ` +
          `${nPrefs} prefs, ${nDecs} decisions. Progress: ${processedCount}/${totalConvos}`
        )

        // Stop early if quota exhausted to avoid burning more API calls
        if (quotaHit) {
          logger.warn(`Quota exhausted detected. Stopping early after ${processedCount}/${totalConvos} conversations.`)
          break
        }
      }
    }
  }

  // ===== Batch mode: flush accumulated results (direct mode already flushed per-conversation) =====
  if (useBatch) {
    totalPrefsWritten = await flushPreferences(sql, allPreferences)
    totalDecisionsWritten = await flushDecisions(sql, allDecisions)

    const logEntries = Array.from(convoResults.entries()).map(([convoId, result]) => ({
      entityId: convoId,
      entityType: 'conversation' as const,
      configHash: PROMPT_HASH,
      status: result.success ? 'success' as const : 'failed' as const,
      error: result.error,
      entityUpdatedAt: convoUpdatedAt.get(convoId),
    }))

    if (logEntries.length > 0) {
      await processingLog.markBatch(logEntries)
      logger.info(`Logged ${logEntries.length} processing results`)
    }
  }

  const stats = await processingLog.getStats(PROMPT_HASH)

  return {
    metadata: {
      conversations: totalConversations,
      processed: totalConversations - skipped,
      skipped,
      messages: totalMessages,
      preferences: totalPrefsWritten,
      decisions: totalDecisionsWritten,
      resumed,
      ...(useBatch ? {
        batch: {
          jobName: batchJobName,
          totalRequests,
          parseFailures,
        },
      } : {
        direct: {
          totalRequests,
          parseFailures,
        },
      }),
      lineage: {
        model: GEMINI_MODEL,
        provider: 'google',
        api: useBatch ? 'batch' : 'direct',
        promptVersion: PROMPT_VERSION,
        promptHash: PROMPT_HASH,
      },
      processingLog: stats,
    },
  }
}
