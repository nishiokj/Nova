import { spawn } from 'child_process';
import { extname, resolve } from 'path';
import type {
  CommandHookAction,
  HookContext,
  HookDefinition,
  HookResult,
  ScriptHookAction,
} from './skills_loader.js';

const EXTENSION_INTERPRETERS: Record<string, string> = {
  '.py': 'python3',
  '.js': 'node',
  '.ts': 'bun',
  '.sh': 'bash',
  '.rb': 'ruby',
  '.pl': 'perl',
};

export class ConfiguredEffectHooksRunner {
  private readonly workingDir: string;

  constructor(workingDir: string) {
    this.workingDir = workingDir;
  }

  matches(definition: HookDefinition, toolName?: string): boolean {
    if (!definition.matcher || !toolName) return true;
    try {
      return new RegExp(definition.matcher).test(toolName);
    } catch {
      return false;
    }
  }

  async execute(definition: HookDefinition, context: HookContext): Promise<HookResult> {
    for (const action of definition.hooks) {
      let result: HookResult;
      if (action.type === 'command') {
        result = await this.runCommandHook(action, definition, context);
      } else if (action.type === 'script') {
        result = await this.runScriptHook(action, definition, context);
      } else {
        continue;
      }

      if (result.action !== 'allow') {
        return result;
      }
    }
    return { action: 'allow' };
  }

  private async runCommandHook(
    action: CommandHookAction,
    hook: HookDefinition,
    context: HookContext
  ): Promise<HookResult> {
    const timeout = hook.timeout_ms ?? 30000;
    const failOpen = hook.fail_open ?? true;
    const env = this.buildEnv(action.env ?? {}, context);

    try {
      const result = await this.execCommand(action.command, env, timeout, this.workingDir);
      return this.parseHookResult(result.exitCode, result.stdout, result.stderr, failOpen, 'Hook');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failOpen
        ? { action: 'allow', message: `Hook error: ${message}` }
        : { action: 'block', message: `Hook error: ${message}` };
    }
  }

  private async runScriptHook(
    action: ScriptHookAction,
    hook: HookDefinition,
    context: HookContext
  ): Promise<HookResult> {
    const timeout = hook.timeout_ms ?? 30000;
    const failOpen = hook.fail_open ?? true;
    const scriptPath = action.path.startsWith('/')
      ? action.path
      : resolve(this.workingDir, action.path);

    let interpreter = action.interpreter;
    if (!interpreter) {
      const ext = extname(scriptPath).toLowerCase();
      interpreter = EXTENSION_INTERPRETERS[ext];
      if (!interpreter) {
        return failOpen
          ? { action: 'allow', message: `Unknown script extension: ${ext}` }
          : { action: 'block', message: `Unknown script extension: ${ext}` };
      }
    }

    const env = this.buildEnv(action.env ?? {}, context);
    const args = (action.args ?? []).map((arg) => arg.replace(/\$(\w+)/g, (_, name) => env[name] ?? ''));

    try {
      const result = await this.execScript(interpreter, scriptPath, args, env, timeout, this.workingDir);
      return this.parseHookResult(result.exitCode, result.stdout, result.stderr, failOpen, 'Script');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failOpen
        ? { action: 'allow', message: `Script error: ${message}` }
        : { action: 'block', message: `Script error: ${message}` };
    }
  }

  private parseHookResult(
    exitCode: number,
    stdout: string,
    stderr: string,
    failOpen: boolean,
    label: string
  ): HookResult {
    if (exitCode !== 0) {
      const message = stderr || stdout || `${label} failed with exit code ${exitCode}`;
      return failOpen
        ? { action: 'allow', message: `${label} failed (exit ${exitCode}): ${message}` }
        : { action: 'block', message };
    }

    const trimmed = stdout.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as HookResult;
        if (parsed.action === 'allow' || parsed.action === 'block' || parsed.action === 'modify') {
          return parsed;
        }
      } catch {
        // no-op: treat as successful output
      }
    }

    return { action: 'allow', message: trimmed || undefined };
  }

  private buildEnv(base: Record<string, string>, context: HookContext): Record<string, string> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...base,
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

    if (context.commitSha) env.COMMIT_SHA = context.commitSha;
    if (context.commitMessage) env.COMMIT_MESSAGE = context.commitMessage;
    if (context.commitBranch) env.COMMIT_BRANCH = context.commitBranch;

    return env;
  }

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

      proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ exitCode: 124, stdout, stderr: stderr || 'Hook timed out' });
          return;
        }
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  }

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

      proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ exitCode: 124, stdout, stderr: stderr || 'Hook timed out' });
          return;
        }
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  }
}
