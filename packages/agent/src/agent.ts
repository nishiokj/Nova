/**
 * Agent - Pure execution primitive.
 *
 * Receives ContextWindow by value and mutates it locally during execution.
 * Returns AgentResult with all outputs.
 */

import type { LLMAdapter, Message, LLMRequestConfig, LLMResponse } from 'llm';
import {
  resilientCall,
  RateLimitError,
  CircuitOpenError,
  RetriesExhaustedError,
  DEFAULT_RESILIENCE_CONFIG,
} from 'llm';
import type { ToolRegistry } from 'tools';
import type { ToolDefinition, ToolResult, FileContentItem, ArtifactKind, StructuredOutputSchema } from 'types';
import { createEvent, errorResult, successResult } from 'types';
import { buildLLMRequestConfig, coerceStructuredOutput, extractPreJsonText, createMicroQueue, profiler } from 'shared';
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
} from './types.js';
import { noopEmit, noopHookQueue } from './types.js';
import type { AgentRegistry } from './agent-registry.js';
import {
  getProviderCircuitState,
  resetProviderCircuit,
  getCircuitStatus,
} from './circuit-breaker-registry.js';
import { TOOL_LIMITS, getMaxOutputLength, isRefusal } from './constants.js';

// Re-export circuit breaker functions for backwards compatibility
export { resetProviderCircuit, getCircuitStatus };

type AgentAction = 'done' | 'continue' | 'handoff';

/**
 * Model selection override for per-agent-type model configuration.
 */
export interface ModelSelection {
  provider: string;
  model: string;
  reasoning?: string;
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

  constructor(config: AgentConfig, runtime: {
    llm: LLMAdapter;
    toolRegistry: ToolRegistry;
    emit?: EventEmitCallback;
    requestId?: string;
    agentRegistry?: AgentRegistry;
    llmConfig: LLMRequestConfig;
    hooks?: AgentHooks;
    internalHookQueue?: InternalHookQueue;
    getModelSelection?: (agentType: string) => ModelSelection | null;
  }) {
    this.config = config;
    this.llm = runtime.llm;
    this.toolRegistry = runtime.toolRegistry;
    this.emit = runtime.emit ?? noopEmit;
    this.requestId = runtime.requestId ?? '';
    this.agentRegistry = runtime.agentRegistry;
    this.llmConfig = runtime.llmConfig;
    this.hooks = runtime.hooks;
    this.internalHookQueue = runtime.internalHookQueue ?? noopHookQueue;
    this.getModelSelection = runtime.getModelSelection;
  }

  /**
   * Build internal hook context from current state.
   */
  private buildHookContext(workItem: WorkItem): InternalHookContext {
    return {
      workId: workItem.workId,
      agentType: this.config.type,
      sessionKey: this.requestId,
      requestId: this.requestId,
    };
  }

  /**
   * Finalize iteration by capturing filesRead and emitting turn completed.
   */
  private finalizeIteration(
    localReadFiles: Set<string>,
    workItem: WorkItem,
    result: AgentResult,
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
   * Handle awaitingUserInput from structured output.
   * This is a fallback for conversational questions when PromptUser isn't used.
   * Returns true if we should pause for user input, false otherwise.
   */
  private handleAwaitingUserInput(
    result: AgentResult,
    structuredOutput: Record<string, unknown> | null,
    responseText: string | undefined,
    content: string
  ): boolean {
    // Skip if PromptUser already set needsUserInput (it takes precedence)
    if (result.needsUserInput) return false;

    // Check if agent explicitly declared it's waiting for input
    if (structuredOutput?.awaitingUserInput !== true) return false;

    result.needsUserInput = true;
    result.userPrompt = {
      question: responseText || content || 'Waiting for your response...',
    };
    result.terminationReason = 'user_input_required';
    return true;
  }

  /**
   * Handle the 'done' action logic: goal state validation, refusal check, success/failure setup.
   * Returns true if the action was handled and should return/break, false otherwise.
   */
  private handleCompletionAction(
    result: AgentResult,
    responseText: string | undefined,
    content: string,
    action: string | null,
    structuredOutput: any
  ): boolean {
    if (action !== 'done') {
      return false;
    }

    const goalReached = structuredOutput?.goalStateReached === true;
    if (!goalReached) {
      result.terminationReason = 'invalid_action';
      result.error = 'Action "done" requires goalStateReached: true.';
      return true; // Should break after this
    }

    const finalText = responseText ?? content;
    if (isRefusal(finalText)) {
      result.isRefusal = true;
      result.error = 'LLM refused to complete the task';
      result.terminationReason = 'refusal';
    } else {
      result.success = true;
      result.response = finalText;
      result.terminationReason = 'goal_state_reached';
    }

    return true;
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

    // Wrap the streaming operation in resilientCall
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
        config: {
          ...DEFAULT_RESILIENCE_CONFIG,
          maxRetries: 2, // Retry up to 2 times for transient errors
        },
        onRetry: (attempt, error, delayMs) => {
          console.error(`[AGENT] Retrying LLM call (attempt ${attempt}): ${error.message}, waiting ${delayMs}ms`);
          // Note: Not emitting an event here since llm_retry isn't a standard event type
          // The retry is logged to stderr for debugging
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
    const { globalContext, workItem, cwd } = params;
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

    const result: AgentResult = {
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
      await this.executeLoop(globalContext, localContext, workItem, result, metrics, startTime, cwd);
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
      } else if (error instanceof RetriesExhaustedError) {
        // For now, treat retries_exhausted as exception. Phase 3 will unwrap the underlying error.
        result.terminationReason = 'exception';
        result.error = `Retries exhausted after ${error.attempts} attempts: ${message}`;
        console.error(`[AGENT] All retries exhausted after ${error.attempts} attempts: ${message}`);
      } else {
        result.terminationReason = 'exception';
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
      terminationReason: result.terminationReason ?? 'exception',
      filesRead: result.filesRead,
      invalidatedPaths: result.invalidatedPaths,
    }, this.buildHookContext(workItem));

    profiler.asyncEnd(`agent.run:${this.config.type}`, runAsyncId, 'agent', {
      success: result.success,
      terminationReason: result.terminationReason,
      llmCalls: metrics.llmCallsMade,
      toolCalls: metrics.toolCallsMade,
    });

    return result;
  }

  /**
   * Main execution loop.
   */
  private async executeLoop(
    globalContext: ContextWindow,
    localContext: ContextWindow,
    workItem: WorkItem,
    result: AgentResult,
    metrics: AgentMetrics,
    startTime: number,
    cwd: string
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
      await this.autoReadTargetFiles(workItem.targetPaths, localContext, localReadFiles, metrics, cwd);
    }

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      profiler.instant(`agent.iteration:${iteration}`, 'agent', 'p', { agentType: this.config.type });

      // Check for user stop request at the start of each iteration
      if (this.hooks?.shouldStop?.()) {
        result.terminationReason = 'user_stopped';
        break;
      }

      const elapsedMs = Date.now() - startTime;

      // Auto-compact if context is near full
      if (localContext.isNearFull()) {
        let compactResult = { itemsRemoved: 0, outputsTruncated: 0, bytesRecovered: 0, fileContentRemoved: 0 };
        try {
          compactResult = await localContext.compactWithLedger({
            llm: this.llm,
            llmConfig: this.llmConfig,
            targetReductionRatio: 0.66,
            preserveRecentItems: 12,
            deduplicateByPath: true,
            truncateOutputsTo: 4000,
          });
        } catch {
          compactResult = localContext.compact({
            deduplicateByPath: true,
            truncateOutputsTo: 4000,
          });
        }
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

      if (metrics.toolCallsMade >= workItem.bounds.maxToolCalls) {
        result.terminationReason = 'bounds:tool_calls';
        this.emit(createEvent('agent_bounds_hit', {
          agentType: this.config.type,
          boundType: 'tool_calls',
          current: metrics.toolCallsMade,
          max: workItem.bounds.maxToolCalls,
        }, workItem.workId));
        break;
      }

      if (elapsedMs >= workItem.bounds.maxDurationMs) {
        result.terminationReason = 'bounds:duration';
        this.emit(createEvent('agent_bounds_hit', {
          agentType: this.config.type,
          boundType: 'duration',
          current: elapsedMs,
          max: workItem.bounds.maxDurationMs,
        }, workItem.workId));
        break;
      }

      const systemMessage = this.buildSystemMessage(workItem, cwd);

      const allTools = [
        ...this.toolRegistry.getDefinitions(),
        ...(this.agentRegistry?.listToolDefinitions() ?? []),
      ];
      const allowedTools = this.filterAllowedTools(allTools);

      const messages = this.buildMessages(systemMessage, workItem, globalContext, localContext);

      // On the last iteration, withhold tools to force the LLM to synthesize a response
      // This ensures the agent produces a meaningful final response before hitting iteration limit
      const isLastIteration = iteration === maxIterations - 1;
      const toolsForThisCall = allowedTools.length > 0 ? allowedTools : undefined;
      const toolChoiceForThisCall = isLastIteration && toolsForThisCall ? 'none' as const : undefined;


      const llmStartTime = Date.now();
      // Don't stream raw chunks when using structured output (they're JSON garbage)
      // The extracted response field will be emitted after parsing
      const hasStructuredOutput = !!this.config.outputSchema;

      // Use resilient streaming with retry + circuit breaker
      const llmAsyncId = profiler.asyncBegin(`agent.llmCall:${this.config.type}`, 'llm');
      const { response, buffer } = await this.streamWithResilience(
        {
          messages: messages as unknown as Message[],
          tools: toolsForThisCall,
          toolChoice: toolChoiceForThisCall,
          responseSchema: this.config.outputSchema,
          onChunk: (chunk) => {
            if (hasStructuredOutput) return; // Skip raw JSON streaming
            this.emit(createEvent('agent_message', {
              agentType: this.config.type,
              message: chunk,
            }, workItem.workId));
          },
          onReasoningChunk: (chunk) => {
            this.emit(createEvent('agent_reasoning', {
              agentType: this.config.type,
              content: chunk,
            }, workItem.workId));
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

      this.emitLlmCall(response, messages, llmDurationMs, allowedTools, workItem.workId);

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

      // Add reasoning content to context for multi-turn salience (GLM-4.7)
      // This preserves the thinking trace across turns so the model can reference it
      if (response.reasoningContent) {
        localContext.addReasoning(response.reasoningContent);
      }

      const structuredOutput = this.parseStructuredOutput(content);
      if (structuredOutput) {
        result.structuredOutput = structuredOutput;
      }

      // Extract artifacts from structured output each iteration (explorer emits these)
      // This allows incremental artifact accumulation rather than only at final response
      if (structuredOutput?.artifacts && Array.isArray(structuredOutput.artifacts)) {
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

        if (validArtifacts.length > 0) {
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
            });
          }
        }
      }

      this.addAssistantMessage(localContext, content, toolCalls);

      const action = this.extractStructuredAction(structuredOutput);
      const parsedResponseText = this.extractStructuredResponse(structuredOutput);

      // For LLMs that output prose before JSON (e.g., GLM), extract that text
      // and combine with the parsed response field for complete display
      const preJsonText = extractPreJsonText(content);
      const responseText = this.combineResponseText(preJsonText, parsedResponseText);

      const emitTurnCompleted = (hasResponse: boolean): void => {
        this.internalHookQueue.enqueue({
          type: 'turn_completed',
          iteration,
          toolCallsMade: metrics.toolCallsMade,
          llmCallsMade: metrics.llmCallsMade,
          hasResponse,
          terminationReason: result.terminationReason || undefined,
        }, this.buildHookContext(workItem));
      };

      // Emit content for TUI display
      // For structured output agents, we skip raw JSON chunk streaming (it's garbage to users).
      // Instead, emit the clean parsed response OR raw content if JSON parsing failed.
      if (hasStructuredOutput) {
        if (responseText && responseText.trim().length > 0) {
          // JSON parsed successfully - emit the clean response field
          this.emit(createEvent('agent_message', {
            agentType: this.config.type,
            message: responseText,
          }, workItem.workId));
        } else if (!structuredOutput && content && content.trim().length > 0) {
          // No JSON parsed but there's text content - emit it (LLM output plain text)
          this.emit(createEvent('agent_message', {
            agentType: this.config.type,
            message: content,
          }, workItem.workId));
        }
      }

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

        if (toolCalls.length > 0) {
          const successCount = metrics.toolCallsSucceeded - toolCallsSucceededBefore;
          const failCount = metrics.toolCallsFailed - toolCallsFailedBefore;
          this.internalHookQueue.enqueue({
            type: 'tool_batch_completed',
            toolNames: toolCalls.map(tc => tc.name),
            successCount,
            failCount,
          }, this.buildHookContext(workItem));
        }

        if (result.needsUserInput || result.terminationReason) {
          this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
          return;
        }

        // Check awaitingUserInput from structured output (fallback for conversational questions)
        if (this.handleAwaitingUserInput(result, structuredOutput, responseText, content as string)) {
          this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
          return;
        }

        // Handle completion after tool calls
        if (this.handleCompletionAction(result, responseText, content as string, action, structuredOutput)) {
          this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
          return;
        }

        // Handle handoff request after tool calls
        if (action === 'handoff') {
          const handoffSpec = typeof structuredOutput?.handoffSpec === 'string'
            ? structuredOutput.handoffSpec
            : null;
          if (handoffSpec) {
            result.needsHandoff = true;
            result.handoffSpec = handoffSpec;
            result.terminationReason = 'handoff_requested';
            this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
            return;
          }
          // No valid handoffSpec provided, continue execution
          this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
          continue;
        }

        // Capture partial response even when continuing (in case we hit bounds later)
        if (responseText && responseText.trim().length > 0) {
          result.response = responseText;
        }

        this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
        continue;
      }

      // Check awaitingUserInput from structured output (fallback for conversational questions)
      if (this.handleAwaitingUserInput(result, structuredOutput, responseText, content as string)) {
        this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
        return;
      }

      // Handle completion action (done)
      if (this.handleCompletionAction(result, responseText, content as string, action, structuredOutput)) {
        this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
        if (result.terminationReason === 'invalid_action') {
          break;
        }
        return;
      }

      // Handle handoff request
      if (action === 'handoff') {
        const handoffSpec = typeof structuredOutput?.handoffSpec === 'string'
          ? structuredOutput.handoffSpec
          : null;
        if (handoffSpec) {
          result.needsHandoff = true;
          result.handoffSpec = handoffSpec;
          result.terminationReason = 'handoff_requested';
          this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
          return;
        }
        // No valid handoffSpec provided, continue execution
        this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
        continue;
      }

      // Handle continue action
      if (action === 'continue') {
        // Capture partial response even when continuing (in case we hit bounds later)
        if (responseText && responseText.trim().length > 0) {
          result.response = responseText;
        }
        this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
        continue;
      }

      // Handle missing action - this happens when models using json_object format
      // (like GLM-4.7) output plain text instead of structured JSON after tool calls.
      // Rather than terminating, treat substantive text as implicit "continue".
      const responseCandidate = responseText ?? content;
      if (responseCandidate.trim().length > 0) {
        result.response = responseCandidate;

        // If we have an output schema configured but no valid action was extracted,
        // the model likely output conversational text instead of JSON.
        // Treat this as implicit "continue" to allow the agent to keep working.
        if (this.config.outputSchema && !action) {
          this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, false);
          continue;
        }
      }

      result.terminationReason = 'no_action';
      const preview = responseCandidate.trim().slice(0, 1000);
      result.error = preview
        ? `LLM response has no tools and no action directive. Response preview: ${preview}`
        : 'LLM response has no tools and no action directive';
      this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
      break;
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
      result.terminationReason = 'iterations_exhausted';
    }

    // For any bounds-related termination, mark as partial success if we have content
    const isBoundsTermination =
      result.terminationReason === 'iterations_exhausted' ||
      result.terminationReason === 'bounds:tool_calls' ||
      result.terminationReason === 'bounds:duration';

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

  private buildSystemMessage(workItem: WorkItem, cwd: string): string {
    const base = this.config.systemPrompt ? `${this.config.systemPrompt}\n\n` : '';
    const contextInfo = buildSystemMessage(
      workItem.goal,
      workItem.objective,
      undefined,
      cwd
    );
    return `${base}${contextInfo}`.trim();
  }

  private filterAllowedTools(allTools: ToolDefinition[]): ToolDefinition[] {
    if (this.config.tools.length === 0) return [];
    const allowed = new Set(this.config.tools.map((t) => t.toLowerCase()));
    return allTools.filter((tool) => allowed.has(tool.name.toLowerCase()));
  }

  /**
   * Build messages array for LLM call.
   * Merges global context (historical) with local context (this turn's work).
   */
  private buildMessages(
    systemMessage: string,
    workItem: WorkItem,
    globalContext: ContextWindow,
    localContext: ContextWindow
  ): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: systemMessage },
    ];

    // Merge global (historical) + local (this turn) items
    const globalItems = globalContext.getItemsForLLM();
    const localItems = localContext.getItemsForLLM();
    const allItems = [...globalItems, ...localItems];

    // Collect all callIds that have outputs - we only want to send function_calls
    // that have matching outputs to avoid OpenAI's "No tool output found" error.
    const callIdsWithOutputs = new Set<string>();
    for (const item of allItems) {
      if (item.type === 'function_call_output') {
        const callId = (item as any).call_id;
        if (callId) callIdsWithOutputs.add(callId);
      }
    }

    // Build context summary from both global and local contexts
    const globalSummary = globalContext.buildContextSummary();
    const localSummary = localContext.buildContextSummary();
    const combinedSummary = [globalSummary, localSummary].filter(Boolean).join('\n');

    const hasUserInput = globalItems.some(
      (item) => item.type === 'message' && (item as any).role === 'user'
    );

    if (!hasUserInput) {
      const objectiveWithContext = combinedSummary
        ? `${combinedSummary}\n\n${workItem.objective}`
        : workItem.objective;
      messages.push({
        role: 'user',
        content: objectiveWithContext,
      });
    } else if (combinedSummary) {
      // Inject context summary even if there's user input
      messages.push({
        role: 'user',
        content: combinedSummary,
      });
    }

    let functionCallCount = 0;
    let functionOutputCount = 0;

    for (const item of allItems) {
      if (item.type === 'message') {
        messages.push({
          role: (item as any).role,
          content: (item as any).content,
        });
      } else if (item.type === 'reasoning') {
        // Pass reasoning items through - formatMessages will attach to assistant messages
        messages.push(item);
      } else if (item.type === 'function_call') {
        // Only include function_calls that have matching outputs
        const callId = (item as any).call_id;
        if (callId && callIdsWithOutputs.has(callId)) {
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
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  ): void {
    if (toolCalls.length > 0) {
      if (content) {
        context.addMessage('assistant', content);
      }
      for (const tc of toolCalls) {
        context.appendItem({
          type: 'function_call',
          callId: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          timestamp: Date.now(),
        });
      }
    } else {
      context.addMessage('assistant', content);
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
    result: AgentResult,
    metrics: AgentMetrics,
    workItem: WorkItem,
    cwd: string,
    workItemId?: string,
    toolRepeatState?: { lastKey: string; lastOutput: string; repeats: number }
  ): Promise<void> {
    const mq = createMicroQueue();
    const allowedTools = new Set(this.config.tools.map((t) => t.toLowerCase()));

    // Build a map from lowercase names to canonical names for case-insensitive lookup
    const canonicalNames = new Map<string, string>();
    for (const toolName of this.config.tools) {
      canonicalNames.set(toolName.toLowerCase(), toolName);
    }
    const pendingParallel: Array<{
      call: { id: string; name: string; arguments: Record<string, unknown> };
      promise: Promise<{ toolResult: ToolResult; toolDurationMs: number }>;
    }> = [];

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
              const maxLen = getMaxOutputLength(call.name);
              const truncatedOutput = rawOutput.length > maxLen
                ? rawOutput.slice(0, maxLen) + `\n... [truncated ${rawOutput.length - maxLen} chars]`
                : rawOutput;
              localContext.addFileContent(readPath, truncatedOutput);
            }
          }
        }

        if ((nameLower === 'write' || nameLower === 'edit') && call.arguments.path) {
          result.invalidatedPaths.push(String(call.arguments.path));
          localReadFiles.delete(String(call.arguments.path));
        }
      } else {
        metrics.toolCallsFailed++;
        if (toolResult.error) {
          result.toolErrors.push(`${call.name}: ${toolResult.error}`);
        }
      }

      // For event emission, include error message for failed tools (output is empty in errorResult)
      const eventResult = toolResult.isSuccess
        ? toolResult.output?.slice(0, 10000)
        : (toolResult.error ?? toolResult.output ?? 'Unknown error').slice(0, 10000);
      this.emit(createEvent('tool_call', {
        toolName: call.name,
        arguments: call.arguments,
        phase: 'completed',
        result: eventResult,
        success: toolResult.isSuccess,
        durationMs: toolDurationMs,
      }, workItemId));

      // Truncate tool outputs at storage to reduce context size
      // File reads get higher limit (30KB) vs general tools (8KB)
      // For failed tools, include the error message so the LLM knows what went wrong
      const rawOutput = toolResult.isSuccess
        ? (toolResult.output ?? '')
        : (toolResult.error ?? toolResult.output ?? 'Unknown error');
      const maxLen = getMaxOutputLength(call.name);
      const truncatedOutput = rawOutput.length > maxLen
        ? rawOutput.slice(0, maxLen) + `\n... [truncated ${rawOutput.length - maxLen} chars]`
        : rawOutput;

      localContext.appendItem({
        type: 'function_call_output',
        callId: call.id,
        output: truncatedOutput,
        isError: !toolResult.isSuccess,
        durationMs: toolDurationMs,
        timestamp: Date.now(),
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
          result.terminationReason = 'stagnation:tool_repeat';
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
        });
        continue;
      }

      // Normalize tool name to canonical form for case-insensitive lookup
      const canonicalName = canonicalNames.get(nameLower) ?? call.name;

      // Intercept Read calls for files already in context
      if (nameLower === 'read') {
        const readPath = call.arguments.path ?? call.arguments.file_path;
        if (typeof readPath === 'string' && localContext.hasReadFile(readPath)) {
          const msg = `File "${readPath}" is already in your context. Look above for its contents instead of re-reading.`;
          localContext.appendItem({
            type: 'function_call_output',
            callId: call.id,
            output: msg,
            isError: false,
            timestamp: Date.now(),
          });
          continue;
        }
      }

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
          relevance: artifact.relevance,
          discoveredBy: artifact.discoveredBy,
        });
      }
    }

    // Transfer file content (sub-agent shouldn't re-read what parent already read)
    if (options.includeFileContent) {
      const fileItems = parentLocalContext.getItemsByType<FileContentItem>('file_content');
      for (const fileItem of fileItems) {
        if (!merged.hasReadFile(fileItem.path)) {
          merged.addFileContent(fileItem.path, fileItem.content, fileItem.language);
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
        });
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
          parentLocalContext.addFileContent(fileItem.path, fileItem.content, fileItem.language);
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
    try {
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
        })));
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
    const payload = {
      agent: agentConfig.type,
      workId: subWorkItem.workId,
      success: subResult.success,
      response: enhancedResponse,
      filesRead: subResult.filesRead ?? [], // Explicit list - do not re-read these
      artifacts: Array.isArray(artifacts) ? artifacts : [], // Full artifact content for downstream use
      error: subResult.error,
      postProcessingError, // Non-null if artifact merging failed
      metrics: subResult.metrics,
    };

    if (subResult.success || subResult.needsUserInput) {
      // Even on success, include any post-processing errors in the result
      if (postProcessingError) {
        (payload as Record<string, unknown>).warning = postProcessingError;
      }
      return successResult(call.name, JSON.stringify(payload), 0);
    }

    // Build human-readable error message for failed sub-agents
    // Include key details without requiring JSON parsing
    const errorParts = [
      `Sub-agent '${agentConfig.type}' failed`,
    ];
    // Always include termination reason if we have one
    if (subResult.terminationReason) {
      errorParts.push(` (reason: ${subResult.terminationReason})`);
    }
    // Include error details - if missing, note that
    if (subResult.error) {
      errorParts.push(`: ${subResult.error}`);
    } else if (subResult.terminationReason === 'exception') {
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
    cwd: string
  ): Promise<void> {
    const allowedTools = new Set(this.config.tools.map((t) => t.toLowerCase()));
    if (!allowedTools.has('read')) {
      return;
    }

    for (const targetPath of targetPaths) {
      if (localReadFiles.has(targetPath)) continue;

      try {
        metrics.toolCallsMade++;
        const result = await this.toolRegistry.execute('Read', { path: targetPath }, { cwd });
        if (result.isSuccess) {
          localReadFiles.add(targetPath);
          metrics.toolCallsSucceeded++;

          const fileContent = typeof result.output === 'string'
            ? result.output
            : JSON.stringify(result.output);

          // Truncate file content at context storage (30KB limit for reads)
          const truncated = fileContent.length > TOOL_LIMITS.MAX_FILE_READ_OUTPUT_LENGTH
            ? fileContent.slice(0, TOOL_LIMITS.MAX_FILE_READ_OUTPUT_LENGTH) + `\n... [truncated ${fileContent.length - TOOL_LIMITS.MAX_FILE_READ_OUTPUT_LENGTH} chars]`
            : fileContent;
          localContext.addFileContent(targetPath, truncated);
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
  private parseStructuredOutput(content: string): Record<string, unknown> | null {
    const parsed = coerceStructuredOutput(content);
    if (!this.config.outputSchema) {
      if (parsed && typeof parsed.action === 'string') {
        return parsed;
      }
      return null;
    }
    return parsed;
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
    workItemId?: string
  ): void {
    const content = response.content ?? '';
    const toolCalls = response.toolCalls ?? [];

    this.emit(createEvent('llm_call', {
      agentType: this.config.type,
      provider: this.llmConfig.provider ?? 'unknown',
      promptPreview: this.getPromptPreview(messages),
      responsePreview: content.slice(0, 4000) || this.buildToolCallPreview(toolCalls),
      totalTokens: response.usage?.totalTokens ?? 0,
      promptTokens: response.usage?.promptTokens ?? 0,
      completionTokens: response.usage?.completionTokens ?? 0,
      cachedTokens: response.usage?.cachedTokens,
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
      return first.content.slice(0, 4000);
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
