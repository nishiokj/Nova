/**
 * Test Reports Repository
 *
 * CRUD operations for test reports - artifacts from testing WorkItems.
 */

import type { RepositoryContext, PaginationOptions } from './types.js';
import type {
  TestReport,
  TestVerdict,
  TestCategory,
  TestCase,
  CategorySummary,
  TestCoverage,
  TestReportCreateInput,
} from 'types';
import { ulid } from 'ulid';

// ============================================
// DATABASE ROW TYPE
// ============================================

export interface TestReportRow {
  id: string;
  session_key: string;
  work_item_id: string;
  verdict: string;
  categories: CategorySummary[];
  cases: TestCase[];
  cli_output: string | null;
  command: string | null;
  coverage: TestCoverage | null;
  mutation_score: number | null;
  agent_note: string;
  duration_ms: number;
  created_at: Date;
}

// ============================================
// ROW MAPPING
// ============================================

function rowToReport(row: TestReportRow): TestReport {
  return {
    id: row.id,
    sessionKey: row.session_key,
    workItemId: row.work_item_id,
    verdict: row.verdict as TestVerdict,
    categories: row.categories,
    cases: row.cases,
    cliOutput: row.cli_output ?? '',
    command: row.command ?? '',
    coverage: row.coverage ?? undefined,
    mutationScore: row.mutation_score ?? undefined,
    agentNote: row.agent_note,
    durationMs: row.duration_ms,
    createdAt: row.created_at.getTime(),
  };
}

// ============================================
// REPOSITORY INTERFACE
// ============================================

export interface TestReportListOptions extends PaginationOptions {
  sessionKey?: string;
  workItemId?: string;
  verdict?: TestVerdict | TestVerdict[];
  category?: TestCategory;
}

export interface TestReportsRepository {
  /** Find report by ID */
  findById(id: string): Promise<TestReport | null>;

  /** Find report by work item ID */
  findByWorkItemId(workItemId: string): Promise<TestReport | null>;

  /** List reports with filtering */
  list(options?: TestReportListOptions): Promise<TestReport[]>;

  /** Count reports with filtering */
  count(options?: Omit<TestReportListOptions, 'limit' | 'offset'>): Promise<number>;

  /** Create a new report */
  create(input: TestReportCreateInput): Promise<TestReport>;

  /** Get latest report for a session */
  getLatestForSession(sessionKey: string): Promise<TestReport | null>;

  /** Get aggregate stats for a session */
  getSessionStats(sessionKey: string): Promise<{
    total: number;
    passed: number;
    failed: number;
    lastVerdict: TestVerdict | null;
  }>;
}

// ============================================
// REPOSITORY IMPLEMENTATION
// ============================================

export function createTestReportsRepository(
  ctx: RepositoryContext
): TestReportsRepository {
  const { sql } = ctx;

  return {
    async findById(id) {
      const rows = await sql<TestReportRow[]>`
        SELECT * FROM test_reports WHERE id = ${id}
      `;
      if (rows.length === 0) return null;
      return rowToReport(rows[0]);
    },

    async findByWorkItemId(workItemId) {
      const rows = await sql<TestReportRow[]>`
        SELECT * FROM test_reports
        WHERE work_item_id = ${workItemId}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (rows.length === 0) return null;
      return rowToReport(rows[0]);
    },

    async list(options = {}) {
      const {
        limit = 50,
        offset = 0,
        sessionKey,
        workItemId,
        verdict,
        category,
        orderBy = 'created_at',
        orderDirection = 'desc',
      } = options;

      const verdictArr = verdict
        ? Array.isArray(verdict)
          ? verdict
          : [verdict]
        : null;

      const rows = await sql<TestReportRow[]>`
        SELECT * FROM test_reports
        WHERE TRUE
          ${sessionKey ? sql`AND session_key = ${sessionKey}` : sql``}
          ${workItemId ? sql`AND work_item_id = ${workItemId}` : sql``}
          ${verdictArr ? sql`AND verdict = ANY(${verdictArr})` : sql``}
          ${category ? sql`AND categories @> ${JSON.stringify([{ category }])}::jsonb` : sql``}
        ORDER BY ${sql(orderBy)} ${orderDirection === 'asc' ? sql`ASC` : sql`DESC`}
        LIMIT ${limit}
        OFFSET ${offset}
      `;

      return rows.map(rowToReport);
    },

    async count(options = {}) {
      const { sessionKey, workItemId, verdict, category } = options;

      const verdictArr = verdict
        ? Array.isArray(verdict)
          ? verdict
          : [verdict]
        : null;

      const result = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM test_reports
        WHERE TRUE
          ${sessionKey ? sql`AND session_key = ${sessionKey}` : sql``}
          ${workItemId ? sql`AND work_item_id = ${workItemId}` : sql``}
          ${verdictArr ? sql`AND verdict = ANY(${verdictArr})` : sql``}
          ${category ? sql`AND categories @> ${JSON.stringify([{ category }])}::jsonb` : sql``}
      `;

      return parseInt(result[0]?.count ?? '0', 10);
    },

    async create(input) {
      const id = ulid();
      const now = new Date();

      const rows = await sql<TestReportRow[]>`
        INSERT INTO test_reports (
          id, session_key, work_item_id, verdict, categories, cases,
          cli_output, command, coverage, mutation_score, agent_note,
          duration_ms, created_at
        ) VALUES (
          ${id},
          ${input.sessionKey},
          ${input.workItemId},
          ${input.verdict},
          ${JSON.stringify(input.categories)}::jsonb,
          ${JSON.stringify(input.cases)}::jsonb,
          ${input.cliOutput},
          ${input.command},
          ${input.coverage ? JSON.stringify(input.coverage) : null}::jsonb,
          ${input.mutationScore ?? null},
          ${input.agentNote},
          ${input.durationMs},
          ${now}
        )
        RETURNING *
      `;

      return rowToReport(rows[0]);
    },

    async getLatestForSession(sessionKey) {
      const rows = await sql<TestReportRow[]>`
        SELECT * FROM test_reports
        WHERE session_key = ${sessionKey}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (rows.length === 0) return null;
      return rowToReport(rows[0]);
    },

    async getSessionStats(sessionKey) {
      const result = await sql<{
        total: string;
        passed: string;
        failed: string;
        last_verdict: string | null;
      }[]>`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE verdict = 'pass') as passed,
          COUNT(*) FILTER (WHERE verdict IN ('fail', 'error')) as failed,
          (SELECT verdict FROM test_reports
           WHERE session_key = ${sessionKey}
           ORDER BY created_at DESC LIMIT 1) as last_verdict
        FROM test_reports
        WHERE session_key = ${sessionKey}
      `;

      const row = result[0];
      return {
        total: parseInt(row?.total ?? '0', 10),
        passed: parseInt(row?.passed ?? '0', 10),
        failed: parseInt(row?.failed ?? '0', 10),
        lastVerdict: (row?.last_verdict as TestVerdict) ?? null,
      };
    },
  };
}
