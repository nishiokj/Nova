/**
 * Agent TypeScript Types - Barrel Export
 *
 * This module exports all types needed for the TypeScript agent implementation.
 */

// ============================================
// EVENTS
// ============================================
export type {
  WizardEventType,
  WizardEvent,
  WizardEventCallback,
  WizardEventEmitter,
  AgentType,
  GoalStartedData,
  GoalAchievedData,
  GoalAbortedData,
  StepStartedData,
  StepCompletedData,
  StepFailedData,
  StepSkippedData,
  ToolCallData,
  UserInputRequestedData,
  UserInputReceivedData,
  QualityIssueData,
  ErrorDetectedData,
  LLMCallData,
  PlanSnapshotData,
  ContextWindowUpdateData,
  ReflectionCompletedData,
  StepsScaffoldedData,
} from './events.js';

export {
  createEvent,
  eventToDict,
  SimpleEventEmitter,
} from './events.js';

// ============================================
// PLAN
// ============================================
export type {
  PlanStatus,
  PlanPhase,
  DiscoveryType,
  GoalType,
  ComplexityLevel,
  Discovery,
  SuccessCriteria,
  StepContext,
  ValidationResult,
  PlanStep,
  StepResult,
  Plan,
  ExecutionTrace,
  Reflection,
} from './plan.js';

export {
  createSuccessCriteria,
  createStepContext,
  addToolResult,
  hasRequiredData,
  createPlanStep,
  createStepResult,
  createPlan,
  planToDict,
  traceHadFailures,
  traceAllStepsSucceeded,
  reflectionToRLLabels,
} from './plan.js';

// ============================================
// TOOLS
// ============================================
export type {
  ToolStatus,
  ToolResult,
  ToolCallRecord,
  ToolDefinition,
  ToolParameterSchema,
  BashArgs,
  ReadArgs,
  WriteArgs,
  GrepArgs,
  GlobArgs,
  ToolArgs,
  ToolExecutor,
} from './tools.js';

export {
  successResult,
  errorResult,
  timeoutResult,
  createToolCallRecord,
} from './tools.js';

// ============================================
// LLM
// ============================================
export type {
  MessageRole,
  ContentBlockType,
  TextContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
  ImageContentBlock,
  ContentBlock,
  Message,
  LLMProvider,
  LLMConfig,
  StopReason,
  TokenUsage,
  ToolCall,
  LLMResponse,
  RespondParams,
  StreamParams,
  LLMAdapter,
  ConversationContext,
} from './llm.js';

export {
  textMessage,
  blocksMessage,
  getMessageText,
  getToolUseBlocks,
  createConversationContext,
  addMessage,
  estimateTokens,
} from './llm.js';

// ============================================
// SESSION
// ============================================
export type {
  SessionStatus,
  ClientType,
  Session,
  ContextWindowMetrics,
  SessionContext,
  ConversationMessage,
  ContextSnapshot,
  KnowledgeEntry,
  KnowledgeStore,
} from './session.js';

export {
  createContextWindowMetrics,
  updateContextMetrics,
  createSessionContext,
  createKnowledgeStore,
  addKnowledge,
  getKnowledge,
  clearExpiredKnowledge,
} from './session.js';

// ============================================
// WORKER
// ============================================
export type {
  OutcomeStatus,
  WorkerOutcome,
  WorkItem,
  ContextDelta,
  DiscoveryDelta,
  WorkerMetrics,
  StagnationState,
} from './worker.js';

export {
  createWorkItem,
  createContextDelta,
  createWorkerMetrics,
  updateMetricsFromLLM,
  updateMetricsFromTool,
  createStagnationState,
  simpleHash,
  updateStagnation,
  isStagnating,
  getStagnationScore,
} from './worker.js';

// ============================================
// WIZARD PLANS
// ============================================
export {
  StepStatus,
  StepPhase,
  DependencyType,
  ReflectionVerdict,
} from './plans.js';

export type {
  WizardGoalType,
  WizardStep,
  WizardPlan,
  WizardReflection,
} from './plans.js';

export {
  createWizardStep,
  createWizardPlan,
} from './plans.js';
