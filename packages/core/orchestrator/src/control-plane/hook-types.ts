import type { ControlEvent, ExecutionMetrics } from './events.js';
import type { Message } from './state.js';
import type { HookOutcome } from './hook-outcome.js';
import type { HookPolicy } from './hook-policy.js';

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

export type HookContext = StateView;

export type HookIdempotency = 'idempotent' | 'non_idempotent' | 'unknown';
export type HookCriticality = 'critical' | 'non_critical';

export interface Hook<Evt extends ControlEvent, D> {
  id: string;
  event: Evt['type'];
  policy: HookPolicy;
  criticality: HookCriticality;
  idempotency: HookIdempotency;
  priority: number;
  timeoutMs: number;
  description?: string;
  run: (evt: Evt, ctx: Readonly<HookContext>) => Promise<HookOutcome<D>>;
}
