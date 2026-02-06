/**
 * Event → Decision Mapping
 *
 * Maps event types to their decision types.
 * Used for type-safe hook registration.
 */

import type { ControlEvent, ControlEventType } from '../domain/events.js';
import type {
  QualityGateDecision,
  BoundsDecision,
  PromptAnswerDecision,
  CadenceDecision,
  AgentErrorDecision,
  HandoffDecision,
  WorkItemCompletedDecision,
} from './decisions.js';
import type {
  QualityGateDecisionSchemaType,
  BoundsDecisionSchemaType,
  PromptAnswerDecisionSchemaType,
  CadenceDecisionSchemaType,
  AgentErrorDecisionSchemaType,
  HandoffDecisionSchemaType,
  WorkItemCompletedDecisionSchemaType,
} from '../protocol/schemas.js';
import type { Hook } from '../hooks/types.js';
import { assertNever } from '../assertNever.js';
import { controlField, type ControlField } from 'prompt-protocol';

// ============================================
// EVENT → DECISION TYPE MAP
// ============================================

/**
 * Maps event types to their decision types.
 * Used for type-safe hook registration.
 */
export interface EventDecisionMap {
  'goal_state_reached': QualityGateDecision;
  'bounds_exceeded': BoundsDecision;
  'user_input_required': PromptAnswerDecision;
  'cadence_audit': CadenceDecision;
  'agent_error': AgentErrorDecision;
  'handoff_requested': HandoffDecision;
  'work_item_completed': WorkItemCompletedDecision;
  'user_stopped': never;  // No decision, always allow
  'transient_error': never;  // No decision, always allow
  'escalation_resolved': never;  // No decision - this IS the resolution from human
}

/**
 * Extract the decision type for a given event type.
 */
export type DecisionFor<E extends ControlEventType> = EventDecisionMap[E];

/**
 * Extract the event for a given event type.
 */
export type EventFor<E extends ControlEventType> = {
  [K in ControlEventType]: Extract<ControlEvent, { type: K }>;
}[E];

// ============================================
// TYPE-SAFE HOOK CREATION
// ============================================

/**
 * Type-safe hook creation that ensures decision type matches event type.
 */
export function createHook<E extends keyof EventDecisionMap>(
  event: E,
  config: Omit<Hook<EventFor<E>, EventDecisionMap[E]>, 'event'>
): Hook<EventFor<E>, EventDecisionMap[E]> {
  return { ...config, event } as Hook<EventFor<E>, EventDecisionMap[E]>;
}

// ============================================
// DECISION REQUIREMENTS
// ============================================

/**
 * Events that don't require a decision (pass through).
 */
export type PassThroughEvent = Extract<ControlEventType, 'user_stopped' | 'transient_error' | 'escalation_resolved'>;

/**
 * Events that require a decision (have hooks).
 */
export type DecisionRequiredEvent = Exclude<ControlEventType, PassThroughEvent>;

/**
 * Check if an event type requires a decision.
 */
export function requiresDecision(eventType: ControlEventType): eventType is DecisionRequiredEvent {
  switch (eventType) {
    case 'goal_state_reached':
    case 'bounds_exceeded':
    case 'user_input_required':
    case 'cadence_audit':
    case 'agent_error':
    case 'handoff_requested':
    case 'work_item_completed':
      return true;
    case 'user_stopped':
    case 'transient_error':
    case 'escalation_resolved':
      return false;
    default:
      return assertNever(eventType);
  }
}

// ============================================
// VALID ACTIONS BY EVENT
// ============================================

/**
 * Valid decision actions for each event type.
 * Prevents invalid decisions from being created.
 */
export type DecisionActionByEvent = {
  goal_state_reached: QualityGateDecisionSchemaType['verdict'];
  bounds_exceeded: BoundsDecisionSchemaType['action'];
  user_input_required: PromptAnswerDecisionSchemaType['action'];
  cadence_audit: CadenceDecisionSchemaType['action'];
  agent_error: AgentErrorDecisionSchemaType['action'];
  handoff_requested: HandoffDecisionSchemaType['action'];
  work_item_completed: WorkItemCompletedDecisionSchemaType['action'];
};

export const VALID_DECISIONS_BY_EVENT = {
  'goal_state_reached': ['passed', 'failed', 'needs_human'],
  'bounds_exceeded': ['realign', 'split', 'wrap_up', 'abort'],
  'user_input_required': ['answer', 'escalate', 'defer'],
  'cadence_audit': ['continue', 'inject_guidance', 'realign', 'split', 'stop', 'stop_work_item'],
  'agent_error': ['retry', 'abort', 'escalate'],
  'handoff_requested': ['approve', 'reject', 'modify'],
  'work_item_completed': ['accept', 'retry', 'split', 'escalate'],
} as const satisfies {
  [E in keyof DecisionActionByEvent]: readonly DecisionActionByEvent[E][];
};

// ============================================
// PROMPT-PROTOCOL CONTROLS
// ============================================

/**
 * Control fields used by decision prompts.
 */
export const DECISION_CONTROL_BY_EVENT = {
  'goal_state_reached': controlField('verdict', VALID_DECISIONS_BY_EVENT.goal_state_reached),
  'bounds_exceeded': controlField('action', VALID_DECISIONS_BY_EVENT.bounds_exceeded),
  'user_input_required': controlField('action', VALID_DECISIONS_BY_EVENT.user_input_required),
  'cadence_audit': controlField('action', VALID_DECISIONS_BY_EVENT.cadence_audit),
  'agent_error': controlField('action', VALID_DECISIONS_BY_EVENT.agent_error),
  'handoff_requested': controlField('action', VALID_DECISIONS_BY_EVENT.handoff_requested),
  'work_item_completed': controlField('action', VALID_DECISIONS_BY_EVENT.work_item_completed),
} as const satisfies Record<DecisionRequiredEvent, ControlField<'action' | 'verdict', readonly string[]>>;

/**
 * Extract the control field for a decision-required event.
 */
export type DecisionControlFor<E extends DecisionRequiredEvent> = (typeof DECISION_CONTROL_BY_EVENT)[E];

/**
 * Get valid decision actions for an event type.
 */

export function getValidDecisions<E extends DecisionRequiredEvent>(
  eventType: E
): (typeof VALID_DECISIONS_BY_EVENT)[E] {
  return VALID_DECISIONS_BY_EVENT[eventType];
}

export function isValidDecision<E extends DecisionRequiredEvent>(
  eventType: E,
  action: string
): action is DecisionActionByEvent[E] {
  return (VALID_DECISIONS_BY_EVENT[eventType] as readonly string[]).includes(action);
}
