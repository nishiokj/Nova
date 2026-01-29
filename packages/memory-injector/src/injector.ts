/**
 * Memory Injector Implementation
 *
 * Stateless retrieval layer that queries coding_preferences and coding_decisions
 * via the agent-memory daemon and returns combined, sorted results.
 */

import { SyncClient } from 'agent-memory';
import type { MemoryInjector, InjectParams, MemoryInjectorConfig } from './types.js';

interface ScoredItem {
  content: string;
  score: number;
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
    async inject({ query, maxTokens }: InjectParams): Promise<string | null> {
      // Validate query - return null early if empty or whitespace-only
      if (!query || !query.trim()) {
        return null;
      }

      // Search both tables in parallel with error logging
      const [prefsResult, decisionsResult] = await Promise.all([
        client.preferences
          .search({ q: query, limit: 10 })
          .catch((err) => {
            console.error('[MemoryInjector] Preferences search failed:', err);
            return { preferences: [] };
          }),
        client.decisions
          .search({ q: query, limit: 10 })
          .catch((err) => {
            console.error('[MemoryInjector] Decisions search failed:', err);
            return { decisions: [] };
          }),
      ]);

      // Handle null/undefined responses safely
      const prefs = prefsResult?.preferences ?? [];
      const decisions = decisionsResult?.decisions ?? [];

      // Combine and filter out null/undefined/empty content, then sort by score
      const items: ScoredItem[] = [
        ...prefs
          .map((p) => ({
            content: p.preference,
            score: p.rank ?? 0,
          }))
          .filter((item) => item.content && item.content.trim().length > 0),
        ...decisions
          .map((d) => ({
            content: d.decision,
            score: d.rank ?? d.similarity ?? 0,
          }))
          .filter((item) => item.content && item.content.trim().length > 0),
      ].sort((a, b) => b.score - a.score);

      if (items.length === 0) {
        return null;
      }

      // Deduplicate by content (BUG #13)
      const seen = new Set<string>();
      const dedupedItems: ScoredItem[] = [];
      for (const item of items) {
        if (!seen.has(item.content)) {
          seen.add(item.content);
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

      // Build output, respecting token limit (BUG #6: continue instead of break for large items)
      const result: string[] = [];
      let tokens = 0;

      for (const item of dedupedItems) {
        const itemTokens = estimateTokens(item.content);
        // Skip items that individually exceed maxTokens, but continue checking others
        if (itemTokens > maxTokens) {
          continue;
        }
        if (tokens + itemTokens > maxTokens) {
          break;
        }
        result.push(item.content);
        tokens += itemTokens;
      }

      if (result.length === 0) {
        return null;
      }

      // Format with a header
      return `## Relevant Memory\n\n${result.join('\n\n')}`;
    },
  };
}
