/**
 * Session and context window types.
 *
 * Types for managing session state and context window metrics.
 */

import type { Message } from './llm.js';

// ============================================
// SESSION STATUS
// ============================================

/**
 * Session status.
 */
export type SessionStatus = 'active' | 'expired' | 'closed';

/**
 * Client type for session.
 */
export type ClientType = 'tui' | 'voice' | 'api';

// ============================================
// SESSION
// ============================================

/**
 * Session data stored in GraphD.
 */
export interface Session {
  sessionKey: string;
  clientType: ClientType;
  createdAt: number; // Unix timestamp in seconds
  lastAccessedAt: number;
  expiresAt?: number;
  workingDir?: string;
  status: SessionStatus;
  metadata?: Record<string, unknown>;
}

// Note: generateSessionKey is in graphd/utils.ts to avoid duplication

// ============================================
// CONTEXT WINDOW
// ============================================

/**
 * Context window metrics.
 *
 * Tracks actual token usage from API responses (source of truth).
 * - inputTokens: Current context size (from last API call)
 * - peakInputTokens: High-water mark for context size
 * - outputTokens: Completion tokens from last request
 * - totalOutputTokens: Cumulative completion tokens across all requests
 */
export interface ContextWindowMetrics {
  /** Current context size - tokens in window (from last API response) */
  inputTokens: number;
  /** Peak context size - highest inputTokens seen */
  peakInputTokens: number;
  /** Completion tokens from last request */
  outputTokens: number;
  /** Cumulative completion tokens across all requests */
  totalOutputTokens: number;
  /** Maximum context window size (default 200000) */
  maxTokens: number;
  /** inputTokens / maxTokens - current window usage */
  percentageUsed: number;
  /** Number of messages in context */
  messageCount: number;
  /** Cached tokens from prompt (if provider supports prompt caching) */
  cachedTokens?: number;
  /** Cumulative cached tokens across all requests */
  totalCachedTokens?: number;
}

/**
 * Create default context window metrics.
 */
export function createContextWindowMetrics(
  maxTokens = 200000
): ContextWindowMetrics {
  return {
    inputTokens: 0,
    peakInputTokens: 0,
    outputTokens: 0,
    totalOutputTokens: 0,
    maxTokens,
    percentageUsed: 0,
    messageCount: 0,
  };
}

/**
 * Update context window metrics after an LLM call.
 *
 * Sets inputTokens to current value (not max) for accurate post-compaction tracking.
 * Tracks peak separately in peakInputTokens.
 */
export function updateContextMetrics(
  metrics: ContextWindowMetrics,
  promptTokens: number,
  completionTokens: number,
  messageCount: number,
  cachedTokens?: number
): ContextWindowMetrics {
  return {
    inputTokens: promptTokens,
    peakInputTokens: Math.max(metrics.peakInputTokens, promptTokens),
    outputTokens: completionTokens,
    totalOutputTokens: metrics.totalOutputTokens + completionTokens,
    maxTokens: metrics.maxTokens,
    percentageUsed: promptTokens / metrics.maxTokens,
    messageCount,
    cachedTokens,
    totalCachedTokens: (metrics.totalCachedTokens ?? 0) + (cachedTokens ?? 0),
  };
}

// ============================================
// SESSION CONTEXT
// ============================================

/**
 * Full session context including messages and metrics.
 */
export interface SessionContext {
  session: Session;
  messages: Message[];
  contextMetrics: ContextWindowMetrics;
}

/**
 * Create a new session context.
 */
export function createSessionContext(
  sessionKey: string,
  clientType: ClientType = 'tui',
  workingDir?: string
): SessionContext {
  const now = Date.now() / 1000;
  return {
    session: {
      sessionKey,
      clientType,
      createdAt: now,
      lastAccessedAt: now,
      workingDir,
      status: 'active',
    },
    messages: [],
    contextMetrics: createContextWindowMetrics(),
  };
}

// ============================================
// CONVERSATION MESSAGE (persisted)
// ============================================

/**
 * Conversation message as stored in GraphD.
 */
export interface ConversationMessage {
  id: number;
  sessionKey: string;
  messageIndex: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  requestId?: string;
  createdAt: number; // Unix timestamp
  metadata?: Record<string, unknown>;
}

// ============================================
// CONTEXT SNAPSHOT (persisted)
// ============================================

/**
 * Context snapshot as stored in GraphD.
 */
export interface ContextSnapshot {
  id: number;
  sessionKey: string;
  snapshotVersion: number;
  createdAt: number; // Unix timestamp
  context: Record<string, unknown>;
}

// ============================================
// KNOWLEDGE STORE
// ============================================

/**
 * Entry in the knowledge store.
 */
export interface KnowledgeEntry {
  key: string;
  value: unknown;
  source: 'tool' | 'llm' | 'user';
  confidence: number;
  timestamp: number;
  expiresAt?: number;
}

/**
 * Knowledge store for accumulated session knowledge.
 */
export interface KnowledgeStore {
  entries: Map<string, KnowledgeEntry>;
}

/**
 * Create an empty knowledge store.
 */
export function createKnowledgeStore(): KnowledgeStore {
  return { entries: new Map() };
}

/**
 * Add an entry to the knowledge store.
 */
export function addKnowledge(
  store: KnowledgeStore,
  key: string,
  value: unknown,
  source: KnowledgeEntry['source'],
  confidence = 1.0
): void {
  store.entries.set(key, {
    key,
    value,
    source,
    confidence,
    timestamp: Date.now() / 1000,
  });
}

/**
 * Get an entry from the knowledge store.
 */
export function getKnowledge(
  store: KnowledgeStore,
  key: string
): KnowledgeEntry | undefined {
  return store.entries.get(key);
}

/**
 * Clear expired entries from the knowledge store.
 */
export function clearExpiredKnowledge(store: KnowledgeStore): void {
  const now = Date.now() / 1000;
  for (const [key, entry] of store.entries) {
    if (entry.expiresAt && entry.expiresAt < now) {
      store.entries.delete(key);
    }
  }
}
