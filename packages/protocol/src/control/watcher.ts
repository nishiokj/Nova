/**
 * Watcher trigger/action contract and prompt-protocol controls.
 *
 * The canonical enum literals live in `shared/watcher_contract` so every
 * watcher schema/parser in the stack consumes the same values.
 */

import { controlField } from 'prompt-protocol';
import {
  WATCHER_TRIGGER_VALUES,
  WATCHER_ACTION_VALUES,
  WATCHER_NO_INTERVENTION_ACTION_VALUES,
  VALID_WATCHER_ACTIONS_BY_TRIGGER,
  isWatcherActionType,
  isWatcherTrigger,
  type WatcherTrigger,
  type WatcherActionType,
  type WatcherNoInterventionAction,
} from 'shared';

export type {
  WatcherTrigger,
  WatcherActionType,
  WatcherNoInterventionAction,
};

export {
  WATCHER_TRIGGER_VALUES,
  WATCHER_ACTION_VALUES,
  WATCHER_NO_INTERVENTION_ACTION_VALUES,
  isWatcherActionType,
  isWatcherTrigger,
};

/**
 * Valid watcher action types for each trigger.
 */
export const VALID_ACTIONS_BY_TRIGGER = VALID_WATCHER_ACTIONS_BY_TRIGGER;

/**
 * Get valid watcher actions for a specific trigger.
 */
export function getValidActions(trigger: WatcherTrigger): readonly WatcherActionType[] {
  return VALID_ACTIONS_BY_TRIGGER[trigger];
}

/**
 * Prompt-protocol control fields for watcher prompts/outputs.
 */
export const WATCHER_TRIGGER_CONTROL = controlField('trigger', WATCHER_TRIGGER_VALUES);
export const WATCHER_ACTION_CONTROL = controlField('watcherAction', WATCHER_ACTION_VALUES);
export const WATCHER_NO_INTERVENTION_CONTROL = controlField(
  'watcherAction',
  WATCHER_NO_INTERVENTION_ACTION_VALUES
);
