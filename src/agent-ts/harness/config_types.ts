/**
 * Configuration types for the TypeScript harness.
 *
 * These types mirror the structure of config/harness_config.json
 * and provide type safety for config loading.
 */

// ============================================
// CORE TYPES
// ============================================

export type Tier = 'simple' | 'standard' | 'advanced';
export type LLMProvider = 'anthropic' | 'openai';

// ============================================
// LLM CONFIG (per-tier)
// ============================================

/**
 * LLM configuration for a specific tier.
 * Matches llm_configs entries in harness_config.json.
 */
export interface TieredLLMConfig {
  provider: string; // Allow any provider in config, filter at runtime
  model: string;
  max_tokens: number;
  temperature?: number;
  api_base?: string;
  failover_models?: TieredLLMConfig[];
}

// ============================================
// CONFIG SECTIONS (from harness_config.json)
// ============================================

export interface RouterConfigSection {
  enabled: boolean;
  default_tier: Tier;
  difficulty_tiers: Tier[];
}

export interface AgentConfigSection {
  tier: Tier;
  max_tool_calls: number;
  tool_timeout: number;
  allow_code_execution: boolean;
  allow_internet: boolean;
  allow_bash: boolean;
  tier_tool_limits: Record<string, number>;
  tier_max_tokens: Record<string, number>;
}

export interface ToolsConfigSection {
  enabled_tools: string[];
  sandbox_bash: boolean;
  sandbox_python: boolean;
  max_output_length: number;
  bash_timeout: number;
  python_timeout: number;
}

export interface SkillsConfigSection {
  enabled: boolean;
  skills_dir: string;
  semantic_enabled: boolean;
  semantic_min_confidence: number;
  semantic_llm_config: unknown;
  max_candidates: number;
  match_policy: 'best_score' | 'first_match';
}

export interface HooksConfigSection {
  enabled: boolean;
  hooks_dir: string;
  default_fail_open: boolean;
  max_exec_ms: number;
}

export interface GraphDConfigSection {
  enabled: boolean;
  enable_tools: boolean;
  root_path: string | null;
  db_path: string;
  host: string;
  port: number;
  client_timeout_s: number;
  index_interval_s: number;
  debounce_s: number;
  max_file_size_bytes: number;
  max_files_per_scan: number;
  derived_ttl_s: number;
  derived_max_entries: number;
  max_results: number;
  enable_rg: boolean;
  rg_path: string;
  idle_refinement: boolean;
  refine_max_files: number;
  refine_max_symbols: number;
  backpressure_when_active: boolean;
  nice_level: number | null;
  max_memory_mb: number | null;
  allow_export: boolean;
  ignore_file: string;
  extra_ignore: string[];
  vacuum_interval_cycles: number;
  stats_log_interval_cycles: number;
}

export interface LoggingConfigSection {
  log_dir: string;
  log_level: string;
  log_to_file: boolean;
  log_to_console: boolean;
  structured_format: boolean;
}

// ============================================
// FULL CONFIG FILE STRUCTURE
// ============================================

/**
 * Complete structure of harness_config.json.
 */
export interface HarnessConfigFile {
  router: RouterConfigSection;
  agent: AgentConfigSection;
  tools: ToolsConfigSection;
  skills: SkillsConfigSection;
  hooks: HooksConfigSection;
  graphd: GraphDConfigSection;
  logging?: LoggingConfigSection;
  llm_configs: Record<string, TieredLLMConfig>;
}

// ============================================
// RUNTIME CONFIG (resolved)
// ============================================

/**
 * Resolved LLM configuration with API key.
 */
export interface ResolvedLLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
  baseUrl?: string;
}

/**
 * Runtime configuration used by AgentHarness.
 * Contains resolved settings with defaults applied.
 */
export interface FullHarnessConfig {
  /** Current LLM config (resolved for default tier) */
  llm: ResolvedLLMConfig;

  /** All tier-keyed LLM configs for runtime switching */
  llmConfigs: Record<string, TieredLLMConfig>;

  /** Tool configuration */
  tools: {
    workingDir: string;
    enabledTools: string[];
    bashTimeout: number;
    maxOutputLength: number;
    enableDangerousCommands?: boolean;
  };

  /** Agent configuration */
  agent: {
    systemPrompt?: string;
    enablePlanning?: boolean;
    enableScouting?: boolean;
    maxIterations?: number;
    /** Maximum context window tokens (default: 200_000) */
    maxContextTokens?: number;
    tierToolLimits: Record<string, number>;
    tierMaxTokens: Record<string, number>;
    /** Behavioral rules loaded from config/behavioral_rules.md */
    behavioralRules?: string;
  };

  /** GraphD configuration */
  graphd: {
    enabled: boolean;
    host: string;
    port: number;
    dbPath: string;
    allowExport?: boolean;
    indexIntervalS?: number;
    maxResults?: number;
  };

  /** Skills configuration */
  skills: {
    enabled: boolean;
    skillsDir: string;
  };

  /** Hooks configuration */
  hooks: {
    enabled: boolean;
    hooksDir: string;
    defaultFailOpen: boolean;
  };

  /** Router configuration */
  router: {
    enabled: boolean;
    defaultTier: Tier;
  };

  /** Optional session key */
  sessionKey?: string;
}

// ============================================
// DEFAULTS
// ============================================

export const DEFAULT_TIER_TOOL_LIMITS: Record<Tier, number> = {
  simple: 1,
  standard: 20,
  advanced: 25,
};

export const DEFAULT_TIER_MAX_TOKENS: Record<Tier, number> = {
  simple: 4098,
  standard: 16000,
  advanced: 32000,
};

export const DEFAULT_ENABLED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
];

export const DEFAULT_GRAPHD_CONFIG: FullHarnessConfig['graphd'] = {
  enabled: true,
  host: '127.0.0.1',
  port: 9444,
  dbPath: '.graphd/graph.db',
  allowExport: true,
  indexIntervalS: 5.0,
  maxResults: 200,
};
