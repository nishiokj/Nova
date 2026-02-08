/**
 * Canonical watcher trigger/action contract shared across packages.
 * Keep all watcher enums and trigger-action constraints here to prevent drift.
 */

export const WATCHER_TRIGGER_VALUES = [
  'session_init',
  'prompt_user',
  'bounds_exceeded',
  'agent_error',
  'goal_state_reached',
  'work_item_completed',
  'scope_collision',
  'cadence_audit',
  'handoff_approval',
] as const;

export type WatcherTrigger = (typeof WATCHER_TRIGGER_VALUES)[number];

export const WATCHER_ACTION_VALUES = [
  'answer',
  'realign',
  'split',
  'create_work_item',
  'stop_work_item',
  'quality_gate',
  'allow',
  'continue',
] as const;

export type WatcherActionType = (typeof WATCHER_ACTION_VALUES)[number];

export const WATCHER_NO_INTERVENTION_ACTION_VALUES = [
  'allow',
  'continue',
] as const;

export type WatcherNoInterventionAction = (typeof WATCHER_NO_INTERVENTION_ACTION_VALUES)[number];

export const VALID_WATCHER_ACTIONS_BY_TRIGGER = {
  prompt_user: ['answer'],
  bounds_exceeded: ['realign', 'split', 'create_work_item'],
  agent_error: ['realign', 'allow'],
  goal_state_reached: ['quality_gate', 'split', 'create_work_item'],
  work_item_completed: ['quality_gate', 'split', 'create_work_item'],
  cadence_audit: ['allow', 'realign', 'split', 'create_work_item', 'stop_work_item'],
  session_init: [],
  scope_collision: ['allow', 'realign'],
  handoff_approval: ['allow', 'realign'],
} as const satisfies Record<WatcherTrigger, readonly WatcherActionType[]>;

const WATCHER_ACTION_SET = new Set<string>(WATCHER_ACTION_VALUES);
const WATCHER_TRIGGER_SET = new Set<string>(WATCHER_TRIGGER_VALUES);

export function isWatcherActionType(value: string): value is WatcherActionType {
  return WATCHER_ACTION_SET.has(value);
}

export function isWatcherTrigger(value: string): value is WatcherTrigger {
  return WATCHER_TRIGGER_SET.has(value);
}

export function getValidWatcherActions(trigger: WatcherTrigger): readonly WatcherActionType[] {
  return VALID_WATCHER_ACTIONS_BY_TRIGGER[trigger];
}
