/**
 * Wizard event types and payloads.
 *
 * Events are emitted by Wizard for observability. Emission is optional and
 * pluggable via callbacks; Wizard does not depend on any event bus.
 *
 * Ported from: src/harness/agent/wizard/events.py
 */

// ============================================
// EVENT TYPES
// ============================================

/**
 * Types of events emitted by the Wizard.
 * Using string literal union for cleaner TypeScript patterns.
 */
export type WizardEventType =
  // Goal events
  | 'goal_started'
  | 'goal_achieved'
  | 'goal_aborted'
  // Progress events
  | 'step_started'
  | 'step_completed'
  | 'step_failed'
  | 'step_skipped'
  // Tool events
  | 'tool_call'
  // Synthesis events (after tool calls, before LLM analysis)
  | 'synthesis_started'
  // Reflection events
  | 'reflection_started'
  | 'reflection_completed'
  // Scaffolding events
  | 'steps_scaffolded'
  // User input events
  | 'user_input_requested'
  | 'user_input_received'
  // Quality events
  | 'quality_issue_detected'
  | 'error_detected'
  // LLM call tracking (for dashboard observability)
  | 'llm_call'
  // LLM error tracking (for error propagation and circuit breaker visibility)
  | 'llm_error'
  // Plan versioning (for dashboard plan carousel)
  | 'plan_snapshot'
  | 'plan_patched'
  // Context window metrics (for dashboard token widget)
  | 'context_window_update'
  // Context window telemetry (full item-based context state)
  | 'context_window_telemetry';

// ============================================
// BASE EVENT
// ============================================

/**
 * Base event structure.
 * All wizard events conform to this shape.
 */
export interface WizardEvent<T = Record<string, unknown>> {
  type: WizardEventType;
  /** Unix timestamp in seconds (float) - matches Python time.time() */
  timestamp: number;
  /** Step number if event is step-related */
  stepNum?: number;
  /** Event-specific payload */
  data: T;
}

/**
 * Create a WizardEvent with current timestamp.
 */
export function createEvent<T>(
  type: WizardEventType,
  data: T,
  stepNum?: number
): WizardEvent<T> {
  return {
    type,
    timestamp: Date.now() / 1000, // Convert to Python-compatible float seconds
    stepNum,
    data,
  };
}

/**
 * Serialize event to JSON-compatible dict.
 * Matches Python WizardEvent.to_dict()
 */
export function eventToDict(event: WizardEvent): Record<string, unknown> {
  return {
    type: event.type,
    timestamp: event.timestamp,
    step_num: event.stepNum ?? null,
    data: event.data ?? {},
  };
}

// ============================================
// EVENT PAYLOADS
// ============================================

export type AgentType = 'wizard' | 'worker' | 'planner' | 'reflector' | 'synthesizer';

/**
 * Data for goal_started event.
 */
export interface GoalStartedData {
  goal: string;
  userInput: string;
  steps?: Array<{
    stepNum: number;
    objective: string;
    phase?: 'discovery' | 'execution';
    toolHint?: string;
  }>;
}

/**
 * Data for goal_achieved event.
 */
export interface GoalAchievedData {
  goal: string;
  stepsCompleted: number;
  totalDurationMs: number;
}

/**
 * Data for goal_aborted event.
 */
export interface GoalAbortedData {
  goal: string;
  reason: string;
  stepsCompleted: number;
}

/**
 * Data for step_started event.
 */
export interface StepStartedData {
  objective: string;
  phase?: 'discovery' | 'execution';
  toolHint?: string;
}

/**
 * Data for step_completed event.
 */
export interface StepCompletedData {
  stepNum: number;
  objective: string;
  outcomeSummary: string;
  qualityScore: number;
  verdict: string;
  scaffoldedCount: number;
  durationMs?: number;
}

/**
 * Data for step_failed event.
 */
export interface StepFailedData {
  objective: string;
  error: string;
  reason?: string;
  /** Full stack trace if available */
  stack?: string;
  /** Tool errors that contributed to failure */
  toolErrors?: string[];
  /** Why execution terminated */
  terminationReason?: string;
}

/**
 * Data for step_skipped event.
 */
export interface StepSkippedData {
  objective: string;
  reason: string;
  message?: string;
  error?: string;
}

/**
 * Phase of a tool call event.
 */
export type ToolCallPhase = 'starting' | 'completed';

/**
 * Data for tool_call event.
 */
export interface ToolCallData {
  toolName: string;
  arguments: Record<string, unknown>;
  /** Phase of the tool call: 'starting' before execution, 'completed' after */
  phase: ToolCallPhase;
  /** Result content (only present when phase='completed') */
  result?: string;
  /** Success status (only present when phase='completed') */
  success?: boolean;
  /** Duration in ms (only present when phase='completed') */
  durationMs?: number;
}

/**
 * Data for USER_INPUT_REQUESTED event.
 */
export interface UserInputRequestedData {
  stepNum: number;
  question: string;
  options: string[];
  context: string;
  requestId?: string;
}

/**
 * Data for USER_INPUT_RECEIVED event.
 */
export interface UserInputReceivedData {
  requestId?: string;
  answer: string;
}

/**
 * Data for quality_issue_detected event.
 */
export interface QualityIssueData {
  stepNum: number;
  issues: string[];
  errors: string[];
  severity: 'low' | 'medium' | 'high';
}

/**
 * Data for error_detected event.
 */
export interface ErrorDetectedData {
  errors: string[];
  context?: string;
}

/**
 * Data for LLM_CALL event - tracks individual LLM API calls.
 */
export interface LLMCallData {
  agentType: AgentType;
  stepNum?: number;
  /** First 500 chars of prompt */
  promptPreview: string;
  /** First 500 chars of response */
  responsePreview: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  model: string;
  toolCallsCount: number;
}

/**
 * Data for llm_error event - tracks LLM API errors.
 */
export interface LLMErrorData {
  agentType: AgentType;
  stepNum?: number;
  provider: string;
  model: string;
  /** Error message */
  error: string;
  /** Error classification */
  errorType: 'api_error' | 'rate_limit' | 'timeout' | 'validation' | 'circuit_open' | 'unknown';
  /** HTTP status code if available */
  statusCode?: number;
  /** Whether this error triggered circuit breaker */
  circuitBreakerTriggered?: boolean;
  /** Whether the operation will be retried */
  willRetry?: boolean;
  /** Attempt number (1-based) */
  attemptNumber?: number;
  /** Max retries configured */
  maxRetries?: number;
}

/**
 * Data for PLAN_SNAPSHOT event - full plan state for versioning.
 */
export interface PlanSnapshotData {
  version: number;
  snapshotType: 'initial' | 'pre_patch' | 'post_patch';
  steps: Array<{
    stepNum: number;
    objective: string;
    status: string;
    phase: 'discovery' | 'execution';
    toolHint?: string;
    required?: boolean;
  }>;
  goal: string;
  trigger: string;
}

/**
 * Data for CONTEXT_WINDOW_UPDATE event - token usage metrics.
 */
export interface ContextWindowUpdateData {
  /** Peak prompt tokens (actual context window usage) */
  contextTokens: number;
  /** Cumulative completion tokens */
  outputTokens: number;
  /** Default 200000 */
  maxTokens: number;
  /** contextTokens / maxTokens */
  percentageUsed: number;
  messageCount: number;
  /** Legacy: contextTokens + outputTokens */
  totalTokens: number;
}

/**
 * Data for reflection_completed event.
 */
export interface ReflectionCompletedData {
  verdict: 'accept' | 'accept_extend' | 'redo' | 'abort_step' | 'abort_goal';
  confidence: number;
  qualityScore: number;
  reasoning?: string;
  issues: string[];
}

/**
 * Data for steps_scaffolded event.
 */
export interface StepsScaffoldedData {
  count: number;
  steps: Array<{
    stepNum: number;
    objective: string;
    phase: 'discovery' | 'execution';
  }>;
}

// ============================================
// EVENT CALLBACK TYPE
// ============================================

/**
 * Callback function type for receiving wizard events.
 */
export type WizardEventCallback = (event: WizardEvent) => void;

/**
 * Event emitter interface for wizard observability.
 */
export interface WizardEventEmitter {
  emit(event: WizardEvent): void;
  on(callback: WizardEventCallback): () => void;
}

/**
 * Simple in-memory event emitter implementation.
 */
export class SimpleEventEmitter implements WizardEventEmitter {
  private callbacks: WizardEventCallback[] = [];

  emit(event: WizardEvent): void {
    for (const cb of this.callbacks) {
      try {
        cb(event);
      } catch {
        // Swallow callback errors to not disrupt wizard
      }
    }
  }

  on(callback: WizardEventCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      const idx = this.callbacks.indexOf(callback);
      if (idx !== -1) {
        this.callbacks.splice(idx, 1);
      }
    };
  }
}
