/**
 * Decision Watcher
 *
 * Main component that intercepts PromptUser events and auto-answers
 * questions using the decision engine and database.
 *
 * The watcher is designed to be integrated with the orchestrator's
 * hook system to provide async mode capabilities.
 */

import type {
  DecisionDatabase,
  DecisionEngine,
  WatcherContext,
  WatcherResponse,
  PromptUserAnswer,
  DecisionWatcherConfig,
  WatcherIntegrationConfig,
  PromptUserHookEvent,
  PromptUserHookResult,
  UserPromptInfo,
} from '../types.js';
import { createDecisionEngine } from '../engine/index.js';

// ============================================
// DECISION WATCHER
// ============================================

/**
 * Main watcher class that orchestrates decision-making.
 */
export class DecisionWatcher {
  private config: DecisionWatcherConfig;
  private engine: DecisionEngine;
  private integration?: WatcherIntegrationConfig;
  private active = false;
  private sessionIdCounter = 0;

  constructor(
    db: DecisionDatabase,
    config: DecisionWatcherConfig
  ) {
    this.config = config;
    this.engine = createDecisionEngine(db, config);

    if (!config.enabled) {
      console.log('[DecisionWatcher] Async mode disabled');
      return;
    }

    this.active = true;
    console.log('[DecisionWatcher] Async mode enabled');
  }

  /**
   * Start the watcher with integration configuration.
   */
  start(integration: WatcherIntegrationConfig): void {
    if (!this.active) {
      console.warn('[DecisionWatcher] Cannot start - watcher is disabled');
      return;
    }

    this.integration = integration;
    console.log('[DecisionWatcher] Started with integration');
  }

  /**
   * Stop the watcher.
   */
  stop(): void {
    this.active = false;
    this.integration = undefined;
    console.log('[DecisionWatcher] Stopped');
  }

  /**
   * Handle a PromptUser hook event.
   * This is the main entry point called by the orchestrator.
   */
  async handlePromptUser(event: PromptUserHookEvent): Promise<PromptUserHookResult> {
    if (!this.active) {
      return { action: 'block', reason: 'Watcher not enabled' };
    }

    if (!this.integration) {
      console.warn('[DecisionWatcher] Integration not configured');
      return { action: 'block', reason: 'Watcher integration not configured' };
    }

    try {
      // Build context for the decision engine
      const context = await this.buildContext(event);

      // Ask the engine to answer the question
      const response = await this.engine.answerQuestion(context);

      // Determine what to do based on response
      const shouldAnswer = this.shouldAutoAnswer(response);

      if (shouldAnswer) {
        // Auto-answer the question
        const answer = this.buildPromptUserAnswer(response, event.prompt);

        // Record the decision in session memory
        const bestDecision = response.relevantDecisions[0];
        this.engine.recordDecision(
          context.sessionId,
          event.prompt.question,
          Array.isArray(answer.answer) ? answer.answer.join(', ') : String(answer.answer),
          bestDecision?.id
        );

        // Notify integration
        this.integration.onAnswer?.(event.prompt, answer, response);

        // Inject answer back into agent
        this.integration.injectAnswer(answer, event.workItemId);

        return { action: 'answer', answer };
      } else {
        // Escalate to user
        this.integration.onEscalate?.(event.prompt, response);
        return { action: 'escalate', response };
      }
    } catch (error) {
      console.error('[DecisionWatcher] Error handling PromptUser:', error);

      // On error, block to let normal flow continue
      return {
        action: 'block',
        reason: `Watcher error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Build watcher context from hook event.
   */
  private async buildContext(event: PromptUserHookEvent): Promise<WatcherContext> {
    // Generate session ID (incrementing counter)
    const sessionId = `session-${this.sessionIdCounter++}`;

    // Get session memory if available
    const sessionDecisions = this.engine.getSessionMemory(sessionId);

    return {
      sessionId,
      goal: '', // Will be populated from work item
      prompt: event.prompt,
      executionContext: {
        filesRead: [], // TODO: Extract from agent context
        toolsUsed: [], // TODO: Extract from agent context
        currentAgent: '', // TODO: Extract from work item
      },
      sessionDecisions,
    };
  }

  /**
   * Determine if we should auto-answer based on response.
   */
  private shouldAutoAnswer(response: WatcherResponse): boolean {
    const confidenceScore = this.confidenceToScore(response.confidence);

    // Check minimum confidence threshold
    if (confidenceScore < this.config.minConfidenceThreshold) {
      return false;
    }

    // Check if escalation is required
    if (response.source === 'escalate') {
      return false;
    }

    // Check for warnings that should escalate
    if (response.warnings.length > 0 && this.config.escalateWithWarnings) {
      return false;
    }

    return true;
  }

  /**
   * Build a PromptUserAnswer from WatcherResponse.
   */
  private buildPromptUserAnswer(
    response: WatcherResponse,
    prompt: UserPromptInfo
  ): PromptUserAnswer {
    const answer: PromptUserAnswer = {
      answer: response.answer,
      shouldContinue: true,
    };

    // If it's a multiple choice question, select the matching option
    if (prompt.options && !Array.isArray(response.answer)) {
      const answerStr = String(response.answer).toLowerCase();
      const matchingOption = prompt.options.find(opt => {
        const optStr = typeof opt === 'string' ? opt.toLowerCase() : opt.label.toLowerCase();
        return optStr.includes(answerStr) || answerStr.includes(optStr);
      });

      if (matchingOption) {
        const optLabel = typeof matchingOption === 'string' ? matchingOption : matchingOption.label;
        answer.selectedOption = optLabel;
      }
    }

    // Add rationale as context if available
    if (response.rationale) {
      answer.contextAddendum = `[Watcher Decision]\n${response.rationale}`;
    }

    // Add warnings to context if any
    if (response.warnings.length > 0) {
      const warningText = response.warnings.map(w => `⚠️ ${w}`).join('\n');
      answer.contextAddendum = answer.contextAddendum
        ? `${answer.contextAddendum}\n\n${warningText}`
        : warningText;
    }

    return answer;
  }

  /**
   * Convert confidence level to numeric score.
   */
  private confidenceToScore(confidence: string): number {
    const scores: Record<string, number> = {
      'very-high': 0.9,
      'high': 0.75,
      'medium': 0.5,
      'low': 0.25,
      'none': 0,
    };
    return scores[confidence] ?? 0;
  }

  /**
   * Get watcher statistics.
   */
  getStats(): {
    active: boolean;
    sessionIdCounter: number;
  } {
    return {
      active: this.active,
      sessionIdCounter: this.sessionIdCounter,
    };
  }

  /**
   * Clear session memory.
   */
  clearSession(sessionId: string): void {
    this.engine.clearSession(sessionId);
  }
}

// ============================================
// FACTORY FUNCTION
// ============================================

/**
 * Create a decision watcher.
 */
export function createDecisionWatcher(
  db: DecisionDatabase,
  config: DecisionWatcherConfig
): DecisionWatcher {
  return new DecisionWatcher(db, config);
}

// ============================================
// DEFAULT CONFIGURATION
// ============================================

/**
 * Default configuration for the decision watcher.
 */
export const DEFAULT_WATCHER_CONFIG: DecisionWatcherConfig = {
  enabled: true,
  minConfidenceThreshold: 0.6, // Require at least "high" confidence
  escalateCritical: true,
  escalateWithWarnings: false,
  maxDecisionsToConsult: 10,
  useLLMSynthesis: true,
  enableConsistencyChecking: true,
};
