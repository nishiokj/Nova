/**
 * AgentHarness - Main entry point for wiring the TypeScript agent to the TUI.
 *
 * Wraps the Agent/Orchestrator classes and provides a TUI-compatible interface with:
 * - Event translation from AgentEvent to BridgeEvent
 * - Async event streaming via AsyncIterable
 * - Session state management via GraphD
 *
 * Configuration is loaded from config/harness_config.json which is the
 * SINGLE SOURCE OF TRUTH for agent LLM assignments, budgets, and tools.
 */

import { Agent } from '../agent/agent.js';
import { AgentRegistry } from '../agent/agent-registry.js';
import type { AgentConfig } from '../agent/types.js';
import { getAgentPrompt, buildAgentConfig } from '../agent/prompts.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { createAdapter } from '../llm/adapter.js';
import { ToolRegistry } from '../tools/registry.js';
import { builtinToolOptions } from '../tools/builtins/index.js';
import { GraphDManager, createGraphDConfig } from '../graphd/index.js';
import { createEvent, type AgentEvent } from '../types/events.js';
import { ContextWindow, type ContextWindowSnapshot } from '../types/context.js';
import { EventBus, type EventBusProtocol, GraphDSubscriber, LogSubscriber, createLogSubscriber, createEventEmitCallback } from '../communication/index.js';
import { createWorkItem } from '../wizard/work-item.js';
import path from 'path';
import { coerceStructuredOutput } from '../shared/structured_output.js';
import {
  translateAgentEvent,
  createStatusEvent,
  createResponseEvent,
  createErrorEvent,
  createReadyEvent,
  createUserPromptEvent,
} from './event_translator.js';
import type {
  AgentRunParams,
  AgentRunResult,
  AgentRunHandle,
  BridgeEvent,
} from './types.js';
import { loadConfig, getAgentConfig } from './config_loader.js';
import type { FullHarnessConfig, ResolvedAgentConfig } from './config_types.js';
import type { LLMRequestConfig, LLMClientConfig, LLMProvider } from '../types/llm.js';

/** Tier classification for routing */
type Tier = 'simple' | 'standard' | 'complex';

function buildAgentRegistry(config: FullHarnessConfig): AgentRegistry {
  const agentConfigs: Array<{ config: AgentConfig; llm: LLMRequestConfig }> = Object.entries(config.agents).map(([agentType, resolved]) => {
    return {
      config: buildAgentConfig(agentType, resolved.tools, resolved.budget, resolved.outputSchema) as AgentConfig,
      llm: {
        model: resolved.llm.model,
        provider: resolved.llm.provider,
        apiKey: resolved.llm.apiKey,
        maxTokens: resolved.llm.maxTokens,
        temperature: resolved.llm.temperature,
        baseUrl: resolved.llm.baseUrl,
        reasoning: resolved.llm.reasoning,
      },
    };
  });

  return new AgentRegistry(agentConfigs);
}

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
  private toolRegistry: ToolRegistry;
  private contextWindows = new Map<string, ContextWindow>();
  private logger: HarnessLogger;
  private isShutdown = false;
  private graphd: GraphDManager | null = null;
  private graphdStarted = false;
  private graphdSubscribers = new Map<string, GraphDSubscriber>();
  private eventBus: EventBus;
  private logSubscriber: LogSubscriber | null = null;
  private agentRegistry: AgentRegistry;
  private llmAdapter: ReturnType<typeof createAdapter>;

  constructor(config: FullHarnessConfig, logger?: HarnessLogger) {
    this.config = config;
    this.logger = logger ?? consoleLogger;
    this.agentRegistry = buildAgentRegistry(config);

    const apiKeys: Partial<Record<LLMProvider, string>> = {};
    const baseUrls: Partial<Record<LLMProvider, string>> = {};
    for (const agent of Object.values(config.agents)) {
      apiKeys[agent.llm.provider] = agent.llm.apiKey;
      if (agent.llm.baseUrl) {
        baseUrls[agent.llm.provider] = agent.llm.baseUrl;
      }
    }

    const llmClientConfig: LLMClientConfig = { apiKeys, baseUrls };
    this.llmAdapter = createAdapter(llmClientConfig);

    for (const agent of Object.values(config.agents)) {
      this.llmAdapter.registerModel?.(
        agent.llm.model,
        agent.llm.provider,
        agent.llm.baseUrl
      );
    }

    // Create EventBus - central pub/sub for all events
    this.eventBus = new EventBus();

    // Create LogSubscriber for agent events
    const logsDir = path.join(config.tools.workingDir, 'logs');
    try {
      this.logSubscriber = createLogSubscriber(this.eventBus, logsDir, 'agent_events.log');
      this.logger.info('LogSubscriber created', { logPath: path.join(logsDir, 'agent_events.log') });
    } catch (error) {
      this.logger.warning('Failed to create LogSubscriber', { error: String(error) });
    }

    const workingDir = config.tools.workingDir;

    // Create tool registry - tools are registered globally, agents filter by their config
    this.toolRegistry = new ToolRegistry(
      {
        bashTimeoutMs: config.tools.bashTimeoutMs,
        maxOutputLength: config.tools.maxOutputLength,
      },
      workingDir
    );

    // Register builtin tools
    for (const toolOptions of builtinToolOptions) {
      this.toolRegistry.register(toolOptions);
    }

    // Initialize GraphD if enabled
    if (config.graphd.enabled) {
      const graphdConfig = createGraphDConfig(workingDir, {
        host: config.graphd.host,
        port: config.graphd.port,
        dbPath: config.graphd.dbPath,
      });
      this.graphd = new GraphDManager(graphdConfig);
    }

    const defaultAgent = config.agents[config.defaultAgent];
    this.logger.info('AgentHarness initialized', {
      defaultAgent: config.defaultAgent,
      provider: defaultAgent?.llm.provider,
      model: defaultAgent?.llm.model,
      agentCount: Object.keys(config.agents).length,
      graphdEnabled: this.graphd !== null,
    });
  }

  /**
   * Get the EventBus for external subscribers.
   */
  getEventBus(): EventBusProtocol {
    return this.eventBus;
  }

  /**
   * Start async services (GraphD).
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
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error('GraphD failed to start', { error: message });
        throw error;
      }
    }
    return true;
  }

  /**
   * Get or create a ContextWindow for the session.
   */
  private getOrCreateContext(sessionKey: string): ContextWindow {
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
    const maxTokens = this.config.context.maxTokens;
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
   */
  run(params: AgentRunParams): AgentRunHandle {
    const { requestId, inputText, tier: requestedTier, sessionKey } = params;
    const runId = requestId;
    const eventQueue = new AsyncEventQueue();

    eventQueue.push(createStatusEvent('sending', 'Processing request...'));

    if (this.graphd && this.graphdStarted) {
      try {
        this.graphd.sessionTouch(sessionKey, this.config.tools.workingDir);
        this.graphd.setActive(true);

        let subscriber = this.graphdSubscribers.get(sessionKey);
        if (!subscriber) {
          subscriber = new GraphDSubscriber(this.eventBus, this.graphd, {
            sessionKey,
            requestId,
          });
          this.graphdSubscribers.set(sessionKey, subscriber);
          this.logger.debug('Created GraphDSubscriber for session', { sessionKey });
        } else {
          subscriber.setRequestId(requestId);
        }
      } catch (error) {
        this.logger.warning('GraphD session touch failed', { error: String(error) });
      }
    }

    const contextWindow = this.getOrCreateContext(sessionKey);
    contextWindow.addMessage('user', inputText);

    const emit = createEventEmitCallback(this.eventBus, requestId, runId);

    const unsubscribe = this.eventBus.subscribeRun(runId, (event: AgentEvent): void => {
      const bridgeEvent = translateAgentEvent(event);
      if (bridgeEvent) {
        eventQueue.push(bridgeEvent);
      }
    });

    const resultPromise = (async (): Promise<AgentRunResult> => {
      try {
        // Route to determine tier if not specified
        const tier = requestedTier ?? await this.route(inputText);

        // Get the appropriate agent config (tier maps directly to agent type)
        const agentConfig = getAgentConfig(this.config, tier);

        this.logger.debug('Running with agent config', {
          tier,
          model: agentConfig.llm.model,
          provider: agentConfig.llm.provider,
        });

        if (this.graphd && this.graphdStarted) {
          try {
            this.graphd.sessionUpdateMetadata(sessionKey, {
              user_id: 'local-user',
              tier,
              model: agentConfig.llm.model,
              provider: agentConfig.llm.provider,
            });
          } catch (error) {
            this.logger.warning('GraphD session metadata update failed', { error: String(error) });
          }
        }

        const llmAdapter = this.llmAdapter;

        const result = tier === 'simple'
          ? await this.runSingleAgent(tier, contextWindow, inputText, requestId, emit, llmAdapter, agentConfig)
          : await this.runOrchestrator(contextWindow, inputText, requestId, emit, llmAdapter, tier);

        if (result.paused && result.userPrompt) {
          eventQueue.push(createUserPromptEvent(
            result.userPrompt.requestId,
            result.userPrompt.question,
            result.userPrompt.options,
            result.userPrompt.context,
            result.userPrompt.multiSelect
          ));
        }

        eventQueue.push(
          createResponseEvent(
            requestId,
            result.success,
            result.finalText,
            result.toolsUsed,
            result.durationMs,
            result.errorMessage,
            result.metadata
          )
        );

        eventQueue.push(createStatusEvent('idle'));

        this.persistToGraphD(sessionKey, requestId, inputText, result.finalText, result.durationMs);

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('Agent run failed', { error: errorMessage, requestId });

        emit(createEvent('goal_not_achieved', {
          goal: inputText,
          reason: errorMessage,
          completed: 0,
          failed: 0,
          skipped: 0,
        }));

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
        unsubscribe();
        this.persistContext(contextWindow);

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

    return { result: resultPromise, events: eventQueue };
  }

  /**
   * Persist session data to GraphD.
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
      this.graphd.messageAdd(sessionKey, 'user', userInput, requestId);
      this.graphd.messageAdd(sessionKey, 'assistant', assistantResponse, requestId, {
        duration_ms: durationMs,
      });
      this.graphd.sessionUpdateMetadata(sessionKey, {
        last_request_id: requestId,
        last_duration_ms: durationMs,
      });
    } catch (error) {
      this.logger.warning('GraphD persist failed', { error: String(error) });
    }
  }

  /**
   * Run a single agent without orchestration.
   * Used for simple tier or any tier that doesn't need multi-agent coordination.
   */
  private async runSingleAgent(
    agentType: string,
    context: ContextWindow,
    goal: string,
    requestId: string,
    emit: ReturnType<typeof createEventEmitCallback>,
    llm: ReturnType<typeof createAdapter>,
    agentConfig: ResolvedAgentConfig
  ): Promise<AgentRunResult> {
    // Get system prompt from prompts.ts, merge with behavioral rules
    const basePrompt = getAgentPrompt(agentType);
    const systemPrompt = this.config.behavioralRules
      ? `${basePrompt}\n\n${this.config.behavioralRules}`
      : basePrompt;

    const config = {
      type: agentType,
      systemPrompt,
      tools: agentConfig.tools,
      budget: agentConfig.budget,
      allowImplicitFinals: false,
    };

    const llmConfig: LLMRequestConfig = {
      model: agentConfig.llm.model,
      provider: agentConfig.llm.provider,
      apiKey: agentConfig.llm.apiKey,
      maxTokens: agentConfig.llm.maxTokens,
      temperature: agentConfig.llm.temperature,
      baseUrl: agentConfig.llm.baseUrl,
      reasoning: agentConfig.llm.reasoning,
    };

    const agent = new Agent(
      config,
      llm,
      this.toolRegistry,
      emit,
      requestId,
      this.agentRegistry,
      llmConfig
    );

    const workItem = createWorkItem({
      goal,
      objective: goal,
      agent: agentType,
    });

    emit(createEvent('workitem_started', {
      workId: workItem.workId,
      objective: workItem.objective,
      delta: workItem.delta,
      agent: workItem.agent,
      dependencies: [...workItem.dependencies],
    }, workItem.workId));

    const result = await agent.run({ context, workItem });

    if (!result.needsUserInput) {
      if (result.success) {
        emit(createEvent('workitem_completed', {
          workId: workItem.workId,
          objective: workItem.objective,
          response: result.response,
          metrics: {
            llmCallsMade: result.metrics.llmCallsMade,
            toolCallsMade: result.metrics.toolCallsMade,
            durationMs: result.metrics.durationMs,
          },
        }, workItem.workId));

        emit(createEvent('goal_achieved', {
          goal,
          completed: 1,
          skipped: 0,
        }));
      } else {
        emit(createEvent('workitem_failed', {
          workId: workItem.workId,
          objective: workItem.objective,
          error: result.error ?? 'Unknown error',
          toolErrors: result.toolErrors,
          terminationReason: result.terminationReason,
        }, workItem.workId));

        emit(createEvent('goal_not_achieved', {
          goal,
          reason: result.error ?? 'Unknown error',
          completed: 0,
          failed: 1,
          skipped: 0,
        }));
      }
    }

    return {
      requestId,
      sessionKey: context.sessionKey,
      success: result.success,
      finalText: result.response,
      errorMessage: result.error,
      paused: result.needsUserInput,
      userPrompt: result.needsUserInput && result.userPrompt ? {
        requestId,
        question: String(result.userPrompt.question ?? 'Please provide input:'),
        options: result.userPrompt.options,
        context: result.userPrompt.context,
        multiSelect: result.userPrompt.multiSelect,
      } : undefined,
      toolsUsed: [],
      durationMs: result.metrics.durationMs,
      metadata: { tier: agentType, metrics: result.metrics },
    };
  }

  /**
   * Run standard/complex tiers via Orchestrator.
   */
  private async runOrchestrator(
    context: ContextWindow,
    goal: string,
    requestId: string,
    emit: ReturnType<typeof createEventEmitCallback>,
    llm: ReturnType<typeof createAdapter>,
    tier: Tier
  ): Promise<AgentRunResult> {
    const orchestrator = new Orchestrator(
      {},
      this.toolRegistry,
      llm,
      emit,
      requestId,
      this.logger,
      this.agentRegistry
    );

    const result = await orchestrator.execute(context, goal, tier === 'complex' ? 'complex' : 'standard');

    return {
      requestId,
      sessionKey: context.sessionKey,
      success: result.success,
      finalText: result.response,
      errorMessage: result.error,
      paused: result.paused,
      userPrompt: result.paused && result.userPrompt ? {
        requestId,
        question: String(result.userPrompt.question ?? 'Please provide input:'),
        options: result.userPrompt.options,
        context: result.userPrompt.context,
        multiSelect: result.userPrompt.multiSelect,
      } : undefined,
      toolsUsed: [],
      durationMs: result.metrics.durationMs,
      metadata: { tier, metrics: result.metrics },
    };
  }

  /**
   * Route a request to determine tier.
   * Uses agents.routing config from harness_config.json.
   */
  private async route(goal: string): Promise<Tier> {
    const routingAgentConfig = getAgentConfig(this.config, 'routing');
    const routingPrompt = getAgentPrompt('routing');

    const routingAdapter = this.llmAdapter;

    this.logger.debug('Routing request', {
      provider: routingAgentConfig.llm.provider,
      model: routingAgentConfig.llm.model,
    });

    const response = await routingAdapter.respond({
      messages: [
        { role: 'system', content: routingPrompt },
        { role: 'user', content: goal },
      ],
      llm: {
        model: routingAgentConfig.llm.model,
        provider: routingAgentConfig.llm.provider,
        apiKey: routingAgentConfig.llm.apiKey,
        maxTokens: routingAgentConfig.llm.maxTokens,
        temperature: routingAgentConfig.llm.temperature,
        baseUrl: routingAgentConfig.llm.baseUrl,
        reasoning: routingAgentConfig.llm.reasoning,
      },
      responseSchema: routingAgentConfig.outputSchema,
    });

    const content = response.content?.toLowerCase().trim() ?? '';
    const structured = coerceStructuredOutput(response.content);
    const tierValue =
      structured && typeof structured.tier === 'string'
        ? structured.tier.toLowerCase().trim()
        : '';
    this.logger.debug('Routing agent response', {
      content: tierValue || content,
      model: response.model,
      stopReason: response.stopReason,
    });
    if (tierValue.includes('simple') || content.includes('simple')) return 'simple';
    if (tierValue.includes('complex') || content.includes('complex')) return 'complex';
    return 'standard';
  }

  /**
   * Resume agent execution after user provides input.
   */
  resume(requestId: string, _answer: string, sessionKey: string): AgentRunHandle {
    const eventQueue = new AsyncEventQueue();
    eventQueue.push(createStatusEvent('sending', 'Resume is not supported in this refactor.'));

    const resultPromise = (async (): Promise<AgentRunResult> => {
      const errorMessage = 'Resume not implemented for orchestrator runs.';
      eventQueue.push(createErrorEvent(errorMessage, true));
      eventQueue.push(createStatusEvent('error', errorMessage));
      eventQueue.finish();
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
    })();

    return { result: resultPromise, events: eventQueue };
  }

  /**
   * Create a ready event for initialization.
   */
  createReadyEvent(sessionKey: string): BridgeEvent {
    const defaultAgent = this.config.agents[this.config.defaultAgent];
    const configSummary = defaultAgent
      ? `Provider: ${defaultAgent.llm.provider}, Model: ${defaultAgent.llm.model}`
      : 'No default agent configured';
    return createReadyEvent(sessionKey, configSummary);
  }

  /**
   * Get the loaded configuration.
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

    if (this.logSubscriber) {
      try {
        this.logSubscriber.close();
        this.logger.debug('Closed LogSubscriber');
      } catch (error) {
        this.logger.warning('LogSubscriber close failed', { error: String(error) });
      }
    }

    this.eventBus.shutdown();

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
 * Create an AgentHarness from configuration file.
 * Tries to load config/harness_config.json, falls back to env-only mode.
 */
export function createHarnessFromEnv(
  workingDir?: string,
  configPath?: string
): AgentHarness {
  const config = loadConfig(configPath, workingDir);
  return new AgentHarness(config);
}
