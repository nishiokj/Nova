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
