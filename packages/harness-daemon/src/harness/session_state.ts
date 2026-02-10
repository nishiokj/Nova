/**
 * Session State - Consolidated per-session state for AgentHarness.
 *
 * Replaces multiple Maps tracking session data:
 * - sessionStores
 * - decisionDatabases
 * - watcherEngines
 * - sessionWorkLogs
 * - workItemLogs (keyed by workId)
 * - workItemsCreated
 * - watcherContexts
 * - watcherHookRegistries
 */

import type { SessionStore } from './session_store.js';
import type { ContextWindow } from 'context';
import type {
  DecisionDatabase,
  DecisionEngine,
  WorkLog,
  WorkItemLog,
} from 'decision-watcher';
import type { HookRegistry } from 'orchestrator';

/**
 * Per-session state container.
 * Consolidates all session-scoped Maps into a single object.
 */
export interface SessionState {
  /** Session store for context persistence */
  store: SessionStore;
  /** Last access timestamp (ms) for TTL eviction */
  lastAccessMs: number;
  /** Decision database for watcher persistence (optional) */
  decisionDatabase?: DecisionDatabase;
  /** Watcher decision engine (optional) */
  watcherEngine?: DecisionEngine;
  /** Work log for session (optional) */
  workLog?: WorkLog;
  /** Per-work-item logs (keyed by workId) */
  workItemLogs: Map<string, WorkItemLog>;
  /** Set of created work item IDs for this session */
  workItemsCreated: Set<string>;
  /** Watcher context window (optional) */
  watcherContext?: ContextWindow;
  /** Watcher hook registry (optional) */
  hookRegistry?: HookRegistry;
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
    workItemLogs: new Map(),
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
  state.workItemLogs.clear();
  state.internalHookUnregisters.length = 0;
}

/**
 * Get or create a work item log for a session.
 */
export function getOrCreateWorkItemLog(
  state: SessionState,
  workId: string,
  createLog: () => WorkItemLog
): WorkItemLog {
  let log = state.workItemLogs.get(workId);
  if (!log) {
    log = createLog();
    state.workItemLogs.set(workId, log);
  }
  return log;
}
