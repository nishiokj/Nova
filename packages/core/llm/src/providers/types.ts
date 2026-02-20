/**
 * Internal provider types - not exposed in public API.
 */

import type {
  LLMProvider,
  Message,
  ToolDefinition,
  ToolCall,
  LLMResponse,
  LLMRequestConfig,
  RespondParams,
  StreamParams,
  LLMExecutionError,
} from 'types';
import { Effect, Stream } from 'effect';

/**
 * Error thrown when a streaming request fails mid-stream.
 * Preserves partial content so callers can recover work done before the error.
 */
export class PartialStreamError extends Error {
  public readonly partialContent: string;
  public readonly partialToolCalls: ToolCall[];
  public readonly cause: Error;

  constructor(
    message: string,
    cause: Error,
    partialContent: string,
    partialToolCalls: ToolCall[] = []
  ) {
    super(`${message}: ${cause.message}`);
    this.name = 'PartialStreamError';
    this.cause = cause;
    this.partialContent = partialContent;
    this.partialToolCalls = partialToolCalls;
  }

  /**
   * Check if an error is a PartialStreamError with recoverable content.
   */
  static hasPartialContent(error: unknown): error is PartialStreamError {
    return error instanceof PartialStreamError && error.partialContent.length > 0;
  }
}

/**
 * Logger interface for adapter operations.
 */
export interface AdapterLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Resolved configuration for a single request.
 */
export interface ResolvedRequestConfig {
  provider: LLMProvider;
  /** Original provider name from config (e.g., 'z.ai-coder', 'cerebras') for display in errors */
  displayProvider: string;
  model: string;
  /** API key (optional for local providers that don't require auth) */
  apiKey?: string;
  baseUrl: string;
  maxTokens?: number;
  temperature?: number;
  reasoning?: LLMRequestConfig['reasoning'];
  /** ChatGPT account ID for Codex OAuth requests */
  chatgptAccountId?: string;
}

/**
 * Provider context passed to all provider methods.
 * Centralizes shared dependencies.
 */
export interface ProviderContext {
  config: ResolvedRequestConfig;
  logger: AdapterLogger;
  startTime: number;
}

/**
 * Provider interface - implemented by each LLM provider.
 * All providers expose a simple, unified API.
 */
export interface LLMProviderAdapter {
  /**
   * Provider name (e.g., 'openai', 'anthropic').
   */
  readonly name: LLMProvider;

  /**
   * Send a non-streaming request.
   */
  respond(
    context: ProviderContext,
    params: RespondParams
  ): Effect.Effect<LLMResponse, LLMExecutionError>;

  /**
   * Send a streaming request.
   */
  stream(
    context: ProviderContext,
    params: StreamParams
  ): Stream.Stream<string, LLMExecutionError>;

  /**
   * Format tools for this provider's API.
   */
  formatTools?(tools: ToolDefinition[]): Record<string, unknown>[];

  /**
   * Format messages for this provider's API.
   */
  formatMessages?(messages: Message[]): Array<Record<string, unknown>>;
}

function inferExecutionErrorType(
  error: unknown
): LLMExecutionError['type'] {
  if (error instanceof PartialStreamError) return 'provider_error';
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'cancelled';
    if (error.name === 'TimeoutError') return 'timeout';
    const message = error.message.toLowerCase();
    if (message.includes('cancel')) return 'cancelled';
    if (message.includes('timeout')) return 'timeout';
  }
  return 'unknown';
}

export function toLLMExecutionError(
  error: unknown,
  provider: string,
  model: string
): LLMExecutionError {
  if (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    'message' in error
  ) {
    return error as LLMExecutionError;
  }
  if (error instanceof Error) {
    const decorated = error as Error & Partial<LLMExecutionError>;
    if (!decorated.type) {
      decorated.type = inferExecutionErrorType(error);
    }
    if (!decorated.metadata) {
      decorated.metadata = { provider, model };
    }
    return decorated as unknown as LLMExecutionError;
  }
  return {
    type: 'unknown',
    message: String(error),
    cause: error,
    metadata: { provider, model },
  };
}
