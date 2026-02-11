/**
 * State Patches - Discriminated Union
 *
 * All state modifications are expressed as patches.
 * Hooks return patches; the orchestrator (single writer) applies them.
 */

import type { WorkItemSpec, AuditLogEntry } from '../domain/state.js';
import type { TerminationReason } from '../domain/termination.js';
import { assertNever } from '../assertNever.js';

// ============================================
// STATE PATCH UNION
// ============================================

/**
 * A single state modification request.
 * Hooks return patches; the orchestrator (single writer) applies them.
 */
export type StatePatch =
  // Work queue operations
  | EnqueueWorkPatch
  | CancelWorkPatch

  // Context operations
  | InjectMessagePatch
  | InjectGuidancePatch

  // Counter operations
  | ResetCounterPatch
  | IncrementCounterPatch

  // Termination operations
  | SetTerminationPatch
  | ClearTerminationPatch
  | ForceContinuePatch

  // Metadata operations
  | SetMetadataPatch
  | AppendAuditLogPatch;

// ============================================
// PATCH DEFINITIONS
// ============================================

/**
 * Add work items to the queue.
 */
export interface EnqueueWorkPatch {
  op: 'enqueue_work';
  items: WorkItemSpec[];
  position?: 'front' | 'back';
}

/**
 * Cancel work items by ID.
 */
export interface CancelWorkPatch {
  op: 'cancel_work';
  workIds: string[];
  reason: string;
}

/**
 * Inject a message into the context window.
 */
export interface InjectMessagePatch {
  op: 'inject_message';
  role: 'system' | 'user';
  content: string;
}

/**
 * Inject guidance (system message) into the context.
 */
export interface InjectGuidancePatch {
  op: 'inject_guidance';
  content: string;
}

/**
 * Reset a counter to zero.
 */
export interface ResetCounterPatch {
  op: 'reset_counter';
  counter: 'realign' | 'iteration' | 'tool_calls';
}

/**
 * Increment a counter.
 */
export interface IncrementCounterPatch {
  op: 'increment_counter';
  counter: 'realign';
}

/**
 * Set the termination reason.
 */
export interface SetTerminationPatch {
  op: 'set_termination';
  reason: TerminationReason;
}

/**
 * Clear the termination reason.
 */
export interface ClearTerminationPatch {
  op: 'clear_termination';
}

/**
 * Force continuation (clear termination and continue).
 */
export interface ForceContinuePatch {
  op: 'force_continue';
}

/**
 * Set a metadata key.
 */
export interface SetMetadataPatch {
  op: 'set_metadata';
  key: string;
  value: unknown;
}

/**
 * Append an entry to the audit log.
 */
export interface AppendAuditLogPatch {
  op: 'append_audit_log';
  entry: AuditLogEntry;
}

// ============================================
// PATCH VALIDATION
// ============================================

/**
 * Validation result.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a patch is well-formed.
 */
export function validatePatch(patch: StatePatch): ValidationResult {
  switch (patch.op) {
    case 'enqueue_work':
      if (!patch.items.length) {
        return { valid: false, error: 'enqueue_work requires at least one item' };
      }
      for (const item of patch.items) {
        if (!item.goal?.trim()) {
          return { valid: false, error: 'enqueue_work item missing goal' };
        }
        if (!item.objective?.trim()) {
          return { valid: false, error: 'enqueue_work item missing objective' };
        }
        if (!item.agent?.trim()) {
          return { valid: false, error: 'enqueue_work item missing agent' };
        }
      }
      return { valid: true };

    case 'cancel_work':
      if (!patch.workIds.length) {
        return { valid: false, error: 'cancel_work requires at least one workId' };
      }
      if (!patch.reason?.trim()) {
        return { valid: false, error: 'cancel_work requires a reason' };
      }
      return { valid: true };

    case 'inject_message':
      if (!patch.content?.trim()) {
        return { valid: false, error: 'inject_message requires non-empty content' };
      }
      if (patch.role !== 'system' && patch.role !== 'user') {
        return { valid: false, error: 'inject_message role must be system or user' };
      }
      return { valid: true };

    case 'inject_guidance':
      if (!patch.content?.trim()) {
        return { valid: false, error: 'inject_guidance requires non-empty content' };
      }
      return { valid: true };

    case 'reset_counter':
      // Counter type is validated by TypeScript at compile time
      return { valid: true };

    case 'increment_counter':
      // Counter type is validated by TypeScript at compile time
      return { valid: true };

    case 'set_termination':
      if (!patch.reason) {
        return { valid: false, error: 'set_termination requires a reason' };
      }
      return { valid: true };

    case 'clear_termination':
    case 'force_continue':
      return { valid: true };

    case 'set_metadata':
      if (!patch.key?.trim()) {
        return { valid: false, error: 'set_metadata requires a key' };
      }
      return { valid: true };

    case 'append_audit_log':
      if (!patch.entry) {
        return { valid: false, error: 'append_audit_log requires an entry' };
      }
      if (!patch.entry.event) {
        return { valid: false, error: 'audit log entry missing event' };
      }
      return { valid: true };

    default:
      return assertNever(patch);
  }
}

/**
 * Validate a batch of patches.
 */
export function validatePatches(patches: StatePatch[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (let i = 0; i < patches.length; i++) {
    const result = validatePatch(patches[i]);
    if (!result.valid) {
      errors.push(`Patch ${i}: ${result.error}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// ============================================
// PATCH FACTORIES
// ============================================

/**
 * Create an enqueue_work patch.
 */
export function enqueueWork(items: WorkItemSpec[], position: 'front' | 'back' = 'back'): EnqueueWorkPatch {
  return { op: 'enqueue_work', items, position };
}

/**
 * Create a cancel_work patch.
 */
export function cancelWork(workIds: string[], reason: string): CancelWorkPatch {
  return { op: 'cancel_work', workIds, reason };
}

/**
 * Create an inject_message patch.
 */
export function injectMessage(role: 'system' | 'user', content: string): InjectMessagePatch {
  return { op: 'inject_message', role, content };
}

/**
 * Create an inject_guidance patch.
 */
export function injectGuidance(content: string): InjectGuidancePatch {
  return { op: 'inject_guidance', content };
}

/**
 * Create a reset_counter patch.
 */
export function resetCounter(counter: 'realign' | 'iteration' | 'tool_calls'): ResetCounterPatch {
  return { op: 'reset_counter', counter };
}

/**
 * Create an increment_counter patch.
 */
export function incrementCounter(counter: 'realign'): IncrementCounterPatch {
  return { op: 'increment_counter', counter };
}

/**
 * Create a set_termination patch.
 */
export function setTermination(reason: TerminationReason): SetTerminationPatch {
  return { op: 'set_termination', reason };
}

/**
 * Create a clear_termination patch.
 */
export function clearTermination(): ClearTerminationPatch {
  return { op: 'clear_termination' };
}

/**
 * Create a force_continue patch.
 */
export function forceContinue(): ForceContinuePatch {
  return { op: 'force_continue' };
}

/**
 * Create a set_metadata patch.
 */
export function setMetadata(key: string, value: unknown): SetMetadataPatch {
  return { op: 'set_metadata', key, value };
}

/**
 * Create an append_audit_log patch.
 */
export function appendAuditLog(entry: AuditLogEntry): AppendAuditLogPatch {
  return { op: 'append_audit_log', entry };
}
