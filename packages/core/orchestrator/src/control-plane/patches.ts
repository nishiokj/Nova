import type { TerminationReason } from 'types';
import { assertNever } from 'types';
import type { AuditLogEntry, WorkItemSpec } from './state.js';

export type StatePatch =
  | EnqueueWorkPatch
  | CancelWorkPatch
  | InjectMessagePatch
  | InjectGuidancePatch
  | ResetCounterPatch
  | IncrementCounterPatch
  | SetTerminationPatch
  | ClearTerminationPatch
  | ForceContinuePatch
  | SetMetadataPatch
  | AppendAuditLogPatch;

export interface EnqueueWorkPatch {
  op: 'enqueue_work';
  items: WorkItemSpec[];
  position?: 'front' | 'back';
}

export type CancellationScope = 'queued' | 'in_progress' | 'all';

export interface CancellationTarget {
  scope: CancellationScope;
  reason: string;
}

export interface CancelWorkPatch {
  op: 'cancel_work';
  workIds: string[];
  cancellation: CancellationTarget;
}

export interface InjectMessagePatch {
  op: 'inject_message';
  role: 'system' | 'user';
  content: string;
}

export interface InjectGuidancePatch {
  op: 'inject_guidance';
  content: string;
}

export interface ResetCounterPatch {
  op: 'reset_counter';
  counter: 'realign' | 'iteration' | 'tool_calls';
}

export interface IncrementCounterPatch {
  op: 'increment_counter';
  counter: 'realign';
}

export interface SetTerminationPatch {
  op: 'set_termination';
  reason: TerminationReason;
}

export interface ClearTerminationPatch {
  op: 'clear_termination';
}

export interface ForceContinuePatch {
  op: 'force_continue';
}

export interface SetMetadataPatch {
  op: 'set_metadata';
  key: string;
  value: unknown;
}

export interface AppendAuditLogPatch {
  op: 'append_audit_log';
  entry: AuditLogEntry;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

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
      if (patch.workIds.some((workId) => !workId?.trim())) {
        return { valid: false, error: 'cancel_work workIds must be non-empty strings' };
      }
      if (!patch.cancellation.reason?.trim()) {
        return { valid: false, error: 'cancel_work requires a reason' };
      }
      if (
        patch.cancellation.scope !== 'queued' &&
        patch.cancellation.scope !== 'in_progress' &&
        patch.cancellation.scope !== 'all'
      ) {
        return { valid: false, error: 'cancel_work scope must be queued, in_progress, or all' };
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
    case 'increment_counter':
    case 'clear_termination':
    case 'force_continue':
      return { valid: true };

    case 'set_termination':
      if (!patch.reason) {
        return { valid: false, error: 'set_termination requires a reason' };
      }
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

export function enqueueWork(items: WorkItemSpec[], position: 'front' | 'back' = 'back'): EnqueueWorkPatch {
  return { op: 'enqueue_work', items, position };
}

export function cancelWork(
  workIds: string[],
  reason: string,
  scope: CancellationScope = 'all'
): CancelWorkPatch {
  return {
    op: 'cancel_work',
    workIds,
    cancellation: {
      scope,
      reason,
    },
  };
}

export function injectMessage(role: 'system' | 'user', content: string): InjectMessagePatch {
  return { op: 'inject_message', role, content };
}

export function injectGuidance(content: string): InjectGuidancePatch {
  return { op: 'inject_guidance', content };
}

export function resetCounter(counter: 'realign' | 'iteration' | 'tool_calls'): ResetCounterPatch {
  return { op: 'reset_counter', counter };
}

export function incrementCounter(counter: 'realign'): IncrementCounterPatch {
  return { op: 'increment_counter', counter };
}

export function setTermination(reason: TerminationReason): SetTerminationPatch {
  return { op: 'set_termination', reason };
}

export function clearTermination(): ClearTerminationPatch {
  return { op: 'clear_termination' };
}

export function forceContinue(): ForceContinuePatch {
  return { op: 'force_continue' };
}

export function setMetadata(key: string, value: unknown): SetMetadataPatch {
  return { op: 'set_metadata', key, value };
}

export function appendAuditLog(entry: AuditLogEntry): AppendAuditLogPatch {
  return { op: 'append_audit_log', entry };
}
