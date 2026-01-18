import { ContextWindow } from 'context';
import type { ContextWindowSnapshot } from 'types';
import type { GraphDManager } from 'graphd';

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
  }
}
