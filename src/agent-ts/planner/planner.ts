/**
 * Planner - Creates explicit execution plans for agent requests.
 *
 * The key insight: know what success looks like BEFORE you start.
 *
 * Ported from: src/harness/agent/planner.py
 */

import type { LLMAdapter } from '../llm/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { WizardPlan, WizardStep } from '../types/plans.js';
import { StepStatus, StepPhase } from '../types/plans.js';
import type { WizardEvent, PlanSnapshotData } from '../types/events.js';
import { createEvent } from '../types/events.js';
import type { EventBusProtocol } from '../communication/event_bus.js';
import type { ContextWindow, FileContentItem } from '../types/context.js';

/**
 * Budget constraints for planning.
 */
export interface PlanBudget {
  maxToolCalls: number;
  maxSteps: number;
  maxTokens?: number;
}

/**
 * Planner configuration.
 */
export interface PlannerConfig {
  enableScouting: boolean;
  maxPlanSteps: number;
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  enableScouting: true,
  maxPlanSteps: 10,
};

/**
 * Planning prompt template.
 */
const PLANNING_PROMPT = `You are a planning assistant. Create an execution plan for the following request.

User Request: {user_input}

{context_section}

Create a JSON plan with this structure:
{
  "goal": "High-level description of what we're trying to accomplish",
  "goalType": "task" | "question" | "search",
  "steps": [
    {
      "stepNum": 1,
      "objective": "What this step accomplishes",
      "toolHint": "Optional: specific tool to use (Bash, Read, Write, Edit, Grep, Glob)",
      "phase": "discovery" | "execution",
      "dependsOn": [],
      "required": true
    }
  ],
  "reasoning": "Brief explanation of why this plan structure was chosen"
}

Guidelines:
- Be intelligent, you will be required to plan a WIDE range of tasks. There is absolutely a chance you are planning something that should not require planning at all. Do not be afraid to be ultra-concise. Assume that each step will require a minimum of 1 LLM call. Knowing this, do not needlessly separate steps UNLESS we can run them in parallel (they are not dependent on one another. This is actually very desirable, and our plans should be crafted in a way so that we parallelize as much work as possible). Each Step should be a fairly large unit. For example this is BAD: '1. Get file A 2. Answer question about A. 3. Answer different question about A (unless not dependent on 2, then this is good) 4. Summarize' An extra summarization step is rarely necessary, it can be part of the final step in most cases. 
- If a file's contents are provided in this prompt and that file is pertinent to the task then DO NOT create steps involving reducing uncertainty of that file. YOU can use the knowledge of that file to create a sharper, more tailored plan. 
- Keep plans simple - prefer fewer steps
- Only include tool hints when truly necessary
- Mark steps as "required" only if they MUST complete for success
- Discovery steps gather information; execution steps perform actions
- Consider dependencies between steps


Return ONLY the JSON, no additional text.
`;

/**
 * Creates explicit execution plans before running.
 */
export class Planner {
  private llm: LLMAdapter;
  private toolRegistry: ToolRegistry;
  private config: PlannerConfig;
  private eventBus?: EventBusProtocol;

  // Store last LLM call details for logging
  lastCallInstructions = '';
  lastCallInput = '';
  lastCallResponse = '';
  lastCallDurationMs = 0;

  constructor(
    llm: LLMAdapter,
    toolRegistry: ToolRegistry,
    config?: Partial<PlannerConfig>,
    eventBus?: EventBusProtocol
  ) {
    this.llm = llm;
    this.toolRegistry = toolRegistry;
    this.config = { ...DEFAULT_PLANNER_CONFIG, ...config };
    this.eventBus = eventBus;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private publish(event: WizardEvent<any>): void {
    if (this.eventBus) {
      this.eventBus.publish(event);
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
      agentType: 'planner' as const,
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
   * Publish a plan_snapshot event.
   */
  private publishPlanSnapshot(plan: WizardPlan, snapshotType: 'initial' | 'pre_patch' | 'post_patch'): void {
    const data: PlanSnapshotData = {
      version: 1,
      snapshotType,
      goal: plan.goal,
      trigger: snapshotType === 'initial' ? 'plan_created' : 'plan_modified',
      steps: plan.steps.map(s => ({
        stepNum: s.stepNum,
        objective: s.objective,
        status: s.status,
        phase: s.phase,
        toolHint: s.toolHint,
        required: s.required,
      })),
    };
    this.publish(createEvent('plan_snapshot', data));
  }

  /**
   * Create an execution plan for the user's request.
   *
   * @param userInput - The user's request
   * @param context - Optional context string for the LLM
   * @param tier - Budget tier (simple, standard, complex)
   * @param budget - Budget constraints
   * @param contextWindow - Optional ContextWindow to check hasReadFile() for smarter planning
   */
  async createPlan(
    userInput: string,
    context?: string,
    tier = 'standard',
    budget?: PlanBudget,
    contextWindow?: ContextWindow
  ): Promise<WizardPlan> {
    // Fast path: detect simple patterns that don't need LLM planning
    const simplePlan = this.trySimplePlan(userInput);
    if (simplePlan) {
      if (budget) {
        const validation = this.validatePlanBudget(simplePlan, budget, tier);
        if (!validation.fits) {
          return this.createBudgetExceededPlan(userInput, budget, tier, validation.reason!);
        }
      }
      // Emit plan_snapshot event
      this.publishPlanSnapshot(simplePlan, 'initial');
      return simplePlan;
    }

    // Complex path: use LLM to create plan
    const plan = await this.createLlmPlan(userInput, context, tier, contextWindow);

    // Validate against budget
    if (budget) {
      const validation = this.validatePlanBudget(plan, budget, tier);
      if (!validation.fits) {
        return this.createBudgetExceededPlan(userInput, budget, tier, validation.reason!);
      }
    }

    // Emit plan_snapshot event
    this.publishPlanSnapshot(plan, 'initial');
    return plan;
  }

  /**
   * Fast pattern matching for simple requests.
   */
  private trySimplePlan(userInput: string): WizardPlan | null {
    const inputLower = userInput.toLowerCase().trim();

    // Simple factual questions (no tools needed)
    const questionStarters = [
      'what is',
      "what's",
      'what does',
      'who is',
      "who's",
      'when did',
      'when was',
      'where is',
      "where's",
      'how many',
      'how much',
      'define',
      'explain',
      'what are',
      'why is',
      'why do',
      'can you tell me',
    ];

    const isSimpleQuestion = questionStarters.some((q) => inputLower.startsWith(q));
    const needsRealtime = ['weather', 'stock', 'price', 'news', 'today', 'current', 'now'].some(
      (kw) => inputLower.includes(kw)
    );
    const needsFiles = ['read file', 'open file', 'save', 'delete file', 'edit file'].some((kw) =>
      inputLower.includes(kw)
    );

    if (isSimpleQuestion && !needsRealtime && !needsFiles) {
      return {
        goal: `Answer: ${userInput}`,
        goalType: 'question',
        steps: [
          {
            stepNum: 1,
            objective: 'Answer the question from knowledge',
            phase: StepPhase.EXECUTION,
            status: StepStatus.PENDING,
            dependsOn: [],
            required: true,
          },
        ],
      };
    }

    // Code location questions
    const codeLocationPatterns = [
      'where is',
      'where does',
      'where do',
      'where are',
      'find where',
      'locate where',
      'show where',
      'which file',
      'what file',
    ];
    const isCodeLocationQuestion = codeLocationPatterns.some((p) => inputLower.includes(p));
    const codeTerms = [
      'function',
      'class',
      'method',
      'handler',
      'receive',
      'send',
      'call',
      'handle',
      'process',
    ];
    const mentionsCode = codeTerms.some((term) => inputLower.includes(term));

    if (isCodeLocationQuestion && mentionsCode) {
      // Extract a search term
      const words = inputLower.split(/\s+/);
      const codeRelated = words.filter((w) => codeTerms.includes(w));
      const searchTerm = codeRelated[0] || 'handler';

      return {
        goal: `Find code location: ${userInput}`,
        goalType: 'search',
        steps: [
          {
            stepNum: 1,
            objective: `Search codebase for '${searchTerm}' handlers/functions`,
            toolHint: 'Grep',
            phase: StepPhase.DISCOVERY,
            status: StepStatus.PENDING,
            dependsOn: [],
            required: true,
          },
          {
            stepNum: 2,
            objective: 'Identify the specific location and provide answer',
            phase: StepPhase.EXECUTION,
            status: StepStatus.PENDING,
            dependsOn: [1],
            required: true,
          },
        ],
      };
    }

    return null;
  }

  /**
   * Create plan using LLM.
   */
  private async createLlmPlan(
    userInput: string,
    context?: string,
    _tier = 'standard',
    contextWindow?: ContextWindow
  ): Promise<WizardPlan> {
    const startTime = Date.now();

    // Build context section with information about already-read files
    let contextSection = context ? `Context:\n${context}\n` : '';

    // Include file content for informed planning
    if (contextWindow) {
      const fileItems = contextWindow.getItemsByType<FileContentItem>('file_content');
      if (fileItems.length > 0) {
        contextSection += '\n--- Files Already Loaded (available to subsequent steps) ---\n';
        for (const file of fileItems) {
          contextSection += `\n[${file.path}]\n\`\`\`\n${file.content}\n\`\`\`\n`;
        }
      }
    }

    const prompt = PLANNING_PROMPT.replace('{user_input}', userInput).replace(
      '{context_section}',
      contextSection
    );

    this.lastCallInput = prompt;

    try {
      const response = await this.llm.respond({
        messages: [{ role: 'user', content: prompt }] as any,
      });
      this.lastCallDurationMs = Date.now() - startTime;
      this.lastCallResponse = response.content ?? '';

      // Parse JSON response
      const content = response.content ?? '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`No JSON found in LLM response. Response: ${content.slice(0, 200)}`);
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return this.normalizePlan(parsed, userInput);
    } catch (error) {
      // CRITICAL: Log the actual error before falling back
      const errorObj = error instanceof Error ? error : new Error(String(error));
      console.error(`[Planner] LLM planning failed: ${errorObj.message}`);
      console.error(`[Planner] Input was: ${userInput.slice(0, 100)}`);
      console.error(`[Planner] Falling back to single-step plan`);

      // Emit LLM error event for propagation
      this.emitLlmErrorEvent(errorObj);

      // Store the error for debugging
      this.lastCallResponse = `[ERROR] ${errorObj.message}`;

      // Fallback to simple single-step plan
      return {
        goal: userInput,
        goalType: 'task',
        steps: [
          {
            stepNum: 1,
            objective: `Execute (planning failed: ${errorObj.message.slice(0, 50)}): ${userInput}`,
            phase: StepPhase.EXECUTION,
            status: StepStatus.PENDING,
            dependsOn: [],
            required: true,
          },
        ],
      };
    }
  }

  /**
   * Normalize parsed plan to WizardPlan format.
   */
  private normalizePlan(parsed: Record<string, unknown>, userInput: string): WizardPlan {
    const steps: WizardStep[] = [];
    const rawSteps = parsed.steps as Array<Record<string, unknown>> | undefined;

    if (rawSteps && Array.isArray(rawSteps)) {
      for (const rawStep of rawSteps) {
        const phase =
          rawStep.phase === 'discovery' ? StepPhase.DISCOVERY : StepPhase.EXECUTION;

        steps.push({
          stepNum: Number(rawStep.stepNum) || steps.length + 1,
          objective: String(rawStep.objective || ''),
          toolHint: rawStep.toolHint as string | undefined,
          phase,
          status: StepStatus.PENDING,
          dependsOn: Array.isArray(rawStep.dependsOn)
            ? (rawStep.dependsOn as number[])
            : [],
          required: rawStep.required === true,
          targetPaths: Array.isArray(rawStep.targetPaths)
            ? (rawStep.targetPaths as string[])
            : undefined,
        });
      }
    }

    // Ensure at least one step
    if (steps.length === 0) {
      steps.push({
        stepNum: 1,
        objective: `Execute: ${userInput}`,
        phase: StepPhase.EXECUTION,
        status: StepStatus.PENDING,
        dependsOn: [],
        required: true,
      });
    }

    return {
      goal: String(parsed.goal || userInput),
      goalType: String(parsed.goalType || 'task'),
      steps,
    };
  }

  /**
   * Validate that a plan fits within budget constraints.
   */
  private validatePlanBudget(
    plan: WizardPlan,
    budget: PlanBudget,
    tier: string
  ): { fits: boolean; reason?: string } {
    const toolsNeeded = plan.steps.filter((s) => s.toolHint).length;
    const stepsNeeded = plan.steps.length;

    if (toolsNeeded > budget.maxToolCalls) {
      return {
        fits: false,
        reason: `Plan requires ${toolsNeeded} tools but ${tier} tier allows max ${budget.maxToolCalls}`,
      };
    }

    if (stepsNeeded > budget.maxSteps) {
      return {
        fits: false,
        reason: `Plan requires ${stepsNeeded} steps but ${tier} tier allows max ${budget.maxSteps}`,
      };
    }

    // For simple tier, no tools should be used
    if (tier === 'simple' && plan.steps.some((s) => s.toolHint)) {
      return {
        fits: false,
        reason: `Simple tier cannot use tools, but plan requires: ${plan.steps.filter((s) => s.toolHint).map((s) => s.toolHint)}`,
      };
    }

    return { fits: true };
  }

  /**
   * Create a plan that immediately fails due to budget constraints.
   */
  private createBudgetExceededPlan(
    userInput: string,
    budget: PlanBudget,
    tier: string,
    reason: string
  ): WizardPlan {
    return {
      goal: `BUDGET_EXCEEDED: ${userInput.slice(0, 100)}`,
      goalType: 'error',
      steps: [
        {
          stepNum: 1,
          objective: `Return error: Task cannot be completed within ${tier} tier budget. ${reason}`,
          phase: StepPhase.EXECUTION,
          status: StepStatus.FAILED,
          dependsOn: [],
          required: true,
        },
      ],
    };
  }
}
