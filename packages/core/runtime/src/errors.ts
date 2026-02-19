export type RuntimeExecutionErrorCode =
  | 'cancelled'
  | 'paused'
  | 'timeout'
  | 'queue_closed'
  | 'interrupted'
  | 'scope_finalization_failed'
  | 'invalid_control_message'
  | 'unknown';

export interface RuntimeExecutionErrorOptions {
  code: RuntimeExecutionErrorCode;
  message: string;
  runId?: string;
  workItemId?: string;
  cause?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Typed runtime error used by Effect-first execution surfaces.
 */
export class RuntimeExecutionError extends Error {
  readonly _tag = 'RuntimeExecutionError';
  readonly code: RuntimeExecutionErrorCode;
  readonly runId?: string;
  readonly workItemId?: string;
  readonly metadata?: Record<string, unknown>;

  constructor(options: RuntimeExecutionErrorOptions) {
    super(options.message);
    this.name = 'RuntimeExecutionError';
    this.code = options.code;
    this.runId = options.runId;
    this.workItemId = options.workItemId;
    this.metadata = options.metadata;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function isRuntimeExecutionError(value: unknown): value is RuntimeExecutionError {
  return value instanceof RuntimeExecutionError;
}

export function toRuntimeExecutionError(
  cause: unknown,
  fallback: Omit<RuntimeExecutionErrorOptions, 'cause'>
): RuntimeExecutionError {
  if (isRuntimeExecutionError(cause)) {
    return cause;
  }
  return new RuntimeExecutionError({
    ...fallback,
    cause,
  });
}
