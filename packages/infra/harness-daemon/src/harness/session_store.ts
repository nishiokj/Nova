import { ContextWindow } from 'context';
import type { GraphDManager } from 'graphd';
import type { ContextWindowSnapshot, SessionPermissionState } from 'types';
import type { ModelSelection } from 'agent';
import type { HandoffSpec } from 'protocol';
import { PermissionChecker } from './permissions.js';
import path from 'path';

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

export interface PausedState {
  goal: string;
  agentType: string;
  workingDir: string;
  planMode?: boolean;
  userPromptType?: string;
  handoffSpec?: HandoffSpec; // Stored for execution after user approval
  pausedAt: number; // Timestamp when session entered paused state
}

export type PausedWorkItemStatus = 'pending' | 'resolved' | 'cancelled';

export interface PausedWorkItemState {
  workId: string;
  agentType: string;
  objective?: string;
  reason: string;
  escalationId?: string;
  status: PausedWorkItemStatus;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  resolutionSummary?: string;
}

function normalizeHandoffSpec(value: unknown): HandoffSpec | undefined {
  if (!value) return undefined;
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
  if (typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const spec = candidate as HandoffSpec;
  if (typeof spec.goal !== 'string' || typeof spec.context !== 'string' || !Array.isArray(spec.workItems)) {
    return undefined;
  }
  return spec;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asPositiveTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizePausedWorkItemStatus(value: unknown): PausedWorkItemStatus {
  switch (value) {
    case 'pending':
    case 'resolved':
    case 'cancelled':
      return value;
    default:
      return 'pending';
  }
}

function normalizePausedWorkItem(value: unknown): PausedWorkItemState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const workId = asNonEmptyString(input.workId);
  const agentType = asNonEmptyString(input.agentType);
  const reason = asNonEmptyString(input.reason);
  if (!workId || !agentType || !reason) return null;
  const objective = asNonEmptyString(input.objective);
  const escalationId = asNonEmptyString(input.escalationId);

  const createdAt = asPositiveTimestamp(input.createdAt) ?? Date.now();
  const updatedAt = asPositiveTimestamp(input.updatedAt) ?? createdAt;
  const resolvedAt = asPositiveTimestamp(input.resolvedAt);
  const resolutionSummary = asNonEmptyString(input.resolutionSummary);

  return {
    workId,
    agentType,
    ...(objective ? { objective } : {}),
    reason,
    ...(escalationId ? { escalationId } : {}),
    status: normalizePausedWorkItemStatus(input.status),
    createdAt,
    updatedAt,
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(resolutionSummary ? { resolutionSummary } : {}),
  };
}

/**
 * Build an interruption directive that wraps the user's message with guidance.
 * This helps the agent understand the message arrived mid-execution and how to handle it.
 */
function buildInterruptionDirective(userMessage: string): string {
  return `**User Interruption**: "${userMessage}"

Consider if the user is:
- Asking you to stop current work
- Requesting a pivot to a different task
- Providing information that invalidates your current action
- Adding context as an addendum

Acknowledge the interruption and adjust your approach accordingly.`;
}

/** Info about an active async run for a session */
export interface AsyncRunInfo {
  requestId: string;
  goal: string;
  cancelled: boolean;
  startedAt: number;
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
  private pausedState: PausedState | null = null;
  private pausedWorkItems = new Map<string, PausedWorkItemState>();
  private modelSelections = new Map<string, ModelSelection>();
  private asyncModeEnabled = false;

  // Execution tracking: prevents race conditions when user sends messages during agent execution
  private executingRequestId: string | null = null;
  private queuedUserMessages: Array<{ requestId: string; message: string }> = [];

  // Session-level exclusive operation tracking (prevents multiple connections from starting concurrent ops)
  private asyncRun: AsyncRunInfo | null = null;

  constructor(options: SessionStoreOptions) {
    this.sessionKey = options.sessionKey;
    this.maxTokens = options.maxTokens;
    this.graphd = options.graphd;
    this.isGraphDReady = options.isGraphDReady;
    this.logger = options.logger;
    this.workingDir = options.workingDir ?? process.cwd();
    const date = new Date().toISOString().split('T')[0];
    this.contextFilePath = path.join(this.workingDir, '.haiku', 'sessions', date, options.sessionKey, 'context.md');

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

    // First, recover paused state from GraphD metadata if it exists
    this.recoverPausedState();

    // Try to hydrate from GraphD
    if (this.isGraphDReady() && this.graphd) {
      try {
        const result = this.graphd.contextGet(this.sessionKey) as {
          snapshot?: { context?: ContextWindowSnapshot };
          error?: string;
        };
        if (result.snapshot?.context) {
          this.context = ContextWindow.deserialize(result.snapshot.context, this.contextFilePath);
          this.logger.debug('Hydrated context from GraphD', {
            sessionKey: this.sessionKey,
            itemCount: this.context.items.length,
            version: this.context.version,
          });
          return this.context;
        }
      } catch (error) {
        this.logger.warning('Failed to hydrate context from GraphD', {
          sessionKey: this.sessionKey,
          error: String(error),
        });
      }
    }

    this.context = new ContextWindow(this.sessionKey, this.maxTokens, this.contextFilePath);
    this.logger.debug('Created new context', { sessionKey: this.sessionKey, maxTokens: this.maxTokens, path: this.contextFilePath });
    return this.context;
  }

  /**
   * Recover paused state from GraphD session metadata.
   * Called during context hydration to restore session pause state.
   */
  private recoverPausedState(): void {
    if (!this.isGraphDReady() || !this.graphd) {
      return;
    }

    try {
      const session = this.graphd.sessionGet(this.sessionKey);
      const metadata = session?.metadata as Record<string, unknown> | undefined;
      const pausedStateMetadata = metadata?.paused_state as Omit<PausedState, 'pausedAt'> | undefined;

      if (pausedStateMetadata) {
        const normalizedHandoffSpec = normalizeHandoffSpec(pausedStateMetadata.handoffSpec);
        if (pausedStateMetadata.handoffSpec && !normalizedHandoffSpec) {
          this.logger.warning('Dropped invalid paused handoffSpec from metadata', { sessionKey: this.sessionKey });
        }
        this.pausedState = {
          ...pausedStateMetadata,
          handoffSpec: normalizedHandoffSpec,
          pausedAt: Date.now(),
        };
        this.logger.debug('Recovered paused state from GraphD', {
          sessionKey: this.sessionKey,
          goal: this.pausedState.goal,
          agentType: this.pausedState.agentType,
        });
      }

      const pausedWorkItemsRaw = metadata?.paused_work_items;
      const pausedWorkItems = Array.isArray(pausedWorkItemsRaw)
        ? pausedWorkItemsRaw.map((entry) => normalizePausedWorkItem(entry)).filter((entry): entry is PausedWorkItemState => entry !== null)
        : [];
      if (pausedWorkItems.length > 0) {
        this.pausedWorkItems.clear();
        for (const item of pausedWorkItems) {
          this.pausedWorkItems.set(item.workId, item);
        }
        this.logger.debug('Recovered paused work items from GraphD', {
          sessionKey: this.sessionKey,
          count: pausedWorkItems.length,
        });
      }

      // Hydrate session state (model selections, permissions) from metadata
      if (metadata) {
        this.hydrateSessionState(metadata);
      }
    } catch (error) {
      this.logger.warning('Failed to recover paused state from GraphD', {
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

  setPausedState(state: Omit<PausedState, 'pausedAt'>): void {
    this.pausedState = { ...state, pausedAt: Date.now() };
    // Persist paused state to GraphD session metadata for recovery
    if (this.isGraphDReady() && this.graphd) {
      try {
        this.graphd.sessionUpdateMetadata(this.sessionKey, { paused_state: state });
        this.logger.debug('Persisted paused state to GraphD', {
          sessionKey: this.sessionKey,
          goal: state.goal,
          agentType: state.agentType,
        });
      } catch (error) {
        this.logger.warning('Failed to persist paused state to GraphD', {
          sessionKey: this.sessionKey,
          error: String(error),
        });
      }
    }
  }

  getPausedState(): PausedState | null {
    return this.pausedState;
  }

  upsertPausedWorkItem(input: {
    workId: string;
    agentType: string;
    objective?: string;
    reason: string;
    escalationId?: string;
    status?: PausedWorkItemStatus;
    timestamp?: number;
  }): PausedWorkItemState {
    const now = input.timestamp ?? Date.now();
    const existing = this.pausedWorkItems.get(input.workId);
    const next: PausedWorkItemState = {
      workId: input.workId,
      agentType: input.agentType,
      ...(input.objective ? { objective: input.objective } : existing?.objective ? { objective: existing.objective } : {}),
      reason: input.reason,
      ...(input.escalationId ? { escalationId: input.escalationId } : existing?.escalationId ? { escalationId: existing.escalationId } : {}),
      status: input.status ?? 'pending',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.resolvedAt ? { resolvedAt: existing.resolvedAt } : {}),
      ...(existing?.resolutionSummary ? { resolutionSummary: existing.resolutionSummary } : {}),
    };
    this.pausedWorkItems.set(input.workId, next);
    this.persistPausedWorkItems();
    return next;
  }

  listPausedWorkItems(): PausedWorkItemState[] {
    return Array.from(this.pausedWorkItems.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  resolvePausedWorkItem(workId: string, resolutionSummary?: string, timestamp: number = Date.now()): PausedWorkItemState | null {
    const existing = this.pausedWorkItems.get(workId);
    if (!existing) return null;
    if (existing.status === 'resolved' || existing.status === 'cancelled') return existing;

    const next: PausedWorkItemState = {
      ...existing,
      status: 'resolved',
      updatedAt: timestamp,
      resolvedAt: timestamp,
      ...(resolutionSummary ? { resolutionSummary } : {}),
    };
    this.pausedWorkItems.set(workId, next);
    this.persistPausedWorkItems();
    return next;
  }

  cancelPausedWorkItem(workId: string, resolutionSummary?: string, timestamp: number = Date.now()): PausedWorkItemState | null {
    const existing = this.pausedWorkItems.get(workId);
    if (!existing) return null;
    if (existing.status === 'resolved' || existing.status === 'cancelled') return existing;

    const next: PausedWorkItemState = {
      ...existing,
      status: 'cancelled',
      updatedAt: timestamp,
      resolvedAt: timestamp,
      ...(resolutionSummary ? { resolutionSummary } : {}),
    };
    this.pausedWorkItems.set(workId, next);
    this.persistPausedWorkItems();
    return next;
  }

  private persistPausedWorkItems(): void {
    if (!this.isGraphDReady() || !this.graphd) return;
    try {
      this.graphd.sessionUpdateMetadata(this.sessionKey, {
        paused_work_items: Array.from(this.pausedWorkItems.values()),
      });
    } catch (error) {
      this.logger.warning('Failed to persist paused work items to GraphD', {
        sessionKey: this.sessionKey,
        error: String(error),
      });
    }
  }

  clearPausedState(): void {
    this.pausedState = null;
    // Clear paused state from GraphD session metadata
    if (this.isGraphDReady() && this.graphd) {
      try {
        this.graphd.sessionUpdateMetadata(this.sessionKey, { paused_state: null });
        this.logger.debug('Cleared paused state from GraphD', { sessionKey: this.sessionKey });
      } catch (error) {
        this.logger.warning('Failed to clear paused state from GraphD', {
          sessionKey: this.sessionKey,
          error: String(error),
        });
      }
    }
  }

  close(): void {
    this.persistContext();
    this.context = null;
    this.pausedState = null;
    this.pausedWorkItems.clear();
    this.modelSelections.clear();
    this.asyncRun = null;
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
  startExecution(requestId: string): boolean {
    if (this.executingRequestId !== null) {
      return false;
    }
    this.executingRequestId = requestId;
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

  /**
   * Mark execution as complete and return any queued user messages.
   * Messages should be injected into context before next agent turn.
   */
  endExecution(): Array<{ requestId: string; message: string }> {
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

  /**
   * Check if any pending user message is a stop request.
   * Used by agent to exit loop early on explicit user stop.
   */
  hasPendingStopRequest(): boolean {
    return this.queuedUserMessages.some(({ message }) => /\bstop\b/i.test(message));
  }
}
