/**
 * Configuration types for the TypeScript harness.
 *
 * These types mirror the structure of config/harness_config.json
 * and provide type safety for config loading.
 *
 * The config is the SINGLE SOURCE OF TRUTH for:
 * - Agent LLM assignments (provider, model, tokens, temperature)
 * - Agent budgets (iterations, tool calls, duration)
 * - Agent tool access
 */

// ============================================
// CORE TYPES
// ============================================

import type { StructuredOutputSchema } from 'agent-core';

/** Supported LLM providers */
export type LLMProvider = 'anthropic' | 'openai' | 'openai-compat';

/** Reasoning effort levels (provider-specific validation in loader) */
export type ReasoningEffort =
  | 'none'
  | 'standard'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

/** Reasoning config in harness_config.json (string or { effort }). */
export type AgentReasoningConfig = ReasoningEffort | { effort: ReasoningEffort };

/**
 * Agent type is just a string - any agent can be defined in config.
 * Common built-in types: 'routing', 'explorer', 'standard', 'complex'
 */
export type AgentType = string;

// ============================================
// AGENT CONFIG (per-agent in config file)
// ============================================

/**
 * LLM configuration for an agent.
 */
export interface AgentLLMConfig {
  provider: string;
  model: string;
  max_tokens: number;
  temperature?: number;
  api_base?: string;
  reasoning?: AgentReasoningConfig;
}

/**
 * Budget constraints for an agent.
 */
export interface AgentBudgetConfig {
  max_iterations: number;
  max_tool_calls: number;
  max_duration_ms: number;
}

/**
 * Full agent configuration from config file.
 * output_schema can be a string reference to output_schemas.json or inline schema.
 */
export interface AgentConfigEntry {
  llm: AgentLLMConfig;
  budget: AgentBudgetConfig;
  tools?: string[];
  /** Schema name (string) referencing output_schemas.json, or inline StructuredOutputSchema */
  output_schema?: string | StructuredOutputSchema;
}

// ============================================
// CONFIG FILE SECTIONS
// ============================================

/**
 * Tools configuration section.
 */
export interface ToolsConfigSection {
  bash_timeout_ms: number;
  max_output_length: number;
}

/**
 * GraphD configuration section.
 */
export interface GraphDConfigSection {
  enabled: boolean;
  host: string;
  port: number;
  db_path: string;
}

/**
 * Context configuration section.
 */
export interface ContextConfigSection {
  max_tokens: number;
}

/**
 * Skill definition in config.
 */
export interface SkillConfigEntry {
  id: string;
  name: string;
  description: string;
  enabled?: boolean;
  type?: string;
  tags?: string[];
  prompt?: string;
}

/**
 * Hook definition in config.
 */
export interface HookConfigEntry {
  id: string;
  name: string;
  description: string;
  enabled?: boolean;
  trigger: string;
  priority?: number;
  command?: string;
}

/**
 * Skills configuration section.
 * Supports both directory-based loading and inline definitions.
 */
export interface SkillsConfigSection {
  enabled: boolean;
  directory?: string;
  definitions?: SkillConfigEntry[];
}

/**
 * Hooks configuration section.
 * Supports both directory-based loading and inline definitions.
 */
export interface HooksConfigSection {
  enabled: boolean;
  directory?: string;
  definitions?: HookConfigEntry[];
}

/**
 * Auth configuration section.
 */
export interface AuthConfigSection {
  enabled: boolean;
  host: string;
  port: number;
  session_expiry_days?: number | null; // null = never expires
}

/**
 * Provider API key configuration.
 * Stores API keys directly in config file for local use.
 */
export interface ProvidersConfigSection {
  anthropic?: string;
  openai?: string;
  cerebras?: string;
  together?: string;
  groq?: string;
  fireworks?: string;
  gemini?: string;
  [key: string]: string | undefined;
}

// ============================================
// FULL CONFIG FILE STRUCTURE
// ============================================

/**
 * Root structure of harness_config.json.
 */
export interface HarnessConfigFile {
  agents: Record<string, AgentConfigEntry>;
  tools: ToolsConfigSection;
  graphd: GraphDConfigSection;
  context: ContextConfigSection;
  skills?: SkillsConfigSection;
  hooks?: HooksConfigSection;
  auth?: AuthConfigSection;
  /** API keys for LLM providers (config file takes precedence over env vars) */
  providers?: ProvidersConfigSection;
}

// ============================================
// RUNTIME CONFIG (resolved with API keys)
// ============================================

/**
 * Resolved LLM config with API key from environment.
 */
export interface ResolvedLLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature?: number;
  baseUrl?: string;
  reasoning?: {
    effort: ReasoningEffort;
  };
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
