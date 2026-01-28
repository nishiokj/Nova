/**
 * Decision Watcher Integration
 *
 * Helper functions for decision watcher configuration and seeding.
 * The watcher now integrates via the StopHookHandler mechanism
 * (see watcher-agent.ts), not via orchestrator hook callbacks.
 */

import type {
  DecisionDatabase,
  DecisionWatcherConfig,
} from '../types.js';

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Create a decision watcher configuration with sensible defaults.
 */
export function createWatcherConfig(
  overrides?: Partial<DecisionWatcherConfig>
): DecisionWatcherConfig {
  return {
    enabled: true,
    minConfidenceThreshold: 0.6,
    escalateCritical: true,
    escalateWithWarnings: false,
    maxDecisionsToConsult: 10,
    useLLMSynthesis: true,
    enableConsistencyChecking: true,
    ...overrides,
  };
}

/**
 * Check if async mode should be enabled based on config.
 */
export async function shouldEnableAsyncMode(
  db: DecisionDatabase,
  config?: DecisionWatcherConfig
): Promise<boolean> {
  if (!config) return false;
  if (!config.enabled) return false;

  // Check if database has any decisions
  const allEntries = await db.getAll();
  const hasDecisions = allEntries.length > 0;

  // We're in async mode if enabled and we have decisions
  return config.enabled && hasDecisions;
}

// ============================================
// DEFAULT DECISIONS (Starter Kit)
// ============================================

/**
 * A set of default decisions to seed the database.
 * These are high-signal, generalizable decisions that serve as
 * examples and provide immediate value.
 *
 * Users should curate their own decisions based on their preferences.
 */
export const DEFAULT_DECISIONS = [
  {
    id: 'dec-error-handling-pattern',
    category: 'error-handling' as const,
    priority: 'high' as const,
    scope: 'global' as const,
    questionPattern: 'how should errors be handled',
    keywords: ['error', 'exception', 'handling', 'try-catch', 'result', 'option'],
    decision: 'Use structured error types (Result<T, E> or Option<T>) instead of throwing exceptions for recoverable errors. Use exceptions only for truly exceptional conditions (system failures, bugs).',
    rationale: 'Structured error types make error handling explicit and type-safe. They force callers to handle error cases rather than relying on try-catch blocks that can be easily forgotten.',
    alternatives: [
      'Throw exceptions for all errors',
      'Return null/undefined on error',
      'Use callback-based error handling',
    ],
    implications: [
      'More verbose code due to explicit error handling',
      'Better type safety and compile-time checking',
      'Clearer API contracts',
      'Easier to test error paths',
    ],
    dependsOn: [],
    conflictsWith: [],
    source: 'documented' as const,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'dec-typescript-strict-mode',
    category: 'style' as const,
    priority: 'critical' as const,
    scope: 'language' as const,
    questionPattern: 'typescript configuration strict mode',
    keywords: ['typescript', 'strict', 'tsconfig', 'compiler'],
    decision: 'Always enable TypeScript strict mode in tsconfig.json. Include: strict: true, noImplicitAny: true, strictNullChecks: true, strictFunctionTypes: true, noUnusedLocals: true.',
    rationale: 'Strict mode catches bugs at compile-time that would otherwise cause runtime errors. It enforces better coding practices and eliminates entire classes of bugs.',
    alternatives: [
      'Disable strict mode for faster prototyping',
      'Use partial strict mode',
    ],
    implications: [
      'Initial development may be slower due to stricter type checking',
      'Higher code quality and fewer runtime errors',
      'Better IDE support and autocomplete',
      'More maintainable codebase',
    ],
    dependsOn: [],
    conflictsWith: ['dec-allow-implicit-any'],
    source: 'documented' as const,
    updatedAt: new Date().toISOString(),
    appliesTo: {
      language: 'typescript',
    },
  },
  {
    id: 'dec-test-coverage-threshold',
    category: 'testing' as const,
    priority: 'medium' as const,
    scope: 'global' as const,
    questionPattern: 'what test coverage should be enforced',
    keywords: ['test', 'coverage', 'testing', 'threshold', 'percentage'],
    decision: 'Enforce minimum 80% code coverage with 100% coverage for critical paths (auth, payments, data integrity). Use coverage exclusions sparingly and document the reason for each exclusion.',
    rationale: 'High test coverage gives confidence in refactoring and catches regressions. Critical paths need absolute certainty as failures can be catastrophic.',
    alternatives: [
      'No coverage requirements',
      '100% coverage for all code',
      'Lower coverage threshold (e.g., 60%)',
    ],
    implications: [
      'More test code to maintain',
      'Slower development cycle for new features',
      'Higher confidence in changes',
      'Better documentation (tests as documentation)',
    ],
    dependsOn: [],
    conflictsWith: [],
    source: 'documented' as const,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'dec-git-commit-conventional',
    category: 'workflow' as const,
    priority: 'medium' as const,
    scope: 'global' as const,
    questionPattern: 'git commit message format',
    keywords: ['git', 'commit', 'message', 'format', 'conventional'],
    decision: 'Use conventional commits format: <type>(<scope>): <description>. Types: feat, fix, docs, style, refactor, test, chore. Add body for context and footer for breaking changes.',
    rationale: 'Conventional commits make git history readable and enable automated changelog generation, semantic versioning, and rollback scripts.',
    alternatives: [
      'Free-form commit messages',
      'Custom commit format',
    ],
    implications: [
      'Structured git history',
      'Automated release tooling',
      'Better code review experience',
      'Requires discipline from team',
    ],
    dependsOn: [],
    conflictsWith: [],
    source: 'documented' as const,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'dec-naming-conventions',
    category: 'style' as const,
    priority: 'high' as const,
    scope: 'global' as const,
    questionPattern: 'naming conventions for variables functions',
    keywords: ['naming', 'convention', 'camelCase', 'snake_case', 'PascalCase'],
    decision: 'Use camelCase for variables and functions, PascalCase for classes and components, UPPER_SNAKE_CASE for constants. Be descriptive but concise: use names that describe intent, not implementation.',
    rationale: 'Consistent naming conventions improve readability and reduce cognitive load. They make the codebase easier to navigate and understand.',
    alternatives: [
      'snake_case for everything (Python style)',
      'kebab-case for variables',
      'Hungarian notation',
    ],
    implications: [
      'Consistent look and feel across codebase',
      'Easier to read and maintain',
      'Requires tooling/linting to enforce',
    ],
    dependsOn: [],
    conflictsWith: [],
    source: 'documented' as const,
    updatedAt: new Date().toISOString(),
  },
];

/**
 * Create a database seeded with default decisions.
 */
export async function createSeededDatabase(
  db: DecisionDatabase
): Promise<DecisionDatabase> {
  for (const decision of DEFAULT_DECISIONS) {
    await db.upsert(decision);
  }
  return db;
}
