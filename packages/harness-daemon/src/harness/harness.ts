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
  type ModelSelection,
  type MemoryInjector,
  type InternalHookEvent,
  type InternalHookContext,
  getAgentPrompt,
  buildAgentConfig,
  getPlanningPromptAddendum,
} from 'agent';
import os from 'os';
import { execSync } from 'child_process';
import { createAdapter, RateLimitError, CircuitOpenError, RetriesExhaustedError, type ProviderKeyService } from 'llm';
import { ToolRegistry, builtinToolOptions } from 'tools';
import { createEvent, successResult, errorResult, providerRequiresAuth, type AgentEvent, type ToolResult, type LLMClientConfig, type LLMProvider, type RateLimitData, type ArtifactDiscoveredData, type ArtifactKind } from 'types';
import { ContextWindow } from 'context';
import { profiler, buildLLMRequestConfig } from 'shared';
import { GraphDManager, createGraphDConfig } from 'graphd';
import { EventBus, type EventBusProtocol, createEventEmitCallback } from 'comms-bus';
import { createGraphDSubscriber } from '../subscribers/graphd_subscriber.js';
import { LogSubscriber, createLogSubscriber } from '../subscribers/log_subscriber.js';
import path from 'path';
import fs from 'fs';
import {
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
import type { FullHarnessConfig, ResolvedAgentConfig } from './config.js';
import { LocalProviderManager } from './local_providers.js';
import { HookExecutor } from './hook_executor.js';
import { loadSkillDefinitions, getSkillDefinition, type HookContext } from './skills_loader.js';
import { SessionStore } from './session_store.js';
import { createFileLogger, type HarnessLogger } from './harness_infra.js';
import { PermissionChecker } from './permissions.js';
import { DefaultOrchestratorRunner, type OrchestratorRunner } from './orchestrator_runner.js';
import type { PermissionedTool, PermissionRequest, PermissionResponse } from 'types';
import { isPermissionedTool, normalizeToolName } from 'types';
import {
  DecisionEngine,
  InMemoryDecisionDatabase,
  createDecisionEngine,
  createWatcherConfig,
  DEFAULT_DECISIONS,
  createWatcherStopHook,
  buildPlanningObjective,
  writeSalienceFile,
  createDecisionLog,
  createWorkLog,
  getWorkItemLog,
  createWorkItemLog,
  type DecisionDatabase,
  type WorkItemLog,
  type DecisionMemory,
  type WatcherAction,
  type DecisionLog,
  type WorkLog,
} from 'decision-watcher';
import { EntityGraph, type EntityGraphConfig } from 'entity-graph';
import { registerHook } from 'orchestrator';
import { createWorkItem } from 'work';
import { createMemoryInjector, type MemoryInjector as MemoryInjectorInstance } from 'memory-injector';

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
  // Registry stores ONLY agent capabilities (tools, budget, schema, llmParams).
  // LLM provider/model comes EXCLUSIVELY from SessionStore via getModelSelection.
  const agentConfigs: AgentConfig[] = Object.entries(config.agents).map(([agentType, resolved]) => {
    const llmParams = {
      maxTokens: resolved.llm.maxTokens,
      temperature: resolved.llm.temperature ?? 0.7,
    };
    return buildAgentConfig(agentType, resolved.tools, resolved.budget, llmParams, resolved.outputSchema, envContext) as AgentConfig;
  });

  const registry = new AgentRegistry(agentConfigs);

  // Validate agent tool references and prevent self-reference
  const builtinTools = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'Skill', 'PromptUser']);
  const registeredAgentTypes = new Set(agentConfigs.map(c => c.type));
  for (const agentConf of agentConfigs) {
    // Filter out self-references to prevent recursive agent calls
    const selfRefLower = agentConf.type.toLowerCase();
    agentConf.tools = agentConf.tools.filter(tool => {
      if (tool.toLowerCase() === selfRefLower) {
        console.warn(`[harness] Removing self-reference: agent '${agentConf.type}' cannot have itself as a tool`);
        return false;
      }
      return true;
    });

    for (const tool of agentConf.tools) {
      const toolLower = tool.toLowerCase();
      if (!builtinTools.has(tool) && !registeredAgentTypes.has(tool) && !registeredAgentTypes.has(toolLower)) {
        console.warn(`[harness] Agent '${agentConf.type}' references tool '${tool}' which is not available`);
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
 * Queries API keys at runtime from LocalProviderManager (GraphD storage) ONLY.
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
    // ONLY check LocalProviderManager (GraphD storage)
    // Config file providers and env vars are no longer supported
    if (this.localProviders) {
      const key = this.localProviders.getProviderKey(provider);
      if (key) {
        this.logger.debug('API key found in GraphD', { provider });
        return key;
      }
    }

    // Return null instead of throwing - let the adapter handle missing keys
    return null;
  }

  hasApiKey(provider: string): boolean {
    // Providers that don't require auth (e.g., lmstudio) always return true
    if (!providerRequiresAuth(provider)) {
      return true;
    }
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
  private readonly pauseTimeoutMs: number;
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
  private permissionChecker: PermissionChecker;
  private orchestratorRunner: OrchestratorRunner;
  private decisionDatabases = new Map<string, DecisionDatabase>();
  private watcherEngines = new Map<string, DecisionEngine>();
  private sessionWorkLogs = new Map<string, WorkLog>();
  /** Track workitem logs by composite key: `${sessionKey}:${workId}` */
  private workItemLogs = new Map<string, WorkItemLog>();
  private entityGraph: EntityGraph | null = null;
  private memoryInjector: MemoryInjector | null = null;

  constructor(config: FullHarnessConfig, logger?: HarnessLogger, orchestratorRunner?: OrchestratorRunner) {
    this.config = config;
    this.logger = logger ?? consoleLogger;
    this.sessionTtlMs = config.context.sessionTtlMs;
    this.pauseTimeoutMs = config.context.pauseTimeoutMs;

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
        dangerousMode: config.dangerousMode,
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

    // Initialize PermissionChecker - handles permission prompts for Bash/Write/Edit
    this.permissionChecker = new PermissionChecker(workingDir, config.dangerousMode);
    if (config.dangerousMode) {
      this.logger.warning('Permission checks DISABLED - running in dangerous mode');
    } else {
      this.logger.info('PermissionChecker initialized', { workingDir });
    }

    this.orchestratorRunner = orchestratorRunner ?? new DefaultOrchestratorRunner();

    // Initialize MemoryInjector if enabled
    if (config.memory.enabled) {
      this.memoryInjector = createMemoryInjector({
        baseUrl: config.memory.baseUrl,
        timeout: config.memory.timeoutMs,
      });
      this.logger.info('MemoryInjector initialized', {
        baseUrl: config.memory.baseUrl,
        timeoutMs: config.memory.timeoutMs,
      });
    }

    const defaultAgent = config.agents[config.defaultAgent];
    this.logger.info('AgentHarness initialized', {
      defaultAgent: config.defaultAgent,
      provider: defaultAgent?.llm.provider,
      model: defaultAgent?.llm.model,
      agentCount: Object.keys(config.agents).length,
      graphdEnabled: this.graphd !== null,
      memoryEnabled: this.memoryInjector !== null,
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
   * Get the auth config from the loaded config.
   */
  getAuthConfig(): { enabled: boolean; host: string; port: number; google_client_id?: string; google_redirect_uri?: string; master_key_path?: string; graphd_db_path?: string } | undefined {
    return {
      enabled: this.config.auth.enabled,
      host: this.config.auth.host,
      port: this.config.auth.port,
      google_client_id: this.config.auth.google_client_id,
      google_redirect_uri: this.config.auth.google_redirect_uri,
      master_key_path: this.config.auth.master_key_path,
      graphd_db_path: this.config.auth.graphd_db_path,
    };
  }

  /**
   * Close and evict in-memory state for a session.
   * Persists context and marks session inactive before closing.
   */
  closeSession(sessionKey: string): void {
    const entry = this.sessionStores.get(sessionKey);
    if (entry) {
      // Persist context before closing
      entry.store.persistContext();

      // Mark session as inactive in GraphD
      if (this.isGraphDReady()) {
        try {
          this.graphd!.sessionUpdateStatus(sessionKey, 'inactive');
        } catch (error) {
          this.logger.warning('Failed to mark session inactive', { sessionKey, error: String(error) });
        }
      }

      entry.store.close();
      this.sessionStores.delete(sessionKey);
    }
    this.decisionDatabases.delete(sessionKey);
    this.watcherEngines.delete(sessionKey);
    this.sessionWorkLogs.delete(sessionKey);
  }

  /**
   * Start async services (GraphD, EntityGraph).
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

    // Initialize EntityGraph if enabled
    if (this.config.entityGraph.enabled && !this.entityGraph) {
      try {
        const dbUrl = this.config.entityGraph.databaseUrl
          ?? process.env.ENTITY_GRAPH_DATABASE_URL
          ?? process.env.DATABASE_URL;

        if (!dbUrl) {
          this.logger.warning('EntityGraph enabled but no database URL configured (entity_graph.database_url or DATABASE_URL env)');
        } else {
          const postgres = (await import('postgres')).default;
          const sql = postgres(dbUrl, { max: 5, idle_timeout: 30, connect_timeout: 10 });

          const entityGraphConfig: EntityGraphConfig = {
            sourceRoot: this.config.tools.workingDir,
            include: this.config.entityGraph.include,
            exclude: this.config.entityGraph.exclude,
            leaseDurationSec: this.config.entityGraph.leaseDurationSec,
            startupScan: this.config.entityGraph.startupScan,
            leaseWaitTimeoutMs: this.config.entityGraph.leaseWaitTimeoutMs,
          };

          this.entityGraph = new EntityGraph(sql, entityGraphConfig);
          await this.entityGraph.initialize();
          this.logger.info('EntityGraph initialized (scan running in background)');

          // Register files_modified hook handler
          const hooks = this.entityGraph.getHooks();
          registerHook('files_modified', async (event: { type: string; paths?: string[] }) => {
            if (event.type === 'files_modified' && event.paths) {
              await hooks.onFilesModified(event.paths);
            }
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error('EntityGraph failed to start', { error: message });
        // Non-fatal — daemon continues without entity graph
      }
    }

    return true;
  }

  /**
   * Get or create a SessionStore for the session.
   */
  private getOrCreateSessionStore(sessionKey: string, dangerousMode = false, workingDir?: string): SessionStore {
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
      dangerousMode,
      workingDir: workingDir ?? this.config.tools.workingDir,
    });
    this.sessionStores.set(sessionKey, { store, lastAccessMs: now });
    return store;
  }

  /**
   * Single entrypoint for session rehydration (context + model selections).
   */
  ensureSessionHydrated(
    sessionKey: string,
    options: { workingDir?: string; dangerousMode?: boolean; includeUserPreferences?: boolean } = {}
  ): SessionStore {
    const store = this.getOrCreateSessionStore(sessionKey, options.dangerousMode ?? false, options.workingDir);
    // Hydrate context + session metadata (paused state, permissions, model selections).
    store.getContext();

    if (options.includeUserPreferences !== false) {
      this.hydrateModelSelectionsFromPreferences(sessionKey, store);
    }

    return store;
  }

  private hydrateModelSelectionsFromPreferences(sessionKey: string, store: SessionStore): void {
    if (!this.isGraphDReady() || !this.graphd) {
      return;
    }
    if (store.getAllModelSelections().size > 0) {
      return;
    }

    const hiddenModels = this.graphd.getUserPreference<string[]>('user_prefs:hidden_models') ?? [];
    const modelSelectionsMap = this.graphd.getUserPreference<Record<string, { provider: string; model: string; reasoning?: string }>>(
      'user_prefs:model_selections'
    );
    if (!modelSelectionsMap) {
      return;
    }

    let applied = 0;
    for (const [agentType, selection] of Object.entries(modelSelectionsMap)) {
      if (selection?.provider && selection?.model) {
        const isHidden = hiddenModels.some(
          (hidden) => hidden.trim().toLowerCase() === selection.model.trim().toLowerCase()
        );
        if (!isHidden) {
          store.setModelSelection(agentType, selection);
          applied += 1;
        }
      }
    }

    if (applied > 0) {
      // Keep session metadata aligned with global preferences.
      this.graphd.sessionUpdateMetadata(sessionKey, { model_selections: modelSelectionsMap });
    }
  }

  setSessionSelectedModel(sessionKey: string, agentType: string, selectedModel: ModelSelection | null): void {
    const store = this.getOrCreateSessionStore(sessionKey);
    if (selectedModel) {
      store.setModelSelection(agentType, selectedModel);
    } else {
      // Clear this specific agent type - if agentType is 'standard', we clear all since it's the main/default
      // For now, we don't have a clearModelSelection(agentType) method, so just set to null equivalent
      // Actually, we should just not call this with null - the UI should only call with a valid selection
    }
  }

  getSessionSelectedModel(sessionKey: string, agentType: string): ModelSelection | null {
    const entry = this.sessionStores.get(sessionKey);
    return entry?.store.getModelSelection(agentType) ?? null;
  }

  getAllSessionSelectedModels(sessionKey: string): Map<string, ModelSelection> {
    const entry = this.sessionStores.get(sessionKey);
    return entry?.store.getAllModelSelections() ?? new Map();
  }

  private pruneSessionStores(reason: string): void {
    if (this.sessionTtlMs <= 0) return;
    const now = Date.now();
    const cutoff = now - this.sessionTtlMs;
    for (const [sessionKey, entry] of this.sessionStores.entries()) {
      const pausedState = entry.store.getPausedState();
      if (pausedState) {
        // Paused sessions: check if paused too long
        const pausedDuration = now - pausedState.pausedAt;
        if (pausedDuration < this.pauseTimeoutMs) continue; // Still within timeout, skip
        // Paused too long - persist and evict
        entry.store.persistContext();
        entry.store.close();
        this.sessionStores.delete(sessionKey);
        this.logger.debug('Evicted paused session (timeout)', {
          sessionKey,
          reason,
          pausedMs: pausedDuration,
        });
      } else {
        // Active sessions: check TTL as before
        if (entry.lastAccessMs > cutoff) continue;
        entry.store.close();
        this.sessionStores.delete(sessionKey);
        this.logger.debug('Evicted session store', {
          sessionKey,
          reason,
          idleMs: now - entry.lastAccessMs,
        });
      }
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
   * Also handles resuming paused sessions - if a session is paused, inputText is treated as the answer.
   */
  run(params: AgentRunParams): AgentRunHandle {
    const { requestId, inputText, tier: requestedTier, sessionKey, workingDir, planMode, stopHook } = params;
    profiler.instant('harness.run', 'harness', 'p', { requestId, tier: requestedTier, planMode });
    const runId = requestId;
    const eventQueue = new AsyncEventQueue();

    this.pruneSessionStores('run');
    const store = this.ensureSessionHydrated(sessionKey, { workingDir, includeUserPreferences: true });
    const paused = store.getPausedState();

    // Determine if this is a resume (paused state exists) or fresh run
    const isResume = !!paused;
    eventQueue.push(createStatusEvent('sending', isResume ? 'Resuming with user input...' : 'Processing request...'));

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

    // Determine execution parameters based on paused state
    let goal: string;
    let effectiveAgentType: AgentType;
    let effectivePlanMode: boolean | undefined;
    let effectiveWorkingDir: string;
    let contextWindow = store.getContext();
    let clearContextForHandoff = false;

    if (isResume) {
      // This is a resume - inputText is the answer to a pending question
      const normalizedAnswer = inputText.trim().toLowerCase();
      const isSpecReview = paused.userPromptType === 'spec_review';
      const isHandoffApproval = paused.userPromptType === 'handoff_approval';
      const isPlanModeExit = paused.userPromptType === 'plan_mode_exit';

      const userApproved = (
        normalizedAnswer.startsWith('yes') ||
        normalizedAnswer === '0' ||
        normalizedAnswer === 'y' ||
        normalizedAnswer === 'true'
      );

      const userHandoff = normalizedAnswer === 'handoff';

      // Handle handoff from plan mode - user says "handoff" to approve spec
      if (paused.handoffSpec && userHandoff) {
        // User approved spec - clear context and execute with handoffSpec
        this.logger.info('User approved spec review, executing with spec', {
          sessionKey,
          specLength: paused.handoffSpec.length,
        });
        contextWindow = store.clearContext();
        store.clearPausedState();
        goal = paused.handoffSpec;
        effectiveAgentType = 'standard';
        effectivePlanMode = false;
        effectiveWorkingDir = workingDir ?? paused.workingDir;
        clearContextForHandoff = true;
      }
      // Handle legacy handoff_approval (orchestrator-level approval)
      else if (isHandoffApproval && paused.handoffSpec && userApproved) {
        // User approved handoff - clear context and execute with handoffSpec
        this.logger.info('User approved handoff, executing with spec', {
          sessionKey,
          specLength: paused.handoffSpec.length,
        });
        contextWindow = store.clearContext();
        store.clearPausedState();
        goal = paused.handoffSpec;
        effectiveAgentType = 'standard';
        effectivePlanMode = false;
        effectiveWorkingDir = workingDir ?? paused.workingDir;
        clearContextForHandoff = true;
      } else {
        // Normal resume or rejection - add answer to context and continue
        contextWindow.addMessage('user', inputText);

        if ((isSpecReview || isHandoffApproval) && !userApproved) {
          contextWindow.addMessage(
            'system',
            'User rejected the plan. Revise based on their feedback and ask for approval again when ready.'
          );
        } else if (isPlanModeExit) {
          if (userApproved) {
            contextWindow.addMessage(
              'system',
              'User approved handoff. Set action: "handoff" with your complete implementation spec in handoffSpec. The system will automatically clear context and start execution with your spec.'
            );
          } else {
            contextWindow.addMessage(
              'system',
              'User rejected the handoff and wants you to continue planning. Revise your plan based on their feedback and ask for approval again when ready.'
            );
          }
        }

        goal = paused.goal;
        effectiveAgentType = paused.agentType as AgentType;
        effectivePlanMode = isPlanModeExit && userApproved ? false : paused.planMode;
        effectiveWorkingDir = workingDir ?? paused.workingDir;
      }
    } else {
      // Fresh run - inputText is the goal
      contextWindow.addMessage('user', inputText);
      goal = inputText;
      effectiveAgentType = requestedTier || 'standard';
      effectivePlanMode = planMode;
      effectiveWorkingDir = workingDir ?? this.config.tools.workingDir;
    }

    if (this.isGraphDReady()) {
      try {
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

    const userMessagePersisted = clearContextForHandoff ? false : this.persistUserMessage(sessionKey, requestId, inputText);
    const emit = createEventEmitCallback(this.eventBus, requestId, runId, sessionKey);

    // NOTE: Agent events (agent_message, tool_call, etc.) are now forwarded directly
    // from EventBus to BusServer via BusServer's direct subscription. The eventQueue
    // is only used for harness-level events (status, response, error, user_prompt).

    const resultPromise = (async (): Promise<AgentRunResult> => {
      try {
        // Run UserPromptSubmit hooks before processing
        if (this.hookExecutor) {
          const hookContext: HookContext = {
            event: 'UserPromptSubmit',
            sessionKey,
            requestId,
            workingDir: effectiveWorkingDir,
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

        // Get the appropriate agent config
        const agentConfig = getAgentConfig(this.config, effectiveAgentType);

        this.logger.debug('Running with agent config', {
          agentType: effectiveAgentType,
          isResume,
          model: agentConfig.llm.model,
          provider: agentConfig.llm.provider,
        });

        if (this.isGraphDReady()) {
          try {
            this.graphd!.sessionUpdateMetadata(sessionKey, {
              user_id: 'local-user',
              tier: effectiveAgentType,
              model: agentConfig.llm.model,
              provider: agentConfig.llm.provider,
            });
          } catch (error) {
            this.logger.warning('GraphD session metadata update failed', { error: String(error) });
          }
        }

        const llmAdapter = this.llmAdapter;

        // All requests go through orchestrator (loop-until-goal architecture)
        // Orchestrator handles interruptions internally via checkInterruption() callback
        // Note: stopHook only applies to fresh runs, not resumes
        const result = await this.runOrchestrator(contextWindow, goal, requestId, emit, llmAdapter, effectiveAgentType, effectiveWorkingDir, effectivePlanMode, store, isResume ? undefined : stopHook);

        if (result.paused && result.userPrompt) {
          // Pausing for user input - emit response first (if any), then user prompt
          if (result.finalText) {
            eventQueue.push(
              createResponseEvent(
                requestId,
                true, // Partial success - got response before pause
                result.finalText,
                result.toolsUsed,
                result.durationMs,
                undefined,
                result.metadata
              )
            );
          }
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
   * Create AgentHooks that handle permission checking and delegate to HookExecutor.
   */
  private createAgentHooks(sessionKey: string, requestId: string, emit?: (event: AgentEvent) => void): AgentHooks {
    const executor = this.hookExecutor;
    const workingDir = this.config.tools.workingDir;
    const logger = this.logger;
    const egHooks = this.entityGraph?.getHooks() ?? null;

    // Get the session store to use its per-session permission checker
    const sessionStore = this.getOrCreateSessionStore(sessionKey);
    const permissionChecker = sessionStore.getPermissionChecker();

    return {
      preToolUse: async (toolName: string, args: Record<string, unknown>): Promise<ToolHookResult> => {
        // Check permissions for Bash, Write, Edit tools
        if (isPermissionedTool(toolName)) {
          const tool = normalizeToolName(toolName);
          if (tool) {
            const target = PermissionChecker.extractTarget(tool, args);
            const decision = permissionChecker.check(tool, target);

            if (decision.granted === false) {
              logger.info('Permission denied', { tool, target, reason: decision.reason });
              return {
                action: 'block',
                message: `Permission denied: ${decision.reason}`,
              };
            }

            if (decision.granted === 'ask') {
              // Create permission request and wait for user response
              const request = permissionChecker.createRequest(tool, target, workingDir);
              logger.info('Requesting permission', { tool, target, requestId: request.requestId });

              // Emit permission_request event via emit callback if available
              if (emit) {
                emit({
                  type: 'permission_request',
                  requestId,
                  sessionKey,
                  timestamp: Date.now() / 1000,
                  data: {
                    requestId: request.requestId,
                    tool: request.tool,
                    target: request.target,
                    suggestedPattern: request.suggestedPattern,
                    workingDirectory: request.workingDirectory,
                    description: request.description,
                  },
                });
              }

              // Wait for user response via promise
              const response = await new Promise<PermissionResponse>((resolve) => {
                permissionChecker.registerPendingRequest(request.requestId, request, resolve);
              });

              if (response.decision === 'deny') {
                logger.info('User denied permission', { tool, target });
                return {
                  action: 'block',
                  message: 'Permission denied by user',
                };
              }

              // 'allow' or 'always_allow' - proceed with tool execution
              logger.info('Permission granted', { tool, target, decision: response.decision });
            }
          }
        }

        // Entity graph file lease check
        if (egHooks) {
          const egResult = await egHooks.preToolUse(sessionKey, toolName, args);
          if (egResult.action === 'block') {
            logger.info('Entity graph lease blocked', { toolName, message: egResult.message });
            return { action: 'block', message: egResult.message };
          }
        }

        // Run hook executor if available
        if (executor) {
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
        }

        return { action: 'allow' };
      },

      postToolUse: async (toolName: string, args: Record<string, unknown>, toolResult: ToolResult): Promise<ToolHookResult> => {
        // Entity graph: release lease, compute blast radius, re-parse modified file
        let egModified = false;
        if (egHooks) {
          try {
            const egResult = await egHooks.postToolUse(sessionKey, toolName, args);
            if (egResult.context) {
              toolResult = { ...toolResult, output: toolResult.output + '\n\n' + egResult.context };
              egModified = true;
            }
          } catch (err) {
            logger.warning('Entity graph postToolUse failed', { error: String(err) });
          }
        }

        if (!executor) {
          return egModified
            ? { action: 'modify', modifiedResult: toolResult }
            : { action: 'allow' };
        }

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

        // If executor modified the result, use its version.
        // Otherwise, propagate entity-graph context if present.
        if (result.action === 'modify' && result.modified) {
          return { action: 'modify', message: result.message, modifiedResult: result.modified as unknown as ToolResult };
        }
        if (egModified) {
          return { action: 'modify', modifiedResult: toolResult };
        }
        return { action: result.action, message: result.message };
      },
    };
  }

  private attachArtifactSubscriber(context: ContextWindow): () => void {
    return this.eventBus.subscribe('artifact_discovered', (event: AgentEvent<ArtifactDiscoveredData>) => {
      const data = event.data;
      if (!data?.artifact) {
        return;
      }
      context.addArtifact({
        sourcePath: data.artifact.sourcePath,
        line: data.artifact.line,
        kind: data.artifact.kind as ArtifactKind,
        name: data.artifact.name,
        signature: data.artifact.signature,
        insight: data.artifact.insight,
        relevance: data.artifact.relevance,
        discoveredBy: data.agentType,
      });
    });
  }

  /**
   * Get the permission checker for a specific session.
   * Each session has its own permission state including dangerous mode.
   */
  getSessionPermissionChecker(sessionKey: string): PermissionChecker | null {
    const entry = this.sessionStores.get(sessionKey);
    if (entry) {
      return entry.store.getPermissionChecker();
    }
    return null;
  }

  /**
   * @deprecated Use getSessionPermissionChecker(sessionKey) instead.
   * Returns the global permission checker (legacy behavior).
   */
  getPermissionChecker(): PermissionChecker {
    return this.permissionChecker;
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
    store?: SessionStore,
    stopHook?: import('orchestrator').StopHookHandler
  ): Promise<AgentRunResult> {
    const hooks = this.createAgentHooks(context.sessionKey, requestId, emit);

    // Build plan mode options if enabled
    const planModeOptions = planMode ? {
      enabled: true,
      promptAddendum: getPlanningPromptAddendum(),
      toolFilter: (tools: string[]) => this.filterPlanModeTools(tools),
    } : undefined;

    // Create closure for per-agent-type model selection lookup
    // NO FALLBACK: Each agent type must have an explicit model selection
    const getModelSelection = store
      ? (queryAgentType: string) => {
          const selection = store.getModelSelection(queryAgentType);
          if (selection) {
            this.logger.debug('Model selection for agent', {
              agentType: queryAgentType,
              model: selection.model,
              provider: selection.provider,
              reasoning: selection.reasoning,
            });
          }
          return selection;
        }
      : undefined;

    // Build orchestrator runtime with optional hooks
    const sessionKey = context.sessionKey;
    let lastWatcherIteration = 0;
    const MIN_WATCHER_GAP = 5;

    const runtime = {
      stopHook,
      onStart: (activeContext: ContextWindow) => this.attachArtifactSubscriber(activeContext),
      // Pass interruption check callback so orchestrator can avoid premature termination
      // when user messages arrived during execution.
      // The callback drains the queue (clear on check) so subsequent checks return false.
      checkInterruption: store ? () => {
        const pending = store.drainQueuedMessages();
        return pending.length > 0;
      } : undefined,
      // Pass stop request check so agent can exit loop early on explicit "stop" from user
      checkStopRequest: store ? () => store.hasPendingStopRequest() : undefined,
      // Watcher evaluation — rule-based, fires every MIN_WATCHER_GAP iterations
      onIteration: (state: { iteration: number; context: ContextWindow; totalToolCalls: number; totalLlmCalls: number; elapsedMs: number }) => {
        if (state.iteration - lastWatcherIteration < MIN_WATCHER_GAP) return;
        lastWatcherIteration = state.iteration;

        const pct = state.context.metrics.percentageUsed;
        const engine = this.getOrCreateWatcherEngine(sessionKey);
        const memory = engine.getSessionMemory(sessionKey);
        const hasDecisions = (memory?.decisionsMade.length ?? 0) > 0;

        // Summarize (compact + epistemic ledger) when context is high and decisions exist
        if (pct > 0.70 && hasDecisions) {
          this.logger.info('Watcher: summarizing (context high + decisions in play)', { pct, sessionKey });
          this.watcherSummarize(sessionKey);
          return;
        }

        // Plain compact when context is high but no decisions to ledger
        if (pct > 0.75) {
          this.logger.info('Watcher: triggering compact (context > 75%)', { pct, sessionKey });
          this.watcherSummarize(sessionKey);
          return;
        }
      },
    };

    // Execute with session-specific working directory (passed explicitly for concurrent-safety)
    const effectiveWorkingDir = workingDir ?? this.config.tools.workingDir;
    const sessionDb = this.getOrCreateDecisionDatabase(context.sessionKey);
    const asyncId = profiler.asyncBegin(`orchestrator:${agentType}`, 'orchestrator');
    const result = await this.orchestratorRunner.execute({
      config: {
        asyncMode: {
          enabled: true,
          database: sessionDb,
        },
        memoryInjector: this.memoryInjector ?? undefined,
      },
      toolRegistry: this.toolRegistry,
      llm,
      emit,
      requestId,
      logger: this.logger,
      agentRegistry: this.agentRegistry,
      hooks,
      planModeOptions,
      getModelSelection,
      context,
      goal,
      agentType,
      cwd: effectiveWorkingDir,
      runtime,
    });
    profiler.asyncEnd(`orchestrator:${agentType}`, asyncId, 'orchestrator', { toolCalls: result.metrics.totalToolCalls, paused: result.paused });

    // Handle handoff: store handoffSpec for approval in paused state
    if (result.handoffSpec && store) {
      this.logger.info('Handoff requested, pausing for user approval', {
        sessionKey: context.sessionKey,
        specLength: result.handoffSpec.length,
      });
    }

    // Store paused state for resume, or clear it on completion
    if (result.paused) {
      store?.setPausedState({
        goal,
        agentType,
        workingDir: effectiveWorkingDir,
        planMode,
        userPromptType: result.userPrompt?.questionType,
        handoffSpec: result.handoffSpec,
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
        questions: result.userPrompt.questions,
      } : undefined,
      toolsUsed: [],
      durationMs: result.metrics.durationMs,
      metadata: { agentType, metrics: result.metrics },
    };
  }

  /**
   * Get message history for a session.
   * Returns conversation history that should be displayed in TUI.
   */
  getSessionHistory(sessionKey: string): Array<{ role: 'user' | 'agent' | 'system'; content: string; timestamp: number; requestId?: string }> {
    const store = this.ensureSessionHydrated(sessionKey, { includeUserPreferences: false });
    return store.getMessageHistory();
  }

  /**
   * Create a ready event for initialization.
   */
  createReadyEvent(sessionKey: string): BridgeEvent {
    return createReadyEvent(sessionKey, this.getSessionHistory(sessionKey));
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

  // =========================================================================
  // Watcher Agent: LLM-backed StopHook
  // =========================================================================

  /**
   * Run the watcher agent with a trigger-specific objective.
   * Creates a mini Agent instance, executes it, and parses the structured WatcherAction output.
   */
  private async runWatcherAgent(objective: string, sessionKey: string, trigger?: string): Promise<WatcherAction> {
    // Get the watcher agent config from registry
    if (!this.agentRegistry.has('watcher')) {
      this.logger.warning('Watcher agent type not registered, defaulting to continue');
      return { watcherAction: 'continue', reason: 'Watcher agent not configured' };
    }

    const agentConfig = this.agentRegistry.getConfig('watcher');

    // Get model selection for the watcher agent type
    const store = this.sessionStores.get(sessionKey)?.store;
    const modelSelection = store?.getModelSelection('watcher')
      ?? store?.getModelSelection('standard');

    if (!modelSelection) {
      this.logger.warning('No model selection available for watcher agent');
      return { watcherAction: 'continue', reason: 'No model selection for watcher' };
    }

    const llmConfig = buildLLMRequestConfig(modelSelection, agentConfig.llmParams);

    // Import getValidActions to build trigger-specific schema
    const { getValidActions } = await import('decision-watcher');

    // Build trigger-specific output schema
    // Only present valid action types for this specific trigger
    const validActions = trigger ? getValidActions(trigger as any) : [];
    const triggerInfo = trigger ? `\n\nValid actions for this trigger: ${validActions.join(', ')}` : '';

    // Build dynamic schema with trigger-specific action enum but full field set
    const actionEnum = validActions.length > 0 ? {
      watcherAction: {
        type: 'string',
        enum: validActions,
        description: `The action type to take. Valid actions for trigger "${trigger}": ${validActions.join(', ')}`,
      },
    } : {
      watcherAction: {
        type: 'string',
        enum: ['answer', 'realign', 'split', 'create_work_item', 'quality_gate', 'continue'],
        description: 'The action type to take',
      },
    };

    // Full watcher action schema with all optional fields
    const outputSchema = {
      name: 'WatcherAction',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...actionEnum,
          reason: {
            type: 'string',
            description: 'Rationale for this decision',
          },
          answer: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: {
              text: { type: 'string', description: 'The answer text to inject' },
              contextAddendum: { type: ['string', 'null'], description: 'Additional context to append' },
            },
            required: ['text'],
          },
          realign: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: {
              systemMessage: { type: 'string', description: 'System message to inject into context' },
              newGoal: { type: ['string', 'null'], description: 'Replacement goal if drifted' },
            },
            required: ['systemMessage'],
          },
          workItems: {
            type: ['array', 'null'],
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                goal: { type: 'string' },
                objective: { type: 'string' },
                agent: { type: 'string' },
                dependencies: { type: ['array', 'null'], items: { type: 'string' } },
                targetPaths: { type: ['array', 'null'], items: { type: 'string' } },
                bounds: {
                  type: ['object', 'null'],
                  additionalProperties: false,
                  properties: {
                    maxToolCalls: { type: ['number', 'null'] },
                    maxLlmCalls: { type: ['number', 'null'] },
                    maxDurationMs: { type: ['number', 'null'] },
                  },
                },
              },
              required: ['goal', 'objective', 'agent'],
            },
          },
          qualityGate: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: {
              passed: { type: 'boolean' },
              issues: { type: ['array', 'null'], items: { type: 'string' } },
            },
            required: ['passed'],
          },
        },
        required: ['watcherAction', 'reason', 'answer', 'realign', 'workItems', 'qualityGate'],
      },
    };

    // Override the agent config's output schema with the trigger-specific one
    const watcherConfig = { ...agentConfig, outputSchema };

    // Create watcher-specific emit callback so watcher appears in dashboard
    const watcherRequestId = `watcher-${trigger ?? 'unknown'}-${Date.now()}`;
    const watcherRunId = `watcher-run-${Date.now()}`;
    const emit = createEventEmitCallback(this.eventBus, watcherRequestId, watcherRunId, sessionKey);

    const agent = new Agent(watcherConfig, {
      llm: this.llmAdapter,
      toolRegistry: this.toolRegistry,
      llmConfig,
      agentRegistry: this.agentRegistry,
      emit,
      requestId: watcherRequestId,
      sessionKey,
      getModelSelection: store
        ? (t: string) => store.getModelSelection(t)
        : undefined,
    });

    // Create a minimal context for the watcher
    const context = new ContextWindow(sessionKey, 200_000);
    const workingDir = this.config.tools.workingDir;

    const workItem = createWorkItem({
      goal: 'watcher_evaluation',
      objective: objective + triggerInfo,
      agent: 'watcher',
      bounds: {
        maxToolCalls: agentConfig.budget.maxToolCalls,
        maxDurationMs: agentConfig.budget.maxDurationMs,
        maxLlmCalls: agentConfig.budget.maxIterations,
      },
    });

    try {
      const result = await agent.run({ globalContext: context, workItem, cwd: workingDir });
      const structured = result.structuredOutput as Record<string, unknown> | undefined;

      // Runtime validation: ensure structured output is a valid WatcherAction
      if (
        structured &&
        typeof structured === 'object' &&
        typeof structured.watcherAction === 'string' &&
        structured.watcherAction.length > 0
      ) {
        return {
          watcherAction: structured.watcherAction as WatcherAction['watcherAction'],
          reason: typeof structured.reason === 'string' ? structured.reason : '',
          answer: structured.answer as WatcherAction['answer'],
          realign: structured.realign as WatcherAction['realign'],
          workItems: structured.workItems as WatcherAction['workItems'],
          qualityGate: structured.qualityGate as WatcherAction['qualityGate'],
        };
      }

      // Fallback: structured output missing or malformed
      this.logger.warning('Watcher agent returned invalid structured output', {
        sessionKey,
        hasStructured: !!structured,
        watcherAction: structured?.watcherAction,
      });
      return { watcherAction: 'continue', reason: result.response || 'Watcher produced no valid structured output' };
    } catch (err) {
      this.logger.error('Watcher agent execution failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionKey,
      });
      return { watcherAction: 'continue', reason: `Watcher error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Create a watcher-backed StopHookHandler for a session.
   * This is the bridge between the orchestrator's stopHook mechanism and the LLM-backed watcher.
   */
  async createWatcherStopHookForSession(
    sessionKey: string,
    goal: string,
    workingDir: string
  ): Promise<{ stopHook: import('orchestrator').StopHookHandler; planningObjective: string }> {
    // NOTE: Skill knowledge is baked into system prompts. No need to discover skill files.
    const saliencePath = await writeSalienceFile(workingDir, {
      sessionId: sessionKey,
      goal,
      mode: 'async',
    });

    const decisionLog = await createDecisionLog(workingDir, sessionKey);
    const workLog = await createWorkLog(workingDir, sessionKey);
    this.sessionWorkLogs.set(sessionKey, workLog);

    // Write session_start entry
    await workLog.append({
      type: 'session_start',
      timestamp: new Date().toISOString(),
      goal,
      mode: 'async',
    }).catch(err => {
      console.warn('[HARNESS] Work log write failed (session_start):', err instanceof Error ? err.message : String(err));
    });

    // Helper to get or create workitem log for this session
    const getOrCreateWorkItemLog = async (workId: string, agentType: string, objective?: string): Promise<WorkItemLog> => {
      const key = `${sessionKey}:${workId}`;
      let log = this.workItemLogs.get(key);
      if (!log) {
        // Try to get existing log first
        log = await getWorkItemLog(workingDir, sessionKey, workId) ?? undefined;
        if (!log) {
          // Create new log
          log = await createWorkItemLog(workingDir, sessionKey, {
            workId,
            objective: objective ?? 'unknown',
            agent: agentType,
          });
        }
        this.workItemLogs.set(key, log);
      }
      return log;
    };

    // Register auto-logging hooks for workitem activity
    // NOTE: Hooks are global, so we filter by sessionKey to only process this session's events
    registerHook('turn_completed', async (event: InternalHookEvent, ctx: InternalHookContext) => {
      if (event.type !== 'turn_completed') return;
      if (ctx.sessionKey !== sessionKey) return; // Filter by session

      // Get or create workitem log - use objective from context
      const itemLog = await getOrCreateWorkItemLog(ctx.workId, ctx.agentType, ctx.objective).catch(err => {
        console.warn('[HARNESS] WorkItem log creation failed:', err instanceof Error ? err.message : String(err));
        return null;
      });

      if (itemLog) {
        // Mark as started on first turn
        if (event.iteration === 1) {
          await itemLog.markStarted().catch(err => {
            console.warn('[HARNESS] WorkItem log write failed (markStarted):', err instanceof Error ? err.message : String(err));
          });
        }
        // Note: actual message content comes via agent_message hook, not here
      }

      // Also log to session-level work log on first turn
      if (event.iteration === 1) {
        await workLog.append({
          type: 'workitem_created',
          timestamp: new Date().toISOString(),
          workId: ctx.workId,
          objective: ctx.objective ?? 'unknown',
          agent: ctx.agentType,
        }).catch(err => {
          console.warn('[HARNESS] Work log write failed (workitem_created):', err instanceof Error ? err.message : String(err));
        });
      }
    });

    // Log actual agent messages (real content, not metadata)
    registerHook('agent_message', async (event: InternalHookEvent, ctx: InternalHookContext) => {
      if (event.type !== 'agent_message') return;
      if (ctx.sessionKey !== sessionKey) return;

      const itemLog = this.workItemLogs.get(`${sessionKey}:${ctx.workId}`);
      if (itemLog) {
        await itemLog.appendMessage(
          event.role,
          event.content
        ).catch(err => {
          console.warn('[HARNESS] WorkItem log write failed (agent_message):', err instanceof Error ? err.message : String(err));
        });
      }
    });

    // Log individual tool calls with full details
    registerHook('tool_call_completed', async (event: InternalHookEvent, ctx: InternalHookContext) => {
      if (event.type !== 'tool_call_completed') return;
      if (ctx.sessionKey !== sessionKey) return;

      const itemLog = this.workItemLogs.get(`${sessionKey}:${ctx.workId}`);
      if (itemLog) {
        await itemLog.appendToolCall(
          event.tool,
          event.args,
          event.success,
          event.resultPreview,
          event.durationMs
        ).catch(err => {
          console.warn('[HARNESS] WorkItem log write failed (tool_call_completed):', err instanceof Error ? err.message : String(err));
        });
      }
    });

    // Legacy batch hook - kept for backwards compatibility but tool_call_completed is primary
    registerHook('tool_batch_completed', async (event: InternalHookEvent, ctx: InternalHookContext) => {
      if (event.type !== 'tool_batch_completed') return;
      if (ctx.sessionKey !== sessionKey) return;
      // tool_call_completed handles individual calls now, this is just for summary events
    });

    registerHook('files_modified', async (event: InternalHookEvent, ctx: InternalHookContext) => {
      if (event.type !== 'files_modified') return;
      if (ctx.sessionKey !== sessionKey) return; // Filter by session

      // Log to session-level work log
      await workLog.append({
        type: 'note',
        timestamp: new Date().toISOString(),
        workId: ctx.workId,
        note: `Files modified: ${event.paths.slice(0, 5).join(', ')}${event.paths.length > 5 ? ` (+${event.paths.length - 5} more)` : ''}`,
        source: 'orchestrator',
      }).catch(err => {
        console.warn('[HARNESS] Work log write failed (files_modified):', err instanceof Error ? err.message : String(err));
      });

      // Also log to workitem log
      const itemLog = this.workItemLogs.get(`${sessionKey}:${ctx.workId}`);
      if (itemLog) {
        await itemLog.appendToolCall(
          'Edit/Write',
          { paths: event.paths },
          true,
          `Modified: ${event.paths.join(', ')}`
        ).catch(err => {
          console.warn('[HARNESS] WorkItem log write failed (files_modified):', err instanceof Error ? err.message : String(err));
        });
      }
    });

    registerHook('agent_completed', async (event: InternalHookEvent, ctx: InternalHookContext) => {
      if (event.type !== 'agent_completed') return;
      if (ctx.sessionKey !== sessionKey) return; // Filter by session

      const workId = ctx.workId ?? event.workId ?? 'unknown';

      // Log to session-level work log
      await workLog.append({
        type: 'workitem_status',
        timestamp: new Date().toISOString(),
        workId,
        status: 'completed',
        filesModified: event.invalidatedPaths,
      }).catch(err => {
        console.warn('[HARNESS] Work log write failed (agent_completed):', err instanceof Error ? err.message : String(err));
      });

      // Mark workitem as completed
      const itemLog = this.workItemLogs.get(`${sessionKey}:${workId}`);
      if (itemLog) {
        await itemLog.markCompleted(
          event.response ?? 'Agent completed',
          event.metrics ? {
            llmCalls: event.metrics.llmCallsMade,
            toolCalls: event.metrics.toolCallsMade,
            contextPercentUsed: event.contextPercentUsed ?? 0,
            durationMs: 0, // Not available in InternalHookEvent
            filesRead: event.filesRead,
            filesModified: event.invalidatedPaths,
          } : undefined
        ).catch(err => {
          console.warn('[HARNESS] WorkItem log write failed (markCompleted):', err instanceof Error ? err.message : String(err));
        });
      }
    });

    const stopHook = createWatcherStopHook({
      sessionId: sessionKey,
      salienceFilePath: saliencePath,
      decisionLog,
      workLog,
      getWorkItemLog: async (workId: string) => {
        // First check our cache, then try to get from disk
        const cached = this.workItemLogs.get(`${sessionKey}:${workId}`);
        if (cached) return cached;
        return getWorkItemLog(workingDir, sessionKey, workId);
      },
      workingDir,
      runAgent: (objective: string, trigger: string) => this.runWatcherAgent(objective, sessionKey, trigger),
      onDecision: (entry) => {
        this.logger.info('Watcher decision', {
          sessionKey,
          trigger: entry.trigger,
          watcherAction: entry.watcherAction,
          rationale: entry.rationale,
          answer: entry.answer,
        });
        this.eventBus.publish(createEvent('watcher_decision', {
          trigger: entry.trigger,
          watcherAction: entry.watcherAction,
          question: entry.question,
          answer: entry.answer,
          rationale: entry.rationale,
          qualityGate: entry.qualityGate,
        }, entry.workItemId, '', sessionKey));
      },
    });

    const planningObjective = buildPlanningObjective(
      goal, saliencePath, decisionLog.filePath(), workLog.filePath()
    );

    return { stopHook, planningObjective };
  }

  // =========================================================================
  // Decision Watcher: Per-session database & engine
  // =========================================================================

  /**
   * Get or create a per-session DecisionDatabase, seeded with DEFAULT_DECISIONS.
   */
  getOrCreateDecisionDatabase(sessionKey: string): DecisionDatabase {
    let db = this.decisionDatabases.get(sessionKey);
    if (!db) {
      db = new InMemoryDecisionDatabase(DEFAULT_DECISIONS);
      this.decisionDatabases.set(sessionKey, db);
    }
    return db;
  }

  /**
   * Get or create a per-session DecisionEngine.
   */
  private getOrCreateWatcherEngine(sessionKey: string): DecisionEngine {
    let engine = this.watcherEngines.get(sessionKey);
    if (!engine) {
      const db = this.getOrCreateDecisionDatabase(sessionKey);
      engine = createDecisionEngine(db, createWatcherConfig());
      this.watcherEngines.set(sessionKey, engine);
    }
    return engine;
  }

  // =========================================================================
  // Watcher CLI Commands
  // =========================================================================

  watcherStatus(sessionKey: string): Record<string, unknown> {
    const engine = this.getOrCreateWatcherEngine(sessionKey);
    const entry = this.sessionStores.get(sessionKey);
    const contextSnapshot = entry?.store.getCachedContextSnapshot();

    return {
      enabled: true,
      sessionKey,
      focusTopic: engine.getFocus(),
      salienceGoal: engine.getSalienceGoal(),
      contextLoaded: !!contextSnapshot,
      contextItems: contextSnapshot?.items.length ?? 0,
    };
  }

  watcherContext(sessionKey: string): Record<string, unknown> {
    const entry = this.sessionStores.get(sessionKey);
    if (!entry) {
      return { error: 'No session store found', sessionKey };
    }

    const context = entry.store.getContext();

    return {
      sessionKey,
      metrics: context.metrics,
    };
  }

  async watcherSearch(sessionKey: string, query: string): Promise<Record<string, unknown>> {
    const db = this.getOrCreateDecisionDatabase(sessionKey);
    const results = await db.search(query, { limit: 10 });

    return {
      query,
      count: results.length,
      results: results.map(entry => ({
        id: entry.id,
        category: entry.category,
        priority: entry.priority,
        summary: 'decision' in entry ? entry.decision.slice(0, 120) : entry.preference.slice(0, 120),
        keywords: entry.keywords,
      })),
    };
  }

  async watcherDecisions(sessionKey: string): Promise<Record<string, unknown>> {
    const db = this.getOrCreateDecisionDatabase(sessionKey);
    const all = await db.getAll();

    return {
      count: all.length,
      decisions: all.map(entry => ({
        id: entry.id,
        category: entry.category,
        priority: entry.priority,
        type: 'decision' in entry ? 'decision' : 'preference',
        summary: 'decision' in entry ? entry.decision.slice(0, 120) : entry.preference.slice(0, 120),
      })),
    };
  }

  async watcherInspect(sessionKey: string, id: string): Promise<Record<string, unknown>> {
    const db = this.getOrCreateDecisionDatabase(sessionKey);
    const entry = await db.get(id);

    if (!entry) {
      return { error: `Decision '${id}' not found` };
    }

    return { decision: entry };
  }

  watcherMemory(sessionKey: string): Record<string, unknown> {
    const engine = this.getOrCreateWatcherEngine(sessionKey);
    const memory = engine.getSessionMemory(sessionKey);

    if (!memory) {
      return {
        sessionKey,
        decisionsMade: 0,
        patterns: [],
        warnings: [],
        consistencyScore: 1.0,
      };
    }

    return {
      sessionKey,
      decisionsMade: memory.decisionsMade.length,
      decisions: memory.decisionsMade,
      patterns: memory.patterns,
      warnings: memory.warnings,
      consistencyScore: memory.consistencyScore,
    };
  }

  watcherFocus(sessionKey: string, topic: string): Record<string, unknown> {
    const engine = this.getOrCreateWatcherEngine(sessionKey);
    engine.setFocus(topic);
    return { success: true, topic };
  }

  watcherDefocus(sessionKey: string): Record<string, unknown> {
    const engine = this.getOrCreateWatcherEngine(sessionKey);
    engine.clearFocus();
    return { success: true };
  }

  watcherReanchor(sessionKey: string, goal: string): Record<string, unknown> {
    const engine = this.getOrCreateWatcherEngine(sessionKey);
    engine.setSalienceGoal(goal);
    return { success: true, goal };
  }

  watcherSummarize(sessionKey: string): Record<string, unknown> {
    const entry = this.sessionStores.get(sessionKey);
    if (!entry) {
      return { error: 'No session store found' };
    }

    const context = entry.store.getContext();
    const result = context.compact({
      deduplicateByPath: true,
      maxFileContentCount: 15,
      truncateOutputsTo: 3000,
    });

    entry.store.persistContext();

    const engine = this.getOrCreateWatcherEngine(sessionKey);
    const memory = engine.getSessionMemory(sessionKey);

    return {
      success: true,
      compaction: {
        itemsRemoved: result.itemsRemoved,
        bytesRecovered: result.bytesRecovered,
      },
      ledger: {
        focusTopic: engine.getFocus(),
        salienceGoal: engine.getSalienceGoal(),
        decisionsMade: memory?.decisionsMade.length ?? 0,
        consistencyScore: memory?.consistencyScore ?? 1.0,
        patterns: memory?.patterns ?? [],
      },
    };
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

    if (this.logSubscriber) {
      try {
        this.logSubscriber.close();
        this.logger.debug('Closed LogSubscriber');
      } catch (error) {
        this.logger.warning('LogSubscriber close failed', { error: String(error) });
      }
    }

    this.eventBus.shutdown();

    // Persist and mark all sessions inactive BEFORE stopping GraphD
    for (const [sessionKey, entry] of this.sessionStores.entries()) {
      try {
        entry.store.persistContext();
        if (this.isGraphDReady()) {
          this.graphd!.sessionUpdateStatus(sessionKey, 'inactive');
        }
      } catch (error) {
        this.logger.warning('Session persist failed during shutdown', { sessionKey, error: String(error) });
      }
      entry.store.close();
    }
    this.sessionStores.clear();

    if (this.isGraphDReady()) {
      try {
        await this.graphd!.stop();
        this.logger.info('GraphD stopped');
      } catch (error) {
        this.logger.warning('GraphD stop failed', { error: String(error) });
      }
    }
    this.toolRegistry.clearCache();

    // Clean up entity graph
    if (this.entityGraph) {
      this.entityGraph = null;
      this.logger.info('EntityGraph stopped');
    }

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
  configPath?: string,
  dangerousMode = false
): AgentHarness {
  const config = loadConfig(configPath, workingDir);
  // Override dangerousMode from CLI flag
  config.dangerousMode = dangerousMode;
  return new AgentHarness(config);
}
