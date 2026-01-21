import { ContextWindow } from 'context';
import type { GraphDManager } from 'graphd';
import type { ContextWindowSnapshot } from 'types';
import type { ModelSelection } from 'agent';

export interface HarnessLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  warning(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  flush?(): void;
}

export interface PausedState {
  goal: string;
  agentType: string;
  workingDir: string;
  planMode?: boolean;
  userPromptType?: string;
  handoffSpec?: string; // Stored for execution after user approval
  pausedAt: number; // Timestamp when session entered paused state
}

interface SessionStoreOptions {
  sessionKey: string;
  maxTokens: number;
  graphd: GraphDManager | null;
  isGraphDReady: () => boolean;
  logger: HarnessLogger;
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

export class SessionStore {
  private readonly sessionKey: string;
  private readonly maxTokens: number;
  private readonly graphd: GraphDManager | null;
  private readonly isGraphDReady: () => boolean;
  private readonly logger: HarnessLogger;
  private context: ContextWindow | null = null;
  private pausedState: PausedState | null = null;
  private modelSelections = new Map<string, ModelSelection>();

  // Execution tracking: prevents race conditions when user sends messages during agent execution
  private executingRequestId: string | null = null;
  private queuedUserMessages: Array<{ requestId: string; message: string }> = [];

  constructor(options: SessionStoreOptions) {
    this.sessionKey = options.sessionKey;
    this.maxTokens = options.maxTokens;
    this.graphd = options.graphd;
    this.isGraphDReady = options.isGraphDReady;
    this.logger = options.logger;
  }

  getContext(): ContextWindow {
    if (this.context) {
      return this.context;
    }

    if (this.isGraphDReady() && this.graphd) {
      try {
        const result = this.graphd.contextGet(this.sessionKey) as {
          snapshot?: { context?: ContextWindowSnapshot };
          error?: string;
        };
        if (result.snapshot?.context) {
          this.context = ContextWindow.deserialize(result.snapshot.context);
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

    this.context = new ContextWindow(this.sessionKey, this.maxTokens);
    this.logger.debug('Created new context', { sessionKey: this.sessionKey, maxTokens: this.maxTokens });
    return this.context;
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
    this.context = new ContextWindow(this.sessionKey, this.maxTokens);
    this.logger.debug('Cleared context for handoff', { sessionKey: this.sessionKey });
    return this.context;
  }

  hydrateFromSnapshot(snapshot: ContextWindowSnapshot): void {
    this.context = ContextWindow.deserialize(snapshot);
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

  touch(workingDir: string): void {
    if (!this.isGraphDReady() || !this.graphd) return;
    this.graphd.sessionTouch(this.sessionKey, workingDir);
  }

  setPausedState(state: Omit<PausedState, 'pausedAt'>): void {
    this.pausedState = { ...state, pausedAt: Date.now() };
  }

  getPausedState(): PausedState | null {
    return this.pausedState;
  }

  hasPausedState(): boolean {
    return this.pausedState !== null;
  }

  clearPausedState(): void {
    this.pausedState = null;
  }

  close(): void {
    this.persistContext();
    this.context = null;
    this.pausedState = null;
    this.modelSelections.clear();
  }

  /**
   * Set model selection for a specific agent type.
   */
  setModelSelection(agentType: string, selection: ModelSelection): void {
    this.modelSelections.set(agentType, selection);
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
    this.modelSelections.clear();
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
   * Attempt to end execution only if no queued messages are waiting.
   * Returns true if execution ended; false if messages are still queued.
   */
  endExecutionIfIdle(): boolean {
    if (this.queuedUserMessages.length > 0) {
      return false;
    }
    this.executingRequestId = null;
    return true;
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
