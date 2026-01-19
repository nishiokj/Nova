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

import {
  Agent,
  AgentRegistry,
  type AgentConfig,
  type AgentHooks,
  type ToolHookResult,
  type EnvironmentContext,
  getAgentPrompt,
  buildAgentConfig,
  getPlanningPromptAddendum,
} from 'agent';
import os from 'os';
import { execSync } from 'child_process';
import { Orchestrator, type ModelOverride } from 'orchestrator';
import { createAdapter, RateLimitError, CircuitOpenError, RetriesExhaustedError, type ProviderKeyService } from 'llm';
import { ToolRegistry, builtinToolOptions } from 'tools';
import { createEvent, successResult, errorResult, type AgentEvent, type ToolResult, type LLMRequestConfig, type LLMClientConfig, type LLMProvider, type RateLimitData } from 'types';
import { ContextWindow } from 'context';
import { createWorkItem } from 'work';
import { coerceStructuredOutput } from 'shared';
import { GraphDManager, createGraphDConfig } from 'graphd';
import { EventBus, type EventBusProtocol, createEventEmitCallback } from 'comms-bus';
import { createGraphDSubscriber } from '../subscribers/graphd_subscriber.js';
import { LogSubscriber, createLogSubscriber } from '../subscribers/log_subscriber.js';
import path from 'path';
import fs from 'fs';
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
import { loadConfig, getAgentConfig, resolveApiKey, getConfigProviders } from './config_loader.js';
import type { FullHarnessConfig, ResolvedAgentConfig } from './config_types.js';
import { LocalProviderManager } from './local_providers.js';
import { HookExecutor } from './hook_executor.js';
import { loadSkillDefinitions, getSkillDefinition, type HookContext } from './skills_loader.js';
import { SessionStore } from './session_store.js';
import { createFileLogger, type HarnessLogger } from './harness_infra.js';

/** Agent type for routing - maps to agent config */
type AgentType = string;

/**
 * Gather environment context for system prompts.
 * Runs synchronously at startup - git commands are fast.
 */
function gatherEnvironmentContext(workingDir: string): EnvironmentContext {
  const env: EnvironmentContext = {
    workingDir,
    platform: process.platform,
    osVersion: os.release(),
    date: new Date().toISOString().split('T')[0],
  };

  try {
    const isRepo = execSync('git rev-parse --is-inside-work-tree', {
      cwd: workingDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() === 'true';

    if (isRepo) {
      const currentBranch = execSync('git branch --show-current', {
        cwd: workingDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      // Detect main branch (main or master)
      let mainBranch = 'main';
      try {
        execSync('git rev-parse --verify main', {
          cwd: workingDir,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        try {
          execSync('git rev-parse --verify master', {
            cwd: workingDir,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          mainBranch = 'master';
        } catch {
          // Neither main nor master exists
        }
      }

      const status = execSync('git status --short', {
        cwd: workingDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const recentCommits = execSync('git log --oneline -5', {
        cwd: workingDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim().split('\n').filter(Boolean);

      env.git = {
        isRepo: true,
        currentBranch: currentBranch || undefined,
        mainBranch,
        status: status || undefined,
        recentCommits: recentCommits.length > 0 ? recentCommits : undefined,
      };
    }
  } catch {
    env.git = { isRepo: false };
  }

  return env;
}

function buildAgentRegistry(config: FullHarnessConfig, envContext?: EnvironmentContext): AgentRegistry {
  const agentConfigs: Array<{ config: AgentConfig; llm: LLMRequestConfig }> = Object.entries(config.agents).map(([agentType, resolved]) => {
    return {
      config: buildAgentConfig(agentType, resolved.tools, resolved.budget, resolved.outputSchema, envContext) as AgentConfig,
      llm: {
        model: resolved.llm.model,
        provider: resolved.llm.provider,
        displayProvider: resolved.llm.displayProvider,
        maxTokens: resolved.llm.maxTokens,
        temperature: resolved.llm.temperature,
        baseUrl: resolved.llm.baseUrl,
        reasoning: resolved.llm.reasoning,
        fallback: resolved.llm.fallback,
        // thinking config comes from provider registry at request time
      },
    };
  });

  const registry = new AgentRegistry(agentConfigs);

  // Validate agent tool references - warn if an agent references another agent that isn't loaded
  const builtinTools = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch']);
  const registeredAgentTypes = new Set(agentConfigs.map(c => c.config.type));
  for (const agentConf of agentConfigs) {
    for (const tool of agentConf.config.tools) {
      const toolLower = tool.toLowerCase();
      if (!builtinTools.has(tool) && !registeredAgentTypes.has(tool) && !registeredAgentTypes.has(toolLower)) {
        console.warn(`[harness] Agent '${agentConf.config.type}' references tool '${tool}' which is not available`);
      }
    }
  }

  return registry;
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

const consoleLogger: HarnessLogger = createFileLogger();

/**
 * Provider key service implementation for the harness.
 * Queries API keys at runtime from:
 * 1. LocalProviderManager (GraphD storage) - if available
 * 2. Config providers cache
 * 3. Environment variables
 *
 * This allows API keys to be added/changed at runtime without restarting the harness.
 */
class HarnessProviderKeyService implements ProviderKeyService {
  private localProviders: LocalProviderManager | null = null;
  private logger: HarnessLogger;

  constructor(graphdDbPath: string | null, logger: HarnessLogger) {
    this.logger = logger;
    if (graphdDbPath) {
      try {
        this.localProviders = new LocalProviderManager(graphdDbPath);
        this.logger.info('HarnessProviderKeyService initialized with GraphD', { dbPath: graphdDbPath });
      } catch (err) {
        this.logger.warning('Failed to initialize LocalProviderManager', { error: String(err) });
      }
    }
  }

  getApiKey(provider: string): string | null {
    // Priority 1: LocalProviderManager (GraphD storage)
    if (this.localProviders) {
      const key = this.localProviders.getProviderKey(provider);
      if (key) {
        this.logger.debug('API key found in GraphD', { provider });
        return key;
      }
    }

    // Priority 2: Config providers cache
    const configProviders = getConfigProviders();
    if (configProviders[provider]) {
      this.logger.debug('API key found in config cache', { provider });
      return configProviders[provider] ?? null;
    }

    // Priority 3: Try resolveApiKey which checks env vars
    try {
      const key = resolveApiKey(provider);
      if (key) {
        this.logger.debug('API key found via resolveApiKey', { provider });
        return key;
      }
    } catch {
      // No key found
    }

    return null;
  }

  hasApiKey(provider: string): boolean {
    return this.getApiKey(provider) !== null;
  }

  close(): void {
    this.localProviders?.close();
  }
}

/**
 * AgentHarness - Wraps the TypeScript Agent for TUI integration.
 */
export class AgentHarness {
  private config: FullHarnessConfig;
  private toolRegistry: ToolRegistry;
  private sessionStores = new Map<string, { store: SessionStore; lastAccessMs: number }>();
  private readonly sessionTtlMs: number;
  private logger: HarnessLogger;
  private isShutdown = false;
  private graphd: GraphDManager | null = null;
  private graphdStarted = false;
  private graphdSubscriber: ReturnType<typeof createGraphDSubscriber> | null = null;
  private eventBus: EventBus;
  private logSubscriber: LogSubscriber | null = null;
  private agentRegistry: AgentRegistry;
  private llmAdapter: ReturnType<typeof createAdapter>;
  private hookExecutor: HookExecutor | null = null;
  private providerKeyService: HarnessProviderKeyService;

  constructor(config: FullHarnessConfig, logger?: HarnessLogger) {
    this.config = config;
    this.logger = logger ?? consoleLogger;
    this.sessionTtlMs = config.context.sessionTtlMs;

    // Gather environment context once at startup
    const envContext = gatherEnvironmentContext(config.tools.workingDir);
    this.agentRegistry = buildAgentRegistry(config, envContext);

    // Create provider key service for runtime API key resolution
    // This allows keys to be added/changed at runtime without restart
    const graphdDbPath = config.graphd.enabled ? config.graphd.dbPath : null;
    this.providerKeyService = new HarnessProviderKeyService(graphdDbPath, this.logger);

    // NOTE: We don't populate shared apiKeys/baseUrls here because:
    // 1. Multiple providers (cerebras, z.ai-coder, groq) map to the same canonical 'openai-compat'
    // 2. Keying by canonical provider causes last-writer-wins collision
    // 3. The providerKeyService will resolve API keys at request time
    // The adapter queries providerKeyService for keys when making requests
    const llmClientConfig: LLMClientConfig = {};

    // Adapt HarnessLogger to AdapterLogger (warning → warn)
    const adapterLogger = {
      debug: this.logger.debug.bind(this.logger),
      info: this.logger.info.bind(this.logger),
      warn: this.logger.warning.bind(this.logger),
      error: this.logger.error.bind(this.logger),
    };
    this.llmAdapter = createAdapter(llmClientConfig, adapterLogger, this.providerKeyService);

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

    // Register Skill tool - loads and executes skills from config/skills/
    const skillsDir = config.skills.directory
      ? path.resolve(workingDir, config.skills.directory)
      : path.resolve(workingDir, 'config/skills');

    this.toolRegistry.register({
      name: 'Skill',
      description: 'Load and execute a skill by name. Use skill="list" to see available skills. Skills provide specialized instructions for complex tasks like code review, design, etc.',
      parameters: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            description: 'Skill name to execute (e.g., "design-fork"), or "list" to see available skills',
          },
          args: {
            type: 'string',
            description: 'Optional arguments to pass to the skill',
          },
        },
        required: ['skill'],
      },
      required: ['skill'],
      executor: async (args) => {
        const skillName = String(args.skill ?? '').trim();
        if (!skillName) {
          return errorResult('Skill', 'Skill name is required', 0);
        }

        // List available skills
        if (skillName === 'list') {
          const skills = loadSkillDefinitions(skillsDir);
          if (skills.length === 0) {
            return successResult('Skill', 'No skills available. Add skills to config/skills/<name>/SKILL.md', 0);
          }
          const list = skills
            .filter(s => s.enabled)
            .map(s => `- **${s.name}**: ${s.description}`)
            .join('\n');
          return successResult('Skill', `Available skills:\n\n${list}`, 0);
        }

        // Load and return skill instructions
        const skill = getSkillDefinition(skillsDir, skillName);
        if (!skill) {
          const available = loadSkillDefinitions(skillsDir)
            .filter(s => s.enabled)
            .map(s => s.name);
          return errorResult('Skill', `Skill '${skillName}' not found. Available: ${available.join(', ') || 'none'}`, 0);
        }

        if (!skill.enabled) {
          return errorResult('Skill', `Skill '${skillName}' is disabled`, 0);
        }

        // Return instructions with optional args
        const skillArgs = typeof args.args === 'string' ? args.args.trim() : '';
        const instructions = skillArgs
          ? `${skill.instructions}\n\n## Arguments\n${skillArgs}`
          : skill.instructions;

        return successResult('Skill', instructions, 0);
      },
      enabled: true,
      readOnly: true,
      parallelizable: false,
      costHint: 'low',
    });

    // Initialize GraphD if enabled
    // Note: config.graphd.dbPath is already an absolute path (resolved in config_loader.ts)
    // rootPath is used for file path normalization in search/index operations
    if (config.graphd.enabled) {
      const graphdConfig = createGraphDConfig(config.tools.repoRoot, {
        host: config.graphd.host,
        port: config.graphd.port,
        dbPath: config.graphd.dbPath, // Already absolute - resolved relative to config file location
      });
      this.graphd = new GraphDManager(graphdConfig);
    }

    // Initialize HookExecutor if hooks are enabled
    if (config.hooks.enabled && config.hooks.directory) {
      const hooksDir = path.resolve(workingDir, config.hooks.directory);
      this.hookExecutor = new HookExecutor(hooksDir, workingDir);
      this.logger.info('HookExecutor initialized', { hooksDir });
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
   * Check if GraphD is initialized and running.
   */
  private isGraphDReady(): boolean {
    return !!(this.graphd && this.graphdStarted);
  }

  /**
   * Update an API key at runtime and reset the circuit breaker.
   * Called when a provider key is saved via /providers.
   */
  updateApiKey(provider: LLMProvider, apiKey: string): void {
    this.llmAdapter.updateApiKey?.(provider, apiKey);
    this.logger.info('Updated API key in harness', { provider });
  }

  /**
   * Reset the circuit breaker state.
   */
  resetCircuitBreaker(): void {
    this.llmAdapter.resetCircuitBreaker?.();
    this.logger.info('Reset circuit breaker in harness');
  }

  /**
   * Check if an API key exists for a provider.
   * Accepts the actual provider name (e.g., 'z.ai-coder', 'cerebras'), not canonical.
   */
  hasApiKey(provider: string): boolean {
    return this.providerKeyService.hasApiKey(provider);
  }

  /**
   * Get the GraphD manager instance.
   */
  getGraphD(): GraphDManager | null {
    return this.graphd;
  }

  /**
   * Close and evict in-memory state for a session.
   */
  closeSession(sessionKey: string): void {
    const entry = this.sessionStores.get(sessionKey);
    if (entry) {
      entry.store.close();
      this.sessionStores.delete(sessionKey);
    }
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
          if (!this.graphdSubscriber) {
            this.graphdSubscriber = createGraphDSubscriber(this.eventBus, this.graphd, { batchMode: false });
            this.logger.debug('GraphDSubscriber created');
          }
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
   * Get or create a SessionStore for the session.
   */
  private getOrCreateSessionStore(sessionKey: string): SessionStore {
    const existing = this.sessionStores.get(sessionKey);
    const now = Date.now();
    if (existing) {
      existing.lastAccessMs = now;
      return existing.store;
    }

    const store = new SessionStore({
      sessionKey,
      maxTokens: this.config.context.maxTokens,
      graphd: this.graphd,
      isGraphDReady: () => this.isGraphDReady(),
      logger: this.logger,
    });
    this.sessionStores.set(sessionKey, { store, lastAccessMs: now });
    return store;
  }

  setSessionSelectedModel(sessionKey: string, selectedModel: ModelOverride | null): void {
    const store = this.getOrCreateSessionStore(sessionKey);
    if (selectedModel) {
      store.setModelOverride(selectedModel);
    } else {
      store.clearModelOverride();
    }
  }

  getSessionSelectedModel(sessionKey: string): ModelOverride | null {
    const entry = this.sessionStores.get(sessionKey);
    return entry?.store.getModelOverride() ?? null;
  }

  private pruneSessionStores(reason: string): void {
    if (this.sessionTtlMs <= 0) return;
    const now = Date.now();
    const cutoff = now - this.sessionTtlMs;
    for (const [sessionKey, entry] of this.sessionStores.entries()) {
      if (entry.lastAccessMs > cutoff) continue;
      if (entry.store.hasPausedState()) continue;
      entry.store.close();
      this.sessionStores.delete(sessionKey);
      this.logger.debug('Evicted session store', {
        sessionKey,
        reason,
        idleMs: now - entry.lastAccessMs,
      });
    }
  }

  private persistUserMessage(sessionKey: string, requestId: string, userInput: string): boolean {
    if (!this.isGraphDReady()) return false;
    try {
      this.graphd!.messageAdd(sessionKey, 'user', userInput, requestId);
      return true;
    } catch (error) {
      this.logger.warning('GraphD user message persist failed', { error: String(error) });
      return false;
    }
  }

  /**
   * Run the agent with the given parameters.
   */
  run(params: AgentRunParams): AgentRunHandle {
    const { requestId, inputText, tier: requestedTier, sessionKey, workingDir, planMode } = params;
    const runId = requestId;
    const eventQueue = new AsyncEventQueue();

    eventQueue.push(createStatusEvent('sending', 'Processing request...'));

    this.pruneSessionStores('run');
    const store = this.getOrCreateSessionStore(sessionKey);

    // Attempt to mark execution as started; if another run is active, queue instead.
    if (!store.startExecution(requestId)) {
      this.logger.info('Message received during active execution, queueing for agent', {
        sessionKey,
        requestId,
        executingRequestId: store.getExecutingRequestId(),
        messagePreview: inputText.slice(0, 100),
      });

      // Queue the message - this adds it to context immediately
      store.queueUserMessage(requestId, inputText);

      // Persist to GraphD if available
      this.persistUserMessage(sessionKey, requestId, inputText);

      // Emit a status event indicating the message was queued
      eventQueue.push(createStatusEvent('idle', 'Message queued - agent will see it on next turn'));

      // Return a "queued" result - not an error, but also not a full response
      const resultPromise = Promise.resolve({
        requestId,
        sessionKey,
        success: true,
        finalText: '',
        paused: false,
        toolsUsed: [],
        durationMs: 0,
        metadata: { queued: true, executingRequestId: store.getExecutingRequestId() },
      } as AgentRunResult);

      queueMicrotask(() => eventQueue.finish());
      return { result: resultPromise, events: eventQueue };
    }

    if (this.isGraphDReady()) {
      try {
        const effectiveWorkingDir = workingDir ?? this.config.tools.workingDir;
        store.touch(effectiveWorkingDir);
        this.graphd!.setActive(true);
        if (!this.graphdSubscriber) {
          this.graphdSubscriber = createGraphDSubscriber(this.eventBus, this.graphd!, { batchMode: false });
          this.logger.debug('GraphDSubscriber created');
        }
      } catch (error) {
        this.logger.warning('GraphD session touch failed', { error: String(error) });
      }
    }

    const contextWindow = store.getContext();

    // NOTE: Per min_patch_spec.md, we no longer auto-inject @path references into context.
    // Users should use explicit tools (Read/Glob/Grep) to bring file contents into context.

    contextWindow.addMessage('user', inputText);

    const userMessagePersisted = this.persistUserMessage(sessionKey, requestId, inputText);
    const emit = createEventEmitCallback(this.eventBus, requestId, runId, sessionKey);

    const unsubscribe = this.eventBus.subscribeRun(runId, (event: AgentEvent): void => {
      const bridgeEvent = translateAgentEvent(event);
      if (bridgeEvent) {
        eventQueue.push(bridgeEvent);
      }
    });

    const resultPromise = (async (): Promise<AgentRunResult> => {
      try {
        // Run UserPromptSubmit hooks before processing
        if (this.hookExecutor) {
          const hookContext: HookContext = {
            event: 'UserPromptSubmit',
            sessionKey,
            requestId,
            workingDir,
          };
          const hookResult = await this.hookExecutor.execute('UserPromptSubmit', hookContext);
          if (hookResult.action === 'block') {
            eventQueue.push(createErrorEvent(hookResult.message || 'Request blocked by hook', false));
            eventQueue.push(createStatusEvent('idle'));
            return {
              requestId,
              sessionKey,
              success: false,
              finalText: hookResult.message || 'Request blocked by hook',
              errorMessage: hookResult.message,
              paused: false,
              toolsUsed: [],
              durationMs: 0,
            };
          }
        }

        // Use explicitly requested agent type or default to 'standard'
        const tier: AgentType = requestedTier || 'standard';
      
        // Get the appropriate agent config (tier maps directly to agent type)
        const agentConfig = getAgentConfig(this.config, tier);

        this.logger.debug('Running with agent config', {
          tier,
          requestedTier,
          model: agentConfig.llm.model,
          provider: agentConfig.llm.provider,
        });

        if (this.isGraphDReady()) {
          try {
            this.graphd!.sessionUpdateMetadata(sessionKey, {
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

        // Get selected model from session store or GraphD metadata if set
        let selectedModel: ModelOverride | undefined;
        const cachedSelected = store.getModelOverride();
        if (cachedSelected) {
          selectedModel = cachedSelected;
        } else if (this.isGraphDReady()) {
          try {
            const session = this.graphd!.sessionGet(sessionKey);
            const metadata = session?.metadata as Record<string, unknown> | undefined;
            const selectedFromMeta = metadata?.selected_model as { provider?: string; model?: string; reasoning?: string } | undefined;
            const legacyOverride = metadata?.model_override as { provider?: string; model?: string; reasoning?: string } | undefined;
            const override = selectedFromMeta ?? legacyOverride;
            if (override?.provider && override?.model) {
              selectedModel = {
                provider: override.provider,
                model: override.model,
                reasoning: override.reasoning,
              };
              store.setModelOverride(selectedModel);
              this.logger.debug('Using selected model from session', { selectedModel });
            }
          } catch {
            // Ignore errors getting selected model - use default
          }
        }

        // All requests go through orchestrator (loop-until-goal architecture)
        let result = await this.runOrchestrator(contextWindow, inputText, requestId, emit, llmAdapter, tier, workingDir, planMode, selectedModel, store);

        while (!result.paused) {
          const queuedMessages = store.drainQueuedMessages();
          if (queuedMessages.length > 0) {
            this.logger.info('Queued messages detected after execution, continuing run', {
              sessionKey,
              requestId,
              queuedCount: queuedMessages.length,
            });
            result = await this.runOrchestrator(contextWindow, inputText, requestId, emit, llmAdapter, tier, workingDir, planMode, selectedModel, store);
            continue;
          }

          if (store.endExecutionIfIdle()) {
            break;
          }

          const lateQueued = store.drainQueuedMessages();
          if (lateQueued.length === 0) {
            break;
          }
          this.logger.info('Late queued messages detected, continuing run', {
            sessionKey,
            requestId,
            queuedCount: lateQueued.length,
          });
          result = await this.runOrchestrator(contextWindow, inputText, requestId, emit, llmAdapter, tier, workingDir, planMode, selectedModel, store);
        }

        if (result.paused && result.userPrompt) {
          // Pausing for user input - only emit user prompt event, not response
          eventQueue.push(createUserPromptEvent(
            result.userPrompt.requestId,
            result.userPrompt.question,
            result.userPrompt.options,
            result.userPrompt.context,
            result.userPrompt.multiSelect,
            result.userPrompt.questionType,
            result.userPrompt.questions
          ));
        } else {
          // Execution completed (success or failure) - emit response event
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
        }

        eventQueue.push(createStatusEvent('idle'));

        this.persistToGraphD(sessionKey, requestId, inputText, result.finalText, result.durationMs, userMessagePersisted);

        return result;
      } catch (error) {
        // Handle RateLimitError specially - persist context and notify user gracefully
        if (RateLimitError.isRateLimitError(error)) {
          const rateLimitInfo = error.info;
          this.logger.warning('Rate limit hit during agent run', {
            requestId,
            provider: error.provider,
            model: error.model,
            type: rateLimitInfo.type,
            retryAfterMs: rateLimitInfo.retryAfterMs,
            limitType: rateLimitInfo.limitType,
          });

          // Emit rate_limit event for monitoring/dashboards
          emit(createEvent('rate_limit', {
            provider: error.provider,
            model: error.model,
            type: rateLimitInfo.type,
            retryAfterMs: rateLimitInfo.retryAfterMs,
            limitType: rateLimitInfo.limitType,
            message: rateLimitInfo.message,
            contextPreserved: true,
          } as RateLimitData));

          // Persist context so user doesn't lose work
          store.persistContext();

          // Create a user-friendly error message based on rate limit type
          let userMessage: string;
          if (rateLimitInfo.type === 'billing') {
            userMessage = `⚠️ Billing limit reached for ${error.provider}. Please check your account billing status. Your conversation has been saved.`;
          } else if (rateLimitInfo.type === 'quota') {
            userMessage = `⚠️ API quota exceeded for ${error.provider} (${rateLimitInfo.limitType ?? 'requests'}). This may be a daily or monthly limit. Your conversation has been saved.`;
          } else {
            const waitTime = rateLimitInfo.retryAfterMs
              ? ` Please wait ${Math.ceil(rateLimitInfo.retryAfterMs / 1000)} seconds and try again.`
              : ' Please wait a moment and try again.';
            userMessage = `⚠️ Rate limit reached for ${error.provider}.${waitTime} Your conversation has been saved.`;
          }

          eventQueue.push(createErrorEvent(userMessage, false)); // recoverable, not fatal
          eventQueue.push(createStatusEvent('idle')); // Return to idle, not error state

          return {
            requestId,
            sessionKey,
            success: false,
            finalText: userMessage,
            errorMessage: error.message,
            paused: false,
            toolsUsed: [],
            durationMs: 0,
          };
        }

        // Handle CircuitOpenError - circuit breaker tripped, need to wait before retrying
        if (error instanceof CircuitOpenError) {
          this.logger.warning('Circuit breaker open', {
            requestId,
            message: error.message,
          });

          // Persist context so user doesn't lose work
          store.persistContext();

          const userMessage = `⚠️ Service temporarily unavailable (circuit breaker open). Please wait a moment and try again. Your conversation has been saved.`;

          eventQueue.push(createErrorEvent(userMessage, false)); // recoverable, not fatal
          eventQueue.push(createStatusEvent('idle')); // Return to idle, not error state

          return {
            requestId,
            sessionKey,
            success: false,
            finalText: userMessage,
            errorMessage: error.message,
            paused: false,
            toolsUsed: [],
            durationMs: 0,
          };
        }

        // Handle RetriesExhaustedError - all retry attempts failed
        if (error instanceof RetriesExhaustedError) {
          const causeMessage = error.cause instanceof Error ? error.cause.message : String(error.cause ?? '');
          this.logger.warning('All retries exhausted', {
            requestId,
            attempts: error.attempts,
            cause: causeMessage,
          });

          // Persist context so user doesn't lose work
          store.persistContext();

          const userMessage = `⚠️ Request failed after ${error.attempts} attempts. Please wait a moment and try again. Your conversation has been saved.`;

          eventQueue.push(createErrorEvent(userMessage, false)); // recoverable, not fatal
          eventQueue.push(createStatusEvent('idle')); // Return to idle, not error state

          return {
            requestId,
            sessionKey,
            success: false,
            finalText: userMessage,
            errorMessage: error.message,
            paused: false,
            toolsUsed: [],
            durationMs: 0,
          };
        }

        // Generic error handling for non-rate-limit errors
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
        // Mark execution as complete - allows new messages to start their own orchestrator
        const queuedMessages = store.endExecution();
        if (queuedMessages.length > 0) {
          this.logger.info('Execution ended with queued messages', {
            sessionKey,
            requestId,
            queuedCount: queuedMessages.length,
          });
        }

        // Run Stop hooks
        if (this.hookExecutor) {
          const hookContext: HookContext = {
            event: 'Stop',
            sessionKey,
            requestId,
            workingDir,
          };
          await this.hookExecutor.execute('Stop', hookContext).catch((err) => {
            this.logger.warning('Stop hook failed', { error: String(err) });
          });
        }

        queueMicrotask(() => {
          try {
            unsubscribe();
            store.persistContext();

            // Flush subscriber events to make them visible to dashboard immediately
            this.graphdSubscriber?.flush();

            if (this.isGraphDReady()) {
              try {
                this.graphd!.setActive(false);
              } catch {
                // Ignore errors during cleanup
              }
            }
          } catch (error) {
            this.logger.warning('Run cleanup failed', { error: String(error) });
          } finally {
            eventQueue.finish();
          }
        });
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
    durationMs: number,
    userMessagePersisted = false
  ): void {
    if (!this.isGraphDReady()) return;

    try {
      if (!userMessagePersisted) {
        this.graphd!.messageAdd(sessionKey, 'user', userInput, requestId);
      }
      this.graphd!.messageAdd(sessionKey, 'assistant', assistantResponse, requestId, {
        duration_ms: durationMs,
      });
      this.graphd!.sessionUpdateMetadata(sessionKey, {
        last_request_id: requestId,
        last_duration_ms: durationMs,
      });
    } catch (error) {
      this.logger.warning('GraphD persist failed', { error: String(error) });
    }
  }
  /**
   * Filter tools for plan mode - removes write/edit capabilities.
   */
  private filterPlanModeTools(tools: string[]): string[] {
    const writeTools = new Set(['Write', 'Edit', 'BatchEdit']);
    return tools.filter(tool => !writeTools.has(tool));
  }

  /**
   * Create AgentHooks that delegate to HookExecutor.
   */
  private createAgentHooks(sessionKey: string, requestId: string): AgentHooks | undefined {
    if (!this.hookExecutor) return undefined;

    const executor = this.hookExecutor;
    const workingDir = this.config.tools.workingDir;

    return {
      preToolUse: async (toolName: string, args: Record<string, unknown>): Promise<ToolHookResult> => {
        const context: HookContext = {
          event: 'PreToolUse',
          toolName,
          toolParams: args,
          sessionKey,
          requestId,
          workingDir,
        };
        const result = await executor.execute('PreToolUse', context);
        return {
          action: result.action,
          message: result.message,
          modifiedArgs: result.modified as Record<string, unknown> | undefined,
        };
      },

      postToolUse: async (toolName: string, args: Record<string, unknown>, toolResult: ToolResult): Promise<ToolHookResult> => {
        const context: HookContext = {
          event: 'PostToolUse',
          toolName,
          toolParams: args,
          toolResult,
          sessionKey,
          requestId,
          workingDir,
        };
        const result = await executor.execute('PostToolUse', context);
        return {
          action: result.action,
          message: result.message,
          modifiedResult: result.modified as ToolResult | undefined,
        };
      },
    };
  }

  /**
   * Run via Orchestrator with specified agent type.
   */
  private async runOrchestrator(
    context: ContextWindow,
    goal: string,
    requestId: string,
    emit: ReturnType<typeof createEventEmitCallback>,
    llm: ReturnType<typeof createAdapter>,
    agentType: AgentType = 'standard',
    workingDir?: string,
    planMode?: boolean,
    selectedModel?: ModelOverride,
    store?: SessionStore
  ): Promise<AgentRunResult> {
    const hooks = this.createAgentHooks(context.sessionKey, requestId);

    // Build plan mode options if enabled
    const planModeOptions = planMode ? {
      enabled: true,
      promptAddendum: getPlanningPromptAddendum(),
      toolFilter: (tools: string[]) => this.filterPlanModeTools(tools),
    } : undefined;

    const orchestrator = new Orchestrator(
      {},
      this.toolRegistry,
      llm,
      emit,
      requestId,
      this.logger,
      this.agentRegistry,
      hooks,
      planModeOptions,
      this.eventBus,
      selectedModel
    );

    // Execute with session-specific working directory (passed explicitly for concurrent-safety)
    const effectiveWorkingDir = workingDir ?? this.config.tools.workingDir;
    const result = await orchestrator.execute(context, goal, agentType, effectiveWorkingDir);

    // Handle handoff: clear context and restart with spec as new goal
    if (result.handoffSpec && store) {
      this.logger.info('Handoff detected, clearing context and starting execution phase', {
        sessionKey: context.sessionKey,
        specLength: result.handoffSpec.length,
      });

      // Clear context for fresh execution
      const freshContext = store.clearContext();
      store.clearPausedState();

      // Recursively run with the spec as the new goal (execution mode, not planning)
      return this.runOrchestrator(
        freshContext,
        result.handoffSpec,
        requestId,
        emit,
        llm,
        'standard', // Use standard agent for execution
        effectiveWorkingDir,
        false, // planMode: false - now in execution mode
        selectedModel,
        store
      );
    }

    // Store paused state for resume, or clear it on completion
    if (result.paused) {
      store?.setPausedState({
        goal,
        agentType,
        workingDir: effectiveWorkingDir,
        planMode,
        userPromptType: result.userPrompt?.questionType,
      });
    } else {
      store?.clearPausedState();
    }

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
        questionType: result.userPrompt.questionType,
      } : undefined,
      toolsUsed: [],
      durationMs: result.metrics.durationMs,
      metadata: { agentType, metrics: result.metrics },
    };
  }

  /**
   * Resume agent execution after user provides input.
   */
  resume(requestId: string, answer: unknown, sessionKey: string, workingDir?: string): AgentRunHandle {
    const eventQueue = new AsyncEventQueue();
    const runId = requestId;

    eventQueue.push(createStatusEvent('sending', 'Resuming with user input...'));

    this.pruneSessionStores('resume');
    const storeEntry = this.sessionStores.get(sessionKey);
    const store = storeEntry?.store ?? null;
    const paused = store?.getPausedState() ?? null;
    if (storeEntry) {
      storeEntry.lastAccessMs = Date.now();
    }
    if (!store || !paused) {
      const errorMessage = 'No paused session found for this sessionKey';
      eventQueue.push(createErrorEvent(errorMessage, false));
      eventQueue.push(createStatusEvent('error', errorMessage));
      const resultPromise = Promise.resolve({
        requestId,
        sessionKey,
        success: false,
        finalText: '',
        errorMessage,
        paused: false,
        toolsUsed: [],
        durationMs: 0,
      } as AgentRunResult);
      queueMicrotask(() => eventQueue.finish());
      return { result: resultPromise, events: eventQueue };
    }

    // Attempt to mark execution as started; queue if another run is active.
    if (!store.startExecution(requestId)) {
      this.logger.warning('Resume called while another execution is in progress', {
        sessionKey,
        requestId,
        executingRequestId: store.getExecutingRequestId(),
      });

      // Queue the answer as a user message for the running execution
      const answerText = typeof answer === 'string' ? answer : JSON.stringify(answer);
      store.queueUserMessage(requestId, answerText);
      this.persistUserMessage(sessionKey, requestId, answerText);

      eventQueue.push(createStatusEvent('idle', 'Answer queued - agent will see it on next turn'));

      const resultPromise = Promise.resolve({
        requestId,
        sessionKey,
        success: true,
        finalText: '',
        paused: false,
        toolsUsed: [],
        durationMs: 0,
        metadata: { queued: true, executingRequestId: store.getExecutingRequestId() },
      } as AgentRunResult);

      queueMicrotask(() => eventQueue.finish());
      return { result: resultPromise, events: eventQueue };
    }

    if (this.isGraphDReady()) {
      try {
        const effectiveWorkingDir = workingDir ?? paused.workingDir;
        store.touch(effectiveWorkingDir);
        this.graphd!.setActive(true);
        if (!this.graphdSubscriber) {
          this.graphdSubscriber = createGraphDSubscriber(this.eventBus, this.graphd!, { batchMode: false });
          this.logger.debug('GraphDSubscriber created');
        }
      } catch (error) {
        this.logger.warning('GraphD session touch failed', { error: String(error) });
      }
    }

    const contextWindow = store.getContext();
    const emit = createEventEmitCallback(this.eventBus, requestId, runId, sessionKey);

    const unsubscribe = this.eventBus.subscribeRun(runId, (event: AgentEvent): void => {
      const bridgeEvent = translateAgentEvent(event);
      if (bridgeEvent) {
        eventQueue.push(bridgeEvent);
      }
    });

    const resultPromise = (async (): Promise<AgentRunResult> => {
      try {
        // Add user's response to context (serialize if structured)
        const answerText = typeof answer === 'string' ? answer : JSON.stringify(answer);
        contextWindow.addMessage('user', answerText);
        const userMessagePersisted = this.persistUserMessage(sessionKey, requestId, answerText);

        // Get selected model from session store or GraphD metadata if set
        let selectedModel: ModelOverride | undefined;
        const cachedSelected = store.getModelOverride();
        if (cachedSelected) {
          selectedModel = cachedSelected;
        } else if (this.isGraphDReady()) {
          try {
            const session = this.graphd!.sessionGet(sessionKey);
            const metadata = session?.metadata as Record<string, unknown> | undefined;
            const selectedFromMeta = metadata?.selected_model as { provider?: string; model?: string; reasoning?: string } | undefined;
            const legacyOverride = metadata?.model_override as { provider?: string; model?: string; reasoning?: string } | undefined;
            const override = selectedFromMeta ?? legacyOverride;
            if (override?.provider && override?.model) {
              selectedModel = {
                provider: override.provider,
                model: override.model,
                reasoning: override.reasoning,
              };
              store.setModelOverride(selectedModel);
            }
          } catch {
            // Ignore errors getting selected model - use default
          }
        }

        const isPlanModeExit = paused.userPromptType === 'plan_mode_exit';
        const normalizedAnswer = typeof answer === 'string'
          ? answer.trim().toLowerCase()
          : answer;
        // Check for approval - TUI sends option label text (e.g., "Yes, handoff now")
        // so we check startsWith('yes') in addition to exact matches
        const approvedHandoff = isPlanModeExit && (
          (typeof normalizedAnswer === 'string' && normalizedAnswer.startsWith('yes')) ||
          normalizedAnswer === '0' ||
          normalizedAnswer === 'y' ||
          normalizedAnswer === 'true' ||
          normalizedAnswer === 0 ||
          normalizedAnswer === true
        );

        if (approvedHandoff) {
          contextWindow.addMessage(
            'system',
            'User approved handoff. Set action: "handoff" with your complete implementation spec in handoffSpec. The system will automatically clear context and start execution with your spec.'
          );
        }

        // Re-run orchestrator with the stored goal/agentType/workingDir
        const effectiveWorkingDir = workingDir ?? paused.workingDir;
        const planMode = approvedHandoff ? false : paused.planMode;
        let result = await this.runOrchestrator(
          contextWindow,
          paused.goal,
          requestId,
          emit,
          this.llmAdapter,
          paused.agentType,
          effectiveWorkingDir,
          planMode,
          selectedModel,
          store
        );

        while (!result.paused) {
          const queuedMessages = store.drainQueuedMessages();
          if (queuedMessages.length > 0) {
            this.logger.info('Queued messages detected after resume execution, continuing run', {
              sessionKey,
              requestId,
              queuedCount: queuedMessages.length,
            });
            result = await this.runOrchestrator(
              contextWindow,
              paused.goal,
              requestId,
              emit,
              this.llmAdapter,
              paused.agentType,
              effectiveWorkingDir,
              planMode,
              selectedModel,
              store
            );
            continue;
          }

          if (store.endExecutionIfIdle()) {
            break;
          }

          const lateQueued = store.drainQueuedMessages();
          if (lateQueued.length === 0) {
            break;
          }
          this.logger.info('Late queued messages detected after resume, continuing run', {
            sessionKey,
            requestId,
            queuedCount: lateQueued.length,
          });
          result = await this.runOrchestrator(
            contextWindow,
            paused.goal,
            requestId,
            emit,
            this.llmAdapter,
            paused.agentType,
            effectiveWorkingDir,
            planMode,
            selectedModel,
            store
          );
        }

        if (result.paused && result.userPrompt) {
          // Pausing for user input - only emit user prompt event, not response
          eventQueue.push(createUserPromptEvent(
            result.userPrompt.requestId,
            result.userPrompt.question,
            result.userPrompt.options,
            result.userPrompt.context,
            result.userPrompt.multiSelect,
            result.userPrompt.questionType,
            result.userPrompt.questions
          ));
        } else {
          // Execution completed (success or failure) - emit response event
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
        }

        eventQueue.push(createStatusEvent('idle'));
        this.persistToGraphD(sessionKey, requestId, answerText, result.finalText, result.durationMs, userMessagePersisted);
        store.persistContext();

        return result;
      } catch (error) {
        // Handle RateLimitError specially - persist context and notify user gracefully
        if (RateLimitError.isRateLimitError(error)) {
          const rateLimitInfo = error.info;
          this.logger.warning('Rate limit hit during resume', {
            requestId,
            provider: error.provider,
            model: error.model,
            type: rateLimitInfo.type,
            retryAfterMs: rateLimitInfo.retryAfterMs,
          });

          // Persist context so user doesn't lose work
          store.persistContext();

          // Create a user-friendly error message
          let userMessage: string;
          if (rateLimitInfo.type === 'billing') {
            userMessage = `⚠️ Billing limit reached for ${error.provider}. Please check your account billing status. Your conversation has been saved.`;
          } else if (rateLimitInfo.type === 'quota') {
            userMessage = `⚠️ API quota exceeded for ${error.provider}. This may be a daily or monthly limit. Your conversation has been saved.`;
          } else {
            const waitTime = rateLimitInfo.retryAfterMs
              ? ` Please wait ${Math.ceil(rateLimitInfo.retryAfterMs / 1000)} seconds and try again.`
              : ' Please wait a moment and try again.';
            userMessage = `⚠️ Rate limit reached for ${error.provider}.${waitTime} Your conversation has been saved.`;
          }

          eventQueue.push(createErrorEvent(userMessage, false)); // recoverable, not fatal
          eventQueue.push(createStatusEvent('idle')); // Return to idle, not error state

          return {
            requestId,
            sessionKey,
            success: false,
            finalText: userMessage,
            errorMessage: error.message,
            paused: false,
            toolsUsed: [],
            durationMs: 0,
          };
        }

        // Handle CircuitOpenError - circuit breaker tripped
        if (error instanceof CircuitOpenError) {
          this.logger.warning('Circuit breaker open during resume', {
            requestId,
            message: error.message,
          });

          // Persist context so user doesn't lose work
          store.persistContext();

          const userMessage = `⚠️ Service temporarily unavailable (circuit breaker open). Please wait a moment and try again. Your conversation has been saved.`;

          eventQueue.push(createErrorEvent(userMessage, false)); // recoverable, not fatal
          eventQueue.push(createStatusEvent('idle')); // Return to idle, not error state

          return {
            requestId,
            sessionKey,
            success: false,
            finalText: userMessage,
            errorMessage: error.message,
            paused: false,
            toolsUsed: [],
            durationMs: 0,
          };
        }

        // Handle RetriesExhaustedError - all retry attempts failed
        if (error instanceof RetriesExhaustedError) {
          const causeMessage = error.cause instanceof Error ? error.cause.message : String(error.cause ?? '');
          this.logger.warning('All retries exhausted during resume', {
            requestId,
            attempts: error.attempts,
            cause: causeMessage,
          });

          // Persist context so user doesn't lose work
          store.persistContext();

          const userMessage = `⚠️ Request failed after ${error.attempts} attempts. Please wait a moment and try again. Your conversation has been saved.`;

          eventQueue.push(createErrorEvent(userMessage, false)); // recoverable, not fatal
          eventQueue.push(createStatusEvent('idle')); // Return to idle, not error state

          return {
            requestId,
            sessionKey,
            success: false,
            finalText: userMessage,
            errorMessage: error.message,
            paused: false,
            toolsUsed: [],
            durationMs: 0,
          };
        }

        // Generic error handling
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('Resume failed', { error: errorMessage, requestId });

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
        // Mark execution as complete
        const queuedMessages = store.endExecution();
        if (queuedMessages.length > 0) {
          this.logger.info('Resume execution ended with queued messages', {
            sessionKey,
            requestId,
            queuedCount: queuedMessages.length,
          });
        }

        // Run Stop hooks
        if (this.hookExecutor) {
          const hookContext: HookContext = {
            event: 'Stop',
            sessionKey,
            requestId,
            workingDir: workingDir ?? paused.workingDir,
          };
          await this.hookExecutor.execute('Stop', hookContext).catch((err) => {
            this.logger.warning('Stop hook failed', { error: String(err) });
          });
        }

        queueMicrotask(() => {
          unsubscribe();

          // Flush subscriber events to make them visible to dashboard immediately
          this.graphdSubscriber?.flush();

          if (this.isGraphDReady()) {
            try {
              this.graphd!.setActive(false);
            } catch {
              // Ignore errors during cleanup
            }
          }

          eventQueue.finish();
        });
      }
    })();

    return { result: resultPromise, events: eventQueue };
  }

  /**
   * Create a ready event for initialization.
   */
  createReadyEvent(sessionKey: string): BridgeEvent {
    return createReadyEvent(sessionKey);
  }

  /**
   * Get the loaded configuration.
   */
  getConfig(): FullHarnessConfig {
    return this.config;
  }

  /**
   * Fork a session: clone context in GraphD and pre-populate in-memory cache.
   */
  forkSession(sourceSessionKey: string, targetSessionKey: string): { success: boolean; error?: string } {
    if (!this.isGraphDReady()) {
      return { success: false, error: 'GraphD not available' };
    }

    const result = this.graphd!.sessionFork(sourceSessionKey, targetSessionKey);

    if (result.success) {
      // Pre-populate in-memory cache with cloned context
      const sourceEntry = this.sessionStores.get(sourceSessionKey);
      const sourceSnapshot = sourceEntry?.store.getCachedContextSnapshot() ?? null;
      if (sourceSnapshot) {
        const clonedSnapshot = { ...sourceSnapshot, sessionKey: targetSessionKey };
        const targetStore = this.getOrCreateSessionStore(targetSessionKey);
        targetStore.hydrateFromSnapshot(clonedSnapshot);
        this.logger.info('Forked session with in-memory context', {
          sourceSessionKey,
          targetSessionKey,
          contextItems: clonedSnapshot.items.length,
        });
      } else {
        this.logger.info('Forked session (no in-memory context to clone)', {
          sourceSessionKey,
          targetSessionKey,
        });
      }
    }

    return result;
  }

  /**
   * Manually compact context for a session.
   * This triggers immediate compaction regardless of current context usage.
   */
  compactContext(sessionKey: string): { success: boolean; itemsRemoved: number; bytesRecovered: number; error?: string } {
    const entry = this.sessionStores.get(sessionKey);
    if (!entry || !entry.store.getCachedContextSnapshot()) {
      return { success: false, itemsRemoved: 0, bytesRecovered: 0, error: 'No context found for session' };
    }

    const context = entry.store.getContext();

    try {
      const result = context.compact({
        deduplicateByPath: true,
        maxFileContentCount: 15,
        truncateOutputsTo: 3000,
      });

      this.logger.info('Manual context compaction', {
        sessionKey,
        itemsRemoved: result.itemsRemoved,
        bytesRecovered: result.bytesRecovered,
      });

      // Persist the compacted context
      entry.store.persistContext();

      return {
        success: true,
        itemsRemoved: result.itemsRemoved,
        bytesRecovered: result.bytesRecovered,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Context compaction failed', { sessionKey, error: message });
      return { success: false, itemsRemoved: 0, bytesRecovered: 0, error: message };
    }
  }

  /**
   * Shutdown the harness.
   */
  async shutdown(): Promise<void> {
    if (this.isShutdown) return;
    this.isShutdown = true;

    if (this.graphdSubscriber) {
      try {
        this.graphdSubscriber.close();
        this.logger.debug('Closed GraphDSubscriber');
      } catch (error) {
        this.logger.warning('GraphDSubscriber close failed', { error: String(error) });
      } finally {
        this.graphdSubscriber = null;
      }
    }

    if (this.isGraphDReady()) {
      for (const sessionKey of this.sessionStores.keys()) {
        try {
          this.graphd!.sessionClose(sessionKey);
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

    if (this.isGraphDReady()) {
      try {
        await this.graphd!.stop();
        this.logger.info('GraphD stopped');
      } catch (error) {
        this.logger.warning('GraphD stop failed', { error: String(error) });
      }
    }

    for (const entry of this.sessionStores.values()) {
      entry.store.close();
    }
    this.sessionStores.clear();
    this.toolRegistry.clearCache();

    // Close provider key service (releases LocalProviderManager resources)
    this.providerKeyService.close();

    this.logger.info('AgentHarness shutdown');
    this.logger.flush?.();
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
