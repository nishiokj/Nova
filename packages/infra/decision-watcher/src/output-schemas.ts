import { z, toJSONSchema } from 'zod';
import { coerceStructuredOutput } from 'shared';
import {
  WATCHER_ACTION_VALUES,
  WATCHER_NO_INTERVENTION_ACTION_VALUES,
  isWatcherActionType,
  type WatcherActionType,
} from 'shared';
import type { AgentConfig } from 'agent';
import { SemanticOutputSchema } from './semantic/schemas.js';

const WatcherActionTypeSchema = z.enum(WATCHER_ACTION_VALUES);
const WatcherNoInterventionSchema = z.enum(WATCHER_NO_INTERVENTION_ACTION_VALUES);

const WatcherSemanticBatchEntrySchema = z.object({
  workId: z.string(),
  semantic: SemanticOutputSchema,
}).strict();

const WatcherSemanticBatchSchema = z.array(WatcherSemanticBatchEntrySchema).min(1);

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
  semantic: SemanticOutputSchema.optional(),
  semantics: WatcherSemanticBatchSchema.optional(),
}).strict();

const WatcherRealignSchema = WatcherBaseSchema.extend({
  action: z.literal('done'),
  goalStateReached: z.literal(true),
  watcherAction: z.literal('realign'),
  realign: z.object({
    systemMessage: z.string(),
    newGoal: z.string().nullable().optional(),
  }).strict(),
  semantic: SemanticOutputSchema.optional(),
  semantics: WatcherSemanticBatchSchema.optional(),
}).strict();

const WatcherWorkItemSchema = z.object({
  id: z.string().min(1).optional(),
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
}).strict();

const WatcherSplitSchema = WatcherBaseSchema.extend({
  action: z.literal('done'),
  goalStateReached: z.literal(true),
  watcherAction: z.literal('split'),
  workItems: z.array(WatcherWorkItemSchema).min(1),
  semantic: SemanticOutputSchema.optional(),
  semantics: WatcherSemanticBatchSchema.optional(),
}).strict();

const WatcherCreateWorkItemSchema = WatcherBaseSchema.extend({
  action: z.literal('done'),
  goalStateReached: z.literal(true),
  watcherAction: z.literal('create_work_item'),
  workItems: z.array(WatcherWorkItemSchema).min(1),
  semantic: SemanticOutputSchema.optional(),
  semantics: WatcherSemanticBatchSchema.optional(),
}).strict();

const WatcherQualityGateSchema = WatcherBaseSchema.extend({
  action: z.literal('done'),
  goalStateReached: z.literal(true),
  watcherAction: z.literal('quality_gate'),
  qualityGate: z.object({
    passed: z.boolean(),
    issues: z.array(z.string()).optional(),
  }).strict(),
  semantic: SemanticOutputSchema.optional(),
  semantics: WatcherSemanticBatchSchema.optional(),
}).strict();

const WatcherStopWorkItemSchema = WatcherBaseSchema.extend({
  action: z.literal('done'),
  goalStateReached: z.literal(true),
  watcherAction: z.literal('stop_work_item'),
  escalationId: z.string().optional(),
  semantic: SemanticOutputSchema.optional(),
  semantics: WatcherSemanticBatchSchema.optional(),
}).strict();

const WatcherContinueDecisionSchema = WatcherBaseSchema.extend({
  action: z.literal('done'),
  goalStateReached: z.literal(true),
  watcherAction: WatcherNoInterventionSchema,
  semantic: SemanticOutputSchema.optional(),
  semantics: WatcherSemanticBatchSchema.optional(),
}).strict();

export const WatcherActionOutputSchema = z.union([
  WatcherAnswerSchema,
  WatcherRealignSchema,
  WatcherSplitSchema,
  WatcherCreateWorkItemSchema,
  WatcherStopWorkItemSchema,
  WatcherQualityGateSchema,
  WatcherContinueDecisionSchema,
]);

/**
 * Map from action type to Zod schema.
 * "allow" and "continue" map to the same no-intervention schema.
 */
const WATCHER_ACTION_SCHEMAS: Record<WatcherActionType, z.ZodType[]> = {
  answer: [WatcherAnswerSchema],
  realign: [WatcherRealignSchema],
  split: [WatcherSplitSchema],
  create_work_item: [WatcherCreateWorkItemSchema],
  stop_work_item: [WatcherStopWorkItemSchema],
  quality_gate: [WatcherQualityGateSchema],
  allow: [WatcherContinueDecisionSchema],
  continue: [WatcherContinueDecisionSchema],
};

type JsonSchema = Record<string, unknown>;

function normalizeForOpenAI(schema: JsonSchema): JsonSchema {
  const result: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$schema') continue;
    if (key === 'oneOf') {
      result.anyOf = (value as JsonSchema[]).map(normalizeForOpenAI);
    } else if (Array.isArray(value)) {
      result[key] = value.map(v =>
        typeof v === 'object' && v !== null ? normalizeForOpenAI(v as JsonSchema) : v
      );
    } else if (typeof value === 'object' && value !== null) {
      result[key] = normalizeForOpenAI(value as JsonSchema);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function ensureRootObject(schema: JsonSchema): JsonSchema {
  if (schema.type === 'object' && !schema.anyOf && !schema.oneOf && !schema.allOf) {
    return schema;
  }
  return {
    type: 'object',
    properties: { result: schema },
    required: ['result'],
    additionalProperties: false,
  };
}

function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return ensureRootObject(normalizeForOpenAI(toJSONSchema(schema) as JsonSchema));
}

export function buildWatcherSchemaForActions(actions: readonly string[]): z.ZodType {
  const schemas: z.ZodType[] = [];
  const seen = new Set<z.ZodType>();

  for (const action of actions) {
    if (!isWatcherActionType(action)) continue;
    const actionSchemas = WATCHER_ACTION_SCHEMAS[action];
    if (!actionSchemas) continue;
    for (const schema of actionSchemas) {
      if (!seen.has(schema)) {
        seen.add(schema);
        schemas.push(schema);
      }
    }
  }

  if (schemas.length === 0) return WatcherActionOutputSchema;
  if (schemas.length === 1) return schemas[0];
  return z.union(schemas as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

export function getWatcherSchemaJsonForActions(
  actions: readonly string[]
): { name: string; schema: Record<string, unknown>; strict: boolean; schemaId: string } {
  const zodSchema = buildWatcherSchemaForActions(actions);
  return {
    name: `watcher_action_${actions.join('_')}`,
    schema: zodToJsonSchema(zodSchema),
    strict: true,
    schemaId: 'watcher_action',
  };
}

function tryParseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function extractJsonCandidates(content: string): Record<string, unknown>[] {
  if (!content) return [];
  const results: Record<string, unknown>[] = [];

  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(content)) !== null) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    const parsed = tryParseJson(candidate);
    if (parsed) results.push(parsed);
  }

  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        const parsed = tryParseJson(content.slice(start, i + 1));
        if (parsed) results.push(parsed);
        start = -1;
      }
    }
  }

  return results;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return fallback;
}

function inferBooleanFromText(text?: string): boolean | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  const failurePattern = /(not\s+pass|did\s+not|not\s+achiev|not\s+complete|fail|failed|failure)/;
  if (failurePattern.test(lower)) return false;
  const successPattern = /(pass|passed|approve|approved|success|achiev|complete)/;
  if (successPattern.test(lower)) return true;
  return null;
}

function readNestedString(value: Record<string, unknown>, path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : null;
}

function normalizeWatcherActionCandidate(candidate: Record<string, unknown>): Record<string, unknown> | null {
  const actionRaw = typeof candidate.action === 'string'
    ? candidate.action.trim().toLowerCase()
    : '';
  const action = actionRaw === 'done' || actionRaw === 'continue' ? actionRaw : 'done';

  const watcherActionValue = candidate.watcherAction ?? candidate.watcher_action;
  const watcherActionRaw = typeof watcherActionValue === 'string'
    ? watcherActionValue.trim().toLowerCase()
    : '';
  const validWatcherActions = new Set<string>(WATCHER_ACTION_VALUES);
  if (!validWatcherActions.has(watcherActionRaw)) return null;

  const response = typeof candidate.response === 'string' ? candidate.response : '';
  const reason = typeof candidate.reason === 'string' ? candidate.reason : response || 'Watcher decision';

  const awaitingUserInputValue = candidate.awaitingUserInput ?? candidate.awaiting_user_input;
  const goalStateReachedValue = candidate.goalStateReached ?? candidate.goal_state_reached;
  const awaitingUserInput = parseBoolean(awaitingUserInputValue, false);
  const goalStateReachedDefault = action === 'done';
  const goalStateReached = action === 'continue'
    ? false
    : parseBoolean(goalStateReachedValue, goalStateReachedDefault);

  const base: Record<string, unknown> = {
    action,
    response,
    goalStateReached,
    awaitingUserInput,
    watcherAction: watcherActionRaw,
    reason,
  };

  if (candidate.semantic && typeof candidate.semantic === 'object' && !Array.isArray(candidate.semantic)) {
    base.semantic = candidate.semantic;
  }

  switch (watcherActionRaw) {
    case 'answer': {
      const answer = candidate.answer;
      if (typeof answer === 'string') {
        base.answer = { text: answer };
        return base;
      }
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
      const answerText = (answer as Record<string, unknown>).text;
      if (typeof answerText !== 'string' || answerText.length === 0) return null;
      const contextAddendum = (answer as Record<string, unknown>).contextAddendum;
      base.answer = {
        text: answerText,
        ...(typeof contextAddendum === 'string' ? { contextAddendum } : {}),
      };
      return base;
    }
    case 'realign': {
      const realign = candidate.realign;
      if (typeof realign === 'string') {
        base.realign = { systemMessage: realign };
        return base;
      }
      if (!realign || typeof realign !== 'object' || Array.isArray(realign)) return null;
      const systemMessage = (realign as Record<string, unknown>).systemMessage;
      if (typeof systemMessage !== 'string' || systemMessage.length === 0) return null;
      const newGoal = (realign as Record<string, unknown>).newGoal;
      base.realign = {
        systemMessage,
        ...(typeof newGoal === 'string' ? { newGoal } : {}),
      };
      return base;
    }
    case 'split':
    case 'create_work_item': {
      const workItemsValue = candidate.workItems ?? candidate.work_items;
      if (!Array.isArray(workItemsValue) || workItemsValue.length === 0) return null;
      base.workItems = workItemsValue;
      return base;
    }
    case 'quality_gate': {
      const qualityGateValue = candidate.qualityGate ?? candidate.quality_gate;
      if (qualityGateValue && typeof qualityGateValue === 'object' && !Array.isArray(qualityGateValue)) {
        const passed = (qualityGateValue as Record<string, unknown>).passed;
        const passedBool = parseBoolean(passed, false);
        base.qualityGate = {
          passed: passedBool,
          ...(Array.isArray((qualityGateValue as Record<string, unknown>).issues)
            ? { issues: (qualityGateValue as Record<string, unknown>).issues }
            : {}),
        };
        return base;
      }

      const statusText = readNestedString(candidate, ['semantic', 'salienceUpdates', 'workItemStatus']);
      const inferredStatus = inferBooleanFromText(statusText ?? undefined);
      const inferredText = inferBooleanFromText(`${reason} ${response}`);
      const passed = inferredStatus ?? inferredText ?? false;
      base.qualityGate = { passed };
      return base;
    }
    case 'stop_work_item': {
      const escalationIdValue = candidate.escalationId ?? candidate.escalation_id;
      if (typeof escalationIdValue === 'string' && escalationIdValue.length > 0) {
        base.escalationId = escalationIdValue;
      }
      return base;
    }
    case 'allow':
    case 'continue':
      return base;
    default:
      return null;
  }
}

function parseWatcherActionLenient(parsed: Record<string, unknown>, rawContent: string): WatcherActionOutput | null {
  const candidates = [parsed, ...extractJsonCandidates(rawContent)];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const normalized = normalizeWatcherActionCandidate(candidate as Record<string, unknown>);
    if (!normalized) continue;
    const validated = WatcherActionOutputSchema.safeParse(normalized);
    if (validated.success) {
      return validated.data;
    }
  }
  return null;
}

export function parseWatcherOutput(raw: unknown): WatcherActionOutput | null {
  const parsed = coerceStructuredOutput(raw);
  if (!parsed) return null;
  const rawContent = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return parseWatcherActionLenient(parsed, rawContent);
}

export function buildWatcherParseOutput(): AgentConfig['parseOutput'] {
  return (parsed: Record<string, unknown>, rawContent: string) => {
    const normalized = parseWatcherActionLenient(parsed, rawContent);
    return normalized ?? null;
  };
}

export const WATCHER_SCHEMA_REMINDER =
  '[SCHEMA REMINDER] For watcher_action output, you MUST return JSON with: action ("done" only), goalStateReached (true), awaitingUserInput (always false), response (short summary), watcherAction (answer|realign|split|create_work_item|stop_work_item|quality_gate|allow|continue), reason (always required). Include only the payload for your watcherAction. Do NOT include handoffSpec.';

export const PLANNER_SCHEMA_REMINDER =
  '[SCHEMA REMINDER] You must set action, goalStateReached, awaitingUserInput, and handoffSpec every turn. Valid actions: "done", "continue", "handoff". If you need user input, call PromptUser then action="done", goalStateReached=false, awaitingUserInput=true, handoffSpec=null. For handoff, handoffSpec must be a structured object.';

export type WatcherActionOutput = z.infer<typeof WatcherActionOutputSchema>;
