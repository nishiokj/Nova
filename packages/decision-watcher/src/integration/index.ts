/**
 * Decision Watcher Integration
 *
 * Integration layer for connecting decision watcher to orchestrator's
 * hook system. This enables async mode by intercepting PromptUser events.
 */

import type {
  DecisionWatcher,
  DecisionDatabase,
  DecisionWatcherConfig,
  WatcherIntegrationConfig,
  PromptUserHookEvent,
  PromptUserHookResult,
  PromptUserAnswer,
} from '../types.js';
import { createDecisionWatcher } from '../watcher/index.js';

// ============================================
// WATCHER INTEGRATION
// ============================================

/**
 * Integration class that connects watcher to orchestrator hooks.
 */
export class WatcherIntegration {
  private watcher: DecisionWatcher;
  private config: WatcherIntegrationConfig;
  private active = false;

  constructor(
    db: DecisionDatabase,
    config: DecisionWatcherConfig & Partial<WatcherIntegrationConfig>
  ) {
    this.watcher = createDecisionWatcher(db, config);

    this.config = {
      watcherConfig: config,
      injectAnswer: config.injectAnswer ?? this.defaultInjectAnswer,
      onAnswer: config.onAnswer,
      onEscalate: config.onEscalate,
      onInconsistency: config.onInconsistency,
    };

    // Start the watcher
    this.watcher.start(this.config);

    this.active = true;
  }

  /**
   * Handle a PromptUser hook event.
   * This is the main entry point called by the orchestrator.
   */
  async handlePromptUser(event: PromptUserHookEvent): Promise<PromptUserHookResult> {
    if (!this.active) {
      return { action: 'block', reason: 'Watcher integration not active' };
    }

    return await this.watcher.handlePromptUser(event);
  }

  /**
   * Stop the integration.
   */
  stop(): void {
    this.watcher.stop();
    this.active = false;
  }

  /**
   * Check if integration is active.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Get watcher statistics.
   */
  getStats() {
    return this.watcher.getStats();
  }

  /**
   * Clear session memory.
   */
  clearSession(sessionId: string): void {
    this.watcher.clearSession(sessionId);
  }

  /**
   * Default answer injection implementation.
   *
   * In production, this would be replaced with actual orchestrator integration
   * that injects the answer into the agent's context and continues execution.
   *
   * This is a placeholder that logs what would happen.
   */
  private defaultInjectAnswer(answer: PromptUserAnswer, workItemId: string): void {
    console.log(`[WatcherIntegration] Injecting answer for work item ${workItemId}:`, answer.answer);

    // TODO: Integrate with orchestrator to actually inject answer
    // This would involve:
    // 1. Getting the work item from orchestrator
    // 2. Adding the answer to the agent's context
    // 3. Triggering continuation of the work item
    //
    // The actual implementation depends on orchestrator's API design.
    // This is a hook integration point that will be wired up separately.
  }
}

// ============================================
// ORCHESTRATOR HOOK INTEGRATION
// ============================================

/**
 * Create a hook handler for PromptUser events that can be registered
 * with the orchestrator's hook system.
 *
 * Usage in orchestrator:
 * ```typescript
 * import { createPromptUserHook } from '@jesus/decision-watcher';
 *
 * const watcherIntegration = createPromptUserHook(db, config);
 *
 * // Register with orchestrator
 * registerHook('prompt_user', watcherIntegration.handlePromptUser);
 * ```
 */
export function createPromptUserHook(
  db: DecisionDatabase,
  config: DecisionWatcherConfig & Partial<WatcherIntegrationConfig>
): WatcherIntegration {
  return new WatcherIntegration(db, config);
}

/**
 * Type-safe hook handler for orchestrator integration.
 *
 * This function returns a handler that matches the orchestrator's
 * hook callback signature.
 */
export function createOrchestratorHookHandler(
  db: DecisionDatabase,
  config: DecisionWatcherConfig & Partial<WatcherIntegrationConfig>
) {
  const integration = new WatcherIntegration(db, config);

  return async (event: PromptUserHookEvent): Promise<PromptUserHookResult> => {
    return await integration.handlePromptUser(event);
  };
}

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
export function shouldEnableAsyncMode(
  db: DecisionDatabase,
  config?: DecisionWatcherConfig
): boolean {
  if (!config) return false;
  if (!config.enabled) return false;

  // Check if database has any decisions
  const hasDecisions = db.getAll().then(entries => entries.length > 0);

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
