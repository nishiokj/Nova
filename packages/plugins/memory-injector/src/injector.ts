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
  InjectRecentParams,
  InjectParamsV2,
  InjectResultV2,
  MemoryInjectorConfig,
  MemoryQueryStrategy,
  QueryIntent,
  QueryPlanSummary,
  InjectWatcherContextParams,
  WatcherContextResult,
} from './types.js';

interface ScoredItem {
  content: string;
  score: number;
  source: 'memory' | 'preference' | 'decision';
  display?: string;
}

interface QuerySpec {
  text: string;
  weight: number;
  kind: 'primary' | 'phrase' | 'topic' | 'hotword' | 'keyword' | 'fallback' | 'intent';
}

interface QueryPlan {
  intent: QueryIntent;
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

const CONCEPT_STOPWORDS = new Set([
  'implement', 'implementation', 'build', 'add', 'create', 'fix', 'bug', 'issue', 'problem',
  'update', 'change', 'improve', 'optimize', 'refactor', 'migrate', 'rewrite', 'use', 'using',
  'make', 'made', 'allow', 'support', 'handle', 'handling', 'ensure',
  'code', 'coding', 'function', 'method', 'class', 'component', 'module', 'service',
  'better', 'best', 'worse',
]);

const INTENT_PATTERNS: Record<QueryIntent, RegExp[]> = {
  decision: [
    /\b(decide|decision[s]?|choose|choice|option[s]?|approach|architecture|design|pattern|strategy)\b/i,
    /\b(trade[- ]?off[s]?|tradeoff[s]?|compare|vs\.?|versus)\b/i,
    /\bshould\s+(we|i|the team|our team)\b/i,
  ],
  recall: [
    /\b(what (did|have) we (talk|talked|discuss|discussed) about|what was that (conversation|chat) about)\b/i,
    /\b(last time (we|i) (talked|discussed)|previous (conversation|chat|session)|earlier (conversation|chat|session)|prior (conversation|chat|session))\b/i,
    /\b(remind me|recap|recall|remember)\b.*\b(conversation|chat|session|discussion)\b/i,
  ],
  preference: [
    /\b(prefer|preference[s]?|like to|dislike|avoid|default|convention[s]?)\b/i,
    /\bshouldn'?t\b/i,
    /\bmust not\b/i,
  ],
  principle: [
    /\b(principle[s]?|guideline[s]?|policy|standard[s]?|best practice[s]?|rule[s]?|guardrail[s]?)\b/i,
  ],
  tradeoff: [
    /\b(trade[- ]?off[s]?|tradeoff[s]?|compare|vs\.?|versus)\b/i,
  ],
  implementation: [
    /\b(implement|build|add|refactor|optimi[sz]e|improve|migrate|rewrite)\b/i,
  ],
  debug: [
    /\b(bug|error|issue|fail|failure|crash|regress|broken|stack trace)\b/i,
  ],
  unknown: [],
};

const QUERY_PLAN_MAX_QUERIES = 8;
const QUERY_PLAN_MAX_HOTWORDS = 8;
const QUERY_PLAN_MAX_KEYWORDS = 8;
const QUERY_PLAN_MAX_PHRASES = 5;
const QUERY_PLAN_PHRASE_TOKEN_COUNT = 3;
const QUERY_PLAN_PHRASE_FALLBACK_TOKEN_COUNT = 2;
const QUERY_PLAN_MAX_TOPIC_TOKENS = 3;
const QUERY_PLAN_MAX_QUERY_CHARS = 80;
const QUERY_PLAN_MIN_QUERY_CHARS = 3;
const QUERY_PLAN_MAX_INTENT_QUERIES = 3;
const QUERY_PLAN_MAX_PRIMARY_TERMS = 5;
const QUERY_WEIGHT_PHRASE = 0.95;
const QUERY_WEIGHT_TOPIC = 0.9;
const QUERY_WEIGHT_HOTWORD = 0.75;
const QUERY_WEIGHT_KEYWORD = 0.65;
const QUERY_WEIGHT_FALLBACK = 0.6;
const QUERY_WEIGHT_INTENT = 0.5;

const DEFAULT_QUERY_STRATEGY: Required<MemoryQueryStrategy> = {
  enableIntentQueries: false,
  enableOverlapBoost: true,
  enableQualityFilters: true,
  maxQueries: 1,
  maxIntentQueries: 0,
};

const INTENT_QUERY_SEEDS: Record<QueryIntent, string[]> = {
  decision: ['decision', 'rationale', 'tradeoff', 'architecture', 'approach'],
  preference: ['preference', 'convention', 'default', 'avoid', 'style'],
  principle: ['principle', 'guideline', 'policy', 'standard', 'best practice'],
  tradeoff: ['tradeoff', 'comparison', 'pros cons', 'vs'],
  recall: ['recap', 'conversation', 'previous discussion', 'last time'],
  implementation: ['implementation', 'pattern', 'interface', 'workflow'],
  debug: ['bug', 'error', 'failure', 'incident'],
  unknown: [],
};

const DEFAULT_MEMORY_CONNECTORS = (() => {
  const env = process.env.MEMORY_INJECTOR_CONNECTORS;
  if (typeof env === 'string' && env.trim().length > 0) {
    return env.trim();
  }
  return 'claude_sessions,rex_sessions,watcher_sessions';
})();

const RECENCY_WINDOW_DAYS = 30;
const RECENCY_MAX_BONUS = 0.25;
const MAX_INJECTED_ITEMS = 3;

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

function resolveStrategy(input?: MemoryQueryStrategy): Required<MemoryQueryStrategy> {
  const merged = { ...DEFAULT_QUERY_STRATEGY, ...(input ?? {}) };
  const maxQueries = Number.isFinite(merged.maxQueries)
    ? Math.max(1, Math.floor(merged.maxQueries))
    : DEFAULT_QUERY_STRATEGY.maxQueries;
  const maxIntentQueries = Number.isFinite(merged.maxIntentQueries)
    ? Math.max(0, Math.floor(merged.maxIntentQueries))
    : DEFAULT_QUERY_STRATEGY.maxIntentQueries;
  return {
    enableIntentQueries: !!merged.enableIntentQueries,
    enableOverlapBoost: !!merged.enableOverlapBoost,
    enableQualityFilters: !!merged.enableQualityFilters,
    maxQueries,
    maxIntentQueries,
  };
}

export function detectQueryIntent(rawQuery: string): QueryIntent {
  if (!rawQuery || !rawQuery.trim()) return 'unknown';
  const lower = rawQuery.toLowerCase();
  const scores: Record<QueryIntent, number> = {
    decision: 0,
    preference: 0,
    principle: 0,
    tradeoff: 0,
    recall: 0,
    implementation: 0,
    debug: 0,
    unknown: 0,
  };

  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    const key = intent as QueryIntent;
    if (key === 'unknown') continue;
    for (const pattern of patterns) {
      if (pattern.test(lower)) {
        scores[key] += 1;
      }
    }
  }

  if (/\b(why|rationale|because|reason)\b/i.test(lower)) {
    scores.decision += 1;
  }
  if (/\b(prefer|preference|avoid|default)\b/i.test(lower)) {
    scores.preference += 1;
  }
  if (/\b(last time (we|i) (talked|discussed)|previous (conversation|chat|session)|earlier (conversation|chat|session)|prior (conversation|chat|session))\b/i.test(lower)) {
    scores.recall += 1;
  }

  const priority: QueryIntent[] = ['recall', 'tradeoff', 'decision', 'preference', 'principle', 'debug', 'implementation'];
  let best: QueryIntent = 'unknown';
  let bestScore = 0;

  for (const intent of priority) {
    const score = scores[intent] ?? 0;
    if (score > bestScore) {
      bestScore = score;
      best = intent;
    }
  }

  return bestScore > 0 ? best : 'unknown';
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

function hasLexemes(rawQuery: string): boolean {
  return extractOrderedTokens(rawQuery).length > 0;
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

function extractCodeTokens(rawQuery: string): Set<string> {
  const tokens = new Set<string>();

  const pathPattern = /(?:[a-z0-9._-]+[\\/])+[a-z0-9._-]+/gi;
  for (const match of rawQuery.matchAll(pathPattern)) {
    const rawPath = match[0];
    const base = path.basename(rawPath);
    const baseToken = normalizeToken(base);
    if (baseToken) tokens.add(baseToken);
    const stem = base.includes('.') ? base.split('.')[0] : base;
    const stemToken = normalizeToken(stem);
    if (stemToken) tokens.add(stemToken);
  }

  const identifierPattern = /[a-z_][a-z0-9_]{2,}/gi;
  for (const match of rawQuery.matchAll(identifierPattern)) {
    const raw = match[0];
    if (!/[A-Z_]/.test(raw)) continue;
    const token = normalizeToken(raw);
    if (token) tokens.add(token);
  }

  const dottedPattern = /[a-z_][a-z0-9_]*\.[a-z0-9_]+/gi;
  for (const match of rawQuery.matchAll(dottedPattern)) {
    const parts = match[0].split('.');
    for (const part of parts) {
      const token = normalizeToken(part);
      if (token) tokens.add(token);
    }
  }

  return tokens;
}

function extractKeywordsWithExclusions(rawQuery: string, exclude: Set<string>, dropConceptStopwords: boolean): string[] {
  const counts = new Map<string, { count: number; score: number }>();
  const wordPattern = /[a-z0-9]{2,}/gi;

  for (const match of rawQuery.matchAll(wordPattern)) {
    const token = normalizeToken(match[0]);
    if (!token) continue;
    if (exclude.has(token)) continue;
    if (dropConceptStopwords && CONCEPT_STOPWORDS.has(token)) continue;
    const existing = counts.get(token);
    const nextCount = (existing?.count ?? 0) + 1;
    const lengthBonus = token.length >= 10 ? 1.1 : token.length >= 7 ? 0.8 : token.length >= 5 ? 0.5 : 0.2;
    const score = nextCount + lengthBonus;
    counts.set(token, { count: nextCount, score });
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1].score - a[1].score || b[1].count - a[1].count || b[0].length - a[0].length)
    .map(([token]) => token);
}

function extractPrimaryTerms(rawQuery: string, intent: QueryIntent): string[] {
  const cleaned = collapseWhitespace(rawQuery);
  const codeTokens = extractCodeTokens(cleaned);
  const isConceptIntent = intent === 'decision'
    || intent === 'preference'
    || intent === 'principle'
    || intent === 'tradeoff';
  const tokens = extractKeywordsWithExclusions(cleaned, isConceptIntent ? codeTokens : new Set(), isConceptIntent);
  if (tokens.length === 0 && isConceptIntent) {
    return extractKeywordsWithExclusions(cleaned, new Set(), false);
  }
  return tokens;
}

function buildIntentQueries(
  intent: QueryIntent,
  topic: string | null,
  hotwords: string[],
  keywords: string[],
  strategy: Required<MemoryQueryStrategy>
): QuerySpec[] {
  if (!strategy.enableIntentQueries || strategy.maxIntentQueries <= 0) return [];
  const seeds = INTENT_QUERY_SEEDS[intent] ?? [];
  if (seeds.length === 0) return [];
  const anchor = topic ?? hotwords[0] ?? keywords[0] ?? null;
  const queries: QuerySpec[] = [];

  for (const seed of seeds) {
    const text = anchor ? `${seed} ${anchor}` : seed;
    const clamped = clampQuery(text);
    if (clamped.length < QUERY_PLAN_MIN_QUERY_CHARS) continue;
    queries.push({ text: clamped, weight: QUERY_WEIGHT_INTENT, kind: 'intent' });
    if (queries.length >= strategy.maxIntentQueries) break;
  }

  return queries;
}

function computeOverlapBoost(text: string, queryTokens: Set<string>): number {
  if (!queryTokens.size) return 0;
  const tokens = extractOrderedTokens(text);
  if (!tokens.length) return 0;
  const unique = new Set(tokens);
  let matches = 0;
  for (const token of queryTokens) {
    if (unique.has(token)) matches += 1;
  }
  const ratio = matches / Math.max(1, queryTokens.size);
  return Math.min(0.2, ratio * 0.18);
}

function computeQualityMultiplier(text: string): number {
  const trimmed = collapseWhitespace(text);
  if (!trimmed) return 0.5;
  const tokens = extractOrderedTokens(trimmed);
  const unique = tokens.length > 0 ? new Set(tokens).size : 0;
  const uniqueRatio = tokens.length > 0 ? unique / tokens.length : 0;
  let score = 1;
  if (trimmed.length < 30) score -= 0.15;
  if (tokens.length < 4) score -= 0.1;
  if (uniqueRatio > 0 && uniqueRatio < 0.45) score -= 0.15;
  if (/^(todo|tbd|n\/a|none|unknown)$/i.test(trimmed)) score -= 0.35;
  return Math.max(0.6, score);
}

function buildQueryPlan(rawQuery: string, strategy: Required<MemoryQueryStrategy>): QueryPlan {
  const cleaned = collapseWhitespace(rawQuery);
  const intent = detectQueryIntent(cleaned);
  const topic = extractTopic(cleaned);
  const hotwords = extractHotwords(cleaned);
  const keywords = extractKeywords(cleaned);
  const phrases = extractPhrases(cleaned);

  if (strategy.maxQueries <= 1) {
    const primaryTerms = extractPrimaryTerms(cleaned, intent);
    const maxTerms = isConceptIntent(intent) ? Math.min(4, QUERY_PLAN_MAX_PRIMARY_TERMS) : QUERY_PLAN_MAX_PRIMARY_TERMS;
    const limited = primaryTerms.slice(0, maxTerms);
    const primaryQuery = clampQuery(limited.join(' '));
    const fallbackQuery = clampQuery(cleaned);
    const shouldFallback = primaryQuery.length < QUERY_PLAN_MIN_QUERY_CHARS && hasLexemes(cleaned);
    const text = primaryQuery.length >= QUERY_PLAN_MIN_QUERY_CHARS
      ? primaryQuery
      : shouldFallback
        ? fallbackQuery
        : '';

    return {
      intent,
      topic,
      hotwords,
      keywords,
      phrases,
      queries: text.length >= QUERY_PLAN_MIN_QUERY_CHARS
        ? [{ text, weight: 1, kind: 'primary' }]
        : [],
    };
  }

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

  if (queries.length === 0 && cleaned.length >= QUERY_PLAN_MIN_QUERY_CHARS && hasLexemes(cleaned)) {
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

  if (strategy.enableIntentQueries) {
    const intentQueries = buildIntentQueries(intent, topic, hotwords, keywords, strategy);
    for (const query of intentQueries) {
      if (deduped.size >= strategy.maxQueries) break;
      const key = query.text.toLowerCase();
      if (!deduped.has(key)) deduped.set(key, query);
    }
  }

  return {
    intent,
    topic,
    hotwords,
    keywords,
    phrases,
    queries: Array.from(deduped.values()).slice(0, strategy.maxQueries),
  };
}

function summarizeQueryPlan(plan: QueryPlan): string {
  if (!plan.queries.length) return '';
  const summary = plan.queries.map((query) => query.text).join(' | ');
  return plan.intent !== 'unknown' ? `[${plan.intent}] ${summary}` : summary;
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

function isConceptIntent(intent: QueryIntent): boolean {
  return intent === 'decision'
    || intent === 'preference'
    || intent === 'principle'
    || intent === 'tradeoff';
}

function sourceBias(intent: QueryIntent, source: ScoredItem['source']): number {
  if (intent === 'preference' || intent === 'principle') {
    if (source === 'preference') return 1.25;
    if (source === 'decision') return 0.9;
    return 0.6;
  }
  if (intent === 'decision' || intent === 'tradeoff') {
    if (source === 'decision') return 1.25;
    if (source === 'preference') return 0.9;
    return 0.6;
  }
  if (intent === 'recall') {
    if (source === 'memory') return 1.15;
    return 0.85;
  }
  if (intent === 'debug') {
    if (source === 'memory') return 1.1;
    return 0.95;
  }
  return 1;
}

function confidenceBoost(confidence?: string): number {
  if (confidence === 'high') return 0.18;
  if (confidence === 'medium') return 0.08;
  if (confidence === 'low') return -0.05;
  return 0;
}

function signalStrengthBoost(signalStrength?: string): number {
  if (signalStrength === 'explicit') return 0.08;
  if (signalStrength === 'implicit') return 0;
  return 0;
}

function evidenceBoost(count?: number): number {
  if (typeof count !== 'number' || !Number.isFinite(count)) return 0;
  if (count >= 4) return 0.12;
  if (count >= 2) return 0.07;
  if (count === 1) return 0.02;
  return 0;
}

function nonEmptyBoost(value?: string, bonus = 0.05): number {
  if (!value) return 0;
  return value.trim().length > 0 ? bonus : 0;
}

function clampText(value: string, max = 160): string {
  const trimmed = collapseWhitespace(value);
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trim()}…`;
}

function formatDateSuffix(value?: string): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  return ` (${new Date(parsed).toISOString().slice(0, 10)})`;
}

// Estimate token count roughly (used for trimming injected content)
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
  const strategy = resolveStrategy(config.strategy);

  return {
    summarizeQueryPlan(rawQuery: string): string {
      if (!rawQuery || !rawQuery.trim()) return '';
      const plan = buildQueryPlan(rawQuery, strategy);
      const summary = summarizeQueryPlan(plan);
      return summary || rawQuery;
    },
    explainQueryPlan(rawQuery: string): QueryPlanSummary {
      const plan = buildQueryPlan(rawQuery, strategy);
      return {
        intent: plan.intent,
        topic: plan.topic,
        hotwords: plan.hotwords,
        keywords: plan.keywords,
        phrases: plan.phrases,
        queries: plan.queries.map((query) => ({
          text: query.text,
          weight: query.weight,
          kind: query.kind,
        })),
      };
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

      const queryPlan = buildQueryPlan(query, strategy);
      if (queryPlan.queries.length === 0) {
        return null;
      }
      const intent = queryPlan.intent;
      const preferStructured = isConceptIntent(intent);
      const shouldSearchMemory = intent === 'recall';
      const shouldSearchStructured = intent !== 'recall';
      const queryTokenSet = strategy.enableOverlapBoost
        ? new Set(extractOrderedTokens(query))
        : null;
      const adjustScore = (baseScore: number, content: string): number => {
        let score = baseScore;
        if (strategy.enableOverlapBoost && queryTokenSet) {
          score += computeOverlapBoost(content, queryTokenSet);
        }
        if (strategy.enableQualityFilters) {
          score *= computeQualityMultiplier(content);
        }
        return score;
      };

      const queryCount = queryPlan.queries.length;
      const preferenceLimit = queryCount === 1 ? 20 : 10;
      const decisionLimit = queryCount === 1 ? 20 : 10;
      const memoryLimit = queryCount === 1 ? 10 : 6;

      const memorySearches = shouldSearchMemory
        ? queryPlan.queries.map(async (spec) => {
          if (!client.memory?.search) {
            return {
              spec,
              items: [] as Array<{
                conversation_id: string;
                summary: string;
                topic?: string;
                source_timestamp?: string;
                updated_at: string;
              }>,
            };
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
            return {
              spec,
              items: [] as Array<{
                conversation_id: string;
                summary: string;
                topic?: string;
                source_timestamp?: string;
                updated_at: string;
              }>,
            };
          }
        })
        : [];

      const preferenceSearches = shouldSearchStructured
        ? queryPlan.queries.map(async (spec) => {
          try {
            const res = await client.preferences.search({
              q: spec.text,
              limit: preferenceLimit,
              mode: preferStructured ? 'trgm' : undefined,
              minSimilarity: preferStructured ? 0.18 : undefined,
            });
            return { spec, preferences: res?.preferences ?? [] };
          } catch (err) {
            console.error('[MemoryInjector] Preferences search failed:', err);
            return { spec, preferences: [] };
          }
        })
        : [];

      const decisionSearches = shouldSearchStructured
        ? queryPlan.queries.map(async (spec) => {
          try {
            const res = await client.decisions.search({
              q: spec.text,
              limit: decisionLimit,
              mode: preferStructured ? 'trgm' : undefined,
              minSimilarity: preferStructured ? 0.18 : undefined,
            });
            return { spec, decisions: res?.decisions ?? [] };
          } catch (err) {
            console.error('[MemoryInjector] Decisions search failed:', err);
            return { spec, decisions: [] };
          }
        })
        : [];

      const [memoryResults, preferenceResults, decisionResults] = await Promise.all([
        Promise.all(memorySearches),
        Promise.all(preferenceSearches),
        Promise.all(decisionSearches),
      ]);

      const sourceCaps = (() => {
        if (intent === 'preference' || intent === 'principle') {
          return { memory: 2, preference: 8, decision: 4 } as const;
        }
        if (intent === 'decision' || intent === 'tradeoff') {
          return { memory: 2, preference: 4, decision: 8 } as const;
        }
        if (intent === 'recall') {
          return { memory: 10, preference: 0, decision: 0 } as const;
        }
        if (intent === 'debug') {
          return { memory: 8, preference: 4, decision: 4 } as const;
        }
        return { memory: 6, preference: 6, decision: 6 } as const;
      })();

      const formatPreferenceDisplay = (pref: {
        preference?: string;
        entity_free_formulation?: string;
        scope?: string;
        failure_mode_prevented?: string;
        confidence?: string;
        signal_strength?: string;
        evidence_count?: number;
        source_timestamp?: string;
        created_at?: string;
      }): string => {
        const core = clampText(pref.entity_free_formulation?.trim() || pref.preference?.trim() || '', 180);
        const meta: string[] = [];
        if (pref.confidence) meta.push(`conf:${pref.confidence}`);
        if (pref.signal_strength) meta.push(`signal:${pref.signal_strength}`);
        if (Number.isFinite(pref.evidence_count)) meta.push(`evidence:${pref.evidence_count}`);
        const metaStr = meta.length ? ` (${meta.join(', ')})` : '';
        const details: string[] = [];
        if (pref.scope?.trim()) details.push(`Scope: ${clampText(pref.scope, 80)}`);
        if (pref.failure_mode_prevented?.trim()) {
          details.push(`Prevents: ${clampText(pref.failure_mode_prevented, 80)}`);
        }
        const detailStr = details.length ? ` — ${details.join(' ')}` : '';
        const timestamp = pref.source_timestamp ?? pref.created_at;
        return `**[Preference]** ${core}${metaStr}${detailStr}${formatDateSuffix(timestamp)}`;
      };

      const formatDecisionDisplay = (decision: {
        decision?: string;
        rationale?: string;
        tradeoffs?: string;
        alternatives_considered?: string;
        confidence?: string;
        signal_strength?: string;
        reversibility?: string;
        source_timestamp?: string;
        created_at?: string;
      }): string => {
        const decisionText = clampText(decision.decision?.trim() || '', 180);
        const details: string[] = [];
        if (decision.rationale?.trim()) {
          details.push(`Rationale: ${clampText(decision.rationale, 140)}`);
        }
        if (decision.tradeoffs?.trim()) {
          details.push(`Tradeoffs: ${clampText(decision.tradeoffs, 140)}`);
        }
        if (decision.alternatives_considered?.trim()) {
          details.push(`Alternatives: ${clampText(decision.alternatives_considered, 120)}`);
        }
        const meta: string[] = [];
        if (decision.confidence) meta.push(`conf:${decision.confidence}`);
        if (decision.signal_strength) meta.push(`signal:${decision.signal_strength}`);
        if (decision.reversibility) meta.push(`reversible:${decision.reversibility}`);
        const metaStr = meta.length ? ` (${meta.join(', ')})` : '';
        const detailStr = details.length ? ` — ${details.join(' ')}` : '';
        const timestamp = decision.source_timestamp ?? decision.created_at;
        return `**[Decision]** ${decisionText}${metaStr}${detailStr}${formatDateSuffix(timestamp)}`;
      };

      const memoryScoredRaw: ScoredItem[] = [];
      for (const { spec, items } of memoryResults) {
        items.forEach((item, index) => {
          if (!item?.summary) return;
          const timestamp = item.source_timestamp ?? item.updated_at;
          const baseScore = spec.weight + recencyBonus(timestamp) - index * 0.015;
          const score = adjustScore(baseScore, item.summary) * sourceBias(intent, 'memory');
          const details: string[] = [];
          if (item.topic?.trim()) details.push(`Topic: ${clampText(item.topic, 80)}`);
          if (item.conversation_id?.trim()) details.push(`Id: ${item.conversation_id}`);
          const detailStr = details.length ? ` — ${details.join(' ')}` : '';
          const contentKey = item.conversation_id ? `${item.conversation_id}:${item.summary}` : item.summary;
          memoryScoredRaw.push({
            content: contentKey,
            display: `**[Memory]** ${item.summary}${detailStr}${formatDateSuffix(timestamp)}`,
            score,
            source: 'memory',
          });
        });
      }

      const prefScoredRaw: ScoredItem[] = [];
      for (const { spec, preferences } of preferenceResults) {
        for (const pref of preferences ?? []) {
          if (!pref?.preference) continue;
          if (pref.kind === 'ignore') continue;
          // Prefer source_timestamp (when conversation happened) over created_at (when extracted)
          const prefWithTs = pref as { source_timestamp?: string; created_at?: string };
          const timestamp = prefWithTs.source_timestamp ?? prefWithTs.created_at;
          const baseRank = safeScore(pref.rank ?? (pref as { similarity?: number }).similarity);
          const baseScore = baseRank * spec.weight + recencyBonus(timestamp);
          const signalBoost = confidenceBoost(pref.confidence)
            + signalStrengthBoost(pref.signal_strength)
            + evidenceBoost(pref.evidence_count)
            + nonEmptyBoost(pref.failure_mode_prevented, 0.04);
          const kindBoost = pref.kind === 'principle_candidate' ? 0.18 : pref.kind === 'local_convention' ? -0.02 : -0.15;
          const score = adjustScore(baseScore + signalBoost + kindBoost, pref.entity_free_formulation || pref.preference)
            * sourceBias(intent, 'preference');
          const display = formatPreferenceDisplay(pref);
          const contentKey = pref.entity_free_formulation?.trim() || pref.preference.trim();
          prefScoredRaw.push({
            content: contentKey,
            display,
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
          // Prefer source_timestamp (when conversation happened) over created_at (when extracted)
          const decWithTs = decision as { source_timestamp?: string; created_at?: string };
          const timestamp = decWithTs.source_timestamp ?? decWithTs.created_at;
          const baseScore = safeScore(rawScore) * spec.weight + recencyBonus(timestamp);
          const signalBoost = confidenceBoost(decision.confidence)
            + signalStrengthBoost(decision.signal_strength)
            + nonEmptyBoost(decision.rationale, 0.05)
            + nonEmptyBoost(decision.tradeoffs, 0.05)
            + nonEmptyBoost(decision.alternatives_considered, 0.04);
          const reversibilityBoost = decision.reversibility === 'hard' ? 0.05
            : decision.reversibility === 'moderate' ? 0.02
              : 0;
          const score = adjustScore(baseScore + signalBoost + reversibilityBoost, decision.decision)
            * sourceBias(intent, 'decision');
          const display = formatDecisionDisplay(decision);
          decisionScoredRaw.push({
            content: decision.decision,
            display,
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

      const renderItem = (item: ScoredItem): string => {
        if (item.display) return item.display;
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
        if (result.length >= MAX_INJECTED_ITEMS) {
          break;
        }
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

      const header = preferStructured && intent !== 'debug'
        ? '## Relevant Decisions & Preferences'
        : '## Relevant Memory';
      return `${header}\n\n${result.join('\n\n')}`;
    },

    async injectRecentConversations(params: InjectRecentParams): Promise<string | null> {
      const tokenBudget = Number.isFinite(params.maxTokens) && params.maxTokens > 0 ? params.maxTokens : 0;
      if (tokenBudget <= 0) return null;

      if (!client.memory?.recent) {
        return null;
      }

      const limit = Number.isFinite(params.limit) && (params.limit as number) > 0
        ? Math.min(50, Math.floor(params.limit as number))
        : 10;

      try {
        const res = await client.memory.recent({
          limit,
          connectors: params.connectors ?? DEFAULT_MEMORY_CONNECTORS,
        });

        const items = res?.items ?? [];
        if (items.length === 0) return null;

        const formatRecent = (item: {
          conversation_id: string;
          summary: string;
          topic?: string;
          source_timestamp?: string;
          updated_at: string;
        }): string => {
          const summary = clampText(item.summary?.trim() || '', 220);
          if (!summary) return '';
          const details: string[] = [];
          if (item.topic?.trim()) {
            details.push(`Topic: ${clampText(item.topic, 80)}`);
          }
          if (item.conversation_id?.trim()) {
            details.push(`Id: ${item.conversation_id}`);
          }
          const detailStr = details.length ? ` — ${details.join(' ')}` : '';
          const timestamp = item.source_timestamp ?? item.updated_at;
          return `**[Conversation]** ${summary}${detailStr}${formatDateSuffix(timestamp)}`;
        };

        const result: string[] = [];
        let tokens = 0;

        for (const item of items) {
          if (result.length >= MAX_INJECTED_ITEMS) {
            break;
          }
          const rendered = formatRecent(item);
          if (!rendered) continue;
          const itemTokens = estimateTokens(rendered);
          if (itemTokens > tokenBudget) continue;
          if (tokens + itemTokens > tokenBudget) continue;
          result.push(rendered);
          tokens += itemTokens;
        }

        if (result.length === 0) return null;

        return `## Recent Conversations\n\n*Use ExpandConversation with the Id to retrieve the full transcript if needed.*\n\n${result.join('\n\n')}`;
      } catch (err) {
        console.error('[MemoryInjector] Recent conversation fetch failed:', err);
        return null;
      }
    },

    async injectV2(params: InjectParamsV2): Promise<InjectResultV2 | null> {
      const debugParams = params as InjectParamsV2 & {
        query?: string;
        maxTokens?: number;
        connectors?: unknown;
        filters?: unknown;
      };
      const task = debugParams.task;

      // Log request payload
      console.log('[MemoryInjector] V2 Request:', {
        taskObjective: task?.objective ?? null,
        touchedFiles: task?.touchedFiles?.length ?? 0,
        touchedFileNames: task?.touchedFiles?.slice(0, 5) ?? [],
        sessionId: task?.sessionId ?? null,
        runId: task?.runId ?? null,
        workItemId: task?.workItemId ?? null,
        iteration: task?.iteration ?? null,
        query: debugParams.query ?? null,
        maxTokens: debugParams.maxTokens ?? null,
        connectors: debugParams.connectors ?? null,
        hasFilters: debugParams.filters !== undefined,
        options: debugParams.options,
      });

      if (debugParams.options?.forceV1Fallback) {
        console.log('[MemoryInjector] V2 returning null: forceV1Fallback=true');
        return null;
      }

      try {
        const response = await client.evidence.retrieve(params);

        if (!response?.content) {
          console.log('[MemoryInjector] V2 returning null: response or content empty', {
            hasResponse: !!response,
            hasContent: !!response?.content,
            responseKeys: response ? Object.keys(response) : [],
          });
          return null;
        }

        // Log successful response details
        console.log('[MemoryInjector] V2 Success:', {
          contentLength: response.content.length,
          atomCount: response.atoms?.length ?? 0,
          metrics: response.metrics,
          retrievalId: response.trainingSignal?.retrieval_id ?? null,
          candidateCount: response.trainingSignal?.candidate_list?.length ?? 0,
          selectedCount: response.trainingSignal?.selected_set?.length ?? 0,
        });

        return response;
      } catch (err) {
        const errorDetails = {
          message: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : 'Unknown',
          stack: err instanceof Error ? err.stack : undefined,
        };
        console.error('[MemoryInjector] V2 returning null: error caught', errorDetails);
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
        cs.status === 'partial' ? '⚠' : '○';
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
