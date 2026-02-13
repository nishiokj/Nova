import type { InternalHookEvent } from 'agent';
import { ALL_EVENT_TYPES, type ControlEventType } from 'protocol';

export type HookMode = 'decision' | 'effect';
export type HookScope = 'orchestrator' | 'agent' | 'harness';

export const LIFECYCLE_EFFECT_EVENT_TYPES = [
  'pre_tool_use',
  'post_tool_use',
  'post_git_commit',
  'user_prompt_submit',
  'session_start',
  'session_stop',
  'notification',
] as const;

export const BLOCKABLE_EFFECT_EVENT_TYPES = [
  'pre_tool_use',
  'user_prompt_submit',
] as const;

export type LifecycleEffectEventType = typeof LIFECYCLE_EFFECT_EVENT_TYPES[number];
export type BlockableEffectEventType = typeof BLOCKABLE_EFFECT_EVENT_TYPES[number];
export type InternalEffectEventType = InternalHookEvent['type'];
export type DecisionEventType = ControlEventType;
export type EffectEventType = InternalEffectEventType | LifecycleEffectEventType;
export type UnifiedEventType = DecisionEventType | EffectEventType;

export interface UnifiedHookCatalogEntry {
  mode: HookMode;
  event: UnifiedEventType;
  allowedScopes: readonly HookScope[];
  stateControl: boolean;
  description: string;
}

const decisionCatalog = ALL_EVENT_TYPES.map((event) => ({
  mode: 'decision',
  event,
  allowedScopes: ['orchestrator'] as const,
  stateControl: true,
  description: 'Control-plane decision event. Hooks may return decisions and state patches.',
})) as readonly UnifiedHookCatalogEntry[];

const effectCatalog: readonly UnifiedHookCatalogEntry[] = [
  {
    mode: 'effect',
    event: 'workitem_created',
    allowedScopes: ['orchestrator', 'harness'],
    stateControl: false,
    description: 'Best-effort side-effect event fired when work is enqueued.',
  },
  {
    mode: 'effect',
    event: 'turn_completed',
    allowedScopes: ['orchestrator', 'harness'],
    stateControl: false,
    description: 'Side-effect event fired after an agent turn is finalized.',
  },
  {
    mode: 'effect',
    event: 'tool_batch_completed',
    allowedScopes: ['orchestrator', 'harness'],
    stateControl: false,
    description: 'Side-effect event fired after a batch of tool calls.',
  },
  {
    mode: 'effect',
    event: 'context_threshold',
    allowedScopes: ['orchestrator', 'harness'],
    stateControl: false,
    description: 'Side-effect event fired when context usage crosses a threshold.',
  },
  {
    mode: 'effect',
    event: 'artifacts_discovered',
    allowedScopes: ['orchestrator', 'harness'],
    stateControl: false,
    description: 'Side-effect event with discovered artifact metadata.',
  },
  {
    mode: 'effect',
    event: 'files_modified',
    allowedScopes: ['agent', 'harness'],
    stateControl: false,
    description: 'Side-effect event fired when tools modify files.',
  },
  {
    mode: 'effect',
    event: 'agent_message',
    allowedScopes: ['agent', 'harness'],
    stateControl: false,
    description: 'Side-effect event carrying emitted assistant message content.',
  },
  {
    mode: 'effect',
    event: 'tool_call_completed',
    allowedScopes: ['agent', 'harness'],
    stateControl: false,
    description: 'Side-effect event fired for each completed tool call.',
  },
  {
    mode: 'effect',
    event: 'agent_completed',
    allowedScopes: ['agent', 'harness'],
    stateControl: false,
    description: 'Side-effect event fired when agent finishes work.',
  },
  {
    mode: 'effect',
    event: 'memory_injected',
    allowedScopes: ['agent', 'harness'],
    stateControl: false,
    description: 'Side-effect event fired when memory is injected.',
  },
  {
    mode: 'effect',
    event: 'git_commit',
    allowedScopes: ['agent', 'harness'],
    stateControl: false,
    description: 'Side-effect event fired when a git commit is detected.',
  },
  {
    mode: 'effect',
    event: 'escalation_raised',
    allowedScopes: ['orchestrator', 'harness'],
    stateControl: false,
    description: 'Side-effect event fired when escalation is raised.',
  },
  {
    mode: 'effect',
    event: 'observer_agent_stopped',
    allowedScopes: ['orchestrator', 'harness'],
    stateControl: false,
    description: 'Side-effect event fired when observer stops a work item.',
  },
  {
    mode: 'effect',
    event: 'pre_tool_use',
    allowedScopes: ['agent', 'harness'],
    stateControl: false,
    description: 'Lifecycle side-effect event before tool execution.',
  },
  {
    mode: 'effect',
    event: 'post_tool_use',
    allowedScopes: ['agent', 'harness'],
    stateControl: false,
    description: 'Lifecycle side-effect event after tool execution.',
  },
  {
    mode: 'effect',
    event: 'post_git_commit',
    allowedScopes: ['agent', 'harness'],
    stateControl: false,
    description: 'Lifecycle side-effect event after commit processing.',
  },
  {
    mode: 'effect',
    event: 'user_prompt_submit',
    allowedScopes: ['orchestrator', 'harness'],
    stateControl: false,
    description: 'Lifecycle side-effect event before prompt submission.',
  },
  {
    mode: 'effect',
    event: 'session_start',
    allowedScopes: ['harness'],
    stateControl: false,
    description: 'Lifecycle side-effect event when a session starts.',
  },
  {
    mode: 'effect',
    event: 'session_stop',
    allowedScopes: ['harness'],
    stateControl: false,
    description: 'Lifecycle side-effect event when a session stops.',
  },
  {
    mode: 'effect',
    event: 'notification',
    allowedScopes: ['harness'],
    stateControl: false,
    description: 'Lifecycle side-effect event for operator notifications.',
  },
];

export const UNIFIED_HOOK_CATALOG = [
  ...decisionCatalog,
  ...effectCatalog,
] as const satisfies readonly UnifiedHookCatalogEntry[];

const CATALOG_BY_EVENT = new Map(UNIFIED_HOOK_CATALOG.map((entry) => [entry.event, entry]));

export function getUnifiedHookCatalogEntry(event: UnifiedEventType): UnifiedHookCatalogEntry {
  const entry = CATALOG_BY_EVENT.get(event);
  if (!entry) {
    throw new Error(`Unknown unified hook event: ${event}`);
  }
  return entry;
}

export function isDecisionEventType(event: UnifiedEventType): event is DecisionEventType {
  return ALL_EVENT_TYPES.includes(event as ControlEventType);
}

export function isEffectEventType(event: UnifiedEventType): event is EffectEventType {
  return !isDecisionEventType(event);
}

export function isBlockableEffectEvent(event: EffectEventType): event is BlockableEffectEventType {
  return (BLOCKABLE_EFFECT_EVENT_TYPES as readonly string[]).includes(event);
}
