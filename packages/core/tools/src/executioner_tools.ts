import { isAbsolute, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import type { ToolResult } from 'types';
import { errorResult, successResult, timeoutResult } from 'types';
import type {
  ToolExecutionContext,
  ToolExecutionError,
  ToolRegistrationOptions,
} from './types.js';
import { isDangerousCommand, toToolExecutionError } from './types.js';

type ExecutionerStatus = 'success' | 'error' | 'timeout' | 'cancelled' | 'policy_denied';

export interface ExecutionerSubmitResult {
  invocationId: string;
  toolName: string;
  status: ExecutionerStatus;
  output: string;
  error?: string | null;
  summary?: string | null;
  effects?: unknown[];
  durationMs: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutionerToolEnvironment {
  session?: {
    workspace: {
      root: string;
      logicalRoot: string;
      mode?: string;
      fresh?: boolean;
      managed?: boolean;
    };
  };
  submit(call: {
    toolName: string;
    arguments: Record<string, unknown>;
    cwd?: string;
    invocationId?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    metadata?: Record<string, unknown>;
  }): Promise<ExecutionerSubmitResult>;
}

export type ExecutionerToolEnvironmentProvider =
  | ExecutionerToolEnvironment
  | Promise<ExecutionerToolEnvironment>
  | (() => ExecutionerToolEnvironment | Promise<ExecutionerToolEnvironment>);

export interface ExecutionerToolLogEvent {
  phase: 'starting' | 'completed' | 'failed' | 'blocked';
  toolName: string;
  invocationId: string;
  substrate: 'substrate';
  logicalCwd: string;
  originalCwd?: string;
  workspaceRoot?: string;
  sandboxRoot?: string;
  sandboxMode?: string;
  sandboxFresh?: boolean;
  sandboxManaged?: boolean;
  argumentSummary: Record<string, unknown>;
  status?: ExecutionerStatus;
  durationMs?: number;
  effectsCount?: number;
  error?: string;
}

export type ExecutionerToolLogger = (event: ExecutionerToolLogEvent) => void;

const EXECUTIONER_TOOL_NAMES = new Set(['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob']);

export function isExecutionerToolName(name: string): boolean {
  return EXECUTIONER_TOOL_NAMES.has(name);
}

export function executionerToolOptions(options: ToolRegistrationOptions[]): ToolRegistrationOptions[] {
  return options.filter((option) => isExecutionerToolName(option.name));
}

export function withExecutionerToolExecutors(
  options: ToolRegistrationOptions[],
  environment: ExecutionerToolEnvironmentProvider,
  workspaceRoot?: string,
  logger?: ExecutionerToolLogger
): ToolRegistrationOptions[] {
  return options.map((option) => {
    if (!EXECUTIONER_TOOL_NAMES.has(option.name)) {
      return option;
    }

    return {
      ...option,
      executor: createExecutionerExecutor(option.name, environment, workspaceRoot, logger),
    };
  });
}

function createExecutionerExecutor(
  toolName: string,
  environment: ExecutionerToolEnvironmentProvider,
  workspaceRoot?: string,
  logger?: ExecutionerToolLogger
): ToolRegistrationOptions['executor'] {
  return (
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Effect.Effect<ToolResult, ToolExecutionError> =>
    Effect.tryPromise({
      try: async () => {
        const invocationId = `agent_${randomUUID().replaceAll('-', '')}`;
        const originalCwd = context?.workdirOverride;
        const logical = logicalCwd(originalCwd, workspaceRoot);
        if (toolName === 'Bash' && !context?.dangerousMode && isDangerousCommand(String(args.command ?? ''))) {
          emitExecutionerToolLog(logger, {
            phase: 'blocked',
            toolName,
            invocationId,
            substrate: 'substrate',
            logicalCwd: logical,
            originalCwd,
            workspaceRoot,
            argumentSummary: summarizeArguments(toolName, args),
            status: 'policy_denied',
            durationMs: 0,
            error: 'Command blocked for safety: contains dangerous pattern',
          });
          return errorResult('Bash', 'Command blocked for safety: contains dangerous pattern', 0, {
            substrate: 'substrate',
            invocationId,
          });
        }

        const env = await resolveEnvironment(environment);
        const normalizedArgs = normalizePathArguments(args, context?.workdirOverride);
        const workspace = env.session?.workspace;
        const started = Date.now();
        emitExecutionerToolLog(logger, {
          phase: 'starting',
          toolName,
          invocationId,
          substrate: 'substrate',
          logicalCwd: logical,
          originalCwd,
          workspaceRoot,
          sandboxRoot: workspace?.root,
          sandboxMode: workspace?.mode,
          sandboxFresh: workspace?.fresh,
          sandboxManaged: workspace?.managed,
          argumentSummary: summarizeArguments(toolName, normalizedArgs),
        });

        try {
          const result = await env.submit({
            toolName,
            arguments: normalizedArgs,
            cwd: logical,
            invocationId,
            maxOutputBytes: typeof normalizedArgs.maxBytes === 'number'
              ? normalizedArgs.maxBytes
              : undefined,
            metadata: {
              source: 'agent-tool-registry',
              originalCwd,
            },
          });

          emitExecutionerToolLog(logger, {
            phase: 'completed',
            toolName,
            invocationId: result.invocationId,
            substrate: 'substrate',
            logicalCwd: logical,
            originalCwd,
            workspaceRoot,
            sandboxRoot: workspace?.root,
            sandboxMode: workspace?.mode,
            sandboxFresh: workspace?.fresh,
            sandboxManaged: workspace?.managed,
            argumentSummary: summarizeArguments(toolName, normalizedArgs),
            status: result.status,
            durationMs: result.durationMs,
            effectsCount: result.effects?.length ?? 0,
            error: result.error ?? undefined,
          });

          return toToolResult(result);
        } catch (error) {
          emitExecutionerToolLog(logger, {
            phase: 'failed',
            toolName,
            invocationId,
            substrate: 'substrate',
            logicalCwd: logical,
            originalCwd,
            workspaceRoot,
            sandboxRoot: workspace?.root,
            sandboxMode: workspace?.mode,
            sandboxFresh: workspace?.fresh,
            sandboxManaged: workspace?.managed,
            argumentSummary: summarizeArguments(toolName, normalizedArgs),
            durationMs: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      catch: (error) =>
        toToolExecutionError(error, 'execution_error', {
          toolName,
          substrate: 'substrate',
        }),
    });
}

function emitExecutionerToolLog(
  logger: ExecutionerToolLogger | undefined,
  event: ExecutionerToolLogEvent
): void {
  try {
    logger?.(event);
  } catch {
    // Tool execution must not depend on diagnostic logging.
  }
}

function summarizeArguments(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    case 'Bash':
      return {
        command: truncateSummary(stringValue(args.command), 500),
        timeout: args.timeout,
      };
    case 'Read':
      return {
        path: args.path,
        offset: args.offset,
        limit: args.limit,
        maxBytes: args.maxBytes,
      };
    case 'Write':
      return {
        path: args.path,
        contentBytes: typeof args.content === 'string' ? Buffer.byteLength(args.content, 'utf8') : undefined,
      };
    case 'Edit':
      return {
        path: args.path,
        oldStringBytes: typeof args.oldString === 'string' ? Buffer.byteLength(args.oldString, 'utf8') : undefined,
        newStringBytes: typeof args.newString === 'string' ? Buffer.byteLength(args.newString, 'utf8') : undefined,
        replaceAll: args.replaceAll,
      };
    case 'Grep':
      return {
        pattern: args.pattern,
        path: args.path,
        glob: args.glob,
        outputMode: args.output_mode,
      };
    case 'Glob':
      return {
        pattern: args.pattern,
        path: args.path,
        maxResults: args.maxResults,
      };
    default:
      return {};
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function truncateSummary(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...[truncated]`;
}

function logicalCwd(cwd: string | undefined, workspaceRoot: string | undefined): string {
  if (!cwd || !workspaceRoot) {
    return '/workspace';
  }

  const relativePath = relative(workspaceRoot, cwd);
  if (!relativePath || relativePath === '.') {
    return '/workspace';
  }
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return '/workspace';
  }
  return `/workspace/${relativePath.split(sep).join('/')}`;
}

async function resolveEnvironment(
  provider: ExecutionerToolEnvironmentProvider
): Promise<ExecutionerToolEnvironment> {
  if (typeof provider === 'function') {
    return provider();
  }
  return provider;
}

function toToolResult(result: ExecutionerSubmitResult): ToolResult {
  const metadata = {
    ...(result.metadata ?? {}),
    invocationId: result.invocationId,
    effects: result.effects ?? [],
    summary: result.summary ?? undefined,
    substrate: 'substrate',
  };

  if (result.status === 'success') {
    return successResult(result.toolName, result.output, result.durationMs, metadata);
  }

  if (result.status === 'timeout') {
    const timeout = timeoutResult(result.toolName, result.durationMs);
    timeout.metadata = metadata;
    return timeout;
  }

  if (result.status === 'cancelled') {
    return {
      toolName: result.toolName,
      status: 'cancelled',
      output: result.output,
      error: result.error ?? result.output,
      durationMs: result.durationMs,
      isSuccess: false,
      metadata,
    };
  }

  return errorResult(
    result.toolName,
    result.error ?? (result.output || `Executioner returned ${result.status}`),
    result.durationMs,
    metadata
  );
}

function normalizePathArguments(
  args: Record<string, unknown>,
  cwd: string | undefined
): Record<string, unknown> {
  if (!cwd) {
    return args;
  }

  const next = { ...args };
  normalizePathField(next, 'path', cwd);
  return next;
}

function normalizePathField(args: Record<string, unknown>, field: string, cwd: string): void {
  const value = args[field];
  if (typeof value !== 'string' || !isAbsolute(value)) {
    return;
  }

  const relativePath = relative(cwd, value);
  if (!relativePath.startsWith('..') && !isAbsolute(relativePath)) {
    args[field] = relativePath || '.';
  }
}
