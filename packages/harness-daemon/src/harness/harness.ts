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
import { randomUUID } from 'crypto';
import { createAdapter, hasCodexCredentials, type ProviderKeyService } from 'llm';
import { classifyRecoverableError, getErrorMessage } from './error_handlers.js';
import { ToolRegistry, builtinToolOptions } from 'tools';
import { createEvent, successResult, errorResult, providerRequiresAuth, type AgentEvent, type ToolResult, type LLMClientConfig, type LLMProvider, type RateLimitData, type ArtifactDiscoveredData, type ArtifactKind, type GitCommitData } from 'types';
import { ContextWindow } from 'context';
import { profiler, buildLLMRequestConfig, parseAndValidateOutput, getWatcherSchemaJsonForActions, type WatcherActionOutput } from 'shared';
import { GraphDManager, createGraphDConfig, type GraphDSession } from 'graphd';
import { EventBus, type EventBusProtocol, createEventEmitCallback } from 'comms-bus';
import { createGraphDSubscriber } from '../subscribers/graphd_subscriber.js';
import { LogSubscriber, createLogSubscriber } from '../subscribers/log_subscriber.js';
import { createTraceSubscriber, extractCommitSha, isGitCommitCommand, type TraceSubscriber } from '../subscribers/trace_subscriber.js';
import { SyncClient } from 'agent-memory';
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
import { loadSkillDefinitions, getSkillDefinition, type HookContext as SkillHookContext } from './skills_loader.js';
import { SessionStore } from './session_store.js';
import { createFileLogger, type HarnessLogger } from './harness_infra.js';
import { PermissionChecker } from './permissions.js';
import { DefaultOrchestratorRunner, type OrchestratorRunner } from './orchestrator_runner.js';
import type { PermissionedTool, PermissionRequest, PermissionResponse, EscalationCreateInput } from 'types';
import { isPermissionedTool, normalizeToolName } from 'types';
import { createSessionState, touchSession, type SessionState } from './session_state.js';
import {
  DecisionEngine,
  InMemoryDecisionDatabase,
  createDecisionEngine,
  createWatcherConfig,
  DEFAULT_DECISIONS,
  createWatcherControlHooks,
  buildPlanningObjective,
  writeSalienceFile,
  createDecisionLog,
  createWorkLog,
  getWorkItemLog,
  createWorkItemLog,
  writeSemanticFileAsync,
  type WatcherTrigger,
  type DecisionDatabase,
  type WorkItemLog,
  type WatcherAction,
  type RaisedEscalation,
  type SemanticOutput,
} from 'decision-watcher';
import { EntityGraph, type EntityGraphConfig } from 'entity-graph';
import { createHookRegistry, registerHook, executeHooks, DEFAULT_ORCHESTRATOR_CONFIG, type HookRegistry } from 'orchestrator';
import { createWorkItem } from 'work';
import { createMemoryInjector, type MemoryInjector as MemoryInjectorInstance } from 'memory-injector';
import { getProtocolId } from 'protocol';
import {
  buildEscalationResolutionGuidance,
  parseSessionEscalations,
  resolveSessionEscalationState,
  type EscalationResolutionInput,
} from './escalation_state.js';

/** Agent type for routing - maps to agent config */
type AgentType = string;

type SessionGetResponse = { session?: GraphDSession; error?: string };

export interface ResolveSessionEscalationResult {
  success: boolean;
  escalationId: string;
  pendingCount?: number;
  sessionStatus?: string;
  resumed?: boolean;
  resumeRequestId?: string;
  alreadyResolved?: boolean;
  error?: string;
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
      cwd: workingDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
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

function normalizeEscalationRefType(type: string): string {
  const normalized = type.trim().toLowerCase();
  if (normalized === 'testreport' || normalized === 'test_report' || normalized === 'test-report') return 'testReport';
  if (normalized === 'workitem' || normalized === 'work_item' || normalized === 'work-item') return 'workItem';
  if (normalized === 'pull_request' || normalized === 'pull-request' || normalized === 'pullrequest') return 'pr';
  if (normalized === 'session') return 'session';
  if (normalized === 'commit') return 'commit';
  if (normalized === 'file') return 'file';
  if (normalized === 'trace') return 'trace';
  if (normalized === 'pr') return 'pr';
  return normalized.replace(/[^a-z0-9]/g, '');
}

function toEscalationEvidenceRefs(
  escalation: RaisedEscalation
): Array<{ type: string; value: string; label: string }> {
  const refs: Array<{ type: string; value: string; label: string }> = [];
  const seen = new Set<string>();
  for (const reference of escalation.references ?? []) {
    const type = normalizeEscalationRefType(reference.type ?? '');
    const value = String(reference.target ?? '').trim();
    if (!type || !value) continue;
    const key = `${type.toLowerCase()}::${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      type,
      value,
      label: reference.label || reference.type || type,
    });
  }
  return refs;
}

function inlineRef(type: string, value: string): string {
  return `@${type}(${value})`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function buildEscalationPacketMarkdown(
  escalation: RaisedEscalation,
  trigger: WatcherTrigger
): {
  markdown: string;
  evidenceIndex: Array<{ type: string; value: string }>;
  requestedDecision: 'choose' | 'approve' | 'clarify';
} {
  const evidenceRefs = toEscalationEvidenceRefs(escalation);
  const options = escalation.options ?? [];
  const requestedDecision: 'choose' | 'approve' | 'clarify' = options.length > 1
    ? 'choose'
    : options.length === 1
      ? 'approve'
      : 'clarify';

  const recommendedOption = options.find((option) => option.recommended) ?? options[0];
  const commitRef = evidenceRefs.find((ref) => ref.type.toLowerCase() === 'commit');
  const testReportRef = evidenceRefs.find((ref) => ref.type.toLowerCase() === 'testreport');
  const links: Array<{ key: string; target: string }> = [];
  if (commitRef) {
    links.push({ key: 'diff', target: `/diff?head=${encodeURIComponent(commitRef.value)}` });
  }
  if (testReportRef) {
    links.push({ key: 'tests', target: `/tests?id=${encodeURIComponent(testReportRef.value)}` });
  }
  if (escalation.workItemId) {
    links.push({
      key: 'trace',
      target: `/trace?sessionKey=${encodeURIComponent(escalation.sessionKey)}&workItemId=${encodeURIComponent(escalation.workItemId)}`,
    });
  }

  const lines: string[] = ['---', 'type: escalation', `sessionKey: ${yamlString(escalation.sessionKey)}`];
  if (escalation.workItemId) {
    lines.push(`workItemId: ${yamlString(escalation.workItemId)}`);
  }
  lines.push(`requestedDecision: ${requestedDecision}`);
  if (links.length > 0) {
    lines.push('links:');
    for (const link of links) {
      lines.push(`  ${link.key}: ${yamlString(link.target)}`);
    }
  }
  if (evidenceRefs.length > 0) {
    lines.push('refs:');
    for (const ref of evidenceRefs) {
      lines.push(`  - ${ref.type}: ${yamlString(ref.value)}`);
    }
  }
  lines.push('---', '');

  lines.push(`# Decision: ${escalation.title}`);
  lines.push('', '## Context');
  lines.push(escalation.context.trim() || `Watcher escalation triggered by ${trigger}.`);

  if ((escalation.tradeoffs ?? []).length > 0) {
    lines.push('', '## Tradeoffs');
    for (const tradeoff of escalation.tradeoffs ?? []) {
      lines.push(`- ${tradeoff}`);
    }
  }

  lines.push('', '## The Question');
  lines.push(escalation.title);

  lines.push('', '## Options');
  if (options.length === 0) {
    lines.push('- Provide direction for the requested decision.');
  } else {
    for (let idx = 0; idx < options.length; idx += 1) {
      const option = options[idx];
      lines.push(`${idx + 1}. **${option.label}**`);
      if (option.description) {
        lines.push(`   ${option.description}`);
      }
      for (const implication of option.implications ?? []) {
        lines.push(`   - ${implication}`);
      }
      if (option.recommended) {
        lines.push('   - Recommended by watcher');
      }
    }
  }

  lines.push('', '## Recommendation (Watcher)');
  if (recommendedOption) {
    lines.push(`Leaning **${recommendedOption.label}** based on current constraints and evidence.`);
  } else {
    lines.push('No single option recommended yet; request is for clarification.');
  }

  lines.push('', 'Evidence:');
  if (evidenceRefs.length === 0) {
    lines.push('- No explicit evidence refs were provided by watcher.');
  } else {
    for (const ref of evidenceRefs.slice(0, 8)) {
      lines.push(`- ${ref.label}: ${inlineRef(ref.type, ref.value)}`);
    }
  }

  if (options.length > 0) {
    for (const option of options.slice(0, 4)) {
      lines.push('', `## If you choose ${option.label}`);
      lines.push('I will apply the selected direction, update implementation, and run verification gates.');
    }
  }

  return {
    markdown: lines.join('\n'),
    evidenceIndex: evidenceRefs.map((ref) => ({ type: ref.type, value: ref.value })),
    requestedDecision,
  };
}

async function writeEscalationPacketFile(
  watcherDir: string,
  escalationId: string,
  markdown: string
): Promise<string> {
  const packetsDir = path.join(watcherDir, '.cockpit', 'packets');
  await fs.promises.mkdir(packetsDir, { recursive: true });
  const safeEscalationId = escalationId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const absolutePath = path.join(packetsDir, `${stamp}_${safeEscalationId}.md`);
  await fs.promises.writeFile(absolutePath, markdown, 'utf8');
  return path.relative(watcherDir, absolutePath);
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
    // Codex uses OAuth tokens, not API keys
    if (provider === 'codex') {
      return hasCodexCredentials();
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

  // -------------------------------------------------------------------------
  // Per-session state (see SessionState type in session_state.ts for consolidated version)
  // -------------------------------------------------------------------------
  private sessions = new Map<string, SessionState>();
  // -------------------------------------------------------------------------

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
  private orchestratorRunner: OrchestratorRunner;
  private entityGraph: EntityGraph | null = null;
  private memoryInjector: MemoryInjector | null = null;
  private traceSubscriber: TraceSubscriber | null = null;
  private memoryClient: SyncClient | null = null;
  private asyncModeIssues: string[] = [];

  constructor(config: FullHarnessConfig, logger?: HarnessLogger, orchestratorRunner?: OrchestratorRunner) {
    this.config = config;
    this.logger = logger ?? consoleLogger;
    this.sessionTtlMs = config.context.sessionTtlMs;
    this.pauseTimeoutMs = config.context.pauseTimeoutMs;

    // Gather environment context once at startup
    const envContext = gatherEnvironmentContext(config.tools.workingDir);
    this.agentRegistry = buildAgentRegistry(config, envContext);
    this.validateAsyncAgentSchemas();

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

    if (config.dangerousMode) {
      this.logger.warning('Permission checks DISABLED - running in dangerous mode');
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

    // Initialize SyncClient for agent-memory daemon (used by TraceSubscriber)
    const memoryDaemonUrl = process.env.MEMORY_DAEMON_URL || 'http://127.0.0.1:3001';
    try {
      this.memoryClient = new SyncClient(memoryDaemonUrl);
      this.logger.info('Memory client initialized for traces', { url: memoryDaemonUrl });
    } catch (error) {
      this.logger.warning('Failed to initialize memory client (traces will not be persisted)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

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
          error: error instanceof Error ? error.message : String(error),
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
      memoryEnabled: this.memoryInjector !== null,
      traceEnabled: this.traceSubscriber !== null,
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
    const state = this.sessions.get(sessionKey);
    if (state) {
      // Persist context before closing
      state.store.persistContext();
      state.store.close();
      this.sessions.delete(sessionKey);
    }

    // Always mark session as inactive in GraphD, even if in-memory state was already evicted
    if (this.isGraphDReady()) {
      try {
        this.graphd!.sessionUpdateStatus(sessionKey, 'inactive');
      } catch (error) {
        this.logger.warning('Failed to mark session inactive', { sessionKey, error: String(error) });
      }
    }
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
  private getSessionState(sessionKey: string): SessionState | null {
    return this.sessions.get(sessionKey) ?? null;
  }

  private getOrCreateSessionState(sessionKey: string, dangerousMode = false, workingDir?: string): SessionState {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      touchSession(existing);
      return existing;
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
    return state;
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
    const state = this.sessions.get(sessionKey);
    return state?.store.getModelSelection(agentType) ?? null;
  }

  getAllSessionSelectedModels(sessionKey: string): Map<string, ModelSelection> {
    const state = this.sessions.get(sessionKey);
    return state?.store.getAllModelSelections() ?? new Map();
  }

  isSessionPaused(sessionKey: string): boolean {
    const state = this.sessions.get(sessionKey);
    return !!state?.store.getPausedState();
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
    return { ok: this.asyncModeIssues.length === 0, issues: [...this.asyncModeIssues] };
  }

  resolveSessionEscalation(
    sessionKey: string,
    escalationId: string,
    resolution: EscalationResolutionInput
  ): ResolveSessionEscalationResult {
    if (!this.isGraphDReady() || !this.graphd) {
      return {
        success: false,
        escalationId,
        error: 'GraphD not available',
      };
    }

    const result = this.graphd.sessionGet(sessionKey) as SessionGetResponse;
    const session = result.session;
    if (!session) {
      return {
        success: false,
        escalationId,
        error: result.error || `Session not found: ${sessionKey}`,
      };
    }

    const metadata = (session.metadata ?? {}) as Record<string, unknown>;
    const existingEscalations = parseSessionEscalations(metadata.escalations);
    const resolvedState = resolveSessionEscalationState(existingEscalations, escalationId, resolution);

    if (!resolvedState.found || !resolvedState.resolved) {
      return {
        success: false,
        escalationId,
        error: `Escalation not found: ${escalationId}`,
      };
    }

    const nextMetadata: Record<string, unknown> = {
      ...metadata,
      escalations: resolvedState.escalations,
    };
    const metadataUpdate = this.graphd.sessionUpdateMetadata(sessionKey, nextMetadata, false) as {
      success?: boolean;
      error?: string;
    };
    if (!metadataUpdate.success) {
      return {
        success: false,
        escalationId,
        error: metadataUpdate.error || `Failed to update escalation metadata for ${sessionKey}`,
      };
    }

    // Persist resolution to durable storage (fire-and-forget)
    if (this.memoryClient) {
      this.memoryClient.escalations.resolve(escalationId, {
        optionId: resolution.optionId,
        freeformResponse: resolution.freeformResponse,
      }).catch((err) => {
        this.logger.warning('Failed to persist escalation resolution to database', {
          sessionKey,
          escalationId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    const store = this.ensureSessionHydrated(sessionKey, {
      workingDir: session.workingDir ?? undefined,
      includeUserPreferences: false,
    });
    const guidance = buildEscalationResolutionGuidance(resolvedState.resolved, resolution);
    store.getContext().addMessage('system', guidance);
    store.persistContext();

    const pausedWorkItems = store.listPausedWorkItems();
    const pausedWorkItem = pausedWorkItems.find((item) => (
      item.status === 'pending' && (
        item.escalationId === escalationId ||
        (!!resolvedState.resolved?.workItemId && item.workId === resolvedState.resolved.workItemId)
      )
    ));
    const resolvedPausedWorkItem = pausedWorkItem
      ? store.resolvePausedWorkItem(pausedWorkItem.workId, guidance)
      : null;

    const internalContext: InternalHookContext = {
      workId: resolvedState.resolved.workItemId ?? escalationId,
      agentType: 'watcher',
      sessionKey,
      requestId: '',
      objective: resolvedState.resolved.title,
    };

    const resolutionEvent: InternalHookEvent = {
      type: 'escalation_resolved',
      escalationId,
      sessionKey,
      resolution,
    };
    this.emitInternalHookAsync(resolutionEvent, internalContext);

    const sessionState = this.sessions.get(sessionKey);
    if (sessionState?.workLog) {
      void sessionState.workLog.append({
        type: 'note',
        timestamp: new Date().toISOString(),
        workId: resolvedState.resolved.workItemId ?? escalationId,
        note: `[escalation_resolved] ${resolvedState.resolved.id} (${resolution.resolvedBy})`,
        source: 'watcher',
      }).catch((err) => {
        this.logger.warning('Work log write failed (escalation_resolved)', {
          sessionKey,
          escalationId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    let nextStatus = session.status;
    if (resolvedState.pendingCount === 0 && session.status === 'blocked') {
      const statusUpdate = this.graphd.sessionUpdateStatus(sessionKey, 'active') as {
        success?: boolean;
        error?: string;
      };
      if (!statusUpdate.success) {
        return {
          success: false,
          escalationId,
          error: statusUpdate.error || `Failed to transition ${sessionKey} to active`,
        };
      }

      nextStatus = 'active';
      const statusEvent: InternalHookEvent = {
        type: 'session_status_changed',
        sessionKey,
        previousStatus: 'blocked',
        newStatus: 'active',
        reason: `Escalation ${escalationId} resolved`,
        triggeringEscalationId: escalationId,
      };
      this.emitInternalHookAsync(statusEvent, internalContext);
    }

    let resumed = false;
    let resumeRequestId: string | undefined;
    const canAutoResume = nextStatus === 'active' &&
      resolvedState.pendingCount === 0 &&
      store.isAsyncModeEnabled() &&
      !this.getSessionAsyncRun(sessionKey);

    if (canAutoResume) {
      const paused = store.getPausedState();
      const replayContext = resolvedPausedWorkItem
        ? [
            '[Watcher Replay Context]',
            `Work item: ${resolvedPausedWorkItem.workId}`,
            `Agent: ${resolvedPausedWorkItem.agentType}`,
            ...(resolvedPausedWorkItem.objective ? [`Original objective: ${resolvedPausedWorkItem.objective}`] : []),
            `Watcher stop reason: ${resolvedPausedWorkItem.reason}`,
            `Escalation: ${escalationId}`,
            ...(sessionState?.workLog ? [`Work log: ${sessionState.workLog.filePath()}`] : []),
            '',
            'Human resolution guidance:',
            guidance,
            '',
            'Resume this work item using the guidance above. Do not restart unrelated tasks.',
          ].join('\n')
        : null;

      const resumeInput = paused
        ? (resolution.freeformResponse?.trim() || resolution.optionId || guidance)
        : replayContext ?? `Escalation ${escalationId} has been resolved.\n${guidance}`;
      const workingDir = paused?.workingDir ?? session.workingDir ?? this.config.tools.workingDir;

      resumeRequestId = `escalation-resume-${randomUUID()}`;
      const resumeHandle = this.run({
        requestId: resumeRequestId,
        inputText: resumeInput,
        sessionKey,
        workingDir,
      });
      resumed = true;

      void resumeHandle.result.catch((error) => {
        this.logger.warning('Auto-resume after escalation resolution failed', {
          sessionKey,
          escalationId,
          requestId: resumeRequestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return {
      success: true,
      escalationId,
      pendingCount: resolvedState.pendingCount,
      sessionStatus: nextStatus,
      resumed,
      ...(resumeRequestId ? { resumeRequestId } : {}),
      alreadyResolved: resolvedState.alreadyTerminal,
    };
  }

  // --- Session-level exclusive operation management (async runs, ralph loops) ---

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

  /**
   * Start a Ralph Loop for a session. Returns false if one is already active.
   */
  startSessionRalphLoop(sessionKey: string, info: { requestId: string; cancelled: boolean }): boolean {
    const store = this.getOrCreateSessionStore(sessionKey);
    return store.startRalphLoop(info);
  }

  /**
   * Get the current Ralph Loop info for a session.
   */
  getSessionRalphLoop(sessionKey: string): { requestId: string; cancelled: boolean } | null {
    const state = this.sessions.get(sessionKey);
    return state?.store.getRalphLoop() ?? null;
  }

  /**
   * Mark the Ralph Loop as cancelled for a session.
   */
  cancelSessionRalphLoop(sessionKey: string): void {
    const state = this.sessions.get(sessionKey);
    state?.store.cancelRalphLoop();
  }

  /**
   * Clear the Ralph Loop state for a session.
   */
  clearSessionRalphLoop(sessionKey: string): void {
    const state = this.sessions.get(sessionKey);
    state?.store.clearRalphLoop();
  }

  private pruneSessionStores(reason: string): void {
    if (this.sessionTtlMs <= 0) return;
    const now = Date.now();
    const cutoff = now - this.sessionTtlMs;
    const markInactive = (sessionKey: string) => {
      if (!this.isGraphDReady()) return;
      try {
        this.graphd!.sessionUpdateStatus(sessionKey, 'inactive');
      } catch (error) {
        this.logger.warning('GraphD session status update failed', { error: String(error), sessionKey });
      }
    };
    for (const [sessionKey, state] of this.sessions.entries()) {
      const pausedState = state.store.getPausedState();
      if (pausedState) {
        // Paused sessions: check if paused too long
        const pausedDuration = now - pausedState.pausedAt;
        if (pausedDuration < this.pauseTimeoutMs) continue; // Still within timeout, skip
        // Paused too long - persist and evict
        state.store.persistContext();
        state.store.close();
        markInactive(sessionKey);
        this.sessions.delete(sessionKey);
        this.logger.debug('Evicted paused session (timeout)', {
          sessionKey,
          reason,
          pausedMs: pausedDuration,
        });
      } else {
        // Active sessions: check TTL as before
        if (state.lastAccessMs > cutoff) continue;
        state.store.close();
        markInactive(sessionKey);
        this.sessions.delete(sessionKey);
        this.logger.debug('Evicted session store', {
          sessionKey,
          reason,
          idleMs: now - state.lastAccessMs,
        });
      }
    }
  }

  private normalizeSchemaId(schema: { schemaId?: string; name?: string } | undefined): string | null {
    const raw = schema?.schemaId ?? schema?.name;
    if (!raw || typeof raw !== 'string') return null;
    return raw.trim().toLowerCase();
  }

  private validateAsyncAgentSchemas(): void {
    const issues: string[] = [];
    const check = (agentType: string, expectedSchemaId: string) => {
      if (!this.agentRegistry.has(agentType)) {
        issues.push(`Missing required agent config: ${agentType}`);
        return;
      }
      const config = this.agentRegistry.getConfig(agentType);
      const schemaId = this.normalizeSchemaId(config.outputSchema);
      if (!schemaId) {
        issues.push(`Agent '${agentType}' missing output schema (expected '${expectedSchemaId}')`);
        return;
      }
      if (schemaId !== expectedSchemaId) {
        issues.push(`Agent '${agentType}' output schema mismatch: expected '${expectedSchemaId}', got '${schemaId}'`);
      }
    };

    check('watcher', 'watcher_action');
    check('planner', 'planner_output');

    this.asyncModeIssues = issues;
    if (issues.length > 0) {
      this.logger.error('Async mode agent schema validation failed', { issues });
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
    const {
      requestId,
      inputText,
      tier: requestedTier,
      sessionKey,
      workingDir,
      context: supplementalContextRaw,
      planMode,
      hookRegistry,
    } = params;
    const supplementalContext = typeof supplementalContextRaw === 'string'
      ? supplementalContextRaw.trim()
      : '';
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
        const handoffSpecText = JSON.stringify(paused.handoffSpec, null, 2);
        // User approved spec - clear context and execute with handoffSpec
        this.logger.info('User approved spec review, executing with spec', {
          sessionKey,
          specLength: handoffSpecText.length,
        });
        contextWindow = store.clearContext();
        store.clearPausedState();
        goal = handoffSpecText;
        effectiveAgentType = 'standard';
        effectivePlanMode = false;
        effectiveWorkingDir = workingDir ?? paused.workingDir;
        clearContextForHandoff = true;
      }
      // Handle legacy handoff_approval (orchestrator-level approval)
      else if (isHandoffApproval && paused.handoffSpec && userApproved) {
        const handoffSpecText = JSON.stringify(paused.handoffSpec, null, 2);
        // User approved handoff - clear context and execute with handoffSpec
        this.logger.info('User approved handoff, executing with spec', {
          sessionKey,
          specLength: handoffSpecText.length,
        });
        contextWindow = store.clearContext();
        store.clearPausedState();
        goal = handoffSpecText;
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
              'User approved handoff. Set action: "handoff" with your complete implementation spec in handoffSpec (structured object). The system will automatically clear context and start execution with your spec.'
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
          const hookContext: SkillHookContext = {
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
        // Note: hookRegistry only applies to fresh runs, not resumes
        const result = await this.runOrchestrator(
          contextWindow,
          goal,
          requestId,
          emit,
          llmAdapter,
          effectiveAgentType,
          effectiveWorkingDir,
          effectivePlanMode,
          store,
          isResume ? undefined : hookRegistry
        );

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

          return {
            requestId,
            sessionKey,
            success: false,
            finalText: recoverable.userMessage,
            errorMessage: getErrorMessage(error),
            paused: false,
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
          const hookContext: SkillHookContext = {
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

  private isToolResult(value: unknown): value is ToolResult {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.toolName !== 'string') return false;
    if (typeof record.status !== 'string') return false;
    if (typeof record.output !== 'string') return false;
    if (typeof record.durationMs !== 'number') return false;
    if (typeof record.isSuccess !== 'boolean') return false;
    if (record.error !== undefined && typeof record.error !== 'string') return false;
    if (record.metadata !== undefined && (typeof record.metadata !== 'object' || record.metadata === null)) return false;

    const validStatuses = new Set(['success', 'error', 'timeout', 'cancelled']);
    if (!validStatuses.has(record.status)) return false;
    if (record.status === 'success' && record.isSuccess !== true) return false;
    if (record.status !== 'success' && record.isSuccess !== false) return false;

    return true;
  }

  /**
   * Create AgentHooks that handle permission checking and delegate to HookExecutor.
   */
  private createAgentHooks(sessionKey: string, requestId: string, emit?: (event: AgentEvent) => void): AgentHooks {
    const executor = this.hookExecutor;
    const workingDir = this.config.tools.workingDir;
    const logger = this.logger;
    const egHooks = this.entityGraph?.getHooks() ?? null;
    const PERMISSION_REQUEST_TIMEOUT_MS = 60_000;

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

        // Run hook executor if available
        if (executor) {
          const context: SkillHookContext = {
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

              // Execute PostGitCommit hooks if executor available
              if (executor) {
                const gitContext: SkillHookContext = {
                  event: 'PostGitCommit',
                  toolName: 'Bash',
                  toolParams: args,
                  toolResult,
                  sessionKey,
                  requestId,
                  workingDir,
                  commitSha: sha,
                };
                await executor.execute('PostGitCommit', gitContext);
              }
            }
          }
        }

        if (!executor) {
          return egModified
            ? { action: 'modify', modifiedResult: toolResult }
            : { action: 'allow' };
        }

        const context: SkillHookContext = {
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
          if (this.isToolResult(result.modified)) {
            return { action: 'modify', message: result.message, modifiedResult: result.modified };
          }
          logger.warning('PostToolUse hook returned invalid ToolResult, ignoring modification', {
            toolName,
            sessionKey,
          });
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
    agentType: AgentType = 'standard',
    workingDir?: string,
    planMode?: boolean,
    store?: SessionStore,
    hookRegistry?: HookRegistry
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
            // Update TraceSubscriber with current model
            this.traceSubscriber?.setCurrentModel(selection.provider, selection.model);
          }
          return selection;
        }
      : undefined;

    // Build orchestrator runtime with optional hooks
    const sessionKey = context.sessionKey;
    const sessionState = this.getSessionState(sessionKey);
    let lastWatcherIteration = 0;
    const minWatcherGap = DEFAULT_ORCHESTRATOR_CONFIG.minWatcherIterationGap;
    const effectiveWorkingDir = workingDir ?? this.config.tools.workingDir;

    const asyncEnabledForRun = (store?.isAsyncModeEnabled() ?? false) || !!hookRegistry;

    // Only create/use watcher hooks when async mode is enabled for this session/run
    let effectiveHookRegistry = hookRegistry;
    if (asyncEnabledForRun && !hookRegistry) {
      // Check if we already have a cached hook registry for this session
      const cachedRegistry = sessionState?.hookRegistry;
      if (cachedRegistry) {
        effectiveHookRegistry = cachedRegistry;
        this.logger.debug('Using cached watcher hook registry', { sessionKey });
      } else {
        // Create the watcher hook registry - registers logging hooks and sets up watcher
        // Pass daemon's config working dir as watcherDir for .watcher artifacts (project root)
        this.logger.info('Creating watcher hook registry for async mode', { sessionKey, goal });
        const { hookRegistry: watcherRegistry } = await this.createWatcherHookRegistryForSession(
          sessionKey,
          goal,
          effectiveWorkingDir,
          this.config.tools.workingDir  // Watcher artifacts at project root
        );
        effectiveHookRegistry = watcherRegistry;
        if (sessionState) {
          sessionState.hookRegistry = watcherRegistry;
        }
      }
    }

    const runtime = {
      hookRegistry: asyncEnabledForRun ? effectiveHookRegistry : undefined,
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
      // Watcher evaluation — rule-based, fires every minWatcherIterationGap iterations
      onIteration: asyncEnabledForRun ? (state: { iteration: number; context: ContextWindow; totalToolCalls: number; totalLlmCalls: number; elapsedMs: number }) => {
        if (state.iteration - lastWatcherIteration < minWatcherGap) return;
        lastWatcherIteration = state.iteration;

        const pct = state.context.metrics.percentageUsed;
        const engine = this.getOrCreateWatcherEngine(sessionKey);
        const hasDecisions = engine.hasDecisions(sessionKey);

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
      } : undefined,
    };

    // Execute with session-specific working directory (passed explicitly for concurrent-safety)
    const sessionDb = asyncEnabledForRun ? this.getOrCreateDecisionDatabase(context.sessionKey) : undefined;
    const asyncId = profiler.asyncBegin(`orchestrator:${agentType}`, 'orchestrator');
    const result = await this.orchestratorRunner.execute({
      config: {
        ...(asyncEnabledForRun ? {
          asyncMode: {
            enabled: true,
            database: sessionDb as DecisionDatabase,
          },
        } : {}),
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
      const handoffSpecText = JSON.stringify(result.handoffSpec);
      this.logger.info('Handoff requested, pausing for user approval', {
        sessionKey: context.sessionKey,
        specLength: handoffSpecText.length,
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
        truncateOutputsTo: 3000,
      });

      this.logger.info('Manual context compaction', {
        sessionKey,
        itemsRemoved: result.itemsRemoved,
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
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Context compaction failed', { sessionKey, error: message });
      return { success: false, itemsRemoved: 0, bytesRecovered: 0, error: message };
    }
  }

  // =========================================================================
  // Watcher Agent: LLM-backed control-plane hooks
  // =========================================================================

  /**
   * Run the watcher agent with a trigger-specific objective.
   * Creates a mini Agent instance, executes it, and parses the structured WatcherAction output.
   */
  private async runWatcherAgent(
    objective: string,
    sessionKey: string,
    trigger?: WatcherTrigger,
    signal?: AbortSignal
  ): Promise<WatcherAction> {
    // Get the watcher agent config from registry
    if (!this.agentRegistry.has('watcher')) {
      this.logger.warning('Watcher agent type not registered, defaulting to allow');
      return { watcherAction: 'allow', reason: 'Watcher agent not configured' };
    }

    const agentConfig = this.agentRegistry.getConfig('watcher');

    // Get model selection for the watcher agent type
    const store = this.sessions.get(sessionKey)?.store;
    const modelSelection = store?.getModelSelection('watcher');

    if (!modelSelection) {
      this.logger.warning('No model selection available for watcher agent');
      return { watcherAction: 'allow', reason: 'No model selection for watcher' };
    }

    // Update TraceSubscriber with current model
    this.traceSubscriber?.setCurrentModel(modelSelection.provider, modelSelection.model);


    const llmConfig = buildLLMRequestConfig(modelSelection, agentConfig.llmParams);
    const rawSchemaId = agentConfig.outputSchema?.schemaId ?? agentConfig.outputSchema?.name;
    const normalizedSchemaId = typeof rawSchemaId === 'string'
      ? rawSchemaId.trim().toLowerCase().replace(/_output$/, '')
      : null;
    if (normalizedSchemaId !== 'watcher_action') {
      throw new Error(`Watcher output schema misconfigured (expected "watcher_action", got "${rawSchemaId ?? 'none'}").`);
    }

    // Import getValidActions to build trigger-specific schema
    const { getValidActions } = await import('decision-watcher');

    // Build trigger-specific schema that ONLY includes valid actions for this trigger
    // This prevents the LLM from seeing/using actions that would be rejected
    const validActions = trigger ? getValidActions(trigger) : [];
    const triggerSpecificSchema = validActions.length > 0
      ? getWatcherSchemaJsonForActions(validActions)
      : agentConfig.outputSchema;

    // Override config with trigger-specific schema
    const watcherConfig = {
      ...agentConfig,
      outputSchema: triggerSpecificSchema,
    };

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
      memoryInjector: this.memoryInjector ?? undefined,
    });

    // Use session-scoped watcher context (persists across invocations)
    // This prevents re-reading the same files every time
    const sessionState = this.sessions.get(sessionKey);
    let context = sessionState?.watcherContext;
    if (!context) {
      context = new ContextWindow(`watcher:${sessionKey}`, 200_000);
      if (sessionState) {
        sessionState.watcherContext = context;
      }
      this.logger.debug('Created new watcher context', { sessionKey });
    }
    const workingDir = this.config.tools.workingDir;

    const workItem = createWorkItem({
      goal: 'watcher_evaluation',
      objective,
      agent: 'watcher',
      bounds: {
        maxToolCalls: agentConfig.budget.maxToolCalls,
        maxDurationMs: agentConfig.budget.maxDurationMs,
        maxLlmCalls: agentConfig.budget.maxIterations,
      },
    });

    try {
      if (signal?.aborted) {
        return { watcherAction: 'allow', reason: 'Watcher aborted' };
      }
      const result = await agent.run({ globalContext: context, workItem, cwd: workingDir, signal });
      let structured = result.structuredOutput as WatcherActionOutput | undefined;

      if (!structured && result.response) {
        const parsed = parseAndValidateOutput('watcher_action', result.response);
        if (parsed) {
          structured = parsed as WatcherActionOutput;
        }
      }

      if (structured) {
        if (structured.action !== 'done' || structured.goalStateReached !== true) {
          this.logger.warning('Watcher structured output ended without done', {
            sessionKey,
            action: structured.action,
            goalStateReached: structured.goalStateReached,
            terminationReason: result.terminationReason,
          });
        }

        switch (structured.watcherAction) {
          case 'answer':
            return {
              watcherAction: 'answer',
              reason: structured.reason,
              answer: {
                text: structured.answer.text,
                contextAddendum: structured.answer.contextAddendum ?? undefined,
              },
            };
          case 'realign':
            return {
              watcherAction: 'realign',
              reason: structured.reason,
              realign: {
                systemMessage: structured.realign.systemMessage,
                newGoal: structured.realign.newGoal ?? undefined,
              },
            };
          case 'split':
            return { watcherAction: 'split', reason: structured.reason, workItems: structured.workItems };
          case 'create_work_item':
            return { watcherAction: 'create_work_item', reason: structured.reason, workItems: structured.workItems };
          case 'stop_work_item':
            return {
              watcherAction: 'stop_work_item',
              reason: structured.reason,
              ...(structured.escalationId ? { escalationId: structured.escalationId } : {}),
            };
          case 'quality_gate':
            return { watcherAction: 'quality_gate', reason: structured.reason, qualityGate: structured.qualityGate };
          case 'allow':
            return { watcherAction: 'allow', reason: structured.reason };
          case 'continue':
            return { watcherAction: 'allow', reason: structured.reason };
        }
      }

      // Fallback: structured output missing or malformed
      this.logger.warning('Watcher agent returned invalid structured output', {
        sessionKey,
        hasStructured: !!result.structuredOutput,
        watcherAction: (result.structuredOutput as WatcherActionOutput | undefined)?.watcherAction,
        terminationReason: result.terminationReason,
        error: result.error,
      });
      return { watcherAction: 'allow', reason: result.response || result.error || 'Watcher produced no valid structured output' };
    } catch (err) {
      this.logger.error('Watcher agent execution failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionKey,
      });
      return { watcherAction: 'allow', reason: `Watcher error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private emitInternalHookAsync(event: InternalHookEvent, context: InternalHookContext): void {
    queueMicrotask(() => {
      void executeHooks(event.type, event, context).catch((err) => {
        this.logger.warning('Failed to execute internal hook', {
          sessionKey: context.sessionKey,
          eventType: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  /**
   * Create a watcher-backed hook registry for a session.
   * This is the bridge between the orchestrator control-plane hooks and the LLM-backed watcher.
   *
   * @param sessionKey - Session identifier
   * @param goal - The goal for the async session
   * @param workingDir - Agent's working directory for file operations (used for cwd in logs)
   * @param watcherDir - Directory for watcher artifacts (.watcher/), defaults to workingDir
   */
  async createWatcherHookRegistryForSession(
    sessionKey: string,
    goal: string,
    workingDir: string,
    watcherDir?: string
  ): Promise<{ hookRegistry: HookRegistry; planningObjective: string }> {
    const sessionState = this.getOrCreateSessionState(sessionKey, false, workingDir);
    // Use watcherDir for watcher artifacts, fallback to workingDir for backwards compatibility
    const effectiveWatcherDir = watcherDir ?? workingDir;

    // NOTE: Skill knowledge is baked into system prompts. No need to discover skill files.
    const saliencePath = await writeSalienceFile(effectiveWatcherDir, {
      sessionId: sessionKey,
      goal,
      mode: 'async',
    });

    const decisionLog = await createDecisionLog(effectiveWatcherDir, sessionKey);
    const workLog = await createWorkLog(effectiveWatcherDir, sessionKey);
    sessionState.workLog = workLog;

    const safeAppend = async (label: string, op: () => Promise<void>): Promise<void> => {
      try {
        await op();
      } catch (err) {
        console.warn(`[HARNESS] ${label}:`, err instanceof Error ? err.message : String(err));
      }
    };

    // Helper to get or create workitem log for this session
    const getOrCreateWorkItemLog = async (
      workId: string,
      agentType: string,
      objective?: string,
      meta?: { domain?: string; dependencies?: string[]; targetPaths?: string[] }
    ): Promise<WorkItemLog> => {
      let log = sessionState.workItemLogs.get(workId);
      if (!log) {
        // Try to get existing log first (artifacts in watcherDir)
        log = await getWorkItemLog(effectiveWatcherDir, sessionKey, workId) ?? undefined;
        if (!log) {
          // Create new log: artifact in watcherDir, cwd for path resolution in workingDir
          log = await createWorkItemLog(effectiveWatcherDir, sessionKey, {
            workId,
            objective: objective ?? 'unknown',
            agent: agentType,
            cwd: workingDir,  // All paths in this log will be relative to agent's working dir
            domain: meta?.domain,
            dependencies: meta?.dependencies,
            targetPaths: meta?.targetPaths,
          });
        }
        sessionState.workItemLogs.set(workId, log);
      }
      return log;
    };

    const getWorkItemLogSafe = async (
      label: string,
      workId: string,
      agentType: string,
      objective?: string,
      meta?: { domain?: string; dependencies?: string[]; targetPaths?: string[] }
    ): Promise<WorkItemLog | null> => {
      try {
        return await getOrCreateWorkItemLog(workId, agentType, objective, meta);
      } catch (err) {
        console.warn(`[HARNESS] WorkItem log creation failed (${label}):`, err instanceof Error ? err.message : String(err));
        return null;
      }
    };

    // Write session_start entry
    await safeAppend('Work log write failed (session_start)', () => workLog.append({
      type: 'session_start',
      timestamp: new Date().toISOString(),
      goal,
      mode: 'async',
    }));

    // Register auto-logging hooks for workitem activity
    // NOTE: Hooks are global, so we filter by sessionKey to only process this session's events
    registerHook('workitem_created', async (event: InternalHookEvent, ctx: InternalHookContext) => {
      if (event.type !== 'workitem_created') return;
      if (ctx.sessionKey !== sessionKey) return;

      if (sessionState.workItemsCreated.has(ctx.workId)) return;

      const itemLog = await getWorkItemLogSafe(
        'workitem_created',
        ctx.workId,
        event.agent ?? ctx.agentType,
        event.objective ?? ctx.objective,
        {
          domain: event.domain,
          dependencies: event.dependencies,
          targetPaths: event.targetPaths,
        }
      );

      if (itemLog) {
        sessionState.workItemsCreated.add(ctx.workId);
        await safeAppend('Work log write failed (workitem_created)', () => workLog.append({
          type: 'workitem_created',
          timestamp: new Date().toISOString(),
          workId: ctx.workId,
          objective: event.objective ?? ctx.objective ?? 'unknown',
          agent: event.agent ?? ctx.agentType,
          domain: event.domain,
          dependencies: event.dependencies,
        }));

        // Write semantic if attached (from watcher split/create)
        if (event.semantic) {
          writeSemanticFileAsync(
            {
              workingDir: effectiveWatcherDir,
              sessionId: sessionKey,
              workId: ctx.workId,
            },
            event.semantic as SemanticOutput,
            new Date().toISOString()
          );
        }
      }
    });
    registerHook('turn_completed', async (event: InternalHookEvent, ctx: InternalHookContext) => {
      if (event.type !== 'turn_completed') return;
      if (ctx.sessionKey !== sessionKey) return; // Filter by session

      // Get or create workitem log - use objective from context
      const itemLog = await getWorkItemLogSafe('turn_completed', ctx.workId, ctx.agentType, ctx.objective);

      if (itemLog) {
        // Mark as started on first turn
        if (event.iteration === 1) {
          await safeAppend('WorkItem log write failed (markStarted)', () => itemLog.markStarted());
        }
        // Note: actual message content comes via agent_message hook, not here
      }

      // Also log to session-level work log on first turn (fallback if creation hook missed)
      if (event.iteration === 1) {
        if (!sessionState.workItemsCreated.has(ctx.workId)) {
          sessionState.workItemsCreated.add(ctx.workId);
          await safeAppend('Work log write failed (workitem_created)', () => workLog.append({
            type: 'workitem_created',
            timestamp: new Date().toISOString(),
            workId: ctx.workId,
            objective: ctx.objective ?? 'unknown',
            agent: ctx.agentType,
          }));
        }
      }
    });

    // Log actual agent messages (real content + reasoning for audit trail)
    // NOTE: Uses getOrCreateWorkItemLog because agent_message fires BEFORE turn_completed
    registerHook('agent_message', async (event: InternalHookEvent, ctx: InternalHookContext) => {
      if (event.type !== 'agent_message') return;
      if (ctx.sessionKey !== sessionKey) return;

      const itemLog = await getWorkItemLogSafe('agent_message', ctx.workId, ctx.agentType, ctx.objective);
      if (itemLog) {
        await safeAppend('WorkItem log write failed (agent_message)', () => itemLog.appendMessage(
          event.role,
          event.content,
          undefined,  // watcherInjected
          event.reasoning  // Include reasoning for decision audit
        ));
      }
    });

    // Log individual tool calls with full details
    // NOTE: Uses getOrCreateWorkItemLog because tool_call_completed can fire before turn_completed
    registerHook('tool_call_completed', async (event: InternalHookEvent, ctx: InternalHookContext) => {
      if (event.type !== 'tool_call_completed') return;
      if (ctx.sessionKey !== sessionKey) return;

      const itemLog = await getWorkItemLogSafe('tool_call_completed', ctx.workId, ctx.agentType, ctx.objective);
      if (itemLog) {
        await safeAppend('WorkItem log write failed (tool_call_completed)', () => itemLog.appendToolCall(
          event.tool,
          event.args,
          event.success,
          event.resultPreview,
          event.durationMs
        ));
      }
    });

    // Log memory injections with full content for observability
    registerHook('memory_injected', async (event: InternalHookEvent, ctx: InternalHookContext) => {
      if (event.type !== 'memory_injected') return;
      if (ctx.sessionKey !== sessionKey) return;

      const itemLog = await getWorkItemLogSafe('memory_injected', ctx.workId, ctx.agentType, ctx.objective);
      if (itemLog) {
        await safeAppend('WorkItem log write failed (memory_injected)', () => itemLog.append({
          type: 'memory_injection',
          timestamp: new Date().toISOString(),
          query: event.query,
          memoryContent: event.memoryContent,
          contextWithMemory: event.contextWithMemory,
          resultPreview: event.resultPreview,
          itemCount: event.itemCount,
          success: event.success,
          iteration: event.iteration,
          version: event.version,
          latencyMs: event.latencyMs,
          coverage: event.coverage,
          discriminatorsIncluded: event.discriminatorsIncluded,
          totalTokens: event.totalTokens,
          fallbackToV1: event.fallbackToV1,
        }));
      }

      this.eventBus.publish(createEvent('memory_injected', {
        query: event.query,
        resultPreview: event.resultPreview,
        memoryContent: event.memoryContent,
        contextWithMemory: event.contextWithMemory,
        itemCount: event.itemCount,
        success: event.success,
        iteration: event.iteration,
        version: event.version,
        latencyMs: event.latencyMs,
        coverage: event.coverage,
        discriminatorsIncluded: event.discriminatorsIncluded,
        totalTokens: event.totalTokens,
        fallbackToV1: event.fallbackToV1,
      }, ctx.workId, ctx.requestId, ctx.sessionKey));
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
      await safeAppend('Work log write failed (files_modified)', () => workLog.append({
        type: 'note',
        timestamp: new Date().toISOString(),
        workId: ctx.workId,
        note: `Files modified: ${event.paths.slice(0, 5).join(', ')}${event.paths.length > 5 ? ` (+${event.paths.length - 5} more)` : ''}`,
        source: 'orchestrator',
      }));

      // Also log to workitem log
      const itemLog = await getWorkItemLogSafe('files_modified', ctx.workId, ctx.agentType, ctx.objective);
      if (itemLog) {
        await safeAppend('WorkItem log write failed (files_modified)', () => itemLog.appendToolCall(
          'Edit/Write',
          { paths: event.paths },
          true,
          `Modified: ${event.paths.join(', ')}`
        ));
      }
    });

    registerHook('agent_completed', async (event: InternalHookEvent, ctx: InternalHookContext) => {
      if (event.type !== 'agent_completed') return;
      if (ctx.sessionKey !== sessionKey) return; // Filter by session

      const workId = ctx.workId ?? event.workId ?? 'unknown';

      // Log to session-level work log
      await safeAppend('Work log write failed (agent_completed)', () => workLog.append({
        type: 'workitem_status',
        timestamp: new Date().toISOString(),
        workId,
        status: 'completed',
        filesModified: event.invalidatedPaths,
      }));

      // Mark workitem as completed
      const itemLog = await getWorkItemLogSafe('agent_completed', workId, ctx.agentType, ctx.objective);
      if (itemLog) {
        await safeAppend('WorkItem log write failed (markCompleted)', () => itemLog.markCompleted(
          event.response ?? 'Agent completed',
          event.metrics ? {
            llmCalls: event.metrics.llmCallsMade,
            toolCalls: event.metrics.toolCallsMade,
            contextPercentUsed: event.contextPercentUsed ?? 0,
            durationMs: 0, // Not available in InternalHookEvent
            filesRead: event.filesRead,
            filesModified: event.invalidatedPaths,
          } : undefined
        ));
      }
    });

    registerHook('watcher_agent_stopped', async (event: InternalHookEvent, ctx: InternalHookContext) => {
      if (event.type !== 'watcher_agent_stopped') return;
      if (ctx.sessionKey !== sessionKey) return;

      const now = Date.now();
      sessionState.store.upsertPausedWorkItem({
        workId: event.workId,
        agentType: event.agentType,
        objective: ctx.objective,
        reason: event.reason,
        escalationId: event.escalationId,
        status: 'pending',
        timestamp: now,
      });

      await safeAppend('Work log write failed (watcher_agent_stopped)', () => workLog.append({
        type: 'note',
        timestamp: new Date(now).toISOString(),
        workId: event.workId,
        note: `[watcher_stop] ${event.reason}`,
        source: 'watcher',
      }));

      if (event.escalationId && this.graphd) {
        const sessionResult = this.graphd.sessionGet(sessionKey) as { session?: { status?: string; metadata?: Record<string, unknown> } } | undefined;
        const sessionMeta = sessionResult?.session?.metadata ?? {};
        const escalations = parseSessionEscalations(sessionMeta.escalations);
        const hasPendingEscalation = escalations.some((item) => item.id === event.escalationId && item.status === 'pending');
        const previousStatus = sessionResult?.session?.status ?? 'active';

        if (hasPendingEscalation && previousStatus !== 'blocked') {
          this.graphd.sessionUpdateStatus(sessionKey, 'blocked');
          const statusEvent: InternalHookEvent = {
            type: 'session_status_changed',
            sessionKey,
            previousStatus,
            newStatus: 'blocked',
            reason: `Escalation ${event.escalationId} pending`,
            triggeringEscalationId: event.escalationId,
          };
          this.emitInternalHookAsync(statusEvent, {
            workId: event.workId,
            agentType: event.agentType,
            sessionKey,
            requestId: '',
            objective: ctx.objective,
          });
        }
      }
    });

    const watcherHooks = createWatcherControlHooks({
      sessionId: sessionKey,
      salienceFilePath: saliencePath,
      decisionLog,
      workLog,
      getWorkItemLog: async (workId: string) => {
        // First check our cache, then try to get from disk (artifacts in watcherDir)
        const cached = sessionState.workItemLogs.get(workId);
        if (cached) return cached;
        return getWorkItemLog(effectiveWatcherDir, sessionKey, workId);
      },
      workingDir: effectiveWatcherDir,
      runAgent: (objective: string, trigger: WatcherTrigger, signal?: AbortSignal) =>
        this.runWatcherAgent(objective, sessionKey, trigger, signal),
      onDecision: (entry) => {
        // Increment decision counter for memory-efficient tracking
        const engine = this.getOrCreateWatcherEngine(sessionKey);
        engine.incrementDecisionCount(sessionKey);

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
      onEscalationRaised: async (
        escalation: RaisedEscalation,
        hookContext,
        trigger
      ) => {
        const internalContext: InternalHookContext = {
          workId: escalation.workItemId ?? hookContext.workId,
          agentType: hookContext.agentType,
          sessionKey,
          requestId: '',
          objective: hookContext.objective,
        };

        const escalationEvent: InternalHookEvent = {
          type: 'escalation_raised',
          escalation,
        };
        this.emitInternalHookAsync(escalationEvent, internalContext);

        const sessionResult = this.graphd?.sessionGet(sessionKey) as { session?: { status?: string } } | undefined;
        const previousStatus = sessionResult?.session?.status ?? 'active';
        const now = Date.now();
        const createdAtIso = new Date(now).toISOString();
        const packetDraft = buildEscalationPacketMarkdown(escalation, trigger);
        const packetId = `pkt_${escalation.id}`;
        let packetSourcePath: string | undefined;
        try {
          packetSourcePath = await writeEscalationPacketFile(effectiveWatcherDir, escalation.id, packetDraft.markdown);
        } catch (error) {
          this.logger.warning('Failed to write escalation packet markdown file', {
            sessionKey,
            escalationId: escalation.id,
            error: getErrorMessage(error),
          });
        }

        const packetRecord: Record<string, unknown> = {
          packetId,
          sessionKey,
          type: 'escalation',
          createdAt: createdAtIso,
          contentMarkdown: packetDraft.markdown,
          source: 'watcher',
          escalationId: escalation.id,
          ...(escalation.workItemId ? { workItemId: escalation.workItemId } : {}),
          ...(packetDraft.evidenceIndex.length > 0 ? { evidenceIndex: packetDraft.evidenceIndex } : {}),
          ...(packetSourcePath ? { sourcePath: packetSourcePath } : {}),
        };

        const packetEvent: Record<string, unknown> = {
          type: 'packet_emitted',
          timestamp: createdAtIso,
          ...(escalation.workItemId ? { work_item_id: escalation.workItemId } : {}),
          data: {
            packetId,
            packetType: 'escalation',
            source: 'watcher',
            escalationId: escalation.id,
            requestedDecision: packetDraft.requestedDecision,
            ...(packetSourcePath ? { sourcePath: packetSourcePath } : {}),
          },
        };

        this.graphd?.sessionUpdateMetadata(sessionKey, {
          escalations: [{
            ...escalation,
            trigger,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
          }],
          packets: [packetRecord],
          agent_events: [packetEvent],
        });

        // Persist to durable storage (fire-and-forget)
        if (this.memoryClient) {
          this.memoryClient.escalations.create({
            type: escalation.escalationType,
            sessionKey: escalation.sessionKey,
            workItemId: escalation.workItemId,
            title: escalation.title,
            context: escalation.context,
            tradeoffs: escalation.tradeoffs,
            options: escalation.options,
            references: escalation.references as EscalationCreateInput['references'],
          }).catch((err) => {
            this.logger.warning('Failed to persist escalation to database', {
              sessionKey,
              escalationId: escalation.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        if (previousStatus !== 'blocked') {
          this.graphd?.sessionUpdateStatus(sessionKey, 'blocked');
          const statusEvent: InternalHookEvent = {
            type: 'session_status_changed',
            sessionKey,
            previousStatus,
            newStatus: 'blocked',
            reason: `Escalation ${escalation.id} raised`,
            triggeringEscalationId: escalation.id,
          };
          this.emitInternalHookAsync(statusEvent, internalContext);
        }

        await safeAppend('Work log write failed (escalation_raised)', () => workLog.append({
          type: 'note',
          timestamp: new Date(now).toISOString(),
          workId: escalation.workItemId ?? hookContext.workId,
          note: `[escalation] ${escalation.id} (${escalation.escalationType}) ${escalation.title}`,
          source: 'watcher',
        }));
      },
    }, sessionKey);

    const planningObjective = buildPlanningObjective(
      goal, saliencePath, decisionLog.filePath(), workLog.filePath()
    );

    const hookRegistry = createHookRegistry();
    hookRegistry.registerHooks({
      source: `watcher:${sessionKey}`,
      protocolId: getProtocolId(),
      hooks: watcherHooks,
    });

    return { hookRegistry, planningObjective };
  }

  // =========================================================================
  // Decision Watcher: Per-session database & engine
  // =========================================================================

  /**
   * Get or create a per-session DecisionDatabase, seeded with DEFAULT_DECISIONS.
   */
  getOrCreateDecisionDatabase(sessionKey: string): DecisionDatabase {
    const state = this.getOrCreateSessionState(sessionKey);
    if (!state.decisionDatabase) {
      state.decisionDatabase = new InMemoryDecisionDatabase(DEFAULT_DECISIONS);
    }
    return state.decisionDatabase;
  }

  /**
   * Get or create a per-session DecisionEngine.
   */
  private getOrCreateWatcherEngine(sessionKey: string): DecisionEngine {
    const state = this.getOrCreateSessionState(sessionKey);
    if (!state.watcherEngine) {
      const db = this.getOrCreateDecisionDatabase(sessionKey);
      state.watcherEngine = createDecisionEngine(db, createWatcherConfig());
    }
    return state.watcherEngine;
  }

  // =========================================================================
  // Watcher CLI Commands
  // =========================================================================

  watcherStatus(sessionKey: string): Record<string, unknown> {
    const engine = this.getOrCreateWatcherEngine(sessionKey);
    const state = this.sessions.get(sessionKey);
    const contextSnapshot = state?.store.getCachedContextSnapshot();

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
    const state = this.sessions.get(sessionKey);
    if (!state) {
      return { error: 'No session store found', sessionKey };
    }

    const context = state.store.getContext();

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
    return {
      sessionKey,
      decisionsMade: engine.getDecisionCount(sessionKey),
      focusTopic: engine.getFocus(),
      salienceGoal: engine.getSalienceGoal(),
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
    const state = this.sessions.get(sessionKey);
    if (!state) {
      return { error: 'No session store found' };
    }

    const context = state.store.getContext();
    const result = context.compact({
      deduplicateByPath: true,
      maxFileContentCount: 15,
      truncateOutputsTo: 3000,
    });

    state.store.persistContext();

    const engine = this.getOrCreateWatcherEngine(sessionKey);

    return {
      success: true,
      compaction: {
        itemsRemoved: result.itemsRemoved,
        bytesRecovered: result.bytesRecovered,
      },
      ledger: {
        focusTopic: engine.getFocus(),
        salienceGoal: engine.getSalienceGoal(),
        decisionsMade: engine.getDecisionCount(sessionKey),
      },
    };
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
