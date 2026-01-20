/**
 * Hook System - Simple registry + executor pattern.
 *
 * Register callbacks (TypeScript functions or shell commands) for fixed event types.
 * Shell commands receive JSON on stdin and return exit codes (0=success, 2=block).
 */

import { spawn } from 'child_process';
import type { InternalHookEvent, InternalHookContext, StopHookResult } from 'agent';

// --- Event Types ---

export type HookEventType = InternalHookEvent['type'] | 'stop';

// --- Callback Types ---

/** TypeScript callback for internal hooks */
export type HookCallback<T extends InternalHookEvent = InternalHookEvent> = (
  event: T,
  ctx: InternalHookContext
) => Promise<void>;

/** Shell command hook - spawns subprocess, pipes JSON to stdin */
export interface ShellHook {
  command: string;
  timeout?: number; // ms, default 60000
}

export type HookEntry = HookCallback | ShellHook;

// --- Stop Hook Types (blocking, can re-inject prompts) ---

export interface StopHookContext {
  workId: string;
  response: string;
  terminationReason: string;
  iteration: number;
  agentType: string;
  sessionKey: string;
}

export type StopHookHandler = (context: StopHookContext) => StopHookResult | Promise<StopHookResult>;

// --- Registry ---

const registry = new Map<HookEventType, HookEntry[]>();

/**
 * Register a hook for an event type.
 * Multiple hooks per event are supported; all execute in parallel.
 */
export function registerHook(event: HookEventType, hook: HookEntry): void {
  const hooks = registry.get(event) ?? [];
  hooks.push(hook);
  registry.set(event, hooks);
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

// --- Executor ---

function isShellHook(h: HookEntry): h is ShellHook {
  return typeof h === 'object' && 'command' in h;
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

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

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
        // Exit 2 = blocking error
        reject(new Error(stderr.trim() || 'Hook blocked execution'));
      } else {
        // Non-blocking warning
        if (stderr) {
          console.error(`[HOOK:${payload.type}] Warning: ${stderr.trim()}`);
        }
        resolve();
      }
    });

    // Write payload to stdin
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
      } else {
        await hook(payload, ctx);
      }
    } catch (err) {
      console.error(`[HOOK:${event}] Error:`, err);
    }
  });

  await Promise.all(executions);
}

// --- Config Loading ---

export interface HooksConfig {
  [event: string]: Array<{ command: string; timeout?: number }>;
}

/**
 * Load hooks from JSON config object.
 * Config format:
 * {
 *   "files_modified": [{ "command": "./scripts/on-change.sh", "timeout": 5000 }],
 *   "agent_completed": [{ "command": "python3 ./hooks/log.py" }]
 * }
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
    'turn_completed',
    'tool_batch_completed',
    'context_threshold',
    'files_modified',
    'artifacts_discovered',
    'agent_completed',
    'stop',
  ];
  return validEvents.includes(event as HookEventType);
}

// --- Backwards Compat (deprecated, remove after migration) ---

/** @deprecated Use executeHooks instead */
export function getHandlers<T extends InternalHookEvent['type']>(
  eventType: T
): Array<HookCallback> {
  const hooks = registry.get(eventType) ?? [];
  // Filter to only TypeScript callbacks (shell hooks can't be returned as handlers)
  return hooks.filter((h): h is HookCallback => !isShellHook(h));
}
