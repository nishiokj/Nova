/**
 * Validation Spec — contract → behavioral conditions decomposition.
 *
 * Bridges the semantic compiler output (ValidationSpec) to the contract row
 * stored in verification_plan_json.
 */

import type { ValidationSpec, ValidationCondition } from './types.js'

/** Parse a ValidationSpec from the contract's verification_plan_json column. */
export function parseValidationSpec(json: string | null): ValidationSpec | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    if (parsed?.version !== 2) return null
    return parsed as ValidationSpec
  } catch {
    return null
  }
}

/** Serialize a ValidationSpec to JSON for storage. */
export function serializeValidationSpec(spec: ValidationSpec): string {
  return JSON.stringify(spec)
}

/** Build a ValidationSpec from compiler output conditions. */
export function buildValidationSpec(
  conditions: ValidationCondition[],
  compileStatus: ValidationSpec['compileStatus'],
  questions?: ValidationSpec['questions'],
): ValidationSpec {
  return {
    version: 2,
    compiledAt: new Date().toISOString(),
    compileStatus,
    conditions,
    ...(questions && questions.length > 0 ? { questions } : {}),
  }
}

/** Extract condition IDs from a spec. */
export function conditionIds(spec: ValidationSpec): string[] {
  return spec.conditions.map(c => c.id)
}

/** Make sequential condition IDs. */
export function makeConditionId(index: number): string {
  return `cond-${String(index + 1).padStart(3, '0')}`
}
