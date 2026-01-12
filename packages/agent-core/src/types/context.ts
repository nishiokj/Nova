/**
 * Context Window and Context Item types.
 *
 * Design Principle: Match the OpenAI Responses API Input Model
 *
 * The OpenAI Responses API input field is an array of heterogeneous items:
 * input: [
 *   { type: 'message', role: 'user', content: [...] },
 *   { type: 'function_call', call_id: '...', name: '...', arguments: '...' },
 *   { type: 'function_call_output', call_id: '...', output: '...' },
 *   { type: 'reasoning', content: '...' },
 * ]
 *
 * Our ContextWindow.items IS the input array. We canonicalize around item types.
 */

import type { ContentBlock } from './llm.js';
import type { ContextWindowMetrics } from './session.js';

// ============================================
// CONTEXT ITEM TYPES
// ============================================

/** Item types that can exist in a context window */
export type ContextItemType =
  | 'message'              // User/assistant/system messages
  | 'function_call'        // Tool invocation by model
  | 'function_call_output' // Result of tool execution
  | 'reasoning'            // Chain of thought (from reasoning models)
  | 'file_content'         // File loaded into context
  | 'artifact';            // Semantic code artifact (function, class, import, etc.)

/** Message item */
export interface MessageItem {
  type: 'message';
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | ContentBlock[];
  timestamp: number;
}

/** Function call item - model wants to call a tool */
export interface FunctionCallItem {
  type: 'function_call';
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  timestamp: number;
}

/** Function call output - result from tool execution */
export interface FunctionCallOutputItem {
  type: 'function_call_output';
  callId: string;
  output: string;
  isError?: boolean;
  durationMs?: number;
  timestamp: number;
}

/** Reasoning item - chain of thought */
export interface ReasoningItem {
  type: 'reasoning';
  content: string;
  timestamp: number;
}

/** File content item - file loaded into context */
export interface FileContentItem {
  type: 'file_content';
  id: string;
  path: string;
  content: string;
  language?: string;
  timestamp: number;
}

/** Artifact kind - what type of code construct this represents */
export type ArtifactKind =
  | 'function'      // Function/method signature + description
  | 'class'         // Class definition with methods summary
  | 'interface'     // Interface/type definition
  | 'import'        // Import/require statement (dependency)
  | 'export'        // Exported symbol
  | 'constant'      // Constant/config value
  | 'pattern'       // Architectural pattern observation
  | 'summary';      // High-level file/module summary

/** Semantic code artifact - extracted from source files */
export interface ArtifactItem {
  type: 'artifact';
  /** Unique identifier for this artifact */
  id: string;
  /** Source file path */
  sourcePath: string;
  /** Line number in source (for navigation) */
  line?: number;
  /** What kind of code construct */
  kind: ArtifactKind;
  /** Name of the artifact (function name, class name, etc.) */
  name: string;
  /** Signature or definition (e.g., "async function run(params: RunParams): Promise<Result>") */
  signature?: string;
  /** What state/data this modifies (side effects) */
  modifies?: string[];
  /** Non-trivial functions this calls (exclude basic utils, logging, etc.) */
  calls?: string[];
  /** Punchy insight - non-obvious behavior, gotchas, or goal-relevant info. Skip if name is self-explanatory. */
  insight?: string;
  /** Relevance score 0.0-1.0 (internal use - not sent to LLM) */
  relevance: number;
  /** Which agent/tool discovered this */
  discoveredBy: string;
  timestamp: number;
}

/** Union of all context item types */
export type ContextItem =
  | MessageItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | ReasoningItem
  | FileContentItem
  | ArtifactItem;

// ============================================
// CONTEXT WINDOW SNAPSHOT (for persistence)
// ============================================

export interface ContextWindowSnapshot {
  sessionKey: string;
  maxTokens: number;
  items: ContextItem[];
  metrics: ContextWindowMetrics;
  version: number;
  readFiles: string[];
  fileContentCounter?: number;
}

// ============================================
// EJECTION & COMPACTION TYPES
// ============================================

/** Result of ejecting file content items */
export interface EjectResult {
  ejectedCount: number;
  ejectedIds: string[];
  pathsRemoved: string[];
}

/** Options for context compaction */
export interface CompactOptions {
  /** Remove file_content older than this many milliseconds */
  maxFileContentAgeMs?: number;
  /** Keep at most this many file_content items (LRU eviction) */
  maxFileContentCount?: number;
  /** Remove file_content items for the same path, keeping only the newest */
  deduplicateByPath?: boolean;
  /** Truncate function_call_output items longer than this */
  truncateOutputsTo?: number;
}

/** Result of compaction */
export interface CompactResult {
  itemsRemoved: number;
  fileContentRemoved: number;
  outputsTruncated: number;
  bytesRecovered: number;
}

// ============================================
// CONTEXT WINDOW TELEMETRY
// ============================================

export interface ContextWindowTelemetry {
  /** Index signature for Record<string, unknown> compatibility */
  [key: string]: unknown;
  sessionKey: string;
  itemCount: number;
  itemsByType: Record<ContextItemType, number>;
  readFilesCount: number;
  /** Current context size - tokens in window (from last API response) */
  inputTokens: number;
  /** Peak context size - highest inputTokens seen */
  peakInputTokens: number;
  /** Completion tokens from last request */
  outputTokens: number;
  /** Cumulative completion tokens across all requests */
  totalOutputTokens: number;
  maxTokens: number;
  percentageUsed: number;
  version: number;
  /** For dashboard inspection */
  recentItems?: Array<{ type: string; preview: string; timestamp: number }>;
}
