/**
 * Stop Hook Types - For per-request stop hook configuration.
 *
 * Stop hooks intercept agent termination and can block it to re-inject
 * a new prompt. This enables Ralph Loop and similar iterative patterns.
 *
 * Usage: Pass a StopHookHandler to OrchestratorConfig.stopHook
 */

import type { StopHookResult } from 'agent';

/**
 * Stop hook context - information about the termination.
 */
export interface StopHookContext {
  workId: string;
  response: string;
  terminationReason: string;
  iteration: number;
  agentType: string;
  sessionKey: string;
}

/**
 * Stop hook handler function signature.
 * Returns decision to allow termination or block and re-inject a prompt.
 */
export type StopHookHandler = (context: StopHookContext) => StopHookResult | Promise<StopHookResult>;
