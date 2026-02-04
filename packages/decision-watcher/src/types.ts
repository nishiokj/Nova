/**
 * Decision Watcher Types
 *
 * Core types for the async decision watcher system.
 * The watcher intercepts PromptUser events and auto-answers them using a
 * curated database of decisions and preferences.
 */

import type { UserPromptInfo } from 'agent';
import type { LLMAdapter } from 'llm';

// ============================================
// DECISION TYPES
// ============================================

/**
 * Category of a decision or preference.
 * Helps organize and retrieve relevant decisions for specific questions.
 */
export type DecisionCategory =
  | 'architecture'
  | 'patterns'
  | 'libraries'
  | 'style'
  | 'testing'
  | 'performance'
  | 'security'
  | 'documentation'
  | 'tooling'
  | 'workflow'
  | 'deployment'
  | 'data-modeling'
  | 'api-design'
  | 'state-management'
  | 'error-handling'
  | 'monitoring'
  | 'integration'
  | 'general';

/**
 * Priority of a decision - determines precedence when conflicts arise.
 */
export type DecisionPriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * Scope of a decision - where it applies.
 */
export type DecisionScope = 'global' | 'project' | 'language' | 'framework' | 'component';

/**
 * A decision record stored in the decision database.
 * Decisions are fundamental primitives of agentic orchestration that steer
 * projects at multiple levels.
 */
export interface Decision {
  /** Unique identifier for the decision */
  id: string;

  /** Category of the decision */
  category: DecisionCategory;

  /** Priority of the decision */
  priority: DecisionPriority;

  /** Scope where this decision applies */
  scope: DecisionScope;

  /**
   * The question or scenario this decision addresses.
   * Used for matching against incoming PromptUser questions.
   */
  questionPattern: string;

  /**
   * Keywords for matching. Helps find relevant decisions.
   */
  keywords: string[];

  /**
   * The actual decision or preference.
   * This is the answer that will be provided to the agent.
   */
  decision: string;

  /**
   * Rationale explaining why this decision was made.
   * Provides context for the watcher and helps with reasoning.
   */
  rationale: string;

  /**
   * Alternative options that were considered.
   * Helps the watcher understand trade-offs.
   */
  alternatives: string[];

  /**
   * Second-order effects of this decision.
   * Helps maintain salience/consistency across the project.
   */
  implications: string[];

  /**
   * Dependencies on other decisions (by ID).
   * If a decision depends on another, the watcher must ensure consistency.
   */
  dependsOn: string[];

  /**
   * Conflicts with other decisions (by ID).
   * The watcher should warn or block if conflicting decisions are made.
   */
  conflictsWith: string[];

  /**
   * Applicability constraints.
   * If specified, this decision only applies in specific contexts.
   */
  appliesTo?: {
    /** Programming language (e.g., 'typescript', 'python') */
    language?: string;
    /** Framework (e.g., 'react', 'express') */
    framework?: string;
    /** File patterns (e.g., '*.ts', 'src/**') */
    filePatterns?: string[];
  };

  /**
   * When this decision was made/last updated.
   */
  updatedAt: string;

  /**
   * Source of this decision (e.g., 'user', 'inferred', 'documented').
   */
  source: 'user' | 'inferred' | 'documented';
}

/**
 * A preference record - similar to a decision but softer constraints.
 * Preferences guide decisions but can be overridden with good reason.
 */
export interface Preference {
  /** Unique identifier */
  id: string;

  /** Category of the preference */
  category: DecisionCategory;

  /** Priority of the preference */
  priority: DecisionPriority;

  /** The preference statement */
  preference: string;

  /** Keywords for matching */
  keywords: string[];

  /** Rationale for the preference */
  rationale?: string;

  /**
   * How strongly this preference should be enforced.
   */
  strength: 'soft' | 'medium' | 'strong';

  /** When this preference was last updated */
  updatedAt: string;

  /** Source of this preference */
  source: 'user' | 'inferred' | 'documented';
}

/**
 * Combined type for decision database entries.
 */
export type DecisionEntry = Decision | Preference;

/**
 * Type guard to distinguish Decision from Preference.
 */
export function isDecision(entry: DecisionEntry): entry is Decision {
  return 'decision' in entry && 'alternatives' in entry;
}

export function isPreference(entry: DecisionEntry): entry is Preference {
  return 'preference' in entry && 'strength' in entry;
}

/**
 * Re-export UserPromptInfo from 'agent' for convenience
 */
export type { UserPromptInfo };

// ============================================
// WATCHER RESPONSE TYPES
// ============================================

/**
 * How the watcher answers a PromptUser question.
 */
export type WatcherAnswerSource =
  | 'database-match'      // Direct match found in decision database
  | 'synthesized'         // Synthesized from multiple decisions/preferences
  | 'inferred'            // Inferred from existing decisions using LLM
  | 'uncertain';          // Too uncertain, use fallback answer

/**
 * The confidence level in the watcher's answer.
 */
export type ConfidenceLevel = 'very-high' | 'high' | 'medium' | 'low' | 'none';

/**
 * The watcher's response to a PromptUser question.
 */
export interface WatcherResponse {
  /** How the answer was determined */
  source: WatcherAnswerSource;

  /** Confidence level in this answer */
  confidence: ConfidenceLevel;

  /** The answer to provide to the user prompt */
  answer: string | string[];

  /** If multiple choice, the selected option(s) */
  selectedOption?: string | string[];

  /**
   * Rationale for the answer.
   * This explains why the watcher chose this answer.
   */
  rationale?: string;

  /**
   * Relevant decisions that informed this answer.
   */
  relevantDecisions: Array<{
    id: string;
    decision: string;
    category: DecisionCategory;
    relevance: number; // 0-1
  }>;

  /**
   * Warnings about potential conflicts or second-order effects.
   */
  warnings: string[];

  /**
   * Whether this response should trigger a consistency check.
   */
  requiresConsistencyCheck: boolean;

  /**
   * Metadata about the decision process.
   */
  metadata: {
    processingTimeMs: number;
    decisionsConsulted: number;
    llmCalls: number;
  };
}

/**
 * Result of answering a PromptUser question.
 */
export interface PromptUserAnswer {
  /** The answer to the prompt */
  answer: string | string[];

  /** Selected option(s) if applicable */
  selectedOption?: string | string[];

  /** Whether to continue execution with this answer */
  shouldContinue: boolean;

  /** Additional context to add to the conversation */
  contextAddendum?: string;

  /** Watcher's response (for logging/telemetry) */
  watcherResponse?: WatcherResponse;
}

// ============================================
// WATCHER STATE & MEMORY
// ============================================

/**
 * Tracks decisions made during a session to maintain consistency.
 */
export interface DecisionMemory {
  /** Session ID */
  sessionId: string;

  /** Decisions made this session */
  decisionsMade: Array<{
    question: string;
    answer: string;
    decisionId?: string;
    timestamp: number;
  }>;

  /** Inferred patterns from decisions */
  patterns: string[];

  /** Warnings issued for inconsistencies */
  warnings: Array<{
    message: string;
    timestamp: number;
  }>;

  /**
   * Consistency score (0-1).
   * Lower scores indicate potential inconsistency.
   */
  consistencyScore: number;
}

/**
 * Context provided to the watcher when answering a question.
 */
export interface WatcherContext {
  /** Session ID for tracking consistency */
  sessionId: string;

  /** Current goal/objective */
  goal: string;

  /** The question(s) to answer */
  prompt: UserPromptInfo;

  /**
   * Relevant context from the current execution.
   * This includes files read, tool calls made, etc.
   */
  executionContext: {
    filesRead: string[];
    toolsUsed: string[];
    currentAgent: string;
  };

  /**
   * Project-level context.
   */
  projectContext?: {
    /** Programming language */
    language?: string;
    /** Framework being used */
    framework?: string;
    /** Project structure hints */
    structure?: string[];
  };

  /**
   * Previously made decisions for this session.
   */
  sessionDecisions?: DecisionMemory;
}

// ============================================
// WATCHER CONFIG
// ============================================

/**
 * Configuration for the decision watcher.
 */
export interface DecisionWatcherConfig {
  /** Whether async mode is enabled */
  enabled: boolean;

  /** Minimum confidence threshold to auto-answer */
  minConfidenceThreshold: number; // 0-1

  /**
   * Maximum number of decisions to consult per question.
   */
  maxDecisionsToConsult: number;

  /**
   * Whether to use LLM for synthesizing answers when no direct match exists.
   */
  useLLMSynthesis: boolean;

  /**
   * Whether to enable consistency checking across decisions.
   */
  enableConsistencyChecking: boolean;

  /**
   * LLM adapter for synthesis.
   */
  llm?: LLMAdapter;

  /**
   * Model to use for synthesis.
   */
  llmModel?: {
    provider: string;
    model: string;
  };

  /**
   * Custom decision database (optional).
   * If not provided, uses the default database.
   */
  customDatabase?: DecisionDatabase;
}

/**
 * Interface for the decision database.
 */
export interface DecisionDatabase {
  /**
   * Search for decisions matching a query.
   */
  search(query: string, options?: {
    category?: DecisionCategory;
    scope?: DecisionScope;
    limit?: number;
  }): Promise<DecisionEntry[]>;

  /**
   * Get a specific decision by ID.
   */
  get(id: string): Promise<DecisionEntry | null>;

  /**
   * Get all decisions.
   */
  getAll(): Promise<DecisionEntry[]>;

  /**
   * Add or update a decision.
   */
  upsert(entry: DecisionEntry): Promise<void>;

  /**
   * Delete a decision.
   */
  delete(id: string): Promise<void>;
}

// ============================================
// INTEGRATION TYPES
// ============================================

/**
 * Configuration for integrating the watcher with the orchestrator.
 */
export interface WatcherIntegrationConfig {
  /** Watcher configuration */
  watcherConfig: DecisionWatcherConfig;

  /**
   * Function to inject answers back into the agent context.
   */
  injectAnswer: (answer: PromptUserAnswer, workItemId: string) => void;

  /**
   * Optional callback when watcher answers a question.
   * Useful for logging, telemetry, or UI updates.
   */
  onAnswer?: (question: UserPromptInfo, answer: PromptUserAnswer, response: WatcherResponse) => void;

  /**
   * Optional callback when watcher detects inconsistency.
   */
  onInconsistency?: (message: string) => void;
}

/**
 * Hook event for PromptUser interception.
 */
export interface PromptUserHookEvent {
  type: 'prompt_user';
  workItemId: string;
  prompt: UserPromptInfo;
  timestamp: number;
}

/**
 * Hook result - determines what happens next.
 */
export type PromptUserHookResult =
  | { action: 'answer'; answer: PromptUserAnswer }
  | { action: 'block'; reason: string };

// ============================================
// WATCHER TRIGGER & ACTION TYPES
// ============================================

/**
 * Trigger types for the LLM-backed watcher.
 * Each trigger maps to a specific orchestrator terminal condition or lifecycle event.
 */
export type WatcherTrigger =
  | 'session_init'
  | 'prompt_user'
  | 'bounds_exceeded'
  | 'agent_error'
  | 'goal_state_reached'
  | 'work_item_completed'
  | 'scope_collision'
  | 'cadence_audit'
  | 'handoff_approval';

/**
 * Structured watcher output action types.
 * These determine what the watcher instructs the orchestrator to do.
 */
export type WatcherActionType =
  | 'answer'
  | 'realign'
  | 'split'
  | 'create_work_item'
  | 'quality_gate'
  | 'allow'
  | 'continue';

export type WatcherNoInterventionAction = 'allow' | 'continue';

/**
 * Valid watcher action types for each trigger.
 * This prevents LLM from being presented with invalid options.
 */
export const VALID_ACTIONS_BY_TRIGGER: Record<WatcherTrigger, WatcherActionType[]> = {
  prompt_user: ['answer'],
  bounds_exceeded: ['realign', 'split', 'create_work_item'],
  agent_error: ['realign', 'allow'],
  goal_state_reached: ['quality_gate', 'split', 'create_work_item'],
  work_item_completed: ['quality_gate', 'split', 'create_work_item'],
  cadence_audit: ['allow', 'realign', 'split', 'create_work_item'],
  session_init: [],  // No action - initialization only
  scope_collision: ['allow', 'realign'],  // Allow parallel or redirect one agent
  handoff_approval: ['allow', 'realign'],  // Approve plan or request revision
};

/**
 * Get valid actions for a specific trigger.
 */
export function getValidActions(trigger: WatcherTrigger): WatcherActionType[] {
  return VALID_ACTIONS_BY_TRIGGER[trigger];
}

import type { SemanticOutput } from './semantic/schemas.js';

export interface WatcherSemanticBatchEntry {
  workId: string;
  semantic: SemanticOutput;
}

/**
 * Structured output from the watcher agent.
 * Returned by the LLM-backed watcher after evaluating a trigger.
 *
 * The LLM output schema wraps this in the standard Agent protocol
 * (action: "done"|"continue", goalStateReached, response). The
 * watcher-specific decision lives in `watcherAction`.
 *
 * The optional `semantic` field is produced during cadence audits
 * and written to the semantic.json file asynchronously.
 */
export type WatcherAction =
  | {
      watcherAction: 'answer';
      reason: string;
      answer: { text: string; contextAddendum?: string };
      semantic?: SemanticOutput;
      semantics?: WatcherSemanticBatchEntry[];
    }
  | {
      watcherAction: 'realign';
      reason: string;
      realign: { systemMessage: string; newGoal?: string };
      semantic?: SemanticOutput;
      semantics?: WatcherSemanticBatchEntry[];
    }
  | {
      watcherAction: 'split' | 'create_work_item';
      reason: string;
      workItems: WatcherWorkItem[];
      semantic?: SemanticOutput;
      semantics?: WatcherSemanticBatchEntry[];
    }
  | {
      watcherAction: 'quality_gate';
      reason: string;
      qualityGate: { passed: boolean; issues?: string[] };
      semantic?: SemanticOutput;
      semantics?: WatcherSemanticBatchEntry[];
    }
  | {
      watcherAction: WatcherNoInterventionAction;
      reason: string;
      semantic?: SemanticOutput;
      semantics?: WatcherSemanticBatchEntry[];
    };

export type WatcherActionWithWorkItems = Extract<
  WatcherAction,
  { watcherAction: 'split' | 'create_work_item' }
>;

// ============================================
// WORK LOG TYPES (Session Level)
// ============================================

/**
 * Session-level work log entry types.
 * Tracks WorkItems at a high level - status, brief notes.
 * Gives the watcher session-wide awareness without drowning in details.
 *
 * JSONL format at .watcher/{date}/{sessionId}/work-log.jsonl
 */
export type WorkLogEntry =
  | WorkLogSessionStart
  | WorkLogWorkItemCreated
  | WorkLogWorkItemStatus
  | WorkLogNote;

/**
 * Session started.
 */
export interface WorkLogSessionStart {
  type: 'session_start';
  timestamp: string;
  goal: string;
  mode: 'async' | 'interactive';
}

/**
 * WorkItem was created/queued.
 */
export interface WorkLogWorkItemCreated {
  type: 'workitem_created';
  timestamp: string;
  workId: string;
  objective: string;
  agent: string;
  domain?: string;
  dependencies?: string[];
  /** Which workitem spawned this one (if split/created by watcher) */
  parentWorkId?: string;
}

/**
 * WorkItem status changed.
 */
export interface WorkLogWorkItemStatus {
  type: 'workitem_status';
  timestamp: string;
  workId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** Brief summary - 1-2 sentences max */
  summary?: string;
  /** Duration if completed/failed */
  durationMs?: number;
  /** Files modified (just paths, for quick reference) */
  filesModified?: string[];
}

/**
 * Session-level note (watcher observations, important events).
 * NOT for detailed conversation - that goes in workitem logs.
 */
export interface WorkLogNote {
  type: 'note';
  timestamp: string;
  /** Which workitem this relates to (optional) */
  workId?: string;
  note: string;
  /** Source of the note */
  source: 'watcher' | 'orchestrator' | 'user';
}

// ============================================
// WORKITEM LOG TYPES (WorkItem Level)
// ============================================

/**
 * WorkItem-level entry types (JSONL format for streaming).
 * Each line is a JSON object with a `type` discriminator.
 * Contains full conversation, tool calls, and scoped decisions.
 *
 * JSONL format at .watcher/{date}/{sessionId}/workitems/{workId}.jsonl
 */
export type WorkItemEntry =
  | WorkItemInitEntry
  | WorkItemMessageEntry
  | WorkItemToolCallEntry
  | WorkItemMemoryInjectionEntry
  | WorkItemDecisionEntry
  | WorkItemStatusEntry
  | WorkItemMetricsEntry;

/**
 * Initial entry when workitem is created.
 */
export interface WorkItemInitEntry {
  type: 'init';
  timestamp: string;
  workId: string;
  /** Working directory - all paths in this workitem log are relative to this */
  cwd: string;
  objective: string;
  agent: string;
  domain?: string;
  dependencies?: string[];
  targetPaths?: string[];
}

/**
 * Conversation message (streamed during agent execution).
 * Captures the agent's reasoning - this is what gives the watcher context.
 */
export interface WorkItemMessageEntry {
  type: 'message';
  timestamp: string;
  role: 'system' | 'user' | 'assistant';
  /** Full content - NOT truncated. The watcher needs complete context. */
  content: string;
  /** Agent's reasoning/thinking for this turn (extended thinking output) */
  reasoning?: string;
  /** If this was a watcher-injected answer */
  watcherInjected?: boolean;
}

/**
 * Tool call record (streamed during agent execution).
 * Shows what the agent investigated - critical for watcher context.
 *
 * NOTE: For Edit tools, the full old/new strings are included so the watcher
 * can see exactly what code was written. Paths are relative to cwd in init entry.
 */
export interface WorkItemToolCallEntry {
  type: 'tool_call';
  timestamp: string;
  tool: string;
  /** Full args - paths relative to cwd, content included for audit trail */
  args: Record<string, unknown>;
  success: boolean;
  /** Result summary - full for Read/Grep, may be truncated for very large outputs */
  resultSummary?: string;
  durationMs: number;
}

/**
 * Memory injection record (streamed during agent execution).
 * Captures what memory was injected and the query that retrieved it.
 */
export interface WorkItemMemoryInjectionEntry {
  type: 'memory_injection';
  timestamp: string;
  query: string;
  /** Full injected memory content (if available) */
  memoryContent?: string;
  /** Full task context with memory appended (if available) */
  contextWithMemory?: string;
  /** Memory content preview - first 500 chars */
  resultPreview?: string;
  /** Number of memory items returned */
  itemCount: number;
  /** Whether injection succeeded */
  success: boolean;
  /** Which iteration this was */
  iteration: number;
  /** Injection version */
  version?: 'v1' | 'v2';
  /** Retrieval latency (ms) */
  latencyMs?: number;
  /** Category coverage counts (v2 only) */
  coverage?: Record<string, number>;
  /** Discriminators included (v2 only) */
  discriminatorsIncluded?: number;
  /** Total tokens injected (v2 only) */
  totalTokens?: number;
  /** Whether v2 fell back to v1 */
  fallbackToV1?: boolean;
}

/**
 * Decision made by watcher for this workitem.
 * Scoped - only this workitem's decisions, not global.
 */
export interface WorkItemDecisionEntry {
  type: 'decision';
  timestamp: string;
  trigger: WatcherTrigger;
  question?: string;
  answer?: string;
  rationale: string;
  action: WatcherActionType;
}

/**
 * Status change (started, completed, failed).
 */
export interface WorkItemStatusEntry {
  type: 'status';
  timestamp: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  error?: string;
  agentSummary?: string;
}

/**
 * Metrics snapshot (can be updated periodically or at end).
 */
export interface WorkItemMetricsEntry {
  type: 'metrics';
  timestamp: string;
  toolCalls: number;
  llmCalls: number;
  contextPercentUsed: number;
  durationMs: number;
  filesRead: string[];
  filesModified: string[];
}

// ============================================
// WATCHER WORK ITEM (with bounds)
// ============================================

/**
 * A work item created by the watcher with optional budget bounds.
 */
export interface WatcherWorkItem {
  id?: string;
  goal: string;
  objective: string;
  agent: string;
  /**
   * Domain tag for parallelization control.
   * WorkItems in the same domain may have collision potential (e.g., modifying same files).
   * Different domains are safe to parallelize.
   * Examples: 'frontend', 'backend', 'tests', 'docs', 'config'
   */
  domain?: string;
  dependencies?: string[];
  targetPaths?: string[];
  bounds?: { maxToolCalls?: number; maxLlmCalls?: number; maxDurationMs?: number };
}

/**
 * Decision log entry persisted as JSONL.
 * Records every watcher invocation for auditability.
 */
export interface DecisionLogEntry {
  timestamp: string;
  trigger: WatcherTrigger;
  watcherAction: WatcherActionType;
  question?: string;
  answer?: string;
  rationale: string;
  workItemId?: string;
  qualityGate?: { passed: boolean; issues?: string[] };
  /** Execution metrics snapshot for audit trail */
  executionMetrics?: {
    toolCallsMade: number;
    filesModified: string[];
    durationMs: number;
    contextPercentUsed: number;
  };
}
