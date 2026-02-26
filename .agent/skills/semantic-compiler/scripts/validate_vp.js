#!/usr/bin/env node

import fs from 'fs';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const ASSERTION_KINDS = new Set([
  'equals',
  'contains',
  'exists',
  'count_lte',
  'status_code',
  'json_path_equals',
  'event_occurs',
  'event_order',
  'eventually',
]);

const STEP_KINDS = new Set(['harness_setup', 'action', 'assert', 'trace_check']);
const COMPILE_STATUS = new Set(['compiled', 'needs_user_answer', 'failed']);
const SEVERITY = new Set(['info', 'warning', 'error']);

const FORBIDDEN_INVARIANT_KEYS = new Set(['id', 'raw']);
const FORBIDDEN_STEP_KEYS = new Set(['type', 'action', 'assert', 'id']);

const REQUIRED_TOP_KEYS = [
  'vp_version',
  'uow_id',
  'generated_at',
  'system_surface',
  'invariants',
  'compile_findings',
];

function validateAssertion(assertion, path, errors) {
  if (!isObject(assertion)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (typeof assertion.kind !== 'string' || !ASSERTION_KINDS.has(assertion.kind)) {
    errors.push(`${path}.kind must be one of ${Array.from(ASSERTION_KINDS).join(', ')}`);
    return;
  }

  if (assertion.kind === 'eventually') {
    if (!('assertion' in assertion)) {
      errors.push(`${path}.assertion is required for eventually`);
    } else {
      validateAssertion(assertion.assertion, `${path}.assertion`, errors);
    }
    if (typeof assertion.timeout_ms !== 'number') {
      errors.push(`${path}.timeout_ms must be a number`);
    }
  }
}

function validate(filePath) {
  const errors = [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const vp = JSON.parse(raw);

  if (!isObject(vp)) {
    errors.push('root must be an object');
    return errors;
  }

  for (const key of REQUIRED_TOP_KEYS) {
    if (!(key in vp)) errors.push(`missing required top-level key: ${key}`);
  }

  if (typeof vp.vp_version !== 'string') errors.push('vp_version must be a string');
  if (typeof vp.uow_id !== 'string') errors.push('uow_id must be a string');
  if (typeof vp.generated_at !== 'string') errors.push('generated_at must be a string');

  if (!isObject(vp.system_surface)) {
    errors.push('system_surface must be an object');
  } else {
    const s = vp.system_surface;
    if (!isStringArray(s.services)) errors.push('system_surface.services must be string[]');
    if (!isStringArray(s.storage)) errors.push('system_surface.storage must be string[]');
    if (!isStringArray(s.ui_surfaces)) errors.push('system_surface.ui_surfaces must be string[]');
    if (!isStringArray(s.external_dependencies)) errors.push('system_surface.external_dependencies must be string[]');
    if (!isStringArray(s.main_flows)) errors.push('system_surface.main_flows must be string[]');
  }

  if (!Array.isArray(vp.invariants)) {
    errors.push('invariants must be an array');
  } else {
    vp.invariants.forEach((inv, i) => {
      const base = `invariants[${i}]`;
      if (!isObject(inv)) {
        errors.push(`${base} must be an object`);
        return;
      }

      for (const key of FORBIDDEN_INVARIANT_KEYS) {
        if (key in inv) errors.push(`${base}.${key} is forbidden; use canonical field names`);
      }
      if ('verification_strategy' in inv) {
        errors.push(`${base}.verification_strategy is forbidden; use verification_plan.strategy_id`);
      }

      const required = [
        'inv_id',
        'original_text',
        'refined',
        'assumptions',
        'verification_plan',
        'verdict_rule',
        'compile_status',
      ];
      for (const key of required) {
        if (!(key in inv)) errors.push(`${base} missing required key: ${key}`);
      }

      if (typeof inv.inv_id !== 'string') errors.push(`${base}.inv_id must be a string`);
      if (typeof inv.original_text !== 'string') errors.push(`${base}.original_text must be a string`);
      if (typeof inv.verdict_rule !== 'string') errors.push(`${base}.verdict_rule must be a string`);
      if (!COMPILE_STATUS.has(inv.compile_status)) {
        errors.push(`${base}.compile_status must be one of ${Array.from(COMPILE_STATUS).join(', ')}`);
      }

      if (!isObject(inv.refined)) {
        errors.push(`${base}.refined must be an object`);
      } else {
        if (typeof inv.refined.intent !== 'string') errors.push(`${base}.refined.intent must be a string`);
        if (!isStringArray(inv.refined.scope)) errors.push(`${base}.refined.scope must be string[]`);
        if (!isStringArray(inv.refined.operational_definition)) {
          errors.push(`${base}.refined.operational_definition must be string[]`);
        }
      }

      if (!isStringArray(inv.assumptions)) errors.push(`${base}.assumptions must be string[]`);

      if (!isObject(inv.verification_plan)) {
        errors.push(`${base}.verification_plan must be an object`);
      } else {
        const plan = inv.verification_plan;
        if (typeof plan.strategy_id !== 'string') {
          errors.push(`${base}.verification_plan.strategy_id must be a string`);
        }
        if (!Array.isArray(plan.steps)) {
          errors.push(`${base}.verification_plan.steps must be an array`);
        } else {
          plan.steps.forEach((step, j) => {
            const stepBase = `${base}.verification_plan.steps[${j}]`;
            if (!isObject(step)) {
              errors.push(`${stepBase} must be an object`);
              return;
            }
            for (const key of FORBIDDEN_STEP_KEYS) {
              if (key in step) errors.push(`${stepBase}.${key} is forbidden; use typed step fields`);
            }
            if (typeof step.kind !== 'string' || !STEP_KINDS.has(step.kind)) {
              errors.push(`${stepBase}.kind must be one of ${Array.from(STEP_KINDS).join(', ')}`);
            }
            if (typeof step.spec !== 'string') {
              errors.push(`${stepBase}.spec must be a string`);
            }
            if (step.kind === 'assert') {
              if (!('assertion' in step)) {
                errors.push(`${stepBase}.assertion is required when kind=assert`);
              } else {
                validateAssertion(step.assertion, `${stepBase}.assertion`, errors);
              }
            }
            if (step.kind === 'trace_check') {
              if (typeof step.predicate !== 'string') {
                errors.push(`${stepBase}.predicate is required when kind=trace_check`);
              }
              if (typeof step.trace_source !== 'string') {
                errors.push(`${stepBase}.trace_source is required when kind=trace_check`);
              }
            }
          });
        }
        if (!isStringArray(plan.evidence)) {
          errors.push(`${base}.verification_plan.evidence must be string[]`);
        }
      }
    });
  }

  if (!Array.isArray(vp.compile_findings)) {
    errors.push('compile_findings must be an array');
  } else {
    vp.compile_findings.forEach((finding, i) => {
      const base = `compile_findings[${i}]`;
      if (!isObject(finding)) {
        errors.push(`${base} must be an object`);
        return;
      }
      if ('level' in finding) errors.push(`${base}.level is forbidden; use severity`);

      const required = ['finding_id', 'severity', 'code', 'message'];
      for (const key of required) {
        if (!(key in finding)) errors.push(`${base} missing required key: ${key}`);
      }

      if (typeof finding.finding_id !== 'string') errors.push(`${base}.finding_id must be a string`);
      if (!SEVERITY.has(finding.severity)) {
        errors.push(`${base}.severity must be one of ${Array.from(SEVERITY).join(', ')}`);
      }
      if (typeof finding.code !== 'string') errors.push(`${base}.code must be a string`);
      if (typeof finding.message !== 'string') errors.push(`${base}.message must be a string`);
      if ('invariant_id' in finding && typeof finding.invariant_id !== 'string') {
        errors.push(`${base}.invariant_id must be a string when present`);
      }
    });
  }

  if ('unresolved_questions' in vp) {
    if (!Array.isArray(vp.unresolved_questions)) {
      errors.push('unresolved_questions must be an array');
    } else {
      vp.unresolved_questions.forEach((q, i) => {
        const base = `unresolved_questions[${i}]`;
        if (!isObject(q)) {
          errors.push(`${base} must be an object`);
          return;
        }
        if (typeof q.question_id !== 'string') errors.push(`${base}.question_id must be a string`);
        if (typeof q.invariant_id !== 'string') errors.push(`${base}.invariant_id must be a string`);
        if (typeof q.question !== 'string') errors.push(`${base}.question must be a string`);
        if (typeof q.rationale !== 'string') errors.push(`${base}.rationale must be a string`);
        if ('options' in q && !isStringArray(q.options)) errors.push(`${base}.options must be string[]`);
      });
    }
  }

  if ('approval_gate' in vp) {
    if (!isObject(vp.approval_gate)) {
      errors.push('approval_gate must be an object');
    } else {
      if (typeof vp.approval_gate.required !== 'boolean') {
        errors.push('approval_gate.required must be boolean');
      }
      if (typeof vp.approval_gate.prompt !== 'string') {
        errors.push('approval_gate.prompt must be string');
      }
    }
  }

  return errors;
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    fail('Usage: node .agent/skills/semantic-compiler/scripts/validate_vp.js <vp.json>');
  }

  let errors;
  try {
    errors = validate(filePath);
  } catch (error) {
    fail(`Failed to validate file: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (errors.length > 0) {
    process.stderr.write(`VP validation failed with ${errors.length} error(s):\n`);
    for (const error of errors) {
      process.stderr.write(`- ${error}\n`);
    }
    process.exit(1);
  }

  process.stdout.write('VP validation passed.\n');
}

main();
