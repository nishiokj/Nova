/**
 * Agent - Pure execution primitive.
 *
 * Receives ContextWindow by value and mutates it locally during execution.
 * Returns AgentResult with all outputs.
 */

import path from 'node:path';
import type { LLMAdapter, Message, LLMRequestConfig, LLMResponse } from 'llm';
import {
  resilientCall,
  RateLimitError,
  CircuitOpenError,
  RetriesExhaustedError,
  TimeoutError,
  DEFAULT_RESILIENCE_CONFIG,
} from 'llm';
import type { ToolRegistry } from 'tools';
import type { ToolDefinition, ToolResult, FileContentItem, ArtifactKind, StructuredOutputSchema, MessageItem, ContextItem, ArtifactItem, LLMItem, ContentBlock } from 'types';
import { isLLMMessageItem, isLLMFunctionCallItem, isLLMFunctionCallOutputItem } from 'types';
import type { HandoffSpec } from 'protocol';
import { createEvent, errorResult, successResult } from 'types';
import { buildLLMRequestConfig, coerceStructuredOutput, extractPreJsonText, createMicroQueue, profiler, StreamingJsonExtractor, getOutputSchema, OUTPUT_SCHEMAS, unwrapStructuredOutput } from 'shared';
import { ContextWindow, buildSystemMessage } from 'context';
import type { WorkItem } from 'work';
import { createWorkItem } from 'work';
import type {
  AgentConfig,
  AgentRunParams,
  AgentResult,
  AgentMetrics,
  EventEmitCallback,
  UserPromptInfo,
  UserPromptQuestion,
  AgentHooks,
  InternalHookQueue,
  InternalHookContext,
  MutableAgentResult,
} from './types.js';
import { noopEmit, noopHookQueue } from './types.js';
import type { AgentRegistry } from './agent-registry.js';
import {
  getProviderCircuitState,
  resetProviderCircuit,
  getCircuitStatus,
} from './circuit-breaker-registry.js';
import { TOOL_LIMITS, truncateToolOutput, isRefusal } from './constants.js';

import { DEFAULT_AGENT_BUDGET } from './types.js';

/**
 * Cadence check interval: every N LLM iterations, invoke the watcher hook.
 * For a 50-iteration budget this gives 5 check-ins; for 20 iterations, 2.
 */
const CADENCE_CHECK_INTERVAL = 10;

// Re-export circuit breaker functions for backwards compatibility
export { resetProviderCircuit, getCircuitStatus };

type AgentAction = 'done' | 'continue' | 'handoff';

const QUESTION_CLEANUP_REGEX = /```[\s\S]*?```|`[^`]*`/g;

function inferUserPromptFromResponse(responseText?: string): UserPromptInfo | null {
  if (!responseText) return null;

  const cleaned = responseText.replace(QUESTION_CLEANUP_REGEX, '').trim();
  if (!cleaned.includes('?')) return null;

  const lastQuestionIndex = cleaned.lastIndexOf('?');
  if (lastQuestionIndex === -1) return null;

  const beforeQuestion = cleaned.slice(0, lastQuestionIndex);
  const boundaryIndex = Math.max(
    beforeQuestion.lastIndexOf('.'),
    beforeQuestion.lastIndexOf('!'),
    beforeQuestion.lastIndexOf('?'),
    beforeQuestion.lastIndexOf('\n')
  );

  const question = cleaned.slice(boundaryIndex + 1, lastQuestionIndex + 1).trim();
  if (question.length < 2 || !/[a-zA-Z]/.test(question)) return null;

  const context = cleaned.slice(0, boundaryIndex + 1).trim();
  return {
    question,
    context: context.length > 0 ? context : undefined,
  };
}

/**
 * Model selection override for per-agent-type model configuration.
 */
export interface ModelSelection {
  provider: string;
  model: string;
  reasoning?: string;
}

/**
 * Memory injector interface for injecting relevant memory into agent context.
 */
export interface MemoryInjector {
  inject(params: { query: string; maxTokens: number }): Promise<string | null>;
  injectRecentConversations?: (params: { limit?: number; maxTokens: number; connectors?: string }) => Promise<string | null>;
  summarizeQueryPlan?: (query: string) => string;
  explainQueryPlan?: (query: string) => { intent?: string } | undefined;
  injectV2?: (params: {
    task: {
      objective: string;
      recentMessages: string[];
      touchedFiles?: string[];
      iteration: number;
      sessionId: string;
      runId?: string;
      workItemId?: string;
    };
    budget: {
      maxTokens: number;
      maxItems?: number;
      topK?: number;
      filters?: Record<string, unknown>;
      minCoverage?: Partial<Record<string, number>>;
    };
    options?: {
      forceV1Fallback?: boolean;
      trace?: boolean;
    };
  }) => Promise<{
    content: string;
    atoms: unknown[];
    trainingSignal?: Record<string, unknown>;
    metrics: {
      totalTokens: number;
      attentionTax: number;
      coverage: Record<string, number>;
      discriminatorsIncluded: number;
      latencyMs: number;
    };
  } | null>;
}

/**
 * Pure execution agent.
 */
export class Agent {
  private config: AgentConfig;
  private llm: LLMAdapter;
  private toolRegistry: ToolRegistry;
  private emit: EventEmitCallback;
  private requestId: string;
  private agentRegistry?: AgentRegistry;
  private llmConfig: LLMRequestConfig;
  private hooks?: AgentHooks;
  private internalHookQueue: InternalHookQueue;
  private getModelSelection?: (agentType: string) => ModelSelection | null;
  private memoryInjector?: MemoryInjector;
  private sessionKey: string;
  private memoryInjectionCache = new Map<string, {
    queryKey: string;
    query: string;
    content: string | null;
    itemCount: number;
    version: 'v1' | 'v2';
    fallbackToV1?: boolean;
    latencyMs?: number;
    coverage?: Record<string, number>;
    discriminatorsIncluded?: number;
    totalTokens?: number;
    trainingSignal?: Record<string, unknown>;
  }>();

  constructor(config: AgentConfig, runtime: {
    llm: LLMAdapter;
    toolRegistry: ToolRegistry;
    emit?: EventEmitCallback;
    requestId?: string;
    sessionKey?: string;
    agentRegistry?: AgentRegistry;
    llmConfig: LLMRequestConfig;
    hooks?: AgentHooks;
    internalHookQueue?: InternalHookQueue;
    getModelSelection?: (agentType: string) => ModelSelection | null;
    memoryInjector?: MemoryInjector;
  }) {
    this.config = config;
    this.llm = runtime.llm;
    this.toolRegistry = runtime.toolRegistry;
    this.emit = runtime.emit ?? noopEmit;
    this.requestId = runtime.requestId ?? '';
    this.sessionKey = runtime.sessionKey ?? runtime.requestId ?? '';
    this.agentRegistry = runtime.agentRegistry;
    this.llmConfig = runtime.llmConfig;
    this.hooks = runtime.hooks;
    this.internalHookQueue = runtime.internalHookQueue ?? noopHookQueue;
    this.getModelSelection = runtime.getModelSelection;
    this.memoryInjector = runtime.memoryInjector;
  }

  /**
   * Build internal hook context from current state.
   */
  private buildHookContext(workItem: WorkItem): InternalHookContext {
    return {
      workId: workItem.workId,
      agentType: this.config.type,
      sessionKey: this.sessionKey,
      requestId: this.requestId,
      objective: workItem.objective,
    };
  }

  private normalizeMemoryQueryKey(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  private getMemoryCacheKey(workItem: WorkItem): string {
    return workItem.workId || this.sessionKey || 'default';
  }

  /**
   * Finalize iteration by capturing filesRead and emitting turn completed.
   */
  private finalizeIteration(
    localReadFiles: Set<string>,
    workItem: WorkItem,
    result: MutableAgentResult,
    metrics: AgentMetrics,
    iteration: number,
    hasResponse: boolean
  ): void {
    result.filesRead = Array.from(localReadFiles);
    this.internalHookQueue.enqueue({
      type: 'turn_completed',
      iteration,
      toolCallsMade: metrics.toolCallsMade,
      llmCallsMade: metrics.llmCallsMade,
      hasResponse,
      terminationReason: result.terminationReason || undefined,
    }, this.buildHookContext(workItem));
  }

  /**
   * Check if agent has hit tool call or duration bounds.
   * Emits agent_bounds_hit event if a bound is hit.
   * @returns termination reason if bound hit, null otherwise
   */
  private checkBounds(
    metrics: AgentMetrics,
    workItem: WorkItem,
    elapsedMs: number
  ): 'max_tool_calls_exceeded' | 'max_duration_exceeded' | null {
    if (metrics.toolCallsMade >= workItem.bounds.maxToolCalls) {
      this.emit(createEvent('agent_bounds_hit', {
        agentType: this.config.type,
        boundType: 'tool_calls',
        current: metrics.toolCallsMade,
        max: workItem.bounds.maxToolCalls,
      }, workItem.workId));
      return 'max_tool_calls_exceeded';
    }

    if (elapsedMs >= workItem.bounds.maxDurationMs) {
      this.emit(createEvent('agent_bounds_hit', {
        agentType: this.config.type,
        boundType: 'duration',
        current: elapsedMs,
        max: workItem.bounds.maxDurationMs,
      }, workItem.workId));
      return 'max_duration_exceeded';
    }

    return null;
  }

  /**
   * Compact context if near full and rebuild localReadFiles tracking.
   * Handles both LLM-assisted compaction and fallback basic compaction.
   */
  private async compactIfNeeded(
    localContext: ContextWindow,
    localReadFiles: Set<string>,
    workItem: WorkItem
  ): Promise<void> {
    if (!localContext.isNearFull(0.5)) return;

    localContext.compact({
      deduplicateByPath: true,
      truncateOutputsTo: 4000,
    });

    // Rebuild localReadFiles from compacted context
    localReadFiles.clear();
    for (const path of localContext.getReadFilesArray()) {
      localReadFiles.add(path);
    }

    this.internalHookQueue.enqueue({
      type: 'context_threshold',
      usagePercent: localContext.metrics.percentageUsed,
      tokenCount: localContext.metrics.inputTokens + localContext.metrics.outputTokens,
      itemCount: localContext.items.length,
    }, this.buildHookContext(workItem));
  }

  /**
   * Build the LLM request parameters for an iteration.
   * Consolidates system prompt, tools, messages, and last-iteration handling.
   */
  private async buildIterationRequest(
    workItem: WorkItem,
    globalContext: ContextWindow,
    localContext: ContextWindow,
    cwd: string,
    iteration: number,
    maxIterations: number
  ): Promise<{
    messages: Array<Record<string, unknown>>;
    tools: ToolDefinition[] | undefined;
    toolChoice: 'none' | 'auto' | undefined;
  }> {
    const { system, taskContext } = this.buildSystemPromptComponents(workItem, cwd);

    const allTools = [
      ...this.toolRegistry.getDefinitions(),
      ...(this.agentRegistry?.listToolDefinitions() ?? []),
    ];
    const allowedTools = this.filterAllowedTools(allTools);

    const isLastIteration = iteration === maxIterations - 1;
    const lastIterationInstruction = isLastIteration
      ? '\n\nIMPORTANT: This is your final iteration. You must NOT make any tool calls. Synthesize your response and provide a comprehensive answer using the information you have gathered. Use action: "done" when finished.'
      : '';

    // Memory injection (recent + v1/v2)
    let recentConversationContent: string | null = null;
    if (this.memoryInjector?.injectRecentConversations && iteration === 0) {
      try {
        recentConversationContent = await this.memoryInjector.injectRecentConversations({
          limit: 10,
          maxTokens: 600,
        });
      } catch {
        recentConversationContent = null;
      }
    }

    let memoryContent: string | null = null;
    if (this.memoryInjector) {
      try {
        const query = this.buildMemoryQuery(workItem, globalContext);
        const querySummary = this.memoryInjector.summarizeQueryPlan?.(query);
        const plan = this.memoryInjector.explainQueryPlan?.(query);
        const intent = plan?.intent ?? 'unknown';
        const isConceptIntent = intent === 'decision'
          || intent === 'preference'
          || intent === 'principle'
          || intent === 'tradeoff';
        const isRecallIntent = intent === 'recall';
        const eventQuery = querySummary || query;
        const queryKey = this.normalizeMemoryQueryKey(eventQuery);
        const cacheKey = this.getMemoryCacheKey(workItem);
        const recentMessageItems = globalContext.getItemsByType('message') as MessageItem[];
        const shouldUseV2 = !!this.memoryInjector.injectV2
          && !isConceptIntent
          && !isRecallIntent
          && this.shouldUseMemoryV2(this.sessionKey, workItem.workId);
        const cached = this.memoryInjectionCache.get(cacheKey);
        const canReuseCached = cached && cached.queryKey === queryKey && (
          cached.version === (shouldUseV2 ? 'v2' : 'v1')
          || (shouldUseV2 && cached.fallbackToV1 && cached.version === 'v1')
        );

        let v2Result: {
          content: string;
          atoms: unknown[];
          trainingSignal?: Record<string, unknown>;
          metrics: {
            totalTokens: number;
            attentionTax: number;
            coverage: Record<string, number>;
            discriminatorsIncluded: number;
            latencyMs: number;
          };
        } | null = null;
        let fallbackToV1 = false;

        if (canReuseCached) {
          memoryContent = cached.content;
          const contextWithMemory = memoryContent ? `${taskContext}\n\n${memoryContent}` : undefined;
          this.internalHookQueue.enqueue({
            type: 'memory_injected',
            query: eventQuery,
            resultPreview: memoryContent ? memoryContent.slice(0, 500) : undefined,
            memoryContent: memoryContent ?? undefined,
            contextWithMemory,
            itemCount: cached.itemCount,
            success: memoryContent !== null,
            iteration,
            version: cached.version,
            latencyMs: cached.latencyMs,
            coverage: cached.coverage,
            discriminatorsIncluded: cached.discriminatorsIncluded,
            totalTokens: cached.totalTokens,
            fallbackToV1: cached.fallbackToV1,
            trainingSignal: cached.trainingSignal,
          }, this.buildHookContext(workItem));
          this.emit(createEvent('memory_injected', {
            query: eventQuery,
            resultPreview: memoryContent ? memoryContent.slice(0, 500) : undefined,
            memoryContent: memoryContent ?? undefined,
            contextWithMemory,
            itemCount: cached.itemCount,
            success: memoryContent !== null,
            iteration,
            version: cached.version,
            latencyMs: cached.latencyMs,
            coverage: cached.coverage,
            discriminatorsIncluded: cached.discriminatorsIncluded,
            totalTokens: cached.totalTokens,
            fallbackToV1: cached.fallbackToV1,
            trainingSignal: cached.trainingSignal,
          }, workItem.workId));
        } else if (shouldUseV2 && this.memoryInjector.injectV2) {
          const recentMessages = recentMessageItems
            .filter(item => item.role === 'user')
            .map(item => {
              if (typeof item.content === 'string') return item.content;
              if (Array.isArray(item.content)) {
                return item.content
                  .map(block => (block.type === 'text' ? block.text : ''))
                  .join(' ');
              }
              return '';
            })
            .filter(text => text && text.trim().length > 0)
            .slice(-3);

          const touchedFiles = globalContext.getReadFilesArray().map((filePath) => {
            if (path.isAbsolute(filePath)) {
              return path.relative(cwd, filePath);
            }
            return filePath;
          });

          v2Result = await this.memoryInjector.injectV2({
            task: {
              objective: workItem.objective,
              recentMessages,
              touchedFiles,
              iteration,
              sessionId: this.sessionKey,
              runId: this.requestId || undefined,
              workItemId: workItem.workId,
            },
            budget: {
              maxTokens: 1000,
              maxItems: 3,
              topK: 12,
              filters: {
                intent,
                mode: 'memory_injection_v2',
              },
              minCoverage: {},
            },
          });
        }

        if (v2Result?.content) {
          memoryContent = v2Result.content;
          const contextWithMemory = memoryContent ? `${taskContext}\n\n${memoryContent}` : undefined;
          this.memoryInjectionCache.set(cacheKey, {
            queryKey,
            query,
            content: memoryContent,
            itemCount: v2Result.atoms?.length ?? 0,
            version: 'v2',
            fallbackToV1: false,
            latencyMs: v2Result.metrics?.latencyMs,
            coverage: v2Result.metrics?.coverage,
            discriminatorsIncluded: v2Result.metrics?.discriminatorsIncluded,
            totalTokens: v2Result.metrics?.totalTokens,
            trainingSignal: v2Result.trainingSignal,
          });
          this.internalHookQueue.enqueue({
            type: 'memory_injected',
            query: eventQuery,
            resultPreview: memoryContent.slice(0, 500),
            memoryContent,
            contextWithMemory,
            itemCount: v2Result.atoms?.length ?? 0,
            success: true,
            iteration,
            version: 'v2',
            latencyMs: v2Result.metrics?.latencyMs,
            coverage: v2Result.metrics?.coverage,
            discriminatorsIncluded: v2Result.metrics?.discriminatorsIncluded,
            totalTokens: v2Result.metrics?.totalTokens,
            fallbackToV1: false,
            trainingSignal: v2Result.trainingSignal,
          }, this.buildHookContext(workItem));
          this.emit(createEvent('memory_injected', {
            query: eventQuery,
            resultPreview: memoryContent.slice(0, 500),
            memoryContent,
            contextWithMemory,
            itemCount: v2Result.atoms?.length ?? 0,
            success: true,
            iteration,
            version: 'v2',
            latencyMs: v2Result.metrics?.latencyMs,
            coverage: v2Result.metrics?.coverage,
            discriminatorsIncluded: v2Result.metrics?.discriminatorsIncluded,
            totalTokens: v2Result.metrics?.totalTokens,
            fallbackToV1: false,
            trainingSignal: v2Result.trainingSignal,
          }, workItem.workId));
        } else {
          fallbackToV1 = shouldUseV2;
          memoryContent = await this.memoryInjector.inject({ query, maxTokens: 1000 });
          const contextWithMemory = memoryContent ? `${taskContext}\n\n${memoryContent}` : undefined;
          const itemCount = memoryContent ? memoryContent.split('\n\n').filter(line => line.trim().length > 0).length : 0;
          this.memoryInjectionCache.set(cacheKey, {
            queryKey,
            query,
            content: memoryContent,
            itemCount,
            version: 'v1',
            fallbackToV1,
          });
          this.internalHookQueue.enqueue({
            type: 'memory_injected',
            query: eventQuery,
            resultPreview: memoryContent ? memoryContent.slice(0, 500) : undefined,
            memoryContent: memoryContent ?? undefined,
            contextWithMemory,
            itemCount,
            success: memoryContent !== null,
            iteration,
            version: 'v1',
            fallbackToV1,
          }, this.buildHookContext(workItem));
          this.emit(createEvent('memory_injected', {
            query: eventQuery,
            resultPreview: memoryContent ? memoryContent.slice(0, 500) : undefined,
            memoryContent: memoryContent ?? undefined,
            contextWithMemory,
            itemCount,
            success: memoryContent !== null,
            iteration,
            version: 'v1',
            fallbackToV1,
          }, workItem.workId));
        }
      } catch {
        // Silent fallback - continue without memory
        // Fire memory_injected hook even on failure for observability
        this.internalHookQueue.enqueue({
          type: 'memory_injected',
          query: this.memoryInjector.summarizeQueryPlan?.(this.buildMemoryQuery(workItem, globalContext))
            || this.buildMemoryQuery(workItem, globalContext),
          resultPreview: undefined,
          itemCount: 0,
          success: false,
          iteration,
          version: 'v1',
        }, this.buildHookContext(workItem));
        this.emit(createEvent('memory_injected', {
          query: this.memoryInjector.summarizeQueryPlan?.(this.buildMemoryQuery(workItem, globalContext))
            || this.buildMemoryQuery(workItem, globalContext),
          resultPreview: undefined,
          itemCount: 0,
          success: false,
          iteration,
          version: 'v1',
        }, workItem.workId));
      }
    }

    // Combine task context with memory injection
    const combinedMemoryContent = [recentConversationContent, memoryContent]
      .filter((section): section is string => typeof section === 'string' && section.trim().length > 0)
      .join('\n\n');
    const contextWithMemory = combinedMemoryContent
      ? `${taskContext}\n\n${combinedMemoryContent}`
      : taskContext;

    const messages = this.buildMessages(
      system,
      contextWithMemory + lastIterationInstruction,
      workItem,
      globalContext,
      localContext
    );

    const tools = allowedTools.length > 0 ? allowedTools : undefined;
    const toolChoice = isLastIteration && tools ? 'none' as const : undefined;

    return { messages, tools, toolChoice };
  }

  /**
   * Handle handoff action from structured output.
   * @returns 'return' if should exit loop, 'continue' if should continue to next iteration, null if not a handoff
   */
  private handleHandoff(
    structuredOutput: Record<string, unknown> | null,
    result: MutableAgentResult
  ): 'return' | 'continue' | null {
    const handoffSpec = structuredOutput?.handoffSpec;
    if (handoffSpec && this.isHandoffSpecCandidate(handoffSpec)) {
      result.needsHandoff = true;
      result.handoffSpec = handoffSpec;
      result.terminationReason = 'handoff_requested';
      return 'return';
    }

    // No valid handoffSpec provided, continue execution
    return 'continue';
  }

  /**
   * Resolve the action from structured output into a loop control directive.
   * Sets result fields as side effects (terminationReason, success, response, etc.)
   * @returns loop control: 'done' | 'handoff' | 'user_input' | 'continue' | 'no_action'
   */
  private resolveAction(
    action: AgentAction | null,
    structuredOutput: Record<string, unknown> | null,
    responseText: string | undefined,
    content: string,
    result: MutableAgentResult
  ): 'done' | 'handoff' | 'user_input' | 'continue' | 'no_action' {
    const avoidRawStructured = !!this.config.outputSchema;
    const contentFallback = avoidRawStructured && (structuredOutput || coerceStructuredOutput(content))
      ? ''
      : content;
    const structuredFallback = this.extractStructuredFallbackResponse(structuredOutput);

    // Check awaitingUserInput first (fallback for conversational questions)
    if (!result.needsUserInput && structuredOutput?.awaitingUserInput === true) {
      result.needsUserInput = true;
      result.userPrompt = {
        question: responseText || contentFallback || structuredFallback || 'Waiting for your response...',
      };
      result.terminationReason = 'user_input_required';
      return 'user_input';
    }

    // If PromptUser already set needsUserInput, honor it
    if (result.needsUserInput) {
      return 'user_input';
    }

    const shouldInferUserPrompt = action !== 'done' || structuredOutput?.goalStateReached !== true;
    if (shouldInferUserPrompt) {
      const responseCandidate = (responseText ?? contentFallback ?? structuredFallback ?? '').trim();
      const inferredPrompt = inferUserPromptFromResponse(responseCandidate);
      if (inferredPrompt) {
        result.needsUserInput = true;
        result.userPrompt = inferredPrompt;
        result.terminationReason = 'user_input_required';
        if (responseCandidate.trim()) {
          result.response = responseCandidate;
        }
        return 'user_input';
      }
    }

    // Handle done action
    if (action === 'done') {
      const goalReached = structuredOutput?.goalStateReached === true;
      if (!goalReached) {
        result.terminationReason = 'invalid_action';
        result.error = 'Action "done" requires goalStateReached: true.';
        return 'done';
      }

      const finalText = (responseText ?? contentFallback ?? '').trim()
        ? (responseText ?? contentFallback ?? '')
        : (structuredFallback ?? '');
      if (isRefusal(finalText)) {
        result.isRefusal = true;
        result.error = 'LLM refused to complete the task';
        result.terminationReason = 'refusal';
      } else {
        result.success = true;
        result.response = finalText;
        result.terminationReason = 'goal_state_reached';
      }
      return 'done';
    }

    // Handle handoff action
    if (action === 'handoff') {
      return 'handoff';
    }

    // Handle continue action
    if (action === 'continue') {
      const continueText = responseText?.trim() ? responseText : structuredFallback;
      if (continueText?.trim()) {
        result.response = continueText;
      }
      return 'continue';
    }

    // No recognized action
    return 'no_action';
  }

  /**
   * Extract and validate artifacts from structured output, adding them to context.
   * Returns the number of artifacts added.
   */
  private extractArtifactsFromOutput(
    structuredOutput: Record<string, unknown> | null,
    localContext: ContextWindow,
    workItemId?: string
  ): number {
    if (!structuredOutput?.artifacts || !Array.isArray(structuredOutput.artifacts)) {
      return 0;
    }

    const validArtifacts = (structuredOutput.artifacts as unknown[]).filter((a): a is {
      sourcePath: string;
      line?: number | null;
      kind: string;
      name: string;
      signature?: string | null;
      modifies?: string[] | null;
      calls?: string[] | null;
      insight?: string | null;
      reduces?: string | null;
    } => (
      typeof a === 'object' &&
      a !== null &&
      typeof (a as Record<string, unknown>).sourcePath === 'string' &&
      typeof (a as Record<string, unknown>).kind === 'string' &&
      typeof (a as Record<string, unknown>).name === 'string'
    ));

    for (const a of validArtifacts) {
      localContext.addArtifact({
        sourcePath: a.sourcePath,
        line: typeof a.line === 'number' ? a.line : undefined,
        kind: a.kind as ArtifactKind,
        name: a.name,
        signature: typeof a.signature === 'string' ? a.signature : undefined,
        modifies: Array.isArray(a.modifies) ? a.modifies : undefined,
        calls: Array.isArray(a.calls) ? a.calls : undefined,
        insight: typeof a.insight === 'string' ? a.insight : undefined,
        reduces: typeof a.reduces === 'string' ? a.reduces as 'structural' | 'relational' | 'behavioral' | 'contractual' : undefined,
        relevance: 1.0,
        discoveredBy: this.config.type,
        workItemId,
      }, workItemId);
    }

    return validArtifacts.length;
  }

  /**
   * Parse LLM response content into structured components.
   * Returns action, response text, and structured output for downstream handling.
   */
  private parseIterationResponse(
    content: string,
    result: MutableAgentResult
  ): {
    structuredOutput: Record<string, unknown> | null;
    action: AgentAction | null;
    responseText: string | undefined;
  } {
    const structuredOutput = this.parseStructuredOutput(content, result);
    if (structuredOutput) {
      result.structuredOutput = structuredOutput;
    }

    const action = this.extractStructuredAction(structuredOutput);
    const parsedResponseText = this.extractStructuredResponse(structuredOutput);
    const preJsonText = extractPreJsonText(content);
    const responseText = this.combineResponseText(preJsonText, parsedResponseText);

    return { structuredOutput, action, responseText };
  }

  /**
   * Extract a user-facing text fallback from structured output when `response`
   * is missing/empty, so harness persistence does not collapse to empty replies.
   */
  private extractStructuredFallbackResponse(
    structuredOutput: Record<string, unknown> | null
  ): string | undefined {
    if (!structuredOutput || typeof structuredOutput !== 'object' || Array.isArray(structuredOutput)) {
      return undefined;
    }
    const read = (value: unknown): string | undefined => {
      if (typeof value !== 'string') return undefined;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };
    const answer = structuredOutput.answer;
    const realign = structuredOutput.realign;
    return (
      read(structuredOutput.work_done)
      ?? read((answer && typeof answer === 'object' && !Array.isArray(answer))
        ? (answer as Record<string, unknown>).text
        : undefined)
      ?? read((realign && typeof realign === 'object' && !Array.isArray(realign))
        ? (realign as Record<string, unknown>).systemMessage
        : undefined)
      ?? read(structuredOutput.summary)
    );
  }

  /**
   * Emit fallback response for TUI when streaming didn't capture content.
   * Only used when structured output was expected but streaming captured nothing.
   */
  private emitFallbackResponse(
    content: string,
    streamedContent: string,
    structuredOutput: Record<string, unknown> | null,
    responseText: string | undefined,
    workItemId: string
  ): void {
    // If we already streamed the response field, don't re-emit
    if (streamedContent.length > 0) return;

    const fallbackResponse = responseText?.trim() || this.extractStructuredFallbackResponse(structuredOutput);
    if (fallbackResponse?.trim()) {
      this.emit(createEvent('agent_message', {
        agentType: this.config.type,
        message: fallbackResponse,
      }, workItemId));
      return;
    }

    // Avoid leaking structured JSON to the TUI. Only emit raw content if no JSON object is present.
    if (!content || content.trim().length === 0) return;
    if (structuredOutput || coerceStructuredOutput(content)) return;

    this.emit(createEvent('agent_message', {
      agentType: this.config.type,
      message: content,
    }, workItemId));
  }

  /**
   * Stream LLM response with resilience (retry + circuit breaker).
   * Returns { response, buffer } on success, throws on unrecoverable error.
   */
  private async streamWithResilience(
    params: {
      messages: Message[];
      tools?: ToolDefinition[];
      toolChoice?: 'none' | 'auto' | 'required';
      responseSchema?: StructuredOutputSchema;
      onChunk?: (chunk: string) => void;
      onReasoningChunk?: (chunk: string) => void;
    },
    workItemId?: string
  ): Promise<{ response: LLMResponse; buffer: string }> {
    const provider = this.llmConfig.provider ?? 'unknown';
    const circuitState = getProviderCircuitState(provider);
    const circuitKey = `${provider}:${this.llmConfig.model ?? 'unknown'}`;

    // Wrap the streaming operation in resilientCall with timeout
    // Note: We wrap the entire stream consumption, not just the initial call
    return resilientCall(
      async () => {
        const stream = this.llm.stream({
          messages: params.messages,
          tools: params.tools,
          toolChoice: params.toolChoice,
          llm: this.llmConfig,
          responseSchema: params.responseSchema,
          onChunk: params.onChunk,
          onReasoningChunk: params.onReasoningChunk,
        });

        let buffer = '';
        let response: LLMResponse | undefined;

        while (true) {
          const { value, done } = await stream.next();
          if (done) {
            response = value;
            break;
          }
          if (value) {
            buffer += value;
          }
        }

        if (!response) {
          throw new Error('LLM stream completed without a final response');
        }

        // If content is empty but we have buffered data, use the buffer
        if (!response.content || response.content.length === 0) {
          response = { ...response, content: buffer };
        }

        return { response, buffer };
      },
      {
        circuitState,
        circuitKey,
        timeoutMs: this.config.budget.llmStreamTimeoutMs ?? DEFAULT_AGENT_BUDGET.llmStreamTimeoutMs!,
        operationName: `LLM stream (${this.config.type})`,
        config: {
          ...DEFAULT_RESILIENCE_CONFIG,
          maxRetries: 2, // Retry up to 2 times for transient errors
        },
        onRetry: (attempt, error, delayMs) => {
          console.error(`[AGENT] Retrying LLM call (attempt ${attempt}): ${error.message}, waiting ${delayMs}ms`);
        },
      }
    );
  }

  /**
   * Execute the agent on a work item.
   * Agent reads from globalContext, writes to its own localContext.
   * GlobalContext is never mutated.
   */
  async run(params: AgentRunParams): Promise<AgentResult> {
    const { globalContext, workItem, cwd, signal } = params;
    const runAsyncId = profiler.asyncBegin(`agent.run:${this.config.type}`, 'agent');

    // Create fresh local context for this agent's work
    const localContext = new ContextWindow(
      `${globalContext.sessionKey}:${this.config.type}:${workItem.workId}`,
      globalContext.maxTokens
    );

    const startTime = Date.now();

    const metrics: AgentMetrics = {
      llmCallsMade: 0,
      toolCallsMade: 0,
      toolCallsSucceeded: 0,
      toolCallsFailed: 0,
      durationMs: 0,
    };

    const result: MutableAgentResult = {
      success: false,
      response: '',
      metrics,
      filesRead: [],
      invalidatedPaths: [],
      toolErrors: [],
      terminationReason: undefined,
      needsUserInput: false,
      isRefusal: false,
      localContext,
    };

    try {
      await this.executeLoop(globalContext, localContext, workItem, result, metrics, startTime, cwd, signal);
    } catch (error) {
      // Capture error message - ensure we always have SOME diagnostic info
      let message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      if (!message || message.trim().length === 0) {
        // Error has no message - capture what we can
        const errorType = error instanceof Error ? error.constructor.name : typeof error;
        const stackPreview = stack?.split('\n').slice(0, 3).join('\n');
        message = `[Empty error message] type=${errorType}${stackPreview ? `, stack:\n${stackPreview}` : ''}`;
      }

      // Classify the error and set appropriate termination reason
      if (error instanceof RateLimitError) {
        result.terminationReason = 'rate_limit';
        result.error = message;
        result.rateLimitInfo = {
          provider: error.provider,
          model: error.model,
          type: error.info.type,
          retryAfterMs: error.info.retryAfterMs,
          message: error.info.message,
        };
        console.error(`[AGENT] Rate limit hit for ${error.provider}/${error.model}: ${error.info.message}`);
      } else if (error instanceof CircuitOpenError) {
        result.terminationReason = 'circuit_open';
        result.error = message;
        console.error(`[AGENT] Circuit breaker open: ${message}`);
      } else if (error instanceof TimeoutError) {
        result.terminationReason = 'timeout';
        result.error = `LLM call timed out after ${error.timeoutMs}ms`;
        console.error(`[AGENT] LLM timeout for ${this.config.type}: ${error.timeoutMs}ms`);
      } else if (error instanceof RetriesExhaustedError) {
        // Check if underlying cause was a timeout
        const cause = error.cause;
        if (cause instanceof TimeoutError) {
          result.terminationReason = 'timeout';
          result.error = `LLM call timed out after ${cause.timeoutMs}ms (retries exhausted)`;
          console.error(`[AGENT] LLM timeout after ${error.attempts} retries: ${cause.timeoutMs}ms`);
        } else {
          result.terminationReason = 'agent_error';
          result.error = `Retries exhausted after ${error.attempts} attempts: ${message}`;
          console.error(`[AGENT] All retries exhausted after ${error.attempts} attempts: ${message}`);
        }
      } else {
        result.terminationReason = 'agent_error';
        // Include stack trace in error message for debugging (truncated to first 5 lines)
        const stackPreview = stack?.split('\n').slice(0, 5).join('\n');
        result.error = stackPreview ? `${message}\n\nStack:\n${stackPreview}` : message;
        // Log full stack to console for detailed debugging
        console.error(`[AGENT] Exception in ${this.config.type}: ${message}`, stack ?? '');
      }

      this.emitLlmError(error instanceof Error ? error : new Error(message), workItem.workId);

      // Synthesize response from accumulated work if we have any
      // This preserves partial progress when rate limits or other errors interrupt execution
      const accumulatedResponse = this.synthesizePartialResponse(localContext, result.response);
      if (accumulatedResponse) {
        result.response = `${accumulatedResponse}\n\n[Execution interrupted: ${message}]`;
      }
    }

    metrics.durationMs = Date.now() - startTime;

    // Bundle artifacts explicitly in result for clear contract
    result.artifacts = localContext.getArtifacts();

    // HARD VALIDATION: Explorer agents MUST produce artifacts when reading files
    // Reading files without extracting artifacts is unacceptable - it wastes context
    // and provides zero value to downstream agents.
    if (this.config.type === 'explorer' && result.filesRead.length > 0 && result.artifacts!.length === 0) {
      result.success = false;
      result.terminationReason = 'invalid_action';
      result.error = `Explorer read ${result.filesRead.length} files but extracted 0 artifacts. ` +
        `This is a hard failure. Every file read MUST produce artifacts. ` +
        `Files read: ${result.filesRead.slice(0, 5).join(', ')}${result.filesRead.length > 5 ? '...' : ''}`;
      console.error(`[AGENT:explorer] VALIDATION FAILURE: ${result.filesRead.length} files read, 0 artifacts produced`);
    }

    // HARD VALIDATION: Detect and reject planning-speak responses
    // Responses that are just "I'll...", "Let me...", "Now I will..." are not actual work
    if (result.success && result.response) {
      const planningPatterns = [
        /^I('ll| will) (analyze|explore|investigate|look|start|begin|check|examine)/i,
        /^Let me (start|begin|first|analyze|explore|look|check)/i,
        /^Now (let me|I('ll| will))/i,
        /^First,? (I('ll| will)|let me)/i,
      ];
      const responseStart = result.response.trim().slice(0, 200);
      const isPlanningSpeak = planningPatterns.some(p => p.test(responseStart));

      // If the entire response is planning speak with no substantive content, fail
      if (isPlanningSpeak && result.response.length < 500 && !result.response.includes('```')) {
        result.success = false;
        result.terminationReason = 'no_action';
        result.error = `Response is planning text, not actual work: "${responseStart.slice(0, 100)}..."`;
        console.error(`[AGENT:${this.config.type}] VALIDATION FAILURE: Response is planning-speak, not actual output`);
      }
    }

    if (result.invalidatedPaths.length > 0) {
      this.internalHookQueue.enqueue({
        type: 'files_modified',
        paths: result.invalidatedPaths,
      }, this.buildHookContext(workItem));
    }

    this.internalHookQueue.enqueue({
      type: 'agent_completed',
      workId: workItem.workId,
      success: result.success,
      terminationReason: result.terminationReason ?? 'agent_error',
      filesRead: result.filesRead,
      invalidatedPaths: result.invalidatedPaths,
      // Include response and metrics for workitem log tracking
      response: result.response,
      metrics: {
        toolCallsMade: metrics.toolCallsMade,
        llmCallsMade: metrics.llmCallsMade,
      },
      contextPercentUsed: result.localContext.metrics.percentageUsed,
    }, this.buildHookContext(workItem));

    profiler.asyncEnd(`agent.run:${this.config.type}`, runAsyncId, 'agent', {
      success: result.success,
      terminationReason: result.terminationReason,
      llmCalls: metrics.llmCallsMade,
      toolCalls: metrics.toolCallsMade,
    });

    return this.finalizeResult(result);
  }

  /**
   * Main execution loop.
   */
  private async executeLoop(
    globalContext: ContextWindow,
    localContext: ContextWindow,
    workItem: WorkItem,
    result: MutableAgentResult,
    metrics: AgentMetrics,
    startTime: number,
    cwd: string,
    signal?: AbortSignal
  ): Promise<void> {
    const maxIterations = Math.min(
      this.config.budget.maxIterations,
      workItem.bounds.maxLlmCalls
    );

    const localReadFiles = new Set(globalContext.getReadFilesArray());
    const toolRepeatState = {
      lastKey: '',
      lastOutput: '',
      repeats: 0,
    };

    // Auto-read target files
    if (workItem.targetPaths && workItem.targetPaths.length > 0) {
      await this.autoReadTargetFiles(workItem.targetPaths, localContext, localReadFiles, metrics, cwd, workItem.workId);
    }

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      profiler.instant(`agent.iteration:${iteration}`, 'agent', 'p', { agentType: this.config.type });

      if (signal?.aborted) {
        throw new Error('aborted');
      }

      // Check for user stop request at the start of each iteration
      if (this.hooks?.shouldStop?.()) {
        result.terminationReason = 'user_stopped';
        break;
      }

      // Cadence check: watcher intervention point (every N LLM calls)
      if (this.hooks?.cadenceCheck && iteration > 0 && iteration % CADENCE_CHECK_INTERVAL === 0) {
        const cadenceResult = await this.hooks.cadenceCheck({
          llmCallsMade: metrics.llmCallsMade,
          toolCallsMade: metrics.toolCallsMade,
          durationMs: Date.now() - startTime,
        });
        if (cadenceResult.action === 'inject' && cadenceResult.systemMessage) {
          localContext.addMessage('system', cadenceResult.systemMessage, workItem.workId);
        } else if (cadenceResult.action === 'stop') {
          if (cadenceResult.systemMessage) {
            localContext.addMessage('system', cadenceResult.systemMessage, workItem.workId);
          }
          const stopReason = cadenceResult.reason ?? cadenceResult.systemMessage ?? 'Watcher requested stop.';
          result.watcherStop = {
            reason: stopReason,
            escalationId: cadenceResult.escalationId,
          };
          result.terminationReason = cadenceResult.terminationReason ?? 'watcher_stopped';
          break;
        }
      }

      // 1. Pre-checks: bounds and context management
      const elapsedMs = Date.now() - startTime;
      const boundHit = this.checkBounds(metrics, workItem, elapsedMs);
      if (boundHit) {
        result.terminationReason = boundHit;
        break;
      }

      await this.compactIfNeeded(localContext, localReadFiles, workItem);

      // 2. Build LLM request (async for memory injection)
      const { messages, tools: toolsForThisCall, toolChoice: toolChoiceForThisCall } = await this.buildIterationRequest(
        workItem,
        globalContext,
        localContext,
        cwd,
        iteration,
        maxIterations
      );


      const llmStartTime = Date.now();
      const hasStructuredOutput = !!this.config.outputSchema;

      // For structured output, use extractor to stream the response field in real-time
      const jsonExtractor = hasStructuredOutput ? new StreamingJsonExtractor() : null;
      // Track what content was streamed to TUI (to avoid re-emitting in result.response)
      let streamedResponseContent = '';
      // Track streamed reasoning content (some providers only stream reasoning)
      let streamedReasoningContent = '';

      // Use resilient streaming with retry + circuit breaker
      const llmAsyncId = profiler.asyncBegin(`agent.llmCall:${this.config.type}`, 'llm');
      const { response, buffer } = await this.streamWithResilience(
        {
          messages: messages as unknown as Message[],
          tools: toolsForThisCall,
          toolChoice: toolChoiceForThisCall,
          responseSchema: this.config.outputSchema,
          onChunk: (chunk) => {
            if (jsonExtractor) {
              // Extract and stream the response field from structured JSON
              const newContent = jsonExtractor.addChunk(chunk);
              if (newContent) {
                streamedResponseContent += newContent;
                this.emit(createEvent('agent_message', {
                  agentType: this.config.type,
                  message: newContent,
                }, workItem.workId));
              }
            } else {
              // Non-structured output: stream directly
              this.emit(createEvent('agent_message', {
                agentType: this.config.type,
                message: chunk,
              }, workItem.workId));
            }
          },
          onReasoningChunk: (chunk) => {
            if (chunk) {
              streamedReasoningContent += chunk;
            }
          },

        },
        workItem.workId
      );

      const llmDurationMs = Date.now() - llmStartTime;
      profiler.asyncEnd(`agent.llmCall:${this.config.type}`, llmAsyncId, 'llm', {
        promptTokens: response.usage?.promptTokens,
        completionTokens: response.usage?.completionTokens,
        toolCalls: response.toolCalls?.length ?? 0,
      });
      metrics.llmCallsMade++;

      this.emitLlmCall(response, messages, llmDurationMs, toolsForThisCall ?? [], localContext.maxTokens, workItem.workId);

      // Update local context metrics with actual token usage from LLM
      if (response.usage) {
        localContext.updateMetrics(
          response.usage.promptTokens ?? 0,
          response.usage.completionTokens ?? 0,
          response.usage.cachedTokens
        );
      }

      const content = (response.content ?? '') as string;
      const toolCalls = response.toolCalls ?? [];

      const reasoningContent = response.reasoningContent || (streamedReasoningContent ? streamedReasoningContent : undefined);

      // Add reasoning content to context for multi-turn salience
      if (reasoningContent) {
        localContext.addReasoning(reasoningContent, workItem.workId);
        this.emit(createEvent('agent_reasoning', {
          agentType: this.config.type,
          content: reasoningContent,
          isFinal: true,
        }, workItem.workId));
      }

      // 3. Parse response content
      const { structuredOutput, action, responseText: rawResponseText } = this.parseIterationResponse(content, result);
      this.extractArtifactsFromOutput(structuredOutput, localContext, workItem.workId);
      this.addAssistantMessage(localContext, content, toolCalls, workItem.workId);

      // Fire agent_message hook for workitem logging (captures actual content + reasoning)
      // Always emit per turn (even if content is empty) to keep async logs in sync.
      this.internalHookQueue.enqueue({
        type: 'agent_message',
        role: 'assistant',
        content,  // Full content - no truncation for proper audit trail
        reasoning: reasoningContent,  // Include reasoning for decision audit
        iteration,
      }, this.buildHookContext(workItem));

      // If we streamed the response field, don't include it again in result.response
      // Only use pre-JSON text (if any) to avoid duplicate TUI output
      const preJsonText = extractPreJsonText(content);
      const responseText = streamedResponseContent.length > 0
        ? (preJsonText?.trim() || undefined)  // Only pre-JSON text, response was already streamed
        : rawResponseText;  // Nothing streamed, use full combined text

      // Fallback: if structured output was expected but streaming didn't capture anything
      if (hasStructuredOutput) {
        this.emitFallbackResponse(
          content,
          jsonExtractor?.getContent() ?? '',
          structuredOutput,
          responseText,
          workItem.workId
        );
      }

      // Hard stop on invalid structured output
      if (result.terminationReason === 'invalid_action') {
        this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
        return;
      }

      // Routing agents return non-action structured output; treat as complete
      if (this.resolveOutputSchemaId() === 'routing' && structuredOutput) {
        result.success = true;
        result.terminationReason = 'goal_state_reached';
        this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
        return;
      }

      // 4. Process tools (if any)
      if (toolCalls.length > 0) {
        const toolCallsSucceededBefore = metrics.toolCallsSucceeded;
        const toolCallsFailedBefore = metrics.toolCallsFailed;

        await this.processToolCalls(
          toolCalls,
          globalContext,
          localContext,
          localReadFiles,
          result,
          metrics,
          workItem,
          cwd,
          workItem.workId,
          toolRepeatState
        );

        const successCount = metrics.toolCallsSucceeded - toolCallsSucceededBefore;
        const failCount = metrics.toolCallsFailed - toolCallsFailedBefore;
        this.internalHookQueue.enqueue({
          type: 'tool_batch_completed',
          toolNames: toolCalls.map(tc => tc.name),
          successCount,
          failCount,
        }, this.buildHookContext(workItem));

        // Early exit if tool processing set a termination reason
        if (result.terminationReason) {
          this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
          return;
        }
      }

      // 4. Resolve action (single code path)
      const resolved = this.resolveAction(action, structuredOutput, responseText, content, result);

      switch (resolved) {
        case 'done':
        case 'user_input':
          this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
          return;

        case 'handoff': {
          const handoffResult = this.handleHandoff(structuredOutput, result);
          this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
          if (handoffResult === 'return') return;
          continue;
        }

        case 'continue':
          this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
          continue;

        case 'no_action': {
          // Handle missing action field
          const safeContent = this.config.outputSchema && (structuredOutput || coerceStructuredOutput(content))
            ? ''
            : content;
          const responseCandidate = responseText ?? safeContent;
          if (responseCandidate.trim().length > 0) {
            result.response = responseCandidate;
          }

          // If structured output was produced but action is missing, hard fail.
          if (this.config.outputSchema && structuredOutput) {
            result.terminationReason = 'invalid_action';
            result.error = 'Structured output missing required "action" field.';
            this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
            return;
          }

          // Tool calls made = progress, allow implicit continue
          if (toolCalls.length > 0) {
            this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, false);
            continue;
          }

          // No tool calls AND no action = inject schema reminder for structured output agents
          if (this.config.outputSchema) {
            const schemaReminder = this.buildSchemaReminder(this.resolveOutputSchemaId());
            localContext.addMessage('user', schemaReminder, workItem.workId);
            this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, false);
            continue;
          }

          // Non-structured agent with no action and no tools - terminate
          result.terminationReason = 'no_action';
          const preview = responseCandidate.trim().slice(0, 1000);
          result.error = preview
            ? `LLM response has no tools and no action directive. Response preview: ${preview}`
            : 'LLM response has no tools and no action directive';
          this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
          break;
        }
      }
    }

    // Always capture all assistant responses even without a terminal action.
    if (!result.response) {
      const messages = localContext.getItemsByType('message') as Array<{ role: string; content: string | unknown[] }>;
      const assistantContents = messages
        .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0)
        .map(m => m.content as string);

      // Try to extract structured response from assistant content
      for (const content of assistantContents) {
        const parsed = coerceStructuredOutput(content);
        if (parsed && typeof parsed.response === 'string' && parsed.response.trim().length > 0) {
          result.response = parsed.response;
          break;
        }
      }

      // If still no response, use raw content
      if (!result.response && assistantContents.length > 0) {
        result.response = assistantContents.join('\n\n');
      }

      // Last resort: summarize tool calls made if we have any
      if (!result.response) {
        const toolCalls = localContext.getItemsByType('function_call') as Array<{ name: string }>;
        const toolOutputs = localContext.getItemsByType('function_call_output') as Array<{ output: string; isError?: boolean }>;
        if (toolCalls.length > 0) {
          const toolNames = toolCalls.map(t => t.name);
          const successfulOutputs = toolOutputs.filter(o => !o.isError && o.output);
          const summary = `Exploration incomplete. Tools called: ${toolNames.join(', ')}. ` +
            `${successfulOutputs.length} successful results obtained but not synthesized.`;
          result.response = summary;
        }
      }
    }

    // Handle exhausted resources - treat as partial success if we have content
    // If terminationReason is unset, we exhausted iterations without a specific termination
    if (!result.terminationReason) {
      result.terminationReason = 'max_iterations_exceeded';
    }

    // For any bounds-related termination, mark as partial success if we have content
    const isBoundsTermination =
      result.terminationReason === 'max_iterations_exceeded' ||
      result.terminationReason === 'max_tool_calls_exceeded' ||
      result.terminationReason === 'max_duration_exceeded';

    if (isBoundsTermination) {
      if (result.response) {
        // We have content, mark as partial success rather than failure
        result.success = true;
        result.isIncomplete = true;
      } else {
        result.error = `${result.terminationReason}: no output captured`;
      }
    }

    result.filesRead = Array.from(localReadFiles);
  }

  private finalizeResult(result: MutableAgentResult): AgentResult {
    const terminationReason = result.terminationReason ?? 'agent_error';
    const base = {
      success: result.success,
      response: result.response,
      error: result.error,
      metrics: result.metrics,
      filesRead: result.filesRead,
      invalidatedPaths: result.invalidatedPaths,
      toolErrors: result.toolErrors,
      isIncomplete: result.isIncomplete,
      structuredOutput: result.structuredOutput,
      artifacts: result.artifacts,
      localContext: result.localContext,
      watcherStop: result.watcherStop,
    };

    if (terminationReason !== 'user_input_required' && result.needsUserInput) {
      throw new Error(`AgentResult invariant violation: needsUserInput=true with terminationReason=${terminationReason}`);
    }
    if (terminationReason !== 'handoff_requested' && result.needsHandoff) {
      throw new Error(`AgentResult invariant violation: needsHandoff=true with terminationReason=${terminationReason}`);
    }
    if (terminationReason !== 'refusal' && result.isRefusal) {
      throw new Error(`AgentResult invariant violation: isRefusal=true with terminationReason=${terminationReason}`);
    }

    switch (terminationReason) {
      case 'user_input_required': {
        if (!result.userPrompt) {
          throw new Error('AgentResult invariant violation: user_input_required without userPrompt');
        }
        return {
          ...base,
          terminationReason,
          needsUserInput: true,
          userPrompt: result.userPrompt,
          needsHandoff: false,
          isRefusal: false,
        };
      }
      case 'handoff_requested': {
        if (!result.handoffSpec) {
          throw new Error('AgentResult invariant violation: handoff_requested without handoffSpec');
        }
        return {
          ...base,
          terminationReason,
          needsUserInput: false,
          needsHandoff: true,
          handoffSpec: result.handoffSpec,
          isRefusal: false,
        };
      }
      case 'refusal': {
        return {
          ...base,
          terminationReason,
          needsUserInput: false,
          needsHandoff: false,
          isRefusal: true,
        };
      }
      case 'rate_limit': {
        if (!result.rateLimitInfo) {
          throw new Error('AgentResult invariant violation: rate_limit without rateLimitInfo');
        }
        return {
          ...base,
          terminationReason,
          needsUserInput: false,
          needsHandoff: false,
          isRefusal: false,
          rateLimitInfo: result.rateLimitInfo,
        };
      }
      default: {
        return {
          ...base,
          terminationReason,
          needsUserInput: false,
          needsHandoff: false,
          isRefusal: false,
        };
      }
    }
  }

  /**
   * Build a query for memory retrieval from workItem objective and recent user messages.
   */
  private buildMemoryQuery(workItem: WorkItem, globalContext: ContextWindow): string {
    const parts: string[] = [];

    // Include workItem objective
    if (workItem?.objective) {
      parts.push(workItem.objective);
    }

    // Include last 3 user messages from global context (avoid file_content/artifact leakage)
    const userMessages = globalContext.items
      .filter((item): item is MessageItem => item.type === 'message' && item.role === 'user')
      .slice(-3)
      .map((item) => {
        if (typeof item.content === 'string') return item.content;
        if (Array.isArray(item.content)) {
          return item.content
            .map((block) => (block.type === 'text' ? block.text : ''))
            .join(' ');
        }
        return '';
      })
      .filter((c): c is string => typeof c === 'string' && c.trim().length > 0);

    parts.push(...userMessages);

    // Cap query length at 500 chars
    return parts.join(' ').slice(0, 500);
  }

  private shouldUseMemoryV2(sessionId: string, workId?: string): boolean {
    const rawPercent = process.env.MEMORY_INJECTOR_V2_PERCENT;
    const percent = rawPercent ? Number(rawPercent) : 100;
    if (!Number.isFinite(percent) || percent <= 0) return false;
    if (percent >= 100) return true;

    const seed = `${sessionId}:${workId ?? ''}`;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    }
    return (hash % 100) < percent;
  }

  /**
   * Build system prompt components for caching optimization.
   * Static content goes in system prompt (cached), dynamic content goes in messages.
   */
  private buildSystemPromptComponents(workItem: WorkItem, cwd: string): { system: string; taskContext: string } {
    const { system, taskContext } = buildSystemMessage(
      workItem.goal,
      workItem.objective,
      this.config.systemPrompt,
      cwd
    );
    return { system, taskContext };
  }

  private filterAllowedTools(allTools: ToolDefinition[]): ToolDefinition[] {
    if (this.config.tools.length === 0) return [];
    const allowed = new Set(this.config.tools.map((t) => t.toLowerCase()));
    return allTools.filter((tool) => allowed.has(tool.name.toLowerCase()));
  }

  /**
   * Build a filtered global context view to reduce cross-workItem bleed.
   * Keeps recent messages, target-related files, and relevant artifacts.
   */
  private buildGlobalContextView(globalContext: ContextWindow, workItem: WorkItem): ContextWindow {
    const toNumber = (value: string | undefined, fallback: number): number => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    const threshold = toNumber(process.env.GLOBAL_CONTEXT_FILTER_THRESHOLD, 0.35);
    const maxItems = Math.max(50, toNumber(process.env.GLOBAL_CONTEXT_MAX_ITEMS, 200));
    const maxMessages = Math.max(6, toNumber(process.env.GLOBAL_CONTEXT_MAX_MESSAGES, 16));
    const maxFiles = Math.max(2, toNumber(process.env.GLOBAL_CONTEXT_MAX_FILE_CONTENT, 6));
    const maxArtifacts = Math.max(2, toNumber(process.env.GLOBAL_CONTEXT_MAX_ARTIFACTS, 6));

    const shouldFilter = globalContext.items.length > maxItems ||
      globalContext.metrics.percentageUsed >= threshold;

    if (!shouldFilter) {
      return globalContext;
    }

    const view = ContextWindow.deserialize(globalContext.serialize());
    const items = view.items;

    const normalizePath = (input: string): string => input.replace(/\\/g, '/');
    const targetPaths = (workItem.targetPaths ?? [])
      .map((p) => normalizePath(p))
      .filter((p) => p.length > 0);
    const hasTargets = targetPaths.length > 0;

    const matchesTarget = (pathValue: string): boolean => {
      const normalized = normalizePath(pathValue);
      return targetPaths.some((target) => {
        if (normalized === target) return true;
        if (normalized.endsWith(`/${target}`)) return true;
        if (normalized.startsWith(target)) return true;
        return false;
      });
    };

    const keep = new Set<ContextItem>();

    // Keep system/developer messages and the most recent user/assistant messages.
    let keptMessages = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type !== 'message') continue;
      if (item.role === 'system' || item.role === 'developer') {
        keep.add(item);
        continue;
      }
      if (keptMessages < maxMessages) {
        keep.add(item);
        keptMessages++;
      }
    }

    // Keep file contents relevant to targets, or most recent if no targets match.
    const fileItems: FileContentItem[] = [];
    for (const item of items) {
      if (item.type === 'file_content') {
        fileItems.push(item as FileContentItem);
      }
    }

    let keptFileItems: FileContentItem[] = [];
    if (fileItems.length > 0) {
      if (hasTargets) {
        const matching = fileItems.filter((item) => matchesTarget(item.path));
        keptFileItems = matching.slice(-maxFiles);
        if (keptFileItems.length === 0) {
          keptFileItems = fileItems.slice(-Math.min(maxFiles, fileItems.length));
        }
      } else {
        keptFileItems = fileItems.slice(-Math.min(maxFiles, fileItems.length));
      }
    }

    for (const item of keptFileItems) {
      keep.add(item);
    }

    const keptPaths = new Set(keptFileItems.map((item) => item.path));

    // Keep artifacts that align with target paths, otherwise most recent ones.
    const artifactItems: ArtifactItem[] = [];
    for (const item of items) {
      if (item.type === 'artifact') {
        artifactItems.push(item as ArtifactItem);
      }
    }

    let keptArtifacts: ArtifactItem[] = [];
    if (artifactItems.length > 0) {
      if (hasTargets) {
        keptArtifacts = artifactItems.filter((item) => matchesTarget(item.sourcePath));
      } else {
        keptArtifacts = artifactItems.slice(-Math.min(maxArtifacts, artifactItems.length));
      }
      if (keptArtifacts.length === 0 && keptPaths.size > 0) {
        keptArtifacts = artifactItems.filter((item) => keptPaths.has(item.sourcePath));
      }
    }

    for (const item of keptArtifacts) {
      keep.add(item);
    }

    // Drop tool history and reasoning items to minimize cross-task bleed.
    view.filterItems((item) => keep.has(item));
    view.rebuildReadFilesFromItems();

    return view;
  }

  /**
   * Build messages array for LLM call.
   * Merges global context (historical) with local context (this turn's work).
   *
   * For cache optimization:
   * - systemPrompt: Static behavioral rules (goes in system parameter, cached)
   * - taskContext: Dynamic goal/objective/workspace (first user message, not cached)
   */
  private buildMessages(
    systemPrompt: string,
    taskContext: string,
    workItem: WorkItem,
    globalContext: ContextWindow,
    localContext: ContextWindow
  ): Array<Record<string, unknown>> {
    // Use LLMItem[] for type safety during construction
    const messages: Array<LLMItem | Record<string, unknown>> = [
      { type: 'message', role: 'system', content: systemPrompt },
    ];

    // Merge global (historical) + local (this turn) items
    const globalView = this.buildGlobalContextView(globalContext, workItem);
    const globalItems = globalView.getItemsForLLM();
    const localItems = localContext.getItemsForLLM();
    const allItems = [...globalItems, ...localItems];

    // Collect all callIds that have outputs - we only want to send function_calls
    // that have matching outputs to avoid OpenAI's "No tool output found" error.
    const callIdsWithOutputs = new Set<string>();
    for (const item of allItems) {
      if (isLLMFunctionCallOutputItem(item)) {
        callIdsWithOutputs.add(item.call_id);
      }
    }

    // Build context summary from both global and local contexts
    const globalSummary = globalView.buildContextSummary();
    const localSummary = localContext.buildContextSummary();
    const combinedSummary = [globalSummary, localSummary].filter(Boolean).join('\n');

    const contextParts = [taskContext];
    if (combinedSummary) contextParts.push(combinedSummary);
    const contextPrelude = contextParts.join('\n\n');

    const hasUserInput = [...globalContext.items, ...localContext.items].some(
      (item) => item.type === 'message' && item.role === 'user'
    );

    const prependContextToUserContent = (
      content: string | ContentBlock[],
      prefix: string
    ): string | ContentBlock[] => {
      if (!prefix.trim()) return content;
      const prefixText = `${prefix}\n\n`;
      if (typeof content === 'string') {
        return `${prefixText}${content}`;
      }
      if (Array.isArray(content)) {
        return [{ type: 'text', text: prefixText }, ...content];
      }
      return content;
    };

    // Task context (goal/objective/workspace) goes in first user message - NOT in system prompt
    // This enables caching of the static system prompt across different tasks
    if (!hasUserInput) {
      messages.push({
        type: 'message',
        role: 'user',
        content: contextPrelude,
      });
    }

    let functionCallCount = 0;
    let functionOutputCount = 0;
    let injectedContext = !hasUserInput;

    for (const item of allItems) {
      if (isLLMMessageItem(item)) {
        const isFileContentMessage = typeof item.content === 'string' && item.content.startsWith('[File: ');
        if (!injectedContext && item.role === 'user' && !isFileContentMessage) {
          messages.push({
            type: 'message',
            role: 'user',
            content: prependContextToUserContent(item.content, contextPrelude),
          });
          injectedContext = true;
          continue;
        }
        messages.push({
          type: 'message',
          role: item.role,
          content: item.content,
        });
      } else if (item.type === 'reasoning') {
        // Pass reasoning items through - formatMessages will attach to assistant messages
        messages.push(item);
      } else if (isLLMFunctionCallItem(item)) {
        // Only include function_calls that have matching outputs
        if (callIdsWithOutputs.has(item.call_id)) {
          messages.push(item);
          functionCallCount++;
        }
      } else if (item.type === 'function_call_output') {
        messages.push(item);
        functionOutputCount++;
      }
    }

    return messages;
  }

  /**
   * Add assistant message to context.
   */
  private addAssistantMessage(
    context: ContextWindow,
    content: string,
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    workItemId?: string
  ): void {
    if (toolCalls.length > 0) {
      if (content) {
        context.addMessage('assistant', content, workItemId);
      }
      for (const tc of toolCalls) {
        context.appendItem({
          type: 'function_call',
          callId: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          timestamp: Date.now(),
          workItemId,
        });
      }
    } else {
      context.addMessage('assistant', content, workItemId);
    }
  }

  /**
   * Process tool calls.
   */
  private async processToolCalls(
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    globalContext: ContextWindow,
    localContext: ContextWindow,
    localReadFiles: Set<string>,
    result: MutableAgentResult,
    metrics: AgentMetrics,
    workItem: WorkItem,
    cwd: string,
    workItemId?: string,
    toolRepeatState?: { lastKey: string; lastOutput: string; repeats: number }
  ): Promise<void> {
    const mq = createMicroQueue();
    const allowedTools = new Set(this.config.tools.map((t) => t.toLowerCase()));
    const itemWorkId = workItemId ?? workItem.workId;

    // Build a map from lowercase names to canonical names for case-insensitive lookup
    const canonicalNames = new Map<string, string>();
    for (const toolName of this.config.tools) {
      canonicalNames.set(toolName.toLowerCase(), toolName);
    }
    const pendingParallel: Array<{
      call: { id: string; name: string; arguments: Record<string, unknown> };
      promise: Promise<{ toolResult: ToolResult; toolDurationMs: number }>;
    }> = [];

    const invalidatePath = (pathValue: unknown): void => {
      if (typeof pathValue !== 'string' || pathValue.length === 0) {
        return;
      }
      result.invalidatedPaths.push(pathValue);
      localReadFiles.delete(pathValue);
      localContext.invalidateFileContent(pathValue);
    };

    const handleToolResult = (
      call: { id: string; name: string; arguments: Record<string, unknown> },
      toolResult: ToolResult,
      toolDurationMs: number,
      isAgentTool: boolean
    ): boolean => {
      if (toolResult.isSuccess) {
        metrics.toolCallsSucceeded++;

        const nameLower = call.name.toLowerCase();
        if (nameLower === 'read') {
          const readPath = call.arguments.path ?? call.arguments.file_path;
          if (typeof readPath === 'string') {
            localReadFiles.add(readPath);
            if (!localContext.hasReadFile(readPath)) {
              const rawOutput = toolResult.output ?? '';
              localContext.addFileContent(readPath, truncateToolOutput(rawOutput, call.name), undefined, workItem.workId);
            }
          }
        }

        if (nameLower === 'write' || nameLower === 'edit') {
          invalidatePath(call.arguments.path ?? call.arguments.file_path);
        } else if (nameLower === 'batchedit') {
          const edits = call.arguments.edits;
          if (Array.isArray(edits)) {
            for (const edit of edits) {
              if (!edit || typeof edit !== 'object') continue;
              const editArgs = edit as Record<string, unknown>;
              invalidatePath(editArgs.path ?? editArgs.file_path);
            }
          }
        }
      } else {
        metrics.toolCallsFailed++;
        if (toolResult.error) {
          result.toolErrors.push(`${call.name}: ${toolResult.error}`);
        }
      }

      // For event emission, include error message for failed tools (output is empty in errorResult)
      const failureMessage = toolResult.isSuccess ? '' : (toolResult.error || 'Unknown error');
      const eventResultPreview = toolResult.isSuccess
        ? toolResult.output.slice(0, 10000)
        : failureMessage.slice(0, 10000);
      const auditResult = toolResult.isSuccess ? toolResult.output : failureMessage;
      this.emit(createEvent('tool_call', {
        toolName: call.name,
        arguments: call.arguments,
        phase: 'completed',
        result: eventResultPreview,
        success: toolResult.isSuccess,
        durationMs: toolDurationMs,
      }, workItemId));

      // Fire tool_call_completed hook for workitem logging (captures full args + full result)
      this.internalHookQueue.enqueue({
        type: 'tool_call_completed',
        tool: call.name,
        args: call.arguments,
        success: toolResult.isSuccess,
        result: auditResult,
        durationMs: toolDurationMs,
      }, this.buildHookContext(workItem));

      // Truncate tool outputs at storage to reduce context size
      // File reads get higher limit (50KB) vs general tools (8KB)
      // For failed tools, include the error message so the LLM knows what went wrong
      const rawOutput = toolResult.isSuccess
        ? toolResult.output
        : failureMessage;

      localContext.appendItem({
        type: 'function_call_output',
        callId: call.id,
        output: truncateToolOutput(rawOutput, call.name),
        isError: !toolResult.isSuccess,
        durationMs: toolDurationMs,
        timestamp: Date.now(),
        workItemId: itemWorkId,
      });

      if (toolRepeatState) {
        const argsKey = JSON.stringify(call.arguments ?? {});
        const outputKey = toolResult.isSuccess
          ? (toolResult.output ?? '')
          : `error:${toolResult.error ?? ''}`;
        const signature = `${call.name}:${argsKey}`;
        const outputSample = outputKey.slice(0, 2000);

        if (signature === toolRepeatState.lastKey && outputSample === toolRepeatState.lastOutput) {
          toolRepeatState.repeats += 1;
        } else {
          toolRepeatState.lastKey = signature;
          toolRepeatState.lastOutput = outputSample;
          toolRepeatState.repeats = 0;
        }

        if (toolRepeatState.repeats >= TOOL_LIMITS.MAX_IDENTICAL_CALLS) {
          result.terminationReason = 'stagnation';
          result.error = `Repeated identical tool call without progress: ${call.name}`;
          return true;
        }
      }

      // SIAS mode: don't propagate sub-agent user input requests
      if (isAgentTool && result.needsUserInput) {
        result.needsUserInput = false;
        result.userPrompt = undefined;
      }

      return false;
    };

    const flushParallel = async (): Promise<boolean> => {
      if (pendingParallel.length === 0) return false;
      const batch = pendingParallel.splice(0, pendingParallel.length);
      const results = await Promise.all(batch.map((item) => item.promise));
      for (let i = 0; i < batch.length; i++) {
        const { call } = batch[i];
        const { toolResult, toolDurationMs } = results[i];
        const shouldStop = handleToolResult(call, toolResult, toolDurationMs, false);
        if (shouldStop) {
          return true;
        }
        await mq.yieldIfNeeded();
      }
      return false;
    };

    for (const call of toolCalls) {
      metrics.toolCallsMade++;
      const nameLower = call.name.toLowerCase();

      if (this.config.tools.length === 0 || !allowedTools.has(nameLower)) {
        const shouldStop = await flushParallel();
        if (shouldStop) return;

        const errorMsg = `Tool "${call.name}" is not allowed for this agent`;
        result.toolErrors.push(errorMsg);
        metrics.toolCallsFailed++;
        localContext.appendItem({
          type: 'function_call_output',
          callId: call.id,
          output: errorMsg,
          isError: true,
          timestamp: Date.now(),
          workItemId: itemWorkId,
        });
        continue;
      }

      // Normalize tool name to canonical form for case-insensitive lookup
      const canonicalName = canonicalNames.get(nameLower) ?? call.name;

      // Intercept PromptUser tool - signal pause for user input
      if (nameLower === 'promptuser') {
        await flushParallel();
        const args = call.arguments;
        const question = typeof args.question === 'string' ? args.question : '';
        if (!question) {
          localContext.appendItem({
            type: 'function_call_output',
            callId: call.id,
            output: 'PromptUser requires a question',
            isError: true,
            timestamp: Date.now(),
            workItemId: itemWorkId,
          });
          continue;
        }

        // Build UserPromptInfo from validated args
        result.needsUserInput = true;
        result.userPrompt = {
          question,
          options: Array.isArray(args.options) ? args.options as UserPromptInfo['options'] : undefined,
          context: typeof args.context === 'string' ? args.context : undefined,
          multiSelect: typeof args.multiSelect === 'boolean' ? args.multiSelect : undefined,
          questionType: typeof args.questionType === 'string' ? args.questionType : undefined,
          questions: Array.isArray(args.questions) ? args.questions as UserPromptQuestion[] : undefined,
        };
        result.terminationReason = 'user_input_required';

        localContext.appendItem({
          type: 'function_call_output',
          callId: call.id,
          output: 'Waiting for user input...',
          isError: false,
          timestamp: Date.now(),
          workItemId: itemWorkId,
        });

        return;
      }

      const isAgentTool = this.agentRegistry?.has(canonicalName) ?? false;
      const isParallelSafe = !isAgentTool && this.toolRegistry.isParallelSafe(canonicalName);

      if (isParallelSafe) {
        // PreToolUse hook
        let effectiveArgs = call.arguments;
        if (this.hooks?.preToolUse) {
          const hookResult = await this.hooks.preToolUse(canonicalName, call.arguments);
          if (hookResult.action === 'block') {
            const toolResult = errorResult(canonicalName, hookResult.message ?? 'Blocked by hook', 0);
            const toolDurationMs = 0;
            const stop = handleToolResult(call, toolResult, toolDurationMs, false);
            if (stop) return;
            continue;
          }
          if (hookResult.action === 'modify' && hookResult.modifiedArgs) {
            effectiveArgs = hookResult.modifiedArgs;
          }
        }

        this.emit(createEvent('tool_call', {
          toolName: canonicalName,
          arguments: effectiveArgs,
          phase: 'starting',
        }, workItemId));

        const toolStartTime = Date.now();
        const capturedArgs = effectiveArgs;
        const promise = (async () => {
          try {
            let toolResult = await this.toolRegistry.execute(canonicalName, capturedArgs, { cwd });

            // PostToolUse hook
            if (this.hooks?.postToolUse) {
              const hookResult = await this.hooks.postToolUse(canonicalName, capturedArgs, toolResult);
              if (hookResult.action === 'modify' && hookResult.modifiedResult) {
                toolResult = hookResult.modifiedResult;
              }
            }

            return { toolResult, toolDurationMs: Date.now() - toolStartTime };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const toolResult = errorResult(canonicalName, message, 0);
            toolResult.output = `Error: ${message}`;
            return { toolResult, toolDurationMs: Date.now() - toolStartTime };
          }
        })();

        pendingParallel.push({ call, promise });
        continue;
      }

      const shouldStop = await flushParallel();
      if (shouldStop) return;

      // PreToolUse hook for sequential execution
      let effectiveArgs = call.arguments;
      if (this.hooks?.preToolUse) {
        const hookResult = await this.hooks.preToolUse(canonicalName, call.arguments);
        if (hookResult.action === 'block') {
          const toolResult = errorResult(canonicalName, hookResult.message ?? 'Blocked by hook', 0);
          const stop = handleToolResult(call, toolResult, 0, isAgentTool);
          if (stop) return;
          continue;
        }
        if (hookResult.action === 'modify' && hookResult.modifiedArgs) {
          effectiveArgs = hookResult.modifiedArgs;
        }
      }

      this.emit(createEvent('tool_call', {
        toolName: canonicalName,
        arguments: effectiveArgs,
        phase: 'starting',
      }, workItemId));

      const toolStartTime = Date.now();

      try {
        // Use canonical name for execution, but pass original call for agent tools (which need call.id)
        const normalizedCall = { ...call, name: canonicalName, arguments: effectiveArgs };
        let toolResult = isAgentTool
          ? await this.executeAgentToolCall(normalizedCall, workItem, globalContext, localContext, cwd)
          : await this.toolRegistry.execute(canonicalName, effectiveArgs, { cwd });
        const toolDurationMs = Date.now() - toolStartTime;

        // PostToolUse hook
        if (this.hooks?.postToolUse) {
          const hookResult = await this.hooks.postToolUse(canonicalName, effectiveArgs, toolResult);
          if (hookResult.action === 'modify' && hookResult.modifiedResult) {
            toolResult = hookResult.modifiedResult;
          }
        }

        const stop = handleToolResult(call, toolResult, toolDurationMs, isAgentTool);
        if (stop) return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        metrics.toolCallsFailed++;
        result.toolErrors.push(`${canonicalName}: ${message}`);

        this.emit(createEvent('tool_call', {
          toolName: canonicalName,
          arguments: effectiveArgs,
          phase: 'completed',
          result: `Error: ${message}`,
          success: false,
          durationMs: Date.now() - toolStartTime,
        }, workItemId));

        localContext.appendItem({
          type: 'function_call_output',
          callId: call.id,
          output: `Error: ${message}`,
          isError: true,
          timestamp: Date.now(),
          workItemId: itemWorkId,
        });
      }
    }

    const shouldStop = await flushParallel();
    if (shouldStop) return;
  }

  /**
   * Create a merged context view for sub-agent consumption.
   * Combines global context with relevant items from parent's local context.
   * This enables sub-agents to see parent's discoveries without re-discovery.
   */
  private createMergedContext(
    globalContext: ContextWindow,
    parentLocalContext: ContextWindow,
    options: {
      includeArtifacts: boolean;
      includeFileContent: boolean;
      includeToolHistory: boolean;
    }
  ): ContextWindow {
    // Clone global context to avoid mutation
    const merged = ContextWindow.deserialize(globalContext.serialize());

    // Filter out tool call history from globalContext clone - sub-agents should not
    // see parent's tool calls (they could mimic tool signatures not in their allowed list)
    if (!options.includeToolHistory) {
      merged.filterItems((item) =>
        item.type !== 'function_call' && item.type !== 'function_call_output'
      );
    }

    // Transfer artifacts from parent
    if (options.includeArtifacts) {
      for (const artifact of parentLocalContext.getArtifacts()) {
        merged.addArtifact({
          sourcePath: artifact.sourcePath,
          line: artifact.line,
          kind: artifact.kind,
          name: artifact.name,
          signature: artifact.signature,
          modifies: artifact.modifies,
          calls: artifact.calls,
          insight: artifact.insight,
          reduces: artifact.reduces,
          relevance: artifact.relevance,
          discoveredBy: artifact.discoveredBy,
          workItemId: artifact.workItemId,
        }, artifact.workItemId);
      }
    }

    // Transfer file content (sub-agent shouldn't re-read what parent already read)
    if (options.includeFileContent) {
      const fileItems = parentLocalContext.getItemsByType<FileContentItem>('file_content');
      for (const fileItem of fileItems) {
        if (!merged.hasReadFile(fileItem.path)) {
          merged.addFileContent(fileItem.path, fileItem.content, fileItem.language, fileItem.workItemId);
        }
      }
    }

    // Optionally transfer tool history (usually not needed)
    if (options.includeToolHistory) {
      for (const item of parentLocalContext.items) {
        if (item.type === 'function_call' || item.type === 'function_call_output') {
          merged.appendItem(item);
        }
      }
    }

    return merged;
  }

  /**
   * Merge sub-agent execution results into parent's local context.
   * Transfers artifacts, file reads, and invalidations back to parent.
   * This prevents future sub-agents from re-discovering the same information.
   */
  private mergeSubAgentResults(
    parentLocalContext: ContextWindow,
    subResult: AgentResult
  ): void {
    // 1. Merge files read (so parent doesn't re-read them)
    // Defensive: filesRead should always be an array, but check anyway
    const filesRead = subResult.filesRead ?? [];
    for (const path of filesRead) {
      if (typeof path === 'string' && path.length > 0) {
        parentLocalContext.markFileRead(path);
      }
    }

    // 2. Merge artifacts - prefer explicit artifacts field, fallback to localContext
    const subArtifacts = subResult.artifacts ?? subResult.localContext?.getArtifacts() ?? [];
    for (const artifact of subArtifacts) {
      // Skip malformed artifacts (defensive: all artifacts should have sourcePath, kind, name)
      if (!artifact || typeof artifact.sourcePath !== 'string' || typeof artifact.name !== 'string') {
        continue;
      }
      // Avoid duplicates by checking sourcePath + name + line
      const existing = parentLocalContext.getArtifactsByPath(artifact.sourcePath);
      const isDuplicate = existing.some(e =>
        e.name === artifact.name && e.line === artifact.line
      );
        if (!isDuplicate) {
          parentLocalContext.addArtifact({
            sourcePath: artifact.sourcePath,
            line: artifact.line,
            kind: artifact.kind,
            name: artifact.name,
            signature: artifact.signature,
            modifies: artifact.modifies,
            calls: artifact.calls,
            insight: artifact.insight,
            reduces: artifact.reduces,
            relevance: artifact.relevance,
            discoveredBy: artifact.discoveredBy,
            workItemId: artifact.workItemId,
          }, artifact.workItemId);
        }
      }

    // 3. Merge file content (if sub-agent read files parent hasn't)
    if (subResult.localContext) {
      const subFileItems = subResult.localContext.getItemsByType<FileContentItem>('file_content');
      for (const fileItem of subFileItems) {
        // Defensive: ensure fileItem has required properties
        if (!fileItem?.path || typeof fileItem.content !== 'string') {
          continue;
        }
        if (!parentLocalContext.hasReadFile(fileItem.path)) {
          parentLocalContext.addFileContent(fileItem.path, fileItem.content, fileItem.language, fileItem.workItemId);
        }
      }
    }
  }

  private async executeAgentToolCall(
    call: { id: string; name: string; arguments: Record<string, unknown> },
    parentWorkItem: WorkItem,
    globalContext: ContextWindow,
    parentLocalContext: ContextWindow,
    cwd: string
  ) {
    if (!this.agentRegistry) {
      return errorResult(call.name, 'Agent tool registry not available', 0);
    }

    // Prevent recursive self-calls
    if (call.name.toLowerCase() === this.config.type.toLowerCase()) {
      return errorResult(call.name, `Agent '${this.config.type}' cannot call itself`, 0);
    }

    let agentConfig: AgentConfig;
    let llmConfig: LLMRequestConfig;
    try {
      // Get agent capabilities (tools, budget, llmParams) from registry
      agentConfig = this.agentRegistry.getConfig(call.name);

      // Build LLM config from model selection (source of truth) + agent's llmParams
      // NO FALLBACK: model selection MUST exist
      const modelSelection = this.getModelSelection?.(agentConfig.type);
      if (!modelSelection) {
        return errorResult(
          call.name,
          `No model configured for agent type '${agentConfig.type}'. Please select a model using /models before using this agent.`,
          0
        );
      }
      llmConfig = buildLLMRequestConfig(modelSelection, agentConfig.llmParams);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(call.name, message, 0);
    }

    const args = call.arguments ?? {};
    const objective = typeof args.objective === 'string' ? args.objective.trim() : '';
    if (!objective) {
      return errorResult(call.name, 'Missing required argument: objective', 0);
    }

    const goal =
      typeof args.goal === 'string' && args.goal.trim().length > 0
        ? args.goal.trim()
        : parentWorkItem.goal;
    const delta = typeof args.delta === 'string' ? args.delta : undefined;
    const toolHint = typeof args.toolHint === 'string' || typeof args.tool_hint === 'string'
      ? String(args.toolHint ?? args.tool_hint)
      : undefined;
    // Accept both camelCase and snake_case for targetPaths
    const rawTargetPaths = args.targetPaths ?? args.target_paths;
    const targetPaths = Array.isArray(rawTargetPaths)
      ? rawTargetPaths.filter((p) => typeof p === 'string')
      : undefined;
    const params =
      args.params && typeof args.params === 'object' && !Array.isArray(args.params)
        ? (args.params as Record<string, unknown>)
        : undefined;

    const subWorkItem = createWorkItem({
      goal,
      objective,
      delta,
      toolHint,
      targetPaths: targetPaths && targetPaths.length > 0 ? targetPaths : undefined,
      params,
      agent: agentConfig.type,
      // Use agent's configured budget as work item bounds
      bounds: {
        maxToolCalls: agentConfig.budget.maxToolCalls,
        maxDurationMs: agentConfig.budget.maxDurationMs,
        maxLlmCalls: agentConfig.budget.maxIterations,
      },
    });

    const agent = new Agent(agentConfig, {
      llm: this.llm,
      toolRegistry: this.toolRegistry,
      emit: this.emit,
      requestId: this.requestId,
      sessionKey: this.sessionKey,
      agentRegistry: this.agentRegistry,
      llmConfig,
      hooks: this.hooks,
      internalHookQueue: this.internalHookQueue,
      getModelSelection: this.getModelSelection,
    });

    // Create merged context for sub-agent: combines global context with parent's discoveries
    // This enables sub-agents to see artifacts and file content from parent without re-discovery
    const mergedContextForSubAgent = this.createMergedContext(
      globalContext,
      parentLocalContext,
      {
        includeArtifacts: true,
        includeFileContent: true,
        includeToolHistory: false, // Don't leak parent's tool calls - they're not relevant
      }
    );

    const subResult = await agent.run({ globalContext: mergedContextForSubAgent, workItem: subWorkItem, cwd });

    // Track post-processing errors separately - we want to preserve sub-agent results
    // even if artifact extraction or merging fails
    let postProcessingError: string | null = null;

    // Extract key findings from sub-agent's tool outputs to include in response
    let enhancedResponse = subResult.response;
    if (!enhancedResponse && subResult.localContext) {
      // If no response but we have tool outputs, try to extract useful info
      const toolOutputs = subResult.localContext.getItemsByType('function_call_output') as Array<{
        output: string;
        isError?: boolean;
        callId?: string;
      }>;
      const toolCalls = subResult.localContext.getItemsByType('function_call') as Array<{
        name: string;
        callId?: string;
        arguments?: Record<string, unknown>;
      }>;

      if (toolOutputs.length > 0) {
        // Build a summary of what was found
        const successfulOutputs = toolOutputs.filter(o => !o.isError && o.output);
        const errorOutputs = toolOutputs.filter(o => o.isError && o.output);
        const outputSummaries: string[] = [];

        // First include successful outputs
        for (let i = 0; i < Math.min(successfulOutputs.length, 5); i++) {
          const output = successfulOutputs[i];
          // Find the corresponding tool call to know what tool was used
          const matchingCall = toolCalls.find(tc => tc.callId === output.callId);
          const toolName = matchingCall?.name ?? 'unknown';
          const truncatedOutput = output.output.length > 2000
            ? output.output.slice(0, 2000) + '... [truncated]'
            : output.output;
          outputSummaries.push(`[${toolName}]: ${truncatedOutput}`);
        }

        // If no successful outputs, include error outputs so parent knows what went wrong
        if (successfulOutputs.length === 0 && errorOutputs.length > 0) {
          for (let i = 0; i < Math.min(errorOutputs.length, 5); i++) {
            const output = errorOutputs[i];
            const matchingCall = toolCalls.find(tc => tc.callId === output.callId);
            const toolName = matchingCall?.name ?? 'unknown';
            const truncatedOutput = output.output.length > 2000
              ? output.output.slice(0, 2000) + '... [truncated]'
              : output.output;
            outputSummaries.push(`[${toolName} ERROR]: ${truncatedOutput}`);
          }
        }

        if (outputSummaries.length > 0) {
          const totalOutputs = successfulOutputs.length > 0 ? successfulOutputs.length : errorOutputs.length;
          const outputType = successfulOutputs.length > 0 ? 'tool outputs' : 'tool errors';
          enhancedResponse = `Sub-agent exploration results (${totalOutputs} ${outputType}):\n\n${outputSummaries.join('\n\n')}`;
          if (totalOutputs > 5) {
            enhancedResponse += `\n\n... and ${totalOutputs - 5} more results`;
          }
        }
      }
    }

    // Extract artifacts from structured output and add to parent's local context
    // Wrapped in try-catch to preserve sub-agent results even if merging fails
    const artifacts = subResult.structuredOutput?.artifacts;
    // Declare outside try-catch for validation access
    let extractedArtifacts: Array<{
      sourcePath: string;
      line?: number | null;
      kind: string;
      name: string;
      signature?: string | null;
      modifies?: string[] | null;
      calls?: string[] | null;
      insight?: string | null;
      reduces?: string | null;
    }> = [];

    try {

      // Try to extract artifacts from structured output first
      if (Array.isArray(artifacts) && artifacts.length > 0) {
        const validArtifacts = artifacts.filter((a): a is {
          sourcePath: string;
          line?: number | null;
          kind: string;
          name: string;
          signature?: string | null;
          modifies?: string[] | null;
          calls?: string[] | null;
          insight?: string | null;
          reduces?: string | null;
        } => (
          typeof a === 'object' &&
          a !== null &&
          typeof a.sourcePath === 'string' &&
          typeof a.kind === 'string' &&
          typeof a.name === 'string'
        ));
        extractedArtifacts.push(...validArtifacts);
      }

      // FALLBACK: If structured output parsing failed, extract directly from sub-agent's local context.
      // This handles cases where tool call exceptions caused JSON parsing to fail.
      // The sub-agent may have discovered artifacts but structuredOutput is null.
      if (extractedArtifacts.length === 0 && subResult.localContext) {
        const contextArtifacts = subResult.localContext.getArtifacts();
        if (contextArtifacts.length > 0) {
          extractedArtifacts.push(...contextArtifacts);
          this.emit(createEvent('agent_message', {
            agentType: this.config.type,
            message: `[Sub-agent artifact extraction] Retrieved ${contextArtifacts.length} artifacts from local context after structured output parsing failed`,
          }, subWorkItem.workId));
        }
      }

      if (extractedArtifacts.length > 0) {
        parentLocalContext.addArtifacts(extractedArtifacts.map(a => ({
          sourcePath: a.sourcePath,
          line: typeof a.line === 'number' ? a.line : undefined,
          kind: a.kind as ArtifactKind,
          name: a.name,
          signature: typeof a.signature === 'string' ? a.signature : undefined,
          modifies: Array.isArray(a.modifies) ? a.modifies : undefined,
          calls: Array.isArray(a.calls) ? a.calls : undefined,
          insight: typeof a.insight === 'string' ? a.insight : undefined,
          reduces: typeof a.reduces === 'string' ? a.reduces as 'structural' | 'relational' | 'behavioral' | 'contractual' : undefined,
          relevance: 1.0, // Default: explorer returns what's relevant
          discoveredBy: agentConfig.type,
          workItemId: (a as { workItemId?: string }).workItemId ?? subWorkItem.workId,
        })), subWorkItem.workId);
      }

      // Merge sub-agent's discoveries back into parent's local context
      // This includes file reads, artifacts, and file content not captured above
      this.mergeSubAgentResults(parentLocalContext, subResult);
    } catch (mergeError) {
      // Log but don't fail - the sub-agent's response is more important than artifact merging
      const message = mergeError instanceof Error ? mergeError.message : String(mergeError);
      const stack = mergeError instanceof Error ? mergeError.stack : undefined;
      postProcessingError = `Artifact extraction/merging failed: ${message}`;
      console.error(`[AGENT] Sub-agent post-processing error: ${message}`, stack ?? '');
    }

    // Include full structured output so calling agent can see artifacts, patterns, etc.
    // Also include explicit filesRead so calling agent knows not to re-read these
    //
    // CRITICAL: Include actual artifact content, not just count. The calling agent
    // needs to see the rich semantic extractions (signatures, side effects, call graphs)
    // to act without re-reading files.
    // HARD VALIDATION: Explorer must produce artifacts when reading files
    // This catches cases where the validation in run() didn't fire (e.g., structured output issues)
    const filesReadCount = (subResult.filesRead ?? []).length;
    const artifactCount = extractedArtifacts.length;
    let explorerValidationFailed = false;
    let explorerValidationError = '';

    if (agentConfig.type === 'explorer' && filesReadCount > 0 && artifactCount === 0) {
      explorerValidationFailed = true;
      explorerValidationError = `Explorer read ${filesReadCount} files but extracted 0 artifacts. ` +
        `This is unacceptable - every file read MUST produce artifacts.`;
      console.error(`[AGENT:explorer] SUB-AGENT VALIDATION FAILURE: ${filesReadCount} files, 0 artifacts`);
    }

    // Sub-agents with structured output stream their response field directly to TUI
    // Mark this so parent knows not to repeat the content
    const responseStreamedToUser = !!agentConfig.outputSchema && !!enhancedResponse;

    const payload = {
      agent: agentConfig.type,
      workId: subWorkItem.workId,
      success: explorerValidationFailed ? false : subResult.success,
      response: enhancedResponse,
      responseStreamedToUser, // True if response was already shown to user via streaming
      filesRead: subResult.filesRead ?? [], // Explicit list - do not re-read these
      artifacts: Array.isArray(artifacts) ? artifacts : [], // Full artifact content for downstream use
      error: explorerValidationFailed ? explorerValidationError : subResult.error,
      postProcessingError, // Non-null if artifact merging failed
      metrics: subResult.metrics,
    };

    if ((subResult.success && !explorerValidationFailed) || subResult.needsUserInput) {
      // Even on success, include any post-processing errors in the result
      if (postProcessingError) {
        (payload as Record<string, unknown>).warning = postProcessingError;
      }
      return successResult(call.name, JSON.stringify(payload), 0);
    }

    // Build human-readable error message for failed sub-agents
    // Include key details without requiring JSON parsing
    const friendlyAgentName = agentConfig.type
      .split(/[_-]/g)
      .filter((part) => part.length > 0)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
    const errorParts = [
      `${friendlyAgentName || 'Sub-agent'} failed`,
    ];
    // Always include termination reason if we have one
    if (subResult.terminationReason) {
      errorParts.push(` (reason: ${subResult.terminationReason})`);
    }
    // Include error details - if missing, note that
    if (subResult.error) {
      errorParts.push(`: ${subResult.error}`);
    } else if (subResult.terminationReason === 'agent_error') {
      errorParts.push(` - no error message captured, check agent logs`);
    }
    const toolsUsed = subResult.metrics?.toolCallsMade ?? 0;
    if (toolsUsed > 0) {
      errorParts.push(`\nTools called: ${toolsUsed} (${subResult.metrics?.toolCallsSucceeded ?? 0} succeeded, ${subResult.metrics?.toolCallsFailed ?? 0} failed)`);
    }
    if (subResult.toolErrors && subResult.toolErrors.length > 0) {
      errorParts.push(`\nTool errors: ${subResult.toolErrors.slice(0, 3).join('; ')}${subResult.toolErrors.length > 3 ? '...' : ''}`);
    }
    // Include partial response if available
    if (enhancedResponse && enhancedResponse.trim().length > 0) {
      const preview = enhancedResponse.length > 500
        ? enhancedResponse.slice(0, 500) + '... [truncated]'
        : enhancedResponse;
      errorParts.push(`\nPartial output:\n${preview}`);
    }
    // Include post-processing error if artifact merging failed
    if (postProcessingError) {
      errorParts.push(`\nPost-processing warning: ${postProcessingError}`);
    }

    return errorResult(call.name, errorParts.join(''), 0);
  }

  /**
   * Auto-read target files before execution.
   */
  private async autoReadTargetFiles(
    targetPaths: readonly string[],
    localContext: ContextWindow,
    localReadFiles: Set<string>,
    metrics: AgentMetrics,
    cwd: string,
    workItemId?: string
  ): Promise<void> {
    const allowedTools = new Set(this.config.tools.map((t) => t.toLowerCase()));
    if (!allowedTools.has('read')) {
      return;
    }

    for (const targetPath of targetPaths) {
      try {
        metrics.toolCallsMade++;
        const result = await this.toolRegistry.execute('Read', { path: targetPath }, { cwd });
        if (result.isSuccess) {
          localReadFiles.add(targetPath);
          metrics.toolCallsSucceeded++;

          const fileContent = typeof result.output === 'string'
            ? result.output
            : JSON.stringify(result.output);

          // Truncate file content at context storage (50KB limit for reads)
          localContext.addFileContent(targetPath, truncateToolOutput(fileContent, 'Read'), undefined, workItemId);
        } else {
          metrics.toolCallsFailed++;
        }
      } catch {
        metrics.toolCallsFailed++;
      }
    }
  }

  /**
   * Parse structured output if configured.
   */
  private resolveOutputSchemaId(): string | null {
    const outputSchema = this.config.outputSchema;
    if (!outputSchema) return null;

    const raw = outputSchema.schemaId ?? outputSchema.name;
    if (!raw || typeof raw !== 'string') return null;

    const normalized = raw.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(OUTPUT_SCHEMAS, normalized)) {
      return normalized;
    }

    const candidate = normalized.endsWith('_output')
      ? normalized.slice(0, -7)
      : normalized;

    if (Object.prototype.hasOwnProperty.call(OUTPUT_SCHEMAS, candidate)) {
      return candidate;
    }

    return null;
  }

  private buildSchemaReminder(schemaId: string | null): string {
    if (typeof this.config.schemaReminder === 'string' && this.config.schemaReminder.trim().length > 0) {
      return this.config.schemaReminder;
    }

    void schemaId;
    return `[SCHEMA REMINDER] You must set action, goalStateReached, awaitingUserInput, and handoffSpec every turn. Valid actions: "done", "continue". If you need user input, call PromptUser then action="done", goalStateReached=false, awaitingUserInput=true, handoffSpec=null. handoffSpec must always be null (handoff is planner-only).`;
  }

  private parseBoolean(
    value: unknown,
    fallback: boolean
  ): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
      if (normalized === '1') return true;
      if (normalized === '0') return false;
    }
    return fallback;
  }

  private normalizeActionOutputCandidate(
    candidate: Record<string, unknown>,
    schemaId: string
  ): Record<string, unknown> | null {
    const allowHandoff = schemaId === 'planner_output';
    const actionRaw = typeof candidate.action === 'string'
      ? candidate.action.trim().toLowerCase()
      : '';

    const goalStateReachedValue = candidate.goalStateReached ?? candidate.goal_state_reached;
    const awaitingUserInputValue = candidate.awaitingUserInput ?? candidate.awaiting_user_input;

    const awaitingUserInput = this.parseBoolean(awaitingUserInputValue, false);

    const handoffSpecValue = (candidate.handoffSpec ?? candidate.handoff_spec) as unknown;
    const hasHandoffSpec = handoffSpecValue !== undefined && handoffSpecValue !== null;

    let action: 'done' | 'continue' | 'handoff';
    if (actionRaw === 'done' || actionRaw === 'continue' || actionRaw === 'handoff') {
      action = actionRaw as 'done' | 'continue' | 'handoff';
    } else if (allowHandoff && hasHandoffSpec) {
      action = 'handoff';
    } else if (awaitingUserInput) {
      action = 'done';
    } else {
      const inferredGoal = this.parseBoolean(goalStateReachedValue, false);
      action = inferredGoal ? 'done' : 'continue';
    }

    if (!allowHandoff && action === 'handoff') {
      action = 'done';
    }

    const response = typeof candidate.response === 'string' ? candidate.response : '';
    const goalStateReachedDefault = action === 'done' || action === 'handoff';
    const goalStateReached = action === 'continue'
      ? false
      : this.parseBoolean(goalStateReachedValue, goalStateReachedDefault);

    const normalized: Record<string, unknown> = {
      action,
      response,
      goalStateReached,
      awaitingUserInput,
      handoffSpec: action === 'handoff' && allowHandoff ? handoffSpecValue : null,
    };

    if (schemaId === 'goal_driven') {
      const workDoneValue = candidate.work_done ?? candidate.workDone;
      if (typeof workDoneValue === 'string') {
        normalized.work_done = workDoneValue;
      } else if (response) {
        normalized.work_done = response;
      } else {
        normalized.work_done = '';
      }
    }

    return normalized;
  }

  private parseActionOutputLenient(
    schemaId: string,
    parsed: Record<string, unknown>,
    content: string
  ): Record<string, unknown> | null {
    if (schemaId !== 'agent_action' && schemaId !== 'goal_driven' && schemaId !== 'planner_output') {
      return null;
    }

    const candidates = [parsed, ...this.extractJsonCandidates(content)];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const normalized = this.normalizeActionOutputCandidate(candidate as Record<string, unknown>, schemaId);
      if (normalized) return normalized;
    }
    return null;
  }

  private tryParseJsonCandidate(value: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }

  private extractJsonCandidates(content: string): Record<string, unknown>[] {
    if (!content) return [];
    const results: Record<string, unknown>[] = [];

    const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
    let match: RegExpExecArray | null;
    while ((match = fenceRegex.exec(content)) !== null) {
      const candidate = match[1]?.trim();
      if (!candidate) continue;
      const parsed = this.tryParseJsonCandidate(candidate);
      if (parsed) results.push(parsed);
    }

    let inString = false;
    let escaped = false;
    let depth = 0;
    let start = -1;

    for (let i = 0; i < content.length; i++) {
      const ch = content[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
        continue;
      }

      if (ch === '}' && depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          const candidate = content.slice(start, i + 1);
          const parsed = this.tryParseJsonCandidate(candidate);
          if (parsed) results.push(parsed);
          start = -1;
        }
      }
    }

    return results;
  }

  private parseStructuredOutput(content: string, result: MutableAgentResult): Record<string, unknown> | null {
    const raw = coerceStructuredOutput(content);
    if (!raw) return null;

    // Unwrap "result" envelope added by zodToJsonSchema for union schemas.
    // OpenAI Structured Outputs requires root type: "object", so unions
    // get wrapped in { result: <actual output> }.
    const parsed = unwrapStructuredOutput(raw);

    if (!this.config.outputSchema) {
      return parsed;
    }

    if (this.config.parseOutput) {
      const normalized = this.config.parseOutput(parsed, content);
      if (normalized) {
        return normalized;
      }
      result.terminationReason = 'invalid_action';
      result.error = `Structured output parsing failed for ${this.config.type}.`;
      return null;
    }

    const schemaId = this.resolveOutputSchemaId();
    if (!schemaId) {
      result.terminationReason = 'invalid_action';
      result.error = `Unknown output schema for ${this.config.type} (schemaId missing or unrecognized).`;
      return null;
    }

    const schema = getOutputSchema(schemaId as keyof typeof OUTPUT_SCHEMAS);
    if (!schema) {
      result.terminationReason = 'invalid_action';
      result.error = `Unknown output schema: ${schemaId}`;
      return null;
    }

    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      if (schemaId === 'planner_output') {
        const fallback = this.coercePlannerOutputFromSpec(parsed);
        if (fallback) {
          console.warn('[agent] Coerced planner output from raw handoffSpec object (missing action).');
          return fallback;
        }
      }

      const lenient = this.parseActionOutputLenient(schemaId, parsed, content);
      if (lenient) {
        console.warn(`[agent] Leniently parsed ${schemaId} structured output after validation failure.`);
        return lenient;
      }

      const issues = validated.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
      result.terminationReason = 'invalid_action';
      result.error = `Structured output failed ${schemaId} validation: ${issues}`;
      return null;
    }

    return validated.data as Record<string, unknown>;
  }

  private coercePlannerOutputFromSpec(parsed: Record<string, unknown>): Record<string, unknown> | null {
    if (!this.isHandoffSpecCandidate(parsed)) return null;

    const workItems = parsed.workItems.length;
    const response = workItems > 0
      ? `Planner produced ${workItems} work items.`
      : 'Planner produced handoffSpec.';

    return {
      action: 'handoff',
      response,
      goalStateReached: true,
      awaitingUserInput: false,
      handoffSpec: parsed,
    };
  }

  private isHandoffSpecCandidate(parsed: unknown): parsed is HandoffSpec {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const spec = parsed as Record<string, unknown>;

    if ('action' in spec) return false;
    if (typeof spec.goal !== 'string' || spec.goal.trim().length === 0) return false;
    if (typeof spec.context !== 'string') return false;
    if (!Array.isArray(spec.workItems)) return false;

    for (const item of spec.workItems) {
      if (!item || typeof item !== 'object') return false;
      const entry = item as Record<string, unknown>;

      if (typeof entry.id !== 'string' || entry.id.trim().length === 0) return false;
      if (typeof entry.objective !== 'string' || entry.objective.trim().length === 0) return false;
      if (typeof entry.delta !== 'string' || entry.delta.trim().length === 0) return false;
      if (typeof entry.agent !== 'string' || entry.agent.trim().length === 0) return false;

      if (entry.targetPaths !== undefined) {
        if (!Array.isArray(entry.targetPaths) || !entry.targetPaths.every(p => typeof p === 'string')) {
          return false;
        }
      }

      if (entry.dependencies !== undefined) {
        if (!Array.isArray(entry.dependencies) || !entry.dependencies.every(d => typeof d === 'string')) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Extract action from structured output.
   */
  private extractStructuredAction(
    structuredOutput: Record<string, unknown> | null
  ): AgentAction | null {
    if (!structuredOutput) return null;
    const raw = structuredOutput.action;
    if (typeof raw !== 'string') return null;
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'done') return 'done';
    if (normalized === 'continue') return 'continue';
    if (normalized === 'handoff') return 'handoff';
    return null;
  }

  /**
   * Extract response text from structured output.
   * Handles LLMs that output literal \n strings instead of actual newlines.
   */
  private extractStructuredResponse(
    structuredOutput: Record<string, unknown> | null
  ): string | undefined {
    if (!structuredOutput) return undefined;
    const raw = structuredOutput.response;
    if (typeof raw !== 'string') return undefined;
    // Unescape literal \n and \t that LLMs sometimes output in JSON response fields
    return raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }

  /**
   * Combine pre-JSON text with parsed response text.
   * Some LLMs (e.g., GLM) output prose before the JSON structured output.
   * This combines both to preserve all user-facing content.
   */
  private combineResponseText(
    preJsonText: string,
    parsedResponseText: string | undefined
  ): string | undefined {
    const pre = preJsonText?.trim() ?? '';
    const parsed = parsedResponseText?.trim() ?? '';

    if (pre && parsed) {
      return `${pre}\n\n${parsed}`;
    }
    if (pre) {
      return pre;
    }
    if (parsed) {
      return parsed;
    }
    return undefined;
  }

  /**
   * Emit llm_call event.
   */
  private emitLlmCall(
    response: { content?: string; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; usage?: { totalTokens: number; promptTokens: number; completionTokens: number; cachedTokens?: number }; model?: string },
    messages: Array<Record<string, unknown>>,
    durationMs: number,
    tools: ToolDefinition[],
    maxWindowSize: number,
    workItemId?: string
  ): void {
    const content = response.content ?? '';
    const toolCalls = response.toolCalls ?? [];

    this.emit(createEvent('llm_call', {
      agentType: this.config.type,
      provider: this.llmConfig.provider ?? 'unknown',
      promptPreview: this.getPromptPreview(messages),
      responsePreview: content.slice(0, 16000) || this.buildToolCallPreview(toolCalls),
      totalTokens: response.usage?.totalTokens ?? 0,
      promptTokens: response.usage?.promptTokens ?? 0,
      completionTokens: response.usage?.completionTokens ?? 0,
      cachedTokens: response.usage?.cachedTokens,
      maxWindowSize,
      durationMs,
      model: response.model ?? 'unknown',
      toolCallsCount: toolCalls.length,
      toolNames: tools.map((t) => t.name),
      messageCount: messages.length,
    }, workItemId));
  }

  /**
   * Emit llm_error event.
   */
  private emitLlmError(error: Error, workItemId?: string): void {
    const provider = this.llmConfig.provider ?? 'unknown';
    const model = this.llmConfig.model ?? 'unknown';
    this.emit(createEvent('llm_error', {
      agentType: this.config.type,
      provider,
      model,
      error: error.message,
      errorType: this.classifyError(error),
    }, workItemId));
  }

  /**
   * Get preview from messages.
   */
  private getPromptPreview(messages: Array<Record<string, unknown>>): string {
    if (!messages.length) return '';
    const first = messages[0] as { role?: string; content?: string };
    if (first.role === 'system' && typeof first.content === 'string') {
      return first.content.slice(0, 16000);
    }
    return '';
  }

  /**
   * Build preview from tool calls.
   */
  private buildToolCallPreview(
    toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>
  ): string {
    if (!toolCalls.length) return '';
    return `[Tools: ${toolCalls.map((tc) => tc.name).join(', ')}]`;
  }

  /**
   * Synthesize a response from accumulated work in the context.
   * Returns the best available content: existing response, last assistant message, or tool outputs.
   */
  private synthesizePartialResponse(localContext: ContextWindow, existingResponse: string): string {
    // If we already have a response from previous iterations, use it
    if (existingResponse && existingResponse.trim().length > 0) {
      return existingResponse;
    }

    // Try to extract the last assistant message
    const messages = localContext.getItemsByType('message') as Array<{ role: string; content: string | unknown[] }>;
    const assistantMessages = messages.filter(m => m.role === 'assistant');
    if (assistantMessages.length > 0) {
      const lastAssistant = assistantMessages[assistantMessages.length - 1];
      const content = typeof lastAssistant.content === 'string'
        ? lastAssistant.content
        : JSON.stringify(lastAssistant.content);
      if (content && content.trim().length > 0) {
        return content;
      }
    }

    // Fall back to summarizing tool outputs
    const toolOutputs = localContext.getItemsByType('function_call_output') as Array<{ name?: string; output: string; isError?: boolean }>;
    if (toolOutputs.length > 0) {
      const successfulOutputs = toolOutputs.filter(o => !o.isError);
      if (successfulOutputs.length > 0) {
        // Return the last few tool outputs as context
        const recentOutputs = successfulOutputs.slice(-3);
        const summary = recentOutputs.map(o => {
          const preview = o.output.length > 500 ? o.output.slice(0, 500) + '...' : o.output;
          return `${o.name ?? 'tool'}: ${preview}`;
        }).join('\n\n');
        return `Work completed before interruption:\n${summary}`;
      }
    }

    return '';
  }

  /**
   * Classify error type.
   */
  private classifyError(error: Error): string {
    const msg = error.message;
    if (msg.includes('rate limit') || msg.includes('429')) return 'rate_limit';
    if (msg.includes('timeout')) return 'timeout';
    if (msg.includes('circuit')) return 'circuit_open';
    return 'unknown';
  }
}
