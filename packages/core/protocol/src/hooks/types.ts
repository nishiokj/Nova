/**
 * Hook Types - Interface Contracts
 *
 * Defines hook interfaces and context/state view types.
 */

import type { ControlEvent, ExecutionMetrics } from '../domain/events.js';
import type { Message } from '../domain/state.js';
import type { HookOutcome } from './outcome.js';
import type { HookPolicy } from './policy.js';

/**
 * Read-only snapshot of orchestrator state exposed to hooks.
 */
export interface StateView {
  readonly sessionKey: string;
  readonly workId: string;
  readonly agentType: string;
  readonly iteration: number;
  readonly metrics: Readonly<ExecutionMetrics>;
  readonly recentMessages: ReadonlyArray<Message>;
  readonly filesModified: ReadonlyArray<string>;
  readonly objective: string;
  readonly realignCount: number;
}

/**
 * Context passed to hooks (alias of StateView).
 */
export type HookContext = StateView;

/**
 * Declared idempotency for safe retries.
 */
export type HookIdempotency = 'idempotent' | 'non_idempotent' | 'unknown';

/**
 * Declared criticality for policy enforcement and observability.
 */
export type HookCriticality = 'critical' | 'non_critical';

/**
 * Hook interface definition.
 *
 * @typeParam Evt - The event type this hook handles.
 * @typeParam D - The decision type this hook produces.
 */
export interface Hook<Evt extends ControlEvent, D> {
  /** Unique identifier for this hook */
  id: string;

  /** The event type this hook handles */
  event: Evt['type'];

  /** Failure handling policy */
  policy: HookPolicy;

  /** Declared criticality (must be validated at registration time) */
  criticality: HookCriticality;

  /** Declared idempotency (must be validated at registration time) */
  idempotency: HookIdempotency;

  /** Execution priority (lower = earlier). Hooks with same priority run in parallel. */
  priority: number;

  /** Timeout for this hook in milliseconds */
  timeoutMs: number;

  /** Optional description for documentation */
  description?: string;

  /** The hook implementation */
  run: (evt: Evt, ctx: Readonly<HookContext>) => Promise<HookOutcome<D>>;
}
