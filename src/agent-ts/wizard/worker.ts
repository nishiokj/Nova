/**
 * Stateless Worker that executes bounded work items.
 * Worker mutates the ContextWindow directly during execution.
 *
 * Ported from: src/harness/agent/wizard/worker.py
 */

import type { LLMAdapter, LLMResponse, Message } from '../llm/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult, ToolDefinition } from '../types/tools.js';
import type { WorkItem } from './work-item.js';
import type { KnowledgeFact, FactSource } from './knowledge.js';
import type { WizardEvent } from '../types/events.js';
import { ContextWindow } from '../types/context.js';
import { createEvent } from '../types/events.js';
import { buildSystemMessage } from './context.js';

/**
 * Explicit action requested by LLM.
 *
 * CRITICAL: We require explicit action markers to prevent premature termination.
 */
export enum WorkerAction {
  TOOL = 'tool',
  FINAL = 'final',
  NEED_CONTEXT = 'need_context',
  CONTINUE = 'continue',
}

/**
 * A tool invocation and its result (internal to Worker).
 */
export interface ToolExchange {
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  resultContent: string;
  success: boolean;
  error?: string;
}

/**
 * Compact metrics bundle for audit trail.
 */
export interface WorkerMetrics {
  toolCallsMade: number;
  toolCallsSucceeded: number;
  toolCallsFailed: number;
  llmCallsMade: number;
  durationMs: number;
}

export function createWorkerMetrics(): WorkerMetrics {
  return {
    toolCallsMade: 0,
    toolCallsSucceeded: 0,
    toolCallsFailed: 0,
    llmCallsMade: 0,
    durationMs: 0,
  };
}

/**
 * Worker-suggested plan change for Wizard review.
 */
export interface PatchSuggestion {
  patchType: string;
  objective?: string;
  toolHint?: string;
  targetStep?: number;
  insertAfter?: number;
  phase?: string;
  dependsOn: number[];
  required: boolean;
  rationale: string;
}

/**
 * Canonical output from Worker.
 *
 * NOTE: contextMessages and readFiles have been removed.
 * Worker now mutates ContextWindow directly.
 */
export interface WorkerOutcome {
  // Identity
  workId: string;
  stepNum: number;
  // Version envelope (for optimistic concurrency)
  baseVersion: number;
  // Core result
  success: boolean;
  finalResponse?: string;
  error?: string;
  toolErrors: string[];
  // Flag: True if LLM refused to attempt work
  isRefusal: boolean;
  // Knowledge to auto-append
  facts: KnowledgeFact[];
  // Worker-suggested plan changes
  patchSuggestions: PatchSuggestion[];
  // Metrics
  metrics: WorkerMetrics;
  // Entity refs discovered
  entityRefs: string[];
  // User input request
  needsUserInput: boolean;
  userPrompt?: Record<string, unknown>;
  // Internal tracking
  terminationReason: string;
}

export function createWorkerOutcome(params: {
  workId: string;
  stepNum: number;
  baseVersion: number;
}): WorkerOutcome {
  return {
    workId: params.workId,
    stepNum: params.stepNum,
    baseVersion: params.baseVersion,
    success: false,
    toolErrors: [],
    isRefusal: false,
    facts: [],
    patchSuggestions: [],
    metrics: createWorkerMetrics(),
    entityRefs: [],
    needsUserInput: false,
    terminationReason: '',
  };
}

/**
 * Check if outcome made progress.
 */
export function outcomeMadeProgress(outcome: WorkerOutcome): boolean {
  return (
    outcome.metrics.toolCallsSucceeded > 0 ||
    outcome.facts.length > 0 ||
    outcome.entityRefs.length > 0
  );
}

// Patterns that indicate refusal rather than completion
const REFUSAL_PATTERNS = [
  /cannot be completed/i,
  /can't be completed/i,
  /cannot complete/i,
  /can't complete/i,
  /unable to complete/i,
  /unable to accomplish/i,
  /exceeds? (?:the )?(?:budget|limit|constraint)/i,
  /beyond (?:the )?(?:scope|budget|limit)/i,
  /too (?:complex|large|big) (?:for|to)/i,
  /not (?:possible|achievable|feasible)/i,
  /would require (?:more|additional|exceeding)/i,
  /insufficient (?:budget|resources|time)/i,
  /task (?:is )?too (?:large|complex|broad)/i,
];

function isRefusalResponse(content: string): boolean {
  if (!content) return false;
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(content));
}

// Action markers
const ACTION_MARKER_PATTERNS = {
  FINAL: /\[FINAL\]/i,
  NEED_CONTEXT: /\[NEED_CONTEXT\]/i,
  CONTINUE: /\[CONTINUE\]/i,
};

/**
 * Extract action from LLM response content.
 */
function extractAction(content: string): WorkerAction | null {
  if (ACTION_MARKER_PATTERNS.FINAL.test(content)) return WorkerAction.FINAL;
  if (ACTION_MARKER_PATTERNS.NEED_CONTEXT.test(content)) return WorkerAction.NEED_CONTEXT;
  if (ACTION_MARKER_PATTERNS.CONTINUE.test(content)) return WorkerAction.CONTINUE;
  return null;
}

/**
 * Worker configuration.
 */
export interface WorkerConfig {
  maxIterations: number;
  enableAdaptiveReasoning: boolean;
  allowImplicitFinals: boolean;
  disallowedTools: Set<string>;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  maxIterations: 10,
  enableAdaptiveReasoning: true,
  allowImplicitFinals: false,
  disallowedTools: new Set(['ask_user']),
};

/**
 * Logger protocol for Worker.
 */
export interface WorkerLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  warning(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Event emitter callback type - Worker receives this from Wizard.
 * Worker knows nothing about EventBus, only emits via callback.
 */
export type EventEmitter = (event: WizardEvent) => void;

/**
 * Extended telemetry for LLM calls - includes full params for debugging.
 */
interface LlmCallTelemetry {
  response: LLMResponse;
  messages: Array<Record<string, unknown>>;
  stepNum: number | undefined;
  durationMs: number;
  /** Tool definitions passed to the LLM */
  toolDefs?: ToolDefinition[];
  /** Working directory for file operations */
  workingDir?: string;
}

/**
 * Stateless inner-loop executor.
 *
 * Worker receives a ContextWindow and mutates it directly during execution.
 * Results are returned in WorkerOutcome for Wizard to process.
 */
export class Worker {
  private toolRegistry: ToolRegistry;
  private llm: LLMAdapter;
  private config: WorkerConfig;
  private logger?: WorkerLogger;
  private eventEmitter?: EventEmitter;

  constructor(
    toolRegistry: ToolRegistry,
    llm: LLMAdapter,
    config?: Partial<WorkerConfig>,
    logger?: WorkerLogger,
    eventEmitter?: EventEmitter
  ) {
    this.toolRegistry = toolRegistry;
    this.llm = llm;
    this.config = { ...DEFAULT_WORKER_CONFIG, ...config };
    this.logger = logger;
    this.eventEmitter = eventEmitter;
  }

  private log(level: keyof WorkerLogger, msg: string, meta?: Record<string, unknown>): void {
    if (this.logger) {
      this.logger[level](msg, { component: 'worker', ...meta });
    }
  }

  /**
   * Get preview from messages, prioritizing the system prompt.
   * Increased limit for better observability in dashboard.
   */
  private getPromptPreview(messages: Array<Record<string, unknown>>): string {
    if (!messages.length) return '';
    const first = messages[0];
    if (first.role === 'system' && typeof first.content === 'string') {
      return first.content.slice(0, 4000);
    }
    for (const msg of messages) {
      if ((msg.role === 'user' || msg.role === 'system') && typeof msg.content === 'string') {
        return msg.content.slice(0, 4000);
      }
    }
    return '';
  }

  /**
   * Build response preview that includes tool call intent when content is blank.
   * Increased limits for better observability.
   */
  private buildResponsePreview(content: string, toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>): string {
    // If we have text content, use it
    if (content.trim()) {
      return content.slice(0, 4000);
    }

    // No text content - build preview from tool calls if any
    if (toolCalls.length === 0) {
      return '';
    }

    // Format tool calls as preview with more detail
    const toolSummaries = toolCalls.map(tc => {
      const args = tc.arguments;
      // Show key argument with more context
      const keyArg = args.path ?? args.pattern ?? args.query ?? args.command ?? args.content?.toString().slice(0, 200);
      if (keyArg) {
        return `${tc.name}(${String(keyArg).slice(0, 200)})`;
      }
      return tc.name;
    });

    return `[Tools: ${toolSummaries.join(', ')}]`.slice(0, 4000);
  }

  /**
   * Emit LLM_CALL event for observability.
   */
  private emitLlmCallEvent(telemetry: LlmCallTelemetry): void {
    if (!this.eventEmitter) return;

    const { response, messages, stepNum, durationMs, toolDefs, workingDir } = telemetry;
    const usage = response.usage;
    const content = response.content ?? '';
    const responseToolCalls = response.toolCalls ?? [];

    // Count messages by role for structure analysis
    const messagesByRole: Record<string, number> = {};
    for (const msg of messages) {
      const role = String(msg.role ?? 'unknown');
      messagesByRole[role] = (messagesByRole[role] ?? 0) + 1;
    }

    // Extract tool names for quick reference
    const toolNames = toolDefs?.map(t => t.name) ?? [];

    const event = createEvent(
      'llm_call',
      {
        agentType: 'worker',
        promptPreview: this.getPromptPreview(messages),
        responsePreview: this.buildResponsePreview(content, responseToolCalls),
        totalTokens: usage?.totalTokens ?? 0,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        durationMs,
        model: response.model ?? 'unknown',
        toolCallsCount: responseToolCalls.length,
        toolNames,
        toolCount: toolNames.length,
        workingDir: workingDir ?? 'not_set',
        messageCount: messages.length,
        messagesByRole,
        systemPrompt: messages[0]?.role === 'system'
          ? String(messages[0].content).slice(0, 8000)
          : undefined,
      },
      stepNum
    );
    this.eventEmitter(event);

    this.log('debug', 'LLM call params', {
      stepNum,
      toolCount: toolNames.length,
      toolNames,
      workingDir,
      messageCount: messages.length,
      messagesByRole,
      hasSystemMessage: messages[0]?.role === 'system',
    });
  }

  /**
   * Emit llm_error event for error propagation.
   */
  private emitLlmErrorEvent(error: Error, stepNum: number | undefined): void {
    if (!this.eventEmitter) return;

    const message = error.message;
    let errorType: 'api_error' | 'rate_limit' | 'timeout' | 'validation' | 'circuit_open' | 'unknown' = 'unknown';
    let statusCode: number | undefined;

    const statusMatch = message.match(/(\d{3}):/);
    if (statusMatch) {
      statusCode = parseInt(statusMatch[1], 10);
    }

    if (message.includes('rate limit') || statusCode === 429) {
      errorType = 'rate_limit';
    } else if (message.includes('timeout') || message.includes('ETIMEDOUT')) {
      errorType = 'timeout';
    } else if (message.includes('circuit') || message.includes('Circuit')) {
      errorType = 'circuit_open';
    } else if (statusCode && statusCode >= 400 && statusCode < 500) {
      errorType = 'validation';
    } else if (statusCode && statusCode >= 500) {
      errorType = 'api_error';
    }

    const event = createEvent(
      'llm_error',
      {
        agentType: 'worker' as const,
        provider: this.llm.provider,
        model: this.llm.model,
        error: message,
        errorType,
        statusCode,
        circuitBreakerTriggered: message.includes('circuit'),
        willRetry: false,
      },
      stepNum
    );
    this.eventEmitter(event);
  }

  /**
   * Execute a work item and return the outcome.
   * Mutates the context window directly during execution.
   */
  async execute(
    context: ContextWindow,
    workItem: WorkItem,
    planVersion: number,
    behavioralRules = '',
    workspaceRoot = ''
  ): Promise<WorkerOutcome> {
    const startTime = Date.now();
    const outcome = createWorkerOutcome({
      workId: workItem.workId,
      stepNum: workItem.stepNum,
      baseVersion: planVersion,
    });

    try {
      await this.executeLoop(context, workItem, outcome, behavioralRules, workspaceRoot);
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      outcome.error = errorObj.message;
      outcome.terminationReason = `error:${errorObj.message}`;
      this.log('error', `Worker execution error: ${errorObj.message}`);
      this.emitLlmErrorEvent(errorObj, workItem.stepNum);
    }

    outcome.metrics.durationMs = Date.now() - startTime;
    return outcome;
  }

  /**
   * Main execution loop.
   */
  private async executeLoop(
    context: ContextWindow,
    workItem: WorkItem,
    outcome: WorkerOutcome,
    behavioralRules: string,
    workspaceRoot: string
  ): Promise<void> {
    const maxIterations = Math.min(this.config.maxIterations, workItem.bounds.maxLlmCalls);

    // PRE-LOOP: Auto-read target files
    if (workItem.targetPaths && workItem.targetPaths.length > 0) {
      for (const targetPath of workItem.targetPaths) {
        if (context.hasReadFile(targetPath)) continue;

        try {
          const result = await this.toolRegistry.execute('read', { path: targetPath });
          if (result.isSuccess) {
            context.markFileRead(targetPath);
            outcome.entityRefs.push(targetPath);
            outcome.metrics.toolCallsMade++;
            outcome.metrics.toolCallsSucceeded++;

            const fileContent = typeof result.output === 'string'
              ? result.output
              : JSON.stringify(result.output);
            context.addFileContent(targetPath, fileContent.slice(0, 10000));

            this.log('debug', `Auto-read target file: ${targetPath}`, {
              stepNum: workItem.stepNum,
              size: fileContent.length,
            });
          } else {
            outcome.metrics.toolCallsFailed++;
            this.log('warning', `Failed to auto-read target file: ${targetPath}`, {
              error: result.error,
            });
          }
        } catch (error) {
          outcome.metrics.toolCallsFailed++;
          this.log('warning', `Exception auto-reading file: ${targetPath}`, {
            error: String(error),
          });
        }
      }
    }

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (outcome.metrics.toolCallsMade >= workItem.bounds.maxToolCalls) {
        outcome.terminationReason = 'bounds:tool_calls';
        outcome.error = 'Tool call limit reached';
        break;
      }

      if (outcome.metrics.durationMs >= workItem.bounds.maxDurationMs) {
        outcome.terminationReason = 'bounds:duration';
        outcome.error = 'Duration limit reached';
        break;
      }

      // Build system message
      const systemMessage = buildSystemMessage(
        workItem.objective, // Use objective as goal in system message
        workItem.objective,
        workItem.stepNum,
        behavioralRules,
        workspaceRoot
      );

      const toolDefs = this.toolRegistry.getDefinitions();
      const workingDir = (this.toolRegistry as any).getWorkingDir?.() ?? '';


      // Build messages for LLM from ContextWindow
      const contextItems = context.getItemsForLLM();
      const hasUserInput = contextItems.some((item) => {
        if (item.type === 'message') {
          return (item as Record<string, unknown>).role === 'user';
        }
        return false;
      });

      const messages: Array<Record<string, unknown>> = [
        { role: 'system', content: systemMessage },
      ];

      // If no prior user input, add the objective as a user message
      // CRITICAL: Also add to context so subsequent iterations don't re-add it
      if (!hasUserInput) {
        const objectiveMessage = `Execute the following objective:\n\n${workItem.objective}`;
        messages.push({
          role: 'user',
          content: objectiveMessage,
        });
        // Add to context so hasUserInput is true on next iteration
        context.addMessage('user', objectiveMessage);
      }

      // Add context items (converted from ContextWindow)
      for (const item of contextItems) {
        if (item.type === 'message') {
          messages.push({
            role: (item as Record<string, unknown>).role,
            content: (item as Record<string, unknown>).content,
          });
        } else if (item.type === 'function_call') {
          // Function calls are handled by the adapter
          messages.push(item);
        } else if (item.type === 'function_call_output') {
          // Function call outputs are handled by the adapter
          messages.push(item);
        }
      }

      this.log('debug', `LLM call ${iteration + 1}/${maxIterations}`, {
        stepNum: workItem.stepNum,
      });

      const llmStartTime = Date.now();
      const response = await this.llm.respond({
        messages: messages as unknown as Message[],
        tools: toolDefs,
      });
      const llmDurationMs = Date.now() - llmStartTime;
      outcome.metrics.llmCallsMade++;

      // Update context metrics
      if (response.usage) {
        context.updateMetrics(response.usage.promptTokens, response.usage.completionTokens);
      }

      this.emitLlmCallEvent({
        response,
        messages,
        stepNum: workItem.stepNum,
        durationMs: llmDurationMs,
        toolDefs,
        workingDir,
      });

      const content = response.content ?? '';
      const toolCalls = response.toolCalls ?? [];

      // Add assistant message to context
      if (toolCalls.length > 0) {
        // Add assistant message with text content if present
        if (content) {
          context.addMessage('assistant', content);
        }
        // Add function calls to context
        for (const tc of toolCalls) {
          context.addFunctionCall(tc.id, tc.name, tc.arguments);
        }
      } else {
        context.addMessage('assistant', content);
      }

      // Handle tool calls
      if (toolCalls.length > 0) {
        const exchanges = await this.processToolCalls(toolCalls, context, outcome, workItem.stepNum);

        // Check if any tool requested user input
        for (const exchange of exchanges) {
          if (exchange.toolName === 'ask_user') {
            try {
              const parsed = JSON.parse(exchange.resultContent);
              outcome.needsUserInput = true;
              outcome.userPrompt = parsed;
              outcome.terminationReason = 'user_input_required';
              return;
            } catch {
              // Not a user prompt
            }
          }
        }

        // Tool calls were made - continue to next iteration for LLM to process results
        continue;
      }

      // No tool calls - check for action markers in text response
      const action = extractAction(content);

      if (action === WorkerAction.FINAL) {
        if (isRefusalResponse(content)) {
          outcome.isRefusal = true;
          outcome.error = 'LLM refused to complete the task';
          outcome.terminationReason = 'refusal';
        } else {
          outcome.success = true;
          outcome.finalResponse = content.replace(/\[FINAL\]/gi, '').trim();
          outcome.terminationReason = 'final';
        }
        return;
      }

      if (action === WorkerAction.NEED_CONTEXT) {
        const promptMatch = content.match(/\{[\s\S]*\}/);
        if (promptMatch) {
          try {
            const parsed = JSON.parse(promptMatch[0]);
            outcome.needsUserInput = true;
            outcome.userPrompt = parsed;
            outcome.terminationReason = 'user_input_required';
            return;
          } catch {
            // Invalid JSON
          }
        }
        continue;
      }

      if (action === WorkerAction.CONTINUE) {
        continue;
      }

      // No explicit action - check for implicit final
      if (this.config.allowImplicitFinals && content.length > 100) {
        outcome.success = true;
        outcome.finalResponse = content;
        outcome.terminationReason = 'implicit_final';
        return;
      }

      // No action, no tools - stuck
      outcome.terminationReason = 'no_action';
      outcome.error = `LLM response has no tools and no action markers ([FINAL], [NEED_CONTEXT], [CONTINUE]). Response preview: "${content.slice(0, 200)}..."`;
      this.log('error', 'Worker stuck: no action or tools', {
        stepNum: workItem.stepNum,
        responseLength: content.length,
        responsePreview: content.slice(0, 100),
      });
      break;
    }

    if (!outcome.terminationReason) {
      outcome.terminationReason = 'iterations_exhausted';
      outcome.error = 'Maximum iterations reached without completion';
    }
  }

  /**
   * Emit tool_call event for observability.
   * Phase 'starting' is emitted before execution, 'completed' after.
   */
  private emitToolCallEvent(
    toolName: string,
    args: Record<string, unknown>,
    phase: 'starting' | 'completed',
    stepNum?: number,
    result?: string,
    success?: boolean,
    durationMs?: number
  ): void {
    if (!this.eventEmitter) return;

    this.log('debug', `Emitting tool_call event: ${toolName} phase=${phase}`, {
      stepNum,
      success,
      durationMs,
    });

    const event = createEvent(
      'tool_call',
      {
        toolName,
        arguments: args,
        phase,
        result: result?.slice(0, 10000), // Increased for observability - full tool output is critical for debugging
        success,
        durationMs,
      },
      stepNum
    );
    this.eventEmitter(event);
  }

  /**
   * Execute a single tool call and return the exchange.
   */
  private async executeSingleTool(
    call: { id: string; name: string; arguments: Record<string, unknown> },
    stepNum?: number
  ): Promise<{ exchange: ToolExchange; result: ToolResult | null; durationMs: number }> {
    const toolStartTime = Date.now();

    this.log('info', `Tool call: ${call.name}`, {
      stepNum,
      args: call.arguments,
    });

    // Emit 'starting' event BEFORE execution
    this.emitToolCallEvent(call.name, call.arguments, 'starting', stepNum);

    try {
      const result: ToolResult = await this.toolRegistry.execute(call.name, call.arguments);
      const toolDurationMs = Date.now() - toolStartTime;

      const exchange: ToolExchange = {
        callId: call.id,
        toolName: call.name,
        arguments: call.arguments,
        resultContent: result.output,
        success: result.isSuccess,
        error: result.error,
      };

      // Emit 'completed' event AFTER execution
      this.emitToolCallEvent(call.name, call.arguments, 'completed', stepNum, result.output, result.isSuccess, toolDurationMs);

      if (result.isSuccess) {
        this.log('info', `Tool success: ${call.name}`, {
          stepNum,
          durationMs: toolDurationMs,
          outputLength: result.output?.length ?? 0,
        });
      } else {
        this.log('error', `Tool failed: ${call.name}`, {
          stepNum,
          durationMs: toolDurationMs,
          error: result.error,
        });
      }

      return { exchange, result, durationMs: toolDurationMs };
    } catch (error) {
      const toolDurationMs = Date.now() - toolStartTime;
      const message = error instanceof Error ? error.message : String(error);

      const exchange: ToolExchange = {
        callId: call.id,
        toolName: call.name,
        arguments: call.arguments,
        resultContent: `Error: ${message}`,
        success: false,
        error: message,
      };

      // Emit 'completed' event for exceptions too
      this.emitToolCallEvent(call.name, call.arguments, 'completed', stepNum, `Error: ${message}`, false, toolDurationMs);
      this.log('error', `Tool exception: ${call.name}`, {
        stepNum,
        durationMs: toolDurationMs,
        error: message,
      });

      return { exchange, result: null, durationMs: toolDurationMs };
    }
  }

  /**
   * Process tool call results and update context.
   */
  private processToolResult(
    call: { id: string; name: string; arguments: Record<string, unknown> },
    execResult: { exchange: ToolExchange; result: ToolResult | null; durationMs: number },
    context: ContextWindow,
    outcome: WorkerOutcome
  ): void {
    const { exchange, result } = execResult;

    outcome.metrics.toolCallsMade++;

    if (result && result.isSuccess) {
      outcome.metrics.toolCallsSucceeded++;

      // Track read files
      if (call.name.toLowerCase() === 'read' && call.arguments.path) {
        context.markFileRead(String(call.arguments.path));
      }
    } else {
      outcome.metrics.toolCallsFailed++;
      if (exchange.error) {
        outcome.toolErrors.push(`${call.name}: ${exchange.error}`);
      }
    }

    // Add function call output to context
    context.addFunctionCallOutput(
      call.id,
      exchange.resultContent,
      !exchange.success,
      execResult.durationMs
    );
  }

  /**
   * Process tool calls and add results to context.
   * Parallelizes read-only tools for efficiency.
   */
  private async processToolCalls(
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    context: ContextWindow,
    outcome: WorkerOutcome,
    stepNum?: number
  ): Promise<ToolExchange[]> {
    const exchanges: ToolExchange[] = [];

    // Filter out disallowed tools first
    const validCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    for (const call of toolCalls) {
      if (this.config.disallowedTools.has(call.name)) {
        const exchange: ToolExchange = {
          callId: call.id,
          toolName: call.name,
          arguments: call.arguments,
          resultContent: `Tool "${call.name}" is not allowed for Workers`,
          success: false,
          error: 'Disallowed tool',
        };
        exchanges.push(exchange);
        outcome.toolErrors.push(`Disallowed tool: ${call.name}`);
        // Disallowed tools are immediately 'completed' with error (no 'starting' event)
        this.emitToolCallEvent(call.name, call.arguments, 'completed', stepNum, exchange.resultContent, false, 0);
        this.log('warning', `Disallowed tool attempted: ${call.name}`, { stepNum, args: call.arguments });

        // Add error result to context
        context.addFunctionCallOutput(call.id, exchange.resultContent, true, 0);
      } else {
        validCalls.push(call);
      }
    }

    if (validCalls.length === 0) {
      return exchanges;
    }

    // Group consecutive parallelizable tools
    type ToolGroup = {
      calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
      parallel: boolean;
    };

    const groups: ToolGroup[] = [];
    let currentGroup: ToolGroup | null = null;

    for (const call of validCalls) {
      const isParallel = (this.toolRegistry as any).isParallelSafe?.(call.name) ?? false;

      if (!currentGroup || currentGroup.parallel !== isParallel) {
        currentGroup = { calls: [call], parallel: isParallel };
        groups.push(currentGroup);
      } else {
        currentGroup.calls.push(call);
      }
    }

    // Execute groups
    for (const group of groups) {
      if (group.parallel && group.calls.length > 1) {
        this.log('debug', `Executing ${group.calls.length} tools in parallel`, {
          stepNum,
          tools: group.calls.map(c => c.name),
        });

        const promises = group.calls.map(call => this.executeSingleTool(call, stepNum));
        const results = await Promise.all(promises);

        for (let i = 0; i < group.calls.length; i++) {
          const call = group.calls[i];
          const execResult = results[i];
          exchanges.push(execResult.exchange);
          this.processToolResult(call, execResult, context, outcome);
        }
      } else {
        for (const call of group.calls) {
          const execResult = await this.executeSingleTool(call, stepNum);
          exchanges.push(execResult.exchange);
          this.processToolResult(call, execResult, context, outcome);
        }
      }
    }

    return exchanges;
  }
}
