import type { InternalHookContext, InternalHookEvent } from 'agent';
import type { Effect } from 'effect';
import type {
  DecisionFor,
  EventFor,
  HookContext,
  HookCriticality,
  HookIdempotency,
  HookOutcome,
  HookPolicy,
} from '../control-plane/index.js';
import type { ToolResult } from 'types';
import type {
  DecisionEventType,
  EffectEventType,
  HookMode,
  HookScope,
  LifecycleEffectEventType,
  UnifiedEventType,
} from './catalog.js';

// ============================================
// EFFECT EVENT PAYLOADS
// ============================================

export interface PreToolUseEffectPayload {
  type: 'pre_tool_use';
  toolName: string;
  args: Record<string, unknown>;
}

export interface PostToolUseEffectPayload {
  type: 'post_tool_use';
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
}

export interface PostGitCommitEffectPayload {
  type: 'post_git_commit';
  sha: string;
  command: string;
  message?: string;
  branch?: string;
}

export interface UserPromptQuestion {
  question: string;
  options?: (string | { label: string; description?: string })[];
  context?: string;
  multiSelect?: boolean;
  questionType?: 'multiple_choice' | 'multi_select' | 'fill_in_blank' | 'yes_no' | 'free_text';
}

export interface UserPromptSubmitEffectPayload {
  type: 'user_prompt_submit';
  workItemId: string;
  prompt: {
    question?: string;
    options?: (string | { label: string; description?: string })[];
    context?: string;
    multiSelect?: boolean;
    questionType?: 'multiple_choice' | 'multi_select' | 'fill_in_blank' | 'yes_no' | 'free_text';
    questions?: UserPromptQuestion[];
  };
}

export interface SessionStartEffectPayload {
  type: 'session_start';
  sessionKey: string;
  workingDir: string;
}

export interface SessionStopEffectPayload {
  type: 'session_stop';
  sessionKey: string;
  reason?: string;
}

export interface NotificationEffectPayload {
  type: 'notification';
  level: 'info' | 'warning' | 'error';
  title: string;
  message: string;
  data?: Record<string, unknown>;
}

export type LifecycleEffectPayload =
  | PreToolUseEffectPayload
  | PostToolUseEffectPayload
  | PostGitCommitEffectPayload
  | UserPromptSubmitEffectPayload
  | SessionStartEffectPayload
  | SessionStopEffectPayload
  | NotificationEffectPayload;

interface LifecycleEffectPayloadMap {
  pre_tool_use: PreToolUseEffectPayload;
  post_tool_use: PostToolUseEffectPayload;
  post_git_commit: PostGitCommitEffectPayload;
  user_prompt_submit: UserPromptSubmitEffectPayload;
  session_start: SessionStartEffectPayload;
  session_stop: SessionStopEffectPayload;
  notification: NotificationEffectPayload;
}

type InternalEffectPayloadMap = {
  [E in InternalHookEvent['type']]: Extract<InternalHookEvent, { type: E }>;
};

type DecisionPayloadMap = {
  [E in DecisionEventType]: EventFor<E>;
};

type EffectPayloadMap = InternalEffectPayloadMap & LifecycleEffectPayloadMap;

export type UnifiedEventPayload<E extends UnifiedEventType> =
  E extends DecisionEventType
    ? DecisionPayloadMap[E]
    : E extends EffectEventType
      ? EffectPayloadMap[E]
      : never;

export type EffectPayloadFor<E extends EffectEventType> = EffectPayloadMap[E];

// ============================================
// EFFECT OUTCOMES
// ============================================

export interface EffectAllowOutcome {
  kind: 'allow';
  message?: string;
}

export interface EffectSkipOutcome {
  kind: 'skip';
  reason: string;
}

export interface EffectBlockOutcome {
  kind: 'block';
  reason: string;
}

export interface EffectModifyOutcome<T> {
  kind: 'modify';
  value: T;
  reason?: string;
}

export type ObserveEffectOutcome = EffectAllowOutcome | EffectSkipOutcome;
export type MutatingEffectOutcome<T> = ObserveEffectOutcome | EffectModifyOutcome<T>;
export type GateEffectOutcome<T> = MutatingEffectOutcome<T> | EffectBlockOutcome;

export type EffectOutcomeFor<E extends EffectEventType> =
  E extends 'pre_tool_use'
    ? GateEffectOutcome<Record<string, unknown>>
    : E extends 'post_tool_use'
      ? MutatingEffectOutcome<ToolResult>
      : E extends 'user_prompt_submit'
        ? GateEffectOutcome<UserPromptSubmitEffectPayload['prompt']>
        : ObserveEffectOutcome;

// ============================================
// REGISTRATION CONTRACTS
// ============================================

export interface UnifiedHookBase<E extends UnifiedEventType, M extends HookMode> {
  id: string;
  event: E;
  mode: M;
  scope: HookScope;
  source: string;
  priority: number;
  timeoutMs: number;
  description?: string;
}

export interface UnifiedDecisionHookRegistration<E extends DecisionEventType>
  extends UnifiedHookBase<E, 'decision'> {
  policy: HookPolicy;
  criticality: HookCriticality;
  idempotency: HookIdempotency;
  callback: (
    payload: EventFor<E>,
    context: Readonly<HookContext>
  ) => Effect.Effect<HookOutcome<DecisionFor<E>>, unknown>;
}

export interface UnifiedEffectContext {
  sessionKey: string;
  requestId: string;
  workId?: string;
  agentType?: string;
  workingDir?: string;
  internal?: InternalHookContext;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface UnifiedEffectHookRegistration<E extends EffectEventType>
  extends UnifiedHookBase<E, 'effect'> {
  policy?: HookPolicy;
  callback: (
    payload: EffectPayloadFor<E>,
    context: Readonly<UnifiedEffectContext>
  ) => Effect.Effect<EffectOutcomeFor<E>, unknown>;
}

export type UnifiedHookRegistration =
  | UnifiedDecisionHookRegistration<DecisionEventType>
  | UnifiedEffectHookRegistration<EffectEventType>;

export type RegisteredUnifiedHook<T = UnifiedHookRegistration> = T & {
  registeredAt: number;
  registrationIndex: number;
};

export function isDecisionHookRegistration(
  hook: UnifiedHookRegistration
): hook is UnifiedDecisionHookRegistration<DecisionEventType> {
  return hook.mode === 'decision';
}

export function isEffectHookRegistration(
  hook: UnifiedHookRegistration
): hook is UnifiedEffectHookRegistration<EffectEventType> {
  return hook.mode === 'effect';
}

export function isLifecycleEffectEventType(event: EffectEventType): event is LifecycleEffectEventType {
  return (
    event === 'pre_tool_use'
    || event === 'post_tool_use'
    || event === 'post_git_commit'
    || event === 'user_prompt_submit'
    || event === 'session_start'
    || event === 'session_stop'
    || event === 'notification'
  );
}
