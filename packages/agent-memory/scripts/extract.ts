#!/usr/bin/env bun
/**
 * Preference Extraction System
 *
 * Loads Claude Code session data, chunks large conversations,
 * and uses Gemini to extract high-signal user preferences.
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';

import {
  CATEGORIES,
  parseSessionContent,
  filterConversation,
  chunkConversation,
  formatConversation,
  parseResponseJson,
  deduplicatePreferences,
  generatePreferenceId,
  generateContentHash,
  type Preference,
  type PreferenceKind,
  type Confidence,
  type ConversationMessage,
  type SessionMetadata,
  type SourceReference,
  type SourceType,
} from './lib';

// ============================================
// CONFIG
// ============================================

const SESSIONS_DIR = join(homedir(), 'Desktop', 'sessions');
const OUTPUT_DIR = join(homedir(), 'Desktop', 'agentPreferences');
const PREFERENCES_DIR = join(OUTPUT_DIR, 'extractions');
const PROCESSED_SESSIONS_FILE = join(OUTPUT_DIR, 'processed_sessions.json');

const CHUNK_SIZE_BYTES = 300 * 1024; // 300KB
const MAX_SESSIONS_TO_PROCESS = 200; // Set to 0 for all sessions, or N to limit for testing
const CONCURRENT_REQUESTS = 5; // Number of parallel LLM requests

// ============================================
// SESSION TRACKING
// ============================================

interface ExtractionLineage {
  model: string;
  provider: string;
  promptVersion: string;
  promptHash: string;
}

interface ProcessedSession {
  filename: string;
  contentHash: string;
  processedAt: string;
  extractionFile: string;
  preferencesFound: number;
  lineage: ExtractionLineage;
}

interface ProcessedSessionsManifest {
  sessions: Record<string, ProcessedSession>;
  lastUpdated: string;
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

async function loadProcessedSessions(): Promise<ProcessedSessionsManifest> {
  try {
    const content = await readFile(PROCESSED_SESSIONS_FILE, 'utf-8');
    return JSON.parse(content) as ProcessedSessionsManifest;
  } catch {
    return { sessions: {}, lastUpdated: new Date().toISOString() };
  }
}

async function saveProcessedSessions(manifest: ProcessedSessionsManifest): Promise<void> {
  manifest.lastUpdated = new Date().toISOString();
  await writeFile(PROCESSED_SESSIONS_FILE, JSON.stringify(manifest, null, 2));
}

function generateExtractionId(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const randomSuffix = Math.random().toString(36).slice(2, 6);
  return `${timestamp}_${randomSuffix}`;
}

/**
 * Parse session metadata from filename.
 * Claude Code: -Users-name-Desktop-project_sessionId.jsonl
 * GraphD: graphd_session_key.jsonl
 */
function parseSessionMetadata(filename: string): SessionMetadata {
  // GraphD sessions
  if (filename.startsWith('graphd_')) {
    const sessionKey = filename.replace('graphd_', '').replace('.jsonl', '');
    return {
      source_type: 'graphd',
      session_id: sessionKey,
      filename,
    };
  }

  // Claude Code sessions: -Users-name-path_sessionId.jsonl
  const withoutExt = filename.replace('.jsonl', '');
  const lastUnderscore = withoutExt.lastIndexOf('_');

  if (lastUnderscore > 0) {
    const pathPart = withoutExt.slice(0, lastUnderscore);
    const sessionId = withoutExt.slice(lastUnderscore + 1);

    // Convert path back: -Users-name-Desktop-project -> /Users/name/Desktop/project
    const project = pathPart.replace(/^-/, '/').replace(/-/g, '/');

    return {
      source_type: 'claude_code',
      session_id: sessionId,
      project,
      filename,
    };
  }

  // Fallback
  return {
    source_type: 'claude_code',
    session_id: withoutExt,
    filename,
  };
}

// ============================================
// LOGGER
// ============================================

const logger = {
  debug: (msg: string, meta?: unknown) => console.log(`[DEBUG] ${msg}`, meta ?? ''),
  info: (msg: string, meta?: unknown) => console.log(`[INFO] ${msg}`, meta ?? ''),
  warn: (msg: string, meta?: unknown) => console.warn(`[WARN] ${msg}`, meta ?? ''),
  error: (msg: string, meta?: unknown) => console.error(`[ERROR] ${msg}`, meta ?? ''),
};

// ============================================
// EXTRACTION PROMPT (versioned)
// ============================================

const PROMPT_VERSION = 'v2';

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
2) Counterexample test:
   If a normal scenario breaks it easily, it's not durable (downgrade confidence or kind).
3) Failure-mode test:
   If it doesn't prevent a real failure mode or recurring confusion, it's probably not worth keeping.
4) Independence test:
   Count only distinct moments; repeated rephrases in one turn count as ONE.

IGNORE (set kind="ignore")
- Project-specific tasks: rename this symbol, fix this bug, move function, line-number requests
- Style already enforced by tools (formatters/linters), whitespace/quotes, trivial formatting
- Vague complaints/praise with no actionable preference
- Purely descriptive statements with no "do this in the future" implication

LOCAL_CONVENTION (kind="local_convention")
- Naming conventions, UI label choices, package naming taste
- Implementation preferences that are plausible defaults but not broadly true
- One-off directives that might be useful sometimes but lack evidence/justification

PRINCIPLE_CANDIDATE (kind="principle_candidate")
- Architecture/process invariants: correctness, determinism, state ownership, cache invalidation, auditability
- Testing philosophy that changes how you build
- Error-handling defaults tied to failure modes
- Boundary/interface contracts with recurring importance

EXAMPLES

EXAMPLE A — Correction ⇒ principle_candidate
[USER]: no don't create a new ErrorBoundary component, we already have one in shared/
[ASSISTANT]: ok

OUTPUT ITEM:
{
  "category": "code_organization",
  "kind": "principle_candidate",
  "preference": "Reuse existing shared components before creating new ones",
  "entity_free_formulation": "Prefer reusing existing utilities before adding new ones",
  "scope": "when adding components/utilities",
  "context": "Search common/shared locations first to avoid duplication and drift.",
  "failure_mode_prevented": "duplicate implementations and inconsistent behavior",
  "signal_strength": "implicit",
  "evidence_count": 1,
  "evidence_notes": ["User corrected creation of new component; pointed to shared reuse."],
  "counterexample": "When the shared component doesn't meet new requirements and extending it would be worse",
  "confidence": "medium"
}

EXAMPLE B — Explicit + tradeoff ⇒ principle_candidate
[USER]: I prefer composition over inheritance. Don't extend classes, use hooks or HOCs instead.

OUTPUT ITEM:
{
  "category": "architecture",
  "kind": "principle_candidate",
  "preference": "Use composition instead of class inheritance",
  "entity_free_formulation": "Prefer composition over inheritance for code reuse",
  "scope": "when sharing logic across modules",
  "context": "Favor composable functions/hooks over extending base classes.",
  "failure_mode_prevented": "tight coupling and brittle hierarchies",
  "signal_strength": "explicit",
  "evidence_count": 1,
  "evidence_notes": ["User explicitly stated preference and alternatives."],
  "counterexample": "When extending a stable framework base class is the intended pattern",
  "confidence": "high"
}

EXAMPLE C — Naming taste ⇒ local_convention
[USER]: use 'agentType' instead of 'tier'

OUTPUT ITEM:
{
  "category": "naming",
  "kind": "local_convention",
  "preference": "Use 'agentType' instead of 'tier' in capability classification",
  "entity_free_formulation": "Prefer clearer names over ambiguous labels in schemas",
  "scope": "configuration and routing schemas",
  "context": "Use terminology that matches the concept and reduces misreadings.",
  "failure_mode_prevented": "confusion about what a field represents",
  "signal_strength": "explicit",
  "evidence_count": 1,
  "evidence_notes": ["User requested renaming tier -> agentType."],
  "counterexample": "When the broader system already standardizes on the older term",
  "confidence": "low"
}

Output ONLY a valid JSON array of preference objects. If no generalizable preferences found, output [].`;

// Compute prompt hash for lineage tracking (changes when prompt content changes)
const PROMPT_HASH = computeContentHash(EXTRACTION_PROMPT);

// ============================================
// EXTRACTION
// ============================================

interface ChunkTask {
  sessionPath: string;
  chunkIndex: number;
  totalChunks: number;
  chunk: ConversationMessage[];
  metadata: SessionMetadata;
}

interface ExtractionResult {
  success: boolean;
  preferences: Preference[];
}

/**
 * Build provenance info from chunk messages.
 */
function buildChunkProvenance(chunk: ConversationMessage[], metadata: SessionMetadata): {
  sourceRef: SourceReference;
  timestamps: string[];
  projects: string[];
} {
  const timestamps: string[] = [];
  const projects = new Set<string>();

  // Collect timestamps and projects from messages
  for (const msg of chunk) {
    if (msg.timestamp) timestamps.push(msg.timestamp);
    if (msg.project) projects.add(msg.project);
  }

  // Add session-level project if available
  if (metadata.project) projects.add(metadata.project);

  // Build source reference
  const sourceRef: SourceReference = {
    source_type: metadata.source_type,
    session_id: metadata.session_id,
    timestamp: timestamps[0] ?? new Date().toISOString(),
    project: metadata.project ?? [...projects][0],
    git_branch: metadata.git_branch,
  };

  return { sourceRef, timestamps, projects: [...projects] };
}

async function extractPreferencesFromChunk(
  client: GoogleGenAI,
  chunk: ConversationMessage[],
  model: string,
  metadata: SessionMetadata,
  extractionId: string
): Promise<ExtractionResult> {
  const conversationText = formatConversation(chunk);
  const { sourceRef, timestamps, projects } = buildChunkProvenance(chunk, metadata);

  logger.debug(`Conversation text length: ${conversationText.length} chars`);

  const prompt = `${EXTRACTION_PROMPT}

Conversation to analyze:
${conversationText}

Remember: Output ONLY a valid JSON array of preference objects. If no generalizable preferences found, output [].`;

  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      logger.info(`Calling Gemini (attempt ${attempt + 1}/${maxAttempts})`);

      const response = await client.models.generateContent({
        model,
        contents: prompt,
      });

      const content = response.text ?? '';

      logger.debug(`Response received: ${content.length} chars`);

      const rawPreferences = parseResponseJson<Partial<Preference>[]>(content);
      if (!Array.isArray(rawPreferences)) {
        return { success: true, preferences: [] };
      }

      // Attach provenance to each extracted preference
      const preferences: Preference[] = rawPreferences.map((raw) => {
        const pref: Preference = {
          id: generatePreferenceId(), // Unique per instance
          content_hash: '', // Will be computed below
          extraction_id: extractionId,
          category: raw.category ?? 'workflow',
          kind: raw.kind ?? 'local_convention',
          preference: raw.preference ?? '',
          entity_free_formulation: raw.entity_free_formulation ?? '',
          scope: raw.scope ?? '',
          context: raw.context ?? '',
          failure_mode_prevented: raw.failure_mode_prevented ?? '',
          signal_strength: raw.signal_strength ?? 'implicit',
          evidence_count: raw.evidence_count ?? 1,
          evidence_notes: raw.evidence_notes ?? [],
          counterexample: raw.counterexample ?? '',
          confidence: raw.confidence ?? 'low',
          first_seen: timestamps[0] ?? new Date().toISOString(),
          last_seen: timestamps[timestamps.length - 1] ?? new Date().toISOString(),
          projects: projects.filter(Boolean),
          sources: [sourceRef],
        };
        pref.content_hash = generateContentHash(pref);
        return pref;
      });

      logger.debug(`Parsed ${preferences.length} preferences with provenance`);
      return { success: true, preferences };
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      logger.warn(`Extraction failed (attempt ${attempt + 1}): ${errorMsg}`);
      if (attempt === maxAttempts - 1) {
        return { success: false, preferences: [] };
      }
    }
  }

  return { success: false, preferences: [] };
}

// ============================================
// MAIN
// ============================================

const GEMINI_MODEL = 'gemini-3-flash-preview';

async function main() {
  console.log('Preference Extraction System');
  console.log('='.repeat(40));

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY not set');
    console.error("  export GEMINI_API_KEY='your-key'");
    process.exit(1);
  }

  // Debug: show masked key
  const masked = apiKey.length > 8
    ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)} (${apiKey.length} chars)`
    : `[key too short: ${apiKey.length} chars]`;
  console.log(`Gemini API key: ${masked}`);
  console.log(`Model: ${GEMINI_MODEL}`);

  // GoogleGenAI reads GEMINI_API_KEY from env automatically
  const client = new GoogleGenAI({ apiKey });

  const availableProvider = 'gemini';
  const availableModel = GEMINI_MODEL;

  // Load processed sessions manifest
  const manifest = await loadProcessedSessions();
  const alreadyProcessedCount = Object.keys(manifest.sessions).length;
  if (alreadyProcessedCount > 0) {
    console.log(`Loaded manifest: ${alreadyProcessedCount} sessions previously processed`);
  }

  let sessionFiles: string[];
  try {
    const files = await readdir(SESSIONS_DIR);
    sessionFiles = files
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(SESSIONS_DIR, f));
  } catch {
    console.error(`No session files found in ${SESSIONS_DIR}`);
    console.log('Run sync_sessions.sh first to copy sessions.');
    process.exit(1);
  }

  if (sessionFiles.length === 0) {
    console.error(`No .jsonl files found in ${SESSIONS_DIR}`);
    process.exit(1);
  }

  console.log(`Found ${sessionFiles.length} total session files`);

  // Limit sessions for testing if configured
  if (MAX_SESSIONS_TO_PROCESS > 0) {
    sessionFiles = sessionFiles.slice(0, MAX_SESSIONS_TO_PROCESS);
    console.log(`Limited to ${sessionFiles.length} session files for testing`);
  }

  // Collect all chunk tasks for batched parallel processing
  const tasks: ChunkTask[] = [];
  let totalMessages = 0;
  let sessionsProcessed = 0;
  let sessionsSkipped = 0;

  // Track session metadata for manifest updates
  // Sessions start with chunksTotal/chunksSucceeded to track partial failures
  const sessionMeta: Map<string, { contentHash: string; preferencesFound: number; chunksTotal: number; chunksSucceeded: number }> = new Map();

  console.log('\nLoading sessions and creating tasks...');
  for (const sessionPath of sessionFiles) {
    const fileName = sessionPath.split('/').pop() ?? sessionPath;

    // Parse session metadata from filename
    const metadata = parseSessionMetadata(fileName);

    // Read raw content for hashing
    const rawContent = await readFile(sessionPath, 'utf-8');
    const contentHash = computeContentHash(rawContent);

    // Check if already processed with same content
    const existing = manifest.sessions[fileName];
    if (existing && existing.contentHash === contentHash) {
      console.log(`  Skipping: ${fileName} (already processed)`);
      sessionsSkipped++;
      continue;
    }

    if (existing) {
      console.log(`  Reprocessing: ${fileName} (content changed)`);
    } else {
      console.log(`  Loading: ${fileName} [${metadata.source_type}]`);
    }

    const rawMessages = parseSessionContent(rawContent);
    const filtered = filterConversation(rawMessages, metadata);

    if (filtered.length === 0) {
      console.log(`    No conversation content, skipping`);
      continue;
    }

    totalMessages += filtered.length;
    sessionsProcessed++;

    // Initialize metadata for this session (chunksTotal updated below after chunking)
    sessionMeta.set(fileName, { contentHash, preferencesFound: 0, chunksTotal: 0, chunksSucceeded: 0 });

    const sessionJson = JSON.stringify(filtered);
    const sessionSize = new TextEncoder().encode(sessionJson).length;

    let chunks: ConversationMessage[][];
    if (sessionSize > CHUNK_SIZE_BYTES) {
      console.log(`    Large session (${Math.round(sessionSize / 1024)}KB), splitting into chunks...`);
      chunks = [...chunkConversation(filtered, CHUNK_SIZE_BYTES)];
    } else {
      chunks = [filtered];
    }

    console.log(`    ${chunks.length} chunk(s), project: ${metadata.project ?? 'unknown'}`);

    // Update chunk count in metadata
    const meta = sessionMeta.get(fileName)!;
    meta.chunksTotal = chunks.length;

    for (let i = 0; i < chunks.length; i++) {
      tasks.push({
        sessionPath: fileName,
        chunkIndex: i + 1,
        totalChunks: chunks.length,
        chunk: chunks[i],
        metadata,
      });
    }
  }

  if (sessionsSkipped > 0) {
    console.log(`\nSkipped ${sessionsSkipped} already-processed sessions`);
  }

  if (tasks.length === 0) {
    console.log('\nNo new sessions to process. All sessions already extracted.');
    return;
  }

  console.log(`\nTotal tasks to process: ${tasks.length}`);
  console.log(`Parallelism: ${CONCURRENT_REQUESTS} concurrent requests\n`);

  // Generate extraction ID for this run
  const extractionId = generateExtractionId();
  const extractionFile = `preferences_${extractionId}.json`;

  // Process chunks in batches
  const allPreferences: Preference[] = [];
  let completedTasks = 0;

  for (let i = 0; i < tasks.length; i += CONCURRENT_REQUESTS) {
    const batch = tasks.slice(i, i + CONCURRENT_REQUESTS);

    const batchResults = await Promise.all(
      batch.map(async (task) => {
        const { sessionPath, chunkIndex, totalChunks, chunk, metadata } = task;
        const result = await extractPreferencesFromChunk(client, chunk, availableModel, metadata, extractionId);
        const status = result.success ? `${result.preferences.length} preferences` : 'FAILED';
        console.log(`[${++completedTasks}/${tasks.length}] ${sessionPath} chunk ${chunkIndex}/${totalChunks}: ${status}`);

        // Track success and preferences per session
        const meta = sessionMeta.get(sessionPath);
        if (meta) {
          if (result.success) {
            meta.chunksSucceeded++;
            meta.preferencesFound += result.preferences.length;
          }
        }

        return result;
      })
    );

    for (const result of batchResults) {
      if (result.success) {
        allPreferences.push(...result.preferences);
      }
    }
  }

  console.log(`\nDeduplicating ${allPreferences.length} raw preferences...`);
  const finalPreferences = deduplicatePreferences(allPreferences);
  console.log(`Reduced to ${finalPreferences.length} unique preferences`);

  // Build list of successfully processed sessions in this run
  const sessionsInRun = Array.from(sessionMeta.entries())
    .filter(([, meta]) => meta.chunksSucceeded === meta.chunksTotal && meta.chunksTotal > 0)
    .map(([fileName]) => fileName);

  // Lineage info for reproducibility
  const lineage: ExtractionLineage = {
    model: availableModel,
    provider: availableProvider,
    promptVersion: PROMPT_VERSION,
    promptHash: PROMPT_HASH,
  };

  const output = {
    id: extractionId,
    lineage,
    preferences: finalPreferences,
    meta: {
      extracted_at: new Date().toISOString(),
      sessions_processed: sessionsInRun,
      session_count: sessionsInRun.length,
      total_messages_analyzed: totalMessages,
      raw_preferences_found: allPreferences.length,
    },
  };

  // Ensure output directories exist
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(PREFERENCES_DIR, { recursive: true });

  // Write timestamped extraction file
  const extractionPath = join(PREFERENCES_DIR, extractionFile);
  await writeFile(extractionPath, JSON.stringify(output, null, 2));
  console.log(`\nExtraction written to: ${extractionPath}`);

  // Update manifest only with fully successful sessions (all chunks succeeded)
  let successfulSessions = 0;
  let failedSessions = 0;
  for (const [fileName, meta] of sessionMeta) {
    if (meta.chunksSucceeded === meta.chunksTotal && meta.chunksTotal > 0) {
      manifest.sessions[fileName] = {
        filename: fileName,
        contentHash: meta.contentHash,
        processedAt: new Date().toISOString(),
        extractionFile,
        preferencesFound: meta.preferencesFound,
        lineage,
      };
      successfulSessions++;
    } else {
      console.warn(`Session ${fileName} had failures (${meta.chunksSucceeded}/${meta.chunksTotal} chunks succeeded), not marking as processed`);
      failedSessions++;
    }
  }
  await saveProcessedSessions(manifest);
  console.log(`Updated manifest: ${PROCESSED_SESSIONS_FILE}`);
  if (failedSessions > 0) {
    console.log(`  ${successfulSessions} sessions marked complete, ${failedSessions} sessions had failures (will retry next run)`);
  }

  console.log('\nPreferences by category:');
  const byCategory = new Map<string, Preference[]>();
  for (const p of finalPreferences) {
    const cat = p.category ?? 'unknown';
    const existing = byCategory.get(cat) ?? [];
    existing.push(p);
    byCategory.set(cat, existing);
  }

  for (const cat of CATEGORIES) {
    const prefs = byCategory.get(cat) ?? [];
    if (prefs.length > 0) {
      console.log(`  ${cat}: ${prefs.length}`);
    }
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
