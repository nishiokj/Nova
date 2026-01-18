/**
 * Zod schemas for harness configuration.
 *
 * These schemas validate and type the config/harness_config.json file.
 * Use z.infer<typeof Schema> to derive types instead of manual interfaces.
 */

import { z } from 'zod';
import {
  SUPPORTED_PROVIDER_IDS,
  OPENAI_COMPAT_PROVIDERS as CENTRAL_OPENAI_COMPAT_PROVIDERS,
  isSupportedProvider as centralIsSupportedProvider,
  isOpenAICompatProvider as centralIsOpenAICompatProvider,
  getCanonicalProvider as centralGetCanonicalProvider,
  type LLMProvider as CentralLLMProvider,
  type SupportedProvider as CentralSupportedProvider,
} from 'types';

// ============================================
// ENUMS & PRIMITIVES
// ============================================

/**
 * Canonical LLM providers (what the adapter routes to).
 * Derived from central types.
 */
export const LLMProviderSchema = z.enum(['anthropic', 'openai', 'openai-compat']);

/**
 * All supported provider names (config input).
 * Uses central provider registry for validation.
 */
export const SupportedProviderSchema = z.enum(
  SUPPORTED_PROVIDER_IDS as [CentralSupportedProvider, ...CentralSupportedProvider[]]
);

/**
 * Reasoning effort levels across all providers.
 */
export const ReasoningEffortSchema = z.enum([
  'none',
  'standard',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

/**
 * Role-based model selection.
 */
export const ModelRoleSchema = z.enum(['fast', 'standard', 'powerful', 'reasoning']);

// ============================================
// FALLBACK CONFIG
// ============================================

/**
 * Fallback LLM configuration (raw from JSON).
 */
export const AgentFallbackConfigSchema = z.object({
  provider: z.string().optional(),
  model: z.string(),
  api_base: z.string().optional(),
});

// ============================================
// LLM CONFIG (RAW)
// ============================================

/**
 * Reasoning config can be a string or object with effort field.
 */
export const AgentReasoningConfigSchema = z.union([
  ReasoningEffortSchema,
  z.object({ effort: ReasoningEffortSchema }),
]);

/**
 * LLM configuration for an agent (raw from JSON).
 */
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

// ============================================
// BUDGET CONFIG
// ============================================

/**
 * Budget constraints for an agent.
 */
export const AgentBudgetConfigSchema = z.object({
  max_iterations: z.number().positive().int(),
  max_tool_calls: z.number().nonnegative().int(),
  max_duration_ms: z.number().positive(),
});

// ============================================
// OUTPUT SCHEMA
// ============================================

/**
 * Inline structured output schema definition.
 */
export const StructuredOutputSchemaSchema = z.object({
  name: z.string(),
  schema: z.record(z.string(), z.unknown()),
  strict: z.boolean().optional(),
});

// ============================================
// AGENT CONFIG ENTRY
// ============================================

/**
 * Full agent configuration entry (raw from JSON).
 */
export const AgentConfigEntrySchema = z.object({
  llm: AgentLLMConfigSchema,
  budget: AgentBudgetConfigSchema,
  tools: z.array(z.string()).optional(),
  output_schema: z.union([
    z.string(),
    StructuredOutputSchemaSchema,
  ]).optional(),
});

// ============================================
// CONFIG SECTIONS
// ============================================

/**
 * Tools configuration section.
 */
export const ToolsConfigSchema = z.object({
  bash_timeout_ms: z.number().positive(),
  max_output_length: z.number().positive(),
});

/**
 * GraphD configuration section.
 */
export const GraphDConfigSchema = z.object({
  enabled: z.boolean(),
  host: z.string(),
  port: z.number().int().positive(),
  db_path: z.string(),
});

/**
 * Context configuration section.
 */
export const ContextConfigSchema = z.object({
  max_tokens: z.number().positive().int(),
});

/**
 * Skill definition.
 */
export const SkillConfigEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean().optional(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  prompt: z.string().optional(),
});

/**
 * Hook definition.
 */
export const HookConfigEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean().optional(),
  trigger: z.string(),
  priority: z.number().optional(),
  command: z.string().optional(),
});

/**
 * Skills configuration section.
 */
export const SkillsConfigSchema = z.object({
  enabled: z.boolean(),
  directory: z.string().optional(),
  definitions: z.array(SkillConfigEntrySchema).optional(),
});

/**
 * Hooks configuration section.
 */
export const HooksConfigSchema = z.object({
  enabled: z.boolean(),
  directory: z.string().optional(),
  definitions: z.array(HookConfigEntrySchema).optional(),
});

/**
 * Auth configuration section.
 */
export const AuthConfigSchema = z.object({
  enabled: z.boolean(),
  host: z.string(),
  port: z.number().int().positive(),
  session_expiry_days: z.number().nullable().optional(),
});

/**
 * Provider API keys configuration.
 */
export const ProvidersConfigSchema = z.record(z.string(), z.string().optional());

/**
 * Provider priority order for role-based resolution.
 */
export const ProviderPrioritySchema = z.array(z.string());

/**
 * Model entry for the models list.
 * Provider is the actual provider name (anthropic, openai, cerebras, etc.)
 * not the canonical adapter (openai-compat).
 */
export const ModelConfigEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  description: z.string().optional(),
  max_tokens: z.number().positive().optional(),
  supports_reasoning: z.boolean().optional(),
});

/**
 * Models configuration section.
 */
export const ModelsConfigSchema = z.object({
  /** List of available models */
  available: z.array(ModelConfigEntrySchema).optional(),
  /** Default model ID to use */
  default: z.string().optional(),
});

// ============================================
// ROOT CONFIG (RAW FROM FILE)
// ============================================

/**
 * Root structure of harness_config.json.
 */
export const HarnessConfigFileSchema = z.object({
  providers: ProvidersConfigSchema.optional(),
  provider_priority: ProviderPrioritySchema.optional(),
  models: ModelsConfigSchema.optional(),
  agents: z.record(z.string(), AgentConfigEntrySchema),
  tools: ToolsConfigSchema.optional(),
  graphd: GraphDConfigSchema.optional(),
  context: ContextConfigSchema.optional(),
  skills: SkillsConfigSchema.optional(),
  hooks: HooksConfigSchema.optional(),
  auth: AuthConfigSchema.optional(),
});

// ============================================
// INFERRED TYPES (RAW)
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
export type AuthConfigSection = z.infer<typeof AuthConfigSchema>;
export type ProvidersConfigSection = z.infer<typeof ProvidersConfigSchema>;
export type ProviderPriority = z.infer<typeof ProviderPrioritySchema>;
export type ModelConfigEntry = z.infer<typeof ModelConfigEntrySchema>;
export type ModelsConfigSection = z.infer<typeof ModelsConfigSchema>;
export type HarnessConfigFile = z.infer<typeof HarnessConfigFileSchema>;

// ============================================
// VALIDATION HELPERS
// ============================================

/**
 * Re-export central provider helpers for backwards compatibility.
 */
export const OPENAI_COMPAT_PROVIDERS = CENTRAL_OPENAI_COMPAT_PROVIDERS;
export const isSupportedProvider = centralIsSupportedProvider;
export const isOpenAICompatProvider = centralIsOpenAICompatProvider;
export const getCanonicalProvider = centralGetCanonicalProvider;

/**
 * Normalize reasoning effort, validating against provider constraints.
 */
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

/**
 * Extract reasoning effort from config (handles string or object).
 */
export function extractReasoningEffort(
  reasoning?: AgentReasoningConfig
): string | undefined {
  if (!reasoning) return undefined;
  if (typeof reasoning === 'string') return reasoning;
  return reasoning.effort;
}
