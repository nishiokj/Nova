/**
 * Zod schemas for agent structured output validation.
 *
 * These schemas are the source of truth. JSON schema for LLM
 * structured output is derived from these at runtime.
 */

import { z, toJSONSchema } from 'zod';

// ============================================
// OUTPUT SCHEMAS
// ============================================

/**
 * Action enum - what execution agents can do next.
 * Valid actions for agent structured output.
 */
export const AgentActionSchema = z.enum(['done', 'continue']);

/**
 * Routing output - used by the router agent.
 */
export const RoutingOutputSchema = z.object({
  tier: z.enum(['simple', 'standard', 'complex']),
}).strict();

// --------------------------------------------
// Base action outputs (explicit state handling)
// --------------------------------------------

const DoneOutputSchema = z.object({
  action: z.literal('done'),
  response: z.string(),
  goalStateReached: z.literal(true),
  awaitingUserInput: z.literal(false),
}).strict();

const ContinueOutputSchema = z.object({
  action: z.literal('continue'),
  response: z.string(),
  goalStateReached: z.literal(false),
  awaitingUserInput: z.literal(false),
}).strict();

/**
 * Base agent action output - common fields for all action-based agents.
 * Explicitly enumerates all valid state combinations.
 */
export const AgentActionOutputSchema = z.union([
  DoneOutputSchema,
  ContinueOutputSchema,
]);

/**
 * Goal-driven agent output - extends agent action with work tracking.
 */
export const GoalDrivenOutputSchema = z.union([
  DoneOutputSchema.extend({ work_done: z.string() }).strict(),
  ContinueOutputSchema.extend({ work_done: z.string() }).strict(),
]);

/**
 * Code artifact from explorer agent.
 * Rich semantic extraction that enables downstream agents to act without re-reading files.
 */
export const ArtifactSchema = z.object({
  sourcePath: z.string().describe('File path where this artifact was found'),
  line: z.number().int().nullable().describe('Line number for navigation'),
  kind: z.enum([
    'function',
    'class',
    'interface',
    'import',
    'export',
    'constant',
    'pattern',
    'summary',
  ]).describe('What type of code construct this represents'),
  name: z.string().describe('Name of the artifact (function name, class name, etc.)'),
  signature: z.string().nullable().describe(
    "Full type signature (e.g., 'async run(params: RunParams): Promise<Result>')"
  ),
  modifies: z.array(z.string()).nullable().describe(
    'Side effects: state, files, globals this touches (e.g., ["this._items", "fs:config.json", "db:users"])'
  ),
  calls: z.array(z.string()).nullable().describe(
    'Call graph: significant functions this invokes (e.g., ["llm.complete", "tools.execute"])'
  ),
  insight: z.string().nullable().describe(
    'Non-obvious info NOT derivable from name/signature (e.g., "Retries 3x with exponential backoff")'
  ),
  reduces: z.enum(['structural', 'relational', 'behavioral', 'contractual']).describe(
    'Which uncertainty category this artifact reduces: structural (what exists), relational (what connects), behavioral (what happens), contractual (what is promised)'
  ),
}).strict();

/**
 * Explorer agent output - discovers codebase structure and artifacts.
 */
export const ExplorerOutputSchema = z.union([
  DoneOutputSchema.extend({
    packageManagers: z.array(z.string()),
    frameworks: z.array(z.string()),
    languages: z.array(z.string()),
    os: z.string(),
    artifacts: z.array(ArtifactSchema).describe('Semantic code artifacts extracted from source files'),
  }).strict(),
  ContinueOutputSchema.extend({
    packageManagers: z.array(z.string()),
    frameworks: z.array(z.string()),
    languages: z.array(z.string()),
    os: z.string(),
    artifacts: z.array(ArtifactSchema).describe('Semantic code artifacts extracted from source files'),
  }).strict(),
]);

/**
 * Work item from runtime script agent.
 */
export const WorkItemOutputSchema = z.object({
  id: z.string(),
  objective: z.string(),
  delta: z.string(),
  agent: z.string(),
  dependencies: z.array(z.string()),
  toolHint: z.string().nullable(),
  targetPaths: z.array(z.string()).nullable(),
  params: z.record(z.string(), z.unknown()).nullable(),
}).strict();

/**
 * Runtime script agent output - creates execution plans.
 */
export const RuntimeScriptOutputSchema = z.union([
  DoneOutputSchema.extend({
    goal: z.string(),
    workItems: z.array(WorkItemOutputSchema),
  }).strict(),
  ContinueOutputSchema.extend({
    goal: z.string(),
    workItems: z.array(WorkItemOutputSchema),
  }).strict(),
]);

/**
 * Planner output schema (planning agent).
 */
export const PlannerOutputSchema = z.union([
  DoneOutputSchema,
  ContinueOutputSchema,
]);

// ============================================
// SCHEMA REGISTRY
// ============================================

/**
 * Registry mapping schema names to Zod schemas.
 */
export const OUTPUT_SCHEMAS = {
  routing: RoutingOutputSchema,
  agent_action: AgentActionOutputSchema,
  goal_driven: GoalDrivenOutputSchema,
  explorer: ExplorerOutputSchema,
  runtime_script: RuntimeScriptOutputSchema,
  planner_output: PlannerOutputSchema,
} as const;

export type OutputSchemaName = keyof typeof OUTPUT_SCHEMAS;

// ============================================
// INFERRED TYPES
// ============================================

export type RoutingOutput = z.infer<typeof RoutingOutputSchema>;
export type AgentAction = z.infer<typeof AgentActionSchema>;
export type AgentActionOutput = z.infer<typeof AgentActionOutputSchema>;
export type GoalDrivenOutput = z.infer<typeof GoalDrivenOutputSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ExplorerOutput = z.infer<typeof ExplorerOutputSchema>;
export type WorkItemOutput = z.infer<typeof WorkItemOutputSchema>;
export type RuntimeScriptOutput = z.infer<typeof RuntimeScriptOutputSchema>;
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

// ============================================
// JSON SCHEMA CONVERSION
// ============================================

type JsonSchema = Record<string, unknown>;

function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const jsonSchema = toJSONSchema(schema) as JsonSchema;
  // Keep shared schemas provider-agnostic. Provider adapters can apply
  // compatibility transforms for their own JSON Schema subsets.
  const { $schema: _draft, ...withoutDraftMeta } = jsonSchema;
  return withoutDraftMeta;
}

/**
 * Unwrap structured output that was wrapped in a "result" envelope.
 * If the output has a "result" key and nothing else meaningful, return its contents.
 * Safe to call on any output - returns as-is if not wrapped.
 */
export function unwrapStructuredOutput(output: Record<string, unknown>): Record<string, unknown> {
  if ('result' in output && typeof output.result === 'object' && output.result !== null) {
    const keys = Object.keys(output);
    if (keys.length === 1) {
      return output.result as Record<string, unknown>;
    }
  }
  return output;
}

export function getOutputSchemaJson(
  schemaName: OutputSchemaName
): { name: string; schema: JsonSchema; strict: boolean; schemaId: OutputSchemaName } | undefined {
  const schema = OUTPUT_SCHEMAS[schemaName];
  if (!schema) return undefined;

  return {
    name: schemaName,
    schema: zodToJsonSchema(schema),
    strict: true,
    schemaId: schemaName,
  };
}

// ============================================
// VALIDATION FUNCTIONS
// ============================================

/**
 * Parse and validate agent output against a named schema.
 * Returns null on validation failure (with logged warning).
 */
export function parseAgentOutput<T extends OutputSchemaName>(
  schemaName: T,
  rawOutput: unknown
): z.output<(typeof OUTPUT_SCHEMAS)[T]> | null {
  const schema = OUTPUT_SCHEMAS[schemaName];
  if (!schema) {
    console.warn(`[output] Unknown schema: ${schemaName}`);
    return null;
  }

  const result = schema.safeParse(rawOutput);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    console.warn(`[output] Validation failed for ${schemaName}: ${issues}`);
    return null;
  }

  return result.data as z.output<(typeof OUTPUT_SCHEMAS)[T]>;
}

/**
 * Check if output matches a schema without returning the parsed value.
 */
export function isValidOutput(schemaName: OutputSchemaName, output: unknown): boolean {
  const schema = OUTPUT_SCHEMAS[schemaName];
  if (!schema) return false;
  return schema.safeParse(output).success;
}

/**
 * Get the Zod schema for a named output schema.
 */
export function getOutputSchema(schemaName: OutputSchemaName): z.ZodType | undefined {
  return OUTPUT_SCHEMAS[schemaName];
}
