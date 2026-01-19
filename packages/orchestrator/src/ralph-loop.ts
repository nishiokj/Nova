/**
 * Ralph Loop - Iterative self-referential development loop.
 *
 * Based on Geoffrey Huntley's Ralph Wiggum technique:
 * - Same prompt fed repeatedly to agent
 * - Agent sees its previous work in files/context
 * - Iterates until completion promise detected or max iterations
 *
 * The "self-referential" aspect comes from the agent seeing its
 * own previous work in files and context, not from feeding output
 * back as input directly.
 *
 * Usage:
 * ```ts
 * const orchestrator = new Orchestrator({
 *   stopHook: createRalphStopHook({ prompt: '...', maxIterations: 20, completionPromise: 'DONE' }),
 * }, ...);
 * ```
 */

import type { StopHookHandler } from './hooks/stop-hook.js';
import type { StopHookResult } from 'agent';

export interface RalphLoopConfig {
  /** The prompt to repeat each iteration */
  prompt: string;
  /** Maximum iterations before auto-stop (0 = unlimited) */
  maxIterations: number;
  /** Promise phrase to signal completion (null = no completion check) */
  completionPromise: string | null;
  /** Called on each iteration with current state */
  onIteration?: (state: RalphLoopState) => void;
  /** Called when loop completes */
  onComplete?: (state: RalphLoopState, reason: RalphCompletionReason) => void;
}

export interface RalphLoopState {
  iteration: number;
  maxIterations: number;
  completionPromise: string | null;
  startedAt: Date;
  lastResponse: string;
}

export type RalphCompletionReason =
  | 'promise_detected'
  | 'max_iterations'
  | 'manual_cancel'
  | 'error';

/**
 * Check if agent response contains the completion promise.
 * Promise must be wrapped in <promise></promise> tags.
 */
export function checkCompletionPromise(response: string, promise: string): boolean {
  if (!promise) return false;

  // Extract text from <promise> tags (case insensitive, handles whitespace)
  const promiseRegex = /<promise>([\s\S]*?)<\/promise>/i;
  const match = response.match(promiseRegex);

  if (!match) return false;

  // Normalize whitespace and compare
  const extracted = match[1].trim().replace(/\s+/g, ' ');
  const expected = promise.trim().replace(/\s+/g, ' ');

  return extracted === expected;
}

/**
 * Create initial Ralph Loop state.
 */
export function createRalphState(config: RalphLoopConfig): RalphLoopState {
  return {
    iteration: 0,
    maxIterations: config.maxIterations,
    completionPromise: config.completionPromise,
    startedAt: new Date(),
    lastResponse: '',
  };
}

/**
 * Ralph Loop controller for orchestrator integration.
 *
 * Usage:
 * ```ts
 * const ralph = new RalphLoop({
 *   prompt: 'Build a REST API',
 *   maxIterations: 20,
 *   completionPromise: 'TASK COMPLETE',
 * });
 *
 * while (!ralph.isComplete()) {
 *   const prompt = ralph.getPrompt();
 *   const result = await orchestrator.execute(context, prompt, agentType, cwd);
 *   ralph.recordIteration(result.response);
 * }
 * ```
 */
export class RalphLoop {
  private config: RalphLoopConfig;
  private state: RalphLoopState;
  private cancelled = false;
  private completionReason: RalphCompletionReason | null = null;

  constructor(config: RalphLoopConfig) {
    this.config = config;
    this.state = createRalphState(config);
  }

  /**
   * Get the prompt for this iteration.
   * Returns the same prompt each time (that's the Ralph technique).
   */
  getPrompt(): string {
    return this.config.prompt;
  }

  /**
   * Get system message with iteration info and completion instructions.
   */
  getSystemMessage(): string {
    const parts: string[] = [];

    parts.push(`🔄 Ralph iteration ${this.state.iteration + 1}`);

    if (this.config.maxIterations > 0) {
      parts.push(`of ${this.config.maxIterations}`);
    }

    if (this.config.completionPromise) {
      parts.push(`| To complete: output <promise>${this.config.completionPromise}</promise>`);
    }

    return parts.join(' ');
  }

  /**
   * Record the result of an iteration.
   * Checks for completion and updates state.
   */
  recordIteration(response: string): void {
    this.state.iteration++;
    this.state.lastResponse = response;

    // Check for completion promise
    if (this.config.completionPromise && checkCompletionPromise(response, this.config.completionPromise)) {
      this.completionReason = 'promise_detected';
      this.config.onComplete?.(this.state, this.completionReason);
      return;
    }

    // Check for max iterations
    if (this.config.maxIterations > 0 && this.state.iteration >= this.config.maxIterations) {
      this.completionReason = 'max_iterations';
      this.config.onComplete?.(this.state, this.completionReason);
      return;
    }

    // Notify iteration callback
    this.config.onIteration?.(this.state);
  }

  /**
   * Check if the loop is complete.
   */
  isComplete(): boolean {
    return this.cancelled || this.completionReason !== null;
  }

  /**
   * Get the completion reason (null if still running).
   */
  getCompletionReason(): RalphCompletionReason | null {
    return this.completionReason;
  }

  /**
   * Get current loop state.
   */
  getState(): Readonly<RalphLoopState> {
    return this.state;
  }

  /**
   * Cancel the loop.
   */
  cancel(): void {
    this.cancelled = true;
    this.completionReason = 'manual_cancel';
    this.config.onComplete?.(this.state, this.completionReason);
  }

  /**
   * Mark loop as failed due to error.
   */
  recordError(error: Error): void {
    this.completionReason = 'error';
    this.config.onComplete?.(this.state, this.completionReason);
  }
}

/**
 * Run a Ralph Loop with the orchestrator.
 *
 * This is a convenience function that handles the full loop lifecycle.
 * For more control, use the RalphLoop class directly.
 */
export async function runRalphLoop<T>(
  config: RalphLoopConfig,
  executor: (prompt: string, systemMessage: string, iteration: number) => Promise<{ response: string; success: boolean; error?: string }>
): Promise<{
  success: boolean;
  reason: RalphCompletionReason;
  iterations: number;
  lastResponse: string;
  error?: string;
}> {
  const ralph = new RalphLoop(config);

  while (!ralph.isComplete()) {
    const prompt = ralph.getPrompt();
    const systemMessage = ralph.getSystemMessage();
    const state = ralph.getState();

    try {
      const result = await executor(prompt, systemMessage, state.iteration);

      if (!result.success && result.error) {
        ralph.recordError(new Error(result.error));
        return {
          success: false,
          reason: 'error',
          iterations: state.iteration,
          lastResponse: result.response,
          error: result.error,
        };
      }

      ralph.recordIteration(result.response);
    } catch (err) {
      ralph.recordError(err instanceof Error ? err : new Error(String(err)));
      return {
        success: false,
        reason: 'error',
        iterations: state.iteration,
        lastResponse: ralph.getState().lastResponse,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const finalState = ralph.getState();
  const reason = ralph.getCompletionReason()!;

  return {
    success: reason === 'promise_detected',
    reason,
    iterations: finalState.iteration,
    lastResponse: finalState.lastResponse,
  };
}

// ============================================
// STOP HOOK INTEGRATION
// ============================================

/**
 * Create a Ralph Loop stop hook for orchestrator config.
 *
 * Returns a StopHookHandler to pass to orchestrator config.
 * The hook maintains iteration state via closure - each orchestrator
 * instance gets its own isolated state.
 *
 * Usage:
 * ```ts
 * const orchestrator = new Orchestrator({
 *   stopHook: createRalphStopHook({
 *     prompt: 'Build a REST API',
 *     maxIterations: 20,
 *     completionPromise: 'TASK COMPLETE',
 *     onIteration: (state) => console.log(`Iteration ${state.iteration}`),
 *   }),
 * }, toolRegistry, llm, emit, requestId);
 *
 * // Run orchestrator - Ralph Loop intercepts each goal_state_reached
 * await orchestrator.execute(context, 'Build a REST API', 'standard', cwd);
 * ```
 */
export function createRalphStopHook(config: RalphLoopConfig): StopHookHandler {
  const state = createRalphState(config);

  return (context): StopHookResult => {
    state.iteration++;
    state.lastResponse = context.response;

    // Check for completion promise
    if (config.completionPromise && checkCompletionPromise(context.response, config.completionPromise)) {
      config.onComplete?.(state, 'promise_detected');
      return { decision: 'allow' };
    }

    // Check for max iterations
    if (config.maxIterations > 0 && state.iteration >= config.maxIterations) {
      config.onComplete?.(state, 'max_iterations');
      return { decision: 'allow' };
    }

    // Notify iteration callback
    config.onIteration?.(state);

    // Build system message
    const parts: string[] = [`🔄 Ralph iteration ${state.iteration + 1}`];
    if (config.maxIterations > 0) {
      parts.push(`of ${config.maxIterations}`);
    }
    if (config.completionPromise) {
      parts.push(`| To complete: output <promise>${config.completionPromise}</promise>`);
    }

    // Block termination and re-inject the same prompt
    return {
      decision: 'block',
      reason: config.prompt,
      systemMessage: parts.join(' '),
    };
  };
}
