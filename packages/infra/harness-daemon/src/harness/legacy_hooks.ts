/**
 * Legacy Internal Hook System (harness-owned).
 *
 * Registry + executor for internal async hooks that are not part of the
 * protocol control-plane hook path.
 */

import { spawn } from 'child_process';
import type { InternalHookEvent, InternalHookContext } from 'agent';

export type HookEventType = InternalHookEvent['type'] | 'stop' | 'prompt_user';

/**
 * PromptUser hook event - fired when agent requests user input.
 */
export interface PromptUserHookEvent {
  type: 'prompt_user';
  workItemId: string;
  prompt: {
    question: string;
    options?: Array<string | { label: string; description?: string }>;
    context?: string;
    multiSelect?: boolean;
    questionType?: 'multiple_choice' | 'multi_select' | 'fill_in_blank' | 'yes_no' | 'free_text';
    questions?: Array<{
      question: string;
      options?: Array<string | { label: string; description?: string }>;
      context?: string;
      multiSelect?: boolean;
      questionType?: 'multiple_choice' | 'multi_select' | 'fill_in_blank' | 'yes_no' | 'free_text';
    }>;
  };
  timestamp: number;
}

/**
 * PromptUser hook result - determines what happens next.
 */
export type PromptUserHookResult =
  | { action: 'answer'; answer: string | string[]; contextAddendum?: string }
  | { action: 'block'; reason: string };

/** TypeScript callback for internal hooks */
export type HookCallback<T extends InternalHookEvent = InternalHookEvent> = (
  event: T,
  ctx: InternalHookContext
) => Promise<void>;

/** TypeScript callback for prompt_user hooks */
export type PromptUserHookHandler = (
  event: PromptUserHookEvent
) => Promise<PromptUserHookResult>;

/** Shell command hook - spawns subprocess, pipes JSON to stdin */
export interface ShellHook {
  command: string;
  timeout?: number; // ms, default 60000
}

export type HookEntry = HookCallback | ShellHook | PromptUserHookHandler;

const registry = new Map<HookEventType, HookEntry[]>();

/**
 * Register a hook for an event type.
 * Multiple hooks per event are supported; all execute in parallel.
 */
export function registerHook(event: HookEventType, hook: HookEntry): () => void {
  const hooks = registry.get(event) ?? [];
  hooks.push(hook);
  registry.set(event, hooks);

  return () => {
    const existing = registry.get(event);
    if (!existing || existing.length === 0) return;
    const idx = existing.indexOf(hook);
    if (idx === -1) return;
    existing.splice(idx, 1);
    if (existing.length === 0) {
      registry.delete(event);
    } else {
      registry.set(event, existing);
    }
  };
}

/**
 * Clear all hooks for an event type (useful for testing).
 */
export function clearHooks(event: HookEventType): void {
  registry.delete(event);
}

/**
 * Get all registered hooks for an event type.
 */
export function getHooks(event: HookEventType): HookEntry[] {
  return registry.get(event) ?? [];
}

function isShellHook(h: HookEntry): h is ShellHook {
  return typeof h === 'object' && 'command' in h;
}

function isPromptUserHook(event: HookEventType, hook: HookEntry): hook is PromptUserHookHandler {
  return event === 'prompt_user' && typeof hook === 'function';
}

/**
 * Execute a shell command hook.
 * Pipes JSON payload to stdin, waits for exit.
 * Exit 0 = success, Exit 2 = block (error), other = warning.
 */
async function executeShellHook(
  hook: ShellHook,
  payload: InternalHookEvent,
  ctx: InternalHookContext
): Promise<void> {
  const timeout = hook.timeout ?? 60000;
  const input = JSON.stringify({ ...payload, ...ctx });

  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', hook.command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
    });

    let stderr = '';

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Hook command failed: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else if (code === 2) {
        reject(new Error(stderr.trim() || 'Hook blocked execution'));
      } else {
        if (stderr) {
          console.error(`[HOOK:${payload.type}] Warning: ${stderr.trim()}`);
        }
        resolve();
      }
    });

    child.stdin?.write(input);
    child.stdin?.end();
  });
}

/**
 * Execute all registered hooks for an event.
 * Hooks run in parallel. Errors are logged but don't block other hooks.
 */
export async function executeHooks(
  event: HookEventType,
  payload: InternalHookEvent,
  ctx: InternalHookContext
): Promise<void> {
  const hooks = registry.get(event) ?? [];
  if (hooks.length === 0) return;

  const executions = hooks.map(async (hook) => {
    try {
      if (isShellHook(hook)) {
        await executeShellHook(hook, payload, ctx);
      } else if (isPromptUserHook(event, hook)) {
        await hook(payload as unknown as PromptUserHookEvent);
      } else {
        const callback = hook as HookCallback;
        await callback(payload, ctx);
      }
    } catch (err) {
      console.error(`[HOOK:${event}] Error:`, err);
    }
  });

  await Promise.all(executions);
}

export interface HooksConfig {
  [event: string]: Array<{ command: string; timeout?: number }>;
}

/**
 * Load hooks from JSON config object.
 */
export function loadHooksFromConfig(config: HooksConfig): void {
  for (const [event, hooks] of Object.entries(config)) {
    if (!isValidEventType(event)) {
      console.error(`[HOOK] Unknown event type in config: ${event}`);
      continue;
    }
    for (const hook of hooks) {
      registerHook(event, hook);
    }
  }
}

function isValidEventType(event: string): event is HookEventType {
  const validEvents: HookEventType[] = [
    'workitem_created',
    'turn_completed',
    'tool_batch_completed',
    'context_threshold',
    'files_modified',
    'artifacts_discovered',
    'agent_completed',
    'agent_message',
    'tool_call_completed',
    'memory_injected',
    'git_commit',
    'escalation_raised',
    'escalation_resolved',
    'session_status_changed',
    'prompt_user',
    'stop',
  ];
  return validEvents.includes(event as HookEventType);
}

/** @deprecated Use executeHooks instead */
export function getHandlers<T extends InternalHookEvent['type']>(
  eventType: T
): Array<HookCallback> {
  const hooks = registry.get(eventType) ?? [];
  return hooks.filter((h): h is HookCallback => !isShellHook(h));
}
