/**
 * Agent - Pure execution primitive.
 *
 * Receives ContextWindow by value and mutates it locally during execution.
 * Returns AgentResult with all outputs.
 */

import path from 'node:path';
import { Effect, Stream } from 'effect';
import type { LLMAdapter, LLMRequestConfig, LLMResponse } from 'llm';
import {
  resilientCall,
  RateLimitError,
  CircuitOpenError,
  RetriesExhaustedError,
  TimeoutError,
  DEFAULT_RESILIENCE_CONFIG,
  getProviderCircuitState,
  vocabForProvider,
} from 'llm';
import { getAgentPrompt } from './prompts.js';
import { MemoryBridge } from './memory-bridge.js';
import type { MemoryInjector } from './memory-bridge.js';
import type { ToolRegistry } from 'tools';
import type { ToolDefinition, ToolResult, FileContentItem, ArtifactKind, StructuredOutputSchema, ContextItem, ArtifactItem, LLMItem, ContentBlock } from 'types';
import { isLLMMessageItem, isLLMFunctionCallItem, isLLMFunctionCallOutputItem } from 'types';
import { createEvent, errorResult, successResult } from 'types';
import { buildLLMRequestConfig, coerceStructuredOutput, extractPreJsonText, profiler, StreamingJsonExtractor, getOutputSchema, OUTPUT_SCHEMAS, unwrapStructuredOutput } from 'shared';
import { ContextWindow, buildSystemMessage } from 'context';
import type { WorkItem } from 'types';
import { createWorkItem } from 'types';
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
  AgentControlDirective,
} from './types.js';
import { noopEmit, noopHookQueue } from './types.js';
import type { AgentRegistry } from './agent-registry.js';
import { truncateToolOutput, isRefusal } from './constants.js';
import { DEFAULT_AGENT_BUDGET } from './types.js';

const MAX_SCHEMA_REMINDER_RETRIES = 3;

type AgentAction = 'done' | 'continue';

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
    questions: [{
      question,
      context: context.length > 0 ? context : undefined,
    }],
  };
}

/** Shape of a raw artifact from LLM structured output. */
interface RawArtifact {
  sourcePath: string;
  line?: number | null;
  kind: string;
  name: string;
  signature?: string | null;
  modifies?: string[] | null;
  calls?: string[] | null;
  insight?: string | null;
  reduces?: string | null;
}

function isValidRawArtifact(a: unknown): a is RawArtifact {
  return (
    typeof a === 'object' &&
    a !== null &&
    typeof (a as Record<string, unknown>).sourcePath === 'string' &&
    typeof (a as Record<string, unknown>).kind === 'string' &&
    typeof (a as Record<string, unknown>).name === 'string'
  );
}

function mapRawArtifact(a: RawArtifact, discoveredBy: string, workItemId?: string): {
  sourcePath: string; line?: number; kind: ArtifactKind; name: string;
  signature?: string; modifies?: string[]; calls?: string[]; insight?: string;
  reduces?: 'structural' | 'relational' | 'behavioral' | 'contractual';
  relevance: number; discoveredBy: string; workItemId?: string;
} {
  return {
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
    discoveredBy,
    workItemId,
  };
}

/**
 * Model selection override for per-agent-type model configuration.
 */
export interface ModelSelection {
  provider: string;
  model: string;
  contextWindow: number;
  reasoning?: string;
  apiKey?: string;
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
  private memoryBridge?: MemoryBridge;
  private sessionKey: string;

  private sanitizeContextPathSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]/g, '_');
  }

  private resolveLocalContextFilePath(globalContext: ContextWindow, workItemId: string): string | undefined {
    if (!globalContext.filePath) return undefined;
    const sessionDir = path.dirname(globalContext.filePath);
    const safe = (v: string) => this.sanitizeContextPathSegment(v);
    return path.join(sessionDir, 'work-contexts', `${safe(this.requestId || 'request')}__${safe(this.config.type || 'agent')}__${safe(workItemId || 'work')}.md`);
  }

  private resolveLocalContextMaxTokens(): number {
    const contextWindow = Math.trunc(this.llmConfig.contextWindow);
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
      throw new Error(`Context window missing for model '${this.llmConfig.model}'`);
    }
    return contextWindow;
  }

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
    if (runtime.memoryInjector) {
      this.memoryBridge = new MemoryBridge(runtime.memoryInjector, {
        sessionKey: this.sessionKey,
        requestId: this.requestId,
        agentType: this.config.type,
        emit: this.emit,
        hookQueue: this.internalHookQueue,
      });
    }
  }

  private emitAgentDiagnostic(message: string, workItemId?: string): void {
    this.emit(createEvent('agent_progress', {
      agentType: this.config.type,
      category: 'diagnostic',
      message,
    }, workItemId, this.requestId, this.sessionKey));
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

  /**
   * Resolve runtime control into a typed directive for loop/tool phases.
   */
  private resolveControlDirective(
    signal?: AbortSignal,
    runControl?: AgentRunParams['runControl']
  ): AgentControlDirective {
    if (signal?.aborted) {
      return {
        action: 'stop',
        source: 'signal',
        reason: 'Execution aborted by signal',
        terminationReason: 'user_stopped',
      };
    }

    const state = runControl?.control.state;
    if (state === 'cancelling' || state === 'cancelled') {
      return {
        action: 'stop',
        source: 'run_control',
        reason: runControl?.control.cancellation?.reason ?? 'Execution cancelled by runtime control',
        terminationReason: 'user_stopped',
      };
    }

    return { action: 'continue' };
  }

  /**
   * Apply an out-of-band control directive to the mutable result.
   * Returns true when loop/tool execution should stop immediately.
   */
  private applyControlDirective(
    result: MutableAgentResult,
    directive: AgentControlDirective
  ): boolean {
    if (directive.action === 'continue') {
      return false;
    }

    result.terminationReason = directive.terminationReason ?? 'user_stopped';
    result.error = directive.reason ?? 'Execution stopped';
    return true;
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
      terminationReason: result.terminationReason ?? undefined,
    }, this.buildHookContext(workItem));
  }

  /**
   * Check if agent has hit tool call or duration bounds.
   * Emits agent_bounds_hit event if a bound is hit.
   * @returns termination reason if bound hit, null otherwise
   */
  private checkBounds(
    workItem: WorkItem,
    elapsedMs: number
  ): 'max_duration_exceeded' | null {
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

  /** Tracks whether the last agent-level compaction was a no-op */
  private _lastAgentCompactWasNoop = false;

  /**
   * Deep-compact context when critically full.
   * The ContextWindow's internal _maybeAutoCompact handles routine compaction
   * at 50% with generous limits. This is the emergency tier at 80% with tighter
   * limits, and includes a no-op guard to prevent compaction storms.
   */
  private compactIfNeeded(
    localContext: ContextWindow,
    localReadFiles: Set<string>,
    workItem: WorkItem
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      if (!localContext.isNearFull(0.80)) {
        this._lastAgentCompactWasNoop = false;
        return;
      }

      // If last compaction recovered nothing, don't burn cycles scanning again
      if (this._lastAgentCompactWasNoop) return;

      const result = localContext.compact({
        deduplicateByPath: true,
        truncateOutputsTo: 2000,
        maxFileContentCount: 15,
        maxFunctionCallCount: 60,
        maxFunctionCallOutputCount: 60,
      });

      if (result.itemsRemoved === 0 && result.outputsTruncated === 0) {
        this._lastAgentCompactWasNoop = true;
        return;
      }

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
    });
  }

  /**
   * Build the LLM request parameters for an iteration.
   * Consolidates system prompt, tools, messages, and last-iteration handling.
   */
  private buildIterationRequest(
    workItem: WorkItem,
    globalContext: ContextWindow,
    localContext: ContextWindow,
    cwd: string,
    iteration: number,
    maxIterations: number
  ): Effect.Effect<{
    messages: LLMItem[];
    tools: ToolDefinition[] | undefined;
    toolChoice: 'none' | 'auto' | 'required' | undefined;
  }> {
    return Effect.gen(this, function* () {
      const { system, taskContext } = this.buildSystemPromptComponents(workItem, cwd);

      const allTools = [
        ...this.toolRegistry.getDefinitions(),
        ...(this.agentRegistry?.listToolDefinitions() ?? []),
      ];
      const allowedTools = this.filterAllowedTools(allTools);

      const isLastIteration = iteration === maxIterations - 1;
      const isPenultimateIteration = iteration === maxIterations - 2 && maxIterations > 2;
      const isExplorer = this.config.type === 'explorer';

      let lastIterationInstruction = '';
      if (isLastIteration) {
        lastIterationInstruction = '\n\nIMPORTANT: This is your final iteration. You must NOT make any tool calls. Synthesize your response and provide a comprehensive answer using the information you have gathered. Use action: "done" when finished.';
        if (isExplorer) {
          lastIterationInstruction += ' You MUST include artifacts in your structured output for every file you have read. Each file MUST produce at least one artifact with sourcePath, kind, and name. Failure to include artifacts is a hard validation failure.';
        }
      } else if (isPenultimateIteration && isExplorer) {
        lastIterationInstruction = '\n\nWARNING: You have ONE iteration remaining after this one. On your final iteration you will NOT be able to make tool calls. You MUST produce artifacts for all files you have read in your next response. If you have not yet extracted artifacts, include them NOW. Every file read without a corresponding artifact is a validation failure.';
      }

      // Memory injection (recent conversations + evidence retrieval)
      const memoryContent = this.memoryBridge
        ? yield* this.memoryBridge.inject(workItem, globalContext, taskContext, cwd, iteration)
        : null;
      const contextWithMemory = memoryContent ? `${taskContext}\n\n${memoryContent}` : taskContext;

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
    });
  }

  /**
   * Resolve the action from structured output into a loop control directive.
   * Sets result fields as side effects (terminationReason, success, response, etc.)
   * @returns loop control: 'done' | 'user_input' | 'continue' | 'no_action'
   */
  private resolveAction(
    action: AgentAction | null,
    structuredOutput: Record<string, unknown> | null,
    responseText: string | undefined,
    content: string,
    result: MutableAgentResult
  ): 'done' | 'user_input' | 'continue' | 'no_action' {
    const avoidRawStructured = !!this.config.outputSchema;
    const contentFallback = avoidRawStructured && (structuredOutput || coerceStructuredOutput(content))
      ? ''
      : content;
    const structuredFallback = this.extractStructuredFallbackResponse(structuredOutput);

    // Check awaitingUserInput first (fallback for conversational questions)
    if (!result.needsUserInput && structuredOutput?.awaitingUserInput === true) {
      result.needsUserInput = true;
      result.userPrompt = {
        questions: [{
          question: responseText ?? contentFallback,
        }],
      };
      result.terminationReason = 'user_input_required';
      return 'user_input';
    }

    // If PromptUser already set needsUserInput, honor it
    if (result.needsUserInput) {
      return 'user_input';
    }

    // When streaming, responseText may be stripped. Use structuredOutput.response as fallback.
    const structuredResponseDirect = typeof structuredOutput?.response === 'string'
      ? (structuredOutput.response)
      : '';

    const shouldInferUserPrompt = action !== 'done' || structuredOutput?.goalStateReached !== true;
    if (shouldInferUserPrompt) {
      const responseCandidate = (responseText ?? contentFallback).trim();
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

      // When streaming is active, responseText is intentionally stripped to avoid
      // double TUI output. Fall back to structuredOutput.response (the canonical
      // response that was already streamed) before using structuredFallback, so that
      // downstream validation (refusal, planning-speak) sees the actual response.
      const primaryCandidate = (responseText ?? contentFallback).trim();
      const finalText = primaryCandidate
        ? (responseText ?? contentFallback)
        : structuredResponseDirect.trim();
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



    // Handle continue action
    if (action === 'continue') {
      const continueText = responseText?.trim() ? responseText
        : (structuredResponseDirect.trim() || structuredFallback);
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

    const validArtifacts = (structuredOutput.artifacts as unknown[]).filter(isValidRawArtifact);

    for (const a of validArtifacts) {
      localContext.addArtifact(mapRawArtifact(a, this.config.type, workItemId), workItemId);
    }

    return validArtifacts.length;
  }

  /**
   * Explorer fallback: if files were read but no artifact was produced for a path,
   * synthesize a minimal summary artifact so downstream agents can still reason
   * from concrete file-level findings.
   */
  private synthesizeExplorerArtifactsFromReadFiles(
    localReadFiles: Set<string>,
    localContext: ContextWindow,
    workItemId?: string
  ): number {
    if (this.config.type !== 'explorer' || localReadFiles.size === 0) {
      return 0;
    }

    const coveredPaths = new Set(localContext.getArtifacts().map((artifact) => artifact.sourcePath));
    const synthesizedArtifacts: {
      sourcePath: string;
      kind: ArtifactKind;
      name: string;
      discoveredBy: string;
      insight: string;
    }[] = [];

    for (const sourcePath of localReadFiles) {
      if (coveredPaths.has(sourcePath)) {
        continue;
      }

      const baseName = path.basename(sourcePath).trim();
      synthesizedArtifacts.push({
        sourcePath,
        kind: 'summary',
        name: baseName.length > 0 ? baseName : sourcePath,
        discoveredBy: this.config.type,
        insight: 'Fallback summary synthesized because explorer output omitted structured artifacts.',
      });
      coveredPaths.add(sourcePath);
    }

    if (synthesizedArtifacts.length === 0) {
      return 0;
    }

    localContext.addArtifacts(synthesizedArtifacts, workItemId);
    return synthesizedArtifacts.length;
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

    const fallbackResponse = responseText?.trim() ?? this.extractStructuredFallbackResponse(structuredOutput);
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
   * Returns final response on success, throws on unrecoverable error.
   */
  private streamWithResilience(
    params: {
      messages: LLMItem[];
      tools?: ToolDefinition[];
      toolChoice?: 'none' | 'auto' | 'required';
      responseSchema?: StructuredOutputSchema;
      onChunk?: (chunk: string) => void;
      onReasoningChunk?: (chunk: string) => void;
    }
  ): Effect.Effect<{ response: LLMResponse }, Error | RateLimitError | CircuitOpenError | TimeoutError | RetriesExhaustedError> {
    const provider = this.llmConfig.provider ?? 'unknown';
    const circuitState = getProviderCircuitState(provider);
    const circuitKey = `${provider}:${this.llmConfig.model}`;

    // Wrap the streaming operation in resilientCall with timeout.
    // We wrap full stream consumption so retry/timeout covers the full LLM operation.
    return resilientCall(
      Effect.gen(this, function* () {
        let response: LLMResponse | undefined;
        let buffer = '';

        const stream = this.llm.stream({
          messages: params.messages,
          tools: params.tools,
          toolChoice: params.toolChoice,
          llm: this.llmConfig,
          responseSchema: params.responseSchema,
          onReasoningChunk: params.onReasoningChunk,
          onComplete: (finalResponse) => {
            response = finalResponse;
          },
        });

        yield* Stream.runForEach(stream, (chunk) =>
          Effect.sync(() => {
            buffer += chunk;
            params.onChunk?.(chunk);
          })
        );

        if (!response) {
          return yield* Effect.fail(new Error('LLM stream completed without a final response'));
        }

        // If content is empty but we have buffered data, use the buffer
        if (!response.content || response.content.length === 0) {
          response = { ...response, content: buffer };
        }

        return { response };
      }),
      {
        circuitState,
        circuitKey,
        timeoutMs: this.config.budget.llmStreamTimeoutMs ?? DEFAULT_AGENT_BUDGET.llmStreamTimeoutMs ?? 240_000,
        operationName: `LLM stream (${this.config.type})`,
        config: {
          ...DEFAULT_RESILIENCE_CONFIG,
          maxRetries: 2, // Retry up to 2 times for transient errors
        },
        onRetry: (attempt, error, delayMs) => {
          this.emitAgentDiagnostic(`Retrying LLM call (attempt ${attempt}): ${error.message}, waiting ${delayMs}ms`);
        },
      }
    );
  }

  /**
   * Execute the agent on a work item.
   * Agent reads from globalContext, writes to its own localContext.
   * GlobalContext is never mutated.
   */
  run(params: AgentRunParams): Effect.Effect<AgentResult> {
    return Effect.gen(this, function* () {
      const { globalContext, workItem, cwd, signal, runControl } = params;
      const runAsyncId = profiler.asyncBegin(`agent.run:${this.config.type}`, 'agent');

      // Create fresh local context for this agent's work
      const localContextFilePath = this.resolveLocalContextFilePath(globalContext, workItem.workId);
      const localContext = new ContextWindow(
        `${globalContext.sessionKey}:${this.config.type}:${workItem.workId}`,
        this.resolveLocalContextMaxTokens(),
        localContextFilePath
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

      yield* this.executeLoop(
        globalContext,
        localContext,
        workItem,
        result,
        metrics,
        startTime,
        cwd,
        signal,
        runControl
      ).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            this.handleLoopError(error, result, localContext, workItem.workId);
          })
        )
      );

      metrics.durationMs = Date.now() - startTime;

      this.synthesizeExplorerArtifactsFromReadFiles(new Set(result.filesRead), localContext, workItem.workId);

      // Bundle artifacts explicitly in result for clear contract
      result.artifacts = localContext.getArtifacts();

      // Explorer produced no artifacts despite reading files — mark incomplete
      // but preserve the response content which is still valuable.
      if (this.config.type === 'explorer' && result.filesRead.length > 0 && result.artifacts.length === 0) {
        result.isIncomplete = true;
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
        const isPlanningSpeak = planningPatterns.some((p) => p.test(responseStart));

        // If the entire response is planning speak with no substantive content, fail
        if (isPlanningSpeak && result.response.length < 500 && !result.response.includes('```')) {
          result.success = false;
          result.terminationReason = 'no_action';
          result.error = `Response is planning text, not actual work: "${responseStart.slice(0, 100)}..."`;
          this.emitAgentDiagnostic('Validation failure: response is planning-speak, not actual output', workItem.workId);
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
    });
  }

  /**
   * Main execution loop.
   */
  private executeLoop(
    globalContext: ContextWindow,
    localContext: ContextWindow,
    workItem: WorkItem,
    result: MutableAgentResult,
    metrics: AgentMetrics,
    startTime: number,
    cwd: string,
    signal?: AbortSignal,
    runControl?: AgentRunParams['runControl']
  ): Effect.Effect<void, Error | RateLimitError | CircuitOpenError | TimeoutError | RetriesExhaustedError> {
    return Effect.gen(this, function* () {
      const maxIterations = Math.min(
        this.config.budget.maxIterations,
        workItem.bounds.maxLlmCalls
      );

      const localReadFiles = new Set(globalContext.getReadFilesArray());
      let consecutiveNoActionNoToolResponses = 0;
      let forceRequiredToolChoice = false;
      this._lastAgentCompactWasNoop = false; // Reset for new execution

      // Auto-read target files
      if (workItem.targetPaths.length > 0) {
        yield* this.autoReadTargetFiles(
          workItem.targetPaths,
          localContext,
          localReadFiles,
          metrics,
          cwd,
          workItem.workId,
          signal,
          runControl
        );
      }

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        profiler.instant(`agent.iteration:${iteration}`, 'agent', 'p', { agentType: this.config.type });

        const loopDirective = this.resolveControlDirective(signal, runControl);
        if (this.applyControlDirective(result, loopDirective)) {
          break;
        }

        // Check for user stop request at the start of each iteration
        if (this.hooks?.shouldStop?.()) {
          result.terminationReason = 'user_stopped';
          break;
        }

        // 1. Pre-checks: bounds and context management
        const elapsedMs = Date.now() - startTime;
        const boundHit = this.checkBounds(workItem, elapsedMs);
        if (boundHit) {
          result.terminationReason = boundHit;
          break;
        }

      yield* this.compactIfNeeded(localContext, localReadFiles, workItem);

      // 2. Build LLM request (async for memory injection)
      const { messages, tools: toolsForThisCall, toolChoice: toolChoiceForThisCall } = yield* this.buildIterationRequest(
        workItem,
        globalContext,
        localContext,
        cwd,
        iteration,
        maxIterations
      );


      const effectiveToolChoice =
        forceRequiredToolChoice && toolChoiceForThisCall !== 'none' && !!toolsForThisCall?.length
          ? 'required' as const
          : toolChoiceForThisCall;

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
      const { response } = yield* this.streamWithResilience({
        messages,
        tools: toolsForThisCall,
        toolChoice: effectiveToolChoice,
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
      });

      const llmDurationMs = Date.now() - llmStartTime;
      profiler.asyncEnd(`agent.llmCall:${this.config.type}`, llmAsyncId, 'llm', {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        toolCalls: response.toolCalls?.length ?? 0,
      });
      metrics.llmCallsMade++;

      this.emitLlmCall(response, messages, llmDurationMs, toolsForThisCall ?? [], localContext.maxTokens, workItem.workId);

      // Update local context metrics with actual token usage from LLM
      const reasoningTokens = response.usage.reasoningTokens ?? 0;
      const visibleCompletionTokens = Math.max(0, response.usage.completionTokens - reasoningTokens);
      localContext.updateMetrics(
        response.usage.promptTokens,
        visibleCompletionTokens,
        response.usage.cachedTokens
      );

      const content = response.content;
      const toolCalls = response.toolCalls ?? [];
      if (toolCalls.length > 0) {
        consecutiveNoActionNoToolResponses = 0;
        forceRequiredToolChoice = false;
      }

      const reasoningContent = response.reasoningContent ?? (streamedReasoningContent ? streamedReasoningContent : undefined);

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
        ? (preJsonText.trim() || undefined)  // Only pre-JSON text, response was already streamed
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

      // 4. Process tools (if any)
      if (toolCalls.length > 0) {
        const preToolDirective = this.resolveControlDirective(signal, runControl);
        if (this.applyControlDirective(result, preToolDirective)) {
          this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
          return;
        }

        const toolCallsSucceededBefore = metrics.toolCallsSucceeded;
        const toolCallsFailedBefore = metrics.toolCallsFailed;

        yield* this.processToolCalls(
          toolCalls,
          globalContext,
          localContext,
          localReadFiles,
          result,
          metrics,
          workItem,
          cwd,
          workItem.workId,
          signal,
          runControl
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

        case 'continue':
          consecutiveNoActionNoToolResponses = 0;
          forceRequiredToolChoice = false;
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
            consecutiveNoActionNoToolResponses = 0;
            forceRequiredToolChoice = false;
            this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, false);
            continue;
          }

          // No tool calls AND no action = inject schema reminder for structured output agents
          if (this.config.outputSchema) {
            consecutiveNoActionNoToolResponses++;
            const isFinalIteration = iteration === maxIterations - 1;
            const preview = responseCandidate.trim().slice(0, 1000);

            if (isFinalIteration || consecutiveNoActionNoToolResponses >= MAX_SCHEMA_REMINDER_RETRIES) {
              result.terminationReason = 'no_action';
              result.error = preview
                ? `LLM produced no tool calls or valid action after ${consecutiveNoActionNoToolResponses} retries. Last response preview: ${preview}`
                : `LLM produced empty output with no tool calls or valid action after ${consecutiveNoActionNoToolResponses} retries.`;
              this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
              return;
            }

            if (toolChoiceForThisCall !== 'none' && toolsForThisCall && toolsForThisCall.length > 0) {
              forceRequiredToolChoice = true;
              localContext.addMessage('user', this.buildRequiredToolCallReminder(toolsForThisCall), workItem.workId);
            }

            const schemaReminder = this.buildSchemaReminder();
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
      const messages = localContext.getItemsByType('message') as { role: string; content: string | unknown[] }[];
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
        const toolCalls = localContext.getItemsByType('function_call') as { name: string }[];
        const toolOutputs = localContext.getItemsByType('function_call_output') as { output: string; isError?: boolean }[];
        if (toolCalls.length > 0) {
          const toolNames = toolCalls.map(t => t.name);
          const successfulOutputs = toolOutputs.filter(o => !o.isError && o.output);
          const summary = `Tool exploration produced partial results. Tools called: ${toolNames.join(', ')}. ` +
            `${successfulOutputs.length} successful results were captured without a final synthesis step.`;
          result.response = summary;
        }
      }
    }

    // Handle exhausted resources - treat as partial success if we have content
    // If terminationReason is unset, we exhausted iterations without a specific termination
    result.terminationReason ??= 'max_iterations_exceeded';

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
    });
  }

  /**
   * Normalize and classify loop/runtime errors to preserve partial progress.
   */
  private handleLoopError(
    error: unknown,
    result: MutableAgentResult,
    localContext: ContextWindow,
    workItemId: string
  ): void {
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
      this.emitAgentDiagnostic(`Rate limit hit for ${error.provider}/${error.model}: ${error.info.message}`, workItemId);
    } else if (error instanceof CircuitOpenError) {
      result.terminationReason = 'circuit_open';
      result.error = message;
      this.emitAgentDiagnostic(`Circuit breaker open: ${message}`, workItemId);
    } else if (error instanceof TimeoutError) {
      result.terminationReason = 'timeout';
      result.error = `LLM call timed out after ${error.timeoutMs}ms`;
      this.emitAgentDiagnostic(`LLM timeout for ${this.config.type}: ${error.timeoutMs}ms`, workItemId);
    } else if (error instanceof RetriesExhaustedError) {
      // Check if underlying cause was a timeout
      const cause = error.cause;
      if (cause instanceof TimeoutError) {
        result.terminationReason = 'timeout';
        result.error = `LLM call timed out after ${cause.timeoutMs}ms (retries exhausted)`;
        this.emitAgentDiagnostic(`LLM timeout after ${error.attempts} retries: ${cause.timeoutMs}ms`, workItemId);
      } else if (cause instanceof RateLimitError) {
        result.terminationReason = 'rate_limit';
        result.error = cause.message;
        result.rateLimitInfo = {
          provider: cause.provider,
          model: cause.model,
          type: cause.info.type,
          retryAfterMs: cause.info.retryAfterMs,
          message: cause.info.message,
        };
        this.emitAgentDiagnostic(`Rate limit persisted after ${error.attempts} attempts for ${cause.provider}/${cause.model}`, workItemId);
      } else {
        result.terminationReason = 'agent_error';
        result.error = `Retries exhausted after ${error.attempts} attempts: ${message}`;
        this.emitAgentDiagnostic(`All retries exhausted after ${error.attempts} attempts: ${message}`, workItemId);
      }
    } else {
      result.terminationReason = 'agent_error';
      // Include stack trace in error message for debugging (truncated to first 5 lines)
      const stackPreview = stack?.split('\n').slice(0, 5).join('\n');
      result.error = stackPreview ? `${message}\n\nStack:\n${stackPreview}` : message;
      this.emitAgentDiagnostic(`Exception in ${this.config.type}: ${message}`, workItemId);
    }

    this.emitLlmError(error instanceof Error ? error : new Error(message), workItemId);

    // Synthesize response from accumulated work if we have any
    // This preserves partial progress when rate limits or other errors interrupt execution
    const accumulatedResponse = this.synthesizePartialResponse(localContext, result.response);
    if (accumulatedResponse) {
      result.response = `${accumulatedResponse}\n\n[Execution interrupted: ${message}]`;
    }
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
      observerStop: result.observerStop,
    };

    if (terminationReason !== 'user_input_required' && result.needsUserInput) {
      throw new Error(`AgentResult invariant violation: needsUserInput=true with terminationReason=${terminationReason}`);
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
          isRefusal: false,
        };
      }
      case 'refusal': {
        return {
          ...base,
          terminationReason,
          needsUserInput: false,
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
          isRefusal: false,
          rateLimitInfo: result.rateLimitInfo,
        };
      }
      case 'goal_state_reached':
      case 'user_stopped':
      case 'max_iterations_exceeded':
      case 'max_tool_calls_exceeded':
      case 'max_duration_exceeded':
      case 'circuit_open':
      case 'timeout':
      case 'agent_error':
      case 'invalid_action':
      case 'no_action':
      case 'observer_stopped':
      case 'observer_work_item_stopped': {
        return {
          ...base,
          terminationReason,
          needsUserInput: false,
          isRefusal: false,
        };
      }
    }
  }

  /**
   * Build system prompt components for caching optimization.
   * Rebuilds the prompt with provider-aware tool vocabulary so the model
   * sees tool names matching its actual tool definitions.
   */
  private buildSystemPromptComponents(workItem: WorkItem, cwd: string): { system: string; taskContext: string } {
    // Rebuild prompt with provider-correct tool names
    const vocab = vocabForProvider(this.llmConfig.provider ?? 'anthropic');
    const basePrompt = getAgentPrompt(this.config.type, vocab);
    const behavioralRules = this.config.envPrompt
      ? `${basePrompt}\n\n${this.config.envPrompt}`
      : basePrompt;

    const { system, taskContext } = buildSystemMessage(
      workItem.goal,
      workItem.objective,
      behavioralRules,
      cwd
    );
    return { system, taskContext };
  }

  private filterAllowedTools(allTools: ToolDefinition[]): ToolDefinition[] {
    if (this.config.tools.length === 0) return [];
    const allowed = new Set(this.config.tools.map((t) => t.toLowerCase()));
    return allTools.filter((tool) => allowed.has(tool.name.toLowerCase()));
  }

  private buildGlobalContextView(globalContext: ContextWindow, workItem: WorkItem): ContextWindow {
    const envNum = (key: string, fallback: number, min = 0) => {
      const v = Number(process.env[key]); return Math.max(min, Number.isFinite(v) ? v : fallback);
    };
    const threshold = envNum('GLOBAL_CONTEXT_FILTER_THRESHOLD', 0.35);
    const maxItems = envNum('GLOBAL_CONTEXT_MAX_ITEMS', 200, 50);
    const maxMessages = envNum('GLOBAL_CONTEXT_MAX_MESSAGES', 16, 6);
    const maxFiles = envNum('GLOBAL_CONTEXT_MAX_FILE_CONTENT', 6, 2);
    const maxArtifacts = envNum('GLOBAL_CONTEXT_MAX_ARTIFACTS', 6, 2);

    if (globalContext.items.length <= maxItems && globalContext.metrics.percentageUsed < threshold) {
      return globalContext;
    }

    const view = ContextWindow.deserialize(globalContext.serialize());
    const items = view.items;
    const norm = (s: string) => s.replace(/\\/g, '/');
    const targets = workItem.targetPaths.map(norm).filter(p => p.length > 0);
    const matchesTarget = (p: string) => {
      const n = norm(p);
      return targets.some(t => n === t || n.endsWith(`/${t}`) || n.startsWith(t));
    };

    const keep = new Set<ContextItem>();

    // Messages: keep system/developer + most recent N user/assistant
    let keptMsgs = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type !== 'message') continue;
      if (item.role === 'system' || item.role === 'developer' || keptMsgs < maxMessages) {
        keep.add(item);
        if (item.role !== 'system' && item.role !== 'developer') keptMsgs++;
      }
    }

    // Files: prefer target-matching, fall back to most recent
    const fileItems = items.filter((i): i is FileContentItem => i.type === 'file_content');
    const keptFiles = (targets.length > 0
      ? fileItems.filter(f => matchesTarget(f.path)).slice(-maxFiles)
      : []
    ).length > 0
      ? fileItems.filter(f => matchesTarget(f.path)).slice(-maxFiles)
      : fileItems.slice(-maxFiles);
    for (const f of keptFiles) keep.add(f);

    const keptPaths = new Set(keptFiles.map(f => f.path));

    // Artifacts: prefer target-matching, fall back to path-matching or most recent
    const artifactItems = items.filter((i): i is ArtifactItem => i.type === 'artifact');
    let keptArtifacts = targets.length > 0
      ? artifactItems.filter(a => matchesTarget(a.sourcePath))
      : artifactItems.slice(-maxArtifacts);
    if (keptArtifacts.length === 0 && keptPaths.size > 0) {
      keptArtifacts = artifactItems.filter(a => keptPaths.has(a.sourcePath));
    }
    for (const a of keptArtifacts) keep.add(a);

    view.filterItems(item => keep.has(item));
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
  ): LLMItem[] {
    const messages: LLMItem[] = [
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
        }
      } else {
        messages.push(item);
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
    toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[],
    workItemId?: string
  ): void {
    if (toolCalls.length > 0) {
      if (content) {
        context.addMessage('assistant', content, workItemId);
      }
      for (const tc of toolCalls) {
        context.addFunctionCall(tc.id, tc.name, tc.arguments, workItemId);
      }
    } else {
      context.addMessage('assistant', content, workItemId);
    }
  }

  /**
   * Apply preToolUse hook, returning effective args or block info.
   */
  private applyPreToolUseHook(
    name: string,
    args: Record<string, unknown>,
  ): Effect.Effect<{ action: 'proceed'; effectiveArgs: Record<string, unknown> } | { action: 'block'; errorMessage: string }, Error> {
    const hook = this.hooks?.preToolUse;
    if (!hook) {
      return Effect.succeed({ action: 'proceed', effectiveArgs: args });
    }
    return Effect.tryPromise({
      try: () => hook(name, args),
      catch: (error) => error instanceof Error ? error : new Error(String(error)),
    }).pipe(
      Effect.map((hookResult) => {
        if (hookResult.action === 'block') {
          return { action: 'block', errorMessage: hookResult.message ?? 'Blocked by hook' } as const;
        }
        if (hookResult.action === 'modify' && hookResult.modifiedArgs) {
          return { action: 'proceed', effectiveArgs: hookResult.modifiedArgs } as const;
        }
        return { action: 'proceed', effectiveArgs: args } as const;
      })
    );
  }

  /**
   * Apply postToolUse hook, returning the (possibly modified) result.
   */
  private applyPostToolUseHook(
    name: string,
    args: Record<string, unknown>,
    toolResult: ToolResult,
  ): Effect.Effect<ToolResult, Error> {
    const hook = this.hooks?.postToolUse;
    if (!hook) {
      return Effect.succeed(toolResult);
    }
    return Effect.tryPromise({
      try: () => hook(name, args, toolResult),
      catch: (error) => error instanceof Error ? error : new Error(String(error)),
    }).pipe(
      Effect.map((hookResult) => {
        if (hookResult.action === 'modify' && hookResult.modifiedResult) {
          return hookResult.modifiedResult;
        }
        return toolResult;
      })
    );
  }

  private executePreparedToolCall(
    prepared: {
      call: { id: string; name: string; arguments: Record<string, unknown> };
      canonicalName: string;
      isAgentTool: boolean;
    },
    workItem: WorkItem,
    globalContext: ContextWindow,
    localContext: ContextWindow,
    cwd: string,
    workItemId?: string,
    signal?: AbortSignal,
    runControl?: AgentRunParams['runControl']
  ): Effect.Effect<{
    call: { id: string; name: string; arguments: Record<string, unknown> };
    isAgentTool: boolean;
    toolResult: ToolResult;
    toolDurationMs: number;
  }> {
    const toolStartTime = Date.now();
    return Effect.gen(this, function* () {
      const { call, canonicalName, isAgentTool } = prepared;
      const preHook = yield* this.applyPreToolUseHook(canonicalName, call.arguments);
      if (preHook.action === 'block') {
        return {
          call,
          isAgentTool,
          toolResult: errorResult(canonicalName, preHook.errorMessage, 0),
          toolDurationMs: Date.now() - toolStartTime,
        };
      }

      const effectiveArgs = preHook.effectiveArgs;
      this.emit(createEvent('tool_call', {
        toolName: canonicalName,
        arguments: effectiveArgs,
        phase: 'starting',
      }, workItemId));

      const normalizedCall = { ...call, name: canonicalName, arguments: effectiveArgs };
      const rawResult = isAgentTool
        ? yield* this.executeAgentToolCall(
            normalizedCall,
            workItem,
            globalContext,
            localContext,
            cwd,
            signal,
            runControl
          )
        : yield* Effect.tryPromise({
            try: () => this.toolRegistry.execute(canonicalName, effectiveArgs, {
              cwd,
              signal,
              execution: runControl?.execution,
              control: runControl?.control,
            }),
            catch: (error) => error instanceof Error ? error : new Error(String(error)),
          });
      const toolResult = yield* this.applyPostToolUseHook(canonicalName, effectiveArgs, rawResult);
      return {
        call,
        isAgentTool,
        toolResult,
        toolDurationMs: Date.now() - toolStartTime,
      };
    }).pipe(
      Effect.catchAll((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const toolResult = errorResult(prepared.canonicalName, message, 0);
        toolResult.output = `Error: ${message}`;
        return Effect.succeed({
          call: prepared.call,
          isAgentTool: prepared.isAgentTool,
          toolResult,
          toolDurationMs: Date.now() - toolStartTime,
        });
      })
    );
  }

  /**
   * Process tool calls.
   */
  private processToolCalls(
    toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[],
    globalContext: ContextWindow,
    localContext: ContextWindow,
    localReadFiles: Set<string>,
    result: MutableAgentResult,
    metrics: AgentMetrics,
    workItem: WorkItem,
    cwd: string,
    workItemId?: string,
    signal?: AbortSignal,
    runControl?: AgentRunParams['runControl']
  ): Effect.Effect<void, Error> {
    interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
    interface PreparedCall {
      call: ToolCall;
      canonicalName: string;
      isAgentTool: boolean;
    }
    type PlannedStep =
      | { type: 'parallel'; calls: PreparedCall[] }
      | { type: 'single'; call: PreparedCall }
      | { type: 'disallowed'; call: ToolCall }
      | { type: 'prompt_invalid'; call: ToolCall }
      | { type: 'prompt'; call: ToolCall; questions: UserPromptQuestion[] };

    return Effect.gen(this, function* () {
      const allowedTools = new Set(this.config.tools.map((t) => t.toLowerCase()));
      const itemWorkId = workItemId ?? workItem.workId;
      const canonicalNames = new Map<string, string>();
      for (const toolName of this.config.tools) {
        canonicalNames.set(toolName.toLowerCase(), toolName);
      }

      const invalidatePath = (pathValue: unknown): void => {
        if (typeof pathValue !== 'string' || pathValue.length === 0) {
          return;
        }
        result.invalidatedPaths.push(pathValue);
        localReadFiles.delete(pathValue);
        localContext.invalidateFileContent(pathValue);
      };

      const recordToolResult = (
        call: ToolCall,
        toolResult: ToolResult,
        toolDurationMs: number,
        isAgentTool: boolean
      ): void => {
        const nameLower = call.name.toLowerCase();
        let addedFileContent = false;
        if (toolResult.isSuccess) {
          metrics.toolCallsSucceeded++;

          if (nameLower === 'read') {
            const readPath = call.arguments.path;
            if (typeof readPath === 'string') {
              localReadFiles.add(readPath);
              if (!localContext.hasReadFile(readPath)) {
                const rawOutput = toolResult.output;
                localContext.addFileContent(readPath, truncateToolOutput(rawOutput, call.name), undefined, workItem.workId);
                addedFileContent = true;
              }
            }
          }

          if (nameLower === 'write' || nameLower === 'edit') {
            invalidatePath(call.arguments.path);
          } else if (nameLower === 'batchedit') {
            const edits = call.arguments.edits;
            if (Array.isArray(edits)) {
              for (const edit of edits) {
                if (!edit || typeof edit !== 'object') continue;
                const editArgs = edit as Record<string, unknown>;
                invalidatePath(editArgs.path);
              }
            }
          }
        } else {
          metrics.toolCallsFailed++;
          if (toolResult.error) {
            result.toolErrors.push(`${call.name}: ${toolResult.error}`);
          }
        }

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

        this.internalHookQueue.enqueue({
          type: 'tool_call_completed',
          tool: call.name,
          args: call.arguments,
          success: toolResult.isSuccess,
          result: auditResult,
          durationMs: toolDurationMs,
        }, this.buildHookContext(workItem));

        const rawOutput = toolResult.isSuccess ? toolResult.output : failureMessage;
        const isReadWithFileContent = nameLower === 'read' && addedFileContent;
        const outputForContext = isReadWithFileContent
          ? `[file content stored in context: ${String(call.arguments.path)}]`
          : truncateToolOutput(rawOutput, call.name);
        localContext.addFunctionCallOutput(call.id, outputForContext, !toolResult.isSuccess, toolDurationMs, itemWorkId);

        if (isAgentTool && result.needsUserInput) {
          result.needsUserInput = false;
          result.userPrompt = undefined;
        }
      };

      const recordDisallowed = (call: ToolCall): void => {
        const message = `Tool "${call.name}" is not allowed for this agent`;
        result.toolErrors.push(message);
        metrics.toolCallsFailed++;
        localContext.addFunctionCallOutput(call.id, message, true, undefined, itemWorkId);
      };

      const plannedSteps: PlannedStep[] = [];
      let parallelBuffer: PreparedCall[] = [];
      const flushParallelBuffer = (): void => {
        if (parallelBuffer.length === 0) return;
        plannedSteps.push({ type: 'parallel', calls: parallelBuffer });
        parallelBuffer = [];
      };

      for (const call of toolCalls) {
        const controlDirective = this.resolveControlDirective(signal, runControl);
        if (this.applyControlDirective(result, controlDirective)) {
          flushParallelBuffer();
          break;
        }

        metrics.toolCallsMade++;
        const nameLower = call.name.toLowerCase();

        if (this.config.tools.length === 0 || !allowedTools.has(nameLower)) {
          flushParallelBuffer();
          plannedSteps.push({ type: 'disallowed', call });
          continue;
        }

        const canonicalName = canonicalNames.get(nameLower) ?? call.name;
        const isAgentTool = this.agentRegistry?.has(canonicalName) ?? false;

        if (nameLower === 'promptuser') {
          flushParallelBuffer();
          const args = call.arguments;
          const questions = Array.isArray(args.questions)
            ? args.questions.filter((q): q is UserPromptQuestion =>
                !!q && typeof q === 'object' && typeof (q as Record<string, unknown>).question === 'string'
              )
            : [];
          if (questions.length === 0) {
            plannedSteps.push({ type: 'prompt_invalid', call });
            continue;
          }
          plannedSteps.push({ type: 'prompt', call, questions });
          break;
        }

        const prepared: PreparedCall = { call, canonicalName, isAgentTool };
        if (!isAgentTool && this.toolRegistry.isParallelSafe(canonicalName)) {
          parallelBuffer.push(prepared);
          continue;
        }

        flushParallelBuffer();
        plannedSteps.push({ type: 'single', call: prepared });
      }
      flushParallelBuffer();

      for (const step of plannedSteps) {
        if (step.type === 'parallel') {
          const executions = yield* Effect.forEach(
            step.calls,
            (prepared) => this.executePreparedToolCall(
              prepared,
              workItem,
              globalContext,
              localContext,
              cwd,
              workItemId,
              signal,
              runControl
            ),
            { concurrency: 'unbounded' }
          );
          for (const execution of executions) {
            recordToolResult(execution.call, execution.toolResult, execution.toolDurationMs, execution.isAgentTool);
          }
          continue;
        }

        if (step.type === 'single') {
          const execution = yield* this.executePreparedToolCall(
            step.call,
            workItem,
            globalContext,
            localContext,
            cwd,
            workItemId,
            signal,
            runControl
          );
          recordToolResult(execution.call, execution.toolResult, execution.toolDurationMs, execution.isAgentTool);
          continue;
        }

        if (step.type === 'disallowed') {
          recordDisallowed(step.call);
          continue;
        }

        if (step.type === 'prompt_invalid') {
          localContext.addFunctionCallOutput(step.call.id, 'PromptUser requires a non-empty questions array', true, undefined, itemWorkId);
          continue;
        }

        result.needsUserInput = true;
        result.userPrompt = { questions: step.questions };
        result.terminationReason = 'user_input_required';
        localContext.addFunctionCallOutput(step.call.id, 'Waiting for user input...', false, undefined, itemWorkId);
        return;
      }
    });
  }

  private createMergedContext(
    globalContext: ContextWindow,
    parentLocalContext: ContextWindow,
    options: { includeArtifacts: boolean; includeFileContent: boolean }
  ): ContextWindow {
    const merged = ContextWindow.deserialize(globalContext.serialize());
    merged.filterItems(item => item.type !== 'function_call' && item.type !== 'function_call_output');

    if (options.includeArtifacts) {
      for (const a of parentLocalContext.getArtifacts()) merged.addArtifact(a, a.workItemId);
    }
    if (options.includeFileContent) {
      for (const f of parentLocalContext.getItemsByType<FileContentItem>('file_content')) {
        if (!merged.hasReadFile(f.path)) merged.addFileContent(f.path, f.content, f.language, f.workItemId);
      }
    }
    return merged;
  }

  private mergeSubAgentResults(parentLocalContext: ContextWindow, subResult: AgentResult): void {
    for (const p of subResult.filesRead) {
      if (typeof p === 'string' && p.length > 0) parentLocalContext.markFileRead(p);
    }

    const subArtifacts = subResult.artifacts ?? subResult.localContext.getArtifacts();
    for (const a of subArtifacts) {
      if (!a.sourcePath || typeof a.name !== 'string') continue;
      const existing = parentLocalContext.getArtifactsByPath(a.sourcePath);
      if (!existing.some(e => e.name === a.name && e.line === a.line)) {
        parentLocalContext.addArtifact(a, a.workItemId);
      }
    }

    for (const f of subResult.localContext.getItemsByType<FileContentItem>('file_content')) {
      if (f.path && typeof f.content === 'string' && !parentLocalContext.hasReadFile(f.path)) {
        parentLocalContext.addFileContent(f.path, f.content, f.language, f.workItemId);
      }
    }
  }

  private executeAgentToolCall(
    call: { id: string; name: string; arguments: Record<string, unknown> },
    parentWorkItem: WorkItem,
    globalContext: ContextWindow,
    parentLocalContext: ContextWindow,
    cwd: string,
    signal?: AbortSignal,
    runControl?: AgentRunParams['runControl']
  ): Effect.Effect<ToolResult> {
    return Effect.gen(this, function* () {
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
        agentConfig = this.agentRegistry.getConfig(call.name);

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

      const args = call.arguments;
      const objective = typeof args.objective === 'string' ? args.objective.trim() : '';
      if (!objective) {
        return errorResult(call.name, 'Missing required argument: objective', 0);
      }

      const goal =
        typeof args.goal === 'string' && args.goal.trim().length > 0
          ? args.goal.trim()
          : parentWorkItem.goal;
      const delta = typeof args.delta === 'string' ? args.delta : undefined;
      const toolHint = typeof args.toolHint === 'string'
        ? args.toolHint
        : undefined;
      const rawTargetPaths = args.targetPaths;
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

      const mergedContextForSubAgent = this.createMergedContext(
        globalContext,
        parentLocalContext,
        { includeArtifacts: true, includeFileContent: true }
      );

      const subResult = yield* agent.run({
        globalContext: mergedContextForSubAgent,
        workItem: subWorkItem,
        cwd,
        signal,
        runControl,
      });

      return this.buildSubAgentToolResult(call, subWorkItem, agentConfig, subResult, parentLocalContext);
    });
  }

  /**
   * Build ToolResult from sub-agent execution, handling post-processing and validation.
   */
  private buildSubAgentToolResult(
    call: { id: string; name: string },
    subWorkItem: WorkItem,
    agentConfig: AgentConfig,
    subResult: AgentResult,
    parentLocalContext: ContextWindow
  ): ToolResult {
    let postProcessingError: string | null = null;

    let enhancedResponse = subResult.response;
    if (!enhancedResponse) {
      const toolOutputs = subResult.localContext.getItemsByType('function_call_output') as {
        output: string;
        isError?: boolean;
        callId?: string;
      }[];
      const toolCalls = subResult.localContext.getItemsByType('function_call') as {
        name: string;
        callId?: string;
        arguments?: Record<string, unknown>;
      }[];

      if (toolOutputs.length > 0) {
        const successfulOutputs = toolOutputs.filter(o => !o.isError && o.output);
        const errorOutputs = toolOutputs.filter(o => o.isError && o.output);
        const outputSummaries: string[] = [];

        for (let i = 0; i < Math.min(successfulOutputs.length, 5); i++) {
          const output = successfulOutputs[i];
          const matchingCall = toolCalls.find(tc => tc.callId === output.callId);
          const toolName = matchingCall?.name ?? 'unknown';
          const truncatedOutput = output.output.length > 2000
            ? output.output.slice(0, 2000) + '... [truncated]'
            : output.output;
          outputSummaries.push(`[${toolName}]: ${truncatedOutput}`);
        }

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

    const artifacts = subResult.structuredOutput?.artifacts;
    const extractedArtifacts: RawArtifact[] = [];

    try {
      if (Array.isArray(artifacts) && artifacts.length > 0) {
        extractedArtifacts.push(...artifacts.filter(isValidRawArtifact));
      }

      if (extractedArtifacts.length === 0) {
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
        parentLocalContext.addArtifacts(extractedArtifacts.map(a =>
          mapRawArtifact(a, agentConfig.type, (a as { workItemId?: string }).workItemId ?? subWorkItem.workId)
        ), subWorkItem.workId);
      }

      this.mergeSubAgentResults(parentLocalContext, subResult);
    } catch (mergeError) {
      const message = mergeError instanceof Error ? mergeError.message : String(mergeError);
      const stack = mergeError instanceof Error ? mergeError.stack : undefined;
      postProcessingError = `Artifact extraction/merging failed: ${message}`;
      this.emitAgentDiagnostic(`Sub-agent post-processing error: ${message}${stack ? `\n${stack}` : ''}`, subWorkItem.workId);
    }

    const filesReadCount = subResult.filesRead.length;
    const artifactCount = extractedArtifacts.length;

    if (agentConfig.type === 'explorer' && filesReadCount > 0 && artifactCount === 0) {
      subResult.isIncomplete = true;
    }

    const responseStreamedToUser = !!agentConfig.outputSchema && !!enhancedResponse;

    const payload = {
      agent: agentConfig.type,
      workId: subWorkItem.workId,
      success: subResult.success,
      response: enhancedResponse,
      responseStreamedToUser,
      filesRead: subResult.filesRead,
      artifacts: Array.isArray(artifacts) ? artifacts : [],
      error: subResult.error,
      postProcessingError,
      metrics: subResult.metrics,
    };

    if (subResult.success || subResult.needsUserInput) {
      if (postProcessingError) {
        (payload as Record<string, unknown>).warning = postProcessingError;
      }
      return successResult(call.name, JSON.stringify(payload), 0);
    }

    return errorResult(call.name, this.formatSubAgentError(agentConfig.type, subResult, enhancedResponse, postProcessingError), 0);
  }

  /**
   * Build human-readable error message for failed sub-agents.
   */
  private formatSubAgentError(
    agentType: string,
    subResult: AgentResult,
    enhancedResponse: string,
    postProcessingError: string | null,
  ): string {
    const friendlyName = agentType
      .split(/[_-]/g)
      .filter((part) => part.length > 0)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
    const parts = [`${friendlyName || 'Sub-agent'} failed`];

    parts.push(` (reason: ${subResult.terminationReason})`);
    if (subResult.error) {
      parts.push(`: ${subResult.error}`);
    } else if (subResult.terminationReason === 'agent_error') {
      parts.push(` - no error message captured, check agent logs`);
    }

    const toolsUsed = subResult.metrics.toolCallsMade;
    if (toolsUsed > 0) {
      parts.push(`\nTools called: ${toolsUsed} (${subResult.metrics.toolCallsSucceeded} succeeded, ${subResult.metrics.toolCallsFailed} failed)`);
    }
    if (subResult.toolErrors.length > 0) {
      parts.push(`\nTool errors: ${subResult.toolErrors.slice(0, 3).join('; ')}${subResult.toolErrors.length > 3 ? '...' : ''}`);
    }
    if (enhancedResponse && enhancedResponse.trim().length > 0) {
      const preview = enhancedResponse.length > 500
        ? enhancedResponse.slice(0, 500) + '... [truncated]'
        : enhancedResponse;
      parts.push(`\nPartial output:\n${preview}`);
    }
    if (postProcessingError) {
      parts.push(`\nPost-processing warning: ${postProcessingError}`);
    }

    return parts.join('');
  }

  /**
   * Auto-read target files before execution.
   */
  private autoReadTargetFiles(
    targetPaths: readonly string[],
    localContext: ContextWindow,
    localReadFiles: Set<string>,
    metrics: AgentMetrics,
    cwd: string,
    workItemId?: string,
    signal?: AbortSignal,
    runControl?: AgentRunParams['runControl']
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const allowedTools = new Set(this.config.tools.map((t) => t.toLowerCase()));
      if (!allowedTools.has('read')) {
        return;
      }

      for (const targetPath of targetPaths) {
        metrics.toolCallsMade++;
        const readResult = yield* Effect.tryPromise({
          try: () => this.toolRegistry.execute('Read', { path: targetPath }, {
            cwd,
            signal,
            execution: runControl?.execution,
            control: runControl?.control,
          }),
          catch: (error) => error instanceof Error ? error : new Error(String(error)),
        }).pipe(Effect.catchAll(() => Effect.succeed<ToolResult | null>(null)));
        if (readResult === null) {
          metrics.toolCallsFailed++;
          continue;
        }
        if (readResult.isSuccess) {
          localReadFiles.add(targetPath);
          metrics.toolCallsSucceeded++;

          const fileContent = typeof readResult.output === 'string'
            ? readResult.output
            : JSON.stringify(readResult.output);

          // Truncate file content at context storage (50KB limit for reads)
          localContext.addFileContent(targetPath, truncateToolOutput(fileContent, 'Read'), undefined, workItemId);
        } else {
          metrics.toolCallsFailed++;
        }
      }
    });
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

  private buildSchemaReminder(): string {
    if (typeof this.config.schemaReminder === 'string' && this.config.schemaReminder.trim().length > 0) {
      return this.config.schemaReminder;
    }

    return `[SCHEMA REMINDER] You must set action, goalStateReached, and awaitingUserInput every turn. action is loop control ("done"|"continue"). goalStateReached is objective completion (true only when objective is complete). awaitingUserInput is blocking state (true only when you need user input). Valid combos: continue/false/false; done/true/false; done/false/true.`;
  }

  private buildRequiredToolCallReminder(tools: ToolDefinition[]): string {
    const toolNames = tools
      .map((tool) => tool.name)
      .filter((name) => typeof name === 'string' && name.trim().length > 0)
      .slice(0, 12);

    const available = toolNames.length > 0 ? toolNames.join(', ') : 'available tools';

    return `[TOOL CALL REQUIRED] Emit at least one actual tool call in your next assistant message. Do not only describe intended actions. If the task is to read a file, call Read with {"path":"..."} immediately. Available tools: ${available}.`;
  }

  private parseBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const n = value.trim().toLowerCase();
      if (n === 'true' || n === '1') return true;
      if (n === 'false' || n === '0') return false;
    }
    return fallback;
  }

  private normalizeActionOutputCandidate(
    candidate: Record<string, unknown>,
    schemaId: string
  ): Record<string, unknown> | null {
    const actionRaw = typeof candidate.action === 'string'
      ? candidate.action.trim().toLowerCase()
      : '';

    const goalStateReachedValue = candidate.goalStateReached ?? candidate.goal_state_reached;
    const awaitingUserInputValue = candidate.awaitingUserInput ?? candidate.awaiting_user_input;

    const response = typeof candidate.response === 'string' ? candidate.response : '';
    const awaitingUserInput = this.parseBoolean(awaitingUserInputValue, false);

    let action: 'done' | 'continue';
    if (actionRaw === 'done' || actionRaw === 'continue') {
      action = actionRaw;
    } else if (awaitingUserInput) {
      action = 'done';
    } else {
      const inferredGoal = this.parseBoolean(goalStateReachedValue, false);
      action = inferredGoal ? 'done' : 'continue';
    }

    // Clamp to valid state combinations.
    if (awaitingUserInput) {
      action = 'done';
    }

    const goalStateReached = action === 'continue'
      ? false
      : (awaitingUserInput ? false : this.parseBoolean(goalStateReachedValue, true));

    const normalized: Record<string, unknown> = {
      action,
      response,
      goalStateReached,
      awaitingUserInput,
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
    if (schemaId === 'explorer') {
      return this.parseExplorerOutputLenient(parsed, content);
    }

    if (schemaId !== 'agent_action' && schemaId !== 'goal_driven') {
      return null;
    }

    const candidates = [parsed, ...this.extractJsonCandidates(content)];
    for (const candidate of candidates) {
      if (typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const normalized = this.normalizeActionOutputCandidate(candidate, schemaId);
      if (normalized) {
        // Preserve artifacts from original output — they are stripped by .strict()
        // Zod validation but still needed for extractArtifactsFromOutput.
        // Individual artifacts are validated downstream by isValidRawArtifact.
        if (Array.isArray(candidate.artifacts)) {
          normalized.artifacts = candidate.artifacts;
        }
        return normalized;
      }
    }
    return null;
  }

  /**
   * Lenient explorer output parser. Salvages action, response, and valid
   * artifacts from output that failed strict Zod validation.
   */
  private parseExplorerOutputLenient(
    parsed: Record<string, unknown>,
    content: string
  ): Record<string, unknown> | null {
    const candidates = [parsed, ...this.extractJsonCandidates(content)];

    for (const candidate of candidates) {
      if (typeof candidate !== 'object' || Array.isArray(candidate)) continue;

      // Must have at least action or artifacts to be useful
      const hasAction = typeof candidate.action === 'string';
      const hasArtifacts = Array.isArray(candidate.artifacts) && candidate.artifacts.length > 0;
      if (!hasAction && !hasArtifacts) continue;

      const normalized = this.normalizeActionOutputCandidate(candidate, 'explorer');
      if (!normalized) continue;

      // Salvage valid artifacts — keep any that have the 3 required fields
      const rawArtifacts = Array.isArray(candidate.artifacts) ? candidate.artifacts : [];
      normalized.artifacts = rawArtifacts.filter(isValidRawArtifact);

      // Carry through metadata with safe defaults
      normalized.packageManagers = Array.isArray(candidate.packageManagers) ? candidate.packageManagers : [];
      normalized.frameworks = Array.isArray(candidate.frameworks) ? candidate.frameworks : [];
      normalized.languages = Array.isArray(candidate.languages) ? candidate.languages : [];
      normalized.os = typeof candidate.os === 'string' ? candidate.os : '';

      return normalized;
    }

    return null;
  }

  private tryParseJsonCandidate(value: string): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(value);
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
      const candidate = match[1].trim();
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

    // Unwrap provider-added envelopes (e.g., adapters that wrap non-object
    // roots as { result: <actual output> } for structured-output constraints).
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
      // Allow plugin-owned/unknown schemas to pass through without Zod validation.
      // Loop control still comes from `action` parsing, and invalid combinations
      // are rejected later (e.g., done requires goalStateReached unless awaitingUserInput).
      return parsed;
    }

    const schema = getOutputSchema(schemaId as keyof typeof OUTPUT_SCHEMAS);
    if (!schema) {
      result.terminationReason = 'invalid_action';
      result.error = `Unknown output schema: ${schemaId}`;
      return null;
    }

    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      const lenient = this.parseActionOutputLenient(schemaId, parsed, content);
      if (lenient) {
        this.emitAgentDiagnostic(`Leniently parsed ${schemaId} structured output after validation failure.`);
        return lenient;
      }

      const issues = validated.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
      result.terminationReason = 'invalid_action';
      result.error = `Structured output failed ${schemaId} validation: ${issues}`;
      return null;
    }

    return validated.data as Record<string, unknown>;
  }

  private extractStructuredAction(output: Record<string, unknown> | null): AgentAction | null {
    if (!output || typeof output.action !== 'string') return null;
    const a = output.action.trim().toLowerCase();
    return a === 'done' || a === 'continue' ? a : null;
  }

  private extractStructuredResponse(output: Record<string, unknown> | null): string | undefined {
    if (!output || typeof output.response !== 'string') return undefined;
    return output.response.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }

  private combineResponseText(preJsonText: string, parsedResponseText: string | undefined): string | undefined {
    const pre = preJsonText.trim();
    const parsed = parsedResponseText?.trim() ?? '';
    return (pre && parsed) ? `${pre}\n\n${parsed}` : (pre || parsed || undefined);
  }

  /**
   * Emit llm_call event.
   */
  private emitLlmCall(
    response: { content?: string; toolCalls?: { name: string; arguments: Record<string, unknown> }[]; usage?: { totalTokens: number; promptTokens: number; completionTokens: number; cachedTokens?: number; reasoningTokens?: number }; model?: string },
    messages: Record<string, unknown>[],
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
      reasoningTokens: response.usage?.reasoningTokens,
      cachedTokens: response.usage?.cachedTokens,
      maxWindowSize,
      durationMs,
      model: response.model ?? 'unknown',
      toolCallsCount: toolCalls.length,
      toolNames: tools.map((t) => t.name),
      messageCount: messages.length,
    }, workItemId));
  }

  private emitLlmError(error: Error, workItemId?: string): void {
    this.emit(createEvent('llm_error', {
      agentType: this.config.type,
      provider: this.llmConfig.provider ?? 'unknown',
      model: this.llmConfig.model,
      error: error.message,
      errorType: this.classifyError(error),
    }, workItemId));
  }

  private getPromptPreview(messages: Record<string, unknown>[]): string {
    const first = messages[0] as { role?: string; content?: string } | undefined;
    return first?.role === 'system' && typeof first.content === 'string' ? first.content.slice(0, 16000) : '';
  }

  private buildToolCallPreview(toolCalls: { name: string }[]): string {
    return toolCalls.length ? `[Tools: ${toolCalls.map(tc => tc.name).join(', ')}]` : '';
  }

  private synthesizePartialResponse(localContext: ContextWindow, existingResponse: string): string {
    if (existingResponse.trim()) return existingResponse;

    const messages = localContext.getItemsByType('message') as { role: string; content: string | unknown[] }[];
    const last = messages.filter(m => m.role === 'assistant').at(-1);
    if (last) {
      const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      if (content.trim()) return content;
    }

    const outputs = (localContext.getItemsByType('function_call_output') as { name?: string; output: string; isError?: boolean }[])
      .filter(o => !o.isError);
    if (outputs.length > 0) {
      const summary = outputs.slice(-3).map(o => `${o.name ?? 'tool'}: ${o.output.slice(0, 500)}`).join('\n\n');
      return `Work completed before interruption:\n${summary}`;
    }
    return '';
  }

  private classifyError(error: Error): string {
    const msg = error.message;
    if (msg.includes('rate limit') || msg.includes('429')) return 'rate_limit';
    if (msg.includes('timeout')) return 'timeout';
    if (msg.includes('circuit')) return 'circuit_open';
    return 'unknown';
  }
}
