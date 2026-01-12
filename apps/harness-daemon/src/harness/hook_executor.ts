/**
 * HookExecutor - Executes hooks for lifecycle events.
 *
 * Handles PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart hooks.
 * Command hooks are executed as shell commands with environment variable injection.
 */

import { spawn } from 'child_process';
import { resolve, extname } from 'path';
import {
  loadHookDefinitions,
  getHookDefinition,
  type HookDefinition,
  type HookEvent,
  type HookContext,
  type HookResult,
  type CommandHookAction,
  type ScriptHookAction,
} from './skills_loader.js';

/** Map file extensions to interpreters */
const EXTENSION_INTERPRETERS: Record<string, string> = {
  '.py': 'python3',
  '.js': 'node',
  '.ts': 'bun',
  '.sh': 'bash',
  '.rb': 'ruby',
  '.pl': 'perl',
};

/**
 * HookExecutor - Loads and executes hooks for lifecycle events.
 */
export class HookExecutor {
  private readonly hooksDir: string;
  private readonly workingDir: string;
  private hookCache: HookDefinition[] | null = null;

  constructor(hooksDir: string, workingDir: string) {
    this.hooksDir = hooksDir;
    this.workingDir = workingDir;
  }

  /**
   * Clear the hook cache (call when hooks are modified).
   */
  clearCache(): void {
    this.hookCache = null;
  }

  /**
   * Load all enabled hooks, sorted by priority (higher first).
   */
  private loadHooks(): HookDefinition[] {
    if (this.hookCache) return this.hookCache;

    const stubs = loadHookDefinitions(this.hooksDir);
    const hooks: HookDefinition[] = [];

    for (const stub of stubs) {
      if (!stub.enabled) continue;
      const full = getHookDefinition(this.hooksDir, stub.id);
      if (full && full.enabled) {
        hooks.push(full);
      }
    }

    this.hookCache = hooks;
    return hooks;
  }

  /**
   * Get hooks matching a lifecycle event and optional tool name.
   */
  private getMatchingHooks(event: HookEvent, toolName?: string): HookDefinition[] {
    const hooks = this.loadHooks();

    return hooks.filter((hook) => {
      // Match trigger
      if (hook.trigger !== event) return false;

      // Match tool name if matcher is specified (for PreToolUse/PostToolUse)
      if (hook.matcher && toolName) {
        try {
          const regex = new RegExp(hook.matcher);
          if (!regex.test(toolName)) return false;
        } catch {
          // Invalid regex - skip this hook
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Execute all matching hooks for an event.
   * Returns aggregated result (block if any hook blocks).
   */
  async execute(event: HookEvent, context: HookContext): Promise<HookResult> {
    const hooks = this.getMatchingHooks(event, context.toolName);

    for (const hook of hooks) {
      const result = await this.runHook(hook, context);

      if (result.action === 'block') {
        return result; // Short-circuit on block
      }

      if (result.action === 'modify' && result.modified) {
        // Merge modifications into context for subsequent hooks
        context.toolParams = { ...context.toolParams, ...result.modified };
      }
    }

    return { action: 'allow' };
  }

  /**
   * Run a single hook.
   */
  private async runHook(hook: HookDefinition, context: HookContext): Promise<HookResult> {
    for (const action of hook.hooks) {
      let result: HookResult;

      if (action.type === 'command') {
        result = await this.runCommandHook(action, hook, context);
      } else if (action.type === 'script') {
        result = await this.runScriptHook(action, hook, context);
      } else {
        // Prompt hooks would be implemented here (Phase 5)
        continue;
      }

      if (result.action !== 'allow') {
        return result;
      }
    }

    return { action: 'allow' };
  }

  /**
   * Run a command hook action.
   */
  private async runCommandHook(
    action: CommandHookAction,
    hook: HookDefinition,
    context: HookContext
  ): Promise<HookResult> {
    const timeout = hook.timeout_ms ?? 30000;
    const failOpen = hook.fail_open ?? true;

    // Build environment variables
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(action.env ?? {}),
      HOOK_EVENT: context.event,
      SESSION_KEY: context.sessionKey,
      REQUEST_ID: context.requestId,
      WORKING_DIR: context.workingDir,
    };

    if (context.toolName) {
      env.TOOL_NAME = context.toolName;
    }

    if (context.toolParams) {
      // Extract file path from common tool params
      const filePath = context.toolParams.file_path ?? context.toolParams.path ?? context.toolParams.filename;
      if (typeof filePath === 'string') {
        env.TOOL_FILE_PATH = filePath;
      }
      env.TOOL_PARAMS = JSON.stringify(context.toolParams);
    }

    if (context.toolResult !== undefined) {
      env.TOOL_RESULT = typeof context.toolResult === 'string'
        ? context.toolResult
        : JSON.stringify(context.toolResult);
    }

    try {
      const result = await this.execCommand(action.command, env, timeout, this.workingDir);

      // Parse result
      if (result.exitCode !== 0) {
        if (failOpen) {
          return { action: 'allow', message: `Hook failed (exit ${result.exitCode}): ${result.stderr || result.stdout}` };
        }
        return { action: 'block', message: result.stderr || result.stdout || `Hook failed with exit code ${result.exitCode}` };
      }

      // Try to parse stdout as JSON result
      const stdout = result.stdout.trim();
      if (stdout.startsWith('{')) {
        try {
          const parsed = JSON.parse(stdout) as HookResult;
          if (parsed.action === 'block' || parsed.action === 'modify' || parsed.action === 'allow') {
            return parsed;
          }
        } catch {
          // Not JSON - treat as success
        }
      }

      return { action: 'allow', message: stdout || undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (failOpen) {
        return { action: 'allow', message: `Hook error: ${message}` };
      }
      return { action: 'block', message: `Hook error: ${message}` };
    }
  }

  /**
   * Run a script hook action.
   */
  private async runScriptHook(
    action: ScriptHookAction,
    hook: HookDefinition,
    context: HookContext
  ): Promise<HookResult> {
    const timeout = hook.timeout_ms ?? 30000;
    const failOpen = hook.fail_open ?? true;

    // Resolve script path
    const scriptPath = action.path.startsWith('/')
      ? action.path
      : resolve(this.workingDir, action.path);

    // Determine interpreter
    let interpreter = action.interpreter;
    if (!interpreter) {
      const ext = extname(scriptPath).toLowerCase();
      interpreter = EXTENSION_INTERPRETERS[ext];
      if (!interpreter) {
        return {
          action: failOpen ? 'allow' : 'block',
          message: `Unknown script extension: ${ext}. Specify interpreter explicitly.`,
        };
      }
    }

    // Build environment variables
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(action.env ?? {}),
      HOOK_EVENT: context.event,
      SESSION_KEY: context.sessionKey,
      REQUEST_ID: context.requestId,
      WORKING_DIR: context.workingDir,
    };

    if (context.toolName) {
      env.TOOL_NAME = context.toolName;
    }

    if (context.toolParams) {
      const filePath = context.toolParams.file_path ?? context.toolParams.path ?? context.toolParams.filename;
      if (typeof filePath === 'string') {
        env.TOOL_FILE_PATH = filePath;
      }
      env.TOOL_PARAMS = JSON.stringify(context.toolParams);
    }

    if (context.toolResult !== undefined) {
      env.TOOL_RESULT = typeof context.toolResult === 'string'
        ? context.toolResult
        : JSON.stringify(context.toolResult);
    }

    // Build args with env var substitution
    const args = (action.args ?? []).map((arg) => {
      return arg.replace(/\$(\w+)/g, (_, varName) => env[varName] ?? '');
    });

    try {
      const result = await this.execScript(interpreter, scriptPath, args, env, timeout, this.workingDir);

      if (result.exitCode !== 0) {
        if (failOpen) {
          return { action: 'allow', message: `Script failed (exit ${result.exitCode}): ${result.stderr || result.stdout}` };
        }
        return { action: 'block', message: result.stderr || result.stdout || `Script failed with exit code ${result.exitCode}` };
      }

      // Try to parse stdout as JSON result
      const stdout = result.stdout.trim();
      if (stdout.startsWith('{')) {
        try {
          const parsed = JSON.parse(stdout) as HookResult;
          if (parsed.action === 'block' || parsed.action === 'modify' || parsed.action === 'allow') {
            return parsed;
          }
        } catch {
          // Not JSON - treat as success
        }
      }

      return { action: 'allow', message: stdout || undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (failOpen) {
        return { action: 'allow', message: `Script error: ${message}` };
      }
      return { action: 'block', message: `Script error: ${message}` };
    }
  }

  /**
   * Execute a script with interpreter and args.
   */
  private execScript(
    interpreter: string,
    scriptPath: string,
    args: string[],
    env: Record<string, string>,
    timeout: number,
    cwd: string
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn(interpreter, [scriptPath, ...args], {
        env,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, timeout);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ exitCode: -1, stdout, stderr: 'Script timed out' });
        } else {
          resolve({ exitCode: code ?? 0, stdout, stderr });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ exitCode: -1, stdout, stderr: err.message });
      });
    });
  }

  /**
   * Execute a shell command with timeout.
   */
  private execCommand(
    command: string,
    env: Record<string, string>,
    timeout: number,
    cwd: string
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn('sh', ['-c', command], {
        env,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, timeout);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ exitCode: -1, stdout, stderr: 'Hook timed out' });
        } else {
          resolve({ exitCode: code ?? 0, stdout, stderr });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ exitCode: -1, stdout, stderr: err.message });
      });
    });
  }
}
