const fs = require('fs');
const z = require('zod');

const AgentReasoningConfigSchema = z.object({
  effort: z.string().optional()
}).optional();

const AgentFallbackConfigSchema = z.object({
  provider: z.string().optional(),
  model: z.string(),
  api_base: z.string().optional()
}).optional();

const AgentLLMConfigSchema = z.object({
  provider: z.string().optional(),
  model: z.string(),
  max_tokens: z.number().positive(),
  temperature: z.number().min(0).max(2).optional(),
  api_base: z.string().optional(),
  reasoning: AgentReasoningConfigSchema.optional(),
  fallback: AgentFallbackConfigSchema.optional(),
});

const AgentBudgetConfigSchema = z.object({
  max_iterations: z.number().positive().int(),
  max_tool_calls: z.number().nonnegative().int(),
  max_duration_ms: z.number().positive(),
});

const AgentConfigEntrySchema = z.object({
  llm: AgentLLMConfigSchema,
  budget: AgentBudgetConfigSchema,
  tools: z.array(z.string()).optional(),
  output_schema: z.union([z.string(), z.object({name: z.string(), schema: z.record(z.string(), z.unknown())})]).optional(),
});

const HarnessConfigFileSchema = z.object({
  providers: z.record(z.string(), z.string()).optional(),
  models: z.object({available: z.array(z.unknown()).optional(), default: z.string().optional()}).optional(),
  agents: z.record(z.string(), AgentConfigEntrySchema),
  tools: z.object({bash_timeout_ms: z.number().optional(), max_output_length: z.number().optional()}).optional(),
  graphd: z.object({enabled: z.boolean().optional(), host: z.string().optional(), port: z.number().optional(), db_path: z.string().optional()}).optional(),
  context: z.object({max_tokens: z.number().optional()}).optional(),
  skills: z.object({enabled: z.boolean().optional(), directory: z.string().optional()}).optional(),
  hooks: z.object({enabled: z.boolean().optional(), directory: z.string().optional()}).optional(),
  auth: z.object({enabled: z.boolean().optional(), host: z.string().optional(), port: z.number().optional(), session_expiry_days: z.number().nullable().optional()}).optional(),
});

const content = fs.readFileSync(process.argv[2], 'utf-8');
const json = JSON.parse(content);

function stripComments(obj) {
  if (Array.isArray(obj)) return obj.map(stripComments);
  if (typeof obj === 'object' && obj !== null) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === '$comment' || key === '$schema') continue;
      result[key] = stripComments(value);
    }
    return result;
  }
  return obj;
}

const stripped = stripComments(json);
const result = HarnessConfigFileSchema.safeParse(stripped);
if (result.success) {
  console.log('Schema validation passed');
  console.log('Agents:', Object.keys(result.data.agents));
} else {
  console.log('Schema validation FAILED:');
  console.log(JSON.stringify(result.error.issues, null, 2));
}
