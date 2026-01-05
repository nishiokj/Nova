/**
 * Configuration loader for the TypeScript harness.
 *
 * Loads harness_config.json with environment variable overrides.
 * Falls back to env-only mode if config file not found.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import type {
  Tier,
  LLMProvider,
  TieredLLMConfig,
  HarnessConfigFile,
  FullHarnessConfig,
  ResolvedLLMConfig,
} from './config_types.js';
import {
  DEFAULT_TIER_TOOL_LIMITS,
  DEFAULT_TIER_MAX_TOKENS,
  DEFAULT_ENABLED_TOOLS,
  DEFAULT_GRAPHD_CONFIG,
} from './config_types.js';

const DEFAULT_CONFIG_PATH = 'config/harness_config.json';
const BEHAVIORAL_RULES_PATH = 'config/behavioral_rules.md';

// ============================================
// PATH RESOLUTION
// ============================================

/**
 * Find project root by looking for config/harness_config.json.
 * This is the canonical marker for the project root.
 */
function findProjectRoot(startDir: string): string {
  let dir = startDir;
  const root = '/';
  while (dir !== root) {
    // Look for the actual config file, not just any package.json
    if (existsSync(resolve(dir, DEFAULT_CONFIG_PATH))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

// ============================================
// BEHAVIORAL RULES LOADING
// ============================================

/**
 * Load behavioral rules from config/behavioral_rules.md.
 * Returns empty string if file not found.
 */
export function loadBehavioralRules(): string {
  const paths: string[] = [];

  // Try relative to cwd
  paths.push(resolve(process.cwd(), BEHAVIORAL_RULES_PATH));

  // Try relative to project root
  const projectRoot = findProjectRoot(process.cwd());
  if (projectRoot !== process.cwd()) {
    paths.push(resolve(projectRoot, BEHAVIORAL_RULES_PATH));
  }

  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8');
        console.log(`[config] Loaded behavioral rules from ${path}`);
        return content;
      } catch (e) {
        console.warn(`[config] Failed to read behavioral rules from ${path}:`, e);
      }
    }
  }

  console.log('[config] No behavioral_rules.md found, using empty rules');
  return '';
}

// ============================================
// CONFIG FILE LOADING
// ============================================

/**
 * Load config file from disk.
 * Tries multiple paths: explicit path, cwd/config/, projectRoot/config/.
 */
export function loadConfigFile(configPath?: string): HarnessConfigFile | null {
  const paths: string[] = [];

  if (configPath) {
    paths.push(resolve(configPath));
  }

  // Try relative to cwd
  paths.push(resolve(process.cwd(), DEFAULT_CONFIG_PATH));

  // Try relative to project root
  const projectRoot = findProjectRoot(process.cwd());
  if (projectRoot !== process.cwd()) {
    paths.push(resolve(projectRoot, DEFAULT_CONFIG_PATH));
  }

  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8');
        const parsed = JSON.parse(content) as HarnessConfigFile;
        console.log(`[config] Loaded from ${path}`);
        return parsed;
      } catch (e) {
        console.warn(`[config] Failed to parse ${path}:`, e);
      }
    }
  }

  return null;
}

// ============================================
// API KEY RESOLUTION
// ============================================

/**
 * Map of provider to environment variable name.
 */
const API_KEY_ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
};

/**
 * Resolve API key from environment based on provider.
 */
export function resolveApiKey(provider: string): string {
  const envVar = API_KEY_ENV_MAP[provider] ?? `${provider.toUpperCase()}_API_KEY`;
  const key = process.env[envVar];
  if (!key) {
    throw new Error(
      `API key not found for provider '${provider}'. Set ${envVar} environment variable.`
    );
  }
  return key;
}

/**
 * Check if a provider is supported (has adapter).
 */
function isSupportedProvider(provider: string): provider is LLMProvider {
  return provider === 'anthropic' || provider === 'openai';
}

// ============================================
// TIER-BASED CONFIG SELECTION
// ============================================

/**
 * Select LLM config for a given tier from llm_configs.
 * Falls back to 'standard' tier if requested tier not found.
 */
function selectTierConfig(
  llmConfigs: Record<string, TieredLLMConfig>,
  tier: Tier
): TieredLLMConfig {
  const config = llmConfigs[tier];
  if (config) return config;

  // Fallback to standard
  const standard = llmConfigs['standard'];
  if (standard) return standard;

  // Final fallback
  return {
    provider: 'openai',
    model: 'gpt-4o',
    max_tokens: 16000,
  };
}

/**
 * Get LLM config for a specific tier from a loaded config.
 * Resolves API key and filters to supported providers only.
 */
export function getLLMConfigForTier(
  config: FullHarnessConfig,
  tier: Tier
): ResolvedLLMConfig {
  const tierConfig = config.llmConfigs[tier];

  if (!tierConfig || !isSupportedProvider(tierConfig.provider)) {
    // Use current resolved config
    return config.llm;
  }

  return {
    provider: tierConfig.provider as LLMProvider,
    model: tierConfig.model,
    apiKey: resolveApiKey(tierConfig.provider),
    maxTokens: config.agent.tierMaxTokens[tier] ?? tierConfig.max_tokens,
    temperature: tierConfig.temperature,
    baseUrl: tierConfig.api_base,
  };
}

// ============================================
// CONFIG CREATION
// ============================================

/**
 * Create FullHarnessConfig from file config with environment overrides.
 */
export function createConfigFromFile(
  fileConfig: HarnessConfigFile,
  tier: Tier = 'standard',
  workingDir?: string
): FullHarnessConfig {
  // Select tier config, filtering to supported providers
  let tierConfig = selectTierConfig(fileConfig.llm_configs, tier);

  // If selected tier's provider is not supported, try to find a supported one
  if (!isSupportedProvider(tierConfig.provider)) {
    // Try standard tier
    const standardConfig = fileConfig.llm_configs['standard'];
    if (standardConfig && isSupportedProvider(standardConfig.provider)) {
      tierConfig = standardConfig;
    } else {
      // Find any supported provider
      for (const [, cfg] of Object.entries(fileConfig.llm_configs)) {
        if (isSupportedProvider(cfg.provider)) {
          tierConfig = cfg;
          break;
        }
      }
    }
  }

  // Apply environment overrides
  const envProvider = process.env.LLM_PROVIDER;
  const envModel = process.env.LLM_MODEL;

  const provider: LLMProvider = envProvider && isSupportedProvider(envProvider)
    ? envProvider
    : isSupportedProvider(tierConfig.provider)
      ? tierConfig.provider
      : 'openai';

  const model = envModel ?? tierConfig.model;
  const apiKey = resolveApiKey(provider);

  // Build tier tool limits and max tokens from config
  const tierToolLimits: Record<string, number> = {};
  const tierMaxTokens: Record<string, number> = {};

  for (const [t, limit] of Object.entries(fileConfig.agent.tier_tool_limits)) {
    tierToolLimits[t] = limit;
  }
  for (const [t, tokens] of Object.entries(fileConfig.agent.tier_max_tokens)) {
    tierMaxTokens[t] = tokens;
  }

  return {
    llm: {
      provider,
      model,
      apiKey,
      maxTokens: tierMaxTokens[tier] ?? tierConfig.max_tokens,
      temperature: tierConfig.temperature,
      baseUrl: tierConfig.api_base,
    },
    llmConfigs: fileConfig.llm_configs,
    tools: {
      workingDir: workingDir ?? process.cwd(),
      enabledTools: fileConfig.tools.enabled_tools,
      bashTimeout: fileConfig.tools.bash_timeout * 1000, // Convert to ms
      maxOutputLength: fileConfig.tools.max_output_length,
    },
    agent: {
      maxIterations: tierToolLimits[tier] ?? fileConfig.agent.max_tool_calls,
      enablePlanning: true,
      enableScouting: true,
      tierToolLimits,
      tierMaxTokens,
      behavioralRules: loadBehavioralRules(),
    },
    graphd: {
      enabled: fileConfig.graphd.enabled,
      host: fileConfig.graphd.host,
      port: fileConfig.graphd.port,
      dbPath: fileConfig.graphd.db_path,
      allowExport: fileConfig.graphd.allow_export,
      indexIntervalS: fileConfig.graphd.index_interval_s,
      maxResults: fileConfig.graphd.max_results,
    },
    skills: {
      enabled: fileConfig.skills.enabled,
      skillsDir: fileConfig.skills.skills_dir,
    },
    hooks: {
      enabled: fileConfig.hooks.enabled,
      hooksDir: fileConfig.hooks.hooks_dir,
      defaultFailOpen: fileConfig.hooks.default_fail_open,
    },
    router: {
      enabled: fileConfig.router.enabled,
      defaultTier: fileConfig.router.default_tier,
    },
  };
}

/**
 * Create config from environment variables only (legacy mode).
 */
export function createConfigFromEnv(workingDir?: string): FullHarnessConfig {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const explicitProvider = process.env.LLM_PROVIDER;

  let provider: LLMProvider;
  let apiKey: string;

  if (explicitProvider && isSupportedProvider(explicitProvider)) {
    provider = explicitProvider;
    apiKey = provider === 'anthropic' ? (anthropicKey ?? '') : (openaiKey ?? '');
    if (!apiKey) {
      throw new Error(
        `LLM_PROVIDER is '${provider}' but ${API_KEY_ENV_MAP[provider]} is not set.`
      );
    }
  } else if (anthropicKey) {
    provider = 'anthropic';
    apiKey = anthropicKey;
  } else if (openaiKey) {
    provider = 'openai';
    apiKey = openaiKey;
  } else {
    throw new Error(
      'No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable.'
    );
  }

  const defaultModel = provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o';

  return {
    llm: {
      provider,
      model: process.env.LLM_MODEL ?? defaultModel,
      apiKey,
      maxTokens: 4096,
    },
    llmConfigs: {},
    tools: {
      workingDir: workingDir ?? process.cwd(),
      enabledTools: DEFAULT_ENABLED_TOOLS,
      bashTimeout: 30000,
      maxOutputLength: 100000,
    },
    agent: {
      maxIterations: 50,
      enablePlanning: true,
      enableScouting: true,
      tierToolLimits: { ...DEFAULT_TIER_TOOL_LIMITS },
      tierMaxTokens: { ...DEFAULT_TIER_MAX_TOKENS },
      behavioralRules: loadBehavioralRules(),
    },
    graphd: { ...DEFAULT_GRAPHD_CONFIG },
    skills: {
      enabled: false,
      skillsDir: 'config/skills',
    },
    hooks: {
      enabled: false,
      hooksDir: 'config/hooks',
      defaultFailOpen: true,
    },
    router: {
      enabled: false,
      defaultTier: 'standard',
    },
  };
}

// ============================================
// MAIN ENTRY POINT
// ============================================

/**
 * Load full config: try file first, fallback to env-only.
 *
 * @param configPath - Optional explicit path to config file
 * @param workingDir - Working directory for tools
 * @param tier - Initial tier for LLM selection (default: 'standard')
 */
export function loadConfig(
  configPath?: string,
  workingDir?: string,
  tier: Tier = 'standard'
): FullHarnessConfig {
  const fileConfig = loadConfigFile(configPath);

  if (fileConfig) {
    return createConfigFromFile(fileConfig, tier, workingDir);
  }

  console.log('[config] No config file found, using environment-only mode');
  return createConfigFromEnv(workingDir);
}
