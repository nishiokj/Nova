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
 */
export interface ContextWindowMetrics {
  /** Peak prompt tokens (actual context window usage) */
  contextTokens: number;
  /** Cumulative completion tokens */
  outputTokens: number;
  /** Maximum context window size (default 200000) */
  maxTokens: number;
  /** contextTokens / maxTokens */
  percentageUsed: number;
  /** Number of messages in context */
  messageCount: number;
  /** Legacy: contextTokens + outputTokens */
  totalTokens: number;
}

/**
 * Create default context window metrics.
 */
export function createContextWindowMetrics(
  maxTokens = 200000
): ContextWindowMetrics {
  return {
    contextTokens: 0,
    outputTokens: 0,
    maxTokens,
    percentageUsed: 0,
    messageCount: 0,
    totalTokens: 0,
  };
}

/**
 * Update context window metrics after an LLM call.
 */
export function updateContextMetrics(
  metrics: ContextWindowMetrics,
  promptTokens: number,
  completionTokens: number,
  messageCount: number
): ContextWindowMetrics {
  const contextTokens = Math.max(metrics.contextTokens, promptTokens);
  const outputTokens = metrics.outputTokens + completionTokens;
  return {
    contextTokens,
    outputTokens,
    maxTokens: metrics.maxTokens,
    percentageUsed: contextTokens / metrics.maxTokens,
    messageCount,
    totalTokens: contextTokens + outputTokens,
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
