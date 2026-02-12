/**
 * Session State - Consolidated per-session state for AgentHarness.
 */

import type { SessionStore } from './session_store.js';

/**
 * Per-session state container.
 * Consolidates all session-scoped Maps into a single object.
 */
export interface SessionState {
  /** Session store for context persistence */
  store: SessionStore;
  /** Last access timestamp (ms) for TTL eviction */
  lastAccessMs: number;
  /** Set of created work item IDs for this session */
  workItemsCreated: Set<string>;
  /** Internal-hook unregister callbacks for session-scoped global hooks */
  internalHookUnregisters: Array<() => void>;
}

/**
 * Create a new session state.
 */
export function createSessionState(store: SessionStore): SessionState {
  return {
    store,
    lastAccessMs: Date.now(),
    workItemsCreated: new Set(),
    internalHookUnregisters: [],
  };
}

/**
 * Update last access time on session state.
 */
export function touchSession(state: SessionState): void {
  state.lastAccessMs = Date.now();
}

/**
 * Clear mutable state before session eviction.
 * Prevents unbounded accumulation in long-lived sessions.
 */
export function clearSessionState(state: SessionState): void {
  state.workItemsCreated.clear();
  state.internalHookUnregisters.length = 0;
}
