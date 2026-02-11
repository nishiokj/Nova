/**
 * Hook Registry - Centralized Registration and Validation
 *
 * Orchestrator-owned registry for all hook wiring.
 */

import {
  ALL_EVENT_TYPES,
  assertNever,
  getMaxRetries,
  isCompatible,
  isCriticalPolicy,
  type ControlEvent,
  type ControlEventType,
  type Hook,
  type HookPolicy,
  type HookCriticality,
  type HookIdempotency,
} from 'protocol';

// ============================================
// TYPES
// ============================================

export interface HookRegistrationMeta {
  source: string;
  protocolId: string;
}

export interface HookBundle {
  source: string;
  protocolId: string;
  hooks: Array<Hook<ControlEvent, unknown>>;
}

export interface RegisteredHook<Evt extends ControlEvent, D> extends Hook<Evt, D> {
  source: string;
  protocolId: string;
  registeredAt: number;
}

export interface HookRegistry {
  register<Evt extends ControlEvent, D>(hook: Hook<Evt, D>, meta: HookRegistrationMeta): void;
  registerHooks(bundle: HookBundle): void;
  unregister(hookId: string): void;
  getHooks<Evt extends ControlEvent>(eventType: Evt['type']): Array<RegisteredHook<Evt, unknown>>;
  getHook(hookId: string): RegisteredHook<ControlEvent, unknown> | undefined;
  has(hookId: string): boolean;
  clear(): void;
  getAllIds(): string[];
  getCounts(): Record<ControlEventType, number>;
}

// ============================================
// REGISTRY IMPLEMENTATION
// ============================================

export function createHookRegistry(): HookRegistry {
  const hooks = new Map<string, RegisteredHook<ControlEvent, unknown>>();
  const byEvent = new Map<ControlEventType, Set<string>>();

  function register<Evt extends ControlEvent, D>(hook: Hook<Evt, D>, meta: HookRegistrationMeta): void {
    validateHook(hook as unknown as Hook<ControlEvent, unknown>, meta, hooks);

    const registered: RegisteredHook<Evt, D> = {
      ...hook,
      source: meta.source,
      protocolId: meta.protocolId,
      registeredAt: Date.now(),
    };

    hooks.set(hook.id, registered as unknown as RegisteredHook<ControlEvent, unknown>);

    if (!byEvent.has(hook.event)) {
      byEvent.set(hook.event, new Set());
    }
    byEvent.get(hook.event)!.add(hook.id);
  }

  function registerHooks(bundle: HookBundle): void {
    validateBundle(bundle);
    for (const hook of bundle.hooks) {
      register(hook, { source: bundle.source, protocolId: bundle.protocolId });
    }
  }

  return {
    register,
    registerHooks,

    unregister(hookId: string): void {
      const hook = hooks.get(hookId);
      if (!hook) return;
      hooks.delete(hookId);
      byEvent.get(hook.event)?.delete(hookId);
    },

    getHooks<Evt extends ControlEvent>(eventType: Evt['type']): Array<RegisteredHook<Evt, unknown>> {
      const ids = byEvent.get(eventType);
      if (!ids) return [];

      const result: Array<RegisteredHook<Evt, unknown>> = [];
      for (const id of ids) {
        const hook = hooks.get(id);
        if (hook) {
          result.push(hook as unknown as RegisteredHook<Evt, unknown>);
        }
      }

      // Sort by priority (lower = earlier)
      result.sort((a, b) => a.priority - b.priority);
      return result;
    },

    getHook(hookId: string): RegisteredHook<ControlEvent, unknown> | undefined {
      return hooks.get(hookId);
    },

    has(hookId: string): boolean {
      return hooks.has(hookId);
    },

    clear(): void {
      hooks.clear();
      byEvent.clear();
    },

    getAllIds(): string[] {
      return Array.from(hooks.keys());
    },

    getCounts(): Record<ControlEventType, number> {
      const counts: Partial<Record<ControlEventType, number>> = {};
      for (const eventType of ALL_EVENT_TYPES) {
        counts[eventType] = byEvent.get(eventType)?.size ?? 0;
      }
      return counts as Record<ControlEventType, number>;
    },
  };
}

// ============================================
// VALIDATION
// ============================================

function validateBundle(bundle: HookBundle): void {
  if (!bundle.source?.trim()) {
    throw new Error('Hook bundle missing source');
  }
  if (!bundle.protocolId?.trim()) {
    throw new Error(`Hook bundle ${bundle.source} missing protocolId`);
  }
  if (!isCompatible(bundle.protocolId)) {
    throw new Error(`Hook bundle ${bundle.source} protocolId incompatible: ${bundle.protocolId}`);
  }
}

function validateHook(
  hook: Hook<ControlEvent, unknown>,
  meta: HookRegistrationMeta,
  existing: Map<string, RegisteredHook<ControlEvent, unknown>>
): void {
  if (!meta.source?.trim()) {
    throw new Error('Hook registration missing source');
  }
  if (!meta.protocolId?.trim()) {
    throw new Error(`Hook registration missing protocolId for ${hook.id}`);
  }
  if (!isCompatible(meta.protocolId)) {
    throw new Error(`Hook ${hook.id} protocolId incompatible: ${meta.protocolId}`);
  }
  if (!hook.id?.trim()) {
    throw new Error('Hook id is required');
  }
  if (existing.has(hook.id)) {
    throw new Error(`Hook id already registered: ${hook.id}`);
  }
  if (!ALL_EVENT_TYPES.includes(hook.event)) {
    throw new Error(`Hook ${hook.id} has unknown event type: ${hook.event}`);
  }
  if (hook.timeoutMs <= 0) {
    throw new Error(`Hook ${hook.id} timeoutMs must be > 0`);
  }
  if (!Number.isFinite(hook.priority)) {
    throw new Error(`Hook ${hook.id} priority must be a number`);
  }
  if (!hook.policy) {
    throw new Error(`Hook ${hook.id} is missing policy`);
  }
  validateCriticality(hook.id, hook.policy, hook.criticality);
  validateIdempotency(hook.id, hook.idempotency, hook.policy);
}

function validateCriticality(
  hookId: string,
  policy: HookPolicy,
  criticality: HookCriticality
): void {
  if (!criticality) {
    throw new Error(`Hook ${hookId} missing criticality declaration`);
  }
  if (isCriticalPolicy(policy) && criticality !== 'critical') {
    throw new Error(`Hook ${hookId} policy is critical but criticality is ${criticality}`);
  }
}

function validateIdempotency(
  hookId: string,
  idempotency: HookIdempotency,
  policy: HookPolicy
): void {
  if (!idempotency) {
    throw new Error(`Hook ${hookId} missing idempotency declaration`);
  }
  const maxRetries = getMaxRetries(policy);
  if ((idempotency === 'non_idempotent' || idempotency === 'unknown') && maxRetries > 0) {
    throw new Error(`Hook ${hookId} is not idempotent but policy requests retries`);
  }
  switch (idempotency) {
    case 'idempotent':
    case 'non_idempotent':
    case 'unknown':
      return;
    default:
      return assertNever(idempotency);
  }
}
