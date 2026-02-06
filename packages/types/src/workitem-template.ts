/**
 * WorkItem Templates
 *
 * Precomputed WorkItem DAGs for common patterns.
 * Templates are instantiated into real WorkItems at runtime.
 */

// ============================================
// WORKITEM SPEC (template-local step)
// ============================================

/**
 * A step definition within a template.
 * Like a WorkItem blueprint - lacks workId, goal, bounds.
 */
export interface WorkItemSpec {
  /** Template-local ID for dependency references */
  id: string;
  /** What the agent should accomplish */
  objective: string;
  /** Agent type to execute (coder, planner, test-runner) */
  agent: string;
  /** Template-local IDs this step depends on */
  dependencies: string[];
  /** Arbitrary metadata passed through to WorkItem */
  metadata?: Record<string, unknown>;
}

// ============================================
// WORKITEM TEMPLATE
// ============================================

/**
 * A precomputed WorkItem DAG.
 * Same structure the planner produces dynamically, but stored for reuse.
 */
export interface WorkItemTemplate {
  /** Unique ID (ULID) */
  id: string;
  /** Unique name: "feature", "bugfix", "prototype", "refactor" */
  name: string;
  /** Human-readable description */
  description: string;
  /** The DAG - ordering determines stepNum */
  specs: WorkItemSpec[];
  /** When created */
  createdAt: number;
  /** Last updated */
  updatedAt: number;
}

// ============================================
// CREATE INPUT
// ============================================

/**
 * Input for creating a new template.
 * Omits auto-generated fields (id, timestamps).
 */
export interface WorkItemTemplateCreateInput {
  name: string;
  description: string;
  specs: WorkItemSpec[];
}

// ============================================
// DEFAULT TEMPLATES
// ============================================

/**
 * Feature template - new feature with full test coverage.
 */
export const FEATURE_TEMPLATE_SPECS: WorkItemSpec[] = [
  { id: 'plan', objective: 'Plan the feature implementation', agent: 'planner', dependencies: [] },
  { id: 'implement', objective: 'Implement the feature', agent: 'coder', dependencies: ['plan'] },
  { id: 'unit-tests', objective: 'Write unit tests for new code', agent: 'coder', dependencies: ['implement'] },
  { id: 'integration-tests', objective: 'Write integration tests', agent: 'coder', dependencies: ['implement'] },
  { id: 'run-tests', objective: 'Run all tests', agent: 'test-runner', dependencies: ['unit-tests', 'integration-tests'] },
  { id: 'invariants', objective: 'Verify semantic invariants hold', agent: 'coder', dependencies: ['run-tests'] },
];

/**
 * Bugfix template - fix with regression tests.
 */
export const BUGFIX_TEMPLATE_SPECS: WorkItemSpec[] = [
  { id: 'reproduce', objective: 'Create failing test that reproduces the bug', agent: 'coder', dependencies: [] },
  { id: 'fix', objective: 'Fix the bug', agent: 'coder', dependencies: ['reproduce'] },
  { id: 'verify', objective: 'Confirm reproduction test now passes', agent: 'test-runner', dependencies: ['fix'] },
  { id: 'suite', objective: 'Run existing test suite', agent: 'test-runner', dependencies: ['fix'] },
  { id: 'regression', objective: 'Add regression tests for similar edge cases', agent: 'coder', dependencies: ['verify'] },
];

/**
 * Prototype template - quick build with minimal testing.
 */
export const PROTOTYPE_TEMPLATE_SPECS: WorkItemSpec[] = [
  { id: 'implement', objective: 'Build the prototype', agent: 'coder', dependencies: [] },
  { id: 'sanity', objective: 'Basic sanity test - does it run?', agent: 'test-runner', dependencies: ['implement'] },
];

/**
 * Refactor template - restructure with no behavior change.
 */
export const REFACTOR_TEMPLATE_SPECS: WorkItemSpec[] = [
  { id: 'plan', objective: 'Plan the refactor', agent: 'planner', dependencies: [] },
  { id: 'refactor', objective: 'Execute the refactor', agent: 'coder', dependencies: ['plan'] },
  { id: 'typecheck', objective: 'Run typecheck', agent: 'test-runner', dependencies: ['refactor'] },
  { id: 'suite', objective: 'Run existing tests (must all pass)', agent: 'test-runner', dependencies: ['refactor'] },
];

/**
 * All default template names.
 */
export const DEFAULT_TEMPLATE_NAMES = ['feature', 'bugfix', 'prototype', 'refactor'] as const;
export type DefaultTemplateName = (typeof DEFAULT_TEMPLATE_NAMES)[number];

/**
 * Get default template specs by name.
 */
export function getDefaultTemplateSpecs(name: DefaultTemplateName): WorkItemSpec[] {
  switch (name) {
    case 'feature':
      return FEATURE_TEMPLATE_SPECS;
    case 'bugfix':
      return BUGFIX_TEMPLATE_SPECS;
    case 'prototype':
      return PROTOTYPE_TEMPLATE_SPECS;
    case 'refactor':
      return REFACTOR_TEMPLATE_SPECS;
  }
}
