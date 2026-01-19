import { ContextWindow } from 'context';
import type { GraphDManager } from 'graphd';
import type { ContextWindowSnapshot } from 'types';
import type { ModelOverride } from 'orchestrator';

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
}

interface SessionStoreOptions {
  sessionKey: string;
  maxTokens: number;
  graphd: GraphDManager | null;
  isGraphDReady: () => boolean;
  logger: HarnessLogger;
}

export class SessionStore {
  private readonly sessionKey: string;
  private readonly maxTokens: number;
  private readonly graphd: GraphDManager | null;
  private readonly isGraphDReady: () => boolean;
  private readonly logger: HarnessLogger;
  private context: ContextWindow | null = null;
  private pausedState: PausedState | null = null;
  private modelOverride: ModelOverride | null = null;

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

  setPausedState(state: PausedState): void {
    this.pausedState = state;
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
    this.modelOverride = null;
  }

  setModelOverride(override: ModelOverride | null): void {
    this.modelOverride = override;
  }

  getModelOverride(): ModelOverride | null {
    return this.modelOverride;
  }

  clearModelOverride(): void {
    this.modelOverride = null;
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
   * The message is added to the context window immediately so the agent sees it.
   */
  queueUserMessage(requestId: string, message: string): void {
    this.queuedUserMessages.push({ requestId, message });
    // Add to context immediately so agent sees it on next LLM call
    const ctx = this.getContext();
    ctx.addMessage('user', message);
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
}
