/**
 * Configuration loader for the TypeScript harness.
 *
 * Loads harness_config.json and resolves API keys from environment.
 * The config file is the SINGLE SOURCE OF TRUTH for agent configurations.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import type {
  LLMProvider,
  AgentConfigEntry,
  HarnessConfigFile,
  FullHarnessConfig,
  ResolvedAgentConfig,
  ResolvedLLMConfig,
  ReasoningEffort,
} from './config_types.js';
import {
  DEFAULT_TOOLS_CONFIG,
  DEFAULT_GRAPHD_CONFIG,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_ENABLED_TOOLS,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_HOOKS_CONFIG,
} from './config_types.js';

const DEFAULT_CONFIG_PATH = 'config/harness_config.json';
const BEHAVIORAL_RULES_PATH = 'config/behavioral_rules.md';

// ============================================
// PATH RESOLUTION
// ============================================

/**
 * Find project root by looking for config/harness_config.json.
 */
function findProjectRoot(startDir: string): string {
  let dir = startDir;
  const root = '/';
  while (dir !== root) {
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
 */
export function loadBehavioralRules(): string {
  const paths: string[] = [];
  paths.push(resolve(process.cwd(), BEHAVIORAL_RULES_PATH));

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

  return '';
}

// ============================================
// CONFIG FILE LOADING
// ============================================

/**
 * Load config file from disk.
 */
export function loadConfigFile(configPath?: string): HarnessConfigFile | null {
  const paths: string[] = [];

  if (configPath) {
    paths.push(resolve(configPath));
  }

  paths.push(resolve(process.cwd(), DEFAULT_CONFIG_PATH));

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

const API_KEY_ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
};

const OPENAI_REASONING_EFFORTS = new Set<ReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

const ANTHROPIC_REASONING_EFFORTS = new Set<ReasoningEffort>([
  'none',
  'standard',
]);

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
 * Check if a provider is supported.
 */
function isSupportedProvider(provider: string): provider is LLMProvider {
  return provider === 'anthropic' || provider === 'openai';
}

function normalizeReasoningEffort(
  provider: LLMProvider,
  effort?: string
): ReasoningEffort {
  if (!effort || typeof effort !== 'string') {
    return 'none';
  }

  const normalized = effort.toLowerCase() as ReasoningEffort;
  const allowed =
    provider === 'openai' ? OPENAI_REASONING_EFFORTS : ANTHROPIC_REASONING_EFFORTS;

  if (allowed.has(normalized)) {
    return normalized;
  }

  console.warn(
    `[config] Invalid reasoning.effort '${effort}' for provider '${provider}', defaulting to 'none'`
  );
  return 'none';
}

// ============================================
// AGENT CONFIG RESOLUTION
// ============================================

/**
 * Resolve a single agent config entry to runtime format.
 */
function resolveAgentConfig(entry: AgentConfigEntry): ResolvedAgentConfig {
  const provider = entry.llm.provider;

  if (!isSupportedProvider(provider)) {
    throw new Error(`Unsupported LLM provider: ${provider}`);
  }

  const rawReasoning = entry.llm.reasoning;
  const rawEffort =
    typeof rawReasoning === 'string' ? rawReasoning : rawReasoning?.effort;
  const reasoningEffort = normalizeReasoningEffort(provider, rawEffort);

  const llm: ResolvedLLMConfig = {
    provider,
    model: entry.llm.model,
    apiKey: resolveApiKey(provider),
    maxTokens: entry.llm.max_tokens,
    temperature: entry.llm.temperature,
    baseUrl: entry.llm.api_base,
    reasoning: { effort: reasoningEffort },
  };

  return {
    llm,
    budget: {
      maxIterations: entry.budget.max_iterations,
      maxToolCalls: entry.budget.max_tool_calls,
      maxDurationMs: entry.budget.max_duration_ms,
    },
    tools: entry.tools ?? DEFAULT_ENABLED_TOOLS,
    outputSchema: entry.output_schema,
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
// CONFIG CREATION
// ============================================

/**
 * Create FullHarnessConfig from file config.
 */
export function createConfigFromFile(
  fileConfig: HarnessConfigFile,
  workingDir?: string
): FullHarnessConfig {
  // Resolve all agent configs
  const agents: Record<string, ResolvedAgentConfig> = {};
  for (const [agentType, entry] of Object.entries(fileConfig.agents)) {
    try {
      agents[agentType] = resolveAgentConfig(entry);
    } catch (e) {
      console.warn(`[config] Failed to resolve agent '${agentType}':`, e);
    }
  }

  if (Object.keys(agents).length === 0) {
    throw new Error('No valid agent configs found in config file');
  }

  return {
    agents,
    defaultAgent: 'standard',
    tools: {
      workingDir: workingDir ?? process.cwd(),
      bashTimeoutMs: fileConfig.tools?.bash_timeout_ms ?? DEFAULT_TOOLS_CONFIG.bash_timeout_ms,
      maxOutputLength: fileConfig.tools?.max_output_length ?? DEFAULT_TOOLS_CONFIG.max_output_length,
    },
    graphd: {
      enabled: fileConfig.graphd?.enabled ?? DEFAULT_GRAPHD_CONFIG.enabled,
      host: fileConfig.graphd?.host ?? DEFAULT_GRAPHD_CONFIG.host,
      port: fileConfig.graphd?.port ?? DEFAULT_GRAPHD_CONFIG.port,
      dbPath: fileConfig.graphd?.db_path ?? DEFAULT_GRAPHD_CONFIG.db_path,
    },
    context: {
      maxTokens: fileConfig.context?.max_tokens ?? DEFAULT_CONTEXT_CONFIG.max_tokens,
    },
    skills: {
      enabled: fileConfig.skills?.enabled ?? DEFAULT_SKILLS_CONFIG.enabled,
      directory: fileConfig.skills?.directory,
      definitions: fileConfig.skills?.definitions ?? [],
    },
    hooks: {
      enabled: fileConfig.hooks?.enabled ?? DEFAULT_HOOKS_CONFIG.enabled,
      directory: fileConfig.hooks?.directory,
      definitions: fileConfig.hooks?.definitions ?? [],
    },
    behavioralRules: loadBehavioralRules(),
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
    provider = explicitProvider;
    apiKey = provider === 'anthropic' ? (anthropicKey ?? '') : (openaiKey ?? '');
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

  return {
    agents,
    defaultAgent: 'standard',
    tools: {
      workingDir: workingDir ?? process.cwd(),
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
    behavioralRules: loadBehavioralRules(),
  };
}

// ============================================
// MAIN ENTRY POINT
// ============================================

/**
 * Load full config: try file first, fallback to env-only.
 */
export function loadConfig(
  configPath?: string,
  workingDir?: string
): FullHarnessConfig {
  const fileConfig = loadConfigFile(configPath);

  if (fileConfig) {
    return createConfigFromFile(fileConfig, workingDir);
  }

  console.log('[config] No config file found, using environment-only mode');
  return createConfigFromEnv(workingDir);
}
