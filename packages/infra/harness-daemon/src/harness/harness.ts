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
  AgentRegistry,
  type AgentConfig,
  type AgentHooks,
  type ToolHookResult,
  type EnvironmentContext,
  type ModelSelection,
  type MemoryInjector,
  type InternalHookEvent,
  type InternalHookContext,
  buildAgentConfig,
} from 'agent';
import { Effect, Layer, ManagedRuntime } from 'effect';
import os from 'os';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { createAdapter, hasCodexCredentials, type ProviderKeyService } from 'llm';
import { classifyRecoverableError, getErrorMessage } from './error_handlers.js';
import { ToolRegistry } from 'tools';
import { createEvent, getProviderEnvVar, providerRequiresAuth, type AgentEvent, type ToolResult, type LLMClientConfig, type LLMProvider, type RateLimitData, type ArtifactDiscoveredData, type ArtifactKind, type GitCommitData } from 'types';
import { ContextWindow } from 'context';
import { profiler } from 'shared';
import { GraphDManager, createGraphDConfig, type GraphDSession } from 'graphd';
import { EventBus, type EventBusProtocol, createEventEmitCallback } from 'comms-bus';
import { createGraphDSubscriber } from '../subscribers/graphd_subscriber.js';
import { LogSubscriber, createLogSubscriber } from '../subscribers/log_subscriber.js';
import { createTraceSubscriber, extractCommitSha, isGitCommitCommand, type TraceSubscriber } from '../subscribers/trace_subscriber.js';
import path from 'path';
import fs from 'fs';
import {
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
  SessionControlResult,
} from './types.js';
import { loadConfig, getAgentConfig } from './config_loader.js';
import type { FullHarnessConfig, ResolvedAgentConfig } from './config.js';
import { LocalProviderManager } from './local_providers.js';
import { ConfiguredEffectHooksRunner } from './configured_effect_hooks.js';
import {
  loadHookDefinitions,
  getHookDefinition,
  normalizeHookTrigger,
  type HookContext as SkillHookContext,
  type HookDefinition,
  type HookResult as LegacyHookResult,
} from './skills_loader.js';
import { SessionStore } from './session_store.js';
import { createFileLogger, createToolRegistry, type HarnessLogger } from './harness_infra.js';
import { PermissionChecker } from './permissions.js';
import { DefaultOrchestratorRunner, type OrchestratorRunner } from './orchestrator_runner.js';
import type { PermissionedTool, PermissionRequest, PermissionResponse } from 'types';
import { isPermissionedTool, normalizeToolName } from 'types';
import { createSessionState, touchSession, clearSessionState, type SessionState } from './session_state.js';
import {
  createSessionScopedUnifiedHookRegistry,
  runUnifiedEffectHooksForSession,
  type EffectEventType,
  type UnifiedHookRegistry,
  type SessionScopedUnifiedHookRegistry,
} from 'orchestrator';
import {
  makeRuntimeControlQueue,
  publishRuntimeControl,
  type RuntimeCancellationMetadata,
  type RuntimeControlQueue,
} from 'runtime';

/** Agent type for routing - maps to agent config */
type AgentType = string;

type EntityGraphConfig = {
  sourceRoot: string;
  include?: string[];
  exclude?: string[];
  leaseDurationSec?: number;
  startupScan?: boolean;
  leaseWaitTimeoutMs?: number;
};

type EntityGraphHooks = {
  preToolUse(agentId: string, toolName: string, args: Record<string, unknown>): Promise<{
    action: 'allow' | 'block';
    message?: string;
  }>;
  postToolUse(agentId: string, toolName: string, args: Record<string, unknown>): Promise<{
    action: 'allow' | 'block';
    message?: string;
    context?: string;
  }>;
  onFilesModified(paths: string[]): Promise<void>;
};

type EntityGraphInstance = {
  initialize(): Promise<void>;
  getHooks(): EntityGraphHooks;
};

type TraceCreatePayload = {
  revision: string;
  session_key?: string;
  tool_name: string;
  tool_version: string;
  trace: unknown;
};

type TraceClient = {
  traces: {
    create(payload: TraceCreatePayload): Promise<unknown>;
  };
};

type MemoryPluginModule = {
  createMemoryInjector?: (config: { baseUrl: string; timeout: number }) => MemoryInjector;
  SyncClient?: new (baseUrl: string) => TraceClient;
  createEntityGraph?: (options: {
    databaseUrl: string;
    config: EntityGraphConfig;
    postgresOptions?: Record<string, unknown>;
  }) => EntityGraphInstance;
};

type SessionGetResponse = { session?: GraphDSession; error?: string };

export interface CloseSessionResult {
  success: boolean;
  error?: string;
  executingRequestId?: string;
}

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

  const gitExec = (cmd: string) =>
    execSync(cmd, { cwd: workingDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

  try {
    const isRepo = gitExec('git rev-parse --is-inside-work-tree') === 'true';

    if (isRepo) {
      const currentBranch = gitExec('git branch --show-current');

      // Detect main branch (main or master)
      let mainBranch = 'main';
      try {
        gitExec('git rev-parse --verify main');
      } catch {
        try {
          gitExec('git rev-parse --verify master');
          mainBranch = 'master';
        } catch {
          // Neither main nor master exists
        }
      }

      const status = gitExec('git status --short');
      const recentCommits = gitExec('git log --oneline -5').split('\n').filter(Boolean);

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

function resolveGitCommitRange(
  workingDir: string,
  sha: string
): { headSha: string; baseSha?: string } {
  const normalizedSha = sha.trim();
  if (!normalizedSha) {
    return { headSha: sha };
  }

  try {
    const parentInfo = execSync(`git rev-list --parents -n 1 ${normalizedSha}`, {
      cwd: workingDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const parts = parentInfo.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return {
        headSha: parts[0],
        baseSha: parts[1],
      };
    }
    if (parts.length === 1) {
      return { headSha: parts[0] };
    }
  } catch {
    // Best-effort: keep commit emission even if parent lookup fails.
  }

  return { headSha: normalizedSha };
}

function buildAgentRegistry(config: FullHarnessConfig, envContext?: EnvironmentContext): AgentRegistry {
  // Registry stores ONLY agent capabilities (tools, budget, schema, llmParams).
  // Model selection is NOT sourced from config; it comes EXCLUSIVELY from SessionStore via getModelSelection.
  const agentConfigs: AgentConfig[] = Object.entries(config.agents).map(([agentType, resolved]) => {
    const llmParams = {
      maxTokens: resolved.llm.maxTokens,
      temperature: resolved.llm.temperature ?? 0.7,
    };
    return buildAgentConfig(agentType, resolved.tools, resolved.budget, llmParams, resolved.outputSchema, envContext) as AgentConfig;
  });

  const registry = new AgentRegistry(agentConfigs);

  // Validate agent tool references and prevent self-reference
  const builtinTools = new Set([
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'Bash',
    'WebFetch',
    'WebSearch',
    'Skill',
    'PromptUser',
    'ExpandConversation',
  ]);
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
  private resolvers: Array<(value: IteratorResult<BridgeEvent, void>) => void> = [];
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
      resolve({ value: undefined, done: true });
    }
    this.resolvers = [];
  }

  async next(): Promise<IteratorResult<BridgeEvent, void>> {
    if (this.queue.length > 0) {
      return { value: this.queue.shift()!, done: false };
    }

    if (this.done) {
      return { value: undefined, done: true };
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

const defaultLogger: HarnessLogger = createFileLogger();

/**
 * Provider key service implementation for the harness.
 * Queries API keys at runtime from LocalProviderManager (GraphD storage),
 * with environment-variable fallback for compatibility.
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
        this.localProviders = new LocalProviderManager(graphdDbPath, logger);
        this.logger.info('HarnessProviderKeyService initialized with GraphD', { dbPath: graphdDbPath });
      } catch (err) {
        this.logger.warning('Failed to initialize LocalProviderManager', { error: String(err) });
      }
    }
  }

  getApiKey(provider: string): string | null {
    // Prefer environment variables so .env can override stale stored credentials.
    const envVar = getProviderEnvVar(provider);
    const envCandidates = [envVar];
    if (provider === 'gemini') {
      envCandidates.push('GEMINI_API_KEY');
    } else if (provider === 'openai-compat') {
      envCandidates.push('OPENAI_API_KEY');
    }

    for (const candidate of envCandidates) {
      const value = process.env[candidate]?.trim();
      if (value) {
        this.logger.debug('API key found in environment', { provider, envVar: candidate });
        return value;
      }
    }

    // Fall back to LocalProviderManager (GraphD storage)
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
    // Codex uses OAuth tokens, not API keys
    if (provider === 'codex') {
      return hasCodexCredentials();
    }
    return this.getApiKey(provider) !== null;
  }

  getLocalProviders(): LocalProviderManager | null {
    return this.localProviders;
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

  // -------------------------------------------------------------------------
  // Per-session state (see SessionState type in session_state.ts for consolidated version)
  // -------------------------------------------------------------------------
  private sessions = new Map<string, SessionState>();
  // -------------------------------------------------------------------------

  private readonly sessionTtlMs: number;
  private readonly maxSessions: number;
  private logger: HarnessLogger;
  private isShutdown = false;
  private graphd: GraphDManager | null = null;
  private graphdStarted = false;
  private graphdSubscriber: ReturnType<typeof createGraphDSubscriber> | null = null;
  private eventBus: EventBus;
  private logSubscriber: LogSubscriber | null = null;
  private agentRegistry: AgentRegistry;
  private llmAdapter: ReturnType<typeof createAdapter>;
  private readonly sessionHookRegistry: SessionScopedUnifiedHookRegistry;
  private readonly configuredHookRuntimes = new Map<string, ConfiguredEffectHooksRunner>();
  private providerKeyService: HarnessProviderKeyService;
  private orchestratorRunner: OrchestratorRunner;
  private entityGraph: EntityGraphInstance | null = null;
  private memoryInjector: MemoryInjector | null = null;
  private traceSubscriber: TraceSubscriber | null = null;
  private memoryClient: TraceClient | null = null;
  private initializedModelSelections = new Set<string>();
  private readonly pendingSessionHookTasks = new Set<Promise<void>>();
  private readonly closingSessionHooks = new Set<string>();

  constructor(config: FullHarnessConfig, logger?: HarnessLogger, orchestratorRunner?: OrchestratorRunner) {
    this.config = config;
    this.logger = logger ?? defaultLogger;
    this.sessionTtlMs = config.context.sessionTtlMs;
    this.maxSessions = config.context.maxSessions;
    this.sessionHookRegistry = createSessionScopedUnifiedHookRegistry();

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

    this.toolRegistry = createToolRegistry(config, workingDir, config.dangerousMode);

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

    if (config.dangerousMode) {
      this.logger.warning('Permission checks DISABLED - running in dangerous mode');
    }

    this.orchestratorRunner = orchestratorRunner ?? new DefaultOrchestratorRunner();

    // Initialize TraceSubscriber for collecting Write/Edit tool calls and emitting on git commits
    this.traceSubscriber = createTraceSubscriber(this.eventBus, {
      repoRoot: workingDir,
      toolName: 'agent',
      toolVersion: '0.1.0',
    });
    this.logger.debug('TraceSubscriber initialized', { repoRoot: workingDir });

    // Register callback to persist traces to database when emitted
    this.traceSubscriber.onTraceEmitted(async (trace) => {
      try {
        if (this.memoryClient) {
          await this.memoryClient.traces.create({
            revision: trace.vcs.revision,
            session_key: undefined, // Session key is per-file in trace, top-level is nullable
            tool_name: trace.tool.name,
            tool_version: trace.tool.version,
            trace: trace,
          });
          this.logger.info('Trace persisted to database', { revision: trace.vcs.revision });
        }
      } catch (error) {
        // Log warning but don't crash the agent if DB is down
        this.logger.warning('Failed to persist trace to database (is agent-memory daemon running?)', {
          error: getErrorMessage(error),
          revision: trace.vcs.revision,
        });
      }
    });


    const defaultAgent = config.agents[config.defaultAgent];
    this.logger.info('AgentHarness initialized', {
      defaultAgent: config.defaultAgent,
      provider: defaultAgent?.llm.provider,
      model: defaultAgent?.llm.model,
      agentCount: Object.keys(config.agents).length,
      graphdEnabled: this.graphd !== null,
      memoryEnabled: this.config.memory.enabled,
      traceEnabled: this.traceSubscriber !== null,
    });
  }

  /**
   * Get the EventBus for external subscribers.
   */
  getEventBus(): EventBusProtocol {
    return this.eventBus;
  }

  getDebugMemoryInfo(): {
    sessionCount: number;
    maxSessions: number;
    sessions: Array<{
      sessionKey: string;
      contextItemCount: number;
      contextEstimatedTokens: number;
      workItemsCreatedCount: number;
      lastAccessMs: number;
      isExecuting: boolean;
    }>;
  } {
    const sessions = [];
    for (const [sessionKey, state] of this.sessions.entries()) {
      const context = state.store.getCachedContextSnapshot();
      const contextItemCount = context?.items?.length ?? 0;
      // Estimate tokens: ~4 chars per token
      let contextChars = 0;
      if (context?.items) {
        for (const item of context.items) {
          if (item.type === 'message') {
            contextChars += typeof item.content === 'string' ? item.content.length : 500;
          } else if (item.type === 'file_content') {
            contextChars += item.content.length;
          } else if (item.type === 'function_call_output') {
            contextChars += item.output.length;
          } else if (item.type === 'function_call') {
            contextChars += JSON.stringify(item.arguments).length;
          } else if (item.type === 'reasoning') {
            contextChars += item.content.length;
          }
        }
      }
      sessions.push({
        sessionKey,
        contextItemCount,
        contextEstimatedTokens: Math.ceil(contextChars / 4),
        workItemsCreatedCount: state.workItemsCreated.size,
        lastAccessMs: state.lastAccessMs,
        isExecuting: state.store.isExecuting(),
      });
    }
    return {
      sessionCount: this.sessions.size,
      maxSessions: this.maxSessions,
      sessions,
    };
  }

  /**
   * Check if GraphD is initialized and running.
   */
  private isGraphDReady(): boolean {
    return !!(this.graphd && this.graphdStarted);
  }

  private isOptionalModuleMissing(error: unknown, moduleName: string): boolean {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: string }).code;
    if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes(`'${moduleName}'`) ||
      message.includes(`"${moduleName}"`) ||
      message.includes(`Cannot find package '${moduleName}'`) ||
      message.includes(`Cannot find module '${moduleName}'`) ||
      message.includes(moduleName)
    );
  }

  private async importOptionalModule<T>(moduleName: string, installHint: string): Promise<T | null> {
    try {
      return await import(moduleName) as T;
    } catch (error) {
      if (this.isOptionalModuleMissing(error, moduleName)) {
        this.logger.info('Optional plugin module not installed; feature disabled', {
          module: moduleName,
          installHint,
        });
        return null;
      }
      throw error;
    }
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
   * Get the shared LocalProviderManager instance.
   * BridgeGateway uses this to avoid creating a second connection to the same GraphD database.
   */
  getLocalProviders(): LocalProviderManager | null {
    return this.providerKeyService.getLocalProviders();
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

  private getConfiguredHookRuntime(sessionKey: string, workingDir: string): ConfiguredEffectHooksRunner {
    const existing = this.configuredHookRuntimes.get(sessionKey);
    if (existing) return existing;
    const runtime = new ConfiguredEffectHooksRunner(workingDir);
    this.configuredHookRuntimes.set(sessionKey, runtime);
    return runtime;
  }

  private mapConfiguredHookTriggerToEffectEvent(trigger: string): EffectEventType | null {
    return normalizeHookTrigger(trigger);
  }

  private buildSkillHookContext(
    eventType: string,
    payload: Record<string, unknown>,
    context: { sessionKey: string; requestId: string; workingDir: string }
  ): SkillHookContext {
    const normalizedEvent = normalizeHookTrigger(eventType) ?? 'notification';
    const base: SkillHookContext = {
      event: normalizedEvent,
      sessionKey: context.sessionKey,
      requestId: context.requestId,
      workingDir: context.workingDir,
    };

    if (eventType === 'post_git_commit') {
      return {
        ...base,
        toolName: 'Bash',
        toolParams: typeof payload.command === 'string' ? { command: payload.command } : undefined,
        commitSha: typeof payload.sha === 'string' ? payload.sha : undefined,
        commitMessage: typeof payload.message === 'string' ? payload.message : undefined,
        commitBranch: typeof payload.branch === 'string' ? payload.branch : undefined,
      };
    }

    if (eventType === 'pre_tool_use' || eventType === 'post_tool_use') {
      return {
        ...base,
        toolName: typeof payload.toolName === 'string' ? payload.toolName : undefined,
        toolParams: typeof payload.args === 'object' && payload.args ? payload.args as Record<string, unknown> : undefined,
        ...(eventType === 'post_tool_use' ? { toolResult: payload.result } : {}),
      };
    }

    return base;
  }

  private convertConfiguredResultToEffectOutcome(
    eventType: string,
    result: LegacyHookResult
  ): Record<string, unknown> {
    if (result.action === 'allow') {
      return { kind: 'allow', ...(result.message ? { message: result.message } : {}) };
    }
    if (result.action === 'block') {
      return { kind: 'block', reason: result.message ?? 'Blocked by configured hook' };
    }
    if (result.action === 'modify') {
      if (eventType === 'pre_tool_use' && result.modified && typeof result.modified === 'object') {
        return { kind: 'modify', value: result.modified, ...(result.message ? { reason: result.message } : {}) };
      }
      if (eventType === 'post_tool_use' && this.isToolResult(result.modified)) {
        return { kind: 'modify', value: result.modified, ...(result.message ? { reason: result.message } : {}) };
      }
      if (eventType === 'user_prompt_submit' && result.modified && typeof result.modified === 'object') {
        return { kind: 'modify', value: result.modified, ...(result.message ? { reason: result.message } : {}) };
      }
      return { kind: 'allow', message: result.message ?? 'Modify ignored for event type' };
    }
    return { kind: 'allow' };
  }

  private registerSessionUnifiedHooks(sessionKey: string, workingDir: string): void {
    this.sessionHookRegistry.clearSession(sessionKey);
    const registry = this.sessionHookRegistry.getOrCreateSessionRegistry(sessionKey);

    if (this.entityGraph) {
      const entityGraphHooks = this.entityGraph.getHooks();
      registry.register({
        id: 'builtin:entity_graph:files_modified',
        mode: 'effect',
        scope: 'harness',
        source: 'builtin:entity_graph',
        event: 'files_modified',
        priority: 0,
        timeoutMs: 30_000,
        callback: (payload: { paths?: string[] }) => Effect.gen(function* () {
          const paths = payload.paths;
          if (paths && paths.length > 0) {
            yield* Effect.tryPromise(() => entityGraphHooks.onFilesModified(paths));
          }
          return { kind: 'allow' } as const;
        }),
      } as never);
    }

    if (!this.config.hooks.enabled || !this.config.hooks.directory) {
      return;
    }

    const hooksDir = path.resolve(workingDir, this.config.hooks.directory);
    const stubs = loadHookDefinitions(hooksDir);
    const runtime = this.getConfiguredHookRuntime(sessionKey, workingDir);

    for (const stub of stubs) {
      if (!stub.enabled) continue;
      const definition = getHookDefinition(hooksDir, stub.id);
      if (!definition || !definition.enabled) continue;

      const effectEvent = this.mapConfiguredHookTriggerToEffectEvent(definition.trigger);
      if (!effectEvent) continue;

      const registrationId = `configured:${definition.id}`;
      try {
        registry.register({
          id: registrationId,
          mode: 'effect',
          scope: 'harness',
          source: `configured:${definition.id}`,
          event: effectEvent,
          priority: Number.isFinite(definition.priority) ? definition.priority : 0,
          timeoutMs: definition.timeout_ms ?? 30_000,
          callback: (
            payload: Record<string, unknown>,
            callbackContext: {
              sessionKey: string;
              requestId: string;
              workingDir?: string;
              signal?: AbortSignal;
            }
          ) => Effect.gen(this, function* () {
            const sessionHookContext = this.buildSkillHookContext(effectEvent, payload, {
              sessionKey: callbackContext.sessionKey,
              requestId: callbackContext.requestId,
              workingDir: callbackContext.workingDir ?? workingDir,
            });

            if (!runtime.matches(definition, sessionHookContext.toolName)) {
              return { kind: 'skip', reason: 'Hook matcher did not match event context' };
            }

            const result = yield* Effect.tryPromise(() =>
              runtime.execute(definition, sessionHookContext, callbackContext.signal)
            );
            return this.convertConfiguredResultToEffectOutcome(effectEvent, result);
          }),
        } as never);
      } catch (error) {
        this.logger.warning('Failed to register configured session hook', {
          sessionKey,
          hookId: definition.id,
          event: effectEvent,
          error: getErrorMessage(error),
        });
      }
    }
  }

  private async runSessionEffectHooks(
    sessionKey: string,
    event: Record<string, unknown> & { type: string },
    context: {
      sessionKey: string;
      requestId: string;
      workingDir?: string;
      workId?: string;
      agentType?: string;
      internal?: InternalHookContext;
      metadata?: Record<string, unknown>;
      signal?: AbortSignal;
    }
  ): Promise<{
    status: 'completed' | 'blocked';
    outcomes: Array<{ hookId: string; source: string; outcome: { kind: string; [key: string]: unknown } }>;
    blockedBy?: { hookId: string; source: string; reason: string };
  }> {
    try {
      const result = await Effect.runPromise(
        runUnifiedEffectHooksForSession(
          sessionKey,
          event as never,
          context as never,
          this.sessionHookRegistry
        )
      );
      return {
        status: result.status,
        outcomes: result.outcomes as unknown as Array<{ hookId: string; source: string; outcome: { kind: string; [key: string]: unknown } }>,
        blockedBy: result.blockedBy,
      };
    } catch (error) {
      this.logger.warning('Session effect hook execution failed', {
        sessionKey,
        eventType: event.type,
        error: getErrorMessage(error),
      });
      return { status: 'completed', outcomes: [] };
    }
  }

  private trackSessionHookTask(task: Promise<void>): void {
    this.pendingSessionHookTasks.add(task);
    task.finally(() => {
      this.pendingSessionHookTasks.delete(task);
    });
  }

  private enqueueSessionEffectHook(
    sessionKey: string,
    event: Record<string, unknown> & { type: string },
    context: {
      sessionKey: string;
      requestId: string;
      workingDir?: string;
      workId?: string;
      agentType?: string;
      internal?: InternalHookContext;
      metadata?: Record<string, unknown>;
      signal?: AbortSignal;
    },
    errorLogMessage: string
  ): Promise<void> {
    const task = this.runSessionEffectHooks(sessionKey, event, context).then(
      () => {},
      (error) => {
        this.logger.warning(errorLogMessage, {
          sessionKey,
          eventType: event.type,
          error: getErrorMessage(error),
        });
      }
    );
    this.trackSessionHookTask(task);
    return task;
  }

  private cleanupSessionInternalHooks(sessionKey: string, state: SessionState): void {
    if (this.closingSessionHooks.has(sessionKey)) {
      return;
    }
    this.closingSessionHooks.add(sessionKey);
    const workingDir = state.store.getWorkingDirectory();
    this.enqueueSessionEffectHook(
      sessionKey,
      { type: 'session_stop', sessionKey, reason: 'session_cleanup' },
      { sessionKey, requestId: 'session_cleanup', workingDir },
      'Session stop hook failed during cleanup'
    ).finally(() => {
      this.sessionHookRegistry.clearSession(sessionKey);
      this.configuredHookRuntimes.delete(sessionKey);
      this.closingSessionHooks.delete(sessionKey);
    });
  }

  /**
   * Shared teardown: persist, close, evict in-memory state, mark inactive in GraphD.
   */
  private teardownSession(sessionKey: string, state: SessionState, persist = true): void {
    this.cleanupSessionInternalHooks(sessionKey, state);
    if (persist) state.store.persistContext();
    state.store.close();
    clearSessionState(state);
    this.sessions.delete(sessionKey);
    this.initializedModelSelections.delete(sessionKey);
    this.markSessionInactive(sessionKey);
  }

  private markSessionInactive(sessionKey: string): void {
    if (!this.isGraphDReady()) return;
    try {
      this.graphd!.sessionUpdateStatus(sessionKey, 'inactive');
    } catch (error) {
      this.logger.warning('Failed to mark session inactive', { sessionKey, error: String(error) });
    }
  }

  /**
   * Close and evict in-memory state for a session.
   */
  closeSession(sessionKey: string): CloseSessionResult {
    const state = this.sessions.get(sessionKey);
    if (state) {
      if (state.store.isExecuting()) {
        const executingRequestId = state.store.getExecutingRequestId() ?? undefined;
        this.logger.warning('Refusing to close session during active execution', {
          sessionKey,
          executingRequestId,
        });
        return {
          success: false,
          error: 'Session has an active execution',
          ...(executingRequestId ? { executingRequestId } : {}),
        };
      }
      this.teardownSession(sessionKey, state);
    } else {
      // Mark inactive even if in-memory state was already evicted
      this.markSessionInactive(sessionKey);
    }
    return { success: true };
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
        } else {
          this.logger.warning('GraphD failed to start; starting harness without GraphD features', {
            host: this.config.graphd.host,
            port: this.config.graphd.port,
            dbPath: this.config.graphd.dbPath,
          });
          this.graphd = null;
        }
      } catch (error) {
        const message = getErrorMessage(error);
        this.logger.warning('GraphD connect failed; starting harness without GraphD features', { error: message });
        this.graphd = null;
        this.graphdStarted = false;
      }
    }

    const shouldInitTracePersistence = this.config.memory.enabled || !!process.env.MEMORY_DAEMON_URL;
    const needsMemoryPlugin = this.config.memory.enabled || shouldInitTracePersistence || this.config.entityGraph.enabled;
    const memoryModuleName = process.env.NOVA_MEMORY_MODULE ?? 'memory';
    const memoryInstallHint = `bun add ${memoryModuleName}`;

    let memoryPluginModule: MemoryPluginModule | null = null;
    if (needsMemoryPlugin) {
      try {
        memoryPluginModule = await this.importOptionalModule<MemoryPluginModule>(
          memoryModuleName,
          memoryInstallHint
        );
      } catch (error) {
        this.logger.warning('Failed to load memory plugin module', {
          module: memoryModuleName,
          error: getErrorMessage(error),
        });
      }
    }

    if (this.config.memory.enabled && !this.memoryInjector) {
      try {
        const createMemoryInjector = memoryPluginModule?.createMemoryInjector;
        if (createMemoryInjector) {
          this.memoryInjector = createMemoryInjector({
            baseUrl: this.config.memory.baseUrl,
            timeout: this.config.memory.timeoutMs,
          });
          this.logger.info('MemoryInjector initialized', {
            baseUrl: this.config.memory.baseUrl,
            timeoutMs: this.config.memory.timeoutMs,
            module: memoryModuleName,
          });
        } else {
          this.logger.warning('Memory integration requested but memory plugin is missing createMemoryInjector export', {
            module: memoryModuleName,
            installHint: memoryInstallHint,
          });
        }
      } catch (error) {
        this.logger.warning('Failed to initialize MemoryInjector', {
          error: getErrorMessage(error),
        });
      }
    }

    if (shouldInitTracePersistence && !this.memoryClient) {
      const memoryDaemonUrl = process.env.MEMORY_DAEMON_URL || 'http://127.0.0.1:3001';
      try {
        const SyncClient = memoryPluginModule?.SyncClient;
        if (SyncClient) {
          this.memoryClient = new SyncClient(memoryDaemonUrl);
          this.logger.info('Memory client initialized for traces', {
            url: memoryDaemonUrl,
            module: memoryModuleName,
          });
        } else {
          this.logger.info('Trace persistence disabled: memory plugin is missing SyncClient export', {
            module: memoryModuleName,
            installHint: memoryInstallHint,
          });
        }
      } catch (error) {
        this.logger.warning('Failed to initialize memory client (traces will not be persisted)', {
          error: getErrorMessage(error),
        });
      }
    }

    // Initialize EntityGraph if enabled
    if (this.config.entityGraph.enabled && !this.entityGraph) {
      try {
        const createEntityGraph = memoryPluginModule?.createEntityGraph;
        if (!createEntityGraph) {
          this.logger.warning('EntityGraph requested but memory plugin is missing createEntityGraph export', {
            module: memoryModuleName,
            installHint: memoryInstallHint,
          });
          return true;
        }

        const dbUrl = this.config.entityGraph.databaseUrl
          ?? process.env.ENTITY_GRAPH_DATABASE_URL
          ?? process.env.DATABASE_URL;

        if (!dbUrl) {
          this.logger.warning('EntityGraph enabled but no database URL configured (entity_graph.database_url or DATABASE_URL env)');
        } else {
          const entityGraphConfig: EntityGraphConfig = {
            sourceRoot: this.config.tools.workingDir,
            include: this.config.entityGraph.include,
            exclude: this.config.entityGraph.exclude,
            leaseDurationSec: this.config.entityGraph.leaseDurationSec,
            startupScan: this.config.entityGraph.startupScan,
            leaseWaitTimeoutMs: this.config.entityGraph.leaseWaitTimeoutMs,
          };

          this.entityGraph = createEntityGraph({
            databaseUrl: dbUrl,
            config: entityGraphConfig,
          });
          await this.entityGraph.initialize();
          this.logger.info('EntityGraph initialized (scan running in background)', {
            module: memoryModuleName,
          });
          for (const [sessionKey, state] of this.sessions.entries()) {
            this.registerSessionUnifiedHooks(sessionKey, state.store.getWorkingDirectory());
          }
        }
      } catch (error) {
        const message = getErrorMessage(error);
        this.logger.error('EntityGraph failed to start', { error: message });
        // Non-fatal — daemon continues without entity graph
      }
    }

    return true;
  }

  /**
   * Get or create a SessionStore for the session.
   */
  private getSessionState(sessionKey: string): SessionState | null {
    return this.sessions.get(sessionKey) ?? null;
  }

  private getOrCreateSessionState(sessionKey: string, dangerousMode = false, workingDir?: string): SessionState {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      touchSession(existing);
      return existing;
    }

    // LRU eviction: if at capacity, evict the oldest idle session
    if (this.sessions.size >= this.maxSessions) {
      this.evictOldestIdleSession();
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

    const state = createSessionState(store);
    this.sessions.set(sessionKey, state);
    this.registerSessionUnifiedHooks(sessionKey, workingDir ?? this.config.tools.workingDir);
    this.enqueueSessionEffectHook(
      sessionKey,
      { type: 'session_start', sessionKey, workingDir: workingDir ?? this.config.tools.workingDir },
      {
        sessionKey,
        requestId: 'session_start',
        workingDir: workingDir ?? this.config.tools.workingDir,
      },
      'Session start hook failed'
    );
    return state;
  }

  private evictOldestIdleSession(): void {
    let oldestKey: string | null = null;
    let oldestAccessMs = Infinity;

    for (const [key, state] of this.sessions.entries()) {
      if (state.store.isExecuting() || state.store.getAsyncRun()) continue;
      if (state.lastAccessMs < oldestAccessMs) {
        oldestAccessMs = state.lastAccessMs;
        oldestKey = key;
      }
    }

    if (!oldestKey) return;

    this.teardownSession(oldestKey, this.sessions.get(oldestKey)!);
    this.logger.debug('LRU evicted session (maxSessions reached)', {
      sessionKey: oldestKey,
      maxSessions: this.maxSessions,
      idleMs: Date.now() - oldestAccessMs,
    });
  }

  private getOrCreateSessionStore(sessionKey: string, dangerousMode = false, workingDir?: string): SessionStore {
    return this.getOrCreateSessionState(sessionKey, dangerousMode, workingDir).store;
  }

  /**
   * Single entrypoint for session rehydration (context + model selections).
   */
  ensureSessionHydrated(
    sessionKey: string,
    options: { workingDir?: string; dangerousMode?: boolean; includeUserPreferences?: boolean } = {}
  ): SessionStore {
    const store = this.getOrCreateSessionStore(sessionKey, options.dangerousMode ?? false, options.workingDir);
    // Hydrate context + session metadata (permissions, model selections).
    store.getContext();

    if (options.includeUserPreferences !== false) {
      const hiddenModels = this.getHiddenModelSet();
      this.pruneInaccessibleSessionSelections(sessionKey, store, hiddenModels);
      this.hydrateModelSelectionsFromPreferences(sessionKey, store, hiddenModels);
      this.seedDefaultModelSelections(sessionKey, store, hiddenModels);
    }

    return store;
  }

  private getHiddenModelSet(): Set<string> {
    const hiddenModels = new Set<string>();
    if (!this.isGraphDReady() || !this.graphd) {
      return hiddenModels;
    }
    const hiddenModelList = this.graphd.getUserPreference<string[]>('user_prefs:hidden_models') ?? [];
    for (const hidden of hiddenModelList) {
      const normalized = hidden.trim().toLowerCase();
      if (normalized.length > 0) {
        hiddenModels.add(normalized);
      }
    }
    return hiddenModels;
  }

  private isSelectionAccessible(
    selection: { provider?: string; model?: string } | null | undefined,
    hiddenModels: Set<string>
  ): selection is ModelSelection {
    const model = selection?.model?.trim();
    const provider = selection?.provider?.trim();
    if (!model || !provider) {
      return false;
    }
    if (hiddenModels.has(model.toLowerCase())) {
      return false;
    }
    return this.hasApiKey(provider);
  }

  private pruneInaccessibleSessionSelections(
    sessionKey: string,
    store: SessionStore,
    hiddenModels: Set<string>
  ): void {
    const removedAgentTypes: string[] = [];
    for (const [agentType, selection] of store.getAllModelSelections()) {
      if (!this.isSelectionAccessible(selection, hiddenModels)) {
        store.clearModelSelection(agentType);
        removedAgentTypes.push(agentType);
      }
    }

    if (removedAgentTypes.length === 0) {
      return;
    }

    this.logger.debug('Removed inaccessible model selections from session', {
      sessionKey,
      removedAgentTypes,
    });

    if (!this.isGraphDReady() || !this.graphd) {
      return;
    }

    const globalSelections = this.graphd.getUserPreference<Record<string, ModelSelection>>(
      'user_prefs:model_selections'
    );
    if (globalSelections) {
      let updated = false;
      for (const [agentType, selection] of Object.entries(globalSelections)) {
        if (!this.isSelectionAccessible(selection, hiddenModels)) {
          delete globalSelections[agentType];
          updated = true;
        }
      }
      if (updated) {
        if (Object.keys(globalSelections).length === 0) {
          this.graphd.deleteUserPreference('user_prefs:model_selections');
        } else {
          this.graphd.setUserPreference('user_prefs:model_selections', globalSelections);
        }
      }
    }

  }

  private modelSelectionForAgent(agentType: string, hiddenModels: Set<string>): ModelSelection | null {
    const agentConfig = this.config.agents[agentType];
    const model = agentConfig?.llm.model?.trim();
    if (!model || hiddenModels.has(model.toLowerCase())) {
      return null;
    }
    const provider = (agentConfig.llm.displayProvider || agentConfig.llm.provider)?.trim();
    const selection = provider ? { provider, model } : null;
    if (!this.isSelectionAccessible(selection, hiddenModels)) {
      return null;
    }
    return selection;
  }

  private resolveFallbackModelSelection(hiddenModels: Set<string>): ModelSelection | null {
    const defaultModel = this.config.models.default?.trim();
    if (defaultModel && !hiddenModels.has(defaultModel.toLowerCase())) {
      const modelEntry = this.config.models.available.find(
        (entry) => entry.id.trim().toLowerCase() === defaultModel.toLowerCase()
      );
      if (modelEntry?.provider && this.hasApiKey(modelEntry.provider)) {
        return { provider: modelEntry.provider, model: modelEntry.id };
      }
    }

    const firstVisible = this.config.models.available.find(
      (entry) => !hiddenModels.has(entry.id.trim().toLowerCase()) && !!entry.provider && this.hasApiKey(entry.provider)
    );
    if (!firstVisible?.provider) {
      return null;
    }
    return { provider: firstVisible.provider, model: firstVisible.id };
  }

  private seedDefaultModelSelections(sessionKey: string, store: SessionStore, hiddenModels: Set<string>): void {
    if (this.initializedModelSelections.has(sessionKey)) {
      return;
    }

    let applied = 0;
    let standardSelection = store.getModelSelection('standard');
    if (!standardSelection) {
      standardSelection =
        this.modelSelectionForAgent('standard', hiddenModels)
        ?? this.modelSelectionForAgent(this.config.defaultAgent, hiddenModels)
        ?? this.resolveFallbackModelSelection(hiddenModels);
      if (standardSelection) {
        store.setModelSelection('standard', standardSelection);
        applied += 1;
      }
    }

    const seedAgentTypes = new Set<string>([
      ...Object.keys(this.config.agents),
      'standard',
      'explorer',
      'coding',
    ]);
    for (const agentType of seedAgentTypes) {
      if (store.getModelSelection(agentType)) {
        continue;
      }
      const selection =
        this.modelSelectionForAgent(agentType, hiddenModels)
        ?? standardSelection
        ?? this.resolveFallbackModelSelection(hiddenModels);
      if (!selection) {
        continue;
      }
      store.setModelSelection(agentType, selection);
      applied += 1;
    }

    this.initializedModelSelections.add(sessionKey);
    if (applied > 0) {
      this.logger.debug('Initialized session model selections from config defaults', {
        sessionKey,
        applied,
      });
    }
  }

  private hydrateModelSelectionsFromPreferences(sessionKey: string, store: SessionStore, hiddenModels: Set<string>): void {
    if (!this.isGraphDReady() || !this.graphd) {
      return;
    }
    if (store.getAllModelSelections().size > 0) {
      return;
    }

    const modelSelectionsMap = this.graphd.getUserPreference<Record<string, { provider: string; model: string; reasoning?: string }>>(
      'user_prefs:model_selections'
    );
    if (!modelSelectionsMap) {
      return;
    }

    let applied = 0;
    let removed = 0;
    const filteredSelections: Record<string, { provider: string; model: string; reasoning?: string }> = {};
    for (const [agentType, selection] of Object.entries(modelSelectionsMap)) {
      if (!this.isSelectionAccessible(selection, hiddenModels)) {
        removed += 1;
        continue;
      }
      const normalizedSelection = {
        provider: selection.provider.trim(),
        model: selection.model.trim(),
        ...(typeof selection.reasoning === 'string' && selection.reasoning.trim().length > 0
          ? { reasoning: selection.reasoning }
          : {}),
      };
      filteredSelections[agentType] = normalizedSelection;
      store.setModelSelection(agentType, normalizedSelection);
      applied += 1;
    }

    if (removed > 0) {
      if (Object.keys(filteredSelections).length === 0) {
        this.graphd.deleteUserPreference('user_prefs:model_selections');
      } else {
        this.graphd.setUserPreference('user_prefs:model_selections', filteredSelections);
      }
    }

    if (applied > 0) {
      // Keep session metadata aligned with global preferences.
      this.graphd.sessionUpdateMetadata(sessionKey, { model_selections: filteredSelections });
    } else if (removed > 0) {
      this.graphd.sessionUpdateMetadata(sessionKey, { model_selections: null });
    }
  }

  setSessionSelectedModel(sessionKey: string, agentType: string, selectedModel: ModelSelection | null): void {
    const store = this.getOrCreateSessionStore(sessionKey);
    if (selectedModel) {
      store.setModelSelection(agentType, selectedModel);
      return;
    }
    store.clearModelSelection(agentType);
  }

  clearAllSessionSelectedModels(sessionKey: string): void {
    const state = this.sessions.get(sessionKey);
    if (!state) {
      return;
    }
    state.store.clearModelSelections();
  }

  getSessionSelectedModel(sessionKey: string, agentType: string): ModelSelection | null {
    const state = this.sessions.get(sessionKey);
    return state?.store.getModelSelection(agentType) ?? null;
  }

  getAllSessionSelectedModels(sessionKey: string): Map<string, ModelSelection> {
    const state = this.sessions.get(sessionKey);
    return state?.store.getAllModelSelections() ?? new Map();
  }

  setSessionAsyncModeEnabled(sessionKey: string, enabled: boolean): void {
    const store = this.getOrCreateSessionStore(sessionKey);
    store.setAsyncModeEnabled(enabled);
  }

  isSessionAsyncModeEnabled(sessionKey: string): boolean {
    const state = this.sessions.get(sessionKey);
    return state?.store.isAsyncModeEnabled() ?? false;
  }

  getAsyncModeStatus(): { ok: boolean; issues: string[] } {
    return { ok: true, issues: [] };
  }

  // --- Session-level exclusive operation management (async runs) ---

  /**
   * Start an async run for a session. Returns false if one is already active.
   */
  startSessionAsyncRun(sessionKey: string, info: { requestId: string; goal: string; cancelled: boolean; startedAt: number }): boolean {
    const store = this.getOrCreateSessionStore(sessionKey);
    return store.startAsyncRun(info);
  }

  /**
   * Get the current async run info for a session.
   */
  getSessionAsyncRun(sessionKey: string): { requestId: string; goal: string; cancelled: boolean; startedAt: number } | null {
    const state = this.sessions.get(sessionKey);
    return state?.store.getAsyncRun() ?? null;
  }

  /**
   * Mark the async run as cancelled for a session.
   */
  cancelSessionAsyncRun(sessionKey: string): void {
    const state = this.sessions.get(sessionKey);
    state?.store.cancelAsyncRun();
  }

  /**
   * Clear the async run state for a session.
   */
  clearSessionAsyncRun(sessionKey: string): void {
    const state = this.sessions.get(sessionKey);
    state?.store.clearAsyncRun();
  }

  async controlSessionExecution(params: {
    sessionKey: string;
    action: 'cancel';
    reason?: string;
    requestedBy?: 'user' | 'system' | 'policy';
    scope?: 'run' | 'work_item' | 'tool';
    targetWorkIds?: string[];
    timeoutMs?: number;
  }): Promise<SessionControlResult> {
    const state = this.sessions.get(params.sessionKey);
    if (!state) {
      return { success: false, error: `Session '${params.sessionKey}' not found` };
    }

    const active = state.store.getActiveExecutionHandle();
    if (!active) {
      return { success: false, error: 'No active execution for this session' };
    }

    const requestedBy = params.requestedBy ?? 'system';
    const requestedAt = Date.now();
    const cancelScope = params.scope ?? 'run';
    const cancellation: RuntimeCancellationMetadata = {
      requestedAt,
      requestedBy,
      reason: params.reason,
      scope: cancelScope,
      targetWorkIds: params.targetWorkIds,
    };

    try {
      await active.executionRuntime.runPromise(publishRuntimeControl(active.controlQueue, {
        action: 'cancel',
        runId: active.requestId,
        cancellation,
      }));
    } catch (error) {
      return {
        success: false,
        requestId: active.requestId,
        error: getErrorMessage(error),
      };
    }

    state.store.updateExecutionRunControl({
      state: cancelScope === 'run' ? 'cancelling' : 'running',
      cancellation: cancelScope === 'run' ? cancellation : undefined,
    });

    if (cancelScope === 'run') {
      const completed = await state.store.waitForExecutionCompletion(
        active.requestId,
        params.timeoutMs ?? 30_000
      );
      if (!completed) {
        return {
          success: false,
          requestId: active.requestId,
          error: 'Timed out waiting for execution to complete',
        };
      }
    }

    return {
      success: true,
      requestId: active.requestId,
    };
  }

  private pruneSessionStores(reason: string): void {
    if (this.sessionTtlMs <= 0) return;
    const now = Date.now();
    const cutoff = now - this.sessionTtlMs;
    for (const [sessionKey, state] of this.sessions.entries()) {
      if (state.store.isExecuting() || state.store.getAsyncRun()) continue;
      if (state.lastAccessMs > cutoff) continue;
      this.teardownSession(sessionKey, state, false);
      this.logger.debug('Evicted session store', {
        sessionKey,
        reason,
        idleMs: now - state.lastAccessMs,
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
    const {
      requestId,
      inputText,
      tier: requestedTier,
      sessionKey,
      workingDir,
      context: supplementalContextRaw,
      hookRegistry,
    } = params;
    const supplementalContext = typeof supplementalContextRaw === 'string'
      ? supplementalContextRaw.trim()
      : '';
    profiler.instant('harness.run', 'harness', 'p', { requestId, tier: requestedTier });
    const runId = requestId;
    const eventQueue = new AsyncEventQueue();
    // Create emit early so harness-level events (status, response, error, user_prompt)
    // reach EventBus → BusServer → SSE, not just the TUI's eventQueue.
    const emit = createEventEmitCallback(this.eventBus, requestId, runId, sessionKey);
    const streamedAssistantChunks: string[] = [];
    const emitWithAssistantCapture = (event: AgentEvent<unknown>) => {
      if (event.type === 'agent_message') {
        const data = event.data;
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          const record = data as Record<string, unknown>;
          const chunk = typeof record.message === 'string'
            ? record.message
            : typeof record.content === 'string'
              ? record.content
              : typeof record.chunk === 'string'
                ? record.chunk
                : '';
          if (chunk) {
            streamedAssistantChunks.push(chunk);
          }
        }
      }
      emit(event);
    };

    this.pruneSessionStores('run');
    const store = this.ensureSessionHydrated(sessionKey, { workingDir, includeUserPreferences: true });
    const controlQueue = Effect.runSync(makeRuntimeControlQueue());
    const executionRuntime = ManagedRuntime.make(Layer.empty);

    const sendingMessage = 'Processing request...';
    eventQueue.push(createStatusEvent('sending', sendingMessage));
    emit(createEvent('harness_status', { state: 'sending', message: sendingMessage }));

    // Attempt to mark execution as started; if another run is active, queue instead.
    if (!store.startExecution(requestId, controlQueue, executionRuntime)) {
      this.logger.info('Message received during active execution, queueing for agent', {
        sessionKey,
        requestId,
        executingRequestId: store.getExecutingRequestId(),
        messagePreview: inputText.slice(0, 100),
      });

      // Queue the message - this adds it to context immediately
      store.queueUserMessage(requestId, inputText);
      if (supplementalContext.length > 0) {
        store.getContext().addMessage(
          'system',
          `Control-plane supplemental context for the queued user message:\n${supplementalContext}`
        );
      }

      // Persist to GraphD if available
      this.persistUserMessage(sessionKey, requestId, inputText);

      // Emit a status event indicating the message was queued
      eventQueue.push(createStatusEvent('idle', 'Message queued - agent will see it on next turn'));
      emit(createEvent('harness_status', { state: 'idle', message: 'Message queued - agent will see it on next turn' }));

      // Return a "queued" result - not an error, but also not a full response
      const resultPromise = Promise.resolve({
        requestId,
        sessionKey,
        success: true,
        finalText: '',
        toolsUsed: [],
        durationMs: 0,
        metadata: { queued: true, executingRequestId: store.getExecutingRequestId() },
      } as AgentRunResult);

      queueMicrotask(() => eventQueue.finish());
      return { result: resultPromise, events: eventQueue };
    }

    const contextWindow = store.getContext();
    contextWindow.addMessage('user', inputText);
    const goal = inputText;
    const effectiveAgentType: AgentType = requestedTier || 'standard';
    const effectiveWorkingDir = workingDir ?? this.config.tools.workingDir;

    if (supplementalContext.length > 0) {
      contextWindow.addMessage(
        'system',
        `Control-plane supplemental context:\n${supplementalContext}`
      );
    }

    if (this.isGraphDReady()) {
      try {
        store.touch(effectiveWorkingDir);
        this.graphd!.setActive(true);
      } catch (error) {
        this.logger.warning('GraphD session touch failed', { error: String(error) });
      }
    }

    const userMessagePersisted = this.persistUserMessage(sessionKey, requestId, inputText);

    // NOTE: Agent events (agent_message, tool_call, etc.) are forwarded directly
    // from EventBus to BusServer via BusServer's direct subscription. Harness-level
    // events (status, response, error, user_prompt) are pushed to eventQueue AND
    // emitted on EventBus so the browser SSE stream receives them too.

    const resultPromise = (async (): Promise<AgentRunResult> => {
      try {
        const userPromptHookResult = await this.runSessionEffectHooks(
          sessionKey,
          {
            type: 'user_prompt_submit',
            workItemId: requestId,
            prompt: {},
          },
          {
            sessionKey,
            requestId,
            workingDir: effectiveWorkingDir,
          }
        );
        if (userPromptHookResult.status === 'blocked') {
          const blockMsg = userPromptHookResult.blockedBy?.reason || 'Request blocked by hook';
          eventQueue.push(createErrorEvent(blockMsg, false));
          eventQueue.push(createStatusEvent('idle'));
          emit(createEvent('harness_error', { message: blockMsg, fatal: false }));
          emit(createEvent('harness_status', { state: 'idle' }));
          return {
            requestId,
            sessionKey,
            success: false,
            finalText: blockMsg,
            errorMessage: blockMsg,
            toolsUsed: [],
            durationMs: 0,
          };
        }

        // Get the appropriate agent config
        const agentConfig = getAgentConfig(this.config, effectiveAgentType);

        this.logger.debug('Running with agent config', {
          agentType: effectiveAgentType,
          model: agentConfig.llm.model,
          provider: agentConfig.llm.provider,
        });

        if (this.isGraphDReady()) {
          try {
            const selection = store.getModelSelection(effectiveAgentType);
            if (!selection) {
              this.logger.warning('No model selection available for session metadata', {
                sessionKey,
                agentType: effectiveAgentType,
              });
            }
            this.graphd!.sessionUpdateMetadata(sessionKey, {
              user_id: 'local-user',
              tier: effectiveAgentType,
              ...(selection ? { model: selection.model, provider: selection.provider } : {}),
            });
          } catch (error) {
            this.logger.warning('GraphD session metadata update failed', { error: String(error) });
          }
        }

        const llmAdapter = this.llmAdapter;

        // All requests go through orchestrator (loop-until-goal architecture)
        // Orchestrator handles interruptions internally via checkInterruption() callback
        const result = await this.runOrchestrator(
          contextWindow,
          goal,
          requestId,
          emitWithAssistantCapture,
          llmAdapter,
          effectiveAgentType,
          effectiveWorkingDir,
          store,
          hookRegistry,
          controlQueue,
          executionRuntime
        );
        const responseContent = result.finalText.trim().length > 0
          ? result.finalText
          : streamedAssistantChunks.join('');
        const responseHasContent = responseContent.trim().length > 0;

        // Persist canonical messages before emitting response/status events.
        // The dashboard refreshes on SSE response events, so persistence must
        // happen first to avoid transient "missing assistant message" gaps.
        this.persistToGraphD(sessionKey, requestId, inputText, responseContent, result.durationMs, userMessagePersisted);

        // Emit response event
        eventQueue.push(
          createResponseEvent(
            requestId,
            result.success,
            responseContent,
            result.toolsUsed,
            result.durationMs,
            result.errorMessage,
            result.metadata
          )
        );
        emit(createEvent('harness_response', {
          success: result.success,
          content: responseContent,
          toolsUsed: result.toolsUsed,
          durationMs: result.durationMs,
          error: result.errorMessage,
          metadata: result.metadata,
        }));

        eventQueue.push(createStatusEvent('idle'));
        emit(createEvent('harness_status', { state: 'idle' }));

        return result;
      } catch (error) {
        // Handle recoverable errors (rate limit, circuit open, retries exhausted)
        const recoverable = classifyRecoverableError(error, requestId);
        if (recoverable) {
          this.logger[recoverable.logLevel]('Recoverable error during agent run', recoverable.logMeta);

          // Emit rate_limit event for monitoring/dashboards (if applicable)
          if (recoverable.rateLimitData) {
            emit(createEvent('rate_limit', recoverable.rateLimitData));
          }

          // Persist context so user doesn't lose work
          store.persistContext();

          eventQueue.push(createErrorEvent(recoverable.userMessage, false)); // recoverable, not fatal
          eventQueue.push(createStatusEvent('idle')); // Return to idle, not error state
          emit(createEvent('harness_error', { message: recoverable.userMessage, fatal: false }));
          emit(createEvent('harness_status', { state: 'idle' }));

          return {
            requestId,
            sessionKey,
            success: false,
            finalText: recoverable.userMessage,
            errorMessage: getErrorMessage(error),
            toolsUsed: [],
            durationMs: 0,
          };
        }

        // Generic error handling for non-recoverable errors
        const errorMessage = getErrorMessage(error);
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
        emit(createEvent('harness_error', { message: errorMessage, fatal: false }));
        emit(createEvent('harness_status', { state: 'error', message: errorMessage }));

        return {
          requestId,
          sessionKey,
          success: false,
          finalText: '',
          errorMessage,
          toolsUsed: [],
          durationMs: 0,
        };
      } finally {
        await this.runSessionEffectHooks(
          sessionKey,
          {
            type: 'session_stop',
            sessionKey,
            reason: 'run_finished',
          },
          {
            sessionKey,
            requestId,
            workingDir: effectiveWorkingDir,
          }
        );

        // Mark execution complete only after session_stop hooks settle.
        const queuedMessages = store.endExecution();
        if (queuedMessages.length > 0) {
          this.logger.info('Execution ended with queued messages', {
            sessionKey,
            requestId,
            queuedCount: queuedMessages.length,
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

    return {
      result: resultPromise,
      events: eventQueue,
      cancel: (reason?: string) =>
        this.controlSessionExecution({
          sessionKey,
          action: 'cancel',
          reason: reason ?? 'Execution cancelled by handle',
          requestedBy: 'system',
        }),
      abort() { void this.cancel!(); },
    };
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
      if (assistantResponse.trim().length > 0) {
        this.graphd!.messageAdd(sessionKey, 'assistant', assistantResponse, requestId, {
          duration_ms: durationMs,
        });
      }
      this.graphd!.sessionUpdateMetadata(sessionKey, {
        last_request_id: requestId,
        last_duration_ms: durationMs,
      });
    } catch (error) {
      this.logger.warning('GraphD persist failed', { error: String(error) });
    }
  }
  private isToolResult(value: unknown): value is ToolResult {
    if (!value || typeof value !== 'object') return false;
    const r = value as Record<string, unknown>;
    return typeof r.toolName === 'string'
      && typeof r.status === 'string'
      && typeof r.output === 'string'
      && typeof r.durationMs === 'number'
      && typeof r.isSuccess === 'boolean';
  }

  /**
   * Create AgentHooks that handle permission checking and session-scoped effect hooks.
   */
  private createAgentHooks(
    sessionKey: string,
    requestId: string,
    workingDir: string,
    emit?: (event: AgentEvent) => void
  ): AgentHooks {
    const logger = this.logger;
    const egHooks = this.entityGraph?.getHooks() ?? null;
    const PERMISSION_REQUEST_TIMEOUT_MS = 60_000;

    // Get the session store to use its per-session permission checker
    const sessionStore = this.getOrCreateSessionStore(sessionKey);
    const permissionChecker = sessionStore.getPermissionChecker();

    return {
      preToolUse: async (toolName: string, args: Record<string, unknown>): Promise<ToolHookResult> => {
        if (toolName.toLowerCase() === 'websearch') {
          const decision = permissionChecker.checkWebSearch();
          if (decision.granted === false) {
            logger.info('Permission denied', { tool: 'WebSearch', reason: decision.reason });
            return {
              action: 'block',
              message: `Permission denied: ${decision.reason}`,
            };
          }
        }

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
              let timeoutId: ReturnType<typeof setTimeout> | null = null;
              const response = await Promise.race<PermissionResponse | null>([
                new Promise<PermissionResponse>((resolve) => {
                  permissionChecker.registerPendingRequest(request.requestId, request, resolve);
                }),
                new Promise<PermissionResponse | null>((resolve) => {
                  timeoutId = setTimeout(() => {
                    resolve(null);
                  }, PERMISSION_REQUEST_TIMEOUT_MS);
                }),
              ]);

              if (timeoutId) {
                clearTimeout(timeoutId);
              }

              if (!response) {
                permissionChecker.cancelPendingRequest(request.requestId);
                return {
                  action: 'block',
                  message: 'Permission request timed out',
                };
              }

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

        const effectResult = await this.runSessionEffectHooks(
          sessionKey,
          {
            type: 'pre_tool_use',
            toolName,
            args,
          },
          {
            sessionKey,
            requestId,
            workingDir,
          }
        );

        if (effectResult.status === 'blocked') {
          return {
            action: 'block',
            message: effectResult.blockedBy?.reason ?? 'Blocked by hook policy',
          };
        }

        let modifiedArgs: Record<string, unknown> | undefined;
        for (const outcomeEntry of effectResult.outcomes) {
          if (outcomeEntry.outcome.kind === 'modify' && typeof outcomeEntry.outcome.value === 'object' && outcomeEntry.outcome.value) {
            modifiedArgs = outcomeEntry.outcome.value as Record<string, unknown>;
          }
        }

        if (modifiedArgs) {
          return { action: 'modify', modifiedArgs };
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

        // Detect git commits from Bash tool and emit git_commit event
        if (toolName === 'Bash' && toolResult.status === 'success') {
          const command = args.command as string | undefined;
          if (command && isGitCommitCommand(command)) {
            let sha = extractCommitSha(toolResult.output);
            if (!sha) {
              try {
                const head = execSync('git rev-parse HEAD', {
                  cwd: workingDir,
                  encoding: 'utf-8',
                  stdio: ['pipe', 'pipe', 'pipe'],
                }).trim();
                if (head) {
                  sha = head;
                }
              } catch {
                // Keep best-effort behavior: no git_commit event if HEAD cannot be resolved.
              }
            }
            if (sha) {
              const range = resolveGitCommitRange(workingDir, sha);
              // Emit git_commit event via EventBus
              const gitCommitData: GitCommitData = {
                sha,
                headSha: range.headSha,
                ...(range.baseSha ? { baseSha: range.baseSha } : {}),
                command,
              };
              this.eventBus.publish(createEvent('git_commit', gitCommitData, undefined, requestId, sessionKey));

              await this.runSessionEffectHooks(
                sessionKey,
                {
                  type: 'post_git_commit',
                  sha,
                  command,
                },
                {
                  sessionKey,
                  requestId,
                  workingDir,
                }
              );
            }
          }
        }

        const effectResult = await this.runSessionEffectHooks(
          sessionKey,
          {
            type: 'post_tool_use',
            toolName,
            args,
            result: toolResult,
          },
          {
            sessionKey,
            requestId,
            workingDir,
          }
        );

        let modifiedResult: ToolResult | undefined;
        for (const outcomeEntry of effectResult.outcomes) {
          if (outcomeEntry.outcome.kind === 'modify' && this.isToolResult(outcomeEntry.outcome.value)) {
            modifiedResult = outcomeEntry.outcome.value;
          }
        }

        if (modifiedResult) {
          return { action: 'modify', modifiedResult };
        }
        if (egModified) {
          return { action: 'modify', modifiedResult: toolResult };
        }
        if (effectResult.status === 'blocked') {
          return { action: 'block', message: effectResult.blockedBy?.reason ?? 'Blocked by hook policy' };
        }
        return { action: 'allow' };
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
    const state = this.sessions.get(sessionKey);
    if (state) {
      return state.store.getPermissionChecker();
    }
    return null;
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
    agentType: AgentType,
    workingDir: string,
    store: SessionStore,
    hookRegistry: UnifiedHookRegistry | undefined,
    controlQueue: RuntimeControlQueue,
    executionRuntime: ManagedRuntime.ManagedRuntime<never, never>
  ): Promise<AgentRunResult> {
    const hooks = this.createAgentHooks(context.sessionKey, requestId, workingDir, emit);

    // Create closure for per-agent-type model selection lookup
    // NO FALLBACK: Each agent type must have an explicit model selection
    const getModelSelection = (queryAgentType: string) => {
      const selection = store.getModelSelection(queryAgentType);
      if (selection) {
        this.logger.debug('Model selection for agent', {
          agentType: queryAgentType,
          model: selection.model,
          provider: selection.provider,
          reasoning: selection.reasoning,
        });
        // Update TraceSubscriber with current model
        this.traceSubscriber?.setCurrentModel(selection.provider, selection.model);
      }
      return selection;
    };

    const sessionKey = context.sessionKey;

    const runtime = {
      hookRegistry,
      executeEffectHook: async (event: InternalHookEvent, hookContext: InternalHookContext, signal?: AbortSignal) => {
        await this.runSessionEffectHooks(
          hookContext.sessionKey,
          event,
          {
            sessionKey: hookContext.sessionKey,
            requestId: hookContext.requestId,
            workId: hookContext.workId,
            agentType: hookContext.agentType,
            workingDir,
            internal: hookContext,
            signal,
          }
        );
      },
      onStart: (activeContext: ContextWindow) => this.attachArtifactSubscriber(activeContext),
      controlQueue,
      // Pass interruption check callback so orchestrator can avoid premature termination
      // when user messages arrived during execution.
      // The callback drains the queue (clear on check) so subsequent checks return false.
      checkInterruption: () => {
        const pending = store.drainQueuedMessages();
        return pending.length > 0;
      },
      getRunControl: () => store.getExecutionRunControl(),
    };

    // Execute with session-specific working directory (passed explicitly for concurrent-safety)
    const asyncId = profiler.asyncBegin(`orchestrator:${agentType}`, 'orchestrator');
    const result = await this.orchestratorRunner.execute({
      config: {
        memoryInjector: this.memoryInjector ?? undefined,
      },
      toolRegistry: this.toolRegistry,
      llm,
      emit,
      requestId,
      logger: this.logger,
      agentRegistry: this.agentRegistry,
      hooks,
      getModelSelection,
      context,
      goal,
      agentType,
      cwd: workingDir,
      runtime,
      executionRuntime,
    });
    profiler.asyncEnd(`orchestrator:${agentType}`, asyncId, 'orchestrator', { toolCalls: result.metrics.totalToolCalls });

    return {
      requestId,
      sessionKey: context.sessionKey,
      success: result.success,
      finalText: result.response,
      errorMessage: result.error,
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
      const sourceState = this.sessions.get(sourceSessionKey);
      const sourceSnapshot = sourceState?.store.getCachedContextSnapshot() ?? null;
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
    const state = this.sessions.get(sessionKey);
    if (!state || !state.store.getCachedContextSnapshot()) {
      return { success: false, itemsRemoved: 0, bytesRecovered: 0, error: 'No context found for session' };
    }

    const context = state.store.getContext();

    try {
      const result = context.compact({
        deduplicateByPath: true,
        maxFileContentCount: 15,
        maxFunctionCallCount: 150,
        maxFunctionCallOutputCount: 150,
        truncateOutputsTo: 3000,
      });

      this.logger.info('Manual context compaction', {
        sessionKey,
        itemsRemoved: result.itemsRemoved,
        functionCallsRemoved: result.functionCallsRemoved ?? 0,
        functionCallOutputsRemoved: result.functionCallOutputsRemoved ?? 0,
        bytesRecovered: result.bytesRecovered,
      });

      // Persist the compacted context
      state.store.persistContext();

      return {
        success: true,
        itemsRemoved: result.itemsRemoved,
        bytesRecovered: result.bytesRecovered,
      };
    } catch (error) {
      const message = getErrorMessage(error);
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

    if (this.traceSubscriber) {
      try {
        this.traceSubscriber.close();
        this.logger.debug('Closed TraceSubscriber');
      } catch (error) {
        this.logger.warning('TraceSubscriber close failed', { error: String(error) });
      } finally {
        this.traceSubscriber = null;
      }
    }

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

    for (const [sessionKey, state] of this.sessions.entries()) {
      this.cleanupSessionInternalHooks(sessionKey, state);
    }

    if (this.pendingSessionHookTasks.size > 0) {
      await Promise.allSettled(Array.from(this.pendingSessionHookTasks));
    }

    // Persist and mark all sessions inactive BEFORE stopping GraphD
    for (const [sessionKey, state] of this.sessions.entries()) {
      try {
        state.store.persistContext();
        if (this.isGraphDReady()) {
          this.graphd!.sessionUpdateStatus(sessionKey, 'inactive');
        }
      } catch (error) {
        this.logger.warning('Session persist failed during shutdown', { sessionKey, error: String(error) });
      }
      state.store.close();
    }
    this.sessions.clear();

    if (this.isGraphDReady()) {
      try {
        await this.graphd!.stop();
        this.logger.info('GraphD disconnected');
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
