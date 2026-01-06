/**
 * Agent - Main reasoning and tool execution agent.
 * Handles user requests with tool usage and LLM reasoning.
 *
 * Architecture: Plan → Wizard → Synthesis
 * - Planner: Creates explicit execution plans with success criteria
 * - Wizard: Orchestrates steps and workers over a single context window
 * - Synthesizer: Produces the final response
 *
 * Ported from: src/harness/agent/agent.py
 */

import type { LLMAdapter } from '../llm/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { WizardEvent } from '../types/events.js';
import { createEvent } from '../types/events.js';
import type { WizardPlan } from '../types/plans.js';
import { StepStatus, StepPhase } from '../types/plans.js';
import { ContextWindow } from '../types/context.js';
import { Planner, type PlanBudget } from '../planner/index.js';
import { Wizard, type WizardResult } from '../wizard/index.js';
import { ResponseSynthesizer, type SynthesisInput, createSynthesisInput } from '../synthesis/index.js';
import type { EventBusProtocol } from '../communication/event_bus.js';

/**
 * Agent configuration.
 */
export interface AgentConfig {
  systemPrompt?: string;
  maxIterations?: number;
  enablePlanning?: boolean;
  enableScouting?: boolean;
  /** Behavioral rules for worker prompts (loaded from config/behavioral_rules.md) */
  behavioralRules?: string;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  systemPrompt: 'You are a helpful assistant that can use tools to accomplish tasks.',
  maxIterations: 50,
  enablePlanning: true,
  enableScouting: true,
};

/**
 * Response from the agent.
 */
export interface AgentResponse {
  content: string;
  structuredAction?: string;
  speechText?: string;
  totalDurationMs: number;
  toolsUsed: string[];
  success: boolean;
  error?: string;
  metadata: Record<string, unknown>;
  goalAchieved: boolean;
  paused: boolean;
  userPrompt?: Record<string, unknown>;
}

/**
 * Logger protocol for Agent.
 */
export interface AgentLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  warning(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Main reasoning and execution agent.
 * Uses Wizard orchestration for plan execution.
 *
 * NOTE: Agent now receives ContextWindow from the caller (Harness).
 * ContextWindow is created/hydrated in Harness BEFORE Agent.run().
 */
export class Agent {
  private config: AgentConfig;
  private toolRegistry: ToolRegistry;
  private llm: LLMAdapter;
  private planner: Planner;
  private wizard: Wizard;
  private synthesizer: ResponseSynthesizer;
  private logger?: AgentLogger;
  private eventBus?: EventBusProtocol;
  /** Last context window for resume capability */
  private lastContext?: ContextWindow;

  constructor(
    config: AgentConfig,
    toolRegistry: ToolRegistry,
    llm: LLMAdapter,
    logger?: AgentLogger,
    eventBus?: EventBusProtocol
  ) {
    this.config = { ...DEFAULT_AGENT_CONFIG, ...config };
    this.toolRegistry = toolRegistry;
    this.llm = llm;
    this.logger = logger;
    this.eventBus = eventBus;

    // Initialize components - pass EventBus to all
    this.planner = new Planner(llm, toolRegistry, { enableScouting: this.config.enableScouting }, eventBus);
    this.wizard = new Wizard(
      toolRegistry,
      llm,
      { maxIterations: this.config.maxIterations },
      logger,
      eventBus
    );
    this.synthesizer = new ResponseSynthesizer(llm);
  }

  private publish(event: WizardEvent): void {
    if (this.eventBus) {
      this.eventBus.publish(event);
    }
  }

  private log(level: keyof AgentLogger, msg: string, meta?: Record<string, unknown>): void {
    if (this.logger) {
      this.logger[level](msg, { component: 'agent', ...meta });
    }
  }

  /**
   * Emit llm_error event for error propagation.
   */
  private emitLlmErrorEvent(error: Error): void {
    const message = error.message;
    let errorType: 'api_error' | 'rate_limit' | 'timeout' | 'validation' | 'circuit_open' | 'unknown' = 'unknown';
    let statusCode: number | undefined;

    // Extract status code from error message
    const statusMatch = message.match(/(\d{3}):/);
    if (statusMatch) {
      statusCode = parseInt(statusMatch[1], 10);
    }

    // Classify error type
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

    this.publish(createEvent('llm_error', {
      agentType: 'wizard' as const, // Agent uses wizard type for consistency
      provider: this.llm.provider,
      model: this.llm.model,
      error: message,
      errorType,
      statusCode,
      circuitBreakerTriggered: message.includes('circuit'),
      willRetry: false,
    }));
  }

  /**
   * Process a user request and return a response.
   *
   * @param userInput - The user's request
   * @param context - The ContextWindow (created/hydrated by Harness)
   * @param additionalContext - Optional additional context string for planning
   * @param tier - Budget tier (simple, standard, complex)
   * @param budget - Budget constraints
   * @param onStreamChunk - Optional callback for streaming responses
   */
  async run(
    userInput: string,
    context: ContextWindow,
    additionalContext?: string,
    tier = 'standard',
    budget?: PlanBudget,
    onStreamChunk?: (chunk: string, index: number, isFinal: boolean) => void
  ): Promise<AgentResponse> {
    const startTime = Date.now();

    this.log('info', `Processing request: ${userInput.slice(0, 100)}`);

    // Add user input to context
    context.addMessage('user', userInput);

    // Pre-read @mentioned files before planning
    for (const match of userInput.matchAll(/@(?:"([^"]+)"|(\S+))/g)) {
      const filePath = match[1] || match[2];
      if (filePath && !context.hasReadFile(filePath)) {
        try {
          const result = await this.toolRegistry.execute('Read', { path: filePath });
          if (result.isSuccess && result.output) {
            context.addFileContent(filePath, String(result.output));
          }
        } catch { /* ignore read failures */ }
      }
    }

    // Store context for resume capability
    this.lastContext = context;

    try {
      // Simple tier: single LLM call, no tools
      if (tier === 'simple') {
        return this.runSimpleTier(userInput, context, onStreamChunk);
      }

      // Create plan (pass ContextWindow for smarter planning)
      let plan;
      if (this.config.enablePlanning) {
        plan = await this.planner.createPlan(userInput, additionalContext, tier, budget, context);

        // Check for budget exceeded
        if (plan.goal.startsWith('BUDGET_EXCEEDED')) {
          return {
            content: `I cannot complete this task within the current tier's budget. ${plan.steps[0]?.objective || ''}`,
            totalDurationMs: Date.now() - startTime,
            toolsUsed: [],
            success: false,
            error: 'Budget exceeded',
            metadata: { tier, plan },
            goalAchieved: false,
            paused: false,
          };
        }
      } else {
        // Default single-step plan
        plan = {
          goal: userInput,
          goalType: 'task',
          steps: [
            {
              stepNum: 1,
              objective: `Execute: ${userInput}`,
              phase: StepPhase.EXECUTION,
              status: StepStatus.PENDING,
              dependsOn: [],
              required: true,
            },
          ],
        };
      }

      this.log('debug', `Created plan with ${plan.steps.length} steps`);

      // Execute plan with Wizard (pass ContextWindow and behavioral rules)
      const result = await this.wizard.execute(plan, context, this.config.behavioralRules ?? '');

      // Synthesize response if needed
      let finalContent = result.finalResponse;
      if (!result.success && result.finalResponse.length < 50) {
        const synthesisInput = this.buildSynthesisInput(result, plan.goal);
        const synthesisResult = await this.synthesizer.synthesize(synthesisInput, onStreamChunk);
        finalContent = synthesisResult.content;
      } else if (onStreamChunk) {
        this.synthesizer.streamContent(finalContent, onStreamChunk);
      }

      return {
        content: finalContent,
        structuredAction: plan.goal,
        totalDurationMs: Date.now() - startTime,
        toolsUsed: this.extractToolsUsed(result),
        success: result.success,
        error: result.success ? undefined : result.finalResponse,
        metadata: {
          tier,
          plan,
          iterations: result.totalIterations,
          stepsCompleted: result.stepsCompleted,
          stepsSkipped: result.stepsSkipped,
          stepsFailed: result.stepsFailed,
        },
        goalAchieved: result.success,
        paused: result.paused,
        userPrompt: result.userPrompt,
      };
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      this.log('error', `Agent error: ${errorObj.message}`);

      // Emit LLM error event for propagation
      this.emitLlmErrorEvent(errorObj);

      return {
        content: `I encountered an error while processing your request: ${errorObj.message}`,
        totalDurationMs: Date.now() - startTime,
        toolsUsed: [],
        success: false,
        error: errorObj.message,
        metadata: { tier },
        goalAchieved: false,
        paused: false,
      };
    }
  }

  /**
   * Simple tier: single LLM call, no tools.
   * Uses ContextWindow.getItemsForLLM() for messages.
   */
  private async runSimpleTier(
    userInput: string,
    context: ContextWindow,
    onStreamChunk?: (chunk: string, index: number, isFinal: boolean) => void
  ): Promise<AgentResponse> {
    const startTime = Date.now();

    // Build messages from context window
    const messages: Array<{ role: string; content: string }> = [];

    // System message
    if (this.config.systemPrompt) {
      messages.push({ role: 'system', content: this.config.systemPrompt });
    }

    // Add messages from context window
    const contextItems = context.getItemsForLLM();
    for (const item of contextItems) {
      if (item.type === 'message') {
        messages.push({
          role: String((item as Record<string, unknown>).role),
          content: String((item as Record<string, unknown>).content),
        });
      }
    }

    try {
      const response = await this.llm.respond({ messages: messages as any });
      const content = response.content ?? '';

      // Update context metrics
      if (response.usage) {
        context.updateMetrics(response.usage.promptTokens, response.usage.completionTokens);
      }

      // Add assistant response to context
      context.addMessage('assistant', content);

      if (onStreamChunk) {
        this.synthesizer.streamContent(content, onStreamChunk);
      }

      return {
        content,
        totalDurationMs: Date.now() - startTime,
        toolsUsed: [],
        success: true,
        metadata: { tier: 'simple' },
        goalAchieved: true,
        paused: false,
      };
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));

      // Emit LLM error event for propagation
      this.emitLlmErrorEvent(errorObj);

      return {
        content: `Error: ${errorObj.message}`,
        totalDurationMs: Date.now() - startTime,
        toolsUsed: [],
        success: false,
        error: errorObj.message,
        metadata: { tier: 'simple' },
        goalAchieved: false,
        paused: false,
      };
    }
  }

  /**
   * Build synthesis input from wizard result.
   */
  private buildSynthesisInput(result: WizardResult, goal: string): SynthesisInput {
    const toolOutputs: Array<{ tool: string; output: string }> = [];
    const stepSummaries: string[] = [];

    // Extract from ledger
    for (const entry of result.ledger.getRecentEntries(10)) {
      if (entry.outcomeSummary) {
        stepSummaries.push(entry.outcomeSummary);
      }
    }

    return {
      ...createSynthesisInput(goal, toolOutputs, 'task'),
      stepSummaries,
      partialResponse: result.finalResponse,
    };
  }

  /**
   * Extract tools used from wizard result.
   */
  private extractToolsUsed(result: WizardResult): string[] {
    const tools = new Set<string>();
    for (const entry of result.ledger.getRecentEntries(100)) {
      // Extract tool names from work item summaries if available
      const summary = entry.workItemSummary || '';
      const toolMatch = summary.match(/using (\w+)/i);
      if (toolMatch) {
        tools.add(toolMatch[1]);
      }
    }
    return Array.from(tools);
  }

  /**
   * Resume execution after user provides input.
   *
   * @param context - The ContextWindow (from Harness)
   * @param userResponse - The user's response
   * @param onStreamChunk - Optional callback for streaming responses
   */
  async resume(
    context: ContextWindow,
    userResponse: string,
    onStreamChunk?: (chunk: string, index: number, isFinal: boolean) => void
  ): Promise<AgentResponse> {
    const startTime = Date.now();

    // Store context for any future resume calls
    this.lastContext = context;

    try {
      const result = await this.wizard.resume(
        context,
        userResponse,
        this.config.behavioralRules ?? ''
      );

      let finalContent = result.finalResponse;
      if (onStreamChunk) {
        this.synthesizer.streamContent(finalContent, onStreamChunk);
      }

      return {
        content: finalContent,
        totalDurationMs: Date.now() - startTime,
        toolsUsed: this.extractToolsUsed(result),
        success: result.success,
        metadata: {
          iterations: result.totalIterations,
          stepsCompleted: result.stepsCompleted,
        },
        goalAchieved: result.success,
        paused: result.paused,
        userPrompt: result.userPrompt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: `Error resuming: ${message}`,
        totalDurationMs: Date.now() - startTime,
        toolsUsed: [],
        success: false,
        error: message,
        metadata: {},
        goalAchieved: false,
        paused: false,
      };
    }
  }
}
