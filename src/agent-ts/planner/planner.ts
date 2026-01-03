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
import type { WizardEvent } from '../types/events.js';

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
- Keep plans simple - prefer fewer steps
- Only include tool hints when truly necessary
- Mark steps as "required" only if they must complete for success
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
  private eventEmitter?: (event: WizardEvent) => void;

  // Store last LLM call details for logging
  lastCallInstructions = '';
  lastCallInput = '';
  lastCallResponse = '';
  lastCallDurationMs = 0;

  constructor(
    llm: LLMAdapter,
    toolRegistry: ToolRegistry,
    config?: Partial<PlannerConfig>,
    eventEmitter?: (event: WizardEvent) => void
  ) {
    this.llm = llm;
    this.toolRegistry = toolRegistry;
    this.config = { ...DEFAULT_PLANNER_CONFIG, ...config };
    this.eventEmitter = eventEmitter;
  }

  /**
   * Create an execution plan for the user's request.
   */
  async createPlan(
    userInput: string,
    context?: string,
    tier = 'standard',
    budget?: PlanBudget
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
      return simplePlan;
    }

    // Complex path: use LLM to create plan
    const plan = await this.createLlmPlan(userInput, context, tier);

    // Validate against budget
    if (budget) {
      const validation = this.validatePlanBudget(plan, budget, tier);
      if (!validation.fits) {
        return this.createBudgetExceededPlan(userInput, budget, tier, validation.reason!);
      }
    }

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
    _tier = 'standard'
  ): Promise<WizardPlan> {
    const startTime = Date.now();

    // Build prompt
    const contextSection = context ? `Context:\n${context}\n` : '';
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
        throw new Error('No JSON found in LLM response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return this.normalizePlan(parsed, userInput);
    } catch (error) {
      // Fallback to simple single-step plan
      return {
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
