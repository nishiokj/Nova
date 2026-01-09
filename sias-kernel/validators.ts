import type { OnCallOutput, PrincipalOutput, TestingOutput } from './types.js';

export type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; errors: string[] };

const PRINCIPAL_DECISION_TYPES = new Set([
  'continue',
  'adjust_objective',
  'escalate',
  'approve_upgrade',
  'rollback',
  'pause',
]);

const ONCALL_STATUSES = new Set(['ongoing', 'resolved', 'escalated', 'blocked']);
const TESTING_RECOMMENDATIONS = new Set(['proceed', 'block', 'investigate']);
const REGRESSION_SEVERITIES = new Set(['minor', 'major', 'critical']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNil(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

export function validatePrincipalOutput(output: unknown): ValidationResult<PrincipalOutput> {
  const errors: string[] = [];
  if (!isRecord(output)) {
    return { valid: false, errors: ['output must be an object'] };
  }

  const decision = output.decision;
  if (!isRecord(decision)) {
    errors.push('decision must be an object');
  } else {
    if (!PRINCIPAL_DECISION_TYPES.has(String(decision.type))) {
      errors.push('decision.type must be a valid decision type');
    }
    if (typeof decision.reasoning !== 'string') {
      errors.push('decision.reasoning must be a string');
    }
    if (!isNumber(decision.confidence)) {
      errors.push('decision.confidence must be a number');
    }
  }

  const nextObjective = output.next_objective;
  if (!isNil(nextObjective)) {
    if (!isRecord(nextObjective)) {
      errors.push('next_objective must be an object or null');
    } else {
      if (typeof nextObjective.goal !== 'string') {
        errors.push('next_objective.goal must be a string');
      }
      if (!isStringArray(nextObjective.success_criteria)) {
        errors.push('next_objective.success_criteria must be an array of strings');
      }
      if (!isStringArray(nextObjective.constraints)) {
        errors.push('next_objective.constraints must be an array of strings');
      }
      if (typeof nextObjective.delegate_to !== 'string') {
        errors.push('next_objective.delegate_to must be a string');
      }
      if (!isNil(nextObjective.target_files) && !isStringArray(nextObjective.target_files)) {
        errors.push('next_objective.target_files must be an array of strings');
      }
    }
  }

  const newConstraints = output.new_constraints;
  if (!isNil(newConstraints)) {
    if (!Array.isArray(newConstraints)) {
      errors.push('new_constraints must be an array or null');
    } else {
      newConstraints.forEach((entry, index) => {
        if (!isRecord(entry)) {
          errors.push(`new_constraints[${index}] must be an object`);
          return;
        }
        if (typeof entry.constraint !== 'string') {
          errors.push(`new_constraints[${index}].constraint must be a string`);
        }
        if (typeof entry.learned_from !== 'string') {
          errors.push(`new_constraints[${index}].learned_from must be a string`);
        }
      });
    }
  }

  const relatedDecisions = output.related_decisions;
  if (!isNil(relatedDecisions)) {
    if (!Array.isArray(relatedDecisions)) {
      errors.push('related_decisions must be an array or null');
    } else {
      relatedDecisions.forEach((entry, index) => {
        if (!isRecord(entry)) {
          errors.push(`related_decisions[${index}] must be an object`);
          return;
        }
        if (typeof entry.decision_id !== 'string') {
          errors.push(`related_decisions[${index}].decision_id must be a string`);
        }
        if (!isNumber(entry.similarity)) {
          errors.push(`related_decisions[${index}].similarity must be a number`);
        }
        if (typeof entry.should_reverse !== 'boolean') {
          errors.push(`related_decisions[${index}].should_reverse must be a boolean`);
        }
        if (typeof entry.reasoning !== 'string') {
          errors.push(`related_decisions[${index}].reasoning must be a string`);
        }
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value: output as PrincipalOutput };
}

export function validateOnCallOutput(output: unknown): ValidationResult<OnCallOutput> {
  const errors: string[] = [];
  if (!isRecord(output)) {
    return { valid: false, errors: ['output must be an object'] };
  }

  if (!ONCALL_STATUSES.has(String(output.investigation_status))) {
    errors.push('investigation_status must be a valid status');
  }

  const diagnosis = output.diagnosis;
  if (!isNil(diagnosis)) {
    if (!isRecord(diagnosis)) {
      errors.push('diagnosis must be an object or null');
    } else {
      if (typeof diagnosis.root_cause !== 'string') {
        errors.push('diagnosis.root_cause must be a string');
      }
      if (!isNumber(diagnosis.confidence)) {
        errors.push('diagnosis.confidence must be a number');
      }
      if (!isStringArray(diagnosis.evidence)) {
        errors.push('diagnosis.evidence must be an array of strings');
      }
      if (!Array.isArray(diagnosis.hypothesis_history)) {
        errors.push('diagnosis.hypothesis_history must be an array');
      } else {
        diagnosis.hypothesis_history.forEach((entry, index) => {
          if (!isRecord(entry)) {
            errors.push(`diagnosis.hypothesis_history[${index}] must be an object`);
            return;
          }
          if (typeof entry.hypothesis !== 'string') {
            errors.push(`diagnosis.hypothesis_history[${index}].hypothesis must be a string`);
          }
          if (typeof entry.tested !== 'boolean') {
            errors.push(`diagnosis.hypothesis_history[${index}].tested must be a boolean`);
          }
          if (!isNil(entry.result) && entry.result !== 'confirmed' && entry.result !== 'rejected') {
            errors.push(`diagnosis.hypothesis_history[${index}].result must be confirmed/rejected/null`);
          }
        });
      }
    }
  }

  const actions = output.actions;
  if (!isNil(actions)) {
    if (!Array.isArray(actions)) {
      errors.push('actions must be an array or null');
    } else {
      actions.forEach((entry, index) => {
        if (!isRecord(entry)) {
          errors.push(`actions[${index}] must be an object`);
        }
      });
    }
  }

  const resolution = output.resolution;
  if (!isNil(resolution)) {
    if (!isRecord(resolution)) {
      errors.push('resolution must be an object or null');
    } else {
      if (typeof resolution.summary !== 'string') {
        errors.push('resolution.summary must be a string');
      }
      if (!isStringArray(resolution.patches_applied)) {
        errors.push('resolution.patches_applied must be an array of strings');
      }
      if (typeof resolution.verification !== 'string') {
        errors.push('resolution.verification must be a string');
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value: output as OnCallOutput };
}

export function validateTestingOutput(output: unknown): ValidationResult<TestingOutput> {
  const errors: string[] = [];
  if (!isRecord(output)) {
    return { valid: false, errors: ['output must be an object'] };
  }

  if (!isRecord(output.suite_result)) {
    errors.push('suite_result must be an object');
  }
  if (!TESTING_RECOMMENDATIONS.has(String(output.recommendation))) {
    errors.push('recommendation must be a valid value');
  }
  if (typeof output.reasoning !== 'string') {
    errors.push('reasoning must be a string');
  }

  const regressions = output.regressions;
  if (!isNil(regressions)) {
    if (!Array.isArray(regressions)) {
      errors.push('regressions must be an array or null');
    } else {
      regressions.forEach((entry, index) => {
        if (!isRecord(entry)) {
          errors.push(`regressions[${index}] must be an object`);
          return;
        }
        if (typeof entry.benchmark_id !== 'string') {
          errors.push(`regressions[${index}].benchmark_id must be a string`);
        }
        if (!REGRESSION_SEVERITIES.has(String(entry.severity))) {
          errors.push(`regressions[${index}].severity must be a valid value`);
        }
        if (typeof entry.details !== 'string') {
          errors.push(`regressions[${index}].details must be a string`);
        }
      });
    }
  }

  const improvements = output.improvements;
  if (!isNil(improvements)) {
    if (!Array.isArray(improvements)) {
      errors.push('improvements must be an array or null');
    } else {
      improvements.forEach((entry, index) => {
        if (!isRecord(entry)) {
          errors.push(`improvements[${index}] must be an object`);
          return;
        }
        if (typeof entry.benchmark_id !== 'string') {
          errors.push(`improvements[${index}].benchmark_id must be a string`);
        }
        if (!isNumber(entry.improvement_percent)) {
          errors.push(`improvements[${index}].improvement_percent must be a number`);
        }
        if (typeof entry.details !== 'string') {
          errors.push(`improvements[${index}].details must be a string`);
        }
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value: output as TestingOutput };
}
