/**
 * Memory Injector Types
 *
 * Defines the interface for injecting relevant memory into agent context.
 */

export type QueryIntent =
  | 'decision'
  | 'preference'
  | 'principle'
  | 'tradeoff'
  | 'recall'
  | 'implementation'
  | 'debug'
  | 'unknown';

export interface MemoryQueryStrategy {
  enableIntentQueries?: boolean;
  enableOverlapBoost?: boolean;
  enableQualityFilters?: boolean;
  maxQueries?: number;
  maxIntentQueries?: number;
}

export interface QueryPlanSummary {
  intent: QueryIntent;
  topic: string | null;
  hotwords: string[];
  keywords: string[];
  phrases: string[];
  queries: Array<{
    text: string;
    weight: number;
    kind: string;
  }>;
}

/**
 * Parameters for recent conversation summary injection.
 */
export interface InjectRecentParams {
  /** Max summaries to include (default: 10) */
  limit?: number;
  /** Maximum tokens to include in injection */
  maxTokens: number;
  /** Optional connector filter */
  connectors?: string;
}

export interface EvidenceInjectParams {
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
  options?: {
    trace?: boolean;
  };
}

export interface EvidenceInjectResult {
  content: string;
  atoms: unknown[];
  trainingSignal?: {
    retrieval_id: string;
    query: {
      raw: string;
      state_summary: string;
    };
    candidate_list: Array<{
      doc_id: string;
      chunk_id: string | null;
      source_type: 'file' | 'symbol' | 'summary' | 'tool_output' | 'web';
      scores: {
        embedding_score: number | null;
        bm25_score: number | null;
        heuristic_score: number | null;
        reranker_score: number | null;
      };
      token_size: number;
      freshness: string | null;
      scope: string | null;
    }>;
    selected_set: Array<{
      doc_id: string;
      chunk_id: string | null;
      source_type: 'file' | 'symbol' | 'summary' | 'tool_output' | 'web';
      scores: {
        embedding_score: number | null;
        bm25_score: number | null;
        heuristic_score: number | null;
        reranker_score: number | null;
      };
      token_size: number;
      freshness: string | null;
      scope: string | null;
    }>;
    budget: {
      max_tokens: number;
      k: number;
      max_items: number;
      filters: Record<string, unknown> | null;
      min_coverage: Record<string, number>;
    };
    run_id: string | null;
    session_id: string;
    work_item_id: string | null;
  };
  metrics: {
    totalTokens: number;
    attentionTax: number;
    coverage: Record<string, number>;
    discriminatorsIncluded: number;
    latencyMs: number;
  };
}

/**
 * Parameters for watcher context injection.
 */
export interface InjectWatcherContextParams {
  /** Working directory for the session */
  workingDir: string;
  /** Session ID */
  sessionId: string;
  /** WorkItem ID */
  workId: string;
  /** Optional date for path resolution (defaults to today) */
  date?: Date;
}

/**
 * Result from watcher context injection.
 */
export interface WatcherContextResult {
  /** Formatted content for injection */
  content: string;
  /** Whether salience was included */
  hasSalience: boolean;
  /** Whether semantic file was included */
  hasSemantic: boolean;
  /** State of the semantic file if present */
  semanticState?: 'valid' | 'failed' | 'initial';
}

/**
 * Memory injector interface.
 * Stateless retrieval layer that queries memory and returns formatted content.
 */
export interface MemoryInjector {
  /**
   * Inject recent conversation summaries (no search query).
   * Intended for first-iteration priming.
   */
  injectRecentConversations?: (params: InjectRecentParams) => Promise<string | null>;

  /**
   * Summarize the internal query plan for observability.
   * Returns a short string of sub-queries (e.g., "foo | bar | baz").
   */
  summarizeQueryPlan?: (query: string) => string;

  /**
   * Return a structured query plan summary for debugging.
   */
  explainQueryPlan?: (query: string) => QueryPlanSummary;

  /**
   * Inject relevant evidence using canonical retrieval (optional).
   * @returns Structured result with formatted content, or null if none
   */
  injectEvidence?: (params: EvidenceInjectParams) => Promise<EvidenceInjectResult | null>;

  /**
   * Inject watcher context (salience + semantic) for a workItem.
   * Used after realign to provide workers with accumulated context.
   * @returns Formatted context, or null if no relevant context found
   */
  injectWatcherContext?: (params: InjectWatcherContextParams) => Promise<WatcherContextResult | null>;
}

/**
 * Configuration for creating a memory injector.
 */
export interface MemoryInjectorConfig {
  /** Base URL of the agent-memory daemon (e.g., 'http://localhost:3001') */
  baseUrl: string;
  /** Request timeout in ms (default: 5000) */
  timeout?: number;
  /** Optional strategy flags for query planning and reranking */
  strategy?: MemoryQueryStrategy;
}
