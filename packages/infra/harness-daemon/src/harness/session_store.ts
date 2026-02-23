import { ContextWindow } from 'context';
import type { GraphDManager } from 'graphd';
import type { ContextWindowSnapshot, RunControlMetadata, SessionPermissionState } from 'types';
import type { ModelSelection } from 'agent';
import type { ManagedRuntime } from 'effect';
import type { RuntimeControlQueue } from 'runtime';
import { PermissionChecker } from './permissions.js';
import path from 'path';
import { existsSync, readdirSync } from 'fs';

interface SessionStoreOptions {
  sessionKey: string;
  maxTokens: number;
  graphd: GraphDManager | null;
  isGraphDReady: () => boolean;
  logger: HarnessLogger;
  dangerousMode?: boolean;  // Allow sessions to opt into dangerous mode independently
  workingDir?: string;       // Working directory for permission checks
}

export interface HarnessLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  warning(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  flush?(): void;
}

export type SessionPermissionStateWithFlags = SessionPermissionState & {
  allowOutsideRoot: boolean;
  webSearchEnabled: boolean;
  writesNoDeletes: boolean;
  restrictWriteToPaths?: string[];
};

/**
 * Build an interruption directive that wraps the user's message with guidance.
 * This helps the agent understand the message arrived mid-execution and how to handle it.
 */
function buildInterruptionDirective(userMessage: string): string {
  return `**User Interruption**: "${userMessage}"

Consider if the user is:
- Requesting a pivot to a different task
- Providing information that invalidates your current action
- Adding context as an addendum

Acknowledge the interruption and adjust your approach accordingly.`;
}

function resolveContextFilePath(workingDir: string, sessionKey: string): string {
  const date = new Date().toISOString().split('T')[0];
  const configuredRoot = process.env.AGENTLAB_SESSION_CONTEXT_ROOT?.trim()
    || process.env.HAIKU_SESSIONS_ROOT?.trim();
  const sessionsRoot = configuredRoot
    ? (path.isAbsolute(configuredRoot) ? configuredRoot : path.resolve(workingDir, configuredRoot))
    : path.join(workingDir, '.haiku', 'sessions');
  const todayPath = path.join(sessionsRoot, date, sessionKey, 'context.md');

  if (existsSync(todayPath)) {
    return todayPath;
  }

  if (!existsSync(sessionsRoot)) {
    return todayPath;
  }

  try {
    const dateDirs = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));

    for (const dateDir of dateDirs) {
      const candidate = path.join(sessionsRoot, dateDir, sessionKey, 'context.md');
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Fall back to today's path on any filesystem error.
  }

  return todayPath;
}

/** Info about an active async run for a session */
export interface AsyncRunInfo {
  requestId: string;
  goal: string;
  cancelled: boolean;
  startedAt: number;
}

export interface SessionExecutionHandle {
  requestId: string;
  controlQueue: RuntimeControlQueue;
  executionRuntime: ManagedRuntime.ManagedRuntime<never, never>;
  runControl: RunControlMetadata;
  startedAt: number;
  completion: Promise<void>;
}

export class SessionStore {
  private readonly sessionKey: string;
  private readonly maxTokens: number;
  private readonly graphd: GraphDManager | null;
  private readonly isGraphDReady: () => boolean;
  private readonly logger: HarnessLogger;
  private readonly workingDir: string;
  private readonly permissionChecker: PermissionChecker;
  private context: ContextWindow | null = null;
  private readonly contextFilePath: string;
  private modelSelections = new Map<string, ModelSelection>();
  private asyncModeEnabled = false;

  // Execution tracking: prevents race conditions when user sends messages during agent execution
  private executingRequestId: string | null = null;
  private queuedUserMessages: Array<{ requestId: string; message: string }> = [];
  private executionControlQueue: RuntimeControlQueue | null = null;
  private executionRuntime: ManagedRuntime.ManagedRuntime<never, never> | null = null;
  private executionRunControl: RunControlMetadata = { state: 'running' };
  private executionCompletion: Promise<void> | null = null;
  private executionCompletionResolver: (() => void) | null = null;

  // Session-level exclusive operation tracking (prevents multiple connections from starting concurrent ops)
  private asyncRun: AsyncRunInfo | null = null;

  constructor(options: SessionStoreOptions) {
    this.sessionKey = options.sessionKey;
    this.maxTokens = options.maxTokens;
    this.graphd = options.graphd;
    this.isGraphDReady = options.isGraphDReady;
    this.logger = options.logger;
    this.workingDir = options.workingDir ?? process.cwd();
    this.contextFilePath = resolveContextFilePath(this.workingDir, options.sessionKey);

    // Per-session permission checker - each session has its own dangerous mode and grants
    this.permissionChecker = new PermissionChecker(
      this.workingDir,
      options.dangerousMode ?? false
    );
  }

  setAsyncModeEnabled(enabled: boolean): void {
    this.asyncModeEnabled = enabled;
  }

  isAsyncModeEnabled(): boolean {
    return this.asyncModeEnabled;
  }

  getWorkingDirectory(): string {
    return this.workingDir;
  }

  // --- Session-level exclusive operation management ---

  /**
   * Start an async run for this session.
   * Returns false if an async run is already active (caller should reject the request).
   */
  startAsyncRun(info: AsyncRunInfo): boolean {
    if (this.asyncRun !== null) {
      return false;
    }
    this.asyncRun = info;
    return true;
  }

  /**
   * Get the current async run info, if any.
   */
  getAsyncRun(): AsyncRunInfo | null {
    return this.asyncRun;
  }

  /**
   * Mark the async run as cancelled.
   */
  cancelAsyncRun(): void {
    if (this.asyncRun) {
      this.asyncRun.cancelled = true;
    }
  }

  /**
   * Clear the async run state.
   */
  clearAsyncRun(): void {
    this.asyncRun = null;
  }

  getContext(): ContextWindow {
    if (this.context) {
      return this.context;
    }

    // Recover session state (model selections, permissions) from GraphD metadata
    this.recoverSessionState();

    const hadLocalContextFile = existsSync(this.contextFilePath);
    if (hadLocalContextFile) {
      this.context = new ContextWindow(this.sessionKey, this.maxTokens, this.contextFilePath);
      this.compactHydratedContextIfNeeded('disk');
      this.logger.debug('Hydrated context from disk', {
        sessionKey: this.sessionKey,
        itemCount: this.context.items.length,
        version: this.context.version,
        path: this.contextFilePath,
      });
      return this.context;
    }

    // Fall back to GraphD only when no disk context exists yet.
    if (this.isGraphDReady() && this.graphd) {
      try {
        const result = this.graphd.contextGet(this.sessionKey) as {
          snapshot?: { context?: ContextWindowSnapshot };
          error?: string;
        };
        if (result.snapshot?.context) {
          this.context = ContextWindow.deserialize(result.snapshot.context, this.contextFilePath);
          this.compactHydratedContextIfNeeded('graphd');
          this.logger.debug('Seeded disk context from GraphD snapshot', {
            sessionKey: this.sessionKey,
            itemCount: this.context.items.length,
            version: this.context.version,
            path: this.contextFilePath,
          });
          return this.context;
        }
      } catch (error) {
        this.logger.warning('Failed to seed context from GraphD snapshot', {
          sessionKey: this.sessionKey,
          error: String(error),
        });
      }
    }

    this.context = new ContextWindow(this.sessionKey, this.maxTokens, this.contextFilePath);
    this.logger.debug('Created new context', { sessionKey: this.sessionKey, maxTokens: this.maxTokens, path: this.contextFilePath });
    return this.context;
  }

  private compactHydratedContextIfNeeded(source: 'disk' | 'graphd'): void {
    if (!this.context || !this.context.isNearFull(0.5)) {
      return;
    }

    const beforeItems = this.context.items.length;
    const result = this.context.compact({
      deduplicateByPath: true,
      maxFileContentCount: 15,
      maxFunctionCallCount: 180,
      maxFunctionCallOutputCount: 180,
      truncateOutputsTo: 3000,
    });

    if (result.itemsRemoved > 0 || result.outputsTruncated > 0) {
      this.logger.info('Compacted hydrated context', {
        sessionKey: this.sessionKey,
        source,
        itemsBefore: beforeItems,
        itemsAfter: this.context.items.length,
        itemsRemoved: result.itemsRemoved,
        functionCallsRemoved: result.functionCallsRemoved ?? 0,
        functionCallOutputsRemoved: result.functionCallOutputsRemoved ?? 0,
        outputsTruncated: result.outputsTruncated,
        bytesRecovered: result.bytesRecovered,
      });
    }
  }

  /**
   * Recover session state (model selections, permissions) from GraphD metadata.
   * Called during context hydration.
   */
  private recoverSessionState(): void {
    if (!this.isGraphDReady() || !this.graphd) {
      return;
    }

    try {
      const session = this.graphd.sessionGet(this.sessionKey);
      const metadata = session?.metadata as Record<string, unknown> | undefined;

      if (metadata) {
        this.hydrateSessionState(metadata);
      }
    } catch (error) {
      this.logger.warning('Failed to recover session state from GraphD', {
        sessionKey: this.sessionKey,
        error: String(error),
      });
    }
  }

  getCachedContextSnapshot(): ContextWindowSnapshot | null {
    if (!this.context) return null;
    return this.context.serialize();
  }

  /**
   * Clear the current context and create a fresh one.
   * Used for handoff transitions from planning to execution.
   */
  clearContext(): ContextWindow {
    this.context = new ContextWindow(this.sessionKey, this.maxTokens, this.contextFilePath);
    this.context.clear(); // Wipe items loaded from existing disk file
    this.logger.debug('Cleared context for handoff', { sessionKey: this.sessionKey });
    return this.context;
  }

  hydrateFromSnapshot(snapshot: ContextWindowSnapshot): void {
    this.context = ContextWindow.deserialize(snapshot, this.contextFilePath);
  }

  /**
   * Get message history for TUI rehydration.
   * This returns the conversation history that should be displayed in the TUI.
   */
  getMessageHistory(): Array<{ role: 'user' | 'agent' | 'system'; content: string; timestamp: number; requestId?: string }> {
    const context = this.getContext();
    return context.getMessageHistory();
  }

  persistContext(): void {
    if (!this.context || !this.isGraphDReady() || !this.graphd) return;

    try {
      const snapshot = this.context.serialize();
      this.graphd.contextSave(this.sessionKey, { context: snapshot });
      this.logger.debug('Persisted context to GraphD', {
        sessionKey: this.sessionKey,
        itemCount: this.context.items.length,
        version: this.context.version,
      });
    } catch (error) {
      this.logger.warning('Failed to persist context to GraphD', {
        sessionKey: this.sessionKey,
        error: String(error),
      });
    }
  }

  /**
   * Persist session state (model selections, permissions) to GraphD.
   */
  private persistSessionState(): void {
    if (!this.isGraphDReady() || !this.graphd) return;

    try {
      const metadata: Record<string, unknown> = {
        model_selections: Object.fromEntries(this.modelSelections),
        permission_state: this.permissionChecker.getState(),
        permission_flags: this.permissionChecker.getRuntimeFlags(),
      };
      this.graphd.sessionUpdateMetadata(this.sessionKey, metadata);
      const runtimeFlags = this.permissionChecker.getRuntimeFlags();
      this.logger.debug('Persisted session state to GraphD', {
        sessionKey: this.sessionKey,
        modelSelectionsCount: this.modelSelections.size,
        permissionGrants: this.permissionChecker.getState().sessionGrants.length,
        permissionDenials: this.permissionChecker.getState().sessionDenials.length,
        dangerousMode: this.permissionChecker.getState().dangerousMode,
        allowOutsideRoot: runtimeFlags.allowOutsideRoot,
        webSearchEnabled: runtimeFlags.webSearchEnabled,
        writesNoDeletes: runtimeFlags.writesNoDeletes,
      });
    } catch (error) {
      this.logger.warning('Failed to persist session state to GraphD', {
        sessionKey: this.sessionKey,
        error: String(error),
      });
    }
  }

  /**
   * Hydrate session state from GraphD metadata.
   */
  private hydrateSessionState(metadata: Record<string, unknown>): void {
    // Hydrate model selections
    const modelSelections = metadata.model_selections as Record<string, ModelSelection> | undefined;
    if (modelSelections) {
      for (const [agentType, selection] of Object.entries(modelSelections)) {
        if (selection?.provider && selection?.model) {
          this.modelSelections.set(agentType, selection);
        }
      }
    }

    // Hydrate permission state
    const permissionState = metadata.permission_state as SessionPermissionState | undefined;
    const permissionFlags = metadata.permission_flags as {
      allowOutsideRoot?: boolean;
      webSearchEnabled?: boolean;
      writesNoDeletes?: boolean;
      restrictWriteToPaths?: string[];
    } | undefined;
    this.permissionChecker.hydrateRuntimeFlags(permissionFlags);
    if (permissionState) {
      this.permissionChecker.hydrateState(permissionState);
      const runtimeFlags = this.permissionChecker.getRuntimeFlags();
      this.logger.debug('Hydrated permission state from GraphD', {
        sessionKey: this.sessionKey,
        grants: permissionState.sessionGrants.length,
        denials: permissionState.sessionDenials.length,
        dangerousMode: permissionState.dangerousMode,
        allowOutsideRoot: runtimeFlags.allowOutsideRoot,
        webSearchEnabled: runtimeFlags.webSearchEnabled,
        writesNoDeletes: runtimeFlags.writesNoDeletes,
      });
    }
  }

  touch(workingDir: string): void {
    if (!this.isGraphDReady() || !this.graphd) return;
    this.graphd.sessionTouch(this.sessionKey, workingDir);
  }

  close(): void {
    this.persistContext();
    this.context = null;
    this.modelSelections.clear();
    this.asyncRun = null;
    this.executionCompletionResolver?.();
    this.executionCompletionResolver = null;
    this.executionCompletion = null;
    this.executionControlQueue = null;
    this.executionRuntime?.dispose();
    this.executionRuntime = null;
    this.executionRunControl = { state: 'running' };
    this.executingRequestId = null;
  }

  /**
   * Set model selection for a specific agent type.
   */
  setModelSelection(agentType: string, selection: ModelSelection): void {
    this.modelSelections.set(agentType, selection);
    this.persistSessionState();
  }

  /**
   * Clear model selection for a specific agent type.
   * Returns true when a selection existed and was removed.
   */
  clearModelSelection(agentType: string): boolean {
    const removed = this.modelSelections.delete(agentType);
    if (removed) {
      this.persistSessionState();
    }
    return removed;
  }

  /**
   * Get model selection for a specific agent type.
   * Returns null if no selection exists for that agent type.
   */
  getModelSelection(agentType: string): ModelSelection | null {
    return this.modelSelections.get(agentType) ?? null;
  }

  /**
   * Get all model selections (for persistence).
   */
  getAllModelSelections(): Map<string, ModelSelection> {
    return new Map(this.modelSelections);
  }

  /**
   * Clear all model selections.
   */
  clearModelSelections(): void {
    if (this.modelSelections.size === 0) {
      return;
    }
    this.modelSelections.clear();
    this.persistSessionState();
  }

  // --- Permission management (per-session) ---

  /**
   * Get the permission checker for this session.
   * Each session has its own permission state including dangerous mode.
   */
  getPermissionChecker(): PermissionChecker {
    return this.permissionChecker;
  }

  /**
   * Set dangerous mode for this session.
   * Does not affect other sessions.
   */
  setDangerousMode(enabled: boolean): void {
    this.permissionChecker.setDangerousMode(enabled);
    this.logger.info('Dangerous mode changed', {
      sessionKey: this.sessionKey,
      enabled,
    });
    this.persistSessionState();
  }

  getPermissionState(): SessionPermissionStateWithFlags {
    return {
      ...this.permissionChecker.getState(),
      ...this.permissionChecker.getRuntimeFlags(),
    };
  }

  updatePermissionOptions(input: {
    dangerousMode?: boolean;
    allowOutsideRoot?: boolean;
    webSearchEnabled?: boolean;
    writesNoDeletes?: boolean;
    restrictWriteToPaths?: string[] | null;
    reloadPersistentConfig?: boolean;
  }): SessionPermissionStateWithFlags {
    if (typeof input.dangerousMode === 'boolean') {
      this.permissionChecker.setDangerousMode(input.dangerousMode);
    }
    if (typeof input.allowOutsideRoot === 'boolean') {
      this.permissionChecker.setAllowOutsideRoot(input.allowOutsideRoot);
    }
    if (typeof input.webSearchEnabled === 'boolean') {
      this.permissionChecker.setWebSearchEnabled(input.webSearchEnabled);
    }
    if (typeof input.writesNoDeletes === 'boolean') {
      this.permissionChecker.setWritesNoDeletes(input.writesNoDeletes);
    }
    if (Array.isArray(input.restrictWriteToPaths) || input.restrictWriteToPaths === null) {
      this.permissionChecker.setRestrictWriteToPaths(input.restrictWriteToPaths);
    }
    if (input.reloadPersistentConfig === true) {
      this.permissionChecker.reloadPersistentConfig();
    }
    this.persistSessionState();
    return {
      ...this.permissionChecker.getState(),
      ...this.permissionChecker.getRuntimeFlags(),
    };
  }

  // --- Execution tracking ---

  /**
   * Mark that an orchestrator is executing for this session.
   * Returns false if there's already an active execution (caller should queue message instead).
   */
  startExecution(requestId: string, controlQueue: RuntimeControlQueue, executionRuntime: ManagedRuntime.ManagedRuntime<never, never>): boolean {
    if (this.executingRequestId !== null) {
      return false;
    }
    this.executingRequestId = requestId;
    this.executionControlQueue = controlQueue;
    this.executionRuntime = executionRuntime;
    this.executionRunControl = { state: 'running' };
    this.executionCompletion = new Promise((resolve) => {
      this.executionCompletionResolver = resolve;
    });
    return true;
  }

  /**
   * Check if there's an active orchestrator execution.
   */
  isExecuting(): boolean {
    return this.executingRequestId !== null;
  }

  /**
   * Get the current executing request ID, if any.
   */
  getExecutingRequestId(): string | null {
    return this.executingRequestId;
  }

  getActiveExecutionHandle(): SessionExecutionHandle | null {
    if (
      this.executingRequestId === null ||
      this.executionControlQueue === null ||
      this.executionRuntime === null ||
      this.executionCompletion === null
    ) {
      return null;
    }
    return {
      requestId: this.executingRequestId,
      controlQueue: this.executionControlQueue,
      executionRuntime: this.executionRuntime,
      runControl: {
        state: this.executionRunControl.state,
        cancellation: this.executionRunControl.cancellation
          ? {
              ...this.executionRunControl.cancellation,
              targetWorkIds: this.executionRunControl.cancellation.targetWorkIds
                ? [...this.executionRunControl.cancellation.targetWorkIds]
                : undefined,
            }
          : undefined,
      },
      startedAt: this.asyncRun?.startedAt ?? Date.now(),
      completion: this.executionCompletion,
    };
  }

  updateExecutionRunControl(control: RunControlMetadata): void {
    this.executionRunControl = {
      state: control.state,
      cancellation: control.cancellation
        ? {
            ...control.cancellation,
            targetWorkIds: control.cancellation.targetWorkIds
              ? [...control.cancellation.targetWorkIds]
              : undefined,
          }
        : undefined,
    };
  }

  getExecutionRunControl(): RunControlMetadata {
    return {
      state: this.executionRunControl.state,
      cancellation: this.executionRunControl.cancellation
        ? {
            ...this.executionRunControl.cancellation,
            targetWorkIds: this.executionRunControl.cancellation.targetWorkIds
              ? [...this.executionRunControl.cancellation.targetWorkIds]
              : undefined,
          }
        : undefined,
    };
  }

  async waitForExecutionCompletion(requestId: string, timeoutMs = 30_000): Promise<boolean> {
    if (this.executingRequestId !== requestId || !this.executionCompletion) {
      return true;
    }

    const completion = this.executionCompletion;
    const timedOut = await Promise.race([
      completion.then(() => false),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    return !timedOut;
  }

  /**
   * Mark execution as complete and return any queued user messages.
   * Messages should be injected into context before next agent turn.
   */
  endExecution(): Array<{ requestId: string; message: string }> {
    this.executionCompletionResolver?.();
    this.executionCompletionResolver = null;
    this.executionCompletion = null;
    this.executionControlQueue = null;
    this.executionRuntime?.dispose();
    this.executionRuntime = null;
    this.executionRunControl = { state: 'running' };
    this.executingRequestId = null;
    const queued = this.queuedUserMessages;
    this.queuedUserMessages = [];
    return queued;
  }

  /**
   * Queue a user message to be seen by the running agent on its next turn.
   * The message is added to the context window immediately (with interruption directive)
   * so the agent sees it and understands it's an interruption.
   */
  queueUserMessage(requestId: string, message: string): void {
    this.queuedUserMessages.push({ requestId, message });
    // Add to context with interruption directive so agent understands it's mid-execution
    const ctx = this.getContext();
    const directive = buildInterruptionDirective(message);
    ctx.addMessage('user', directive);
    this.logger.debug('Queued user message during execution', {
      sessionKey: this.sessionKey,
      executingRequestId: this.executingRequestId,
      queuedRequestId: requestId,
      messagePreview: message.slice(0, 100),
    });
  }

  /**
   * Drain queued messages (clears the queue).
   */
  drainQueuedMessages(): Array<{ requestId: string; message: string }> {
    const queued = this.queuedUserMessages;
    this.queuedUserMessages = [];
    return queued;
  }

  /**
   * Get queued messages without clearing them (for inspection).
   */
  getQueuedMessages(): ReadonlyArray<{ requestId: string; message: string }> {
    return this.queuedUserMessages;
  }

  /**
   * Check if there are pending user messages (interruptions) waiting.
   * Used by orchestrator to avoid premature termination.
   */
  hasPendingInterruption(): boolean {
    return this.queuedUserMessages.length > 0;
  }
}
