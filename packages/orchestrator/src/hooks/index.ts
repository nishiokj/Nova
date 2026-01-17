/**
 * Internal Hook Registry
 *
 * Maps event types to handler functions.
 * Handlers are plain async functions - no LLM invocation.
 */

import type { InternalHookEvent, InternalHookHandler } from 'agent';

import { handle as handleContextThreshold } from './context-threshold.js';
import { handle as handleTurnCompleted } from './turn-completed.js';
import { handle as handleArtifactsDiscovered } from './artifacts-discovered.js';
import { handle as handleFilesModified } from './files-modified.js';
import { handle as handleAgentCompleted } from './agent-completed.js';
import { handle as handleToolBatchCompleted } from './tool-batch-completed.js';
import { handle as handleHookTest } from './hook-test.js';

type InternalHookType = InternalHookEvent['type'];
type InternalHookEventMap = {
  [K in InternalHookType]: Extract<InternalHookEvent, { type: K }>;
};
type InternalHookRegistry = {
  [K in InternalHookType]: Array<InternalHookHandler<InternalHookEventMap[K]>>;
};

/**
 * Registry mapping event types to their handlers.
 * Multiple handlers per event type supported.
 */
export const HOOK_REGISTRY: InternalHookRegistry = {
  context_threshold: [handleContextThreshold],
  turn_completed: [handleTurnCompleted, handleHookTest],
  tool_batch_completed: [handleToolBatchCompleted],
  artifacts_discovered: [handleArtifactsDiscovered],
  files_modified: [handleFilesModified],
  agent_completed: [handleAgentCompleted],
};

/**
 * Register an additional handler for an event type.
 */
export function registerHook<T extends InternalHookType>(
  eventType: T,
  handler: InternalHookHandler<InternalHookEventMap[T]>
): void {
  if (!HOOK_REGISTRY[eventType]) {
    HOOK_REGISTRY[eventType] = [];
  }
  HOOK_REGISTRY[eventType].push(handler);
}

/**
 * Get all handlers for an event type.
 */
export function getHandlers<T extends InternalHookType>(
  eventType: T
): Array<InternalHookHandler<InternalHookEventMap[T]>> {
  return HOOK_REGISTRY[eventType] ?? [];
}
