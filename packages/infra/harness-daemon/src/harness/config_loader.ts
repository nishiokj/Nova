/**
 * Configuration loader for the TypeScript harness.
 *
 * Loads harness_config.json and resolves API keys from environment.
 * The config file is the SINGLE SOURCE OF TRUTH for agent configurations.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import {
  HarnessConfigFileSchema,
  normalizeReasoningEffort,
  extractReasoningEffort,
  DEFAULT_TOOLS_CONFIG,
  DEFAULT_GRAPHD_CONFIG,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_HOOKS_CONFIG,
  DEFAULT_ENTITY_GRAPH_CONFIG,
  DEFAULT_AUTH_CONFIG,
  DEFAULT_MODELS_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  type FullHarnessConfig,
  type ResolvedAgentConfig,
  type ResolvedLLMConfig,
  type ResolvedFallbackConfig,
  type AgentConfigEntry,
  type HarnessConfigFile,
} from './config.js';

import {
  isSupportedProvider,
  getCanonicalProvider,
  getProviderBaseUrl as getCentralProviderBaseUrl,
  PROVIDER_MODEL_DEFAULTS,
  getAllModels,
  getProviderForModel,
  getModelDefinition,
  type ModelRole,
} from 'types';
import { getOutputSchemaJson, OUTPUT_SCHEMAS, type OutputSchemaName } from 'shared';
import { stderrLogger, type HarnessLogger } from './harness_infra.js';

const DEFAULT_CONFIG_PATH = 'config/defaults.json';
const USER_CONFIG_PATH = '~/.nova/config.json';
const BEHAVIORAL_RULES_PATH = 'config/behavioral_rules.md';

/** Module-level logger, overridden when callers pass a logger */
let _log: HarnessLogger = stderrLogger;

function walkUpForRelativePath(startDir: string, relativePath: string): string | null {
  let currentDir = resolve(startDir);

  while (true) {
    const candidate = resolve(currentDir, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function getBundledAssetSearchDirs(): string[] {
  const searchDirs = new Set<string>();
  const moduleDir = dirname(fileURLToPath(import.meta.url));

  searchDirs.add(moduleDir);

  if (process.argv[1]) {
    searchDirs.add(dirname(resolve(process.argv[1])));
  }

  if (process.execPath) {
    searchDirs.add(dirname(process.execPath));
  }

  return [...searchDirs];
}

/**
 * Resolve a bundled asset that ships with the installation.
 *
 * This intentionally searches upward from the installed module/executable
 * location instead of assuming a fixed repo depth. That keeps dev, npm, and
 * packaged layouts working without hardcoded ".." counts.
 */
export function resolveBundledAssetPath(relativePath: string, startDirs = getBundledAssetSearchDirs()): string | null {
  for (const startDir of startDirs) {
    const assetPath = walkUpForRelativePath(startDir, relativePath);
    if (assetPath) {
      return assetPath;
    }
  }

  return null;
}

// ============================================
// PATH RESOLUTION
// ============================================

/**
 * Resolve the repository root - uses cwd directly without walking.
 */
export function resolveRepoRoot(startDir: string): string {
  return resolve(startDir);
}

// ============================================
// BEHAVIORAL RULES LOADING
// ============================================

/**
 * Load behavioral rules from config/behavioral_rules.md.
 */
export function loadBehavioralRules(logger: HarnessLogger = stderrLogger): string {
  // Check cwd first
  const cwdPath = resolve(process.cwd(), BEHAVIORAL_RULES_PATH);
  if (existsSync(cwdPath)) {
    try {
      const content = readFileSync(cwdPath, 'utf-8');
      logger.info(`[config] Loaded behavioral rules from ${cwdPath}`);
      return content;
    } catch (e) {
      logger.warning(`[config] Failed to read behavioral rules from ${cwdPath}: ${String(e)}`);
    }
  }

  // Check bundled install location
  const bundledPath = resolveBundledAssetPath(BEHAVIORAL_RULES_PATH);
  if (bundledPath && existsSync(bundledPath)) {
    try {
      const content = readFileSync(bundledPath, 'utf-8');
      logger.info(`[config] Loaded behavioral rules from bundle: ${bundledPath}`);
      return content;
    } catch (e) {
      logger.warning(`[config] Failed to read behavioral rules from bundle ${bundledPath}: ${String(e)}`);
    }
  }

  return '';
}

// ============================================
// CONFIG FILE LOADING
// ============================================

/**
 * Result of loading a config file - includes the directory where it was found.
 * This is critical for resolving relative paths consistently.
 */
interface LoadedConfigFile {
  config: HarnessConfigFile;
  /** Directory where config file was found (repo root) - use this for resolving relative paths */
  configDir: string;
  /** Full path to the config file */
  configPath: string;
}

/**
 * Load config file from disk.
 * Returns both the config and the directory where it was found.
 * Relative paths in the config should be resolved relative to configDir.
 */
export function loadConfigFile(configPath?: string, logger: HarnessLogger = stderrLogger): LoadedConfigFile | null {
  const resolveConfigDirForPath = (path: string): string => {
    const parent = dirname(path);
    return basename(parent) === 'config' ? dirname(parent) : parent;
  };

  // Helper to validate config with Zod
  const validateConfig = (content: string, path: string): HarnessConfigFile | null => {
    try {
      const json: unknown = JSON.parse(content);
      const result = HarnessConfigFileSchema.safeParse(json);
      if (!result.success) {
        const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
        logger.warning(`[config] Invalid config at ${path}: ${issues}`);
        return null;
      }
      if (Object.keys(result.data.agents).length === 0) {
        logger.warning(`[config] Config at ${path} has no agents; ignoring and falling back`);
        return null;
      }
      return result.data;
    } catch (e) {
      logger.warning(`[config] Failed to parse JSON at ${path}: ${String(e)}`);
      return null;
    }
  };

  // 1. Check explicit path if provided (highest priority)
  if (configPath) {
    const explicitPath = resolve(configPath);
    if (existsSync(explicitPath)) {
      const content = readFileSync(explicitPath, 'utf-8');
      const parsed = validateConfig(content, explicitPath);
      if (parsed) {
        logger.info(`[config] Loaded from ${explicitPath}`);
        const configDir = resolveConfigDirForPath(explicitPath);
        return { config: parsed, configDir, configPath: explicitPath };
      }
    }
  }

  // 2. Check cwd + /config/harness_config.json
  const cwdPath = resolve(process.cwd(), DEFAULT_CONFIG_PATH);
  if (existsSync(cwdPath)) {
    const content = readFileSync(cwdPath, 'utf-8');
    const parsed = validateConfig(content, cwdPath);
    if (parsed) {
      logger.info(`[config] Loaded from ${cwdPath}`);
      return { config: parsed, configDir: process.cwd(), configPath: cwdPath };
    }
  }

  // 3. Check user config (~/.nova/config.json)
  const userPath = expandHome(USER_CONFIG_PATH);
  if (existsSync(userPath)) {
    const content = readFileSync(userPath, 'utf-8');
    const parsed = validateConfig(content, userPath);
    if (parsed) {
      logger.info(`[config] Loaded user config from ${userPath}`);
      return { config: parsed, configDir: dirname(userPath), configPath: userPath };
    }
  }

  // 4. Check bundled install location
  const bundledConfigPath = resolveBundledAssetPath(DEFAULT_CONFIG_PATH);
  if (bundledConfigPath && existsSync(bundledConfigPath)) {
    const content = readFileSync(bundledConfigPath, 'utf-8');
    const parsed = validateConfig(content, bundledConfigPath);
    if (parsed) {
      logger.info(`[config] Loaded from bundle: ${bundledConfigPath}`);
      return {
        config: parsed,
        configDir: dirname(dirname(bundledConfigPath)),
        configPath: bundledConfigPath,
      };
    }
  }

  return null;
}

/**
 * Resolve a schema reference (string) to the full schema definition.
 * If already a full schema object, returns it as-is.
 */
function resolveOutputSchema(
  schemaRef: string | { name: string; schema: Record<string, unknown>; strict?: boolean; schemaId?: string } | undefined
): { name: string; schema: Record<string, unknown>; strict?: boolean; schemaId?: string } | undefined {
  if (!schemaRef) {
    return undefined;
  }

  const normalizeSchemaName = (raw: string): OutputSchemaName | null => {
    const normalized = raw.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(OUTPUT_SCHEMAS, normalized)) {
      return normalized as OutputSchemaName;
    }
    if (normalized.endsWith('_output')) {
      const candidate = normalized.slice(0, -7);
      if (Object.prototype.hasOwnProperty.call(OUTPUT_SCHEMAS, candidate)) {
        return candidate as OutputSchemaName;
      }
    }
    return null;
  };

  // Already a full schema object
  if (typeof schemaRef === 'object') {
    const schemaValue = (schemaRef as { schema?: unknown }).schema;
    const hasValidSchema = !!schemaValue && typeof schemaValue === 'object' && !Array.isArray(schemaValue);
    if (hasValidSchema) {
      return schemaRef;
    }

    const rawName = typeof schemaRef.schemaId === 'string'
      ? schemaRef.schemaId
      : typeof schemaRef.name === 'string'
        ? schemaRef.name
        : '';
    const resolvedName = rawName ? normalizeSchemaName(rawName) : null;
    if (resolvedName) {
      const definition = getOutputSchemaJson(resolvedName);
      if (definition) {
        return {
          ...definition,
          strict: schemaRef.strict ?? definition.strict,
        };
      }
    }

    _log.warning('[config] Output schema object missing valid schema; ignoring structured output');
    return undefined;
  }

  // String reference - look up in Zod registry (source of truth)
  const resolvedName = normalizeSchemaName(schemaRef);
  const definition = resolvedName ? getOutputSchemaJson(resolvedName) : undefined;
  if (!definition) {
    _log.warning(`[config] Schema '${schemaRef}' not found in output schema registry`);
    return undefined;
  }

  return definition;
}

/**
 * Get the base URL for a provider, using central registry for known providers.
 */
function getProviderBaseUrl(provider: string, configBaseUrl?: string): string | undefined {
  if (configBaseUrl) return configBaseUrl;
  return getCentralProviderBaseUrl(provider);
}

// ============================================
// AGENT CONFIG RESOLUTION
// ============================================

/**
 * Resolve fallback config if present.
 * NO API KEY resolution - credentials are resolved at request time.
 */
function resolveFallbackConfig(
  fallback: { provider?: string; model: string; api_base?: string } | undefined
): ResolvedFallbackConfig | undefined {
  if (!fallback) return undefined;

  const modelProvider = getProviderForModel(fallback.model);
  let configProvider = fallback.provider ?? modelProvider;
  if (modelProvider && fallback.provider && fallback.provider !== modelProvider) {
    _log.warning(
      `[config] Fallback model '${fallback.model}' is registered under provider ` +
      `'${modelProvider}', ignoring provider '${fallback.provider}'.`
    );
    configProvider = modelProvider;
  }
  if (!configProvider) {
    _log.warning(`[config] Fallback missing provider and model '${fallback.model}' is not registered`);
    return undefined;
  }
  if (!isSupportedProvider(configProvider)) {
    _log.warning(`[config] Unsupported fallback provider: ${configProvider}, skipping fallback`);
    return undefined;
  }

  const canonicalProvider = getCanonicalProvider(configProvider);
  const baseUrl = getProviderBaseUrl(configProvider, fallback.api_base);

  return {
    provider: canonicalProvider,
    model: fallback.model,
    baseUrl,
  };
}

/**
 * Resolve a model for a given role.
 * Returns the first matching provider/model from provider priority order.
 * NO API KEY check - we don't care if the key exists at config time.
 * The user may add the key later at runtime.
 */
function resolveModelForRole(
  role: ModelRole,
  providerHint?: string
): { provider: string; model: string } | null {
  // Default provider priority order for role-based resolution.
  // Prefer providers that match our headless/runtime flows before falling back
  // to Anthropic, and make sure codex is actually considered.
  const DEFAULT_PROVIDER_PRIORITY: string[] = [
    'codex',
    'openai',
    'z.ai-coder',
    'anthropic',
    'groq',
    'cerebras',
    'gemini',
    'openai-compat',
    'vercel-gateway',
  ];

  const providerOrder = providerHint ? [providerHint] : DEFAULT_PROVIDER_PRIORITY;

  for (const provider of providerOrder) {
    if (!isSupportedProvider(provider)) continue;
    const model = PROVIDER_MODEL_DEFAULTS[provider]?.[role];
    if (model) {
      return { provider, model };
    }
  }

  return null;
}

/**
 * Resolve a single agent config entry to runtime format.
 * NO API KEY resolution - credentials are resolved at request time.
 * This allows the harness to start without any configured providers.
 */
function resolveAgentConfig(
  agentType: string,
  entry: AgentConfigEntry,
  defaultModelId?: string
): ResolvedAgentConfig {
  const normalizeConfigValue = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed.toLowerCase() : undefined;
  };

  let resolvedProvider = entry.llm.provider;
  let resolvedModel = entry.llm.model;

  if (!resolvedModel) {
    // Try role-based resolution first - finds a model from provider priority order
    if (entry.llm.role) {
      const roleResolution = resolveModelForRole(entry.llm.role, entry.llm.provider);
      if (roleResolution) {
        resolvedModel = roleResolution.model;
        resolvedProvider = roleResolution.provider;
      }
    }
    // Fall back to default model if role resolution failed
    if (!resolvedModel && defaultModelId && defaultModelId.trim().length > 0) {
      resolvedModel = defaultModelId;
    }
    // Error if we still don't have a model - this is a config error, not a runtime issue
    if (!resolvedModel) {
      if (!entry.llm.role) {
        throw new Error(`Agent '${agentType}' missing both model and role`);
      }
      throw new Error(
        `No model found for role '${entry.llm.role}'. ` +
        `Add a provider that supports this role to provider_priority, ` +
        `or set agents.${agentType}.llm.model explicitly.`
      );
    }
  }

  const normalizedResolvedModel = normalizeConfigValue(resolvedModel);
  const normalizedResolvedProvider = normalizeConfigValue(resolvedProvider);
  const modelDefinition = getAllModels().find((entry) =>
    normalizeConfigValue(entry.id) === normalizedResolvedModel
    && (!normalizedResolvedProvider || normalizeConfigValue(entry.provider) === normalizedResolvedProvider)
  ) ?? getModelDefinition(resolvedModel);
  if (!modelDefinition) {
    throw new Error(`Model '${resolvedModel}' is not registered`);
  }
  if (!modelDefinition.context_window || !Number.isFinite(modelDefinition.context_window)) {
    throw new Error(`Model '${resolvedModel}' is missing a context window definition`);
  }
  const modelProvider = modelDefinition.provider;
  let configProvider = resolvedProvider ?? modelProvider;
  if (resolvedProvider && resolvedProvider !== modelProvider) {
    _log.warning(
      `[config] Agent '${agentType}' model '${resolvedModel}' is registered under provider ` +
      `'${modelProvider}', ignoring provider '${resolvedProvider}'.`
    );
    configProvider = modelProvider;
  }
  if (!configProvider) {
    throw new Error(`Provider missing for model '${resolvedModel}' (not registered)`);
  }
  if (!isSupportedProvider(configProvider)) {
    throw new Error(`Unsupported LLM provider: ${configProvider}`);
  }

  // Map to canonical provider for adapter routing (e.g., 'cerebras' -> 'openai-compat')
  const canonicalProvider = getCanonicalProvider(configProvider);

  // Get base URL: config > provider registry > default
  const baseUrl = getProviderBaseUrl(configProvider, entry.llm.api_base);

  const rawEffort = extractReasoningEffort(entry.llm.reasoning);
  const reasoningEffort = normalizeReasoningEffort(canonicalProvider, rawEffort);

  // Resolve fallback config if present (also without API keys)
  const fallback = resolveFallbackConfig(entry.llm.fallback);

  const llm: ResolvedLLMConfig = {
    provider: canonicalProvider,
    displayProvider: configProvider,  // Original provider name for error messages
    model: resolvedModel,
    maxTokens: entry.llm.max_tokens,
    contextWindow: Math.trunc(modelDefinition.context_window),
    temperature: entry.llm.temperature,
    baseUrl,
    reasoning: { effort: reasoningEffort },
    fallback,
  };

  // Convention: max_tool_calls = 0 disables tool-call bound checks (effectively unbounded).
  const maxToolCalls = entry.budget.max_tool_calls === 0
    ? Number.MAX_SAFE_INTEGER
    : entry.budget.max_tool_calls;

  return {
    llm,
    budget: {
      maxIterations: entry.budget.max_iterations,
      maxToolCalls,
      maxDurationMs: entry.budget.max_duration_ms,
    },
    tools: entry.tools ?? [],
    outputSchema: resolveOutputSchema(entry.output_schema),
  };
}

/**
 * Get resolved config for a specific agent type.
 * Falls back to 'standard' if agent not found.
 */
export function getAgentConfig(
  config: FullHarnessConfig,
  agentType: string
): ResolvedAgentConfig {
  if (!(agentType in config.agents)) {
    throw new Error(`Agent config not found: ${agentType}`);
  }
  return config.agents[agentType];
}

// ============================================
// PATH RESOLUTION HELPERS
// ============================================

/**
 * Expand ~ to user home directory.
 */
function expandHome(pathStr: string): string {
  if (pathStr.startsWith('~/')) {
    return pathStr.replace('~', homedir());
  }
  if (pathStr === '~') {
    return homedir();
  }
  return pathStr;
}

function parseBooleanEnv(name: string): boolean | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string') return undefined;

  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

/**
 * Resolve a path relative to a base directory.
 * - Paths starting with ~ are expanded to home directory
 * - Absolute paths are returned as-is
 * - Relative paths are resolved relative to basePath
 * This ensures consistent path resolution regardless of process.cwd().
 */
function resolvePathRelativeTo(basePath: string, relativePath: string): string {
  if (!relativePath) return relativePath;
  // Expand ~ to home directory
  const expanded = expandHome(relativePath);
  // If absolute (including expanded home paths), return as-is
  if (expanded.startsWith('/')) return expanded;
  return resolve(basePath, expanded);
}


// ============================================
// CONFIG CREATION
// ============================================

/**
 * Create FullHarnessConfig from file config.
 *
 * IMPORTANT: configDir is where the config file was found (repo root).
 * All relative paths in the config are resolved relative to configDir,
 * NOT relative to process.cwd(). This ensures consistent behavior
 * regardless of where the harness is started from.
 */
export function createConfigFromFile(
  fileConfig: HarnessConfigFile,
  configDir: string,
  workingDir?: string,
  configPath?: string,
  logger: HarnessLogger = stderrLogger
): FullHarnessConfig {
  _log = logger;
  if ((fileConfig.models?.available ?? []).length > 0) {
    logger.warning('[config] models.available is now derived from provider registry; config list is ignored');
  }

  // Resolve all agent configs
  const agents: Record<string, ResolvedAgentConfig> = {};
  for (const [agentType, entry] of Object.entries(fileConfig.agents)) {
    try {
      const resolved = resolveAgentConfig(agentType, entry, fileConfig.models?.default ?? undefined);
      agents[agentType] = resolved;
    } catch (e) {
      _log.warning(`[config] Failed to resolve agent '${agentType}': ${String(e)}`);
    }
  }

  if (Object.keys(agents).length === 0) {
    throw new Error('No valid agent configs found in config file');
  }

  // workingDir can be overridden (e.g., for tool execution context)
  // but defaults to configDir (repo root) for consistency
  const resolvedWorkingDir = resolve(workingDir ?? configDir);

  // Resolve all relative paths in config relative to configDir (repo root)
  // This is the KEY fix - paths are deterministic regardless of cwd
  const rawDbPath = fileConfig.graphd?.db_path ?? DEFAULT_GRAPHD_CONFIG.db_path;
  const resolvedDbPath = resolvePathRelativeTo(configDir, rawDbPath);

  const rawSkillsDir = fileConfig.skills?.directory;
  const resolvedSkillsDir = rawSkillsDir
    ? resolvePathRelativeTo(configDir, rawSkillsDir)
    : undefined;

  const rawHooksDir = fileConfig.hooks?.directory;
  const resolvedHooksDir = rawHooksDir
    ? resolvePathRelativeTo(configDir, rawHooksDir)
    : undefined;

  logger.info(`[config] Resolved paths relative to ${configDir}:`);
  logger.info(`[config]   graphd.dbPath: ${rawDbPath} -> ${resolvedDbPath}`);
  if (resolvedSkillsDir) {
    logger.info(`[config]   skills.directory: ${rawSkillsDir} -> ${resolvedSkillsDir}`);
  }
  if (resolvedHooksDir) {
    logger.info(`[config]   hooks.directory: ${rawHooksDir} -> ${resolvedHooksDir}`);
  }

  const envEntityGraphEnabled = parseBooleanEnv('NOVA_ENTITY_GRAPH_ENABLED');
  const envEntityGraphStartupScan = parseBooleanEnv('NOVA_ENTITY_GRAPH_STARTUP_SCAN');
  const entityGraphEnabled = envEntityGraphEnabled ?? (fileConfig.entity_graph?.enabled ?? DEFAULT_ENTITY_GRAPH_CONFIG.enabled);
  const entityGraphStartupScan = envEntityGraphStartupScan ?? (fileConfig.entity_graph?.startup_scan ?? DEFAULT_ENTITY_GRAPH_CONFIG.startup_scan ?? true);

  if (envEntityGraphEnabled !== undefined) {
    logger.info(`[config]   entity_graph.enabled overridden by NOVA_ENTITY_GRAPH_ENABLED=${entityGraphEnabled}`);
  }
  if (envEntityGraphStartupScan !== undefined) {
    logger.info(`[config]   entity_graph.startup_scan overridden by NOVA_ENTITY_GRAPH_STARTUP_SCAN=${entityGraphStartupScan}`);
  }

  return {
    agents,
    defaultAgent: 'standard',
    tools: {
      workingDir: resolvedWorkingDir,
      repoRoot: configDir, // configDir IS the repo root (where config/ lives)
      bashTimeoutMs: fileConfig.tools?.bash_timeout_ms ?? DEFAULT_TOOLS_CONFIG.bash_timeout_ms,
      maxOutputLength: fileConfig.tools?.max_output_length ?? DEFAULT_TOOLS_CONFIG.max_output_length,
    },
    graphd: {
      enabled: fileConfig.graphd?.enabled ?? DEFAULT_GRAPHD_CONFIG.enabled,
      host: fileConfig.graphd?.host ?? DEFAULT_GRAPHD_CONFIG.host,
      port: fileConfig.graphd?.port ?? DEFAULT_GRAPHD_CONFIG.port,
      dbPath: resolvedDbPath, // NOW AN ABSOLUTE PATH
    },
    context: {
      maxTokens: fileConfig.context?.max_tokens ?? DEFAULT_CONTEXT_CONFIG.max_tokens,
      sessionTtlMs: fileConfig.context?.session_ttl_ms ?? (DEFAULT_CONTEXT_CONFIG.session_ttl_ms ?? 0),
      maxSessions: fileConfig.context?.max_sessions ?? (DEFAULT_CONTEXT_CONFIG.max_sessions ?? 50),
    },
    skills: {
      enabled: fileConfig.skills?.enabled ?? DEFAULT_SKILLS_CONFIG.enabled,
      directory: resolvedSkillsDir, // NOW AN ABSOLUTE PATH (if set)
      definitions: fileConfig.skills?.definitions ?? [],
    },
    hooks: {
      enabled: fileConfig.hooks?.enabled ?? DEFAULT_HOOKS_CONFIG.enabled,
      directory: resolvedHooksDir, // NOW AN ABSOLUTE PATH (if set)
      definitions: fileConfig.hooks?.definitions ?? [],
    },
    entityGraph: {
      enabled: entityGraphEnabled,
      databaseUrl: fileConfig.entity_graph?.database_url,
      include: fileConfig.entity_graph?.include,
      exclude: fileConfig.entity_graph?.exclude,
      leaseDurationSec: fileConfig.entity_graph?.lease_duration_sec ?? DEFAULT_ENTITY_GRAPH_CONFIG.lease_duration_sec ?? 30,
      startupScan: entityGraphStartupScan,
      leaseWaitTimeoutMs: fileConfig.entity_graph?.lease_wait_timeout_ms ?? DEFAULT_ENTITY_GRAPH_CONFIG.lease_wait_timeout_ms ?? 10_000,
    },
    auth: {
      enabled: fileConfig.auth?.enabled ?? DEFAULT_AUTH_CONFIG.enabled,
      host: fileConfig.auth?.host ?? DEFAULT_AUTH_CONFIG.host,
      port: fileConfig.auth?.port ?? DEFAULT_AUTH_CONFIG.port,
      sessionExpiryDays: fileConfig.auth?.session_expiry_days !== undefined
        ? fileConfig.auth.session_expiry_days
        : (DEFAULT_AUTH_CONFIG.session_expiry_days ?? null),
    },
    behavioralRules: loadBehavioralRules(logger),
    models: {
      available: getAllModels(),
      default: fileConfig.models?.default ?? DEFAULT_MODELS_CONFIG.default,
    },
    memory: {
      enabled: fileConfig.memory?.enabled ?? DEFAULT_MEMORY_CONFIG.enabled,
      baseUrl: fileConfig.memory?.base_url ?? DEFAULT_MEMORY_CONFIG.base_url ?? 'http://localhost:3001',
      timeoutMs: fileConfig.memory?.timeout_ms ?? DEFAULT_MEMORY_CONFIG.timeout_ms ?? 5000,
    },
    configPath,
    dangerousMode: false, // Set at runtime via CLI flag
  };
}

// ============================================
// MAIN ENTRY POINT
// ============================================

/**
 * Load config from first available location (no merging).
 *
 * Search order:
 * 1. Explicit configPath (if provided)
 * 2. cwd/config/defaults.json (project config)
 * 3. ~/.nova/config.json (user fallback)
 * 4. Bundled install config
 *
 * Each config must be complete and valid. No partial configs or merging.
 * User preferences (model selection, etc.) are handled at runtime via SessionStore/GraphD.
 */
export function loadConfig(
  configPath?: string,
  workingDir?: string,
  logger: HarnessLogger = stderrLogger
): FullHarnessConfig {
  const loaded = loadConfigFile(configPath, logger);

  if (!loaded) {
    throw new Error(
      'No configuration file found. Please create one of the following:\n' +
      '  - <project>/config/defaults.json (project config)\n' +
      '  - ~/.nova/config.json (user config)\n' +
      'Or specify an explicit config path via the --config option.'
    );
  }

  // configDir is where the config file was found (repo root)
  // All relative paths in config will be resolved relative to this
  const { config: fileConfig, configDir, configPath: loadedConfigPath } = loaded;
  return createConfigFromFile(fileConfig, configDir, workingDir, loadedConfigPath, logger);
}
