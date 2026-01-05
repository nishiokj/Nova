/**
 * AgentHarness - Main entry point for wiring the TypeScript agent to the TUI.
 *
 * Wraps the Agent class and provides a TUI-compatible interface with:
 * - Event translation from WizardEvent to BridgeEvent
 * - Async event streaming via AsyncIterable
 * - Session state management via GraphD
 */

import { Agent, type AgentConfig } from '../agent/agent.js';
import { createAdapter } from '../llm/adapter.js';
import { ToolRegistry } from '../tools/registry.js';
import { builtinToolOptions } from '../tools/builtins/index.js';
import { GraphDManager, createGraphDConfig } from '../graphd/index.js';
import type { WizardEvent } from '../types/events.js';
import type { LLMConfig } from '../types/llm.js';
import { ContextWindow, type ContextWindowSnapshot } from '../types/context.js';
import { EventBus, type EventBusProtocol, GraphDSubscriber, LogSubscriber, createLogSubscriber } from '../communication/index.js';
import path from 'path';
import {
  translateWizardEvent,
  createStreamEvent,
  createStatusEvent,
  createResponseEvent,
  createErrorEvent,
  createReadyEvent,
} from './event_translator.js';
import type {
  AgentRunParams,
  AgentRunResult,
  AgentRunHandle,
  BridgeEvent,
  UserPromptInfo,
} from './types.js';
import { loadConfig, getLLMConfigForTier } from './config_loader.js';
import type { FullHarnessConfig, Tier } from './config_types.js';

/**
 * Simple async queue for streaming events.
 */
class AsyncEventQueue {
  private queue: BridgeEvent[] = [];
  private resolvers: Array<(value: IteratorResult<BridgeEvent>) => void> = [];
  private done = false;

  push(event: BridgeEvent): void {
    if (this.done) return;

    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  finish(): void {
    this.done = true;
    for (const resolve of this.resolvers) {
      resolve({ value: undefined as unknown as BridgeEvent, done: true });
    }
    this.resolvers = [];
  }

  async next(): Promise<IteratorResult<BridgeEvent>> {
    if (this.queue.length > 0) {
      return { value: this.queue.shift()!, done: false };
    }

    if (this.done) {
      return { value: undefined as unknown as BridgeEvent, done: true };
    }

    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<BridgeEvent> {
    return {
      next: () => this.next(),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

/**
 * Logger interface for harness.
 */
interface HarnessLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  warning(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Console logger implementation.
 */
const consoleLogger: HarnessLogger = {
  info: (msg, meta) => console.log(`[INFO] ${msg}`, meta ?? ''),
  debug: (msg, meta) => console.debug(`[DEBUG] ${msg}`, meta ?? ''),
  warning: (msg, meta) => console.warn(`[WARN] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta ?? ''),
};

/**
 * AgentHarness - Wraps the TypeScript Agent for TUI integration.
 */
export class AgentHarness {
  private config: FullHarnessConfig;
  private agent: Agent;
  private toolRegistry: ToolRegistry;
  /** Context windows for active sessions */
  private contextWindows = new Map<string, ContextWindow>();
  private logger: HarnessLogger;
  private isShutdown = false;
  private graphd: GraphDManager | null = null;
  private graphdStarted = false;
  private graphdSubscribers = new Map<string, GraphDSubscriber>();
  private eventBus: EventBus;
  private logSubscriber: LogSubscriber | null = null;
  private llm: ReturnType<typeof createAdapter>;
  private llmConfig: LLMConfig;
  private agentConfig: AgentConfig;

  constructor(config: FullHarnessConfig, logger?: HarnessLogger) {
    this.config = config;
    this.logger = logger ?? consoleLogger;

    // Create EventBus - central pub/sub for all events
    this.eventBus = new EventBus();

    // Create LogSubscriber for agent events
    // This writes ALL events to disk for debugging/observability
    const logsDir = path.join(config.tools.workingDir, 'logs');
    try {
      this.logSubscriber = createLogSubscriber(this.eventBus, logsDir, 'agent_events.log');
      this.logger.info('LogSubscriber created', { logPath: path.join(logsDir, 'agent_events.log') });
    } catch (error) {
      this.logger.warning('Failed to create LogSubscriber', { error: String(error) });
    }

    // Create LLM adapter from resolved config
    this.llmConfig = {
      provider: config.llm.provider,
      model: config.llm.model,
      apiKey: config.llm.apiKey,
      maxTokens: config.llm.maxTokens ?? 4096,
      temperature: config.llm.temperature,
      baseUrl: config.llm.baseUrl,
    };
    this.llm = createAdapter(this.llmConfig);

    const workingDir = config.tools.workingDir;

    // Create tool registry with config-driven enabled tools
    this.toolRegistry = new ToolRegistry(
      {
        enabledTools: config.tools.enabledTools,
        bashTimeoutMs: config.tools.bashTimeout,
        maxOutputLength: config.tools.maxOutputLength,
      },
      workingDir
    );

    // Register builtin tools
    for (const toolOptions of builtinToolOptions) {
      this.toolRegistry.register(toolOptions);
    }

    // Create agent config with tier-aware settings
    this.agentConfig = {
      systemPrompt: config.agent.systemPrompt,
      maxIterations: config.agent.maxIterations ?? 50,
      enablePlanning: config.agent.enablePlanning ?? true,
      enableScouting: config.agent.enableScouting ?? true,
      behavioralRules: config.agent.behavioralRules,
    };

    // Create agent with EventBus
    this.agent = new Agent(
      this.agentConfig,
      this.toolRegistry,
      this.llm,
      this.logger,
      this.eventBus
    );

    // Initialize GraphD if enabled
    if (config.graphd.enabled) {
      const graphdConfig = createGraphDConfig(workingDir, {
        host: config.graphd.host,
        port: config.graphd.port,
        dbPath: config.graphd.dbPath,
      });
      this.graphd = new GraphDManager(graphdConfig);
    }

    this.logger.info('AgentHarness initialized', {
      provider: config.llm.provider,
      model: this.llmConfig.model,
      enabledTools: config.tools.enabledTools,
      graphdEnabled: this.graphd !== null,
    });
  }

  /**
   * Get the EventBus for external subscribers (logger, dashboard, etc.)
   */
  getEventBus(): EventBusProtocol {
    return this.eventBus;
  }

  /**
   * Start async services (GraphD).
   * Call this before run() if using GraphD.
   */
  async start(): Promise<boolean> {
    if (this.graphd && !this.graphdStarted) {
      try {
        const started = await this.graphd.start();
        this.graphdStarted = started;
        if (started) {
          this.logger.info('GraphD started', {
            port: this.config.graphd.port,
            dbPath: this.config.graphd.dbPath,
            reusing: this.graphd.isReusing(),
          });
        }
      } catch (error) {
        // Propagate the detailed error from GraphDManager
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error('GraphD failed to start', { error: message });
        throw error;
      }
    }
    return true;
  }

  private getDefaultModel(provider: 'anthropic' | 'openai'): string {
    return provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o';
  }

  /**
   * Get or create a ContextWindow for the session.
   * Attempts to hydrate from GraphD if available.
   */
  private getOrCreateContext(sessionKey: string): ContextWindow {
    // Check in-memory cache first
    let context = this.contextWindows.get(sessionKey);
    if (context) {
      return context;
    }

    // Try to hydrate from GraphD
    if (this.graphd && this.graphdStarted) {
      try {
        const result = this.graphd.contextGet(sessionKey) as {
          snapshot?: { context?: ContextWindowSnapshot };
          error?: string;
        };
        if (result.snapshot && result.snapshot.context) {
          context = ContextWindow.deserialize(result.snapshot.context);
          this.contextWindows.set(sessionKey, context);
          this.logger.debug('Hydrated context from GraphD', {
            sessionKey,
            itemCount: context.items.length,
            version: context.version,
          });
          return context;
        }
      } catch (error) {
        this.logger.warning('Failed to hydrate context from GraphD', {
          sessionKey,
          error: String(error),
        });
      }
    }

    // Create new context
    const maxTokens = this.config.agent.maxContextTokens ?? 200_000;
    context = new ContextWindow(sessionKey, maxTokens);
    this.contextWindows.set(sessionKey, context);
    this.logger.debug('Created new context', { sessionKey, maxTokens });
    return context;
  }

  /**
   * Persist a ContextWindow to GraphD.
   */
  private persistContext(context: ContextWindow): void {
    if (!this.graphd || !this.graphdStarted) return;

    try {
      // Serialize context snapshot as a generic record for GraphD storage
      const snapshot = context.serialize();
      this.graphd.contextSave(context.sessionKey, { context: snapshot });
      this.logger.debug('Persisted context to GraphD', {
        sessionKey: context.sessionKey,
        itemCount: context.items.length,
        version: context.version,
      });
    } catch (error) {
      this.logger.warning('Failed to persist context to GraphD', {
        sessionKey: context.sessionKey,
        error: String(error),
      });
    }
  }

  /**
   * Run the agent with the given parameters.
   * Returns a handle with a result promise and an async event stream.
   */
  run(params: AgentRunParams): AgentRunHandle {
    const { requestId, inputText, tier = 'standard', sessionKey, context } = params;
    const eventQueue = new AsyncEventQueue();

    // Emit initial status
    eventQueue.push(createStatusEvent('sending', 'Processing request...'));

    // Touch session in GraphD (creates if needed)
    if (this.graphd && this.graphdStarted) {
      try {
        this.graphd.sessionTouch(sessionKey, this.config.tools.workingDir);
        this.graphd.setActive(true);

        // Set session metadata for dashboard (user_id is required by dashboard mapper)
        this.graphd.sessionUpdateMetadata(sessionKey, {
          user_id: 'local-user', // Could be from config or context in a multi-user setup
          tier,
          model: this.llmConfig.model,
          provider: this.llmConfig.provider,
        });

        // Create or get GraphDSubscriber for this session
        let subscriber = this.graphdSubscribers.get(sessionKey);
        if (!subscriber) {
          subscriber = new GraphDSubscriber(this.eventBus, this.graphd, {
            sessionKey,
            requestId,
          });
          this.graphdSubscribers.set(sessionKey, subscriber);
          this.logger.debug('Created GraphDSubscriber for session', { sessionKey });
        } else {
          // Update request ID for existing subscriber
          subscriber.setRequestId(requestId);
        }
      } catch (error) {
        this.logger.warning('GraphD session touch failed', { error: String(error) });
      }
    }

    // Get tier-specific LLM config and create adapter for this run
    const tierKey = tier as Tier;
    const tierLLMConfig = getLLMConfigForTier(this.config, tierKey);
    const tierToolLimit = this.config.agent.tierToolLimits[tierKey] ?? this.config.agent.maxIterations ?? 50;

    this.logger.debug('Running with tier config', {
      tier,
      model: tierLLMConfig.model,
      toolLimit: tierToolLimit,
    });

    // Create tier-specific adapter if model differs from current
    let runAdapter = this.llm;
    if (tierLLMConfig.model !== this.llmConfig.model || tierLLMConfig.provider !== this.llmConfig.provider) {
      const tierAdapterConfig = {
        provider: tierLLMConfig.provider,
        model: tierLLMConfig.model,
        apiKey: tierLLMConfig.apiKey,
        maxTokens: tierLLMConfig.maxTokens ?? 4096,
        temperature: tierLLMConfig.temperature,
        baseUrl: tierLLMConfig.baseUrl,
      };
      runAdapter = createAdapter(tierAdapterConfig);
      this.logger.info('Created tier-specific adapter', {
        tier,
        model: tierLLMConfig.model,
        provider: tierLLMConfig.provider,
      });
    }

    // Create agent for this run with the tier-specific adapter and tool limit
    const runAgentConfig: AgentConfig = {
      ...this.agentConfig,
      maxIterations: tierToolLimit,
    };
    const runAgent = new Agent(
      runAgentConfig,
      this.toolRegistry,
      runAdapter,
      this.logger,
      this.eventBus
    );

    // Get or create context window for this session
    const contextWindow = this.getOrCreateContext(sessionKey);

    // Track streaming state
    let chunkIndex = 0;

    // Subscribe to EventBus for this request's events
    // Translate WizardEvents to BridgeEvents for the TUI
    const unsubscribe = this.eventBus.subscribeAll((event: WizardEvent): void => {
      const bridgeEvent = translateWizardEvent(event, requestId);
      if (bridgeEvent) {
        eventQueue.push(bridgeEvent);
      }
    });

    // Stream callback
    const onStreamChunk = (chunk: string, index: number, isFinal: boolean): void => {
      if (chunkIndex === 0) {
        eventQueue.push(createStatusEvent('streaming'));
      }
      eventQueue.push(createStreamEvent(requestId, chunk, chunkIndex++, isFinal));
    };

    // Run the agent with tier-specific config
    const resultPromise = (async (): Promise<AgentRunResult> => {
      try {
        // Agent.run() now takes ContextWindow instead of SessionContext
        const response = await runAgent.run(
          inputText,
          contextWindow,
          context, // additional context string for planning
          tier,
          undefined, // budget
          onStreamChunk
        );

        // Context is already updated by Agent/Wizard - no need to update session state

        // Build result
        const result: AgentRunResult = {
          requestId,
          sessionKey,
          success: response.success,
          finalText: response.content,
          errorMessage: response.error,
          paused: response.paused,
          toolsUsed: response.toolsUsed,
          durationMs: response.totalDurationMs,
          metadata: response.metadata,
        };

        // Handle user prompt if paused
        if (response.paused && response.userPrompt) {
          result.userPrompt = {
            requestId,
            question: String(response.userPrompt.question ?? 'Please provide input:'),
            options: response.userPrompt.options as Array<string | { label: string; description?: string }>,
            context: String(response.userPrompt.context ?? ''),
            multiSelect: Boolean(response.userPrompt.multiSelect),
          };
        }

        // Emit response event
        eventQueue.push(
          createResponseEvent(
            requestId,
            response.success,
            response.content,
            response.toolsUsed,
            response.totalDurationMs,
            response.error,
            response.metadata
          )
        );

        // Emit idle status
        eventQueue.push(createStatusEvent('idle'));

        // Persist to GraphD (events are persisted in real-time via GraphDSubscriber)
        this.persistToGraphD(sessionKey, requestId, inputText, response.content, response.totalDurationMs);

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('Agent run failed', { error: errorMessage, requestId });

        eventQueue.push(createErrorEvent(errorMessage, false));
        eventQueue.push(createStatusEvent('error', errorMessage));

        return {
          requestId,
          sessionKey,
          success: false,
          finalText: '',
          errorMessage,
          paused: false,
          toolsUsed: [],
          durationMs: 0,
        };
      } finally {
        // Unsubscribe from EventBus
        unsubscribe();

        // Persist context to GraphD
        this.persistContext(contextWindow);

        // Mark agent as inactive
        if (this.graphd && this.graphdStarted) {
          try {
            this.graphd.setActive(false);
          } catch {
            // Ignore errors during cleanup
          }
        }
        eventQueue.finish();
      }
    })();

    return {
      result: resultPromise,
      events: eventQueue,
    };
  }

  /**
   * Persist session data to GraphD.
   * Note: Events are persisted in real-time via GraphDSubscriber.
   */
  private persistToGraphD(
    sessionKey: string,
    requestId: string,
    userInput: string,
    assistantResponse: string,
    durationMs: number
  ): void {
    if (!this.graphd || !this.graphdStarted) return;

    try {
      // Store user message
      this.graphd.messageAdd(sessionKey, 'user', userInput, requestId);

      // Store assistant response
      this.graphd.messageAdd(sessionKey, 'assistant', assistantResponse, requestId, {
        duration_ms: durationMs,
      });

      // Update session metadata with request info
      this.graphd.sessionUpdateMetadata(sessionKey, {
        last_request_id: requestId,
        last_duration_ms: durationMs,
      });
    } catch (error) {
      this.logger.warning('GraphD persist failed', { error: String(error) });
    }
  }

  /**
   * Resume agent execution after user provides input.
   */
  resume(requestId: string, answer: string, sessionKey: string): AgentRunHandle {
    const eventQueue = new AsyncEventQueue();

    // Emit resuming status
    eventQueue.push(createStatusEvent('sending', 'Resuming with your response...'));

    // Update GraphDSubscriber request ID for this resume
    const subscriber = this.graphdSubscribers.get(sessionKey);
    if (subscriber) {
      subscriber.setRequestId(requestId);
    }

    // Get context window for this session
    const contextWindow = this.getOrCreateContext(sessionKey);
    let chunkIndex = 0;

    // Subscribe to EventBus for this request's events
    const unsubscribe = this.eventBus.subscribeAll((event: WizardEvent): void => {
      const bridgeEvent = translateWizardEvent(event, requestId);
      if (bridgeEvent) {
        eventQueue.push(bridgeEvent);
      }
    });

    const onStreamChunk = (chunk: string, index: number, isFinal: boolean): void => {
      if (chunkIndex === 0) {
        eventQueue.push(createStatusEvent('streaming'));
      }
      eventQueue.push(createStreamEvent(requestId, chunk, chunkIndex++, isFinal));
    };

    const resultPromise = (async (): Promise<AgentRunResult> => {
      try {
        // Agent.resume() now takes ContextWindow
        const response = await this.agent.resume(contextWindow, answer, onStreamChunk);

        // Context is already updated by Agent/Wizard - no need to update session state

        const result: AgentRunResult = {
          requestId,
          sessionKey,
          success: response.success,
          finalText: response.content,
          errorMessage: response.error,
          paused: response.paused,
          toolsUsed: response.toolsUsed,
          durationMs: response.totalDurationMs,
          metadata: response.metadata,
        };

        if (response.paused && response.userPrompt) {
          result.userPrompt = {
            requestId,
            question: String(response.userPrompt.question ?? 'Please provide input:'),
            options: response.userPrompt.options as Array<string | { label: string; description?: string }>,
            context: String(response.userPrompt.context ?? ''),
            multiSelect: Boolean(response.userPrompt.multiSelect),
          };
        }

        eventQueue.push(
          createResponseEvent(
            requestId,
            response.success,
            response.content,
            response.toolsUsed,
            response.totalDurationMs,
            response.error,
            response.metadata
          )
        );

        eventQueue.push(createStatusEvent('idle'));

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('Agent resume failed', { error: errorMessage, requestId });

        eventQueue.push(createErrorEvent(errorMessage, false));
        eventQueue.push(createStatusEvent('error', errorMessage));

        return {
          requestId,
          sessionKey,
          success: false,
          finalText: '',
          errorMessage,
          paused: false,
          toolsUsed: [],
          durationMs: 0,
        };
      } finally {
        // Unsubscribe from EventBus
        unsubscribe();

        // Persist context to GraphD
        this.persistContext(contextWindow);

        eventQueue.finish();
      }
    })();

    return {
      result: resultPromise,
      events: eventQueue,
    };
  }

  /**
   * Create a ready event for initialization.
   */
  createReadyEvent(sessionKey: string): BridgeEvent {
    const configSummary = `Provider: ${this.config.llm.provider}, Model: ${this.config.llm.model}`;
    return createReadyEvent(sessionKey, configSummary);
  }

  /**
   * Get the loaded configuration (for TUI integration).
   */
  getConfig(): FullHarnessConfig {
    return this.config;
  }

  /**
   * Shutdown the harness.
   */
  async shutdown(): Promise<void> {
    if (this.isShutdown) return;
    this.isShutdown = true;

    // Close all GraphDSubscribers first (they flush pending events)
    // Also collect session keys to close
    const sessionKeysToClose: string[] = [];
    for (const [sessionKey, subscriber] of this.graphdSubscribers) {
      try {
        subscriber.close();
        sessionKeysToClose.push(sessionKey);
        this.logger.debug('Closed GraphDSubscriber', { sessionKey });
      } catch (error) {
        this.logger.warning('GraphDSubscriber close failed', { sessionKey, error: String(error) });
      }
    }
    this.graphdSubscribers.clear();

    // Close sessions in GraphD before stopping the server
    if (this.graphd && this.graphdStarted) {
      for (const sessionKey of sessionKeysToClose) {
        try {
          this.graphd.sessionClose(sessionKey);
          this.logger.debug('Closed GraphD session', { sessionKey });
        } catch (error) {
          this.logger.warning('GraphD session close failed', { sessionKey, error: String(error) });
        }
      }
    }

    // Close LogSubscriber (flushes pending events)
    if (this.logSubscriber) {
      try {
        this.logSubscriber.close();
        this.logger.debug('Closed LogSubscriber');
      } catch (error) {
        this.logger.warning('LogSubscriber close failed', { error: String(error) });
      }
    }

    // Shutdown EventBus
    this.eventBus.shutdown();

    // Stop GraphD
    if (this.graphd && this.graphdStarted) {
      try {
        await this.graphd.stop();
        this.logger.info('GraphD stopped');
      } catch (error) {
        this.logger.warning('GraphD stop failed', { error: String(error) });
      }
    }

    this.contextWindows.clear();
    this.toolRegistry.clearCache();
    this.logger.info('AgentHarness shutdown');
  }

  /**
   * Check if the harness is shut down.
   */
  isShuttingDown(): boolean {
    return this.isShutdown;
  }
}

/**
 * Create an AgentHarness from configuration file with environment overrides.
 * Tries to load config/harness_config.json, falls back to env-only mode.
 *
 * @param workingDir - Working directory for tools
 * @param configPath - Optional explicit path to config file
 * @param tier - Initial tier for LLM selection (default: 'standard')
 */
export function createHarnessFromEnv(
  workingDir?: string,
  configPath?: string,
  tier: Tier = 'standard'
): AgentHarness {
  const config = loadConfig(configPath, workingDir, tier);
  return new AgentHarness(config);
}
