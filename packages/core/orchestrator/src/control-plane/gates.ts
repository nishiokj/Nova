import type { ControlEvent, ControlEventType } from './events.js';
import type {
  QualityGateDecision,
  BoundsDecision,
  PromptAnswerDecision,
  CadenceDecision,
  AgentErrorDecision,
  WorkItemCompletedDecision,
} from './decisions.js';
import type { Hook } from './hook-types.js';
import { assertNever } from 'types';

export interface EventDecisionMap {
  goal_state_reached: QualityGateDecision;
  bounds_exceeded: BoundsDecision;
  user_input_required: PromptAnswerDecision;
  cadence_audit: CadenceDecision;
  agent_error: AgentErrorDecision;
  work_item_completed: WorkItemCompletedDecision;
  user_stopped: never;
  transient_error: never;
}

export type DecisionFor<E extends ControlEventType> = EventDecisionMap[E];

export type EventFor<E extends ControlEventType> = {
  [K in ControlEventType]: Extract<ControlEvent, { type: K }>;
}[E];

export function createHook<E extends keyof EventDecisionMap>(
  event: E,
  config: Omit<Hook<EventFor<E>, EventDecisionMap[E]>, 'event'>
): Hook<EventFor<E>, EventDecisionMap[E]> {
  return { ...config, event } as Hook<EventFor<E>, EventDecisionMap[E]>;
}

export type PassThroughEvent = Extract<ControlEventType, 'user_stopped' | 'transient_error'>;
export type DecisionRequiredEvent = Exclude<ControlEventType, PassThroughEvent>;

export function requiresDecision(eventType: ControlEventType): eventType is DecisionRequiredEvent {
  switch (eventType) {
    case 'goal_state_reached':
    case 'bounds_exceeded':
    case 'user_input_required':
    case 'cadence_audit':
    case 'agent_error':
    case 'work_item_completed':
      return true;
    case 'user_stopped':
    case 'transient_error':
      return false;
    default:
      return assertNever(eventType);
  }
}
