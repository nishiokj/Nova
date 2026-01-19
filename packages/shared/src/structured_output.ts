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
  OUTPUT_SCHEMAS,
  type OutputSchemaName,
} from './output_schemas.js';

// Re-export schema types and functions
export {
  parseAgentOutput,
  isValidOutput,
  getOutputSchema,
  OUTPUT_SCHEMAS,
  type OutputSchemaName,
};

// Re-export all inferred types
export type {
  UserPromptOption,
  UserPrompt,
  AgentAction,
  AgentActionOutput,
  GoalDrivenOutput,
  Artifact,
  ExplorerOutput,
  WorkItemOutput,
  RuntimeScriptOutput,
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

function extractJsonFromFence(value: string): Record<string, unknown> | null {
  const fenceMatch = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (!fenceMatch) return null;
  const candidate = fenceMatch[1]?.trim();
  if (!candidate) return null;
  return tryParseJson(candidate) ?? findFirstJsonObject(candidate);
}

function findFirstJsonObject(value: string): Record<string, unknown> | null {
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
        if (parsed) return parsed;
        start = -1;
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

  // Then validate against schema
  return parseAgentOutput(schemaName, coerced);
}
