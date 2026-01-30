/**
 * State Patches - Single Writer
 *
 * Orchestrator-owned mutation reducer for protocol patches.
 */

import type { AuditLogEntry, TerminationReason } from 'protocol';
import { assertNever, validatePatch, type StatePatch } from 'protocol';
import type { ContextWindow } from 'context';
import { createWorkItem, type WorkItem } from 'work';

// ============================================
// APPLY RESULT
// ============================================

/**
 * Result of applying patches to state.
 */
export interface ApplyResult {
  /** The updated state */
  state: HookState;
  /** Patches that were successfully applied */
  applied: StatePatch[];
  /** Patches that were rejected with reasons */
  rejected: Array<{ patch: StatePatch; reason: string }>;
  /** Audit entries for all operations */
  audit: AuditLogEntry[];
}

// ============================================
// APPLY PATCHES
// ============================================

export interface HookState {
  workQueue: WorkItem[];
  context: ContextWindow;
  realignCount: number;
  terminationReason: TerminationReason | null;
  metadata: Map<string, unknown>;
  auditLog: AuditLogEntry[];
}

/**
 * Apply a batch of patches to state.
 * This is the ONLY place state is mutated.
 */
export function applyPatches(
  state: HookState,
  patches: StatePatch[],
  source: string = 'unknown'
): ApplyResult {
  const applied: StatePatch[] = [];
  const rejected: Array<{ patch: StatePatch; reason: string }> = [];
  const audit: AuditLogEntry[] = [];

  for (const patch of patches) {
    const validation = validatePatch(patch);
    if (!validation.valid) {
      rejected.push({ patch, reason: validation.error! });
      audit.push(createAuditEntry(source, `patch_rejected:${patch.op}`, { error: validation.error }));
      continue;
    }

    try {
      applyPatch(state, patch);
      applied.push(patch);
      audit.push(createAuditEntry(source, `patch_applied:${patch.op}`, summarizePatch(patch)));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      rejected.push({ patch, reason: error });
      audit.push(createAuditEntry(source, `patch_error:${patch.op}`, { error }));
    }
  }

  return { state, applied, rejected, audit };
}

/**
 * Apply a single patch to state (mutates in place).
 */
function applyPatch(state: HookState, patch: StatePatch): void {
  switch (patch.op) {
    case 'enqueue_work': {
      const newItems = patch.items.map(spec => createWorkItem({
        goal: spec.goal,
        objective: spec.objective,
        agent: spec.agent,
        domain: spec.domain,
        dependencies: spec.dependencies,
        targetPaths: spec.targetPaths,
        bounds: spec.bounds,
      }));
      if (patch.position === 'front') {
        state.workQueue.unshift(...newItems);
      } else {
        state.workQueue.push(...newItems);
      }
      break;
    }

    case 'cancel_work': {
      const cancelSet = new Set(patch.workIds);
      state.workQueue = state.workQueue.filter(w => !cancelSet.has(w.workId));
      break;
    }

    case 'inject_message': {
      state.context.addMessage(patch.role, patch.content);
      break;
    }

    case 'inject_guidance': {
      state.context.addMessage('system', patch.content);
      break;
    }

    case 'reset_counter': {
      const counter = patch.counter;
      switch (counter) {
        case 'realign':
          state.realignCount = 0;
          break;
        case 'iteration':
          state.metadata.set('iterationCount', 0);
          break;
        case 'tool_calls':
          state.metadata.set('toolCallCount', 0);
          break;
        default:
          assertNever(counter);
      }
      break;
    }

    case 'increment_counter': {
      const counter = patch.counter;
      switch (counter) {
        case 'realign':
          state.realignCount++;
          break;
        default:
          assertNever(counter);
      }
      break;
    }

    case 'set_termination': {
      state.terminationReason = patch.reason;
      break;
    }

    case 'clear_termination': {
      state.terminationReason = null;
      break;
    }

    case 'force_continue': {
      state.terminationReason = null;
      break;
    }

    case 'set_metadata': {
      state.metadata.set(patch.key, patch.value);
      break;
    }

    case 'append_audit_log': {
      state.auditLog.push(patch.entry);
      break;
    }

    default: {
      assertNever(patch);
    }
  }
}

// ============================================
// HELPERS
// ============================================

/**
 * Create an audit log entry.
 */
function createAuditEntry(
  source: string,
  event: string,
  details: Record<string, unknown>
): AuditLogEntry {
  return {
    timestamp: Date.now(),
    source,
    event,
    details,
  };
}

/**
 * Summarize a patch for audit logging (avoid logging full content).
 */
function summarizePatch(patch: StatePatch): Record<string, unknown> {
  switch (patch.op) {
    case 'enqueue_work':
      return { itemCount: patch.items.length, position: patch.position };
    case 'cancel_work':
      return { workIdCount: patch.workIds.length, reason: patch.reason };
    case 'inject_message':
      return { role: patch.role, contentLength: patch.content.length };
    case 'inject_guidance':
      return { contentLength: patch.content.length };
    case 'reset_counter':
    case 'increment_counter':
      return { counter: patch.counter };
    case 'set_termination':
      return { reason: patch.reason };
    case 'clear_termination':
    case 'force_continue':
      return {};
    case 'set_metadata':
      return { key: patch.key };
    case 'append_audit_log':
      return { entryEvent: patch.entry.event };
    default:
      return assertNever(patch);
  }
}
