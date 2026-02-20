/**
 * Tool execution types.
 *
 * Ported from: src/harness/agent/tool_registry.py (ToolResult only)
 * and src/harness/agent/plan_models.py (ToolCallRecord)
 */

import type { Effect } from 'effect';
import type { RunControlMetadata, RunExecutionMetadata } from './llm.js';

// ============================================
// TOOL RESULT
// ============================================

/**
 * Status of a tool execution.
 */
export type ToolStatus = 'success' | 'error' | 'timeout' | 'cancelled';

/**
 * Result of executing a tool.
 */
export type ToolResult =
  | {
      toolName: string;
      status: 'success';
      output: string;
      durationMs: number;
      isSuccess: true;
      metadata?: Record<string, unknown>;
      error?: undefined;
    }
  | {
      toolName: string;
      status: Exclude<ToolStatus, 'success'>;
      output: string;
      error: string;
      durationMs: number;
      isSuccess: false;
      metadata?: Record<string, unknown>;
    };

/**
 * Create a successful tool result.
 */
export function successResult(
  toolName: string,
  output: string,
  durationMs: number,
  metadata?: Record<string, unknown>
): ToolResult {
  return {
    toolName,
    status: 'success',
    output,
    durationMs,
    isSuccess: true,
    metadata,
  };
}

/**
 * Create a failed tool result.
 */
export function errorResult(
  toolName: string,
  error: string,
  durationMs: number,
  metadata?: Record<string, unknown>
): ToolResult {
  return {
    toolName,
    status: 'error',
    output: '',
    error,
    durationMs,
    isSuccess: false,
    metadata,
  };
}

/**
 * Create a timeout tool result.
 */
export function timeoutResult(
  toolName: string,
  durationMs: number
): ToolResult {
  return {
    toolName,
    status: 'timeout',
    output: '',
    error: `Tool execution timed out after ${durationMs}ms`,
    durationMs,
    isSuccess: false,
  };
}

// ============================================
// TOOL CALL RECORD
// ============================================

/**
 * Record of a single tool call made during step execution.
 */
export interface ToolCallRecord {
  toolName: string;
  arguments: Record<string, unknown>;
  result: ToolResult;
  durationMs: number;
  /** Unix timestamp in seconds */
  timestamp: number;
}

/**
 * Create a tool call record.
 */
export function createToolCallRecord(
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
  durationMs: number
): ToolCallRecord {
  return {
    toolName,
    arguments: args,
    result,
    durationMs,
    timestamp: Date.now() / 1000,
  };
}

// ============================================
// TOOL DEFINITION
// ============================================

/**
 * JSON Schema for tool parameter.
 */
export interface ToolParameterSchema {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: string[];
  items?: ToolParameterSchema;
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
  default?: unknown;
  additionalProperties?: boolean | ToolParameterSchema;
}

/**
 * Tool definition for LLM tool use.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameterSchema>;
    required: string[];
    additionalProperties?: boolean;
  };
  strict?: boolean;
}

// ============================================
// TOOL EXECUTOR TYPES
// ============================================

/**
 * Arguments for bash tool execution.
 */
export interface BashArgs {
  command: string;
  timeout?: number; // milliseconds
  env?: Record<string, string>;
}

/**
 * Arguments for read tool execution.
 */
export interface ReadArgs {
  path: string;
  encoding?: BufferEncoding;
  maxBytes?: number;
  /** Start line for partial reads (1-indexed, inclusive) */
  startLine?: number;
  /** End line for partial reads (1-indexed, inclusive) */
  endLine?: number;
}

/**
 * Arguments for write tool execution.
 */
export interface WriteArgs {
  path: string;
  content: string;
  encoding?: BufferEncoding;
  mode?: number; // file permissions
}

/**
 * Arguments for grep/search tool execution.
 */
export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  maxResults?: number;
  caseInsensitive?: boolean;
}

/**
 * Arguments for glob tool execution.
 */
export interface GlobArgs {
  pattern: string;
  path?: string; // Subdirectory to search within
  ignore?: string[];
  maxResults?: number;
}

/**
 * Union of all tool argument types.
 */
export type ToolArgs = BashArgs | ReadArgs | WriteArgs | GrepArgs | GlobArgs;

export interface ToolExecutionContext {
  execution: RunExecutionMetadata;
  control: RunControlMetadata;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionError {
  type: 'cancelled' | 'paused' | 'timeout' | 'validation_error' | 'execution_error' | 'unknown';
  message: string;
  cause?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Effect-native tool executor contract.
 */
export type ToolExecutor<T extends ToolArgs = ToolArgs> = (
  args: T,
  context: ToolExecutionContext
) => Effect.Effect<ToolResult, ToolExecutionError>;
