/**
 * Append-only knowledge store for accumulated facts.
 * Facts can be added or superseded but never deleted.
 *
 * Ported from: src/harness/agent/wizard/knowledge_store.py
 */

/**
 * Where a fact came from.
 */
export enum FactSource {
  TOOL = 'tool',
  INFERENCE = 'inference',
  USER = 'user',
  COMPACTION = 'compaction',
  GRAPHDB = 'graphdb',
}

/**
 * A single accumulated fact.
 */
export interface KnowledgeFact {
  /** Canonicalized key (e.g., "file:/path:exists") */
  key: string;
  /** Fact value */
  value: unknown;
  /** Confidence 0.0 to 1.0 */
  confidence: number;
  /** Source of the fact */
  source: FactSource;
  /** Timestamp when fact was created */
  timestamp: number;
  /** Work entry ID this was derived from */
  derivedFromEntry?: string;
  /** Tool that produced this fact */
  toolName?: string;
  /** TTL in seconds (undefined = no expiry) */
  ttlSeconds?: number;
  /** Pinned facts survive compaction */
  isPinned: boolean;
}

/**
 * Create a knowledge fact.
 */
export function createKnowledgeFact(params: {
  key: string;
  value: unknown;
  confidence: number;
  source: FactSource;
  derivedFromEntry?: string;
  toolName?: string;
  ttlSeconds?: number;
  isPinned?: boolean;
}): KnowledgeFact {
  return {
    key: params.key,
    value: params.value,
    confidence: params.confidence,
    source: params.source,
    timestamp: Date.now(),
    derivedFromEntry: params.derivedFromEntry,
    toolName: params.toolName,
    ttlSeconds: params.ttlSeconds,
    isPinned: params.isPinned ?? false,
  };
}

/**
 * Append-only knowledge base owned by Wizard.
 *
 * Facts are keyed by canonicalized strings.
 * New facts supersede old facts with same key.
 */
export class KnowledgeStore {
  private facts = new Map<string, KnowledgeFact>();
  private history: KnowledgeFact[] = [];
  private maxFacts: number;
  private maxCompactionFacts: number;

  constructor(maxFacts = 500, maxCompactionFacts = 5) {
    this.maxFacts = maxFacts;
    this.maxCompactionFacts = maxCompactionFacts;
  }

  /**
   * Insert or update a fact.
   * If key exists, new fact supersedes (but old is kept in history).
   */
  upsert(fact: KnowledgeFact): void {
    this.history.push(fact);
    this.facts.set(fact.key, fact);

    if (this.facts.size > this.maxFacts) {
      this.evictOldest();
    }
  }

  /**
   * Get fact by key, checking TTL.
   */
  get(key: string): KnowledgeFact | undefined {
    const fact = this.facts.get(key);
    if (!fact) return undefined;

    if (fact.ttlSeconds !== undefined) {
      const age = (Date.now() - fact.timestamp) / 1000;
      if (age > fact.ttlSeconds) {
        return undefined;
      }
    }

    return fact;
  }

  /**
   * Query facts by key prefix (e.g., 'file:').
   */
  queryByPrefix(prefix: string): KnowledgeFact[] {
    const results: KnowledgeFact[] = [];
    for (const [key, fact] of this.facts) {
      if (key.startsWith(prefix)) {
        results.push(fact);
      }
    }
    return results;
  }

  /**
   * Get all current facts, optionally limited.
   * Filters out expired TTL facts without deleting them.
   */
  getAllFacts(limit?: number): KnowledgeFact[] {
    const now = Date.now();
    const validFacts: KnowledgeFact[] = [];

    // Sort by timestamp descending (most recent first)
    const sortedFacts = Array.from(this.facts.values()).sort(
      (a, b) => b.timestamp - a.timestamp
    );

    for (const fact of sortedFacts) {
      // Skip expired facts
      if (fact.ttlSeconds !== undefined) {
        const age = (now - fact.timestamp) / 1000;
        if (age > fact.ttlSeconds) continue;
      }

      validFacts.push(fact);

      if (limit !== undefined && validFacts.length >= limit) {
        break;
      }
    }

    return validFacts;
  }

  /**
   * Get the most recent non-expired facts.
   */
  getRecentFacts(limit = 20): KnowledgeFact[] {
    return this.getAllFacts(limit);
  }

  /**
   * Remove all expired facts.
   */
  evictExpired(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [key, fact] of this.facts) {
      if (fact.ttlSeconds !== undefined) {
        const age = (now - fact.timestamp) / 1000;
        if (age > fact.ttlSeconds) {
          toRemove.push(key);
        }
      }
    }

    for (const key of toRemove) {
      this.facts.delete(key);
    }
  }

  /**
   * Compact store to fit within token budget.
   * Returns summary of compacted facts.
   */
  compact(_budgetTokens: number): string {
    // First, consolidate old compaction facts
    this.consolidateCompactionFacts();

    const summaries: string[] = [];
    const toRemove: string[] = [];

    for (const [key, fact] of this.facts) {
      if (!fact.isPinned) {
        const valueStr = String(fact.value).slice(0, 50);
        summaries.push(`${key}: ${valueStr}`);
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      this.facts.delete(key);
    }

    if (summaries.length > 0) {
      const summaryText = 'Compacted facts: ' + summaries.slice(0, 10).join('; ');
      const compactionFact = createKnowledgeFact({
        key: `compaction:${Date.now()}`,
        value: summaryText,
        confidence: 0.8,
        source: FactSource.COMPACTION,
        isPinned: true,
      });
      this.upsert(compactionFact);
      return summaryText;
    }

    return '';
  }

  /**
   * Consolidate old compaction facts to prevent unbounded growth.
   */
  private consolidateCompactionFacts(): void {
    const compactionKeys: Array<{ timestamp: number; key: string }> = [];

    for (const [key, fact] of this.facts) {
      if (key.startsWith('compaction:') && fact.source === FactSource.COMPACTION) {
        const parts = key.split(':');
        const ts = parseInt(parts[1], 10) || 0;
        compactionKeys.push({ timestamp: ts, key });
      }
    }

    if (compactionKeys.length <= this.maxCompactionFacts) {
      return;
    }

    // Sort by timestamp (oldest first)
    compactionKeys.sort((a, b) => a.timestamp - b.timestamp);

    // Remove oldest, keeping only maxCompactionFacts
    const toRemove = compactionKeys.slice(0, -this.maxCompactionFacts);
    const oldSummaries: string[] = [];

    for (const { key } of toRemove) {
      const fact = this.facts.get(key);
      if (fact) {
        oldSummaries.push(String(fact.value).slice(0, 100));
        this.facts.delete(key);
      }
    }

    // Create consolidated summary
    if (oldSummaries.length > 0) {
      const consolidated = createKnowledgeFact({
        key: `compaction_consolidated:${Date.now()}`,
        value: `Consolidated ${oldSummaries.length} old compactions`,
        confidence: 0.7,
        source: FactSource.COMPACTION,
        isPinned: true,
      });
      this.facts.set(consolidated.key, consolidated);
      this.history.push(consolidated);
    }
  }

  /**
   * Evict oldest non-pinned fact.
   */
  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;

    for (const [key, fact] of this.facts) {
      if (!fact.isPinned && fact.timestamp < oldestTime) {
        oldestTime = fact.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.facts.delete(oldestKey);
    }
  }

  /**
   * Get current fact count.
   */
  get factCount(): number {
    return this.facts.size;
  }
}
