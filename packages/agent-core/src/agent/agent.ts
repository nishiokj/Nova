/**
 * Agent - Pure execution primitive.
 *
 * Receives ContextWindow by value and mutates it locally during execution.
 * Returns AgentResult with all outputs.
 */

import type { LLMAdapter, Message, LLMRequestConfig } from '../llm/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolDefinition, ToolResult } from '../types/tools.js';
import { ContextWindow } from '../context/index.js';
import type { WorkItem } from '../work/work-item.js';
import type {
  AgentConfig,
  AgentRunParams,
  AgentResult,
  AgentMetrics,
  EventEmitCallback,
  UserPromptInfo,
  AgentHooks,
} from './types.js';
import { noopEmit } from './types.js';
import type { AgentRegistry } from './agent-registry.js';
import { createEvent } from '../types/events.js';
import { buildSystemMessage } from '../context/index.js';
import { createWorkItem } from '../work/work-item.js';
import { errorResult, successResult } from '../types/tools.js';
import { coerceStructuredOutput } from '../shared/structured_output.js';
import { createMicroQueue } from '../shared/microqueue.js';

type AgentAction = 'done' | 'need_user_input' | 'continue';

const MAX_IDENTICAL_TOOL_CALLS = 2;

const REFUSAL_PATTERNS = [
  /cannot be completed/i,
  /can't be completed/i,
  /cannot complete/i,
  /unable to complete/i,
  /exceeds? (?:the )?(?:budget|limit)/i,
  /not (?:possible|achievable|feasible)/i,
];

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
  private lastRequestConfig: LLMRequestConfig | null = null;
  private hooks?: AgentHooks;

  constructor(
    config: AgentConfig,
    llm: LLMAdapter,
    toolRegistry: ToolRegistry,
    emit: EventEmitCallback = noopEmit,
    requestId: string = '',
    agentRegistry?: AgentRegistry,
    llmConfig?: LLMRequestConfig,
    hooks?: AgentHooks
  ) {
    this.config = config;
    this.llm = llm;
    this.toolRegistry = toolRegistry;
    this.emit = emit;
    this.requestId = requestId;
    this.agentRegistry = agentRegistry;
    this.llmConfig = llmConfig ?? { model: 'unknown' };
    this.hooks = hooks;
  }

  /**
   * Execute the agent on a work item.
   * Agent reads from globalContext, writes to its own localContext.
   * GlobalContext is never mutated.
   */
  async run(params: AgentRunParams): Promise<AgentResult> {
    const { globalContext, workItem, cwd } = params;

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
      terminationReason: '',
      needsUserInput: false,
      isRefusal: false,
      localContext,
    };

    try {
      await this.executeLoop(globalContext, localContext, workItem, result, metrics, startTime, cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.error = message;
      result.terminationReason = `exception:${message}`;
      this.emitLlmError(error instanceof Error ? error : new Error(message), workItem.workId);

      // Synthesize response from accumulated work if we have any
      // This preserves partial progress when rate limits or other errors interrupt execution
      const accumulatedResponse = this.synthesizePartialResponse(localContext, result.response);
      if (accumulatedResponse) {
        result.response = `${accumulatedResponse}\n\n[Execution interrupted: ${message}]`;
      }
    }

    metrics.durationMs = Date.now() - startTime;

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
      const elapsedMs = Date.now() - startTime;
      console.error(`[AGENT DEBUG] Starting iteration ${iteration}/${maxIterations}, elapsed=${elapsedMs}ms, toolCallsMade=${metrics.toolCallsMade}, agent=${this.config.type}`);

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

      const systemMessage = this.buildSystemMessage(workItem, {
        iteration: iteration + 1,
        maxIterations,
        toolCallsUsed: metrics.toolCallsMade,
        maxToolCalls: workItem.bounds.maxToolCalls,
        elapsedMs,
        maxDurationMs: workItem.bounds.maxDurationMs,
      });

      const allTools = [
        ...this.toolRegistry.getDefinitions(),
        ...(this.agentRegistry?.listToolDefinitions() ?? []),
      ];
      const allowedTools = this.filterAllowedTools(allTools);

      const messages = this.buildMessages(systemMessage, workItem, globalContext, localContext);

      // On the last iteration OR when approaching bounds, don't provide tools to force synthesis
      // This ensures the LLM produces structured output instead of more tool calls
      const isLastIteration = iteration === maxIterations - 1;
      const toolBudgetNearlyExhausted = metrics.toolCallsMade >= workItem.bounds.maxToolCalls * 0.8;
      const timeBudgetNearlyExhausted = elapsedMs >= workItem.bounds.maxDurationMs * 0.8;
      const shouldWithholdTools = isLastIteration || toolBudgetNearlyExhausted || timeBudgetNearlyExhausted;

      const toolsForThisCall = shouldWithholdTools ? undefined : (allowedTools.length > 0 ? allowedTools : undefined);

      if (shouldWithholdTools && allowedTools.length > 0) {
        console.error(`[AGENT DEBUG] Withholding tools to force synthesis: iteration=${iteration}/${maxIterations}, toolCalls=${metrics.toolCallsMade}/${workItem.bounds.maxToolCalls}, elapsed=${elapsedMs}/${workItem.bounds.maxDurationMs}ms, agent=${this.config.type}`);
      }

      const llmStartTime = Date.now();
      this.lastRequestConfig = this.llmConfig;
      const response = await this.llm.respond({
        messages: messages as unknown as Message[],
        tools: toolsForThisCall,
        llm: this.llmConfig,
        responseSchema: this.config.outputSchema,
      });
      const llmDurationMs = Date.now() - llmStartTime;
      metrics.llmCallsMade++;

      this.emitLlmCall(response, messages, llmDurationMs, allowedTools, workItem.workId);

      // Update local context metrics with actual token usage from LLM
      if (response.usage) {
        localContext.updateMetrics(
          response.usage.promptTokens ?? 0,
          response.usage.completionTokens ?? 0
        );
      }

      const content = response.content ?? '';
      const toolCalls = response.toolCalls ?? [];
      const structuredOutput = this.parseStructuredOutput(content);
      if (structuredOutput) {
        result.structuredOutput = structuredOutput;
      }

      this.addAssistantMessage(localContext, content, toolCalls);

      const action = this.extractStructuredAction(structuredOutput);
      const responseText = this.extractStructuredResponse(structuredOutput);
      const structuredPrompt = this.extractStructuredUserPrompt(structuredOutput);

      console.error(`[AGENT DEBUG] LLM response: iteration=${iteration}, agent=${this.config.type}, action=${action}, hasResponseText=${!!responseText}, responseTextLength=${responseText?.length ?? 0}, toolCallCount=${toolCalls.length}, contentLength=${content.length}`);

      if (toolCalls.length > 0) {
        console.error(`[AGENT DEBUG] Processing ${toolCalls.length} tool calls, iteration=${iteration}, agent=${this.config.type}`);
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

        console.error(`[AGENT DEBUG] After processToolCalls: terminationReason=${result.terminationReason}, needsUserInput=${result.needsUserInput}, toolCallsMade=${metrics.toolCallsMade}, maxToolCalls=${workItem.bounds.maxToolCalls}`);

        if (result.needsUserInput || result.terminationReason) {
          console.error(`[AGENT DEBUG] Early exit after tool calls: terminationReason=${result.terminationReason}, needsUserInput=${result.needsUserInput}`);
          result.filesRead = Array.from(localReadFiles);
          return;
        }

        // Handle completion after tool calls
        if (action === 'done') {
          const goalReached = structuredOutput?.goalStateReached === true;
          if (!goalReached) {
            result.terminationReason = 'invalid_action';
            result.error = 'Action "done" requires goalStateReached: true.';
            break;
          }
          const finalText = responseText ?? content;
          if (REFUSAL_PATTERNS.some((p) => p.test(finalText))) {
            result.isRefusal = true;
            result.error = 'LLM refused to complete the task';
            result.terminationReason = 'refusal';
          } else {
            result.success = true;
            result.response = finalText;
            result.terminationReason = 'goal_state_reached';
          }
          result.filesRead = Array.from(localReadFiles);
          return;
        }

        // Handle user input request after tool calls
        if (action === 'need_user_input' && structuredPrompt) {
          result.needsUserInput = true;
          result.userPrompt = structuredPrompt;
          result.terminationReason = 'user_input_required';
          result.filesRead = Array.from(localReadFiles);
          return;
        }

        // Capture partial response even when continuing (in case we hit bounds later)
        if (responseText && responseText.trim().length > 0) {
          result.response = responseText;
        }

        continue;
      }

      if (action === 'done') {
        const goalReached = structuredOutput?.goalStateReached === true;
        if (!goalReached) {
          result.terminationReason = 'invalid_action';
          result.error = 'Action "done" requires goalStateReached: true.';
          break;
        }
        const finalText = responseText ?? content;
        if (REFUSAL_PATTERNS.some((p) => p.test(finalText))) {
          result.isRefusal = true;
          result.error = 'LLM refused to complete the task';
          result.terminationReason = 'refusal';
        } else {
          result.success = true;
          result.response = finalText;
          result.terminationReason = 'goal_state_reached';
        }
        result.filesRead = Array.from(localReadFiles);
        return;
      }

      if (action === 'need_user_input') {
        if (structuredPrompt) {
          result.needsUserInput = true;
          result.userPrompt = structuredPrompt;
          result.terminationReason = 'user_input_required';
          result.filesRead = Array.from(localReadFiles);
          return;
        }
        // No valid userPrompt provided, continue execution
        continue;
      }

      if (action === 'continue') {
        // Capture partial response even when continuing (in case we hit bounds later)
        if (responseText && responseText.trim().length > 0) {
          result.response = responseText;
        }
        continue;
      }

      const responseCandidate = responseText ?? content;
      if (responseCandidate.trim().length > 0) {
        result.response = responseCandidate;
      }
      result.terminationReason = 'no_action';
      const preview = responseCandidate.trim().slice(0, 1000);
      result.error = preview
        ? `LLM response has no tools and no action directive. Response preview: ${preview}`
        : 'LLM response has no tools and no action directive';
      break;
    }

    // Always capture all assistant responses even without a terminal action.
    if (!result.response) {
      const messages = localContext.getItemsByType('message') as Array<{ role: string; content: string | unknown[] }>;
      const assistantContents = messages
        .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0)
        .map(m => m.content as string);
      console.error(`[AGENT DEBUG] Fallback response capture: found ${assistantContents.length} assistant messages, agent=${this.config.type}, terminationReason=${result.terminationReason}`);

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
          console.error(`[AGENT DEBUG] Using tool call summary as fallback response for ${this.config.type}`);
        }
      }
    }

    // Handle exhausted resources - treat as partial success if we have content
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

  private buildSystemMessage(
    workItem: WorkItem,
    constraints?: {
      iteration?: number;
      maxIterations?: number;
      toolCallsUsed?: number;
      maxToolCalls?: number;
      elapsedMs?: number;
      maxDurationMs?: number;
    }
  ): string {
    const base = this.config.systemPrompt ? `${this.config.systemPrompt}\n\n` : '';
    const contextInfo = buildSystemMessage(
      workItem.goal,
      workItem.objective,
      undefined,
      this.toolRegistry.getWorkingDir(),
      constraints
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

    const hasUserInput = globalItems.some(
      (item) => item.type === 'message' && (item as any).role === 'user'
    );

    if (!hasUserInput) {
      messages.push({
        role: 'user',
        content: `Execute the following objective:\n\n${workItem.objective}`,
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

    console.error(`[AGENT DEBUG] buildMessages: agent=${this.config.type}, messageCount=${messages.length}, functionCalls=${functionCallCount}, functionOutputs=${functionOutputCount}`);

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
        if (nameLower === 'read' && call.arguments.path) {
          localReadFiles.add(String(call.arguments.path));
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

      this.emit(createEvent('tool_call', {
        toolName: call.name,
        arguments: call.arguments,
        phase: 'completed',
        result: toolResult.output?.slice(0, 10000),
        success: toolResult.isSuccess,
        durationMs: toolDurationMs,
      }, workItemId));

      localContext.appendItem({
        type: 'function_call_output',
        callId: call.id,
        output: toolResult.output ?? '',
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

        if (toolRepeatState.repeats >= MAX_IDENTICAL_TOOL_CALLS) {
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

    let agentConfig: AgentConfig;
    let llmConfig: LLMRequestConfig;
    try {
      const runtimeConfig = this.agentRegistry.getRuntimeConfig(call.name);
      agentConfig = runtimeConfig.config;
      llmConfig = runtimeConfig.llm;
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

    const agent = new Agent(
      agentConfig,
      this.llm,
      this.toolRegistry,
      this.emit,
      this.requestId,
      this.agentRegistry,
      llmConfig,
      this.hooks
    );

    // Sub-agent sees only globalContext (Option A: parent's local work is invisible)
    // Sub-agent's internal execution is opaque - we only extract the response
    const subResult = await agent.run({ globalContext, workItem: subWorkItem, cwd });

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
        const outputSummaries: string[] = [];

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

        if (outputSummaries.length > 0) {
          enhancedResponse = `Sub-agent exploration results (${successfulOutputs.length} tool outputs):\n\n${outputSummaries.join('\n\n')}`;
          if (successfulOutputs.length > 5) {
            enhancedResponse += `\n\n... and ${successfulOutputs.length - 5} more results`;
          }
        }
      }
    }

    // Extract artifacts from structured output and add to parent's local context
    const artifacts = subResult.structuredOutput?.artifacts;
    if (Array.isArray(artifacts) && artifacts.length > 0) {
      const validArtifacts = artifacts.filter((a): a is {
        sourcePath: string;
        line?: number;
        kind: string;
        name: string;
        signature?: string;
        description: string;
        relevance: number;
      } => (
        typeof a === 'object' &&
        a !== null &&
        typeof a.sourcePath === 'string' &&
        typeof a.kind === 'string' &&
        typeof a.name === 'string' &&
        typeof a.description === 'string' &&
        typeof a.relevance === 'number'
      ));

      if (validArtifacts.length > 0) {
        parentLocalContext.addArtifacts(validArtifacts.map(a => ({
          sourcePath: a.sourcePath,
          line: typeof a.line === 'number' ? a.line : undefined,
          kind: a.kind as import('../types/context.js').ArtifactKind,
          name: a.name,
          signature: typeof a.signature === 'string' ? a.signature : undefined,
          description: a.description,
          relevance: a.relevance,
          discoveredBy: agentConfig.type,
        })));
      }
    }

    // Include full structured output so calling agent can see artifacts, patterns, etc.
    const payload = {
      agent: agentConfig.type,
      workId: subWorkItem.workId,
      success: subResult.success,
      response: enhancedResponse,
      structuredOutput: subResult.structuredOutput,
      artifactsAdded: Array.isArray(artifacts) ? artifacts.length : 0,
      error: subResult.error,
      needsUserInput: subResult.needsUserInput,
      userPrompt: subResult.userPrompt,
      metrics: subResult.metrics,
    };

    if (subResult.success || subResult.needsUserInput) {
      return successResult(call.name, JSON.stringify(payload), 0);
    }

    return errorResult(call.name, JSON.stringify(payload), 0);
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

          localContext.addFileContent(targetPath, fileContent.slice(0, 10000));
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
    if (normalized === 'need_user_input') return 'need_user_input';
    if (normalized === 'continue') return 'continue';
    return null;
  }

  /**
   * Extract response text from structured output.
   */
  private extractStructuredResponse(
    structuredOutput: Record<string, unknown> | null
  ): string | undefined {
    if (!structuredOutput) return undefined;
    const raw = structuredOutput.response;
    return typeof raw === 'string' ? raw : undefined;
  }

  /**
   * Extract user prompt from structured output.
   */
  private extractStructuredUserPrompt(
    structuredOutput: Record<string, unknown> | null
  ): AgentResult['userPrompt'] | null {
    if (!structuredOutput) return null;
    return this.parseUserPromptValue(structuredOutput.userPrompt);
  }

  /**
   * Parse user prompt payload safely.
   */
  private parseUserPromptValue(
    value: unknown
  ): AgentResult['userPrompt'] | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const data = value as Record<string, unknown>;
    const question = typeof data.question === 'string' ? data.question.trim() : '';
    if (!question) return null;

    const optionsRaw = data.options;
    let options: UserPromptInfo['options'] | undefined;
    if (Array.isArray(optionsRaw)) {
      const normalized = optionsRaw
        .map((opt) => {
          if (typeof opt === 'string') return opt;
          if (opt && typeof opt === 'object' && !Array.isArray(opt)) {
            const optObj = opt as Record<string, unknown>;
            const label = typeof optObj.label === 'string' ? optObj.label : '';
            if (!label) return null;
            const description =
              typeof optObj.description === 'string' ? optObj.description : undefined;
            return description ? { label, description } : { label };
          }
          return null;
        })
        .filter((opt): opt is string | { label: string; description?: string } => opt !== null);
      if (normalized.length > 0) {
        options = normalized;
      }
    }

    const context = typeof data.context === 'string' ? data.context : undefined;
    const multiSelect =
      typeof data.multiSelect === 'boolean' ? data.multiSelect : undefined;

    return {
      question,
      options,
      context,
      multiSelect,
    };
  }


  /**
   * Emit llm_call event.
   */
  private emitLlmCall(
    response: { content?: string; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; usage?: { totalTokens: number; promptTokens: number; completionTokens: number }; model?: string },
    messages: Array<Record<string, unknown>>,
    durationMs: number,
    tools: ToolDefinition[],
    workItemId?: string
  ): void {
    const content = response.content ?? '';
    const toolCalls = response.toolCalls ?? [];

    this.emit(createEvent('llm_call', {
      agentType: this.config.type,
      promptPreview: this.getPromptPreview(messages),
      responsePreview: content.slice(0, 4000) || this.buildToolCallPreview(toolCalls),
      totalTokens: response.usage?.totalTokens ?? 0,
      promptTokens: response.usage?.promptTokens ?? 0,
      completionTokens: response.usage?.completionTokens ?? 0,
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
    const provider = this.lastRequestConfig?.provider ?? 'unknown';
    const model = this.lastRequestConfig?.model ?? 'unknown';
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
