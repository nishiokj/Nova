/**
 * Agent Trace Types - Cursor agent-trace spec implementation
 *
 * Based on: https://github.com/cursor/agent-trace
 * MIME type: application/vnd.agent-trace.record+json
 *
 * This is a vendor-neutral standard for recording AI contributions
 * in version-controlled codebases.
 */

// ============================================
// SPEC VERSION
// ============================================

export const AGENT_TRACE_VERSION = '0.1';

// ============================================
// CONTRIBUTOR TYPES
// ============================================

/**
 * Who authored the code.
 */
export type ContributorType = 'human' | 'ai' | 'mixed' | 'unknown';

/**
 * Contributor identity with optional model info.
 */
export interface Contributor {
  type: ContributorType;
  /** Model ID in models.dev format: "provider/model-name" */
  model_id?: string;
}

// ============================================
// VERSION CONTROL
// ============================================

/**
 * Supported VCS types.
 */
export type VCSType = 'git' | 'jj' | 'hg' | 'svn';

/**
 * Version control system info.
 */
export interface VCSInfo {
  type: VCSType;
  /** Commit SHA (git), change ID (jj), changeset (hg), or revision (svn) */
  revision: string;
}

// ============================================
// LINE RANGES
// ============================================

/**
 * A range of lines in a file (1-indexed).
 */
export interface LineRange {
  /** Starting line number (1-indexed, inclusive) */
  start_line: number;
  /** Ending line number (1-indexed, inclusive) */
  end_line: number;
  /**
   * Content hash for tracking code movement.
   * Format: "algorithm:hash" (e.g., "murmur3:9f2e8a1b")
   */
  content_hash?: string;
  /** Per-range contributor override */
  contributor?: Contributor;
}

// ============================================
// RELATED RESOURCES
// ============================================

/**
 * Related resource link.
 */
export interface RelatedResource {
  type: string;
  url: string;
}

// ============================================
// CONVERSATIONS
// ============================================

/**
 * A conversation that produced code changes.
 */
export interface Conversation {
  /** URL to access the conversation/session */
  url: string;
  /** Who contributed this code */
  contributor: Contributor;
  /** Line ranges attributed to this conversation */
  ranges: LineRange[];
  /** Optional links to related resources */
  related?: RelatedResource[];
}

// ============================================
// FILE ATTRIBUTION
// ============================================

/**
 * Attribution data for a single file.
 */
export interface FileAttribution {
  /** Path relative to repository root */
  path: string;
  /** Conversations that contributed to this file */
  conversations: Conversation[];
}

// ============================================
// TOOL INFO
// ============================================

/**
 * Information about the tool that generated this trace.
 */
export interface ToolInfo {
  name: string;
  version: string;
}

// ============================================
// TRACE RECORD
// ============================================

/**
 * A complete Agent Trace record.
 * This is the top-level structure anchored to a VCS revision.
 */
export interface TraceRecord {
  /** Spec version (e.g., "0.1") */
  version: string;
  /** Unique identifier for this trace record */
  id: string;
  /** RFC 3339 timestamp when trace was created */
  timestamp: string;
  /** Version control info */
  vcs: VCSInfo;
  /** Tool that generated this trace */
  tool: ToolInfo;
  /** Files with attribution data */
  files: FileAttribution[];
  /** Vendor-specific extensions (use reverse-domain notation) */
  metadata?: Record<string, unknown>;
}

// ============================================
// PENDING TRACE (INTERNAL)
// ============================================

/**
 * Internal structure for accumulating file modifications before commit.
 * This is NOT part of the spec - it's for the collection phase.
 */
export interface PendingFileModification {
  /** Absolute file path */
  filePath: string;
  /** Relative path from repo root */
  relativePath?: string;
  /** The tool that made the modification */
  toolName: 'Write' | 'Edit';
  /** Session key for conversation URL */
  sessionKey?: string;
  /** Model used (provider/model format) */
  modelId?: string;
  /** Timestamp of modification */
  timestamp: number;
  /** For Edit: the old content that was replaced */
  oldContent?: string;
  /** For Edit: the new content */
  newContent?: string;
  /** For Write: the full content written */
  content?: string;
  /** Request ID for correlation */
  requestId?: string;
}

// ============================================
// CONFIGURATION
// ============================================

/**
 * Configuration for trace URL generation.
 * Abstracted so different systems can provide their own URL scheme.
 */
export interface ConversationUrlProvider {
  /**
   * Generate a conversation URL from a session key.
   * Return undefined if no URL can be generated.
   */
  getUrl(sessionKey: string): string | undefined;
}

/**
 * Default/dummy URL provider that returns a placeholder.
 */
export const dummyUrlProvider: ConversationUrlProvider = {
  getUrl: (sessionKey: string) => `session://${sessionKey}`,
};

// ============================================
// HELPERS
// ============================================

/**
 * Format a model ID in models.dev convention.
 */
export function formatModelId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * Generate RFC 3339 timestamp.
 */
export function rfc3339Timestamp(date: Date = new Date()): string {
  return date.toISOString();
}

/**
 * Generate a UUID v4.
 */
export function generateTraceId(): string {
  return crypto.randomUUID();
}
