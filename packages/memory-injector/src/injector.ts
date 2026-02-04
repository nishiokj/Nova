/**
 * Memory Injector Implementation
 *
 * Stateless retrieval layer that queries coding_preferences and coding_decisions
 * via the agent-memory daemon and returns combined, sorted results.
 *
 * Also provides watcher context injection for workers after realign.
 */

import fs from 'fs/promises';
import path from 'path';
import { SyncClient } from 'agent-memory';
import type {
  MemoryInjector,
  InjectParams,
  InjectParamsV2,
  InjectResultV2,
  MemoryInjectorConfig,
  InjectWatcherContextParams,
  WatcherContextResult,
} from './types.js';

interface ScoredItem {
  content: string;
  score: number;
  source: 'memory' | 'preference' | 'decision';
}

interface QuerySpec {
  text: string;
  weight: number;
  kind: 'phrase' | 'topic' | 'hotword' | 'keyword' | 'fallback';
}

interface QueryPlan {
  topic: string | null;
  hotwords: string[];
  keywords: string[];
  phrases: string[];
  queries: QuerySpec[];
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'done', 'for', 'from', 'had', 'has', 'have', 'how',
  'if', 'in', 'into', 'is', 'it', 'its', 'just', 'like', 'make', 'made',
  'may', 'might', 'more', 'most', 'no', 'not', 'of', 'on', 'or', 'our',
  'out', 'over', 'please', 'should', 'so', 'some', 'such', 'than', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'to', 'up', 'use', 'using', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'who', 'will', 'with', 'would', 'you', 'your',
  'context', 'contexts', 'file', 'files', 'goal', 'goals', 'item', 'items',
  'log', 'logs', 'note', 'notes', 'objective', 'session', 'sessions', 'work',
  'workitem', 'workitems',
  'json', 'jsonl', 'md', 'ts', 'tsx', 'js', 'jsx', 'txt', 'yaml', 'yml',
]);

const QUERY_PLAN_MAX_QUERIES = 8;
const QUERY_PLAN_MAX_HOTWORDS = 8;
const QUERY_PLAN_MAX_KEYWORDS = 8;
const QUERY_PLAN_MAX_PHRASES = 5;
const QUERY_PLAN_PHRASE_TOKEN_COUNT = 3;
const QUERY_PLAN_PHRASE_FALLBACK_TOKEN_COUNT = 2;
const QUERY_PLAN_MAX_TOPIC_TOKENS = 3;
const QUERY_PLAN_MAX_QUERY_CHARS = 80;
const QUERY_PLAN_MIN_QUERY_CHARS = 3;
const QUERY_WEIGHT_PHRASE = 0.95;
const QUERY_WEIGHT_TOPIC = 0.9;
const QUERY_WEIGHT_HOTWORD = 0.75;
const QUERY_WEIGHT_KEYWORD = 0.65;
const QUERY_WEIGHT_FALLBACK = 0.6;

const DEFAULT_MEMORY_CONNECTORS = (() => {
  const env = process.env.MEMORY_INJECTOR_CONNECTORS;
  if (typeof env === 'string' && env.trim().length > 0) {
    return env.trim();
  }
  return 'claude_sessions,rex_sessions,watcher_sessions';
})();

const RECENCY_WINDOW_DAYS = 30;
const RECENCY_MAX_BONUS = 0.25;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function looksSensitive(token: string): boolean {
  if (token.length >= 32 && /^[a-z0-9+/=_-]+$/i.test(token)) return true;
  if (/^[a-f0-9]{32,}$/i.test(token)) return true;
  if (/^sk-[a-z0-9]{10,}$/i.test(token)) return true;
  if (/^[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}$/i.test(token)) return true;
  return false;
}

function normalizeToken(raw: string): string | null {
  const trimmed = raw.trim().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (STOPWORDS.has(lower)) return null;
  if (looksSensitive(lower)) return null;
  const isShortAllowed = /^[a-z]+\d+$/i.test(lower) || /^v\d+$/i.test(lower);
  if (lower.length < 3 && !isShortAllowed) return null;
  return lower;
}

function clampQuery(text: string): string {
  const collapsed = collapseWhitespace(text);
  if (collapsed.length <= QUERY_PLAN_MAX_QUERY_CHARS) return collapsed;
  return collapsed.slice(0, QUERY_PLAN_MAX_QUERY_CHARS).trim();
}

function extractTopic(rawQuery: string): string | null {
  const firstClause = rawQuery.split(/[\n.!?]/)[0] ?? rawQuery;
  const tokens: string[] = [];
  for (const chunk of firstClause.split(/[^a-z0-9._/-]+/i)) {
    if (!chunk) continue;
    const token = normalizeToken(chunk);
    if (!token) continue;
    if (tokens.includes(token)) continue;
    tokens.push(token);
    if (tokens.length >= QUERY_PLAN_MAX_TOPIC_TOKENS) break;
  }
  if (tokens.length === 0) return null;
  const topic = tokens.join(' ');
  return topic.length >= QUERY_PLAN_MIN_QUERY_CHARS ? topic : null;
}

function extractHotwords(rawQuery: string): string[] {
  const candidates = new Map<string, number>();

  const addCandidate = (token: string | null, score: number): void => {
    if (!token) return;
    const existing = candidates.get(token);
    if (existing === undefined || score > existing) {
      candidates.set(token, score);
    }
  };

  const pathPattern = /(?:[a-z0-9._-]+[\\/])+[a-z0-9._-]+/gi;
  for (const match of rawQuery.matchAll(pathPattern)) {
    const rawPath = match[0];
    const base = path.basename(rawPath);
    const baseToken = normalizeToken(base);
    addCandidate(baseToken, 2.5);
    const stem = base.includes('.') ? base.split('.')[0] : base;
    addCandidate(normalizeToken(stem), 2.0);
  }

  const identifierPattern = /[a-z_][a-z0-9_]{2,}/gi;
  for (const match of rawQuery.matchAll(identifierPattern)) {
    const raw = match[0];
    const token = normalizeToken(raw);
    if (!token) continue;
    const bonus = /[A-Z]/.test(raw) || raw.includes('_') ? 1.6 : 1.0;
    addCandidate(token, bonus);
  }

  const hyphenPattern = /[a-z][a-z0-9-]{2,}/gi;
  for (const match of rawQuery.matchAll(hyphenPattern)) {
    const token = normalizeToken(match[0]);
    addCandidate(token, 1.2);
  }

  const tokens = Array.from(candidates.entries())
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([token]) => token);

  return tokens.slice(0, QUERY_PLAN_MAX_HOTWORDS);
}

function extractOrderedTokens(rawQuery: string): string[] {
  const tokens: string[] = [];
  const wordPattern = /[a-z0-9]{2,}/gi;
  for (const match of rawQuery.matchAll(wordPattern)) {
    const token = normalizeToken(match[0]);
    if (!token) continue;
    tokens.push(token);
  }
  return tokens;
}

function extractKeywords(rawQuery: string): string[] {
  const counts = new Map<string, { count: number; score: number }>();
  const wordPattern = /[a-z0-9]{2,}/gi;

  for (const match of rawQuery.matchAll(wordPattern)) {
    const token = normalizeToken(match[0]);
    if (!token) continue;
    const existing = counts.get(token);
    const nextCount = (existing?.count ?? 0) + 1;
    const lengthBonus = token.length >= 10 ? 1.1 : token.length >= 7 ? 0.8 : token.length >= 5 ? 0.5 : 0.2;
    const score = nextCount + lengthBonus;
    counts.set(token, { count: nextCount, score });
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1].score - a[1].score || b[1].count - a[1].count || b[0].length - a[0].length)
    .map(([token]) => token)
    .slice(0, QUERY_PLAN_MAX_KEYWORDS);
}

function extractPhrases(rawQuery: string): string[] {
  const tokens = extractOrderedTokens(rawQuery);
  const phrases: string[] = [];
  const phraseSize = tokens.length >= QUERY_PLAN_PHRASE_TOKEN_COUNT
    ? QUERY_PLAN_PHRASE_TOKEN_COUNT
    : tokens.length >= QUERY_PLAN_PHRASE_FALLBACK_TOKEN_COUNT
      ? QUERY_PLAN_PHRASE_FALLBACK_TOKEN_COUNT
      : 0;

  if (phraseSize === 0) return phrases;

  for (let i = 0; i <= tokens.length - phraseSize; i++) {
    const phrase = tokens.slice(i, i + phraseSize).join(' ');
    if (phrases.includes(phrase)) continue;
    phrases.push(phrase);
    if (phrases.length >= QUERY_PLAN_MAX_PHRASES) break;
  }

  return phrases;
}

function buildQueryPlan(rawQuery: string): QueryPlan {
  const cleaned = collapseWhitespace(rawQuery);
  const topic = extractTopic(cleaned);
  const hotwords = extractHotwords(cleaned);
  const keywords = extractKeywords(cleaned);
  const phrases = extractPhrases(cleaned);

  const queries: QuerySpec[] = [];
  for (const phrase of phrases) {
    const text = clampQuery(phrase);
    if (text.length >= QUERY_PLAN_MIN_QUERY_CHARS) {
      queries.push({ text, weight: QUERY_WEIGHT_PHRASE, kind: 'phrase' });
    }
  }
  const maxLen = Math.max(hotwords.length, keywords.length);
  for (let i = 0; i < maxLen; i++) {
    const hotword = hotwords[i];
    if (hotword && !queries.some((q) => q.text === hotword)) {
      const text = clampQuery(hotword);
      if (text.length >= QUERY_PLAN_MIN_QUERY_CHARS) {
        queries.push({ text, weight: QUERY_WEIGHT_HOTWORD, kind: 'hotword' });
      }
    }
    const keyword = keywords[i];
    if (keyword && !queries.some((q) => q.text === keyword)) {
      const text = clampQuery(keyword);
      if (text.length >= QUERY_PLAN_MIN_QUERY_CHARS) {
        queries.push({ text, weight: QUERY_WEIGHT_KEYWORD, kind: 'keyword' });
      }
    }
  }

  if (topic) {
    const topicTokens = topic.split(' ').filter(Boolean);
    for (const token of topicTokens) {
      if (queries.some((q) => q.text === token)) continue;
      const text = clampQuery(token);
      if (text.length >= QUERY_PLAN_MIN_QUERY_CHARS) {
        queries.push({ text, weight: QUERY_WEIGHT_TOPIC, kind: 'topic' });
      }
    }
  }

  if (queries.length === 0 && cleaned.length >= QUERY_PLAN_MIN_QUERY_CHARS) {
    queries.push({
      text: clampQuery(cleaned),
      weight: QUERY_WEIGHT_FALLBACK,
      kind: 'fallback',
    });
  }

  const deduped = new Map<string, QuerySpec>();
  for (const query of queries) {
    const key = query.text.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, query);
  }

  return {
    topic,
    hotwords,
    keywords,
    phrases,
    queries: Array.from(deduped.values()).slice(0, QUERY_PLAN_MAX_QUERIES),
  };
}

function summarizeQueryPlan(plan: QueryPlan): string {
  if (!plan.queries.length) return '';
  return plan.queries.map((query) => query.text).join(' | ');
}

function safeScore(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isNaN(value) ? 0 : value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const coerced = Number(value);
    return Number.isNaN(coerced) ? 0 : coerced;
  }
  return 0;
}

function recencyBonus(timestamp?: string): number {
  if (!timestamp) return 0;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return 0;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ageMs = Math.max(0, todayUtc - parsed);
  const ageDays = ageMs / MS_PER_DAY;
  const ratio = Math.max(0, 1 - ageDays / RECENCY_WINDOW_DAYS);
  return ratio * RECENCY_MAX_BONUS;
}

/**
 * Create a memory injector that queries the agent-memory daemon.
 *
 * @param config - Configuration with baseUrl and optional timeout
 * @returns MemoryInjector instance
 */
export function createMemoryInjector(config: MemoryInjectorConfig): MemoryInjector {
  const client = new SyncClient({
    baseUrl: config.baseUrl,
    timeout: config.timeout ?? 5000,
  });

  return {
    summarizeQueryPlan(rawQuery: string): string {
      if (!rawQuery || !rawQuery.trim()) return '';
      const plan = buildQueryPlan(rawQuery);
      const summary = summarizeQueryPlan(plan);
      return summary || rawQuery;
    },
    async inject({ query, maxTokens }: InjectParams): Promise<string | null> {
      // Validate query - return null early if empty or whitespace-only
      if (!query || !query.trim()) {
        return null;
      }
      const tokenBudget = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0;
      if (tokenBudget <= 0) {
        return null;
      }

      const queryPlan = buildQueryPlan(query);
      if (queryPlan.queries.length === 0) {
        return null;
      }

      const memoryLimit = 6;
      const preferenceLimit = 6;
      const decisionLimit = 6;

      const memorySearches = queryPlan.queries.map(async (spec) => {
        if (!client.memory?.search) {
          return { spec, items: [] as Array<{ summary: string; source_timestamp?: string; updated_at: string }> };
        }
        try {
          const res = await client.memory.search({
            q: spec.text,
            limit: memoryLimit,
            connectors: DEFAULT_MEMORY_CONNECTORS,
          });
          return { spec, items: res?.items ?? [] };
        } catch (err) {
          console.error('[MemoryInjector] Conversational memory search failed:', err);
          return { spec, items: [] as Array<{ summary: string; source_timestamp?: string; updated_at: string }> };
        }
      });

      const preferenceSearches = queryPlan.queries.map(async (spec) => {
        try {
          const res = await client.preferences.search({ q: spec.text, limit: preferenceLimit });
          return { spec, preferences: res?.preferences ?? [] };
        } catch (err) {
          console.error('[MemoryInjector] Preferences search failed:', err);
          return { spec, preferences: [] };
        }
      });

      const decisionSearches = queryPlan.queries.map(async (spec) => {
        try {
          const res = await client.decisions.search({ q: spec.text, limit: decisionLimit });
          return { spec, decisions: res?.decisions ?? [] };
        } catch (err) {
          console.error('[MemoryInjector] Decisions search failed:', err);
          return { spec, decisions: [] };
        }
      });

      const [memoryResults, preferenceResults, decisionResults] = await Promise.all([
        Promise.all(memorySearches),
        Promise.all(preferenceSearches),
        Promise.all(decisionSearches),
      ]);

      const sourceCaps = {
        memory: 6,
        preference: 6,
        decision: 6,
      } as const;

      const formatDateSuffix = (value?: string): string => {
        if (!value) return '';
        const parsed = Date.parse(value);
        if (!Number.isFinite(parsed)) return '';
        return ` (${new Date(parsed).toISOString().slice(0, 10)})`;
      };

      const memoryScoredRaw: ScoredItem[] = [];
      for (const { spec, items } of memoryResults) {
        items.forEach((item, index) => {
          if (!item?.summary) return;
          const timestamp = item.source_timestamp ?? item.updated_at;
          const score = spec.weight + recencyBonus(timestamp) - index * 0.015;
          memoryScoredRaw.push({
            content: `${item.summary}${formatDateSuffix(timestamp)}`,
            score,
            source: 'memory',
          });
        });
      }

      const prefScoredRaw: ScoredItem[] = [];
      for (const { spec, preferences } of preferenceResults) {
        for (const pref of preferences ?? []) {
          if (!pref?.preference) continue;
          const timestamp = (pref as { created_at?: string }).created_at;
          const score = safeScore(pref.rank) * spec.weight + recencyBonus(timestamp);
          prefScoredRaw.push({
            content: pref.preference,
            score,
            source: 'preference',
          });
        }
      }

      const decisionScoredRaw: ScoredItem[] = [];
      for (const { spec, decisions } of decisionResults) {
        for (const decision of decisions ?? []) {
          if (!decision?.decision) continue;
          const rawScore = decision.rank ?? decision.similarity;
          const timestamp = (decision as { created_at?: string }).created_at;
          const score = safeScore(rawScore) * spec.weight + recencyBonus(timestamp);
          decisionScoredRaw.push({
            content: decision.decision,
            score,
            source: 'decision',
          });
        }
      }

      const memoryScored = memoryScoredRaw
        .filter((item) => item.content && item.content.trim().length > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, sourceCaps.memory);

      const prefScored = prefScoredRaw
        .filter((item) => item.content && item.content.trim().length > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, sourceCaps.preference);

      const decisionScored = decisionScoredRaw
        .filter((item) => item.content && item.content.trim().length > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, sourceCaps.decision);

      const items: ScoredItem[] = [...memoryScored, ...prefScored, ...decisionScored]
        .sort((a, b) => b.score - a.score);

      if (items.length === 0) {
        return null;
      }

      // Deduplicate by normalized content (BUG #13)
      const normalizeForDedup = (text: string): string =>
        text.trim().replace(/\s+/g, ' ').toLowerCase();
      const seen = new Set<string>();
      const dedupedItems: ScoredItem[] = [];
      for (const item of items) {
        const key = normalizeForDedup(item.content);
        if (!seen.has(key)) {
          seen.add(key);
          dedupedItems.push(item);
        }
      }

      // Estimate token count more accurately (BUG #5)
      // CJK characters: ~1-2 tokens per char, Emoji: ~1-2 tokens, Code special chars split more
      // Use a conservative multiplier for non-ASCII content
      function estimateTokens(text: string): number {
        let tokens = 0;
        for (let i = 0; i < text.length; i++) {
          const code = text.charCodeAt(i);
          // Non-ASCII (including CJK, emoji): more tokens
          if (code > 127) {
            // Emoji (usually 2+ chars in UTF-16) or CJK
            tokens += code > 0x7FF ? 1.5 : 1.2;
          } else {
            // ASCII: simple approximation
            tokens += 0.25;
          }
        }
        return Math.ceil(tokens);
      }

      const renderItem = (item: ScoredItem): string => {
        const label = item.source === 'memory'
          ? 'Memory'
          : item.source === 'preference'
            ? 'Preference'
            : 'Decision';
        return `**[${label}]** ${item.content}`;
      };

      // Build output, respecting token limit (BUG #6: continue instead of break for large items)
      const result: string[] = [];
      let tokens = 0;

      for (const item of dedupedItems) {
        const rendered = renderItem(item);
        const itemTokens = estimateTokens(rendered);
        // Skip items that individually exceed maxTokens, but continue checking others
        if (itemTokens > tokenBudget) {
          continue;
        }
        if (tokens + itemTokens > tokenBudget) {
          continue;
        }
        result.push(rendered);
        tokens += itemTokens;
      }

      if (result.length === 0) {
        return null;
      }

      // Format with a header
      return `## Relevant Memory\n\n${result.join('\n\n')}`;
    },

    async injectV2(params: InjectParamsV2): Promise<InjectResultV2 | null> {
      if (params.options?.forceV1Fallback) {
        return null;
      }
      try {
        const response = await client.evidence.retrieve(params);
        if (!response?.content) {
          return null;
        }
        return response;
      } catch (err) {
        console.error('[MemoryInjector] Evidence retrieval failed:', err);
        return null;
      }
    },

    async injectWatcherContext(params: InjectWatcherContextParams): Promise<WatcherContextResult | null> {
      const { workingDir, sessionId, workId, date } = params;

      // Build paths using the watcher file structure
      const dateStr = (date ?? new Date()).toISOString().split('T')[0];
      const sessionDir = path.join(workingDir, '.watcher', dateStr, sessionId);
      const saliencePath = path.join(sessionDir, 'salience.md');
      const semanticPath = path.join(sessionDir, 'workitems', workId, 'semantic.json');

      const sections: string[] = [];
      let hasSalience = false;
      let hasSemantic = false;
      let semanticState: WatcherContextResult['semanticState'] = undefined;

      // Load salience.md
      try {
        const salienceContent = await fs.readFile(saliencePath, 'utf-8');
        if (salienceContent.trim()) {
          sections.push('## Session Context (Salience)\n');
          sections.push(salienceContent);
          sections.push('');
          hasSalience = true;
        }
      } catch {
        // Salience file doesn't exist - that's fine
      }

      // Load semantic.json
      try {
        const semanticContent = await fs.readFile(semanticPath, 'utf-8');
        const semanticData = JSON.parse(semanticContent) as { _state: string; [key: string]: unknown };

        semanticState = semanticData._state as WatcherContextResult['semanticState'];

        if (semanticData._state === 'valid') {
          // Format valid semantic file for injection
          const formatted = formatValidSemanticForInjection(semanticData as unknown as ValidSemanticData);
          sections.push(formatted);
          hasSemantic = true;
        } else if (semanticData._state === 'initial') {
          // Initial state - just show objective
          const initial = semanticData as unknown as { meta: { objective: string; workId: string } };
          sections.push(`## WorkItem Context (${initial.meta.workId})\n`);
          sections.push(`**Objective**: ${initial.meta.objective}\n`);
          sections.push('*Note: This workItem has not yet been audited. Full semantic context will be available after the first cadence audit.*\n');
          hasSemantic = true;
        } else if (semanticData._state === 'failed') {
          // Failed state - note the failure
          const failed = semanticData as unknown as { error: string; previousValidVersion?: number };
          sections.push(`## WorkItem Context (Error)\n`);
          sections.push(`*Semantic generation failed. Error: ${failed.error.slice(0, 200)}*\n`);
          if (failed.previousValidVersion !== undefined) {
            sections.push(`*Previous valid version: v${failed.previousValidVersion.toString().padStart(3, '0')}*\n`);
          }
          hasSemantic = true;
        }
      } catch {
        // Semantic file doesn't exist - that's fine
      }

      if (!hasSalience && !hasSemantic) {
        return null;
      }

      return {
        content: sections.join('\n'),
        hasSalience,
        hasSemantic,
        semanticState,
      };
    },
  };
}

// ============================================
// SEMANTIC FORMATTING HELPERS
// ============================================

interface ValidSemanticData {
  _state: 'valid';
  meta: {
    workId: string;
    lastAudit: string;
    auditSequence: number;
  };
  stateAndProgress: {
    objective: string;
    currentState: Array<{ component: string; status: string; location?: string }>;
    changesMade: Array<{ file: string; summary: string; rationale: string }>;
    gapAnalysis: Array<{ required: string; current: string; blocker?: string }>;
    reasoningTrace: string[];
    blockers: string[];
  };
  decisionContext: {
    pendingQuestions: string[];
    tradeoffs: Array<{
      title: string;
      options: Array<{ id: string; description: string }>;
      considerations: string[];
      assessment?: string;
    }>;
  };
}

export function formatValidSemanticForInjection(semantic: ValidSemanticData): string {
  const sections: string[] = [];

  sections.push(`## WorkItem Context (${semantic.meta.workId})`);
  sections.push('');
  sections.push(`*Last audit: ${semantic.meta.lastAudit} (sequence ${semantic.meta.auditSequence})*`);
  sections.push('');

  // State & Progress
  sections.push('### Current State');
  sections.push('');
  sections.push(`**Objective**: ${semantic.stateAndProgress.objective}`);
  sections.push('');

  if (semantic.stateAndProgress.currentState.length > 0) {
    sections.push('| Component | Status | Location |');
    sections.push('|-----------|--------|----------|');
    for (const cs of semantic.stateAndProgress.currentState) {
      const statusIcon = cs.status === 'complete' ? '✓' :
        cs.status === 'partial' ? '⚠' :
          cs.status === 'blocked' ? '✗' : '○';
      sections.push(`| ${cs.component} | ${statusIcon} ${cs.status} | ${cs.location ?? '-'} |`);
    }
    sections.push('');
  }

  // Changes made
  if (semantic.stateAndProgress.changesMade.length > 0) {
    sections.push('### Changes Made');
    sections.push('');
    for (const change of semantic.stateAndProgress.changesMade) {
      sections.push(`- **${change.file}**: ${change.summary}`);
      sections.push(`  *Rationale*: ${change.rationale}`);
    }
    sections.push('');
  }

  // Gap analysis
  if (semantic.stateAndProgress.gapAnalysis.length > 0) {
    sections.push('### Gap Analysis');
    sections.push('');
    for (const gap of semantic.stateAndProgress.gapAnalysis) {
      sections.push(`- **Required**: ${gap.required}`);
      sections.push(`  **Current**: ${gap.current}`);
      if (gap.blocker) sections.push(`  **Blocker**: ${gap.blocker}`);
    }
    sections.push('');
  }

  // Reasoning trace
  if (semantic.stateAndProgress.reasoningTrace.length > 0) {
    sections.push('### Reasoning Trace');
    sections.push('');
    for (let i = 0; i < semantic.stateAndProgress.reasoningTrace.length; i++) {
      sections.push(`${i + 1}. ${semantic.stateAndProgress.reasoningTrace[i]}`);
    }
    sections.push('');
  }

  // Blockers
  if (semantic.stateAndProgress.blockers.length > 0) {
    sections.push('### Blockers');
    sections.push('');
    for (const blocker of semantic.stateAndProgress.blockers) {
      sections.push(`- ${blocker}`);
    }
    sections.push('');
  }

  // Trade-offs
  if (semantic.decisionContext.tradeoffs.length > 0) {
    sections.push('### Trade-off Analysis');
    sections.push('');
    for (const tradeoff of semantic.decisionContext.tradeoffs) {
      sections.push(`#### ${tradeoff.title}`);
      sections.push('');
      sections.push('**Options:**');
      for (const opt of tradeoff.options) {
        sections.push(`- **${opt.id}**: ${opt.description}`);
      }
      sections.push('');
      if (tradeoff.considerations.length > 0) {
        sections.push('**Considerations:**');
        for (const c of tradeoff.considerations) {
          sections.push(`- ${c}`);
        }
        sections.push('');
      }
      if (tradeoff.assessment) {
        sections.push(`**Assessment**: ${tradeoff.assessment}`);
        sections.push('');
      }
    }
  }

  return sections.join('\n');
}
