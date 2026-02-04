/**
 * Harness configuration - schemas, types, and defaults.
 *
 * This is the SINGLE SOURCE OF TRUTH for config structure.
 * - Zod schemas validate config/defaults.json
 * - Types are inferred from schemas (no manual duplication)
 * - Resolved types represent runtime config after processing
 * - Defaults provide fallbacks for optional sections
 */

import { z } from 'zod';
import {
  SUPPORTED_PROVIDER_IDS,
  type SupportedProvider as CentralSupportedProvider,
  type StructuredOutputSchema,
} from 'types';

// ============================================
// ZOD SCHEMAS - Config File Validation
// ============================================

/** Canonical LLM providers (what the adapter routes to) */
export const LLMProviderSchema = z.enum(['anthropic', 'openai', 'openai-compat', 'vercel-gateway', 'codex']);

/** All supported provider names (config input) */
export const SupportedProviderSchema = z.enum(
  SUPPORTED_PROVIDER_IDS as [CentralSupportedProvider, ...CentralSupportedProvider[]]
);

/** Reasoning effort levels */
export const ReasoningEffortSchema = z.enum([
  'none', 'standard', 'minimal', 'low', 'medium', 'high', 'xhigh',
]);

/** Role-based model selection */
export const ModelRoleSchema = z.enum(['fast', 'standard', 'powerful', 'reasoning']);

/** Fallback LLM configuration */
export const AgentFallbackConfigSchema = z.object({
  provider: z.string().optional(),
  model: z.string(),
  api_base: z.string().optional(),
});

/** Reasoning config - string or object */
export const AgentReasoningConfigSchema = z.union([
  ReasoningEffortSchema,
  z.object({ effort: ReasoningEffortSchema }),
]);

/** LLM configuration for an agent */
export const AgentLLMConfigSchema = z.object({
  role: ModelRoleSchema.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  max_tokens: z.number().positive(),
  temperature: z.number().min(0).max(2).optional(),
  api_base: z.string().optional(),
  reasoning: AgentReasoningConfigSchema.optional(),
  fallback: AgentFallbackConfigSchema.optional(),
}).superRefine((value, ctx) => {
  if (!value.model && !value.role) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'llm.model or llm.role is required',
    });
  }
});

/** Budget constraints for an agent */
export const AgentBudgetConfigSchema = z.object({
  max_iterations: z.number().positive().int(),
  max_tool_calls: z.number().nonnegative().int(),
  max_duration_ms: z.number().positive(),
});

/** Inline structured output schema */
export const StructuredOutputSchemaSchema = z.object({
  name: z.string(),
  schema: z.record(z.string(), z.unknown()),
  strict: z.boolean().optional(),
});

/** Full agent configuration entry */
export const AgentConfigEntrySchema = z.object({
  llm: AgentLLMConfigSchema,
  budget: AgentBudgetConfigSchema,
  tools: z.array(z.string()).optional(),
  output_schema: z.union([z.string(), StructuredOutputSchemaSchema]).optional(),
});

/** Tools configuration */
export const ToolsConfigSchema = z.object({
  bash_timeout_ms: z.number().positive(),
  max_output_length: z.number().positive(),
});

/** GraphD configuration */
export const GraphDConfigSchema = z.object({
  enabled: z.boolean(),
  host: z.string(),
  port: z.number().int().positive(),
  db_path: z.string(),
});

/** Context configuration */
export const ContextConfigSchema = z.object({
  max_tokens: z.number().positive().int(),
  session_ttl_ms: z.number().int().nonnegative().optional(),
  pause_timeout_ms: z.number().int().nonnegative().optional(),
});

/** Skill definition */
export const SkillConfigEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean().optional(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  prompt: z.string().optional(),
});

/** Hook definition */
export const HookConfigEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean().optional(),
  trigger: z.string(),
  priority: z.number().optional(),
  command: z.string().optional(),
});

/** Skills configuration */
export const SkillsConfigSchema = z.object({
  enabled: z.boolean(),
  directory: z.string().optional(),
  definitions: z.array(SkillConfigEntrySchema).optional(),
});

/** Hooks configuration */
export const HooksConfigSchema = z.object({
  enabled: z.boolean(),
  directory: z.string().optional(),
  definitions: z.array(HookConfigEntrySchema).optional(),
});

/** Entity Graph configuration */
export const EntityGraphConfigSchema = z.object({
  enabled: z.boolean(),
  database_url: z.string().optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  lease_duration_sec: z.number().positive().optional(),
  startup_scan: z.boolean().optional(),
  lease_wait_timeout_ms: z.number().positive().optional(),
});

/** Auth configuration */
export const AuthConfigSchema = z.object({
  enabled: z.boolean(),
  host: z.string(),
  port: z.number().int().positive(),
  session_expiry_days: z.number().nullable().optional(),
  google_client_id: z.string().optional(),
  google_redirect_uri: z.string().optional(),
  master_key_path: z.string().optional(),
  graphd_db_path: z.string().optional(),
});

/** Memory injection configuration */
export const MemoryConfigSchema = z.object({
  enabled: z.boolean(),
  base_url: z.string().optional(),
  timeout_ms: z.number().positive().optional(),
});

/** Model entry */
export const ModelConfigEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  description: z.string().optional(),
  max_tokens: z.number().positive().optional(),
  context_window: z.number().positive().optional(),
  supports_reasoning: z.boolean().optional(),
});

/** Models configuration */
export const ModelsConfigSchema = z.object({
  available: z.array(ModelConfigEntrySchema).optional(),
  default: z.string().optional(),
});

/** Root config file structure */
export const HarnessConfigFileSchema = z.object({
  models: ModelsConfigSchema.optional(),
  agents: z.record(z.string(), AgentConfigEntrySchema),
  tools: ToolsConfigSchema.optional(),
  graphd: GraphDConfigSchema.optional(),
  context: ContextConfigSchema.optional(),
  skills: SkillsConfigSchema.optional(),
  hooks: HooksConfigSchema.optional(),
  entity_graph: EntityGraphConfigSchema.optional(),
  auth: AuthConfigSchema.optional(),
  memory: MemoryConfigSchema.optional(),
});

// ============================================
// INFERRED TYPES - From Zod Schemas
// ============================================

export type LLMProvider = z.infer<typeof LLMProviderSchema>;
export type SupportedProvider = z.infer<typeof SupportedProviderSchema>;
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type ModelRole = z.infer<typeof ModelRoleSchema>;
export type AgentReasoningConfig = z.infer<typeof AgentReasoningConfigSchema>;
export type AgentFallbackConfig = z.infer<typeof AgentFallbackConfigSchema>;
export type AgentLLMConfig = z.infer<typeof AgentLLMConfigSchema>;
export type AgentBudgetConfig = z.infer<typeof AgentBudgetConfigSchema>;
export type AgentConfigEntry = z.infer<typeof AgentConfigEntrySchema>;
export type ToolsConfigSection = z.infer<typeof ToolsConfigSchema>;
export type GraphDConfigSection = z.infer<typeof GraphDConfigSchema>;
export type ContextConfigSection = z.infer<typeof ContextConfigSchema>;
export type SkillConfigEntry = z.infer<typeof SkillConfigEntrySchema>;
export type HookConfigEntry = z.infer<typeof HookConfigEntrySchema>;
export type SkillsConfigSection = z.infer<typeof SkillsConfigSchema>;
export type HooksConfigSection = z.infer<typeof HooksConfigSchema>;
export type EntityGraphConfigSection = z.infer<typeof EntityGraphConfigSchema>;
export type AuthConfigSection = z.infer<typeof AuthConfigSchema>;
export type MemoryConfigSection = z.infer<typeof MemoryConfigSchema>;
export type ModelConfigEntry = z.infer<typeof ModelConfigEntrySchema>;
export type ModelsConfigSection = z.infer<typeof ModelsConfigSchema>;
export type HarnessConfigFile = z.infer<typeof HarnessConfigFileSchema>;

/** Agent type is just a string */
export type AgentType = string;

// ============================================
// RESOLVED TYPES - Runtime Config After Processing
// ============================================

/** Resolved fallback config (no API key - resolved at request time) */
export interface ResolvedFallbackConfig {
  provider: LLMProvider;
  model: string;
  baseUrl?: string;
}

/** Resolved LLM config (no API key - resolved at request time) */
export interface ResolvedLLMConfig {
  provider: LLMProvider;
  displayProvider: string; // Original provider name for error messages
  model: string;
  maxTokens: number;
  temperature?: number;
  baseUrl?: string;
  reasoning?: { effort: ReasoningEffort };
  fallback?: ResolvedFallbackConfig;
}

/** Resolved agent config ready for runtime */
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

/** Full resolved harness config - what the harness uses at runtime */
export interface FullHarnessConfig {
  agents: Record<string, ResolvedAgentConfig>;
  defaultAgent: string;
  tools: {
    workingDir: string;
    repoRoot: string;
    bashTimeoutMs: number;
    maxOutputLength: number;
  };
  graphd: {
    enabled: boolean;
    host: string;
    port: number;
    dbPath: string;
  };
  context: {
    maxTokens: number;
    sessionTtlMs: number;
    pauseTimeoutMs: number;
  };
  skills: {
    enabled: boolean;
    directory?: string;
    definitions: SkillConfigEntry[];
  };
  hooks: {
    enabled: boolean;
    directory?: string;
    definitions: HookConfigEntry[];
  };
  entityGraph: {
    enabled: boolean;
    databaseUrl?: string;
    include?: string[];
    exclude?: string[];
    leaseDurationSec: number;
    startupScan: boolean;
    leaseWaitTimeoutMs: number;
  };
  auth: {
    enabled: boolean;
    host: string;
    port: number;
    sessionExpiryDays: number | null;
    google_client_id?: string;
    google_redirect_uri?: string;
    master_key_path?: string;
    graphd_db_path?: string;
  };
  behavioralRules?: string;
  models: {
    available: ModelConfigEntry[];
    default?: string;
  };
  memory: {
    enabled: boolean;
    baseUrl: string;
    timeoutMs: number;
  };
  configPath?: string;
  /** Dangerous mode - bypasses all permission checks. Set via --dangerous CLI flag. */
  dangerousMode: boolean;
}

// ============================================
// DEFAULTS - Fallbacks for optional config sections
// ============================================

export const DEFAULT_TOOLS_CONFIG: ToolsConfigSection = {
  bash_timeout_ms: 120000,
  max_output_length: 10000,
};

export const DEFAULT_GRAPHD_CONFIG: GraphDConfigSection = {
  enabled: false,
  host: 'localhost',
  port: 9444,
  db_path: '~/.graphd/graphd.db',
};

export const DEFAULT_CONTEXT_CONFIG: ContextConfigSection = {
  max_tokens: 200_000,
  session_ttl_ms: 7_200_000,
  pause_timeout_ms: 1_200_000, // 20 minutes
};

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

export const DEFAULT_ENTITY_GRAPH_CONFIG: EntityGraphConfigSection = {
  enabled: false,
  startup_scan: true,
  lease_duration_sec: 30,
  lease_wait_timeout_ms: 10_000,
};

export const DEFAULT_AUTH_CONFIG: AuthConfigSection = {
  enabled: true,
  host: '127.0.0.1',
  port: 9556,
  session_expiry_days: null,
};

export const DEFAULT_MODELS_CONFIG: ModelsConfigSection = {
  available: [],
  default: undefined,
};

export const DEFAULT_MEMORY_CONFIG: MemoryConfigSection = {
  enabled: false,
  base_url: 'http://localhost:3001',
  timeout_ms: 5000,
};

// ============================================
// HELPERS
// ============================================

/** Normalize reasoning effort, validating against provider constraints */
export function normalizeReasoningEffort(
  provider: LLMProvider,
  effort?: string
): ReasoningEffort {
  if (!effort) return 'none';

  const result = ReasoningEffortSchema.safeParse(effort.toLowerCase());
  if (!result.success) {
    console.warn(`[config] Invalid reasoning effort '${effort}', defaulting to 'none'`);
    return 'none';
  }

  // Anthropic only supports 'none' and 'standard'
  if (provider === 'anthropic' && !['none', 'standard'].includes(result.data)) {
    console.warn(`[config] Anthropic doesn't support effort '${result.data}', using 'none'`);
    return 'none';
  }

  return result.data;
}

/** Extract reasoning effort from config (handles string or object) */
export function extractReasoningEffort(
  reasoning?: AgentReasoningConfig
): string | undefined {
  if (!reasoning) return undefined;
  if (typeof reasoning === 'string') return reasoning;
  return reasoning.effort;
}
