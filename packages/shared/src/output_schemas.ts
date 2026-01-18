/**
 * Zod schemas for agent structured output validation.
 *
 * These schemas mirror config/output_schemas.json and provide runtime
 * validation for LLM structured output responses.
 */

import { z } from 'zod';

// ============================================
// SHARED COMPONENTS
// ============================================

/**
 * Option in a user prompt - can be a string or object with label/description.
 */
export const UserPromptOptionSchema = z.union([
  z.string(),
  z.object({
    label: z.string(),
    description: z.string().nullable(),
  }),
]);

/**
 * Single question structure for asking questions.
 */
export const SingleQuestionSchema = z.object({
  question: z.string(),
  options: z.array(UserPromptOptionSchema).nullable(),
  context: z.string().nullable(),
  multiSelect: z.boolean().nullable(),
});

/**
 * User prompt structure for asking questions.
 * Supports single question (backwards compatible) or multiple questions.
 */
export const UserPromptSchema = z.object({
  /** Single question (backwards compatible) */
  question: z.string().nullable(),
  options: z.array(UserPromptOptionSchema).nullable(),
  context: z.string().nullable(),
  multiSelect: z.boolean().nullable(),
  /** Multiple questions to ask in sequence */
  questions: z.array(SingleQuestionSchema).nullable(),
});

// ============================================
// OUTPUT SCHEMAS
// ============================================

/**
 * Routing agent output - determines request complexity tier.
 */
export const RoutingOutputSchema = z.object({
  tier: z.enum(['simple', 'standard', 'complex']),
});

/**
 * Action enum - what the agent wants to do next.
 */
export const AgentActionSchema = z.enum(['done', 'need_user_input', 'continue']);

/**
 * Base agent action output - common fields for all action-based agents.
 */
export const AgentActionOutputSchema = z.object({
  action: AgentActionSchema,
  response: z.string().nullable(),
  goalStateReached: z.boolean().nullable(),
  userPrompt: UserPromptSchema.nullable(),
});

/**
 * Goal-driven agent output - extends agent action with work tracking.
 */
export const GoalDrivenOutputSchema = AgentActionOutputSchema.extend({
  work_done: z.string().nullable().describe(
    'Concrete work completed this turn: files read, edits made, commands run. NOT plans or intentions.'
  ),
});

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
  reduces: z.enum(['structural', 'relational', 'behavioral', 'contractual']).nullable().describe(
    'Which uncertainty category this artifact reduces: structural (what exists), relational (what connects), behavioral (what happens), contractual (what is promised)'
  ),
});

/**
 * Explorer agent output - discovers codebase structure and artifacts.
 */
export const ExplorerOutputSchema = AgentActionOutputSchema.extend({
  packageManagers: z.array(z.string()),
  frameworks: z.array(z.string()),
  languages: z.array(z.string()),
  os: z.string(),
  artifacts: z.array(ArtifactSchema).describe('Semantic code artifacts extracted from source files'),
});

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
  params: z.record(z.unknown()).nullable(),
});

/**
 * Runtime script agent output - creates execution plans.
 */
export const RuntimeScriptOutputSchema = AgentActionOutputSchema.extend({
  goal: z.string(),
  workItems: z.array(WorkItemOutputSchema),
});

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
} as const;

export type OutputSchemaName = keyof typeof OUTPUT_SCHEMAS;

// ============================================
// INFERRED TYPES
// ============================================

export type UserPromptOption = z.infer<typeof UserPromptOptionSchema>;
export type SingleQuestion = z.infer<typeof SingleQuestionSchema>;
export type UserPrompt = z.infer<typeof UserPromptSchema>;
export type RoutingOutput = z.infer<typeof RoutingOutputSchema>;
export type AgentAction = z.infer<typeof AgentActionSchema>;
export type AgentActionOutput = z.infer<typeof AgentActionOutputSchema>;
export type GoalDrivenOutput = z.infer<typeof GoalDrivenOutputSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ExplorerOutput = z.infer<typeof ExplorerOutputSchema>;
export type WorkItemOutput = z.infer<typeof WorkItemOutputSchema>;
export type RuntimeScriptOutput = z.infer<typeof RuntimeScriptOutputSchema>;

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
