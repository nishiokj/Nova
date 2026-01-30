/**
 * Memory Injector Types
 *
 * Defines the interface for injecting relevant memory into agent context.
 */

/**
 * Parameters for memory injection.
 */
export interface InjectParams {
  /** Search query built from objective + recent messages */
  query: string;
  /** Maximum tokens to include in injection */
  maxTokens: number;
}

export interface InjectParamsV2 {
  task: {
    objective: string;
    recentMessages: string[];
    touchedFiles?: string[];
    iteration: number;
    sessionId: string;
    workItemId?: string;
  };
  budget: {
    maxTokens: number;
    maxItems?: number;
    minCoverage?: Partial<Record<string, number>>;
  };
  options?: {
    forceV1Fallback?: boolean;
    trace?: boolean;
  };
}

export interface InjectResultV2 {
  content: string;
  atoms: unknown[];
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
   * Inject relevant memory based on query.
   * @returns Formatted memory content, or null if no relevant memories found
   */
  inject(params: InjectParams): Promise<string | null>;

  /**
   * Inject relevant evidence using v2 retrieval (optional).
   * @returns Structured result with formatted content, or null if none
   */
  injectV2?: (params: InjectParamsV2) => Promise<InjectResultV2 | null>;

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
}
