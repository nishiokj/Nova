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
// RUNTIME CONFIG (resolved with API keys)
// ============================================

/**
 * Resolved fallback config with API key.
 */
export interface ResolvedFallbackConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

/**
 * Resolved LLM config with API key from environment.
 */
export interface ResolvedLLMConfig {
  provider: LLMProvider;
  /** Original provider name from config (e.g., 'z.ai-coder') for display in errors */
  displayProvider: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature?: number;
  baseUrl?: string;
  reasoning?: {
    effort: ReasoningEffort;
  };
  fallback?: ResolvedFallbackConfig;
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
