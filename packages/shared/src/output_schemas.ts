/**
 * Zod schemas for agent structured output validation.
 *
 * These schemas are the source of truth. JSON schema for LLM
 * structured output is derived from these at runtime.
 */

import { z } from 'zod';

// ============================================
// OUTPUT SCHEMAS
// ============================================

/**
 * Action enum - what the agent wants to do next.
 */
export const AgentActionSchema = z.enum(['done', 'continue', 'handoff']);

/**
 * Routing output - used by the router agent.
 */
export const RoutingOutputSchema = z.object({
  tier: z.enum(['simple', 'standard', 'complex']),
}).strict();

// --------------------------------------------
// Base action outputs (explicit state handling)
// --------------------------------------------

const HandoffWorkItemSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  delta: z.string().min(1),
  agent: z.string().min(1),
  domain: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  targetPaths: z.array(z.string()).optional(),
}).strict();

const HandoffSpecSchema = z.object({
  goal: z.string().min(1),
  context: z.string().min(1),
  workItems: z.array(HandoffWorkItemSchema).min(1),
}).strict();

const DoneOutputSchema = z.object({
  action: z.literal('done'),
  response: z.string(),
  goalStateReached: z.literal(true),
  handoffSpec: z.null(),
  awaitingUserInput: z.literal(false),
}).strict();

const AwaitingUserInputOutputSchema = z.object({
  action: z.literal('done'),
  response: z.string(),
  goalStateReached: z.literal(false),
  handoffSpec: z.null(),
  awaitingUserInput: z.literal(true),
}).strict();

const ContinueOutputSchema = z.object({
  action: z.literal('continue'),
  response: z.string(),
  goalStateReached: z.literal(false),
  handoffSpec: z.null(),
  awaitingUserInput: z.literal(false),
}).strict();

const HandoffOutputSchema = z.object({
  action: z.literal('handoff'),
  response: z.string(),
  goalStateReached: z.literal(true),
  handoffSpec: HandoffSpecSchema,
  awaitingUserInput: z.literal(false),
}).strict();

/**
 * Base agent action output - common fields for all action-based agents.
 * Explicitly enumerates all valid state combinations.
 */
export const AgentActionOutputSchema = z.union([
  DoneOutputSchema,
  AwaitingUserInputOutputSchema,
  ContinueOutputSchema,
  HandoffOutputSchema,
]);

/**
 * Goal-driven agent output - extends agent action with work tracking.
 */
export const GoalDrivenOutputSchema = z.union([
  DoneOutputSchema.extend({ work_done: z.string() }).strict(),
  AwaitingUserInputOutputSchema.extend({ work_done: z.string() }).strict(),
  ContinueOutputSchema.extend({ work_done: z.string() }).strict(),
  HandoffOutputSchema.extend({ work_done: z.string() }).strict(),
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
  AwaitingUserInputOutputSchema.extend({
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
  HandoffOutputSchema.extend({
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
  params: z.record(z.unknown()).nullable(),
}).strict();

/**
 * Runtime script agent output - creates execution plans.
 */
export const RuntimeScriptOutputSchema = z.union([
  DoneOutputSchema.extend({
    goal: z.string(),
    workItems: z.array(WorkItemOutputSchema),
  }).strict(),
  AwaitingUserInputOutputSchema.extend({
    goal: z.string(),
    workItems: z.array(WorkItemOutputSchema),
  }).strict(),
  ContinueOutputSchema.extend({
    goal: z.string(),
    workItems: z.array(WorkItemOutputSchema),
  }).strict(),
  HandoffOutputSchema.extend({
    goal: z.string(),
    workItems: z.array(WorkItemOutputSchema),
  }).strict(),
]);

// --------------------------------------------
// Watcher output schema (explicit action states)
// --------------------------------------------

const WatcherActionTypeSchema = z.enum([
  'answer',
  'realign',
  'split',
  'create_work_item',
  'quality_gate',
  'continue',
]);

// --------------------------------------------
// Semantic output schema (produced during cadence audits)
// --------------------------------------------

const SemanticComponentStatusSchema = z.object({
  component: z.string(),
  status: z.enum(['complete', 'partial', 'not_started', 'blocked']),
  location: z.string().optional(),
});

const SemanticChangeEntrySchema = z.object({
  file: z.string(),
  summary: z.string(),
  rationale: z.string(),
});

const SemanticGapEntrySchema = z.object({
  required: z.string(),
  current: z.string(),
  blocker: z.string().optional(),
});

const SemanticTradeoffOptionSchema = z.object({
  id: z.string(),
  description: z.string(),
});

const SemanticTradeoffAnalysisSchema = z.object({
  title: z.string(),
  options: z.array(SemanticTradeoffOptionSchema).min(2),
  considerations: z.array(z.string()),
  relevantPreferences: z.array(z.string()),
  precedent: z.string().optional(),
  assessment: z.string().optional(),
});

const SemanticStateAndProgressSchema = z.object({
  objective: z.string(),
  currentState: z.array(SemanticComponentStatusSchema),
  changesMade: z.array(SemanticChangeEntrySchema),
  gapAnalysis: z.array(SemanticGapEntrySchema),
  reasoningTrace: z.array(z.string()),
  blockers: z.array(z.string()),
});

const SemanticDecisionContextSchema = z.object({
  pendingQuestions: z.array(z.string()),
  tradeoffs: z.array(SemanticTradeoffAnalysisSchema),
});

const SemanticCrossReferencesSchema = z.object({
  sessionSalience: z.string().optional(),
  preferences: z.array(z.string()),
  siblingWorkItems: z.array(z.string()),
  decisions: z.array(z.string()),
});

const SemanticSalienceUpdatesSchema = z.object({
  workItemStatus: z.string(),
  patterns: z.array(z.string()).optional(),
  abstractionsInPlay: z.array(z.string()).optional(),
});

/**
 * Semantic output schema - produced during cadence audits.
 * Contains semantic understanding of workItem state for context injection.
 */
export const WatcherSemanticOutputSchema = z.object({
  meta: z.object({
    auditSequence: z.number().int().min(0),
    logPosition: z.number().int().min(0),
    totalEvents: z.number().int().min(0),
  }),
  stateAndProgress: SemanticStateAndProgressSchema,
  decisionContext: SemanticDecisionContextSchema,
  crossReferences: SemanticCrossReferencesSchema,
  salienceUpdates: SemanticSalienceUpdatesSchema.optional(),
});

export type WatcherSemanticOutput = z.infer<typeof WatcherSemanticOutputSchema>;

// --------------------------------------------
// Watcher base and action schemas
// --------------------------------------------

const WatcherBaseSchema = z.object({
  action: z.enum(['done', 'continue']),
  response: z.string(),
  goalStateReached: z.boolean(),
  awaitingUserInput: z.literal(false),
  watcherAction: WatcherActionTypeSchema,
  reason: z.string(),
});

const WatcherAnswerSchema = WatcherBaseSchema.extend({
  action: z.literal('done'),
  goalStateReached: z.literal(true),
  watcherAction: z.literal('answer'),
  answer: z.object({
    text: z.string(),
    contextAddendum: z.string().nullable().optional(),
  }).strict(),
}).strict();

const WatcherRealignSchema = WatcherBaseSchema.extend({
  action: z.literal('done'),
  goalStateReached: z.literal(true),
  watcherAction: z.literal('realign'),
  realign: z.object({
    systemMessage: z.string(),
    newGoal: z.string().nullable().optional(),
  }).strict(),
  semantic: WatcherSemanticOutputSchema.optional(),
}).strict();

const WatcherSplitSchema = WatcherBaseSchema.extend({
  action: z.literal('done'),
  goalStateReached: z.literal(true),
  watcherAction: z.literal('split'),
  workItems: z.array(z.object({
    goal: z.string(),
    objective: z.string(),
    agent: z.string(),
    domain: z.string().optional(),
    dependencies: z.array(z.string()).optional(),
    targetPaths: z.array(z.string()).optional(),
    bounds: z.object({
      maxToolCalls: z.number().optional(),
      maxLlmCalls: z.number().optional(),
      maxDurationMs: z.number().optional(),
    }).optional(),
  }).strict()).min(1),
  semantic: WatcherSemanticOutputSchema.optional(),
}).strict();

const WatcherCreateWorkItemSchema = WatcherBaseSchema.extend({
  action: z.literal('done'),
  goalStateReached: z.literal(true),
  watcherAction: z.literal('create_work_item'),
  workItems: z.array(z.object({
    goal: z.string(),
    objective: z.string(),
    agent: z.string(),
    domain: z.string().optional(),
    dependencies: z.array(z.string()).optional(),
    targetPaths: z.array(z.string()).optional(),
    bounds: z.object({
      maxToolCalls: z.number().optional(),
      maxLlmCalls: z.number().optional(),
      maxDurationMs: z.number().optional(),
    }).optional(),
  }).strict()).min(1),
  semantic: WatcherSemanticOutputSchema.optional(),
}).strict();

const WatcherQualityGateSchema = WatcherBaseSchema.extend({
  action: z.literal('done'),
  goalStateReached: z.literal(true),
  watcherAction: z.literal('quality_gate'),
  qualityGate: z.object({
    passed: z.boolean(),
    issues: z.array(z.string()).optional(),
  }).strict(),
}).strict();

const WatcherContinueDecisionSchema = WatcherBaseSchema.extend({
  action: z.literal('done'),
  goalStateReached: z.literal(true),
  watcherAction: z.literal('continue'),
  semantic: WatcherSemanticOutputSchema.optional(),
}).strict();

const WatcherContinueWorkingSchema = WatcherBaseSchema.extend({
  action: z.literal('continue'),
  goalStateReached: z.literal(false),
  watcherAction: z.literal('continue'),
  semantic: WatcherSemanticOutputSchema.optional(),
}).strict();

export const WatcherActionOutputSchema = z.union([
  WatcherAnswerSchema,
  WatcherRealignSchema,
  WatcherSplitSchema,
  WatcherCreateWorkItemSchema,
  WatcherQualityGateSchema,
  WatcherContinueDecisionSchema,
  WatcherContinueWorkingSchema,
]);

/**
 * Planner output schema (planning agent). Same state model as AgentActionOutput.
 */
export const PlannerOutputSchema = AgentActionOutputSchema;

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
  watcher_action: WatcherActionOutputSchema,
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
export type WatcherActionOutput = z.infer<typeof WatcherActionOutputSchema>;
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

// ============================================
// JSON SCHEMA CONVERSION
// ============================================

type JsonSchema = Record<string, unknown>;

function addDescription(schema: JsonSchema, zodSchema: z.ZodTypeAny): JsonSchema {
  const description = zodSchema.description;
  if (!description) return schema;
  return { ...schema, description };
}

function unwrapOptional(schema: z.ZodTypeAny): { schema: z.ZodTypeAny; optional: boolean } {
  let current = schema;
  let optional = false;

  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
    optional = true;
    const inner = (current as z.ZodOptional<z.ZodTypeAny>)._def.innerType
      ?? (current as z.ZodDefault<z.ZodTypeAny>)._def.innerType;
    current = inner ?? current;
  }

  return { schema: current, optional };
}

function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodObject) {
    const shape = typeof schema._def.shape === 'function' ? schema._def.shape() : schema._def.shape;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const key of Object.keys(shape)) {
      const { schema: inner, optional } = unwrapOptional(shape[key]);
      properties[key] = zodToJsonSchema(inner);
      if (!optional) required.push(key);
    }

    const additionalProperties = schema._def.unknownKeys === 'strict' ? false : true;

    const base: JsonSchema = {
      type: 'object',
      properties,
      additionalProperties,
    };

    if (required.length > 0) {
      base.required = required;
    }

    return addDescription(base, schema);
  }

  if (schema instanceof z.ZodString) {
    const base: JsonSchema = { type: 'string' };
    for (const check of schema._def.checks) {
      if (check.kind === 'min') base.minLength = check.value;
      if (check.kind === 'max') base.maxLength = check.value;
    }
    return addDescription(base, schema);
  }

  if (schema instanceof z.ZodNumber) {
    const base: JsonSchema = { type: 'number' };
    for (const check of schema._def.checks) {
      if (check.kind === 'int') {
        base.type = 'integer';
      } else if (check.kind === 'min') {
        base.minimum = check.value;
      } else if (check.kind === 'max') {
        base.maximum = check.value;
      }
    }
    return addDescription(base, schema);
  }

  if (schema instanceof z.ZodBoolean) {
    return addDescription({ type: 'boolean' }, schema);
  }

  if (schema instanceof z.ZodNull) {
    return addDescription({ type: 'null' }, schema);
  }

  if (schema instanceof z.ZodLiteral) {
    const value = schema._def.value;
    const type = value === null ? 'null' : typeof value;
    return addDescription({ const: value, type }, schema);
  }

  if (schema instanceof z.ZodEnum) {
    return addDescription({ type: 'string', enum: schema._def.values }, schema);
  }

  if (schema instanceof z.ZodArray) {
    const base: JsonSchema = {
      type: 'array',
      items: zodToJsonSchema(schema._def.type),
    };
    if (schema._def.minLength) {
      base.minItems = schema._def.minLength.value;
    }
    if (schema._def.maxLength) {
      base.maxItems = schema._def.maxLength.value;
    }
    return addDescription(base, schema);
  }

  if (schema instanceof z.ZodUnion) {
    return addDescription({ oneOf: schema._def.options.map(zodToJsonSchema) }, schema);
  }

  if (schema instanceof z.ZodNullable) {
    return addDescription(
      { anyOf: [zodToJsonSchema(schema._def.innerType), { type: 'null' }] },
      schema
    );
  }

  if (schema instanceof z.ZodOptional) {
    return addDescription(zodToJsonSchema(schema._def.innerType), schema);
  }

  if (schema instanceof z.ZodDefault) {
    return addDescription(zodToJsonSchema(schema._def.innerType), schema);
  }

  if (schema instanceof z.ZodEffects) {
    return addDescription(zodToJsonSchema(schema._def.schema), schema);
  }

  console.warn('[output] Unsupported Zod schema type for JSON conversion');
  return addDescription({}, schema);
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
