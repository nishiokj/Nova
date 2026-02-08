---
session: tui_1770406109268_3bv4q5
created: 2026-02-06T19:28:29.268Z
maxTokens: 200000
fileContentCounter: 0
artifactCounter: 0
---

### message:user
@ts 1770406149909
are workItems persisted or logged anywhere during non-async mode execution? @packages/agent/src/agent.ts

### function_call
@callId call_x9dNQriGAzQIHWNyJMvOUUql
@name Grep
@ts 1770406152754
@workItemId 9e3fd496
{"pattern":"workItems|non-async|async|persist|log","path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","glob":"agent.ts","type":"ts","maxResults":200,"caseSensitive":false}

### function_call_output
@callId call_x9dNQriGAzQIHWNyJMvOUUql
@ts 1770406152765
@durationMs 10
@workItemId 9e3fd496
packages/agent/src/agent.ts:217:35:   * Summarize tool arguments for logging (strip large content, keep paths/patterns).
packages/agent/src/agent.ts:292:11:  private async compactIfNeeded(
packages/agent/src/agent.ts:322:11:  private async buildIterationRequest(
packages/agent/src/agent.ts:814:11:  private async streamWithResilience(
packages/agent/src/agent.ts:832:7:      async () => {
packages/agent/src/agent.ts:889:3:  async run(params: AgentRunParams): Promise<AgentResult> {
packages/agent/src/agent.ts:891:14:    const runAsyncId = profiler.asyncBegin(`agent.run:${this.config.type}`, 'agent');
packages/agent/src/agent.ts:972:12:        // Log full stack to console for detailed debugging
packages/agent/src/agent.ts:1038:52:      // Include response and metrics for workitem log tracking
packages/agent/src/agent.ts:1047:14:    profiler.asyncEnd(`agent.run:${this.config.type}`, runAsyncId, 'agent', {
packages/agent/src/agent.ts:1060:11:  private async executeLoop(
packages/agent/src/agent.ts:1133:32:      // 2. Build LLM request (async for memory injection)
packages/agent/src/agent.ts:1155:16:      const llmAsyncId = profiler.asyncBegin(`agent.llmCall:${this.config.type}`, 'llm');
packages/agent/src/agent.ts:1192:16:      profiler.asyncEnd(`agent.llmCall:${this.config.type}`, llmAsyncId, 'llm', {
packages/agent/src/agent.ts:1225:47:      // Fire agent_message hook for workitem logging (captures actual content + reasoning)
packages/agent/src/agent.ts:1226:66:      // Always emit per turn (even if content is empty) to keep async logs in sync.
packages/agent/src/agent.ts:1839:11:  private async processToolCalls(
packages/agent/src/agent.ts:1928:53:      // Fire tool_call_completed hook for workitem logging (captures args + result preview)
packages/agent/src/agent.ts:1987:27:    const flushParallel = async (): Promise<boolean> => {
packages/agent/src/agent.ts:2097:26:        const promise = (async () => {
packages/agent/src/agent.ts:2325:11:  private async executeAgentToolCall(
packages/agent/src/agent.ts:2566:10:      // Log but don't fail - the sub-agent's response is more important than artifact merging
packages/agent/src/agent.ts:2631:66:      errorParts.push(` - no error message captured, check agent logs`);
packages/agent/src/agent.ts:2658:11:  private async autoReadTargetFiles(
packages/agent/src/agent.ts:2774:90:    const statusText = this.readNestedString(candidate, ['semantic', 'salienceUpdates', 'workItemStatus']);
packages/agent/src/agent.ts:2857:15:        const workItems = candidate.workItems;
packages/agent/src/agent.ts:2858:28:        if (!Array.isArray(workItems) || workItems.length === 0) return null;
packages/agent/src/agent.ts:2859:14:        base.workItems = workItems;
packages/agent/src/agent.ts:3116:11:    const workItems = parsed.workItems.length;
packages/agent/src/agent.ts:3117:22:    const response = workItems > 0
packages/agent/src/agent.ts:3118:29:      ? `Planner produced ${workItems} work items.`
packages/agent/src/agent.ts:3137:29:    if (!Array.isArray(spec.workItems) || spec.workItems.length === 0) return false;
packages/agent/src/agent.ts:3139:29:    for (const item of spec.workItems) {

### function_call
@callId call_1vorjBhsvQ4mzwOZP2IfHkil
@name Read
@ts 1770406156693
@workItemId 9e3fd496
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","encoding":"utf-8","maxBytes":120000,"startLine":880,"endLine":1280}

### function_call
@callId call_wItn0xipmOjlHnLOoMHOK6MD
@name Read
@ts 1770406156693
@workItemId 9e3fd496
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","encoding":"utf-8","maxBytes":120000,"startLine":1800,"endLine":2010}

### function_call
@callId call_qb2Ywnm6Yt4nUnied3eUOm50
@name Read
@ts 1770406156693
@workItemId 9e3fd496
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","encoding":"utf-8","maxBytes":120000,"startLine":2720,"endLine":3180}

### function_call_output
@callId call_1vorjBhsvQ4mzwOZP2IfHkil
@ts 1770406156701
@durationMs 6
@workItemId 9e3fd496
// Lines 880-1280 of 3186 total
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

### function_call_output
@callId call_wItn0xipmOjlHnLOoMHOK6MD
@ts 1770406156701
@durationMs 5
@workItemId 9e3fd496
// Lines 1800-2010 of 3186 total
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
      const eventResult = toolResult.isSuccess
        ? toolResult.output.slice(0, 10000)
        : failureMessage.slice(0, 10000);
      this.emit(createEvent('tool_call', {
        toolName: call.name,
        arguments: call.arguments,
        phase: 'completed',
        result: eventResult,
        success: toolResult.isSuccess,
        durationMs: toolDurationMs,
      }, workItemId));

      // Fire tool_call_completed hook for workitem logging (captures args + result preview)
      this.internalHookQueue.enqueue({
        type: 'tool_call_completed',
        tool: call.name,
        args: this.summarizeToolArgs(call.arguments),
        success: toolResult.isSuccess,
        resultPreview: eventResult?.slice(0, 500),
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


### function_call_output
@callId call_qb2Ywnm6Yt4nUnied3eUOm50
@ts 1770406156702
@durationMs 5
@workItemId 9e3fd496
// Lines 2720-3180 of 3186 total
  private buildSchemaReminder(schemaId: string | null): string {
    if (schemaId === 'watcher_action') {
      return `[SCHEMA REMINDER] For watcher_action output, you MUST return JSON with: action ("done" only), goalStateReached (true), awaitingUserInput (always false), response (short summary), watcherAction (answer|realign|split|create_work_item|quality_gate|allow), reason (always required). Include only the payload for your watcherAction. Do NOT include handoffSpec.`;
    }

    if (schemaId === 'planner_output') {
      return `[SCHEMA REMINDER] You must set action, goalStateReached, awaitingUserInput, and handoffSpec every turn. Valid actions: "done", "continue", "handoff". If you need user input, call PromptUser then action="done", goalStateReached=false, awaitingUserInput=true, handoffSpec=null. For handoff, handoffSpec must be a structured object.`;
    }

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

  private inferBooleanFromText(text?: string): boolean | null {
    if (!text) return null;
    const lower = text.toLowerCase();
    const failurePattern = /(not\s+pass|did\s+not|not\s+achiev|not\s+complete|fail|failed|failure)/;
    if (failurePattern.test(lower)) return false;
    const successPattern = /(pass|passed|approve|approved|success|achiev|complete)/;
    if (successPattern.test(lower)) return true;
    return null;
  }

  private readNestedString(
    value: Record<string, unknown>,
    path: string[]
  ): string | null {
    let current: unknown = value;
    for (const key of path) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
      current = (current as Record<string, unknown>)[key];
    }
    return typeof current === 'string' ? current : null;
  }

  private inferQualityGate(
    candidate: Record<string, unknown>,
    response: string,
    reason: string
  ): { passed: boolean; issues?: string[] } {
    const statusText = this.readNestedString(candidate, ['semantic', 'salienceUpdates', 'workItemStatus']);
    const inferredStatus = this.inferBooleanFromText(statusText ?? undefined);
    const inferredText = this.inferBooleanFromText(`${reason} ${response}`);
    const passed = inferredStatus ?? inferredText ?? false;
    return { passed };
  }

  private normalizeWatcherActionCandidate(
    candidate: Record<string, unknown>
  ): Record<string, unknown> | null {
    const actionRaw = typeof candidate.action === 'string' ? candidate.action.trim().toLowerCase() : '';
    if (actionRaw && actionRaw !== 'done' && actionRaw !== 'continue') return null;
    const normalizedAction = actionRaw === 'continue' || actionRaw.length === 0 ? 'done' : actionRaw;

    const watcherActionValue = typeof candidate.watcherAction === 'string'
      ? candidate.watcherAction
      : typeof (candidate as Record<string, unknown>).watcher_action === 'string'
        ? (candidate as Record<string, unknown>).watcher_action
        : '';
    const watcherActionRaw = typeof watcherActionValue === 'string'
      ? watcherActionValue.trim().toLowerCase()
      : '';
    const validWatcherActions = new Set([
      'answer',
      'realign',
      'split',
      'create_work_item',
      'quality_gate',
      'allow',
      'continue',
    ]);
    if (!validWatcherActions.has(watcherActionRaw)) return null;

    const response = typeof candidate.response === 'string' ? candidate.response : '';
    const reason = typeof candidate.reason === 'string'
      ? candidate.reason
      : response || 'Watcher decision';

    const awaitingUserInputValue = (candidate as Record<string, unknown>).awaitingUserInput
      ?? (candidate as Record<string, unknown>).awaiting_user_input;
    const awaitingUserInput = this.parseBoolean(awaitingUserInputValue, false);
    const goalStateReached = true;

    const base: Record<string, unknown> = {
      action: normalizedAction,
      response,
      goalStateReached,
      awaitingUserInput,
      watcherAction: watcherActionRaw,
      reason,
    };

    if (candidate.semantic && typeof candidate.semantic === 'object' && !Array.isArray(candidate.semantic)) {
      base.semantic = candidate.semantic;
    }

    switch (watcherActionRaw) {
      case 'answer': {
        const answer = candidate.answer;
        if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
        const answerText = (answer as Record<string, unknown>).text;
        if (typeof answerText !== 'string' || answerText.length === 0) return null;
        const contextAddendum = (answer as Record<string, unknown>).contextAddendum;
        base.answer = {
          text: answerText,
          ...(typeof contextAddendum === 'string' ? { contextAddendum } : {}),
        };
        return base;
      }
      case 'realign': {
        const realign = candidate.realign;
        if (!realign || typeof realign !== 'object' || Array.isArray(realign)) return null;
        const systemMessage = (realign as Record<string, unknown>).systemMessage;
        if (typeof systemMessage !== 'string' || systemMessage.length === 0) return null;
        const newGoal = (realign as Record<string, unknown>).newGoal;
        base.realign = {
          systemMessage,
          ...(typeof newGoal === 'string' ? { newGoal } : {}),
        };
        return base;
      }
      case 'split':
      case 'create_work_item': {
        const workItems = candidate.workItems;
        if (!Array.isArray(workItems) || workItems.length === 0) return null;
        base.workItems = workItems;
        return base;
      }
      case 'quality_gate': {
        const qualityGate = (candidate.qualityGate ?? candidate.quality_gate) as Record<string, unknown> | undefined;
        if (qualityGate && typeof qualityGate === 'object' && !Array.isArray(qualityGate)) {
          const passed = qualityGate.passed;
          const passedBool = this.parseBoolean(passed, false);
          base.qualityGate = {
            passed: passedBool,
            ...(Array.isArray(qualityGate.issues)
              ? { issues: qualityGate.issues }
              : {}),
          };
          return base;
        }
        base.qualityGate = this.inferQualityGate(candidate, response, reason);
        return base;
      }
      case 'allow':
      case 'continue':
        return base;
      default:
        return null;
    }
  }

  private parseWatcherActionLenient(
    parsed: Record<string, unknown>,
    content: string
  ): Record<string, unknown> | null {
    const candidates = [parsed, ...this.extractJsonCandidates(content)];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const normalized = this.normalizeWatcherActionCandidate(candidate as Record<string, unknown>);
      if (normalized) return normalized;
    }
    return null;
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

    const schemaId = this.resolveOutputSchemaId();
    if (!schemaId) {
      result.terminationReason = 'invalid_action';
      result.error = `Unknown output schema for ${this.config.type} (schemaId missing or unrecognized).`;
      return null;
    }

    if (schemaId === 'watcher_action') {
      const normalized = this.parseWatcherActionLenient(parsed, content);
      if (normalized) {
        return normalized;
      }
      result.terminationReason = 'invalid_action';
      result.error = 'Watcher output missing required fields for watcherAction.';
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
    if (!Array.isArray(spec.workItems) || spec.workItems.length === 0) return false;

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

### function_call
@callId call_KcWsmSjYyJo48PWp5mUllLi0
@name Read
@ts 1770406160315
@workItemId 9e3fd496
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","encoding":"utf-8","maxBytes":120000,"startLine":1,"endLine":420}

### function_call_output
@callId call_KcWsmSjYyJo48PWp5mUllLi0
@ts 1770406160321
@durationMs 4
@workItemId 9e3fd496
// Lines 1-420 of 3186 total
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
      workItemId?: string;
    };
    budget: {
      maxTokens: number;
      maxItems?: number;
      minCoverage?: Partial<Record<string, number>>;
    };
    options?: {
      forceV1Fallback?: boolean;
      trace?: boolean;
    };
  }) => Promise<{
    content: string;
    atoms: unknown[];
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
   * Summarize tool arguments for logging (strip large content, keep paths/patterns).
   */
  private summarizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.length > 200) {
        summary[key] = value.slice(0, 200) + '...';
      } else if (Array.isArray(value) && value.length > 10) {
        summary[key] = [...value.slice(0, 10), `... and ${value.length - 10} more`];
      } else {
        summary[key] = value;
      }
    }
    return summary;
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
    if (!localContext.isNearFull()) return;

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

        let v2Result: { content: string; atoms: unknown[]; metrics: { totalTokens: number; attentionTax: number; coverage: Record<string, number>; discriminatorsIncluded: number; latencyMs: number } } | null = null;
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

### function_call
@callId call_I1empFyE3hh31EoIut8285iS
@name Grep
@ts 1770406165153
@workItemId 9e3fd496
{"pattern":"internalHookQueue\\.enqueue|workItem|create_work_item|split|agent_completed|turn_completed|workitem|work item","path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","glob":"agent.ts","type":"ts","maxResults":300,"caseSensitive":false}

### function_call_output
@callId call_I1empFyE3hh31EoIut8285iS
@ts 1770406165166
@durationMs 11
@workItemId 9e3fd496
packages/agent/src/agent.ts:25:15:import type { WorkItem } from 'work';
packages/agent/src/agent.ts:26:16:import { createWorkItem } from 'work';
packages/agent/src/agent.ts:115:7:      workItemId?: string;
packages/agent/src/agent.ts:198:28:  private buildHookContext(workItem: WorkItem): InternalHookContext {
packages/agent/src/agent.ts:200:15:      workId: workItem.workId,
packages/agent/src/agent.ts:204:18:      objective: workItem.objective,
packages/agent/src/agent.ts:212:29:  private getMemoryCacheKey(workItem: WorkItem): string {
packages/agent/src/agent.ts:213:12:    return workItem.workId || this.sessionKey || 'default';
packages/agent/src/agent.ts:238:5:    workItem: WorkItem,
packages/agent/src/agent.ts:245:10:    this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:246:14:      type: 'turn_completed',
packages/agent/src/agent.ts:252:30:    }, this.buildHookContext(workItem));
packages/agent/src/agent.ts:262:5:    workItem: WorkItem,
packages/agent/src/agent.ts:265:34:    if (metrics.toolCallsMade >= workItem.bounds.maxToolCalls) {
packages/agent/src/agent.ts:270:14:        max: workItem.bounds.maxToolCalls,
packages/agent/src/agent.ts:271:10:      }, workItem.workId));
packages/agent/src/agent.ts:275:22:    if (elapsedMs >= workItem.bounds.maxDurationMs) {
packages/agent/src/agent.ts:280:14:        max: workItem.bounds.maxDurationMs,
packages/agent/src/agent.ts:281:10:      }, workItem.workId));
packages/agent/src/agent.ts:295:5:    workItem: WorkItem
packages/agent/src/agent.ts:310:10:    this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:315:30:    }, this.buildHookContext(workItem));
packages/agent/src/agent.ts:323:5:    workItem: WorkItem,
packages/agent/src/agent.ts:334:70:    const { system, taskContext } = this.buildSystemPromptComponents(workItem, cwd);
packages/agent/src/agent.ts:363:45:        const query = this.buildMemoryQuery(workItem, globalContext);
packages/agent/src/agent.ts:374:49:        const cacheKey = this.getMemoryCacheKey(workItem);
packages/agent/src/agent.ts:379:54:          && this.shouldUseMemoryV2(this.sessionKey, workItem.workId);
packages/agent/src/agent.ts:392:16:          this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:407:36:          }, this.buildHookContext(workItem));
packages/agent/src/agent.ts:422:14:          }, workItem.workId));
packages/agent/src/agent.ts:447:26:              objective: workItem.objective,
packages/agent/src/agent.ts:452:15:              workItemId: workItem.workId,
packages/agent/src/agent.ts:480:16:          this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:495:36:          }, this.buildHookContext(workItem));
packages/agent/src/agent.ts:510:14:          }, workItem.workId));
packages/agent/src/agent.ts:515:59:          const itemCount = memoryContent ? memoryContent.split('\n\n').filter(line => line.trim().length > 0).length : 0;
packages/agent/src/agent.ts:524:16:          this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:535:36:          }, this.buildHookContext(workItem));
packages/agent/src/agent.ts:546:14:          }, workItem.workId));
packages/agent/src/agent.ts:551:14:        this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:553:81:          query: this.memoryInjector.summarizeQueryPlan?.(this.buildMemoryQuery(workItem, globalContext))
packages/agent/src/agent.ts:554:38:            || this.buildMemoryQuery(workItem, globalContext),
packages/agent/src/agent.ts:560:34:        }, this.buildHookContext(workItem));
packages/agent/src/agent.ts:562:81:          query: this.memoryInjector.summarizeQueryPlan?.(this.buildMemoryQuery(workItem, globalContext))
packages/agent/src/agent.ts:563:38:            || this.buildMemoryQuery(workItem, globalContext),
packages/agent/src/agent.ts:569:12:        }, workItem.workId));
packages/agent/src/agent.ts:584:7:      workItem,
packages/agent/src/agent.ts:708:5:    workItemId?: string
packages/agent/src/agent.ts:745:9:        workItemId,
packages/agent/src/agent.ts:746:10:      }, workItemId);
packages/agent/src/agent.ts:786:5:    workItemId: string
packages/agent/src/agent.ts:796:10:      }, workItemId));
packages/agent/src/agent.ts:807:8:    }, workItemId));
packages/agent/src/agent.ts:823:5:    workItemId?: string
packages/agent/src/agent.ts:885:29:   * Execute the agent on a work item.
packages/agent/src/agent.ts:890:28:    const { globalContext, workItem, cwd, signal } = params;
packages/agent/src/agent.ts:895:58:      `${globalContext.sessionKey}:${this.config.type}:${workItem.workId}`,
packages/agent/src/agent.ts:923:59:      await this.executeLoop(globalContext, localContext, workItem, result, metrics, startTime, cwd, signal);
packages/agent/src/agent.ts:931:37:        const stackPreview = stack?.split('\n').slice(0, 3).join('\n');
packages/agent/src/agent.ts:970:37:        const stackPreview = stack?.split('\n').slice(0, 5).join('\n');
packages/agent/src/agent.ts:976:78:      this.emitLlmError(error instanceof Error ? error : new Error(message), workItem.workId);
packages/agent/src/agent.ts:1025:12:      this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:1028:32:      }, this.buildHookContext(workItem));
packages/agent/src/agent.ts:1031:10:    this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:1032:14:      type: 'agent_completed',
packages/agent/src/agent.ts:1033:15:      workId: workItem.workId,
packages/agent/src/agent.ts:1038:43:      // Include response and metrics for workitem log tracking
packages/agent/src/agent.ts:1045:30:    }, this.buildHookContext(workItem));
packages/agent/src/agent.ts:1063:5:    workItem: WorkItem,
packages/agent/src/agent.ts:1072:7:      workItem.bounds.maxLlmCalls
packages/agent/src/agent.ts:1083:9:    if (workItem.targetPaths && workItem.targetPaths.length > 0) {
packages/agent/src/agent.ts:1084:38:      await this.autoReadTargetFiles(workItem.targetPaths, localContext, localReadFiles, metrics, cwd, workItem.workId);
packages/agent/src/agent.ts:1108:74:          localContext.addMessage('system', cadenceResult.systemMessage, workItem.workId);
packages/agent/src/agent.ts:1111:76:            localContext.addMessage('system', cadenceResult.systemMessage, workItem.workId);
packages/agent/src/agent.ts:1125:50:      const boundHit = this.checkBounds(metrics, workItem, elapsedMs);
packages/agent/src/agent.ts:1131:64:      await this.compactIfNeeded(localContext, localReadFiles, workItem);
packages/agent/src/agent.ts:1135:9:        workItem,
packages/agent/src/agent.ts:1171:20:                }, workItem.workId));
packages/agent/src/agent.ts:1178:18:              }, workItem.workId));
packages/agent/src/agent.ts:1188:9:        workItem.workId
packages/agent/src/agent.ts:1199:107:      this.emitLlmCall(response, messages, llmDurationMs, toolsForThisCall ?? [], localContext.maxTokens, workItem.workId);
packages/agent/src/agent.ts:1217:53:        localContext.addReasoning(reasoningContent, workItem.workId);
packages/agent/src/agent.ts:1222:71:      this.extractArtifactsFromOutput(structuredOutput, localContext, workItem.workId);
packages/agent/src/agent.ts:1223:66:      this.addAssistantMessage(localContext, content, toolCalls, workItem.workId);
packages/agent/src/agent.ts:1225:38:      // Fire agent_message hook for workitem logging (captures actual content + reasoning)
packages/agent/src/agent.ts:1227:12:      this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:1233:32:      }, this.buildHookContext(workItem));
packages/agent/src/agent.ts:1249:11:          workItem.workId
packages/agent/src/agent.ts:1255:48:        this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
packages/agent/src/agent.ts:1263:48:        this.finalizeIteration(localReadFiles, workItem, result, metrics, iteration, !!responseText);
packages/agent/src/agent.ts:1279:11:          workItem,
packages/agent/src/agent.ts:1281:11:          workItem.workId,
packages/agent/src/agent.ts:1287:14:        this.interna
... [truncated 7439 chars]

### function_call
@callId call_VyaPsKRu2LtHANjkvCfPKf29
@name Grep
@ts 1770406170676
@workItemId 9e3fd496
{"pattern":"createWorkItem|internalHookQueue|noopHookQueue|agent_message|tool_call_completed|agent_completed|turn_completed|workItems","path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","glob":"agent.ts","type":"ts","maxResults":200,"caseSensitive":false}

### function_call_output
@callId call_VyaPsKRu2LtHANjkvCfPKf29
@ts 1770406170690
@durationMs 11
@workItemId 9e3fd496
packages/agent/src/agent.ts:26:10:import { createWorkItem } from 'work';
packages/agent/src/agent.ts:36:3:  InternalHookQueue,
packages/agent/src/agent.ts:40:20:import { noopEmit, noopHookQueue } from './types.js';
packages/agent/src/agent.ts:151:11:  private internalHookQueue: InternalHookQueue;
packages/agent/src/agent.ts:177:5:    internalHookQueue?: InternalHookQueue;
packages/agent/src/agent.ts:190:10:    this.internalHookQueue = runtime.internalHookQueue ?? noopHookQueue;
packages/agent/src/agent.ts:245:10:    this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:246:14:      type: 'turn_completed',
packages/agent/src/agent.ts:310:10:    this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:392:16:          this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:480:16:          this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:524:16:          this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:551:14:        this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:793:30:      this.emit(createEvent('agent_message', {
packages/agent/src/agent.ts:804:28:    this.emit(createEvent('agent_message', {
packages/agent/src/agent.ts:1025:12:      this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:1031:10:    this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:1032:14:      type: 'agent_completed',
packages/agent/src/agent.ts:1168:40:                this.emit(createEvent('agent_message', {
packages/agent/src/agent.ts:1175:38:              this.emit(createEvent('agent_message', {
packages/agent/src/agent.ts:1225:15:      // Fire agent_message hook for workitem logging (captures actual content + reasoning)
packages/agent/src/agent.ts:1227:12:      this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:1228:16:        type: 'agent_message',
packages/agent/src/agent.ts:1287:14:        this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:1928:15:      // Fire tool_call_completed hook for workitem logging (captures args + result preview)
packages/agent/src/agent.ts:1929:12:      this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:1930:16:        type: 'tool_call_completed',
packages/agent/src/agent.ts:2387:25:    const subWorkItem = createWorkItem({
packages/agent/src/agent.ts:2412:7:      internalHookQueue: this.internalHookQueue,
packages/agent/src/agent.ts:2538:34:          this.emit(createEvent('agent_message', {
packages/agent/src/agent.ts:2774:90:    const statusText = this.readNestedString(candidate, ['semantic', 'salienceUpdates', 'workItemStatus']);
packages/agent/src/agent.ts:2857:15:        const workItems = candidate.workItems;
packages/agent/src/agent.ts:2858:28:        if (!Array.isArray(workItems) || workItems.length === 0) return null;
packages/agent/src/agent.ts:2859:14:        base.workItems = workItems;
packages/agent/src/agent.ts:3116:11:    const workItems = parsed.workItems.length;
packages/agent/src/agent.ts:3117:22:    const response = workItems > 0
packages/agent/src/agent.ts:3118:29:      ? `Planner produced ${workItems} work items.`
packages/agent/src/agent.ts:3137:29:    if (!Array.isArray(spec.workItems) || spec.workItems.length === 0) return false;
packages/agent/src/agent.ts:3139:29:    for (const item of spec.workItems) {

### function_call
@callId call_6zMjmjTLCHPpuW4Z25m5oXto
@name Read
@ts 1770406174879
@workItemId 9e3fd496
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","encoding":"utf-8","maxBytes":120000,"startLine":1268,"endLine":1375}

### function_call_output
@callId call_6zMjmjTLCHPpuW4Z25m5oXto
@ts 1770406174881
@durationMs 1
@workItemId 9e3fd496
// Lines 1268-1375 of 3186 total
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

### function_call
@callId call_2TG2qyIDWwZ4aD2ezgbUmrqo
@name Read
@ts 1770406178957
@workItemId 9e3fd496
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/types.ts","encoding":"utf-8","maxBytes":80000,"startLine":1,"endLine":260}

### function_call_output
@callId call_2TG2qyIDWwZ4aD2ezgbUmrqo
@ts 1770406178959
@durationMs 1
@workItemId 9e3fd496
// Lines 1-260 of 606 total
import type { WorkItem } from 'work';
import type { AgentEvent, StructuredOutputSchema, ToolResult, ArtifactItem, LLMRequestConfig } from 'types';
import type { ContextWindow } from 'context';
import type { LLMAdapter } from 'llm';
import type { ToolRegistry } from 'tools';
import type { HandoffSpec, TerminationReason } from 'protocol';

// Re-export stop hook types from protocol (moved there to avoid circular deps)
export type {
  DeferredWorkItem,
  ExecutionSnapshot,
  StopHookResult,
  StopHookContext,
  StopHookUserPrompt,
  StopHookHandler,
} from 'protocol';

/**
 * Agent type identifier - any string, defined via config.
 * Common types: 'routing', 'explorer', 'standard', 'complex'
 */
export type AgentType = string;

/**
 * Budget constraints for agent execution.
 */
export interface AgentBudget {
  /** Maximum LLM calls per run */
  maxIterations: number;
  /** Maximum tool calls per run */
  maxToolCalls: number;
  /** Maximum duration in milliseconds */
  maxDurationMs: number;
  /** Timeout for individual LLM streaming calls in milliseconds (default 240_000 = 4 min) */
  llmStreamTimeoutMs?: number;
}

export const DEFAULT_AGENT_BUDGET: AgentBudget = {
  maxIterations: 20,
  maxToolCalls: 150,
  maxDurationMs: 120_000,
  llmStreamTimeoutMs: 240_000,
};

/**
 * LLM operational parameters - NOT provider/model selection.
 * These control HOW the model runs, not WHICH model runs.
 */
export interface LLMParams {
  /** Maximum tokens in response */
  maxTokens: number;
  /** Temperature for sampling (0-1) */
  temperature: number;
}

export const DEFAULT_LLM_PARAMS: LLMParams = {
  maxTokens: 16000,
  temperature: 0.7,
};

/**
 * Agent configuration - wired at instantiation.
 * Determines the agent's capabilities and constraints.
 *
 * NOTE: The LLM provider/model is NOT specified here. Model selection
 * comes EXCLUSIVELY from SessionStore via getModelSelection.
 * Only operational params (maxTokens, temperature) are stored here.
 */
export interface AgentConfig {
  /** Agent type identifier */
  type: AgentType;
  /** System prompt defining agent behavior */
  systemPrompt: string;
  /** Tools this agent can access (discretionary) */
  tools: string[];
  /** Resource budget */
  budget: AgentBudget;
  /** LLM operational parameters (NOT provider/model) */
  llmParams: LLMParams;
  /** Structured output schema for responses */
  outputSchema?: StructuredOutputSchema;
}

/**
 * Parameters for Agent.run().
 * Minimal interface - all config is at construction.
 */
export interface AgentRunParams {
  /** Global context window - read-only reference, agent writes to its own local context */
  globalContext: ContextWindow;
  /** Work item defining the objective */
  workItem: WorkItem;
  /** Working directory for tool execution. Required for concurrent-safe operation. */
  cwd: string;
  /** Optional abort signal to cancel agent execution. */
  signal?: AbortSignal;
}

/**
 * Metrics from agent execution.
 */
export interface AgentMetrics {
  /** Number of LLM calls made */
  llmCallsMade: number;
  /** Number of tool calls made */
  toolCallsMade: number;
  /** Number of successful tool calls */
  toolCallsSucceeded: number;
  /** Number of failed tool calls */
  toolCallsFailed: number;
  /** Total duration in milliseconds */
  durationMs: number;
}

/**
 * Result from Agent.run().
 * Contains all outputs; agent does not mutate input context.
 */
export interface AgentResultBase {
  /** Whether the objective was achieved */
  success: boolean;
  /** Response content (if successful) */
  response: string;
  /** Error message (if failed) */
  error?: string;
  /** Execution metrics */
  metrics: AgentMetrics;
  /** Files read during execution */
  filesRead: string[];
  /** Paths invalidated by Write/Edit operations */
  invalidatedPaths: string[];
  /** Tool errors encountered */
  toolErrors: string[];
  /** Whether result is incomplete (e.g., iterations exhausted but has partial output) */
  isIncomplete?: boolean;
  /** Parsed structured output (if available). Shape defined by config, not TypeScript. */
  structuredOutput?: Record<string, unknown>;
  /** Explicitly bundled artifacts discovered during execution */
  artifacts?: ArtifactItem[];
  /** Agent's execution context - contains tool calls, outputs, reasoning from this run */
  localContext: ContextWindow;
  /** Optional watcher stop metadata when cadence intervention terminates a work item/session. */
  watcherStop?: {
    reason: string;
    escalationId?: string;
  };
}

export type AgentRateLimitInfo = {
  provider: string;
  model: string;
  type: string;
  retryAfterMs?: number;
  message: string;
};

export type AgentResult =
  | (AgentResultBase & {
      terminationReason: 'user_input_required';
      needsUserInput: true;
      userPrompt: UserPromptInfo;
      needsHandoff?: false;
      handoffSpec?: undefined;
      isRefusal: false;
      rateLimitInfo?: undefined;
    })
  | (AgentResultBase & {
      terminationReason: 'handoff_requested';
      needsUserInput: false;
      userPrompt?: undefined;
      needsHandoff: true;
      handoffSpec: HandoffSpec;
      isRefusal: false;
      rateLimitInfo?: undefined;
    })
  | (AgentResultBase & {
      terminationReason: 'refusal';
      needsUserInput: false;
      userPrompt?: undefined;
      needsHandoff?: false;
      handoffSpec?: undefined;
      isRefusal: true;
      rateLimitInfo?: undefined;
    })
  | (AgentResultBase & {
      terminationReason: 'rate_limit';
      needsUserInput: false;
      userPrompt?: undefined;
      needsHandoff?: false;
      handoffSpec?: undefined;
      isRefusal: false;
      rateLimitInfo: AgentRateLimitInfo;
    })
  | (AgentResultBase & {
      terminationReason: Exclude<TerminationReason, 'user_input_required' | 'handoff_requested' | 'refusal' | 'rate_limit'>;
      needsUserInput: false;
      userPrompt?: undefined;
      needsHandoff?: false;
      handoffSpec?: undefined;
      isRefusal: false;
      rateLimitInfo?: undefined;
    });

export type MutableAgentResult = AgentResultBase & {
  /** Why execution terminated (undefined while still running) */
  terminationReason?: TerminationReason;
  /** Whether user input is needed */
  needsUserInput: boolean;
  /** User prompt info (if needsUserInput) */
  userPrompt?: UserPromptInfo;
  /** Whether handoff is requested (planning → execution transition) */
  needsHandoff?: boolean;
  /** Handoff spec (if needsHandoff) */
  handoffSpec?: HandoffSpec;
  /** Whether LLM refused to complete */
  isRefusal: boolean;
  /** Rate limit info (if terminationReason is 'rate_limit') */
  rateLimitInfo?: AgentRateLimitInfo;
};

/**
 * Single question in a multi-question prompt.
 */
export interface UserPromptQuestion {
  question: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multiSelect?: boolean;
  questionType?: string;
}

/**
 * User prompt information for interactive requests.
 * Supports single question (backwards compatible) or multiple questions.
 */
export interface UserPromptInfo {
  /** Single question (backwards compatible) */
  question: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multiSelect?: boolean;
  questionType?: string;
  /** Multiple questions to ask in sequence */
  questions?: UserPromptQuestion[];
}

/**
 * Event emit callback type.
 * Agents receive this, never the EventBus directly.
 */
export type EventEmitCallback = (event: AgentEvent) => void;

/**
 * Noop emit callback for testing or when events aren't needed.
 */
export const noopEmit: EventEmitCallback = () => {};

// ============================================
// TOOL HOOKS
// ============================================

### function_call
@callId call_0QvspPT08sdh1Y41Xt7svvlz
@name Grep
@ts 1770406182659
@workItemId 9e3fd496
{"pattern":"InternalHookQueue|noopHookQueue|enqueue|async mode|non-async|workitem","path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/types.ts","glob":"types.ts","type":"ts","maxResults":200,"caseSensitive":false}

### function_call_output
@callId call_0QvspPT08sdh1Y41Xt7svvlz
@ts 1770406182677
@durationMs 18
@workItemId 9e3fd496
packages/agent/src/types.ts:1:15:import type { WorkItem } from 'work';
packages/agent/src/types.ts:10:11:  DeferredWorkItem,
packages/agent/src/types.ts:92:3:  workItem: WorkItem;
packages/agent/src/types.ts:339:20: * Fired by agent, enqueued as work items, executed as plain functions (no LLM).
packages/agent/src/types.ts:343:37:      /** Fired when a work item is enqueued (before execution). */
packages/agent/src/types.ts:344:14:      type: 'workitem_created';
packages/agent/src/types.ts:469:9:        workItemId?: string;
packages/agent/src/types.ts:540:18: * Interface for enqueueing internal hook work items.
packages/agent/src/types.ts:543:18:export interface InternalHookQueue {
packages/agent/src/types.ts:545:6:   * Enqueue a hook event as a work item.
packages/agent/src/types.ts:548:3:  enqueue(event: InternalHookEvent, context: InternalHookContext): void;
packages/agent/src/types.ts:554:14:export const noopHookQueue: InternalHookQueue = {
packages/agent/src/types.ts:555:3:  enqueue: () => {},
packages/agent/src/types.ts:602:3:  internalHookQueue?: InternalHookQueue;

### function_call
@callId call_CmZp88u10qiCwc0pkR7MEeAd
@name Read
@ts 1770406185817
@workItemId 9e3fd496
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/types.ts","encoding":"utf-8","maxBytes":120000,"startLine":320,"endLine":580}

### function_call
@callId call_YrzdNhe2Y2S1agN9qG390Z2Q
@name Read
@ts 1770406185817
@workItemId 9e3fd496
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/agent/src/agent.ts","encoding":"utf-8","maxBytes":120000,"startLine":2320,"endLine":2465}

### function_call_output
@callId call_CmZp88u10qiCwc0pkR7MEeAd
@ts 1770406185824
@durationMs 3
@workItemId 9e3fd496
// Lines 320-580 of 606 total
  /**
   * Called at the start of each agent iteration to check for stop signal.
   * Returns true if agent should stop immediately (e.g., user typed "stop").
   */
  shouldStop?: () => boolean;

  /**
   * Called every N iterations inside the agent loop for watcher intervention.
   * Gives the watcher a synchronization point to steer or stop the agent mid-run.
   */
  cadenceCheck?: (metrics: AgentCadenceMetrics) => Promise<AgentCadenceResult>;
}

// ============================================
// INTERNAL ASYNC HOOKS (best-effort housekeeping)
// ============================================

/**
 * Internal hook event types.
 * Fired by agent, enqueued as work items, executed as plain functions (no LLM).
 */
export type InternalHookEvent =
  | {
      /** Fired when a work item is enqueued (before execution). */
      type: 'workitem_created';
      objective: string;
      agent: string;
      domain?: string;
      dependencies?: string[];
      targetPaths?: string[];
      /** Semantic state attached during watcher split/create (to be written to semantic.json) */
      semantic?: unknown;
    }
  | {
      type: 'turn_completed';
      iteration: number;
      toolCallsMade: number;
      llmCallsMade: number;
      hasResponse: boolean;
      terminationReason?: TerminationReason;
    }
  | {
      type: 'tool_batch_completed';
      toolNames: string[];
      successCount: number;
      failCount: number;
    }
  | {
      type: 'context_threshold';
      usagePercent: number;
      tokenCount: number;
      itemCount: number;
    }
  | {
      type: 'artifacts_discovered';
      artifacts: Array<{ sourcePath: string; name: string; kind: string }>;
      discoveredBy: string;
    }
  | {
      type: 'files_modified';
      paths: string[];
    }
  | {
      /** Fired when agent produces a message - captures actual conversation content */
      type: 'agent_message';
      role: 'assistant';
      /** Actual message content (NOT truncated - full content for audit) */
      content: string;
      /** Agent's reasoning/thinking for this turn (if extended thinking enabled) */
      reasoning?: string;
      iteration: number;
    }
  | {
      /** Fired for each individual tool call with full details */
      type: 'tool_call_completed';
      tool: string;
      /** Tool arguments (summarized - file paths, patterns, not full content) */
      args: Record<string, unknown>;
      success: boolean;
      /** Result preview - first 500 chars of output */
      resultPreview?: string;
      durationMs: number;
    }
  | {
      type: 'agent_completed';
      workId: string;
      success: boolean;
      terminationReason: TerminationReason;
      filesRead: string[];
      invalidatedPaths: string[];
      /** Agent's final response text */
      response?: string;
      /** Execution metrics */
      metrics?: {
        toolCallsMade: number;
        llmCallsMade: number;
      };
      /** Context window percentage used */
      contextPercentUsed?: number;
    }
  | {
      /** Fired when memory is injected into agent context */
      type: 'memory_injected';
      /** Search query used to retrieve memory */
      query: string;
      /** Memory content preview - first 500 chars */
      resultPreview?: string;
      /** Full memory content injected (if available) */
      memoryContent?: string;
      /** Final task context string with memory appended (if available) */
      contextWithMemory?: string;
      /** Number of memory items returned */
      itemCount: number;
      /** Whether injection succeeded */
      success: boolean;
      /** Which iteration this was (typically 0 - first iteration only) */
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
  | {
      /** Fired when a git commit is detected from Bash tool output */
      type: 'git_commit';
      /** Git commit SHA */
      sha: string;
      /** The bash command that triggered the commit */
      command: string;
      /** Commit message if extractable */
      message?: string;
      /** Branch name if detectable */
      branch?: string;
    }
  | {
      /** Fired when an escalation is raised (needs human attention) */
      type: 'escalation_raised';
      escalation: {
        id: string;
        escalationType: string;
        sessionKey: string;
        workItemId?: string;
        title: string;
        context: string;
        tradeoffs?: string[];
        options?: Array<{
          id: string;
          label: string;
          description: string;
          implications: string[];
          recommended: boolean;
        }>;
        references: Array<{
          type: string;
          label: string;
          target: string;
          preview?: string;
        }>;
      };
    }
  | {
      /** Fired when an escalation is resolved by human or system */
      type: 'escalation_resolved';
      escalationId: string;
      sessionKey: string;
      resolution: {
        optionId?: string;
        freeformResponse?: string;
        resolvedBy: 'user' | 'system' | 'timeout';
      };
    }
  | {
      /** Fired when watcher stops a specific work item during cadence checks. */
      type: 'watcher_agent_stopped';
      sessionKey: string;
      workId: string;
      reason: string;
      escalationId?: string;
      agentType: string;
    }
  | {
      /** Fired when session status changes (e.g., active → blocked) */
      type: 'session_status_changed';
      sessionKey: string;
      previousStatus: string;
      newStatus: string;
      reason?: string;
      triggeringEscalationId?: string;
    };

/**
 * Context passed to internal hook handlers.
 */
export interface InternalHookContext {
  workId: string;
  agentType: string;
  sessionKey: string;
  requestId: string;
  /** The objective/goal this work item is trying to accomplish */
  objective?: string;
}

/**
 * Internal hook handler function signature.
 * Plain async function - no LLM, no agent.
 */
export type InternalHookHandler<T extends InternalHookEvent = InternalHookEvent> = (
  event: T,
  context: InternalHookContext
) => Promise<void>;

/**
 * Interface for enqueueing internal hook work items.
 * Implemented by orchestrator, passed to agent.
 */
export interface InternalHookQueue {
  /**
   * Enqueue a hook event as a work item.
   * Returns immediately - does not block.
   */
  enqueue(event: InternalHookEvent, context: InternalHookContext): void;
}

/**
 * Noop hook queue for when hooks are disabled.
 */
export const noopHookQueue: InternalHookQueue = {
  enqueue: () => {},
};

// ============================================
// AGENT RUNTIME CONFIG
// ============================================

// Forward declaration for AgentRegistry to avoid circular import
export interface AgentRegistry {
  has(agentType: string): boolean;
  getConfig(agentType: string): AgentConfig;
  listToolDefinitions(): Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}

/**
 * Model selection from SessionStore - identifies WHICH model to use.
 * This is the runtime type for getModelSelection callback.
 */
export interface ModelSelectionInfo {
  provider: string;
  model: string;
  reasoning?: string;
}

/**
 * Runtime configuration for Agent.

### function_call_output
@callId call_YrzdNhe2Y2S1agN9qG390Z2Q
@ts 1770406185824
@durationMs 3
@workItemId 9e3fd496
// Lines 2320-2465 of 3186 total
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

### function_call
@callId call_Lm8GwxnIBSOQVoAWTfH0kbu1
@name Grep
@ts 1770406192427
@workItemId 9e3fd496
{"pattern":"non-async|async mode|internal hooks|workitem_created|noopHookQueue|internalHookQueue","path":"/Users/jevinnishioka/Desktop/jesus/packages","glob":"**/*.ts","type":"ts","maxResults":200,"caseSensitive":false}

### function_call_output
@callId call_Lm8GwxnIBSOQVoAWTfH0kbu1
@ts 1770406192471
@durationMs 40
@workItemId 9e3fd496
packages/decision-watcher/src/types.ts:333:15:  /** Whether async mode is enabled */
packages/decision-watcher/src/types.ts:608:10:  type: 'workitem_created';
packages/decision-watcher/src/watcher-agent.ts:339:11:    case 'workitem_created':
packages/decision-watcher/src/watcher-agent.ts:340:38:      return `- [${entry.timestamp}] workitem_created: ${entry.workId} agent=${entry.agent} objective="${entry.objective.slice(0, 140)}"`;
packages/decision-watcher/src/watcher-agent.ts:970:85:**You MUST answer with \`watcherAction: "answer"\`.** There is no user available in async mode.
packages/decision-watcher/src/watcher-agent.ts:1046:51:  // Watcher failed to provide a usable answer in async mode.
packages/decision-watcher/src/integration/index.ts:34:13: * Check if async mode should be enabled based on config.
packages/decision-watcher/src/integration/index.ts:47:15:  // We're in async mode if enabled and we have decisions
packages/orchestrator/src/hooks.ts:50:29:/** TypeScript callback for internal hooks */
packages/orchestrator/src/hooks.ts:221:6:    'workitem_created',
packages/agent/src/index.ts:31:3:  InternalHookQueue,
packages/agent/src/index.ts:38:62:export { DEFAULT_AGENT_BUDGET, DEFAULT_LLM_PARAMS, noopEmit, noopHookQueue } from './types.js';
packages/harness-daemon/src/harness/bridge_gateway.ts:2076:37:      this.sendError(connectionId, `Async mode is unavailable: ${asyncStatus.issues.join('; ')}`);
packages/harness-daemon/src/harness/bridge_gateway.ts:2081:120:      this.sendError(connectionId, 'Session is paused awaiting user input. Resume or close the session before starting async mode.');
packages/harness-daemon/src/harness/bridge_gateway.ts:2164:78:        // NOT when it pauses for user input. Paused runs should resume with async mode still on.
packages/harness-daemon/src/harness/bridge_gateway.ts:2166:47:          // Run paused for user input - keep async mode enabled for resume
packages/orchestrator/src/orchestrator.test.ts:702:58:    it.skip('should allow watcher to answer questions in async mode', async () => {
packages/orchestrator/src/orchestrator.test.ts:1489:13:  describe('Async Mode', () => {
packages/orchestrator/src/orchestrator.test.ts:1490:26:    it('should configure async mode correctly', async () => {
packages/orchestrator/src/ralph-loop.ts:307:52:  'user_input_required', // Handled specially with async mode message
packages/orchestrator/src/ralph-loop.ts:330:40:const ASYNC_MODE_MESSAGE = 'You are in async mode. User cannot answer questions. Do not ask again. Continue working autonomously.';
packages/orchestrator/src/ralph-loop.ts:383:66:    // Handle user_input_required specially - tell agent it's in async mode
packages/orchestrator/src/ralph-loop.ts:391:70:        systemMessage: `🔄 Ralph iteration ${state.iteration + 1} (async mode - no user input available)`,
packages/agent/src/types.ts:344:14:      type: 'workitem_created';
packages/agent/src/types.ts:543:18:export interface InternalHookQueue {
packages/agent/src/types.ts:554:14:export const noopHookQueue: InternalHookQueue = {
packages/agent/src/types.ts:602:3:  internalHookQueue?: InternalHookQueue;
packages/agent/src/prompts.ts:309:70:You are Jevin's representative inside the system. When he is absent (async mode), you speak for him with maximum agency. Your authority comes from understanding the goal better than any worker agen
packages/agent/src/prompts.ts:319:118:4. **Autonomous Decision-Maker**: When an agent asks a question (PromptUser), you MUST answer -- there is no user in async mode. Consult salience file, decision log, session preferences, and codeb
packages/agent/src/prompts.ts:620:58: * Comprehensive prompt for agents running in autonomous async mode.
packages/agent/src/prompts.ts:771:4: * Async mode addendum for worker agents running under watcher oversight.
packages/agent/src/prompts.ts:776:4:## ASYNC MODE -- WATCHER OVERSIGHT ACTIVE
packages/agent/src/prompts.ts:810:12: * Get the async mode prompt addendum for worker agents.
packages/agent/src/prompts.ts:819:64: * This is the primary prompt for agents running in autonomous async mode.
packages/agent/src/agent.ts:36:3:  InternalHookQueue,
packages/agent/src/agent.ts:40:20:import { noopEmit, noopHookQueue } from './types.js';
packages/agent/src/agent.ts:151:11:  private internalHookQueue: InternalHookQueue;
packages/agent/src/agent.ts:177:5:    internalHookQueue?: InternalHookQueue;
packages/agent/src/agent.ts:190:10:    this.internalHookQueue = runtime.internalHookQueue ?? noopHookQueue;
packages/agent/src/agent.ts:245:10:    this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:310:10:    this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:392:16:          this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:480:16:          this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:524:16:          this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:551:14:        this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:1025:12:      this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:1031:10:    this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:1227:12:      this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:1287:14:        this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:1929:12:      this.internalHookQueue.enqueue({
packages/agent/src/agent.ts:2412:7:      internalHookQueue: this.internalHookQueue,
packages/harness-daemon/src/harness/harness.ts:1429:26:      this.logger.error('Async mode agent schema validation failed', { issues });
packages/harness-daemon/src/harness/harness.ts:2203:43:    // Only create/use watcher hooks when async mode is enabled for this session/run
packages/harness-daemon/src/harness/harness.ts:2214:62:        this.logger.info('Creating watcher hook registry for async mode', { sessionKey, goal });
packages/harness-daemon/src/harness/harness.ts:2723:19:    registerHook('workitem_created', async (event: InternalHookEvent, ctx: InternalHookContext) => {
packages/harness-daemon/src/harness/harness.ts:2724:27:      if (event.type !== 'workitem_created') return;
packages/harness-daemon/src/harness/harness.ts:2730:10:        'workitem_created',
packages/harness-daemon/src/harness/harness.ts:2743:50:        await safeAppend('Work log write failed (workitem_created)', () => workLog.append({
packages/harness-daemon/src/harness/harness.ts:2744:18:          type: 'workitem_created',
packages/harness-daemon/src/harness/harness.ts:2786:52:          await safeAppend('Work log write failed (workitem_created)', () => workLog.append({
packages/harness-daemon/src/harness/harness.ts:2787:20:            type: 'workitem_created',
packages/orchestrator/src/orchestrator.ts:22:3:  InternalHookQueue,
packages/orchestrator/src/orchestrator.ts:106:6:   * Async mode configuration for decision watcher.
packages/orchestrator/src/orchestrator.ts:111:17:    /** Whether async mode is enabled */
packages/orchestrator/src/orchestrator.ts:113:31:    /** Decision database for async mode */
packages/orchestrator/src/orchestrator.ts:295:22:  private hookQueue: InternalHookQueue;
packages/orchestrator/src/orchestrator.ts:343:76:   * @param semantic - Optional semantic state to attach (flows through to workitem_created event)
packages/orchestrator/src/orchestrator.ts:357:16:        type: 'workitem_created',
packages/orchestrator/src/orchestrator.ts:378:30:  private createHookQueue(): InternalHookQueue {
packages/orchestrator/src/orchestrator.ts:1318:14:    // Apply async mode modifications to worker agents (not the watcher itself)
packages/orchestrator/src/orchestrator.ts:1319:83:    // CRITICAL: Must clear outputSchema - structured output is incompatible with async mode
packages/orchestrator/src/orchestrator.ts:1465:7:      internalHookQueue: this.hookQueue,
packages/orchestrator/src/orchestrator.ts:2385:50:      // Call stop hook for approval (watcher in async mode, or no-op in sync mode)

### function_call
@callId call_0HiYKMqnuG23w2PT4CizhYWk
@name Read
@ts 1770406196291
@workItemId 9e3fd496
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/orchestrator/src/orchestrator.ts","encoding":"utf-8","maxBytes":120000,"startLine":330,"endLine":430}

### function_call_output
@callId call_0HiYKMqnuG23w2PT4CizhYWk
@ts 1770406196294
@durationMs 1
@workItemId 9e3fd496
// Lines 330-430 of 2980 total
    this.logger = logger;
    this.agentRegistry = agentRegistry;
    this.hooks = hooks;
    this.planModeOptions = planModeOptions;
    this.getModelSelection = getModelSelection;
    this.hookQueue = this.createHookQueue();
  }

  /**
   * Enqueue a work item for processing.
   * Items with dependencies will wait until all dependencies are completed.
   *
   * @param item - The work item to enqueue
   * @param semantic - Optional semantic state to attach (flows through to workitem_created event)
   * @returns The work item's ID
   */
  enqueue(item: WorkItem, semantic?: unknown): string {
    this.workQueue.push(item);
    const hookParams = item.params as { isInternalHook?: boolean } | undefined;
    if (!hookParams?.isInternalHook && this.useFreshWorkItemContexts && !this.workItemContexts.has(item.workId)) {
      const seededContext = this.createFreshWorkItemContext();
      if (seededContext) {
        this.workItemContexts.set(item.workId, seededContext);
      }
    }
    if (!hookParams?.isInternalHook && this.activeSessionKey) {
      this.hookQueue.enqueue({
        type: 'workitem_created',
        objective: item.objective,
        agent: item.agent,
        domain: item.domain,
        dependencies: [...item.dependencies],
        targetPaths: [...item.targetPaths],
        semantic,
      }, {
        workId: item.workId,
        agentType: item.agent,
        sessionKey: this.activeSessionKey,
        requestId: this.requestId,
        objective: item.objective,
      });
    }
    return item.workId;
  }

  /**
   * Creates a hook queue that enqueues events as work items.
   */
  private createHookQueue(): InternalHookQueue {
    return {
      enqueue: (event: InternalHookEvent, context: InternalHookContext) => {
        const hookWorkItem = createWorkItem({
          goal: 'internal_hook',
          objective: `hook:${event.type}`,
          agent: 'internal',
          dependencies: [],
          bounds: {
            maxToolCalls: 0,
            maxDurationMs: this.config.hookTimeoutMs,
            maxLlmCalls: 0,
          },
          params: {
            isInternalHook: true,
            hookType: event.type,
            event,
            hookContext: context,
            handler: () => executeHooks(event.type, event, context),
          },
        });

        this.enqueue(hookWorkItem);
      },
    };
  }

  /**
   * Run a hook handler without blocking the orchestrator loop.
   */
  private runHookHandler(params: {
    handler: () => Promise<void>;
    hookType: string;
    workItemId: string;
    event?: InternalHookEvent;
    hookContext?: InternalHookContext;
    contextWindow: ContextWindow;
  }): void {
    const timeoutMs = this.config.hookTimeoutMs;
    void (async () => {
      const start = Date.now();
      const callId = `hook-${params.hookType}-${params.workItemId}`;
      const hookArgs = {
        hookType: params.hookType,
        event: params.event,
        context: params.hookContext,
      };
      const hookCallContext = new ContextWindow(params.contextWindow.sessionKey, params.contextWindow.maxTokens);
      hookCallContext.addFunctionCall(callId, `hook:${params.hookType}`, hookArgs);
      params.contextWindow.addAgentResultContext({
        response: '',
        filesRead: [],
        invalidatedPaths: [],

### function_call
@callId call_PT7Q9TY3hwTCE9lcQYfIspQt
@name Read
@ts 1770406201320
@workItemId 9e3fd496
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/orchestrator/src/hooks.ts","encoding":"utf-8","maxBytes":120000,"startLine":1,"endLine":320}

### function_call_output
@callId call_PT7Q9TY3hwTCE9lcQYfIspQt
@ts 1770406201322
@durationMs 1
@workItemId 9e3fd496
// Lines 1-252 of 252 total
/**
 * Hook System - Simple registry + executor pattern.
 *
 * Register callbacks (TypeScript functions or shell commands) for fixed event types.
 * Shell commands receive JSON on stdin and return exit codes (0=success, 2=block).
 */

import { spawn } from 'child_process';
import type { InternalHookEvent, InternalHookContext, StopHookResult, StopHookContext, StopHookHandler } from 'agent';

// Re-export stop hook types from agent (canonical location)
export type { StopHookContext, StopHookHandler };

// --- Event Types ---

export type HookEventType = InternalHookEvent['type'] | 'stop' | 'prompt_user';

/**
 * PromptUser hook event - fired when agent requests user input.
 */
export interface PromptUserHookEvent {
  type: 'prompt_user';
  workItemId: string;
  prompt: {
    question: string;
    options?: Array<string | { label: string; description?: string }>;
    context?: string;
    multiSelect?: boolean;
    questionType?: 'multiple_choice' | 'multi_select' | 'fill_in_blank' | 'yes_no' | 'free_text';
    questions?: Array<{
      question: string;
      options?: Array<string | { label: string; description?: string }>;
      context?: string;
      multiSelect?: boolean;
      questionType?: 'multiple_choice' | 'multi_select' | 'fill_in_blank' | 'yes_no' | 'free_text';
    }>;
  };
  timestamp: number;
}

/**
 * PromptUser hook result - determines what happens next.
 */
export type PromptUserHookResult =
  | { action: 'answer'; answer: string | string[]; contextAddendum?: string }
  | { action: 'block'; reason: string };

// --- Callback Types ---

/** TypeScript callback for internal hooks */
export type HookCallback<T extends InternalHookEvent = InternalHookEvent> = (
  event: T,
  ctx: InternalHookContext
) => Promise<void>;

/** TypeScript callback for prompt_user hooks */
export type PromptUserHookHandler = (
  event: PromptUserHookEvent
) => Promise<PromptUserHookResult>;

/** Shell command hook - spawns subprocess, pipes JSON to stdin */
export interface ShellHook {
  command: string;
  timeout?: number; // ms, default 60000
}

export type HookEntry = HookCallback | ShellHook | PromptUserHookHandler;

// --- Registry ---

const registry = new Map<HookEventType, HookEntry[]>();

/**
 * Register a hook for an event type.
 * Multiple hooks per event are supported; all execute in parallel.
 */
export function registerHook(event: HookEventType, hook: HookEntry): void {
  const hooks = registry.get(event) ?? [];
  hooks.push(hook);
  registry.set(event, hooks);
}

/**
 * Clear all hooks for an event type (useful for testing).
 */
export function clearHooks(event: HookEventType): void {
  registry.delete(event);
}

/**
 * Get all registered hooks for an event type.
 */
export function getHooks(event: HookEventType): HookEntry[] {
  return registry.get(event) ?? [];
}

// --- Executor ---

function isShellHook(h: HookEntry): h is ShellHook {
  return typeof h === 'object' && 'command' in h;
}

function isPromptUserHook(event: HookEventType, hook: HookEntry): hook is PromptUserHookHandler {
  return event === 'prompt_user' && typeof hook === 'function';
}

/**
 * Execute a shell command hook.
 * Pipes JSON payload to stdin, waits for exit.
 * Exit 0 = success, Exit 2 = block (error), other = warning.
 */
async function executeShellHook(
  hook: ShellHook,
  payload: InternalHookEvent,
  ctx: InternalHookContext
): Promise<void> {
  const timeout = hook.timeout ?? 60000;
  const input = JSON.stringify({ ...payload, ...ctx });

  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', hook.command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Hook command failed: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else if (code === 2) {
        // Exit 2 = blocking error
        reject(new Error(stderr.trim() || 'Hook blocked execution'));
      } else {
        // Non-blocking warning
        if (stderr) {
          console.error(`[HOOK:${payload.type}] Warning: ${stderr.trim()}`);
        }
        resolve();
      }
    });

    // Write payload to stdin
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

/**
 * Execute all registered hooks for an event.
 * Hooks run in parallel. Errors are logged but don't block other hooks.
 */
export async function executeHooks(
  event: HookEventType,
  payload: InternalHookEvent,
  ctx: InternalHookContext
): Promise<void> {
  const hooks = registry.get(event) ?? [];
  if (hooks.length === 0) return;

  const executions = hooks.map(async (hook) => {
    try {
      if (isShellHook(hook)) {
        await executeShellHook(hook, payload, ctx);
      } else if (isPromptUserHook(event, hook)) {
        // PromptUser hooks have different signature - they return PromptUserHookResult
        await hook(payload as unknown as PromptUserHookEvent);
      } else {
        const callback = hook as HookCallback;
        await callback(payload, ctx);
      }
    } catch (err) {
      console.error(`[HOOK:${event}] Error:`, err);
    }
  });

  await Promise.all(executions);
}

// --- Config Loading ---

export interface HooksConfig {
  [event: string]: Array<{ command: string; timeout?: number }>;
}

/**
 * Load hooks from JSON config object.
 * Config format:
 * {
 *   "files_modified": [{ "command": "./scripts/on-change.sh", "timeout": 5000 }],
 *   "agent_completed": [{ "command": "python3 ./hooks/log.py" }]
 * }
 */
export function loadHooksFromConfig(config: HooksConfig): void {
  for (const [event, hooks] of Object.entries(config)) {
    if (!isValidEventType(event)) {
      console.error(`[HOOK] Unknown event type in config: ${event}`);
      continue;
    }
    for (const hook of hooks) {
      registerHook(event, hook);
    }
  }
}

function isValidEventType(event: string): event is HookEventType {
  const validEvents: HookEventType[] = [
    'workitem_created',
    'turn_completed',
    'tool_batch_completed',
    'context_threshold',
    'files_modified',
    'artifacts_discovered',
    'agent_completed',
    'agent_message',
    'tool_call_completed',
    'memory_injected',
    'git_commit',
    'escalation_raised',
    'escalation_resolved',
    'watcher_agent_stopped',
    'session_status_changed',
    'prompt_user',
    'stop',
  ];
  return validEvents.includes(event as HookEventType);
}

// --- Backwards Compat (deprecated, remove after migration) ---

/** @deprecated Use executeHooks instead */
export function getHandlers<T extends InternalHookEvent['type']>(
  eventType: T
): Array<HookCallback> {
  const hooks = registry.get(eventType) ?? [];
  // Filter to only TypeScript callbacks (shell hooks can't be returned as handlers)
  return hooks.filter((h): h is HookCallback => !isShellHook(h));
}


### message:user
@ts 1770406423245
Is that the same deal with Trace outputs? 

### function_call
@callId call_kJ6l2xzIB44zblVwcsY8CNEj
@name Grep
@ts 1770406429546
@workItemId f05b8210
{"pattern":"trace|Trace|tracing|output","path":"/Users/jevinnishioka/Desktop/jesus/packages","glob":"**/*.ts","type":"ts","maxResults":200,"caseSensitive":false}

### function_call_output
@callId call_kJ6l2xzIB44zblVwcsY8CNEj
@ts 1770406429559
@durationMs 10
@workItemId f05b8210
packages/decision-watcher/src/engine/index.ts:593:5:The output should be a clear, direct answer that addresses the user's question.`;
packages/decision-watcher/src/engine/index.ts:650:5:The output should be a clear recommendation with rationale.`;
packages/memory-injector/src/injector.ts:98:65:    /\b(bug|error|issue|fail|failure|crash|regress|broken|stack trace)\b/i,
packages/memory-injector/src/injector.ts:1046:16:      // Build output, respecting token limit (BUG #6: continue instead of break for large items)
packages/memory-injector/src/injector.ts:1244:14:    reasoningTrace: string[];
packages/memory-injector/src/injector.ts:1307:16:  // Reasoning trace
packages/memory-injector/src/injector.ts:1308:42:  if (semantic.stateAndProgress.reasoningTrace.length > 0) {
packages/memory-injector/src/injector.ts:1309:34:    sections.push('### Reasoning Trace');
packages/memory-injector/src/injector.ts:1311:60:    for (let i = 0; i < semantic.stateAndProgress.reasoningTrace.length; i++) {
packages/memory-injector/src/injector.ts:1312:69:      sections.push(`${i + 1}. ${semantic.stateAndProgress.reasoningTrace[i]}`);
packages/dashboard/src/domain/mockData.ts:145:5:    outputTokens: 1200,
packages/dashboard/src/domain/mockData.ts:146:10:    totalOutputTokens: 6200,
packages/dashboard/src/domain/mockData.ts:280:5:    outputTokens: 1800,
packages/dashboard/src/domain/mockData.ts:281:10:    totalOutputTokens: 8200,
packages/dashboard/src/domain/mockData.ts:406:5:    outputTokens: 2400,
packages/dashboard/src/domain/mockData.ts:407:10:    totalOutputTokens: 13400,
packages/decision-watcher/src/index.ts:205:23:export type { SemanticOutput } from './semantic/index.js';
packages/memory-injector/src/types.ts:76:5:    trace?: boolean;
packages/dashboard/src/domain/models.ts:142:3:  outputTokens: number;
packages/dashboard/src/domain/models.ts:144:8:  totalOutputTokens: number;
packages/dashboard/src/domain/models.ts:234:8:  totalOutputTokens: number;
packages/dashboard/src/domain/models.ts:322:12:  let totalOutputTokens = 0;
packages/dashboard/src/domain/models.ts:326:12:      totalOutputTokens += call.completionTokens;
packages/dashboard/src/domain/models.ts:345:10:    totalOutputTokens,
packages/harness-daemon/src/subscribers/trace_subscriber.ts:2:4: * TraceSubscriber - Collects file modifications and emits Agent Trace records on commit.
packages/harness-daemon/src/subscribers/trace_subscriber.ts:6:70: * - Phase B (Emit): On git commit, finalizes line ranges and writes trace record
packages/harness-daemon/src/subscribers/trace_subscriber.ts:8:46: * Based on: https://github.com/cursor/agent-trace
packages/harness-daemon/src/subscribers/trace_subscriber.ts:18:9:  AGENT_TRACE_VERSION,
packages/harness-daemon/src/subscribers/trace_subscriber.ts:23:8:  type TraceRecord,
packages/harness-daemon/src/subscribers/trace_subscriber.ts:26:11:  generateTraceId,
packages/harness-daemon/src/subscribers/trace_subscriber.ts:30:29:/** Callback invoked when a trace is emitted */
packages/harness-daemon/src/subscribers/trace_subscriber.ts:31:13:export type TraceEmittedCallback = (trace: TraceRecord) => void;
packages/harness-daemon/src/subscribers/trace_subscriber.ts:37:18:export interface TraceSubscriberConfig {
packages/harness-daemon/src/subscribers/trace_subscriber.ts:40:26:  /** Directory to store trace records (relative to repoRoot) */
packages/harness-daemon/src/subscribers/trace_subscriber.ts:41:3:  traceDir?: string;
packages/harness-daemon/src/subscribers/trace_subscriber.ts:42:21:  /** Tool name for trace records */
packages/harness-daemon/src/subscribers/trace_subscriber.ts:44:24:  /** Tool version for trace records */
packages/harness-daemon/src/subscribers/trace_subscriber.ts:53:4:// TRACE SUBSCRIBER
packages/harness-daemon/src/subscribers/trace_subscriber.ts:56:14:export class TraceSubscriber {
packages/harness-daemon/src/subscribers/trace_subscriber.ts:57:33:  private config: Required<Omit<TraceSubscriberConfig, 'currentModelId'>> & { currentModelId?: string };
packages/harness-daemon/src/subscribers/trace_subscriber.ts:61:11:  private traceEmittedCallbacks: TraceEmittedCallback[] = [];
packages/harness-daemon/src/subscribers/trace_subscriber.ts:64:51:  constructor(eventBus: EventBusProtocol, config: TraceSubscriberConfig) {
packages/harness-daemon/src/subscribers/trace_subscriber.ts:67:7:      traceDir: config.traceDir ?? '.agent-trace',
packages/harness-daemon/src/subscribers/trace_subscriber.ts:77:57:    // Subscribe to git_commit events for auto-emitting traces
packages/harness-daemon/src/subscribers/trace_subscriber.ts:82:47:   * Register a callback to be invoked when a trace is emitted.
packages/harness-daemon/src/subscribers/trace_subscriber.ts:85:5:  onTraceEmitted(callback: TraceEmittedCallback): () => void {
packages/harness-daemon/src/subscribers/trace_subscriber.ts:86:10:    this.traceEmittedCallbacks.push(callback);
packages/harness-daemon/src/subscribers/trace_subscriber.ts:88:24:      const idx = this.traceEmittedCallbacks.indexOf(callback);
packages/harness-daemon/src/subscribers/trace_subscriber.ts:90:14:        this.traceEmittedCallbacks.splice(idx, 1);
packages/harness-daemon/src/subscribers/trace_subscriber.ts:117:44:   * Handle git_commit events to auto-emit traces.
packages/harness-daemon/src/subscribers/trace_subscriber.ts:125:14:    this.emitTrace(sha);
packages/harness-daemon/src/subscribers/trace_subscriber.ts:173:13:   * Emit a trace record for a commit.
packages/harness-daemon/src/subscribers/trace_subscriber.ts:176:7:  emitTrace(revision: string): TraceRecord | null {
packages/harness-daemon/src/subscribers/trace_subscriber.ts:207:11:    const trace: TraceRecord = {
packages/harness-daemon/src/subscribers/trace_subscriber.ts:208:22:      version: AGENT_TRACE_VERSION,
packages/harness-daemon/src/subscribers/trace_subscriber.ts:209:19:      id: generateTraceId(),
packages/harness-daemon/src/subscribers/trace_subscriber.ts:216:16:    // Persist trace record
packages/harness-daemon/src/subscribers/trace_subscriber.ts:217:17:    this.persistTrace(trace);
packages/harness-daemon/src/subscribers/trace_subscriber.ts:220:33:    for (const callback of this.traceEmittedCallbacks) {
packages/harness-daemon/src/subscribers/trace_subscriber.ts:222:18:        callback(trace);
packages/harness-daemon/src/subscribers/trace_subscriber.ts:228:12:    return trace;
packages/harness-daemon/src/subscribers/trace_subscriber.ts:236:13:      const output = execSync(`git diff-tree --no-commit-id --name-only -r ${revision}`, {
packages/harness-daemon/src/subscribers/trace_subscriber.ts:240:14:      return output.trim().split('\n').filter(Boolean);
packages/harness-daemon/src/subscribers/trace_subscriber.ts:436:14:   * Persist trace record to disk.
packages/harness-daemon/src/subscribers/trace_subscriber.ts:438:18:  private persistTrace(trace: TraceRecord): void {
packages/harness-daemon/src/subscribers/trace_subscriber.ts:439:11:    const traceDir = path.join(this.config.repoRoot, this.config.traceDir);
packages/harness-daemon/src/subscribers/trace_subscriber.ts:440:21:    if (!existsSync(traceDir)) {
packages/harness-daemon/src/subscribers/trace_subscriber.ts:441:17:      mkdirSync(traceDir, { recursive: true });
packages/harness-daemon/src/subscribers/trace_subscriber.ts:444:25:    const filename = `${trace.vcs.revision}.json`;
packages/harness-daemon/src/subscribers/trace_subscriber.ts:445:32:    const filepath = path.join(traceDir, filename);
packages/harness-daemon/src/subscribers/trace_subscriber.ts:446:44:    writeFileSync(filepath, JSON.stringify(trace, null, 2));
packages/harness-daemon/src/subscribers/trace_subscriber.ts:486:10:    this.traceEmittedCallbacks = [];
packages/harness-daemon/src/subscribers/trace_subscriber.ts:495:23:export function createTraceSubscriber(
packages/harness-daemon/src/subscribers/trace_subscriber.ts:497:11:  config: TraceSubscriberConfig
packages/harness-daemon/src/subscribers/trace_subscriber.ts:498:4:): TraceSubscriber {
packag
... [truncated 14174 chars]

### function_call
@callId call_SK8NeLrxNtvYNaRYrd75gE0G
@name Read
@ts 1770406434608
@workItemId f05b8210
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/subscribers/trace_subscriber.ts","encoding":"utf-8","maxBytes":120000,"startLine":1,"endLine":260}

### function_call
@callId call_JCD3a0mJXwzePBHWM03mI2z8
@name Read
@ts 1770406434608
@workItemId f05b8210
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/subscribers/trace_subscriber.ts","encoding":"utf-8","maxBytes":120000,"startLine":260,"endLine":530}

### function_call
@callId call_GL3VNSyWNX875b2vtVIkNSEo
@name Grep
@ts 1770406434608
@workItemId f05b8210
{"pattern":"createTraceSubscriber|traceSubscriber|TraceSubscriber|emitTrace|git_commit","path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src","glob":"**/*.ts","type":"ts","maxResults":200,"caseSensitive":false}

### function_call_output
@callId call_SK8NeLrxNtvYNaRYrd75gE0G
@ts 1770406434621
@durationMs 4
@workItemId f05b8210
// Lines 1-260 of 534 total
/**
 * TraceSubscriber - Collects file modifications and emits Agent Trace records on commit.
 *
 * Two-phase pipeline:
 * - Phase A (Collect): Quietly accumulates Write/Edit tool_call events
 * - Phase B (Emit): On git commit, finalizes line ranges and writes trace record
 *
 * Based on: https://github.com/cursor/agent-trace
 */

import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import type { EventBusProtocol } from 'comms-bus';
import type { AgentEvent, ToolCallData, GitCommitData } from 'types';
import {
  AGENT_TRACE_VERSION,
  type ConversationUrlProvider,
  type FileAttribution,
  type LineRange,
  type PendingFileModification,
  type TraceRecord,
  dummyUrlProvider,
  formatModelId,
  generateTraceId,
  rfc3339Timestamp,
} from 'types';

/** Callback invoked when a trace is emitted */
export type TraceEmittedCallback = (trace: TraceRecord) => void;

// ============================================
// CONFIGURATION
// ============================================

export interface TraceSubscriberConfig {
  /** Repository root directory */
  repoRoot: string;
  /** Directory to store trace records (relative to repoRoot) */
  traceDir?: string;
  /** Tool name for trace records */
  toolName?: string;
  /** Tool version for trace records */
  toolVersion?: string;
  /** URL provider for conversation links */
  urlProvider?: ConversationUrlProvider;
  /** Current model being used (provider/model format) */
  currentModelId?: string;
}

// ============================================
// TRACE SUBSCRIBER
// ============================================

export class TraceSubscriber {
  private config: Required<Omit<TraceSubscriberConfig, 'currentModelId'>> & { currentModelId?: string };
  private unsubscribeToolCall: (() => void) | null = null;
  private unsubscribeGitCommit: (() => void) | null = null;
  private pendingModifications: Map<string, PendingFileModification[]> = new Map();
  private traceEmittedCallbacks: TraceEmittedCallback[] = [];
  private closed = false;

  constructor(eventBus: EventBusProtocol, config: TraceSubscriberConfig) {
    this.config = {
      repoRoot: config.repoRoot,
      traceDir: config.traceDir ?? '.agent-trace',
      toolName: config.toolName ?? 'agent',
      toolVersion: config.toolVersion ?? '0.1.0',
      urlProvider: config.urlProvider ?? dummyUrlProvider,
      currentModelId: config.currentModelId,
    };

    // Subscribe to tool_call events for collecting modifications
    this.unsubscribeToolCall = eventBus.subscribe('tool_call', (event) => this.handleToolCallEvent(event));

    // Subscribe to git_commit events for auto-emitting traces
    this.unsubscribeGitCommit = eventBus.subscribe('git_commit', (event) => this.handleGitCommitEvent(event as AgentEvent<GitCommitData>));
  }

  /**
   * Register a callback to be invoked when a trace is emitted.
   * Use this for external integrations that need to react to commits.
   */
  onTraceEmitted(callback: TraceEmittedCallback): () => void {
    this.traceEmittedCallbacks.push(callback);
    return () => {
      const idx = this.traceEmittedCallbacks.indexOf(callback);
      if (idx !== -1) {
        this.traceEmittedCallbacks.splice(idx, 1);
      }
    };
  }

  /**
   * Set the current model ID for new modifications.
   */
  setCurrentModel(provider: string, model: string): void {
    this.config.currentModelId = formatModelId(provider, model);
  }

  /**
   * Handle tool_call events for collecting modifications.
   */
  private handleToolCallEvent(event: AgentEvent<ToolCallData>): void {
    if (this.closed) return;

    const data = event.data;
    if (data.phase !== 'completed') return;
    if (!data.success) return;
    if (data.toolName !== 'Write' && data.toolName !== 'Edit') return;

    this.collectModification(event, data);
  }

  /**
   * Handle git_commit events to auto-emit traces.
   */
  private handleGitCommitEvent(event: AgentEvent<GitCommitData>): void {
    if (this.closed) return;

    const { sha } = event.data;
    if (!sha || !isValidGitSha(sha)) return;

    this.emitTrace(sha);
  }

  /**
   * Collect a file modification from a tool_call event.
   */
  private collectModification(event: AgentEvent<unknown>, data: ToolCallData): void {
    const args = data.arguments as Record<string, unknown>;
    const filePath = args.file_path as string;
    if (!filePath) return;

    const modification: PendingFileModification = {
      filePath,
      relativePath: this.getRelativePath(filePath),
      toolName: data.toolName as 'Write' | 'Edit',
      sessionKey: event.sessionKey,
      modelId: this.config.currentModelId,
      timestamp: event.timestamp,
      requestId: event.requestId,
    };

    // Capture content for Write
    if (data.toolName === 'Write') {
      modification.content = args.content as string;
    }

    // Capture old/new for Edit
    if (data.toolName === 'Edit') {
      modification.oldContent = args.old_string as string;
      modification.newContent = args.new_string as string;
    }

    const existing = this.pendingModifications.get(filePath) ?? [];
    existing.push(modification);
    this.pendingModifications.set(filePath, existing);
  }

  /**
   * Get path relative to repo root.
   */
  private getRelativePath(absolutePath: string): string {
    if (absolutePath.startsWith(this.config.repoRoot)) {
      return absolutePath.slice(this.config.repoRoot.length + 1);
    }
    return absolutePath;
  }

  /**
   * Emit a trace record for a commit.
   * Call this after creating a git commit.
   */
  emitTrace(revision: string): TraceRecord | null {
    if (this.pendingModifications.size === 0) {
      return null;
    }

    // Get files in this commit
    const committedFiles = this.getCommittedFiles(revision);
    if (committedFiles.length === 0) {
      return null;
    }

    // Build file attributions for files we have modifications for
    const files: FileAttribution[] = [];
    for (const relativePath of committedFiles) {
      const absolutePath = path.join(this.config.repoRoot, relativePath);
      const modifications = this.pendingModifications.get(absolutePath);
      if (!modifications || modifications.length === 0) continue;

      const attribution = this.buildFileAttribution(relativePath, modifications, revision);
      if (attribution) {
        files.push(attribution);
      }

      // Clear processed modifications
      this.pendingModifications.delete(absolutePath);
    }

    if (files.length === 0) {
      return null;
    }

    const trace: TraceRecord = {
      version: AGENT_TRACE_VERSION,
      id: generateTraceId(),
      timestamp: rfc3339Timestamp(),
      vcs: { type: 'git', revision },
      tool: { name: this.config.toolName, version: this.config.toolVersion },
      files,
    };

    // Persist trace record
    this.persistTrace(trace);

    // Notify registered callbacks
    for (const callback of this.traceEmittedCallbacks) {
      try {
        callback(trace);
      } catch {
        // Ignore callback errors
      }
    }

    return trace;
  }

  /**
   * Get list of files changed in a commit.
   */
  private getCommittedFiles(revision: string): string[] {
    try {
      const output = execSync(`git diff-tree --no-commit-id --name-only -r ${revision}`, {
        cwd: this.config.repoRoot,
        encoding: 'utf-8',
      });
      return output.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Build file attribution from modifications.
   */
  private buildFileAttribution(
    relativePath: string,
    modifications: PendingFileModification[],
    revision: string
  ): FileAttribution | null {
    // Read file content at this revision
    const content = this.getFileAtRevision(relativePath, revision);
    if (!content) {
      // Fall back to attributing entire file
      return this.buildFallbackAttribution(relativePath, modifications);
    }


### function_call_output
@callId call_JCD3a0mJXwzePBHWM03mI2z8
@ts 1770406434622
@durationMs 3
@workItemId f05b8210
// Lines 260-530 of 534 total

    const lines = content.split('\n');
    const conversations: FileAttribution['conversations'] = [];

    // Group modifications by session
    const bySession = new Map<string, PendingFileModification[]>();
    for (const mod of modifications) {
      const key = mod.sessionKey ?? 'unknown';
      const existing = bySession.get(key) ?? [];
      existing.push(mod);
      bySession.set(key, existing);
    }

    for (const [sessionKey, mods] of bySession) {
      const ranges: LineRange[] = [];

      for (const mod of mods) {
        const range = this.computeLineRange(mod, lines, content);
        if (range) {
          ranges.push(range);
        }
      }

      if (ranges.length === 0) {
        // Fallback: attribute entire file
        ranges.push({
          start_line: 1,
          end_line: lines.length,
          content_hash: this.contentHash(content),
        });
      }

      // Merge overlapping/adjacent ranges
      const mergedRanges = this.mergeRanges(ranges);

      const modelId = mods[0]?.modelId;
      conversations.push({
        url: this.config.urlProvider.getUrl(sessionKey) ?? `session://${sessionKey}`,
        contributor: {
          type: 'ai',
          model_id: modelId,
        },
        ranges: mergedRanges,
      });
    }

    return { path: relativePath, conversations };
  }

  /**
   * Compute line range for a modification by locating content in file.
   */
  private computeLineRange(
    mod: PendingFileModification,
    lines: string[],
    fullContent: string
  ): LineRange | null {
    // For Write: attribute entire file
    if (mod.toolName === 'Write') {
      return {
        start_line: 1,
        end_line: lines.length,
        content_hash: this.contentHash(fullContent),
      };
    }

    // For Edit: try to locate newContent in file
    if (mod.toolName === 'Edit' && mod.newContent) {
      const newContentTrimmed = mod.newContent.trim();
      const index = fullContent.indexOf(newContentTrimmed);
      if (index !== -1) {
        // Count lines to this position
        const before = fullContent.slice(0, index);
        const startLine = before.split('\n').length;
        const endLine = startLine + mod.newContent.split('\n').length - 1;
        return {
          start_line: startLine,
          end_line: endLine,
          content_hash: this.contentHash(mod.newContent),
        };
      }
    }

    return null;
  }

  /**
   * Build fallback attribution when we can't compute precise ranges.
   */
  private buildFallbackAttribution(
    relativePath: string,
    modifications: PendingFileModification[]
  ): FileAttribution {
    // Group by session
    const bySession = new Map<string, PendingFileModification[]>();
    for (const mod of modifications) {
      const key = mod.sessionKey ?? 'unknown';
      const existing = bySession.get(key) ?? [];
      existing.push(mod);
      bySession.set(key, existing);
    }

    const conversations: FileAttribution['conversations'] = [];
    for (const [sessionKey, mods] of bySession) {
      const modelId = mods[0]?.modelId;
      conversations.push({
        url: this.config.urlProvider.getUrl(sessionKey) ?? `session://${sessionKey}`,
        contributor: {
          type: 'ai',
          model_id: modelId,
        },
        ranges: [
          {
            start_line: 1,
            end_line: 1, // Unknown, will be coarse
          },
        ],
      });
    }

    return { path: relativePath, conversations };
  }

  /**
   * Get file content at a specific revision.
   */
  private getFileAtRevision(relativePath: string, revision: string): string | null {
    try {
      return execSync(`git show ${revision}:${relativePath}`, {
        cwd: this.config.repoRoot,
        encoding: 'utf-8',
      });
    } catch {
      return null;
    }
  }

  /**
   * Compute content hash for tracking code movement.
   */
  private contentHash(content: string): string {
    const hash = createHash('md5').update(content).digest('hex').slice(0, 8);
    return `md5:${hash}`;
  }

  /**
   * Merge overlapping or adjacent line ranges.
   */
  private mergeRanges(ranges: LineRange[]): LineRange[] {
    if (ranges.length <= 1) return ranges;

    // Sort by start line
    const sorted = [...ranges].sort((a, b) => a.start_line - b.start_line);
    const merged: LineRange[] = [];

    let current = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      if (next.start_line <= current.end_line + 1) {
        // Overlapping or adjacent - merge
        current = {
          start_line: current.start_line,
          end_line: Math.max(current.end_line, next.end_line),
          // Drop content_hash when merging
        };
      } else {
        merged.push(current);
        current = next;
      }
    }
    merged.push(current);

    return merged;
  }

  /**
   * Persist trace record to disk.
   */
  private persistTrace(trace: TraceRecord): void {
    const traceDir = path.join(this.config.repoRoot, this.config.traceDir);
    if (!existsSync(traceDir)) {
      mkdirSync(traceDir, { recursive: true });
    }

    const filename = `${trace.vcs.revision}.json`;
    const filepath = path.join(traceDir, filename);
    writeFileSync(filepath, JSON.stringify(trace, null, 2));
  }

  /**
   * Get count of pending modifications.
   */
  getPendingCount(): number {
    let count = 0;
    for (const mods of this.pendingModifications.values()) {
      count += mods.length;
    }
    return count;
  }

  /**
   * Get pending file paths.
   */
  getPendingFiles(): string[] {
    return Array.from(this.pendingModifications.keys());
  }

  /**
   * Clear all pending modifications without emitting.
   */
  clear(): void {
    this.pendingModifications.clear();
  }

  /**
   * Close the subscriber.
   */
  close(): void {
    if (this.unsubscribeToolCall) {
      this.unsubscribeToolCall();
      this.unsubscribeToolCall = null;
    }
    if (this.unsubscribeGitCommit) {
      this.unsubscribeGitCommit();
      this.unsubscribeGitCommit = null;
    }
    this.traceEmittedCallbacks = [];
    this.closed = true;
  }
}

// ============================================
// FACTORY
// ============================================

export function createTraceSubscriber(
  eventBus: EventBusProtocol,
  config: TraceSubscriberConfig
): TraceSubscriber {
  return new TraceSubscriber(eventBus, config);
}

// ============================================
// GIT HELPERS
// ============================================

const GIT_SHA_PATTERN = /^[a-f0-9]{7,40}$/;

/**
 * Validate a git SHA to prevent command injection.
 */
function isValidGitSha(sha: string): boolean {
  return GIT_SHA_PATTERN.test(sha);
}

/**
 * Helper to detect git commit in Bash tool output and extract SHA.
 * Use this to hook into agent-initiated commits.
 *
 * Pattern matches:
 * - "[main abc1234] Commit message"
 * - "[detached HEAD abc1234] Commit message"
 */
export function extractCommitSha(bashOutput: string): string | null {
  const match = bashOutput.match(/\[[\w\s/-]+\s+([a-f0-9]{7,40})\]/);
  return match?.[1] ?? null;
}

/**
 * Check if a bash command is a git commit.
 */

### function_call_output
@callId call_GL3VNSyWNX875b2vtVIkNSEo
@ts 1770406434623
@durationMs 10
@workItemId f05b8210
packages/harness-daemon/src/subscribers/trace_subscriber.ts:2:4: * TraceSubscriber - Collects file modifications and emits Agent Trace records on commit.
packages/harness-daemon/src/subscribers/trace_subscriber.ts:37:18:export interface TraceSubscriberConfig {
packages/harness-daemon/src/subscribers/trace_subscriber.ts:56:14:export class TraceSubscriber {
packages/harness-daemon/src/subscribers/trace_subscriber.ts:57:33:  private config: Required<Omit<TraceSubscriberConfig, 'currentModelId'>> & { currentModelId?: string };
packages/harness-daemon/src/subscribers/trace_subscriber.ts:64:51:  constructor(eventBus: EventBusProtocol, config: TraceSubscriberConfig) {
packages/harness-daemon/src/subscribers/trace_subscriber.ts:77:21:    // Subscribe to git_commit events for auto-emitting traces
packages/harness-daemon/src/subscribers/trace_subscriber.ts:78:53:    this.unsubscribeGitCommit = eventBus.subscribe('git_commit', (event) => this.handleGitCommitEvent(event as AgentEvent<GitCommitData>));
packages/harness-daemon/src/subscribers/trace_subscriber.ts:117:13:   * Handle git_commit events to auto-emit traces.
packages/harness-daemon/src/subscribers/trace_subscriber.ts:125:10:    this.emitTrace(sha);
packages/harness-daemon/src/subscribers/trace_subscriber.ts:176:3:  emitTrace(revision: string): TraceRecord | null {
packages/harness-daemon/src/subscribers/trace_subscriber.ts:495:17:export function createTraceSubscriber(
packages/harness-daemon/src/subscribers/trace_subscriber.ts:497:11:  config: TraceSubscriberConfig
packages/harness-daemon/src/subscribers/trace_subscriber.ts:498:4:): TraceSubscriber {
packages/harness-daemon/src/subscribers/trace_subscriber.ts:499:14:  return new TraceSubscriber(eventBus, config);
packages/harness-daemon/src/harness/harness.ts:41:10:import { createTraceSubscriber, extractCommitSha, isGitCommitCommand, type TraceSubscriber } from '../subscribers/trace_subscriber.js';
packages/harness-daemon/src/harness/harness.ts:582:11:  private traceSubscriber: TraceSubscriber | null = null;
packages/harness-daemon/src/harness/harness.ts:753:63:    // Initialize SyncClient for agent-memory daemon (used by TraceSubscriber)
packages/harness-daemon/src/harness/harness.ts:764:19:    // Initialize TraceSubscriber for collecting Write/Edit tool calls and emitting on git commits
packages/harness-daemon/src/harness/harness.ts:765:10:    this.traceSubscriber = createTraceSubscriber(this.eventBus, {
packages/harness-daemon/src/harness/harness.ts:770:24:    this.logger.debug('TraceSubscriber initialized', { repoRoot: workingDir });
packages/harness-daemon/src/harness/harness.ts:773:10:    this.traceSubscriber.onTraceEmitted(async (trace) => {
packages/harness-daemon/src/harness/harness.ts:803:26:      traceEnabled: this.traceSubscriber !== null,
packages/harness-daemon/src/harness/harness.ts:2050:55:        // Detect git commits from Bash tool and emit git_commit event
packages/harness-daemon/src/harness/harness.ts:2057:23:              // Emit git_commit event via EventBus
packages/harness-daemon/src/harness/harness.ts:2064:50:              this.eventBus.publish(createEvent('git_commit', gitCommitData, undefined, requestId, sessionKey));
packages/harness-daemon/src/harness/harness.ts:2187:23:            // Update TraceSubscriber with current model
packages/harness-daemon/src/harness/harness.ts:2188:18:            this.traceSubscriber?.setCurrentModel(selection.provider, selection.model);
packages/harness-daemon/src/harness/harness.ts:2468:15:    // Update TraceSubscriber with current model
packages/harness-daemon/src/harness/harness.ts:2469:10:    this.traceSubscriber?.setCurrentModel(modelSelection.provider, modelSelection.model);
packages/harness-daemon/src/harness/harness.ts:3327:14:    if (this.traceSubscriber) {
packages/harness-daemon/src/harness/harness.ts:3329:14:        this.traceSubscriber.close();
packages/harness-daemon/src/harness/harness.ts:3330:35:        this.logger.debug('Closed TraceSubscriber');
packages/harness-daemon/src/harness/harness.ts:3332:30:        this.logger.warning('TraceSubscriber close failed', { error: String(error) });
packages/harness-daemon/src/harness/harness.ts:3334:14:        this.traceSubscriber = null;
packages/harness-daemon/src/harness/control_plane_routes.ts:1242:35:    if (asString(entry.type) !== 'git_commit') continue;
packages/harness-daemon/src/harness/control_plane_routes.ts:3089:17:  if (type === 'git_commit') return 'trace';

### function_call
@callId call_rdKzrxV99T2Dw2bBCFwmENos
@name Read
@ts 1770406441562
@workItemId f05b8210
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/harness.ts","encoding":"utf-8","maxBytes":120000,"startLine":740,"endLine":820}

### function_call
@callId call_o7hmEPJNCRlHT1FlaUCqHfPK
@name Read
@ts 1770406441562
@workItemId f05b8210
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/harness.ts","encoding":"utf-8","maxBytes":120000,"startLine":2036,"endLine":2078}

### function_call
@callId call_L3qvQGkJi0aSPqf7xtssyhjc
@name Read
@ts 1770406441562
@workItemId f05b8210
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/harness.ts","encoding":"utf-8","maxBytes":120000,"startLine":2168,"endLine":2210}

### function_call_output
@callId call_rdKzrxV99T2Dw2bBCFwmENos
@ts 1770406441571
@durationMs 6
@workItemId f05b8210
// Lines 740-820 of 3255 total

    // Initialize MemoryInjector if enabled
    if (config.memory.enabled) {
      this.memoryInjector = createMemoryInjector({
        baseUrl: config.memory.baseUrl,
        timeout: config.memory.timeoutMs,
      });
      this.logger.info('MemoryInjector initialized', {
        baseUrl: config.memory.baseUrl,
        timeoutMs: config.memory.timeoutMs,
      });
    }

    // Initialize SyncClient for agent-memory daemon (used by TraceSubscriber)
    const memoryDaemonUrl = process.env.MEMORY_DAEMON_URL || 'http://127.0.0.1:3001';
    try {
      this.memoryClient = new SyncClient(memoryDaemonUrl);
      this.logger.info('Memory client initialized for traces', { url: memoryDaemonUrl });
    } catch (error) {
      this.logger.warning('Failed to initialize memory client (traces will not be persisted)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Initialize TraceSubscriber for collecting Write/Edit tool calls and emitting on git commits
    this.traceSubscriber = createTraceSubscriber(this.eventBus, {
      repoRoot: workingDir,
      toolName: 'agent',
      toolVersion: '0.1.0',
    });
    this.logger.debug('TraceSubscriber initialized', { repoRoot: workingDir });

    // Register callback to persist traces to database when emitted
    this.traceSubscriber.onTraceEmitted(async (trace) => {
      try {
        if (this.memoryClient) {
          await this.memoryClient.traces.create({
            revision: trace.vcs.revision,
            session_key: undefined, // Session key is per-file in trace, top-level is nullable
            tool_name: trace.tool.name,
            tool_version: trace.tool.version,
            trace: trace,
          });
          this.logger.info('Trace persisted to database', { revision: trace.vcs.revision });
        }
      } catch (error) {
        // Log warning but don't crash the agent if DB is down
        this.logger.warning('Failed to persist trace to database (is agent-memory daemon running?)', {
          error: error instanceof Error ? error.message : String(error),
          revision: trace.vcs.revision,
        });
      }
    });


    const defaultAgent = config.agents[config.defaultAgent];
    this.logger.info('AgentHarness initialized', {
      defaultAgent: config.defaultAgent,
      provider: defaultAgent?.llm.provider,
      model: defaultAgent?.llm.model,
      agentCount: Object.keys(config.agents).length,
      graphdEnabled: this.graphd !== null,
      memoryEnabled: this.memoryInjector !== null,
      traceEnabled: this.traceSubscriber !== null,
    });
  }

  /**
   * Get the EventBus for external subscribers.
   */
  getEventBus(): EventBusProtocol {
    return this.eventBus;
  }

  /**
   * Check if GraphD is initialized and running.
   */
  private isGraphDReady(): boolean {
    return !!(this.graphd && this.graphdStarted);
  }


### function_call_output
@callId call_o7hmEPJNCRlHT1FlaUCqHfPK
@ts 1770406441571
@durationMs 5
@workItemId f05b8210
// Lines 2036-2078 of 3255 total
        // Entity graph: release lease, compute blast radius, re-parse modified file
        let egModified = false;
        if (egHooks) {
          try {
            const egResult = await egHooks.postToolUse(sessionKey, toolName, args);
            if (egResult.context) {
              toolResult = { ...toolResult, output: toolResult.output + '\n\n' + egResult.context };
              egModified = true;
            }
          } catch (err) {
            logger.warning('Entity graph postToolUse failed', { error: String(err) });
          }
        }

        // Detect git commits from Bash tool and emit git_commit event
        if (toolName === 'Bash' && toolResult.status === 'success') {
          const command = args.command as string | undefined;
          if (command && isGitCommitCommand(command)) {
            const sha = extractCommitSha(toolResult.output);
            if (sha) {
              const range = resolveGitCommitRange(workingDir, sha);
              // Emit git_commit event via EventBus
              const gitCommitData: GitCommitData = {
                sha,
                headSha: range.headSha,
                ...(range.baseSha ? { baseSha: range.baseSha } : {}),
                command,
              };
              this.eventBus.publish(createEvent('git_commit', gitCommitData, undefined, requestId, sessionKey));

              // Execute PostGitCommit hooks if executor available
              if (executor) {
                const gitContext: SkillHookContext = {
                  event: 'PostGitCommit',
                  toolName: 'Bash',
                  toolParams: args,
                  toolResult,
                  sessionKey,
                  requestId,
                  workingDir,
                  commitSha: sha,
                };
                await executor.execute('PostGitCommit', gitContext);

### function_call_output
@callId call_L3qvQGkJi0aSPqf7xtssyhjc
@ts 1770406441573
@durationMs 3
@workItemId f05b8210
// Lines 2168-2210 of 3255 total
    // Build plan mode options if enabled
    const planModeOptions = planMode ? {
      enabled: true,
      promptAddendum: getPlanningPromptAddendum(),
      toolFilter: (tools: string[]) => this.filterPlanModeTools(tools),
    } : undefined;

    // Create closure for per-agent-type model selection lookup
    // NO FALLBACK: Each agent type must have an explicit model selection
    const getModelSelection = store
      ? (queryAgentType: string) => {
          const selection = store.getModelSelection(queryAgentType);
          if (selection) {
            this.logger.debug('Model selection for agent', {
              agentType: queryAgentType,
              model: selection.model,
              provider: selection.provider,
              reasoning: selection.reasoning,
            });
            // Update TraceSubscriber with current model
            this.traceSubscriber?.setCurrentModel(selection.provider, selection.model);
          }
          return selection;
        }
      : undefined;

    // Build orchestrator runtime with optional hooks
    const sessionKey = context.sessionKey;
    const sessionState = this.getSessionState(sessionKey);
    let lastWatcherIteration = 0;
    const minWatcherGap = DEFAULT_ORCHESTRATOR_CONFIG.minWatcherIterationGap;
    const effectiveWorkingDir = workingDir ?? this.config.tools.workingDir;

    const asyncEnabledForRun = (store?.isAsyncModeEnabled() ?? false) || !!hookRegistry;

    // Only create/use watcher hooks when async mode is enabled for this session/run
    let effectiveHookRegistry = hookRegistry;
    if (asyncEnabledForRun && !hookRegistry) {
      // Check if we already have a cached hook registry for this session
      const cachedRegistry = sessionState?.hookRegistry;
      if (cachedRegistry) {
        effectiveHookRegistry = cachedRegistry;
        this.logger.debug('Using cached watcher hook registry', { sessionKey });
