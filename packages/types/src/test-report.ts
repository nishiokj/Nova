/**
 * Test Report Types
 *
 * Artifacts produced by testing WorkItems.
 * Designed for browser display with category breakdowns,
 * CLI evidence, and agent commentary.
 */

// ============================================
// ENUMS
// ============================================

/**
 * Test verdict for individual cases and aggregates.
 */
export type TestVerdict = 'pass' | 'fail' | 'error' | 'skip';

/**
 * Test category - different templates run different categories.
 */
export type TestCategory = 'unit' | 'integration' | 'invariant' | 'mutation' | 'typecheck' | 'lint';

/**
 * All test categories.
 */
export const ALL_TEST_CATEGORIES: readonly TestCategory[] = [
  'unit',
  'integration',
  'invariant',
  'mutation',
  'typecheck',
  'lint',
] as const;

/**
 * All test verdicts.
 */
export const ALL_TEST_VERDICTS: readonly TestVerdict[] = ['pass', 'fail', 'error', 'skip'] as const;

// ============================================
// TEST CASE
// ============================================

/**
 * Individual test case result.
 */
export interface TestCase {
  /** Test name */
  name: string;
  /** Suite/describe block */
  suite: string;
  /** Category this test belongs to */
  category: TestCategory;
  /** Pass/fail/error/skip */
  verdict: TestVerdict;
  /** Execution time */
  durationMs: number;
  /** Stack trace if failed (truncated 2KB) */
  error?: string;
}

// ============================================
// CATEGORY SUMMARY
// ============================================

/**
 * Aggregate stats for a test category.
 * Used for dashboard display.
 */
export interface CategorySummary {
  /** Which category */
  category: TestCategory;
  /** Aggregate verdict: fail if any fail */
  verdict: TestVerdict;
  /** Total test count */
  total: number;
  /** Passed count */
  passed: number;
  /** Failed count */
  failed: number;
}

// ============================================
// COVERAGE
// ============================================

/**
 * Code coverage metrics (percentages 0-100).
 */
export interface TestCoverage {
  lines: number;
  branches: number;
  functions: number;
}

// ============================================
// TEST REPORT
// ============================================

/**
 * Test report - artifact from testing WorkItem.
 * Composed from whichever categories the workflow ran.
 */
export interface TestReport {
  /** Unique ID (ULID) */
  id: string;
  /** Session this belongs to */
  sessionKey: string;
  /** WorkItem that produced this report */
  workItemId: string;

  // Aggregate
  /** Overall verdict: fail if any category fails */
  verdict: TestVerdict;
  /** Per-category breakdowns (only categories that ran) */
  categories: CategorySummary[];

  // Detail (collapsible in UI)
  /** Individual test cases */
  cases: TestCase[];

  // Evidence
  /** Raw CLI output (truncated 8KB) */
  cliOutput: string;
  /** Command that was run */
  command: string;

  // Optional metrics
  /** Coverage percentages */
  coverage?: TestCoverage;
  /** Mutation score 0-100 (if mutation tests ran) */
  mutationScore?: number;

  // Agent commentary
  /** 1-2 sentence summary from agent */
  agentNote: string;

  // Metadata
  /** Total execution time */
  durationMs: number;
  /** When created */
  createdAt: number;
}

// ============================================
// CREATE INPUT
// ============================================

/**
 * Input for creating a test report.
 * Omits auto-generated fields (id, createdAt).
 */
export interface TestReportCreateInput {
  sessionKey: string;
  workItemId: string;
  verdict: TestVerdict;
  categories: CategorySummary[];
  cases: TestCase[];
  cliOutput: string;
  command: string;
  coverage?: TestCoverage;
  mutationScore?: number;
  agentNote: string;
  durationMs: number;
}

// ============================================
// HELPERS
// ============================================

/**
 * Compute aggregate verdict from categories.
 * Returns 'fail' if any category failed, 'error' if any errored, else 'pass'.
 */
export function computeAggregateVerdict(categories: CategorySummary[]): TestVerdict {
  if (categories.some((c) => c.verdict === 'fail')) return 'fail';
  if (categories.some((c) => c.verdict === 'error')) return 'error';
  if (categories.every((c) => c.verdict === 'skip')) return 'skip';
  return 'pass';
}

/**
 * Build category summary from test cases.
 */
export function buildCategorySummary(cases: TestCase[], category: TestCategory): CategorySummary {
  const filtered = cases.filter((c) => c.category === category);
  const passed = filtered.filter((c) => c.verdict === 'pass').length;
  const failed = filtered.filter((c) => c.verdict === 'fail' || c.verdict === 'error').length;

  let verdict: TestVerdict = 'pass';
  if (failed > 0) verdict = 'fail';
  else if (filtered.every((c) => c.verdict === 'skip')) verdict = 'skip';

  return {
    category,
    verdict,
    total: filtered.length,
    passed,
    failed,
  };
}

/**
 * Build all category summaries from test cases.
 * Only includes categories that have at least one test.
 */
export function buildAllCategorySummaries(cases: TestCase[]): CategorySummary[] {
  const presentCategories = new Set(cases.map((c) => c.category));
  return ALL_TEST_CATEGORIES.filter((cat) => presentCategories.has(cat)).map((cat) =>
    buildCategorySummary(cases, cat)
  );
}
