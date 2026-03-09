import {
  UNIFIED_HOOK_CATALOG,
  getUnifiedHookCatalogEntry,
  isDecisionEventType,
  isEffectEventType,
  type DecisionEventType,
  type EffectEventType,
  type UnifiedEventType,
} from './catalog.js';
import type {
  RegisteredUnifiedHook,
  UnifiedDecisionHookRegistration,
  UnifiedEffectHookRegistration,
  UnifiedHookRegistration,
} from './contracts.js';

export interface UnifiedHookRegistry {
  register<T extends UnifiedHookRegistration>(hook: T): void;
  unregister(hookId: string): void;
  has(hookId: string): boolean;
  getHook(hookId: string): RegisteredUnifiedHook | undefined;
  getHooksForEvent<E extends UnifiedEventType>(event: E): RegisteredUnifiedHook<Extract<UnifiedHookRegistration, { event: E }>>[];
  getDecisionHooks<E extends DecisionEventType>(event: E): RegisteredUnifiedHook<UnifiedDecisionHookRegistration<E>>[];
  getEffectHooks<E extends EffectEventType>(event: E): RegisteredUnifiedHook<UnifiedEffectHookRegistration<E>>[];
  clear(): void;
  getAllIds(): string[];
  getCounts(): Partial<Record<UnifiedEventType, number>>;
}

export interface SessionScopedUnifiedHookRegistry {
  register<T extends UnifiedHookRegistration>(sessionKey: string, hook: T): void;
  unregister(sessionKey: string, hookId: string): void;
  has(sessionKey: string, hookId: string): boolean;
  getHook(sessionKey: string, hookId: string): RegisteredUnifiedHook | undefined;
  getSessionRegistry(sessionKey: string): UnifiedHookRegistry | null;
  getOrCreateSessionRegistry(sessionKey: string): UnifiedHookRegistry;
  clearSession(sessionKey: string): void;
  clearAll(): void;
  hasSession(sessionKey: string): boolean;
  listSessions(): string[];
  getSessionCounts(sessionKey: string): Partial<Record<UnifiedEventType, number>>;
}

export function createUnifiedHookRegistry(): UnifiedHookRegistry {
  const hooks = new Map<string, RegisteredUnifiedHook>();
  const byEvent = new Map<UnifiedEventType, Set<string>>();
  let registrationIndex = 0;

  function register<T extends UnifiedHookRegistration>(hook: T): void {
    validateHookRegistration(hook, hooks);

    const registered: RegisteredUnifiedHook<T> = {
      ...hook,
      registeredAt: Date.now(),
      registrationIndex,
    };
    registrationIndex += 1;

    hooks.set(hook.id, registered);

    if (!byEvent.has(hook.event)) {
      byEvent.set(hook.event, new Set());
    }
    byEvent.get(hook.event)!.add(hook.id);
  }

  function getSorted<E extends UnifiedEventType>(event: E): RegisteredUnifiedHook<Extract<UnifiedHookRegistration, { event: E }>>[] {
    const ids = byEvent.get(event);
    if (!ids) return [];

    const result: RegisteredUnifiedHook<Extract<UnifiedHookRegistration, { event: E }>>[] = [];
    for (const id of ids) {
      const hook = hooks.get(id);
      if (!hook) continue;
      result.push(hook as RegisteredUnifiedHook<Extract<UnifiedHookRegistration, { event: E }>>);
    }

    result.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.registrationIndex - b.registrationIndex;
    });

    return result;
  }

  return {
    register,

    unregister(hookId: string): void {
      const existing = hooks.get(hookId);
      if (!existing) return;

      hooks.delete(hookId);
      const eventSet = byEvent.get(existing.event);
      eventSet?.delete(hookId);
      if (eventSet?.size === 0) {
        byEvent.delete(existing.event);
      }
    },

    has(hookId: string): boolean {
      return hooks.has(hookId);
    },

    getHook(hookId: string): RegisteredUnifiedHook | undefined {
      return hooks.get(hookId);
    },

    getHooksForEvent<E extends UnifiedEventType>(event: E): RegisteredUnifiedHook<Extract<UnifiedHookRegistration, { event: E }>>[] {
      return getSorted(event);
    },

    getDecisionHooks<E extends DecisionEventType>(event: E): RegisteredUnifiedHook<UnifiedDecisionHookRegistration<E>>[] {
      const hooksForEvent = getSorted(event);
      const typedHooks = hooksForEvent as RegisteredUnifiedHook[];
      return typedHooks
        .filter((hook) => hook.mode === 'decision') as unknown as RegisteredUnifiedHook<UnifiedDecisionHookRegistration<E>>[];
    },

    getEffectHooks<E extends EffectEventType>(event: E): RegisteredUnifiedHook<UnifiedEffectHookRegistration<E>>[] {
      const hooksForEvent = getSorted(event);
      const typedHooks = hooksForEvent as RegisteredUnifiedHook[];
      return typedHooks
        .filter((hook) => hook.mode === 'effect') as unknown as RegisteredUnifiedHook<UnifiedEffectHookRegistration<E>>[];
    },

    clear(): void {
      hooks.clear();
      byEvent.clear();
    },

    getAllIds(): string[] {
      return Array.from(hooks.keys());
    },

    getCounts(): Partial<Record<UnifiedEventType, number>> {
      const counts: Partial<Record<UnifiedEventType, number>> = {};
      for (const entry of UNIFIED_HOOK_CATALOG) {
        counts[entry.event] = byEvent.get(entry.event)?.size ?? 0;
      }
      return counts;
    },
  };
}

export function createSessionScopedUnifiedHookRegistry(): SessionScopedUnifiedHookRegistry {
  const sessionRegistries = new Map<string, UnifiedHookRegistry>();

  function getOrCreateSessionRegistry(sessionKey: string): UnifiedHookRegistry {
    validateSessionKey(sessionKey);
    let registry = sessionRegistries.get(sessionKey);
    if (!registry) {
      registry = createUnifiedHookRegistry();
      sessionRegistries.set(sessionKey, registry);
    }
    return registry;
  }

  function getSessionRegistry(sessionKey: string): UnifiedHookRegistry | null {
    validateSessionKey(sessionKey);
    return sessionRegistries.get(sessionKey) ?? null;
  }

  return {
    register<T extends UnifiedHookRegistration>(sessionKey: string, hook: T): void {
      getOrCreateSessionRegistry(sessionKey).register(hook);
    },

    unregister(sessionKey: string, hookId: string): void {
      const registry = getSessionRegistry(sessionKey);
      if (!registry) return;
      registry.unregister(hookId);
      if (registry.getAllIds().length === 0) {
        sessionRegistries.delete(sessionKey);
      }
    },

    has(sessionKey: string, hookId: string): boolean {
      return getSessionRegistry(sessionKey)?.has(hookId) ?? false;
    },

    getHook(sessionKey: string, hookId: string): RegisteredUnifiedHook | undefined {
      return getSessionRegistry(sessionKey)?.getHook(hookId);
    },

    getSessionRegistry,
    getOrCreateSessionRegistry,

    clearSession(sessionKey: string): void {
      validateSessionKey(sessionKey);
      sessionRegistries.delete(sessionKey);
    },

    clearAll(): void {
      sessionRegistries.clear();
    },

    hasSession(sessionKey: string): boolean {
      validateSessionKey(sessionKey);
      return sessionRegistries.has(sessionKey);
    },

    listSessions(): string[] {
      return Array.from(sessionRegistries.keys());
    },

    getSessionCounts(sessionKey: string): Partial<Record<UnifiedEventType, number>> {
      return getSessionRegistry(sessionKey)?.getCounts() ?? {};
    },
  };
}

function validateSessionKey(sessionKey: string): void {
  if (!sessionKey.trim()) {
    throw new Error('sessionKey is required for session-scoped hook registration');
  }
}

function validateHookRegistration(
  hook: UnifiedHookRegistration,
  existing: Map<string, RegisteredUnifiedHook>
): void {
  if (!hook.id?.trim()) {
    throw new Error('Unified hook id is required');
  }
  if (existing.has(hook.id)) {
    throw new Error(`Unified hook id already registered: ${hook.id}`);
  }
  if (!hook.source?.trim()) {
    throw new Error(`Unified hook ${hook.id} must declare source`);
  }
  if (!Number.isFinite(hook.priority)) {
    throw new Error(`Unified hook ${hook.id} priority must be a finite number`);
  }
  if (!Number.isFinite(hook.timeoutMs) || hook.timeoutMs <= 0) {
    throw new Error(`Unified hook ${hook.id} timeoutMs must be > 0`);
  }

  const catalog = getUnifiedHookCatalogEntry(hook.event);

  if (catalog.mode !== hook.mode) {
    throw new Error(`Unified hook ${hook.id} mode mismatch for ${hook.event}: expected ${catalog.mode}, got ${hook.mode}`);
  }

  if (!catalog.allowedScopes.includes(hook.scope)) {
    throw new Error(`Unified hook ${hook.id} scope ${hook.scope} is not allowed for ${hook.event}`);
  }

  if (hook.mode === 'decision') {
    if (!isDecisionEventType(hook.event)) {
      throw new Error(`Unified decision hook ${hook.id} must use a control-plane event`);
    }
  } else {
    if (!isEffectEventType(hook.event)) {
      throw new Error(`Unified effect hook ${hook.id} must use an effect event`);
    }
  }
}
