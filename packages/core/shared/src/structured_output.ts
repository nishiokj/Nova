/**
 * Structured output helpers.
 *
 * Provides light-weight coercion from model output into a JSON object,
 * plus schema-validated parsing via Zod.
 */

import { z } from 'zod';
import {
  parseAgentOutput,
  isValidOutput,
  getOutputSchema,
  getOutputSchemaJson,
  getWatcherSchemaJsonForActions,
  unwrapStructuredOutput,
  OUTPUT_SCHEMAS,
  type OutputSchemaName,
} from './output_schemas.js';
import { WATCHER_ACTION_VALUES } from './watcher_contract.js';

// Re-export schema types and functions
export {
  parseAgentOutput,
  isValidOutput,
  getOutputSchema,
  getOutputSchemaJson,
  getWatcherSchemaJsonForActions,
  unwrapStructuredOutput,
  OUTPUT_SCHEMAS,
  type OutputSchemaName,
};

// Re-export all inferred types
export type {
  RoutingOutput,
  AgentAction,
  AgentActionOutput,
  GoalDrivenOutput,
  Artifact,
  ExplorerOutput,
  WorkItemOutput,
  RuntimeScriptOutput,
  WatcherActionOutput,
  PlannerOutput,
} from './output_schemas.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

function normalizeWatcherActionCandidate(
  candidate: Record<string, unknown>
): Record<string, unknown> | null {
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

function parseWatcherActionLenient(
  parsed: Record<string, unknown>
): Record<string, unknown> | null {
  return normalizeWatcherActionCandidate(parsed);
}

function extractJsonFromFence(value: string): Record<string, unknown> | null {
  const fenceMatch = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (!fenceMatch) return null;
  const candidate = fenceMatch[1]?.trim();
  if (!candidate) return null;
  return tryParseJson(candidate) ?? findFirstJsonObject(candidate);
}

/**
 * Find the start position of the first valid JSON object in a string.
 * Returns -1 if no valid JSON object is found.
 */
function findJsonStartPosition(value: string): number {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];

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
        const candidate = value.slice(start, i + 1);
        const parsed = tryParseJson(candidate);
        if (parsed) return start;
        start = -1;
      }
    }
  }

  return -1;
}

function findFirstJsonObject(value: string): Record<string, unknown> | null {
  const start = findJsonStartPosition(value);
  if (start < 0) return null;

  // Find the matching closing brace
  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let i = start; i < value.length; i++) {
    const ch = value[i];

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
      depth++;
      continue;
    }

    if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        const candidate = value.slice(start, i + 1);
        return tryParseJson(candidate);
      }
    }
  }

  return null;
}

/**
 * Coerce structured output into a JSON object when possible.
 * This is a lightweight function that doesn't validate against a schema.
 */
export function coerceStructuredOutput(
  value: unknown
): Record<string, unknown> | null {
  if (!value) return null;
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  return (
    tryParseJson(trimmed) ??
    extractJsonFromFence(trimmed) ??
    findFirstJsonObject(trimmed)
  );
}

/**
 * Extract text that appears before the JSON object in a string.
 * Useful for LLMs that output prose followed by structured JSON (e.g., GLM).
 * Returns empty string if no pre-JSON text exists or content is pure JSON.
 */
export function extractPreJsonText(content: string): string {
  if (!content || typeof content !== 'string') return '';

  const trimmed = content.trim();
  if (!trimmed) return '';

  // If the content starts with '{', there's no pre-JSON text
  if (trimmed.startsWith('{')) return '';

  // Check for JSON in markdown fence first
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    const fenceStart = trimmed.indexOf('```');
    if (fenceStart > 0) {
      return trimmed.slice(0, fenceStart).trim();
    }
    return '';
  }

  // Find where the JSON object starts
  const jsonStart = findJsonStartPosition(trimmed);
  if (jsonStart > 0) {
    return trimmed.slice(0, jsonStart).trim();
  }

  return '';
}

/**
 * Parse raw text/value and validate against a named schema.
 * First coerces to JSON, then validates with Zod.
 * Returns null on parse/validation failure.
 */
export function parseAndValidateOutput<T extends OutputSchemaName>(
  schemaName: T,
  rawValue: unknown
): z.output<(typeof OUTPUT_SCHEMAS)[T]> | null {
  // First coerce to JSON object
  const coerced = coerceStructuredOutput(rawValue);
  if (!coerced) return null;

  // Unwrap "result" envelope added by zodToJsonSchema for union schemas
  const unwrapped = unwrapStructuredOutput(coerced);

  if (schemaName === 'watcher_action') {
    const lenient = parseWatcherActionLenient(unwrapped);
    if (lenient) {
      return lenient as z.output<(typeof OUTPUT_SCHEMAS)[T]>;
    }
  }

  // Then validate against schema
  return parseAgentOutput(schemaName, unwrapped);
}
