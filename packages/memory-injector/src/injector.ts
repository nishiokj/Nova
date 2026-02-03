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

      // Search conversational memory + preferences/decisions in parallel with error logging
      const [memoryResult, prefsResult, decisionsResult] = await Promise.all([
        client.memory
          .search({ q: query, limit: 8, connectors: 'claude_sessions,rex_sessions' })
          .catch((err) => {
            console.error('[MemoryInjector] Conversational memory search failed:', err);
            return { items: [] } as { items: { summary: string; source_timestamp?: string; updated_at: string }[] };
          }),
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
      const memoryItems = memoryResult?.items ?? [];
      const prefs = prefsResult?.preferences ?? [];
      const decisions = decisionsResult?.decisions ?? [];

      // Combine and filter out null/undefined/empty content, then sort by score
      const items: ScoredItem[] = [
        ...memoryItems
          .map((m, index) => {
            const when = m.source_timestamp ?? m.updated_at;
            const suffix = when ? ` (${new Date(when).toISOString().slice(0, 10)})` : '';
            return {
              content: `${m.summary}${suffix}`,
              score: 1 - index * 0.01,
            };
          })
          .filter((item) => item.content && item.content.trim().length > 0),
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

function formatValidSemanticForInjection(semantic: ValidSemanticData): string {
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
