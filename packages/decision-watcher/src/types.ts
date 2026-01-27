/**
 * Decision Watcher Types
 *
 * Core types for the async decision watcher system.
 * The watcher intercepts PromptUser events and auto-answers them using a
 * curated database of decisions and preferences.
 */

import type { UserPromptInfo, UserPromptQuestion } from '@jesus/agent';
import type { LLMAdapter } from '@jesus/llm';

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
    /** File patterns (e.g., '**/*.ts', 'src/**/*') */
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
  | 'uncertain'           // Too uncertain, should ask user
  | 'escalate';           // Critical decision that requires user input

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

  /** When enabled, always escalate critical questions to user */
  escalateCritical: boolean;

  /**
   * When enabled, escalate if answer has warnings.
   */
  escalateWithWarnings: boolean;

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
   * Optional callback when watcher escalates to user.
   */
  onEscalate?: (question: UserPromptInfo, response: WatcherResponse) => void;

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
  | { action: 'escalate'; response: WatcherResponse }
  | { action: 'block'; reason: string };
