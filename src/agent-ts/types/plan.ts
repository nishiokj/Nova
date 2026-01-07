/**
 * Shared data models for the Plan -> Execute -> Reflect architecture.
 *
 * This module intentionally contains no logging. Logging is handled by the Agent.
 *
 * Ported from: src/harness/agent/plan_models.py
 */

import type { ToolResult, ToolCallRecord } from './tools.js';
import type { Message } from './llm.js';

// ============================================
// ENUMS (as string literal unions)
// ============================================

/**
 * Status of a plan or step.
 */
export type PlanStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'partial'
  | 'skipped'; // Dependencies failed or step could not execute

/**
 * Execution phase for a plan step.
 */
export type PlanPhase = 'discovery' | 'execution';

/**
 * Type of discovery extracted from tool results.
 */
export type DiscoveryType =
  | 'file_content'
  | 'search_result'
  | 'directory_listing'
  | 'command_output'
  | 'error'
  | 'step_summary'; // Summary of a completed step

// ============================================
// DISCOVERY
// ============================================

/**
 * Canonicalized discovery entry from tool execution.
 */
export interface Discovery {
  type: DiscoveryType;
  timestamp: number;
  // Type-specific fields
  path?: string; // For file_content, directory_listing
  size?: number; // For file_content (bytes)
  preview?: string; // For file_content (truncated content)
  query?: string; // For search_result
  matches?: string[]; // For search_result (top N matches)
  total?: number; // For search_result, directory_listing (total count)
  files?: string[]; // For directory_listing (top N files)
  command?: string; // For command_output
  output?: string; // For command_output (truncated)
  tool?: string; // For error
  message?: string; // For error
  stepNum?: number; // For error, step_summary (which step)
  // step_summary fields
  objective?: string; // Step objective
  status?: string; // Step completion status
  toolsUsed?: string[]; // Tools executed in this step
  resultSummary?: string; // Brief summary of what was accomplished
}

// ============================================
// SUCCESS CRITERIA
// ============================================

/**
 * Defines what success looks like for a step or plan.
 */
export interface SuccessCriteria {
  description: string; // Human-readable success condition
  requiredOutputs: string[]; // What must be produced
  validationHints: string[]; // How to validate
  automatedChecks?: Record<string, unknown>; // Automated validation config
}

/**
 * Create default success criteria.
 */
export function createSuccessCriteria(
  description: string,
  opts?: Partial<Omit<SuccessCriteria, 'description'>>
): SuccessCriteria {
  return {
    description,
    requiredOutputs: opts?.requiredOutputs ?? [],
    validationHints: opts?.validationHints ?? [],
    automatedChecks: opts?.automatedChecks,
  };
}

// ============================================
// STEP CONTEXT
// ============================================

/**
 * Accumulated context during step execution.
 *
 * A step may involve multiple tool calls and reasoning rounds.
 * This captures everything that happened within the step.
 */
export interface StepContext {
  toolCallsMade: ToolCallRecord[];
  toolResults: Record<string, unknown>; // tool_name -> last result
  intermediateReasoning: string[];
  validationChecks: Record<string, boolean>;
  accumulatedData: Record<string, unknown>; // Step's working memory
}

/**
 * Create an empty step context.
 */
export function createStepContext(): StepContext {
  return {
    toolCallsMade: [],
    toolResults: {},
    intermediateReasoning: [],
    validationChecks: {},
    accumulatedData: {},
  };
}

/**
 * Add tool result to step context.
 */
export function addToolResult(
  context: StepContext,
  toolName: string,
  result: ToolResult
): void {
  context.toolResults[toolName] = result;

  if (result.isSuccess && result.output) {
    const key = `${toolName}_output`;
    if (!context.accumulatedData[key]) {
      context.accumulatedData[key] = [];
    }
    (context.accumulatedData[key] as unknown[]).push(result.output);
  }
}

/**
 * Check if step has all required data in accumulatedData.
 */
export function hasRequiredData(
  context: StepContext,
  required: string[]
): boolean {
  return required.every((key) => key in context.accumulatedData);
}

// ============================================
// VALIDATION RESULT
// ============================================

/**
 * Result of validating a step's success criteria.
 */
export interface ValidationResult {
  passed: boolean;
  details: string;
  confidence: number;
}

// ============================================
// PLAN STEP
// ============================================

/**
 * A single step in an execution plan.
 *
 * A step is a unit of work (sub-goal), not a single tool call.
 * It may involve 0-N tool calls plus reasoning to achieve its objective.
 */
export interface PlanStep {
  stepNum: number;
  objective: string; // What this step should accomplish

  // Guidance (not strict requirements)
  toolHint?: string; // Suggested primary tool
  toolArgsHint?: Record<string, unknown>; // Suggested arguments

  // Step boundaries and validation
  successCriteria?: SuccessCriteria;
  maxToolCalls: number; // Safety limit per step (default 3)
  dependsOn: number[]; // Step dependencies
  phase: PlanPhase; // Discovery vs execution phase

  // Uncertainty reduction (for discovery steps)
  uncertaintiesTargeted: string[]; // Which uncertainties this reduces
  expectedUncertaintyReduction: number; // Expected entropy reduction (0.0-1.0)
  actualUncertaintyReduction: number; // Actual reduction achieved

  // Pre/postconditions (for execution steps)
  preconditions: string[]; // Must be true before this step
  postconditions: string[]; // Will be true after this step
  verificationMethod?: string; // How to verify postconditions met

  // Execution state (filled during execution)
  status: PlanStatus;
  context?: StepContext; // Accumulated context during execution
  error?: string;
  durationMs: number;
  startedAt?: number; // Unix timestamp
  completedAt?: number; // Unix timestamp

  // Validation results
  validationPassed: boolean;
  validationDetails?: string;
}

/**
 * Create a plan step with defaults.
 */
export function createPlanStep(
  stepNum: number,
  objective: string,
  opts?: Partial<Omit<PlanStep, 'stepNum' | 'objective'>>
): PlanStep {
  return {
    stepNum,
    objective,
    toolHint: opts?.toolHint,
    toolArgsHint: opts?.toolArgsHint,
    successCriteria: opts?.successCriteria,
    maxToolCalls: opts?.maxToolCalls ?? 3,
    dependsOn: opts?.dependsOn ?? [],
    phase: opts?.phase ?? 'execution',
    uncertaintiesTargeted: opts?.uncertaintiesTargeted ?? [],
    expectedUncertaintyReduction: opts?.expectedUncertaintyReduction ?? 0,
    actualUncertaintyReduction: opts?.actualUncertaintyReduction ?? 0,
    preconditions: opts?.preconditions ?? [],
    postconditions: opts?.postconditions ?? [],
    verificationMethod: opts?.verificationMethod,
    status: opts?.status ?? 'pending',
    context: opts?.context,
    error: opts?.error,
    durationMs: opts?.durationMs ?? 0,
    startedAt: opts?.startedAt,
    completedAt: opts?.completedAt,
    validationPassed: opts?.validationPassed ?? false,
    validationDetails: opts?.validationDetails,
  };
}

// ============================================
// STEP RESULT
// ============================================

/**
 * Result from executing a single step.
 *
 * Returned by Executor - does NOT mutate the original PlanStep.
 * Agent interprets this result and updates plan state accordingly.
 */
export interface StepResult {
  stepNum: number;
  status: PlanStatus;
  toolCallsMade: ToolCallRecord[];
  llmMessages: Message[]; // Messages to append to conversation
  accumulatedData: Record<string, unknown>; // Step's working memory
  finalResponse?: string; // If step generated final response
  error?: string; // Error message if step failed
  durationMs: number;
  phase: PlanPhase;
  context?: StepContext;

  // Validation results (can be filled by Agent after executor returns)
  validationPassed: boolean;
  validationDetails?: string;
}

/**
 * Create a step result with defaults.
 */
export function createStepResult(
  stepNum: number,
  status: PlanStatus,
  opts?: Partial<Omit<StepResult, 'stepNum' | 'status'>>
): StepResult {
  return {
    stepNum,
    status,
    toolCallsMade: opts?.toolCallsMade ?? [],
    llmMessages: opts?.llmMessages ?? [],
    accumulatedData: opts?.accumulatedData ?? {},
    finalResponse: opts?.finalResponse,
    error: opts?.error,
    durationMs: opts?.durationMs ?? 0,
    phase: opts?.phase ?? 'execution',
    context: opts?.context,
    validationPassed: opts?.validationPassed ?? false,
    validationDetails: opts?.validationDetails,
  };
}

// ============================================
// PLAN
// ============================================

/**
 * Goal type classification.
 */
export type GoalType = 'question' | 'task' | 'creation' | 'search';

/**
 * Estimated complexity classification.
 */
export type ComplexityLevel = 'simple' | 'standard' | 'complex';

/**
 * An explicit execution plan created before running.
 *
 * Key difference from current approach: we know WHAT we're trying to do
 * and HOW we'll know if we succeeded BEFORE we start.
 *
 * TWO-PHASE ARCHITECTURE (Epistemic -> Instrumental):
 * - Phase A (Discovery/Triage): Reduce uncertainty through observation
 * - Phase B (Execution): Take minimal actions with verification gates
 */
export interface Plan {
  goal: string; // The user's actual goal
  goalType: GoalType;
  steps: PlanStep[]; // Ordered steps to achieve goal
  successCriteria: SuccessCriteria; // How we know the whole plan succeeded
  estimatedComplexity: ComplexityLevel;
  requiresTools: boolean; // Does this need external tools?
  reasoning: string; // Why this plan
  discoveryPlan: PlanStep[];
  executionPlan: PlanStep[];
  discoveryRequired: boolean;
  assumptions: string[];

  // Explicit uncertainty tracking (Phase A)
  userIntent: string; // Explicitly modeled user intent
  uncertainties: string[]; // What we don't know
  uncertaintyThreshold: number; // Max acceptable uncertainty before execution (0.0-1.0)
  currentUncertainty: number; // Current uncertainty level

  // Pre/postconditions
  preconditions: string[]; // Must be true before execution
  postconditions: string[]; // Will be true after completion

  // Phase tracking
  triageComplete: boolean; // Has Phase A (discovery) completed?
  triageSummary?: string; // What did we learn in discovery?

  // Metadata
  createdAt: number; // Unix timestamp
  status: PlanStatus;
}

/**
 * Create a plan with defaults.
 */
export function createPlan(
  goal: string,
  goalType: GoalType,
  successCriteria: SuccessCriteria,
  opts?: Partial<Omit<Plan, 'goal' | 'goalType' | 'successCriteria'>>
): Plan {
  return {
    goal,
    goalType,
    successCriteria,
    steps: opts?.steps ?? [],
    estimatedComplexity: opts?.estimatedComplexity ?? 'standard',
    requiresTools: opts?.requiresTools ?? true,
    reasoning: opts?.reasoning ?? '',
    discoveryPlan: opts?.discoveryPlan ?? [],
    executionPlan: opts?.executionPlan ?? [],
    discoveryRequired: opts?.discoveryRequired ?? true,
    assumptions: opts?.assumptions ?? [],
    userIntent: opts?.userIntent ?? '',
    uncertainties: opts?.uncertainties ?? [],
    uncertaintyThreshold: opts?.uncertaintyThreshold ?? 0.2,
    currentUncertainty: opts?.currentUncertainty ?? 1.0,
    preconditions: opts?.preconditions ?? [],
    postconditions: opts?.postconditions ?? [],
    triageComplete: opts?.triageComplete ?? false,
    triageSummary: opts?.triageSummary,
    createdAt: opts?.createdAt ?? Date.now() / 1000, // Unix timestamp in seconds
    status: opts?.status ?? 'pending',
  };
}

/**
 * Convert plan to JSON-serializable dict.
 * Matches Python Plan.to_dict()
 */
export function planToDict(plan: Plan): Record<string, unknown> {
  return {
    goal: plan.goal,
    goal_type: plan.goalType,
    user_intent: plan.userIntent,
    steps: plan.steps.map((s) => ({
      step_num: s.stepNum,
      objective: s.objective,
      tool_hint: s.toolHint,
      status: s.status,
      phase: s.phase,
    })),
    success_criteria: plan.successCriteria.description,
    complexity: plan.estimatedComplexity,
    requires_tools: plan.requiresTools,
    discovery_required: plan.discoveryRequired,
    triage_complete: plan.triageComplete,
    assumptions: plan.assumptions,
    uncertainties: plan.uncertainties,
    uncertainty_threshold: plan.uncertaintyThreshold,
    current_uncertainty: plan.currentUncertainty,
    preconditions: plan.preconditions,
    postconditions: plan.postconditions,
  };
}

// ============================================
// EXECUTION TRACE
// ============================================

/**
 * Record of what happened during execution.
 */
export interface ExecutionTrace {
  plan: Plan;
  stepResults: StepResult[]; // Results from executor
  llmCalls: number;
  toolCalls: number;
  toolFailures: number;
  finalResponse?: string;
  totalDurationMs: number;
}

/**
 * Check if trace had any failures.
 */
export function traceHadFailures(trace: ExecutionTrace): boolean {
  return trace.toolFailures > 0;
}

/**
 * Check if all steps succeeded (SKIPPED steps are acceptable).
 */
export function traceAllStepsSucceeded(trace: ExecutionTrace): boolean {
  return trace.stepResults.every((s) =>
    ['completed', 'partial', 'skipped'].includes(s.status)
  );
}

// ============================================
// REFLECTION
// ============================================

/**
 * Post-execution evaluation with RL labels.
 */
export interface Reflection {
  planGoal: string;
  goalAchieved: boolean; // Did we actually accomplish the goal?
  confidence: number; // 0-1 confidence in assessment
  evidence: string[]; // Why we think goal was/wasn't achieved
  gaps: string[]; // What's missing
  suggestions: string[]; // What could be done differently
  shouldRetry: boolean; // Should we try again with different approach?

  // RL-specific labels
  hadToolFailures: boolean;
  reward: number;
  planQuality: number;
  executionQuality: number;
  responseQuality: number;
}

/**
 * Convert reflection to RL labels dict for logging.
 */
export function reflectionToRLLabels(
  reflection: Reflection
): Record<string, unknown> {
  return {
    goal_achieved: reflection.goalAchieved,
    reflection_confidence: reflection.confidence,
    had_tool_failures: reflection.hadToolFailures,
    reward: reflection.reward,
    plan_quality: reflection.planQuality,
    execution_quality: reflection.executionQuality,
    response_quality: reflection.responseQuality,
    gaps: reflection.gaps,
    suggested_improvements: reflection.suggestions,
  };
}
