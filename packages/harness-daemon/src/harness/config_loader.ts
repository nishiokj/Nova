/**
 * Configuration loader for the TypeScript harness.
 *
 * Loads harness_config.json and resolves API keys from environment.
 * The config file is the SINGLE SOURCE OF TRUTH for agent configurations.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import type {
  FullHarnessConfig,
  ResolvedAgentConfig,
  ResolvedLLMConfig,
  ResolvedFallbackConfig,
  ProvidersConfigSection,
} from './config_types.js';
import {
  DEFAULT_TOOLS_CONFIG,
  DEFAULT_GRAPHD_CONFIG,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_ENABLED_TOOLS,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_HOOKS_CONFIG,
  DEFAULT_AUTH_CONFIG,
} from './config_types.js';
import {
  HarnessConfigFileSchema,
  isSupportedProvider,
  getCanonicalProvider,
  normalizeReasoningEffort,
  extractReasoningEffort,
  OPENAI_COMPAT_PROVIDERS,
  type LLMProvider,
  type AgentConfigEntry,
  type HarnessConfigFile,
} from './config_schema.js';

const DEFAULT_CONFIG_PATH = 'config/harness_config.json';
const OUTPUT_SCHEMAS_PATH = 'config/output_schemas.json';
const BEHAVIORAL_RULES_PATH = 'config/behavioral_rules.md';

/**
 * Get the package root directory from this module's location.
 * Works regardless of where the process is started from.
 *
 * In dev:  apps/harness-daemon/src/harness/config_loader.ts -> ../../../../
 * In dist: apps/harness-daemon/dist/harness/config_loader.js -> ../../../../
 */
function getPackageRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Always 4 levels up: harness/ -> (src|dist)/ -> harness-daemon/ -> apps/ -> root
  return resolve(__dirname, '..', '..', '..', '..');
}

/** Cached output schemas (loaded once) */
let cachedOutputSchemas: OutputSchemasFile | null = null;

/**
 * Structure of output_schemas.json
 */
interface OutputSchemaDefinition {
  name: string;
  strict: boolean;
  schema: Record<string, unknown>;
}

interface OutputSchemasFile {
  schemas: Record<string, OutputSchemaDefinition>;
}

// ============================================
// PATH RESOLUTION
// ============================================

/**
 * Walk up the directory tree, yielding each parent directory.
 */
function* walkParents(startDir: string): Iterable<string> {
  let dir = startDir;
  const root = '/';
  while (true) {
    yield dir;
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/**
 * Resolve the repository root by walking up from startDir looking for .git.
 * Falls back to startDir if no .git is found.
 */
export function resolveRepoRoot(startDir: string): string {
  const resolved = resolve(startDir);
  for (const dir of walkParents(resolved)) {
    const gitPath = resolve(dir, '.git');
    if (existsSync(gitPath)) {
      return dir;
    }
  }
  return resolved;
}

// ============================================
// BEHAVIORAL RULES LOADING
// ============================================

/**
 * Load behavioral rules from config/behavioral_rules.md.
 */
export function loadBehavioralRules(): string {
  // Check cwd parents first (development)
  for (const dir of walkParents(process.cwd())) {
    const path = resolve(dir, BEHAVIORAL_RULES_PATH);
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, 'utf-8');
      console.log(`[config] Loaded behavioral rules from ${path}`);
      return content;
    } catch (e) {
      console.warn(`[config] Failed to read behavioral rules from ${path}:`, e);
    }
  }

  // Check package location (fallback for global installs)
  const packagePath = resolve(getPackageRoot(), BEHAVIORAL_RULES_PATH);
  if (existsSync(packagePath)) {
    try {
      const content = readFileSync(packagePath, 'utf-8');
      console.log(`[config] Loaded behavioral rules from package: ${packagePath}`);
      return content;
    } catch (e) {
      console.warn(`[config] Failed to read behavioral rules from package ${packagePath}:`, e);
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
export function loadConfigFile(configPath?: string): LoadedConfigFile | null {
  // Helper to validate config with Zod
  const validateConfig = (content: string, path: string): HarnessConfigFile | null => {
    try {
      const json = JSON.parse(content);
      const result = HarnessConfigFileSchema.safeParse(json);
      if (!result.success) {
        const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
        console.warn(`[config] Invalid config at ${path}: ${issues}`);
        return null;
      }
      return result.data;
    } catch (e) {
      console.warn(`[config] Failed to parse JSON at ${path}:`, e);
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
        console.log(`[config] Loaded from ${explicitPath}`);
        // Config dir is parent of 'config/' directory (i.e., repo root)
        const configDir = dirname(dirname(explicitPath));
        return { config: parsed, configDir, configPath: explicitPath };
      }
    }
  }

  // 2. Walk up from cwd (development mode / local project configs)
  for (const dir of walkParents(process.cwd())) {
    const path = resolve(dir, DEFAULT_CONFIG_PATH);
    if (!existsSync(path)) continue;

    const content = readFileSync(path, 'utf-8');
    const parsed = validateConfig(content, path);
    if (parsed) {
      console.log(`[config] Loaded from ${path}`);
      // dir is the repo root (where config/ directory lives)
      return { config: parsed, configDir: dir, configPath: path };
    }
  }

  // 3. Check relative to package install location (fallback for globally installed packages)
  const packageRoot = getPackageRoot();
  const packageConfigPath = resolve(packageRoot, DEFAULT_CONFIG_PATH);
  if (existsSync(packageConfigPath)) {
    const content = readFileSync(packageConfigPath, 'utf-8');
    const parsed = validateConfig(content, packageConfigPath);
    if (parsed) {
      console.log(`[config] Loaded from package: ${packageConfigPath}`);
      return { config: parsed, configDir: packageRoot, configPath: packageConfigPath };
    }
  }

  return null;
}

// ============================================
// OUTPUT SCHEMA LOADING
// ============================================

/**
 * Load output schemas from config/output_schemas.json.
 * Schemas are cached after first load.
 */
function loadOutputSchemas(): OutputSchemasFile | null {
  if (cachedOutputSchemas) {
    return cachedOutputSchemas;
  }

  // Check cwd parents first (development)
  for (const dir of walkParents(process.cwd())) {
    const path = resolve(dir, OUTPUT_SCHEMAS_PATH);
    if (!existsSync(path)) continue;

    try {
      const content = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(content) as OutputSchemasFile;
      console.log(`[config] Loaded output schemas from ${path}`);
      cachedOutputSchemas = parsed;
      return parsed;
    } catch (e) {
      console.warn(`[config] Failed to parse output schemas ${path}:`, e);
    }
  }

  // Check package location (fallback for global installs)
  const packagePath = resolve(getPackageRoot(), OUTPUT_SCHEMAS_PATH);
  if (existsSync(packagePath)) {
    try {
      const content = readFileSync(packagePath, 'utf-8');
      const parsed = JSON.parse(content) as OutputSchemasFile;
      console.log(`[config] Loaded output schemas from package: ${packagePath}`);
      cachedOutputSchemas = parsed;
      return parsed;
    } catch (e) {
      console.warn(`[config] Failed to parse package output schemas ${packagePath}:`, e);
    }
  }

  console.warn('[config] No output_schemas.json found');
  return null;
}

/**
 * Resolve a schema reference (string) to the full schema definition.
 * If already a full schema object, returns it as-is.
 */
function resolveOutputSchema(
  schemaRef: string | { name: string; schema: Record<string, unknown>; strict?: boolean } | undefined
): { name: string; schema: Record<string, unknown>; strict?: boolean } | undefined {
  if (!schemaRef) {
    return undefined;
  }

  // Already a full schema object
  if (typeof schemaRef === 'object') {
    return schemaRef;
  }

  // String reference - look up in output_schemas.json
  const schemas = loadOutputSchemas();
  if (!schemas) {
    console.warn(`[config] Cannot resolve schema '${schemaRef}' - no output_schemas.json loaded`);
    return undefined;
  }

  const definition = schemas.schemas[schemaRef];
  if (!definition) {
    console.warn(`[config] Schema '${schemaRef}' not found in output_schemas.json`);
    return undefined;
  }

  return {
    name: definition.name,
    schema: definition.schema,
    strict: definition.strict,
  };
}

// ============================================
// API KEY RESOLUTION
// ============================================

const API_KEY_ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'openai-compat': 'OPENAI_COMPAT_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  // OpenAI-compatible providers with their own API keys
  cerebras: 'CEREBRAS_API_KEY',
  together: 'TOGETHER_API_KEY',
  groq: 'GROQ_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
};

/** Base URLs for OpenAI-compatible providers */
const OPENAI_COMPAT_BASE_URLS: Record<string, string> = {
  cerebras: 'https://api.cerebras.ai/v1',
  together: 'https://api.together.xyz/v1',
  groq: 'https://api.groq.com/openai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
};

// Note: OPENAI_COMPAT_PROVIDERS is now imported from config_schema.ts

/** Module-level providers cache (set by createConfigFromFile) */
let configProviders: ProvidersConfigSection = {};

/**
 * Set providers from config file (called during config loading).
 */
export function setConfigProviders(providers: ProvidersConfigSection): void {
  configProviders = providers;
}

/**
 * Get the current config providers.
 */
export function getConfigProviders(): ProvidersConfigSection {
  return configProviders;
}

/**
 * Resolve API key from config file or environment.
 * Config file takes precedence over environment variables.
 */
export function resolveApiKey(provider: string, providers?: ProvidersConfigSection): string {
  // Check config file providers first (passed directly or from module cache)
  const configKey = (providers ?? configProviders)[provider];
  if (configKey) {
    return configKey;
  }

  // Fall back to environment variable
  const envVar = API_KEY_ENV_MAP[provider] ?? `${provider.toUpperCase()}_API_KEY`;
  const key = process.env[envVar];
  if (!key) {
    const canonicalHint = OPENAI_COMPAT_PROVIDERS.has(provider) && provider !== 'openai-compat'
      ? ` (routes to openai-compat adapter)`
      : '';
    throw new Error(
      `API key not found for provider '${provider}'${canonicalHint}. ` +
      `Set in ~/.rex/config.json providers section or ${envVar} environment variable.`
    );
  }
  return key;
}

// Note: isSupportedProvider and getCanonicalProvider are now imported from config_schema.ts

/**
 * Get the base URL for a provider, using built-in registry for known providers.
 */
function getProviderBaseUrl(provider: string, configBaseUrl?: string): string | undefined {
  if (configBaseUrl) return configBaseUrl;
  return OPENAI_COMPAT_BASE_URLS[provider];
}

// Note: normalizeReasoningEffort is now imported from config_schema.ts

// ============================================
// AGENT CONFIG RESOLUTION
// ============================================

/**
 * Resolve fallback config if present.
 */
function resolveFallbackConfig(
  fallback: { provider: string; model: string; api_base?: string } | undefined
): ResolvedFallbackConfig | undefined {
  if (!fallback) return undefined;

  const configProvider = fallback.provider;
  if (!isSupportedProvider(configProvider)) {
    console.warn(`[config] Unsupported fallback provider: ${configProvider}, skipping fallback`);
    return undefined;
  }

  try {
    const apiKey = resolveApiKey(configProvider);
    const canonicalProvider = getCanonicalProvider(configProvider);
    const baseUrl = getProviderBaseUrl(configProvider, fallback.api_base);

    return {
      provider: canonicalProvider,
      model: fallback.model,
      apiKey,
      baseUrl,
    };
  } catch (e) {
    console.warn(`[config] Failed to resolve fallback config:`, e);
    return undefined;
  }
}

/**
 * Resolve a single agent config entry to runtime format.
 */
function resolveAgentConfig(entry: AgentConfigEntry): ResolvedAgentConfig {
  const configProvider = entry.llm.provider;

  if (!isSupportedProvider(configProvider)) {
    throw new Error(`Unsupported LLM provider: ${configProvider}`);
  }

  // Use original provider name for API key lookup (e.g., 'cerebras' -> CEREBRAS_API_KEY)
  const apiKey = resolveApiKey(configProvider);

  // Map to canonical provider for adapter routing (e.g., 'cerebras' -> 'openai-compat')
  const canonicalProvider = getCanonicalProvider(configProvider);

  // Get base URL: config > provider registry > default
  const baseUrl = getProviderBaseUrl(configProvider, entry.llm.api_base);

  const rawEffort = extractReasoningEffort(entry.llm.reasoning);
  const reasoningEffort = normalizeReasoningEffort(canonicalProvider, rawEffort);

  // Resolve fallback config if present
  const fallback = resolveFallbackConfig(entry.llm.fallback);

  const llm: ResolvedLLMConfig = {
    provider: canonicalProvider,
    model: entry.llm.model,
    apiKey,
    maxTokens: entry.llm.max_tokens,
    temperature: entry.llm.temperature,
    baseUrl,
    reasoning: { effort: reasoningEffort },
    fallback,
  };

  return {
    llm,
    budget: {
      maxIterations: entry.budget.max_iterations,
      maxToolCalls: entry.budget.max_tool_calls,
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
  const agentConfig = config.agents[agentType];
  if (agentConfig) {
    return agentConfig;
  }
  throw new Error(`Agent config not found: ${agentType}`);
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
  configPath?: string
): FullHarnessConfig {
  // Merge file providers with existing (preloaded GraphD providers take precedence)
  const existingProviders = getConfigProviders();
  const fileProviders = fileConfig.providers ?? {};
  // GraphD providers (already in cache) take precedence over config file
  const mergedProviders = { ...fileProviders, ...existingProviders };
  setConfigProviders(mergedProviders);
  // Resolve all agent configs
  const agents: Record<string, ResolvedAgentConfig> = {};
  for (const [agentType, entry] of Object.entries(fileConfig.agents)) {
    try {
      const resolved = resolveAgentConfig(entry);
      agents[agentType] = resolved;
    } catch (e) {
      console.warn(`[config] Failed to resolve agent '${agentType}':`, e);
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

  console.log(`[config] Resolved paths relative to ${configDir}:`);
  console.log(`[config]   graphd.dbPath: ${rawDbPath} -> ${resolvedDbPath}`);
  if (resolvedSkillsDir) {
    console.log(`[config]   skills.directory: ${rawSkillsDir} -> ${resolvedSkillsDir}`);
  }
  if (resolvedHooksDir) {
    console.log(`[config]   hooks.directory: ${rawHooksDir} -> ${resolvedHooksDir}`);
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
    auth: {
      enabled: fileConfig.auth?.enabled ?? DEFAULT_AUTH_CONFIG.enabled,
      host: fileConfig.auth?.host ?? DEFAULT_AUTH_CONFIG.host,
      port: fileConfig.auth?.port ?? DEFAULT_AUTH_CONFIG.port,
      sessionExpiryDays: fileConfig.auth?.session_expiry_days !== undefined
        ? fileConfig.auth.session_expiry_days
        : (DEFAULT_AUTH_CONFIG.session_expiry_days ?? null),
    },
    behavioralRules: loadBehavioralRules(),
    providers: mergedProviders,
    configPath,
  };
}

/**
 * Create config from environment variables only (fallback mode).
 */
export function createConfigFromEnv(workingDir?: string): FullHarnessConfig {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const explicitProvider = process.env.LLM_PROVIDER;

  let provider: LLMProvider;
  let apiKey: string;

  if (explicitProvider && isSupportedProvider(explicitProvider)) {
    provider = getCanonicalProvider(explicitProvider);
    apiKey = explicitProvider === 'anthropic' ? (anthropicKey ?? '') : (openaiKey ?? '');
    if (!apiKey) {
      throw new Error(
        `LLM_PROVIDER is '${provider}' but ${API_KEY_ENV_MAP[provider]} is not set.`
      );
    }
  } else if (openaiKey) {
    provider = 'openai';
    apiKey = openaiKey;
  } else if (anthropicKey) {
    provider = 'anthropic';
    apiKey = anthropicKey;
  } else {
    throw new Error(
      'No API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable.'
    );
  }

  const defaultModel = provider;

  // Create minimal agent configs from env
  const defaultLLM: ResolvedLLMConfig = {
    provider,
    model: process.env.LLM_MODEL ?? defaultModel,
    apiKey,
    maxTokens: 16000,
    temperature: 0.7,
    reasoning: { effort: 'none' },
  };

  const defaultBudget = {
    maxIterations: 10,
    maxToolCalls: 15,
    maxDurationMs: 120000,
  };

  const agents: Record<string, ResolvedAgentConfig> = {
    routing: {
      llm: { ...defaultLLM, maxTokens: 100, temperature: 0.1 },
      budget: { maxIterations: 1, maxToolCalls: 0, maxDurationMs: 3000 },
      tools: [],
    },
    simple: {
      llm: { ...defaultLLM, maxTokens: 4000, temperature: 0.5 },
      budget: { maxIterations: 3, maxToolCalls: 5, maxDurationMs: 30000 },
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
    },
    explorer: {
      llm: { ...defaultLLM, maxTokens: 8000, temperature: 0.3 },
      budget: { maxIterations: 5, maxToolCalls: 20, maxDurationMs: 60000 },
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
    },
    runtime_script: {
      llm: { ...defaultLLM, maxTokens: 16000, temperature: 0.5 },
      budget: { maxIterations: 2, maxToolCalls: 0, maxDurationMs: 30000 },
      tools: [],
    },
    standard: {
      llm: defaultLLM,
      budget: defaultBudget,
      tools: DEFAULT_ENABLED_TOOLS,
    },
    complex: {
      llm: { ...defaultLLM, maxTokens: 32000 },
      budget: { ...defaultBudget, maxIterations: 15, maxToolCalls: 25, maxDurationMs: 180000 },
      tools: DEFAULT_ENABLED_TOOLS,
    },
    debugger: {
      llm: { ...defaultLLM, maxTokens: 16000, temperature: 0.5 },
      budget: defaultBudget,
      tools: DEFAULT_ENABLED_TOOLS,
    },
    context_compactor: {
      llm: { ...defaultLLM, maxTokens: 200000, temperature: 0.3 },
      budget: { maxIterations: 2, maxToolCalls: 0, maxDurationMs: 30000 },
      tools: [],
    },
    web_crawler: {
      llm: { ...defaultLLM, maxTokens: 8000, temperature: 0.5 },
      budget: defaultBudget,
      tools: ['WebFetch', 'WebSearch'],
    },
  };

  const resolvedWorkingDir = resolve(workingDir ?? process.cwd());

  return {
    agents,
    defaultAgent: 'standard',
    tools: {
      workingDir: resolvedWorkingDir,
      repoRoot: resolveRepoRoot(resolvedWorkingDir),
      bashTimeoutMs: DEFAULT_TOOLS_CONFIG.bash_timeout_ms,
      maxOutputLength: DEFAULT_TOOLS_CONFIG.max_output_length,
    },
    graphd: {
      enabled: DEFAULT_GRAPHD_CONFIG.enabled,
      host: DEFAULT_GRAPHD_CONFIG.host,
      port: DEFAULT_GRAPHD_CONFIG.port,
      dbPath: DEFAULT_GRAPHD_CONFIG.db_path,
    },
    context: {
      maxTokens: DEFAULT_CONTEXT_CONFIG.max_tokens,
    },
    skills: {
      enabled: DEFAULT_SKILLS_CONFIG.enabled,
      directory: DEFAULT_SKILLS_CONFIG.directory,
      definitions: [],
    },
    hooks: {
      enabled: DEFAULT_HOOKS_CONFIG.enabled,
      directory: DEFAULT_HOOKS_CONFIG.directory,
      definitions: [],
    },
    auth: {
      enabled: DEFAULT_AUTH_CONFIG.enabled,
      host: DEFAULT_AUTH_CONFIG.host,
      port: DEFAULT_AUTH_CONFIG.port,
      sessionExpiryDays: DEFAULT_AUTH_CONFIG.session_expiry_days ?? null,
    },
    behavioralRules: loadBehavioralRules(),
    providers: {},
    configPath: undefined,
  };
}

// ============================================
// MAIN ENTRY POINT
// ============================================

/**
 * Load full config: try file first, fallback to env-only.
 *
 * Path resolution is BULLETPROOF:
 * - All relative paths in config are resolved relative to where the config file was found
 * - This works correctly regardless of process.cwd() or where the harness is started from
 * - workingDir only affects tool execution context, not path resolution
 */
export function loadConfig(
  configPath?: string,
  workingDir?: string
): FullHarnessConfig {
  const loaded = loadConfigFile(configPath);

  if (loaded) {
    // configDir is where the config file was found (repo root)
    // All relative paths in config will be resolved relative to this
    const { config: fileConfig, configDir, configPath: loadedConfigPath } = loaded;
    const result = createConfigFromFile(fileConfig, configDir, workingDir, loadedConfigPath);
    return result;
  }

  const result = createConfigFromEnv(workingDir);
  return result;
}
