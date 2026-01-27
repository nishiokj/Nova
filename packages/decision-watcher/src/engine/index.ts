/**
 * Decision Engine
 *
 * Core logic for matching questions to decisions and synthesizing answers.
 * The engine handles:
 * - Direct database lookups
 * - Synthesis from multiple decisions/preferences
 * - LLM inference for novel questions
 * - Consistency checking across decisions
 */

import type {
  DecisionEntry,
  Decision,
  Preference,
  WatcherResponse,
  WatcherAnswerSource,
  ConfidenceLevel,
  WatcherContext,
  DecisionDatabase,
  DecisionWatcherConfig,
  DecisionMemory,
  DecisionCategory,
  isDecision,
  isPreference,
} from '../types.js';
import type { LLMAdapter, Message } from '@jesus/llm';
import { isDecision as _isDecision, isPreference as _isPreference } from '../types.js';

// ============================================
// DECISION ENGINE
// ============================================

/**
 * Main decision engine for answering PromptUser questions.
 */
export class DecisionEngine {
  private db: DecisionDatabase;
  private config: DecisionWatcherConfig;
  private llm?: LLMAdapter;
  private sessionMemories: Map<string, DecisionMemory> = new Map();

  constructor(db: DecisionDatabase, config: DecisionWatcherConfig) {
    this.db = db;
    this.config = config;
    this.llm = config.llm;
  }

  /**
   * Answer a PromptUser question.
   */
  async answerQuestion(context: WatcherContext): Promise<WatcherResponse> {
    const startTime = Date.now();

    try {
      // Step 1: Search database for matching decisions
      const matches = await this.searchDatabase(context);

      if (matches.length === 0) {
        // No direct matches - can we synthesize or infer?
        return await this.handleNoMatches(context, startTime);
      }

      // Step 2: Analyze matches and select best answer
      const bestMatch = this.selectBestMatch(matches, context);

      if (bestMatch.score < this.config.minConfidenceThreshold) {
        // Low confidence - may need LLM synthesis
        if (this.config.useLLMSynthesis && this.llm) {
          return await this.synthesizeAnswer(matches, context, startTime);
        }

        // Can't synthesize - escalate
        return this.createEscalateResponse(matches, 'low-confidence', startTime);
      }

      // Step 3: Check for consistency issues
      const warnings = await this.checkConsistency(bestMatch.entry, context);

      if (warnings.length > 0 && this.config.escalateWithWarnings) {
        return this.createEscalateResponse(matches, 'warnings', startTime, warnings);
      }

      // Step 4: Build final answer
      return this.createAnswerResponse(bestMatch, matches, warnings, startTime);
    } catch (error) {
      console.error('[DecisionEngine] Error answering question:', error);
      return {
        source: 'uncertain',
        confidence: 'none',
        answer: 'Unable to determine answer due to error.',
        relevantDecisions: [],
        warnings: [`Engine error: ${error instanceof Error ? error.message : String(error)}`],
        requiresConsistencyCheck: false,
        metadata: {
          processingTimeMs: Date.now() - startTime,
          decisionsConsulted: 0,
          llmCalls: 0,
        },
      };
    }
  }

  /**
   * Search database for decisions matching the question.
   */
  private async searchDatabase(context: WatcherContext): Promise<Array<{ entry: DecisionEntry; score: number }>> {
    const query = this.buildSearchQuery(context);
    const results = await this.db.search(query, {
      limit: this.config.maxDecisionsToConsult,
    });

    return results.map(entry => ({
      entry,
      score: this.calculateMatchScore(entry, query, context),
    }));
  }

  /**
   * Build search query from context.
   */
  private buildSearchQuery(context: WatcherContext): string {
    const parts = [context.goal];

    // Add question text
    parts.push(context.prompt.question);

    // Add context
    if (context.prompt.context) {
      parts.push(context.prompt.context);
    }

    // Add project context
    if (context.projectContext?.language) {
      parts.push(context.projectContext.language);
    }
    if (context.projectContext?.framework) {
      parts.push(context.projectContext.framework);
    }

    return parts.join(' ');
  }

  /**
   * Calculate match score for an entry.
   */
  private calculateMatchScore(entry: DecisionEntry, query: string, context: WatcherContext): number {
    let score = 0;
    const normalizedQuery = query.toLowerCase();
    const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 2);

    // Check question pattern
    if ('questionPattern' in entry) {
      const patternLower = entry.questionPattern.toLowerCase();
      if (patternLower.includes(normalizedQuery) || normalizedQuery.includes(patternLower)) {
        score += 40;
      }
    }

    // Keyword matches
    for (const kw of entry.keywords) {
      const kwLower = kw.toLowerCase();
      if (normalizedQuery.includes(kwLower)) {
        score += 15;
      }
    }

    // Category relevance
    if (this.isCategoryRelevant(entry.category, context)) {
      score += 10;
    }

    // Scope relevance
    if (this.isScopeRelevant(entry.scope, context)) {
      score += 10;
    }

    // Project-specific applicability
    if (entry.appliesTo) {
      let applicable = true;
      if (entry.appliesTo.language && context.projectContext?.language) {
        applicable = entry.appliesTo.language === context.projectContext.language;
      }
      if (applicable && entry.appliesTo.framework && context.projectContext?.framework) {
        applicable = entry.appliesTo.framework === context.projectContext.framework;
      }
      if (applicable) {
        score += 20;
      } else {
        score = 0; // Not applicable
      }
    }

    return score;
  }

  /**
   * Check if category is relevant to context.
   */
  private isCategoryRelevant(category: DecisionCategory, context: WatcherContext): boolean {
    // TODO: Implement smarter category relevance detection
    // For now, all categories are considered relevant
    return true;
  }

  /**
   * Check if scope is relevant to context.
   */
  private isScopeRelevant(scope: DecisionCategory, context: WatcherContext): boolean {
    if (scope === 'global') return true;
    if (scope === 'project') return !!context.projectContext;
    if (scope === 'language') return !!context.projectContext?.language;
    if (scope === 'framework') return !!context.projectContext?.framework;
    if (scope === 'component') return context.executionContext.filesRead.length > 0;
    return true;
  }

  /**
   * Select the best match from results.
   */
  private selectBestMatch(
    matches: Array<{ entry: DecisionEntry; score: number }>,
    context: WatcherContext
  ): { entry: DecisionEntry; score: number } {
    // Sort by score (descending), then by priority
    const priorityOrder: Record<string, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
    };

    matches.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const prioA = priorityOrder[a.entry.priority] ?? 0;
      const prioB = priorityOrder[b.entry.priority] ?? 0;
      return prioB - prioA;
    });

    return matches[0];
  }

  /**
   * Check for consistency issues with a decision.
   */
  private async checkConsistency(
    entry: DecisionEntry,
    context: WatcherContext
  ): Promise<string[]> {
    const warnings: string[] = [];

    // Get session memory
    const memory = this.getOrCreateMemory(context.sessionId);

    // Check for conflicts with previous decisions
    for (const prevDecision of memory.decisionsMade) {
      if (prevDecision.decisionId === entry.id) {
        continue; // Same decision, no conflict
      }

      // Check if current entry conflicts with previous decision
      if ('conflictsWith' in entry) {
        for (const conflictId of entry.conflictsWith) {
          if (prevDecision.decisionId === conflictId) {
            warnings.push(
              `This decision conflicts with a previous decision in this session: "${prevDecision.question}" → "${prevDecision.answer}"`
            );
          }
        }
      }

      // Check if previous decision conflicts with current entry
      const prevEntry = await this.db.get(prevDecision.decisionId ?? '');
      if (prevEntry && 'conflictsWith' in prevEntry) {
        if (prevEntry.conflictsWith.includes(entry.id)) {
          warnings.push(
            `Previous decision conflicts with this one: "${prevDecision.question}" → "${prevDecision.answer}"`
          );
        }
      }
    }

    return warnings;
  }

  /**
   * Handle case where no direct matches were found.
   */
  private async handleNoMatches(
    context: WatcherContext,
    startTime: number
  ): Promise<WatcherResponse> {
    if (this.config.useLLMSynthesis && this.llm) {
      // Try LLM inference
      try {
        const allDecisions = await this.db.getAll();
        const response = await this.inferWithLLM(context, allDecisions);

        return {
          ...response,
          metadata: {
            ...response.metadata,
            processingTimeMs: Date.now() - startTime,
          },
        };
      } catch (error) {
        console.error('[DecisionEngine] LLM inference failed:', error);
      }
    }

    // Can't answer - escalate
    return {
      source: 'uncertain',
      confidence: 'none',
      answer: 'No matching decisions found and unable to infer answer.',
      relevantDecisions: [],
      warnings: [],
      requiresConsistencyCheck: false,
      metadata: {
        processingTimeMs: Date.now() - startTime,
        decisionsConsulted: 0,
        llmCalls: 0,
      },
    };
  }

  /**
   * Synthesize an answer from multiple decisions using LLM.
   */
  private async synthesizeAnswer(
    matches: Array<{ entry: DecisionEntry; score: number }>,
    context: WatcherContext,
    startTime: number
  ): Promise<WatcherResponse> {
    if (!this.llm) {
      return this.createEscalateResponse(matches, 'no-llm', startTime);
    }

    const topEntries = matches.slice(0, 5).map(m => m.entry);

    const prompt = this.buildSynthesisPrompt(context, topEntries);

    try {
      const response = await this.llm.complete({
        messages: [
          {
            role: 'system',
            content: this.getSynthesisSystemPrompt(),
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        llm: {
          provider: this.config.llmModel?.provider ?? 'unknown',
          model: this.config.llmModel?.model ?? 'unknown',
          maxTokens: 1000,
          temperature: 0.3,
        },
      });

      const answerText = response.content ?? 'Unable to synthesize answer.';

      return {
        source: 'synthesized',
        confidence: 'medium',
        answer: answerText,
        rationale: 'Answer synthesized from multiple relevant decisions.',
        relevantDecisions: topEntries.map(entry => ({
          id: entry.id,
          decision: 'decision' in entry ? entry.decision : entry.preference,
          category: entry.category,
          relevance: 0.5,
        })),
        warnings: [],
        requiresConsistencyCheck: true,
        metadata: {
          processingTimeMs: Date.now() - startTime,
          decisionsConsulted: topEntries.length,
          llmCalls: 1,
        },
      };
    } catch (error) {
      console.error('[DecisionEngine] Synthesis failed:', error);
      return this.createEscalateResponse(matches, 'synthesis-failed', startTime);
    }
  }

  /**
   * Infer an answer using LLM when no direct matches exist.
   */
  private async inferWithLLM(
    context: WatcherContext,
    allDecisions: DecisionEntry[]
  ): Promise<WatcherResponse> {
    if (!this.llm) {
      throw new Error('LLM not configured');
    }

    const prompt = this.buildInferencePrompt(context, allDecisions);

    const response = await this.llm.complete({
      messages: [
        {
          role: 'system',
          content: this.getInferenceSystemPrompt(),
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      llm: {
        provider: this.config.llmModel?.provider ?? 'unknown',
        model: this.config.llmModel?.model ?? 'unknown',
        maxTokens: 1500,
        temperature: 0.4,
      },
    });

    const answerText = response.content ?? 'Unable to infer answer.';

    return {
      source: 'inferred',
      confidence: 'medium',
      answer: answerText,
      rationale: 'Answer inferred from decision patterns and project context.',
      relevantDecisions: [],
      warnings: [],
      requiresConsistencyCheck: true,
      metadata: {
        processingTimeMs: 0, // Will be set by caller
        decisionsConsulted: allDecisions.length,
        llmCalls: 1,
      },
    };
  }

  /**
   * Create an answer response from a best match.
   */
  private createAnswerResponse(
    bestMatch: { entry: DecisionEntry; score: number },
    allMatches: Array<{ entry: DecisionEntry; score: number }>,
    warnings: string[],
    startTime: number
  ): WatcherResponse {
    const entry = bestMatch.entry;
    const confidence = this.scoreToConfidence(bestMatch.score);

    let answer: string | string[];
    if ('decision' in entry) {
      answer = entry.decision;
    } else {
      answer = entry.preference;
    }

    const relevantDecisions = allMatches.slice(0, 5).map(m => ({
      id: m.entry.id,
      decision: 'decision' in m.entry ? m.entry.decision : m.entry.preference,
      category: m.entry.category,
      relevance: m.score / 100, // Normalize to 0-1
    }));

    let rationale: string | undefined;
    if ('rationale' in entry && entry.rationale) {
      rationale = entry.rationale;
    }

    return {
      source: 'database-match',
      confidence,
      answer,
      rationale,
      relevantDecisions,
      warnings,
      requiresConsistencyCheck: warnings.length > 0,
      metadata: {
        processingTimeMs: Date.now() - startTime,
        decisionsConsulted: allMatches.length,
        llmCalls: 0,
      },
    };
  }

  /**
   * Create an escalate response.
   */
  private createEscalateResponse(
    matches: Array<{ entry: DecisionEntry; score: number }>,
    reason: string,
    startTime: number,
    additionalWarnings: string[] = []
  ): WatcherResponse {
    return {
      source: 'escalate',
      confidence: 'none',
      answer: `Escalating to user: ${reason}`,
      relevantDecisions: matches.slice(0, 3).map(m => ({
        id: m.entry.id,
        decision: 'decision' in m.entry ? m.entry.decision : m.entry.preference,
        category: m.entry.category,
        relevance: m.score / 100,
      })),
      warnings: additionalWarnings,
      requiresConsistencyCheck: false,
      metadata: {
        processingTimeMs: Date.now() - startTime,
        decisionsConsulted: matches.length,
        llmCalls: 0,
      },
    };
  }

  /**
   * Convert score to confidence level.
   */
  private scoreToConfidence(score: number): ConfidenceLevel {
    if (score >= 80) return 'very-high';
    if (score >= 60) return 'high';
    if (score >= 40) return 'medium';
    if (score >= 20) return 'low';
    return 'none';
  }

  /**
   * Get session memory, creating if needed.
   */
  private getOrCreateMemory(sessionId: string): DecisionMemory {
    if (!this.sessionMemories.has(sessionId)) {
      this.sessionMemories.set(sessionId, {
        sessionId,
        decisionsMade: [],
        patterns: [],
        warnings: [],
        consistencyScore: 1.0,
      });
    }
    return this.sessionMemories.get(sessionId)!;
  }

  /**
   * Record a decision made in a session.
   */
  recordDecision(sessionId: string, question: string, answer: string, decisionId?: string): void {
    const memory = this.getOrCreateMemory(sessionId);
    memory.decisionsMade.push({
      question,
      answer,
      decisionId,
      timestamp: Date.now(),
    });

    // Update consistency score
    if (memory.decisionsMade.length > 1) {
      // Simple heuristic: more decisions = slightly lower consistency potential
      const decay = 0.95 ** (memory.decisionsMade.length - 1);
      memory.consistencyScore = memory.consistencyScore * decay;
    }
  }

  /**
   * Get or create session memory.
   */
  getSessionMemory(sessionId: string): DecisionMemory | undefined {
    return this.sessionMemories.get(sessionId);
  }

  /**
   * Clear session memory.
   */
  clearSession(sessionId: string): void {
    this.sessionMemories.delete(sessionId);
  }

  // ============================================
  // PROMPT TEMPLATES
  // ============================================

  private getSynthesisSystemPrompt(): string {
    return `You are a decision synthesis assistant. Your task is to synthesize an answer to a user's question based on multiple relevant decisions and preferences from a curated database.

Key principles:
- Use the provided decisions as guidance, but synthesize a clear, direct answer
- If decisions conflict, explain the trade-offs and recommend based on priorities
- Maintain consistency with higher-priority decisions
- Provide concise, actionable answers
- If you're uncertain, state this clearly

The output should be a clear, direct answer that addresses the user's question.`;
  }

  private buildSynthesisPrompt(
    context: WatcherContext,
    entries: DecisionEntry[]
  ): string {
    const goalSection = `**Current Goal:**\n${context.goal}`;

    const questionSection = `**Question:**\n${context.prompt.question}`;
    const contextSection = context.prompt.context
      ? `\n**Context:**\n${context.prompt.context}`
      : '';

    const decisionsSection = entries.map(entry => {
      const isDec = 'decision' in entry;
      return `
**${isDec ? 'Decision' : 'Preference'} [${entry.category}, ${entry.priority}]**:
${isDec ? entry.decision : entry.preference}
${isDec && entry.rationale ? `Rationale: ${entry.rationale}` : ''}
${isDec && entry.alternatives.length > 0 ? `Alternatives considered: ${entry.alternatives.join(', ')}` : ''}
${isDec && entry.implications.length > 0 ? `Implications: ${entry.implications.join(', ')}` : ''}
${entry.appliesTo ? `Applies to: ${JSON.stringify(entry.appliesTo)}` : ''}
`;
    }).join('\n---\n');

    return `**Goal:** Synthesize a clear answer to the user's question based on the provided decisions.

${goalSection}

${questionSection}${contextSection}

**Available Decisions:**
${decisionsSection}

**Instructions:**
1. Synthesize a clear, direct answer that addresses the question
2. Reference the most relevant decisions
3. Note any trade-offs or conflicts
4. If multiple options were presented in the question, select the best one based on the decisions

**Answer:**`;
  }

  private getInferenceSystemPrompt(): string {
    return `You are a decision inference assistant. Your task is to infer the most appropriate answer to a question based on:
1. The project context (goal, language, framework)
2. Existing patterns in the curated decision database
3. General software engineering best practices

You should:
- Make reasonable inferences when no direct match exists
- Consider second-order effects of the decision
- Maintain consistency with general engineering principles
- Be explicit about your confidence level

The output should be a clear recommendation with rationale.`;
  }

  private buildInferencePrompt(
    context: WatcherContext,
    allDecisions: DecisionEntry[]
  ): string {
    const goalSection = `**Current Goal:**\n${context.goal}`;

    const questionSection = `**Question:**\n${context.prompt.question}`;
    const contextSection = context.prompt.context
      ? `\n**Context:**\n${context.prompt.context}`
      : '';

    const projectSection = context.projectContext
      ? `**Project Context:**
${context.projectContext.language ? `- Language: ${context.projectContext.language}` : ''}
${context.projectContext.framework ? `- Framework: ${context.projectContext.framework}` : ''}
${context.projectContext.structure ? `- Structure: ${context.projectContext.structure.join(', ')}` : ''}`
      : '';

    const executionSection = `**Execution Context:**
- Files read: ${context.executionContext.filesRead.join(', ') || 'none'}
- Tools used: ${context.executionContext.toolsUsed.join(', ') || 'none'}
- Agent: ${context.executionContext.currentAgent}`;

    // Summarize patterns from database
    const categoryCount = new Map<DecisionCategory, number>();
    for (const d of allDecisions) {
      categoryCount.set(d.category, (categoryCount.get(d.category) ?? 0) + 1);
    }
    const patternsSection = `**Available Patterns:**
${Array.from(categoryCount.entries()).map(([cat, count]) => `- ${cat}: ${count} decisions`).join('\n')}`;

    return `**Goal:** Infer the best answer to the user's question based on project context and general patterns.

${goalSection}

${questionSection}${contextSection}

${projectSection}

${executionSection}

${patternsSection}

**Instructions:**
1. Infer the most appropriate answer based on context and patterns
2. Consider trade-offs and second-order effects
3. Be explicit about your confidence level
4. If uncertain, recommend escalating to user

**Answer:**`;
  }
}

// ============================================
// FACTORY FUNCTION
// ============================================

/**
 * Create a decision engine.
 */
export function createDecisionEngine(
  db: DecisionDatabase,
  config: DecisionWatcherConfig
): DecisionEngine {
  return new DecisionEngine(db, config);
}
