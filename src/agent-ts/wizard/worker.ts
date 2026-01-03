/**
 * Stateless Worker that executes bounded work items.
 * Workers NEVER mutate global state - all results go through WorkerOutcome.
 *
 * Ported from: src/harness/agent/wizard/worker.py
 */

import type { LLMAdapter } from '../llm/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult } from '../types/tools.js';
import type { WorkItem } from './work-item.js';
import type { ContextWindow, ContextDelta } from './context.js';
import type { KnowledgeFact } from './knowledge.js';
import {
  createContextDelta,
  addDeltaMessage,
  mergeMessages,
  buildSystemMessage,
} from './context.js';

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
 * CRITICAL: Workers NEVER mutate global state.
 * All state changes go through WorkerOutcome for Wizard to ingest.
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
  // Context updates
  contextMessages: Array<Record<string, unknown>>;
  readFiles: Set<string>;
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
    contextMessages: [],
    readFiles: new Set(),
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
 * Stateless inner-loop executor.
 *
 * CRITICAL INVARIANTS:
 * - Worker NEVER mutates PlanState, Ledger, or Stores
 * - All observations are returned in WorkerOutcome
 * - Worker receives a read-only ContextWindow + WorkItem, returns WorkerOutcome
 */
export class Worker {
  private toolRegistry: ToolRegistry;
  private llm: LLMAdapter;
  private config: WorkerConfig;
  private logger?: WorkerLogger;

  constructor(
    toolRegistry: ToolRegistry,
    llm: LLMAdapter,
    config?: Partial<WorkerConfig>,
    logger?: WorkerLogger
  ) {
    this.toolRegistry = toolRegistry;
    this.llm = llm;
    this.config = { ...DEFAULT_WORKER_CONFIG, ...config };
    this.logger = logger;
  }

  private log(level: keyof WorkerLogger, msg: string, meta?: Record<string, unknown>): void {
    if (this.logger) {
      this.logger[level](msg, { component: 'worker', ...meta });
    }
  }

  /**
   * Execute a work item and return the outcome.
   */
  async execute(
    baseContext: ContextWindow,
    workItem: WorkItem,
    planVersion: number,
    behavioralRules = ''
  ): Promise<WorkerOutcome> {
    const startTime = Date.now();
    const outcome = createWorkerOutcome({
      workId: workItem.workId,
      stepNum: workItem.stepNum,
      baseVersion: planVersion,
    });

    // Create local delta - Worker never mutates base context
    const delta = createContextDelta();

    try {
      await this.executeLoop(baseContext, workItem, delta, outcome, behavioralRules);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome.error = message;
      outcome.terminationReason = `error:${message}`;
      this.log('error', `Worker execution error: ${message}`);
    }

    // Finalize metrics
    outcome.metrics.durationMs = Date.now() - startTime;
    outcome.contextMessages = delta.messages;
    outcome.readFiles = delta.readFiles;

    return outcome;
  }

  /**
   * Main execution loop.
   */
  private async executeLoop(
    baseContext: ContextWindow,
    workItem: WorkItem,
    delta: ContextDelta,
    outcome: WorkerOutcome,
    behavioralRules: string
  ): Promise<void> {
    const maxIterations = Math.min(this.config.maxIterations, workItem.bounds.maxLlmCalls);

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // Check bounds
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

      // Build messages for LLM
      const systemMessage = buildSystemMessage(
        baseContext.goal,
        workItem.objective,
        workItem.stepNum,
        behavioralRules
      );

      const messages = [
        { role: 'system', content: systemMessage },
        ...mergeMessages(baseContext.messages, delta),
      ];

      // Get tool definitions
      const toolDefs = this.toolRegistry.getDefinitions();

      // Call LLM
      this.log('debug', `LLM call ${iteration + 1}/${maxIterations}`, {
        stepNum: workItem.stepNum,
      });

      const response = await this.llm.respond({
        messages: messages as any,
        tools: toolDefs,
      });
      outcome.metrics.llmCallsMade++;

      // Process response
      const content = response.content ?? '';
      const toolCalls = response.toolCalls ?? [];

      // Add assistant message to delta
      addDeltaMessage(delta, { role: 'assistant', content, toolCalls });

      // Handle tool calls
      if (toolCalls.length > 0) {
        const exchanges = await this.processToolCalls(toolCalls, delta, outcome);

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

        continue;
      }

      // No tool calls - check for action markers
      const action = extractAction(content);

      if (action === WorkerAction.FINAL) {
        // Check for refusal
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
        // Try to parse user prompt
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
      break;
    }

    // Loop exhausted
    if (!outcome.terminationReason) {
      outcome.terminationReason = 'iterations_exhausted';
      outcome.error = 'Maximum iterations reached without completion';
    }
  }

  /**
   * Process tool calls and add results to delta.
   */
  private async processToolCalls(
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    delta: ContextDelta,
    outcome: WorkerOutcome
  ): Promise<ToolExchange[]> {
    const exchanges: ToolExchange[] = [];

    for (const call of toolCalls) {
      // Check if tool is disallowed
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
        continue;
      }

      outcome.metrics.toolCallsMade++;

      try {
        const result: ToolResult = await this.toolRegistry.execute(call.name, call.arguments);

        const exchange: ToolExchange = {
          callId: call.id,
          toolName: call.name,
          arguments: call.arguments,
          resultContent: result.output,
          success: result.isSuccess,
          error: result.error,
        };
        exchanges.push(exchange);

        if (result.isSuccess) {
          outcome.metrics.toolCallsSucceeded++;

          // Track read files
          if (call.name.toLowerCase() === 'read' && call.arguments.path) {
            delta.readFiles.add(String(call.arguments.path));
          }
        } else {
          outcome.metrics.toolCallsFailed++;
          if (result.error) {
            outcome.toolErrors.push(`${call.name}: ${result.error}`);
          }
        }

        // Add tool result to delta
        addDeltaMessage(delta, {
          role: 'tool',
          toolCallId: call.id,
          content: result.output,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const exchange: ToolExchange = {
          callId: call.id,
          toolName: call.name,
          arguments: call.arguments,
          resultContent: `Error: ${message}`,
          success: false,
          error: message,
        };
        exchanges.push(exchange);
        outcome.metrics.toolCallsFailed++;
        outcome.toolErrors.push(`${call.name}: ${message}`);

        addDeltaMessage(delta, {
          role: 'tool',
          toolCallId: call.id,
          content: `Error: ${message}`,
        });
      }
    }

    return exchanges;
  }
}
