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

import type { StopHookHandler, StopHookContext } from './hooks.js';
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
/** Minimum ms between iterations before triggering death spiral detection */
const DEATH_SPIRAL_THRESHOLD_MS = 2000;
/** Number of rapid iterations before aborting */
const DEATH_SPIRAL_COUNT = 3;

/** Termination reasons that should always continue the Ralph loop */
const CONTINUABLE_TERMINATIONS = new Set([
  'goal_state_reached',
  'max_iterations_exceeded',
  'max_tool_calls_exceeded',
  'max_duration_exceeded',
  'handoff_requested', // Orchestrator handles handoffs internally
  'user_input_required', // Handled specially with async mode message
  'no_action', // LLM didn't output proper action field - common formatting issue
  'invalid_action', // Invalid action value - try again
  'stagnation:tool_repeat', // Agent is repeating tool calls - nudge it to try something else
]);

/** Termination reasons that can continue IF there's substantial response content */
const CONDITIONAL_CONTINUABLE = new Set([
  'agent_error', // Agent errors might be recoverable if LLM produced output
  'exception', // Caught exceptions - recoverable if we have partial output
]);

/** Termination reasons that MUST terminate the loop - no recovery */
const TERMINAL_TERMINATIONS = new Set([
  'refusal', // Model refused - no point retrying
  'circuit_open', // Circuit breaker tripped - must stop
  'rate_limit', // Rate limited - must stop
  'user_stopped', // User explicitly stopped
]);

/** Minimum response length to consider an error recoverable */
const MIN_RESPONSE_FOR_RECOVERY = 50;

/** Message sent when agent tries to ask user questions in async Ralph mode */
const ASYNC_MODE_MESSAGE = 'You are in async mode. User cannot answer questions. Do not ask again. Continue working autonomously.';

export function createRalphStopHook(config: RalphLoopConfig): StopHookHandler {
  const state = createRalphState(config);
  let lastIterationTime = Date.now();
  let rapidFireCount = 0;

  return (context: StopHookContext): StopHookResult => {
    state.lastResponse = context.response;

    // TERMINAL TERMINATIONS: These MUST end the loop immediately - no recovery possible
    if (TERMINAL_TERMINATIONS.has(context.terminationReason)) {
      console.log(`[RalphLoop] Terminal termination: ${context.terminationReason} at iteration ${state.iteration}`);
      config.onComplete?.(state, 'error');
      return { decision: 'allow' };
    }

    // Check if this termination reason allows continuation
    const isAlwaysContinuable = CONTINUABLE_TERMINATIONS.has(context.terminationReason);
    const isConditionalContinuable = CONDITIONAL_CONTINUABLE.has(context.terminationReason);
    const hasSubstantialResponse = (context.response?.length ?? 0) >= MIN_RESPONSE_FOR_RECOVERY;

    // For unknown termination reasons, log and terminate to be safe
    // This prevents silent failures on new/unhandled termination types
    if (!isAlwaysContinuable && !isConditionalContinuable) {
      console.warn(`[RalphLoop] Unknown termination reason: ${context.terminationReason} - terminating loop at iteration ${state.iteration}`);
      config.onComplete?.(state, 'error');
      return { decision: 'allow' };
    }

    // Conditional continuable (agent_error, exception) - only continue if we have substantial output
    if (isConditionalContinuable && !hasSubstantialResponse) {
      console.log(`[RalphLoop] Conditional termination (${context.terminationReason}) without substantial response at iteration ${state.iteration}`);
      config.onComplete?.(state, 'error');
      return { decision: 'allow' };
    }

    // Death spiral detection - abort if iterations are completing too fast
    const now = Date.now();
    const elapsed = now - lastIterationTime;
    lastIterationTime = now;

    if (elapsed < DEATH_SPIRAL_THRESHOLD_MS) {
      rapidFireCount++;
      if (rapidFireCount >= DEATH_SPIRAL_COUNT) {
        console.warn(`[RalphLoop] Death spiral detected (${rapidFireCount} rapid iterations) at iteration ${state.iteration}`);
        config.onComplete?.(state, 'error');
        return { decision: 'allow' };
      }
    } else {
      rapidFireCount = 0; // Reset on normal iteration
    }

    // Handle user_input_required specially - tell agent it's in async mode
    // Don't increment iteration count for this, it's not real progress
    if (context.terminationReason === 'user_input_required') {
      // Still emit iteration event so TUI knows loop is continuing
      config.onIteration?.(state);
      return {
        decision: 'block',
        reason: ASYNC_MODE_MESSAGE,
        systemMessage: `🔄 Ralph iteration ${state.iteration + 1} (async mode - no user input available)`,
      };
    }

    // Handle error conditions that we're retrying - add context about the issue
    const isFormatError = context.terminationReason === 'no_action' ||
                          context.terminationReason === 'invalid_action';
    const isRecoverableError = context.terminationReason === 'agent_error' ||
                               context.terminationReason === 'exception';
    const isStagnation = context.terminationReason === 'stagnation:tool_repeat';

    let errorHint = '';
    if (isFormatError) {
      errorHint = `\n\nPrevious iteration ended with ${context.terminationReason}. Make sure to use proper structured output with action field.`;
    } else if (isRecoverableError) {
      errorHint = `\n\nPrevious iteration encountered an error (${context.terminationReason}). Continue working on the task.`;
    } else if (isStagnation) {
      errorHint = `\n\nPrevious iteration detected tool repetition. Try a different approach or tool to make progress.`;
    }

    // Increment iteration count for actual progress
    state.iteration++;

    // Check for completion promise
    if (config.completionPromise && checkCompletionPromise(context.response, config.completionPromise)) {
      console.log(`[RalphLoop] Completion promise detected at iteration ${state.iteration}`);
      config.onComplete?.(state, 'promise_detected');
      return { decision: 'allow' };
    }

    // Check for max iterations
    if (config.maxIterations > 0 && state.iteration >= config.maxIterations) {
      console.log(`[RalphLoop] Max iterations (${config.maxIterations}) reached`);
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

    console.log(`[RalphLoop] Continuing to iteration ${state.iteration + 1} (reason: ${context.terminationReason})`);

    // Block termination and re-inject the same prompt
    return {
      decision: 'block',
      reason: config.prompt + errorHint,
      systemMessage: parts.join(' '),
    };
  };
}
