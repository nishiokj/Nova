/**
 * Configuration types for the TypeScript harness.
 *
 * Raw config types are inferred from Zod schemas in config_schema.ts.
 * This file exports those types plus resolved runtime types with computed fields.
 *
 * The config is the SINGLE SOURCE OF TRUTH for:
 * - Agent LLM assignments (provider, model, tokens, temperature)
 * - Agent budgets (iterations, tool calls, duration)
 * - Agent tool access
 */

import type { StructuredOutputSchema } from 'types';
import type {
  LLMProvider,
  ModelRole,
  ReasoningEffort,
  ToolsConfigSection,
  GraphDConfigSection,
  ContextConfigSection,
  SkillConfigEntry,
  HookConfigEntry,
  SkillsConfigSection,
  HooksConfigSection,
  AuthConfigSection,
  ProvidersConfigSection,
  ProviderPriority,
  ModelConfigEntry,
  ModelsConfigSection,
} from './config_schema.js';

// ============================================
// RE-EXPORT RAW TYPES FROM ZOD SCHEMAS
// ============================================

export type {
  LLMProvider,
  SupportedProvider,
  ReasoningEffort,
  ModelRole,
  AgentReasoningConfig,
  AgentFallbackConfig,
  AgentLLMConfig,
  AgentBudgetConfig,
  AgentConfigEntry,
  ToolsConfigSection,
  GraphDConfigSection,
  ContextConfigSection,
  SkillConfigEntry,
  HookConfigEntry,
  SkillsConfigSection,
  HooksConfigSection,
  AuthConfigSection,
  ProvidersConfigSection,
  ProviderPriority,
  ModelConfigEntry,
  ModelsConfigSection,
  HarnessConfigFile,
} from './config_schema.js';

/**
 * Agent type is just a string - any agent can be defined in config.
 * Common built-in types: 'routing', 'explorer', 'standard', 'complex'
 */
export type AgentType = string;

// ============================================
// RUNTIME CONFIG (no credentials - resolved at request time)
// ============================================

/**
 * Resolved fallback config - NO API KEY.
 * Credentials are resolved at request time via ProviderService.
 */
export interface ResolvedFallbackConfig {
  provider: LLMProvider;
  model: string;
  baseUrl?: string;
}

/**
 * Resolved LLM config - NO API KEY.
 * Credentials are resolved at request time via ProviderService.
 * This allows the harness to start without any configured providers,
 * and for users to add/change API keys at runtime.
 *
 * Note: thinking config is derived from provider registry at request time
 * via getModelThinkingConfig() - not stored here.
 */
export interface ResolvedLLMConfig {
  provider: LLMProvider;
  /** Original provider name from config (e.g., 'z.ai-coder') for display in errors */
  displayProvider: string;
  model: string;
  maxTokens: number;
  temperature?: number;
  baseUrl?: string;
  reasoning?: {
    effort: ReasoningEffort;
  };
  fallback?: ResolvedFallbackConfig;
}

/**
 * Provider service interface for runtime API key resolution.
 * This is queried at request time, not at config load time.
 */
export interface ProviderService {
  /** Get API key for a provider. Returns null if not configured. */
  getApiKey(provider: string): string | null;
  /** Check if an API key exists for a provider. */
  hasApiKey(provider: string): boolean;
  /** Save an API key for a provider. */
  saveApiKey(provider: string, apiKey: string): { success: boolean; error?: string };
}

/**
 * Resolved agent config ready for runtime use.
 */
export interface ResolvedAgentConfig {
  llm: ResolvedLLMConfig;
  budget: {
    maxIterations: number;
    maxToolCalls: number;
    maxDurationMs: number;
  };
  tools: string[];
  outputSchema?: StructuredOutputSchema;
}

/**
 * Full resolved harness config.
 * This is what the harness uses at runtime.
 */
export interface FullHarnessConfig {
  /** All agent configs, keyed by agent type */
  agents: Record<string, ResolvedAgentConfig>;

  /** Default agent for initial requests (usually 'standard') */
  defaultAgent: string;

  /** Tool configuration */
  tools: {
    workingDir: string;
    repoRoot: string;
    bashTimeoutMs: number;
    maxOutputLength: number;
  };

  /** GraphD configuration */
  graphd: {
    enabled: boolean;
    host: string;
    port: number;
    dbPath: string;
  };

  /** Context window configuration */
  context: {
    maxTokens: number;
    sessionTtlMs: number;
  };

  /** Skills configuration */
  skills: {
    enabled: boolean;
    directory?: string;
    definitions: SkillConfigEntry[];
  };

  /** Hooks configuration */
  hooks: {
    enabled: boolean;
    directory?: string;
    definitions: HookConfigEntry[];
  };

  /** Auth configuration */
  auth: {
    enabled: boolean;
    host: string;
    port: number;
    sessionExpiryDays: number | null;
  };

  /** Behavioral rules loaded from config/behavioral_rules.md */
  behavioralRules?: string;

  /** Provider API keys (from config file) */
  providers: ProvidersConfigSection;

  /** Available models for selection */
  models: {
    available: ModelConfigEntry[];
    default?: string;
  };

  /** Path to the config file (needed for updating providers) */
  configPath?: string;
}

// ============================================
// DEFAULTS
// ============================================

export const DEFAULT_TOOLS_CONFIG: ToolsConfigSection = {
  bash_timeout_ms: 30000,
  max_output_length: 10000,
};

export const DEFAULT_GRAPHD_CONFIG: GraphDConfigSection = {
  enabled: false,
  host: 'localhost',
  port: 9444,
  db_path: '~/.graphd/graphd.db', // Global database in user home directory
};

export const DEFAULT_CONTEXT_CONFIG: ContextConfigSection = {
  max_tokens: 200_000,
  session_ttl_ms: 1_800_000,
};

export const DEFAULT_ENABLED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'Skill',
];

export const DEFAULT_SKILLS_CONFIG: SkillsConfigSection = {
  enabled: true,
  directory: 'config/skills',
  definitions: [],
};

export const DEFAULT_HOOKS_CONFIG: HooksConfigSection = {
  enabled: true,
  directory: 'config/hooks',
  definitions: [],
};

export const DEFAULT_AUTH_CONFIG: AuthConfigSection = {
  enabled: true,
  host: '127.0.0.1',
  port: 9556,
  session_expiry_days: null, // Never expires
};

export const DEFAULT_MODELS_CONFIG: ModelsConfigSection = {
  available: [],
  default: undefined,
};
