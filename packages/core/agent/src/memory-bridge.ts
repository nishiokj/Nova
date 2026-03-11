/**
 * Memory Bridge - Encapsulates memory injection for agent iterations.
 *
 * Handles recent conversation injection, evidence retrieval,
 * caching, and observability events.
 */

import path from 'node:path';
import { Effect } from 'effect';
import type { ContextWindow } from 'context';
import { createEvent } from 'types';
import type { WorkItem, MessageItem } from 'types';
import type { EventEmitCallback, InternalHookQueue, InternalHookContext } from './types.js';

// ── Interface ────────────────────────────────────────────────────────

export interface MemoryInjector {
  injectRecentConversations?: (params: { limit?: number; maxTokens: number; connectors?: string }) => Promise<string | null>;
  summarizeQueryPlan?: (query: string) => string;
  explainQueryPlan?: (query: string) => { intent?: string } | undefined;
  injectEvidence?: (params: {
    task: {
      objective: string;
      recentMessages: string[];
      touchedFiles?: string[];
      iteration: number;
      sessionId: string;
      runId?: string;
      workItemId?: string;
    };
    budget: {
      maxTokens: number;
      maxItems?: number;
      topK?: number;
      filters?: Record<string, unknown>;
      minCoverage?: Partial<Record<string, number>>;
    };
    options?: { trace?: boolean };
  }) => Promise<{
    content: string;
    atoms: unknown[];
    trainingSignal?: Record<string, unknown>;
    metrics: {
      totalTokens: number;
      attentionTax: number;
      coverage: Record<string, number>;
      discriminatorsIncluded: number;
      latencyMs: number;
    };
  } | null>;
}

// ── Internals ────────────────────────────────────────────────────────

interface CacheEntry {
  queryKey: string;
  query: string;
  content: string | null;
  itemCount: number;
  latencyMs?: number;
  coverage?: Record<string, number>;
  discriminatorsIncluded?: number;
  totalTokens?: number;
  trainingSignal?: Record<string, unknown>;
}

const CONCEPT_INTENTS = new Set(['decision', 'preference', 'principle', 'tradeoff', 'recall']);

function extractUserMessages(ctx: ContextWindow, limit = 3): string[] {
  return ctx.getItemsByType<MessageItem>('message')
    .filter(m => m.role === 'user')
    .map(m => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) return m.content.map(b => b.type === 'text' ? b.text : '').join(' ');
      return '';
    })
    .filter(t => t.trim().length > 0)
    .slice(-limit);
}

// ── Bridge ───────────────────────────────────────────────────────────

export class MemoryBridge {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private injector: MemoryInjector,
    private deps: {
      sessionKey: string;
      requestId: string;
      agentType: string;
      emit: EventEmitCallback;
      hookQueue: InternalHookQueue;
    },
  ) {}

  /**
   * Inject memory content for an iteration.
   * Returns combined string of recent conversations + evidence, or null.
   */
  inject(
    workItem: WorkItem,
    globalContext: ContextWindow,
    taskContext: string,
    cwd: string,
    iteration: number,
  ): Effect.Effect<string | null> {
    return Effect.gen(this, function* () {
      // Recent conversations (first iteration only)
      let recent: string | null = null;
      const injectRecent = this.injector.injectRecentConversations;
      if (injectRecent && iteration === 0) {
        recent = yield* Effect.tryPromise({
          try: () => injectRecent({ limit: 10, maxTokens: 600 }),
          catch: () => null as never,
        }).pipe(Effect.catchAll(() => Effect.succeed(null)));
      }

      // Evidence retrieval
      const evidence = yield* this.getEvidence(workItem, globalContext, taskContext, cwd, iteration)
        .pipe(Effect.catchAll(() => Effect.succeed(null as string | null)));

      const parts = [recent, evidence].filter((s): s is string => !!s?.trim());
      return parts.length > 0 ? parts.join('\n\n') : null;
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
  }

  private buildQuery(workItem: WorkItem, globalContext: ContextWindow): string {
    const parts = workItem.objective ? [workItem.objective] : [];
    parts.push(...extractUserMessages(globalContext));
    return parts.join(' ').slice(0, 500);
  }

  private getEvidence(
    workItem: WorkItem,
    globalContext: ContextWindow,
    taskContext: string,
    cwd: string,
    iteration: number,
  ): Effect.Effect<string | null, Error> {
    const query = this.buildQuery(workItem, globalContext);
    const eventQuery = this.injector.summarizeQueryPlan?.(query) ?? query;
    const queryKey = eventQuery.trim().replace(/\s+/g, ' ').toLowerCase();
    const cacheKey = workItem.workId || this.deps.sessionKey || 'default';
    const hookCtx = this.hookContext(workItem);

    const plan = this.injector.explainQueryPlan?.(query);
    const intent = plan?.intent ?? 'unknown';
    const shouldFetch = !!this.injector.injectEvidence && !CONCEPT_INTENTS.has(intent);

    // Cache hit
    const cached = shouldFetch ? this.cache.get(cacheKey) : undefined;
    if (cached?.queryKey === queryKey) {
      this.emitInjected(workItem.workId, hookCtx, eventQuery, cached, iteration, taskContext);
      return Effect.succeed(cached.content);
    }

    const injectEvidence = this.injector.injectEvidence;
    if (!shouldFetch || !injectEvidence) {
      const empty: CacheEntry = { queryKey, query, content: null, itemCount: 0 };
      this.cache.set(cacheKey, empty);
      this.emitInjected(workItem.workId, hookCtx, eventQuery, empty, iteration, taskContext);
      return Effect.succeed(null);
    }

    return Effect.gen(this, function* () {
      const recentMessages = extractUserMessages(globalContext);
      const touchedFiles = globalContext.getReadFilesArray().map(f =>
        path.isAbsolute(f) ? path.relative(cwd, f) : f
      );

      const result = yield* Effect.tryPromise({
        try: () => injectEvidence({
          task: {
            objective: workItem.objective,
            recentMessages,
            touchedFiles,
            iteration,
            sessionId: this.deps.sessionKey,
            runId: this.deps.requestId || undefined,
            workItemId: workItem.workId,
          },
          budget: {
            maxTokens: 1000, maxItems: 3, topK: 12,
            filters: { intent, mode: 'memory_injection' },
            minCoverage: {},
          },
        }),
        catch: (e) => e instanceof Error ? e : new Error(String(e)),
      });

      const content = result?.content ?? null;
      const entry: CacheEntry = {
        queryKey, query, content,
        itemCount: result?.atoms.length ?? 0,
        latencyMs: result?.metrics.latencyMs,
        coverage: result?.metrics.coverage,
        discriminatorsIncluded: result?.metrics.discriminatorsIncluded,
        totalTokens: result?.metrics.totalTokens,
        trainingSignal: result?.trainingSignal,
      };
      this.cache.set(cacheKey, entry);
      this.emitInjected(workItem.workId, hookCtx, eventQuery, entry, iteration, taskContext);
      return content;
    }).pipe(
      Effect.catchAll(() => {
        this.emitInjected(workItem.workId, hookCtx, eventQuery, { queryKey, query, content: null, itemCount: 0 }, iteration, taskContext);
        return Effect.succeed(null);
      })
    );
  }

  private hookContext(workItem: WorkItem): InternalHookContext {
    return {
      workId: workItem.workId,
      agentType: this.deps.agentType,
      sessionKey: this.deps.sessionKey,
      requestId: this.deps.requestId,
      objective: workItem.objective,
    };
  }

  private emitInjected(
    workId: string,
    hookCtx: InternalHookContext,
    query: string,
    entry: CacheEntry,
    iteration: number,
    taskContext: string,
  ): void {
    const data = {
      query,
      resultPreview: entry.content?.slice(0, 500),
      memoryContent: entry.content ?? undefined,
      contextWithMemory: entry.content ? `${taskContext}\n\n${entry.content}` : undefined,
      itemCount: entry.itemCount,
      success: entry.content !== null,
      iteration,
      latencyMs: entry.latencyMs,
      coverage: entry.coverage,
      discriminatorsIncluded: entry.discriminatorsIncluded,
      totalTokens: entry.totalTokens,
      trainingSignal: entry.trainingSignal,
    };
    this.deps.hookQueue.enqueue({ type: 'memory_injected', ...data }, hookCtx);
    this.deps.emit(createEvent('memory_injected', data, workId));
  }
}
