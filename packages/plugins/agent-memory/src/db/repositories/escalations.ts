/**
 * Escalations Repository
 *
 * CRUD operations for escalations - the atomic unit of "needs human attention".
 */

import type { RepositoryContext, PaginationOptions } from './types.js';
import type {
  Escalation,
  EscalationType,
  EscalationStatus,
  EscalationOption,
  EscalationReference,
  EscalationResolution,
  EscalationCreateInput,
  EscalationResolveInput,
} from 'types';
import { ulid } from 'ulid';

// ============================================
// DATABASE ROW TYPE
// ============================================

export interface EscalationRow {
  id: string;
  type: string;
  status: string;
  session_key: string;
  work_item_id: string | null;
  title: string;
  context: string;
  tradeoffs_json: string | null;
  options_json: string | null;
  references_json: string;
  resolution_json: string | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ============================================
// ROW MAPPING
// ============================================

function rowToEscalation(row: EscalationRow): Escalation {
  return {
    id: row.id,
    type: row.type as EscalationType,
    status: row.status as EscalationStatus,
    sessionKey: row.session_key,
    workItemId: row.work_item_id ?? undefined,
    title: row.title,
    context: row.context,
    tradeoffs: row.tradeoffs_json ? JSON.parse(row.tradeoffs_json) : undefined,
    options: row.options_json
      ? (JSON.parse(row.options_json) as EscalationOption[])
      : undefined,
    references: JSON.parse(row.references_json) as EscalationReference[],
    resolution: row.resolution_json
      ? (JSON.parse(row.resolution_json) as EscalationResolution)
      : undefined,
    resolvedAt: row.resolved_at ? row.resolved_at.getTime() : undefined,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

// ============================================
// REPOSITORY INTERFACE
// ============================================

export interface EscalationListOptions extends PaginationOptions {
  sessionKey?: string;
  status?: EscalationStatus | EscalationStatus[];
  type?: EscalationType | EscalationType[];
}

export interface EscalationsRepository {
  /** Find escalation by ID */
  findById(id: string): Promise<Escalation | null>;

  /** List escalations with filtering */
  list(options?: EscalationListOptions): Promise<Escalation[]>;

  /** Count escalations with filtering */
  count(options?: Omit<EscalationListOptions, 'limit' | 'offset'>): Promise<number>;

  /** Create a new escalation */
  create(input: EscalationCreateInput): Promise<Escalation>;

  /** Update escalation status */
  updateStatus(id: string, status: EscalationStatus): Promise<Escalation | null>;

  /** Resolve an escalation */
  resolve(id: string, input: EscalationResolveInput): Promise<Escalation | null>;

  /** Dismiss an escalation */
  dismiss(id: string): Promise<Escalation | null>;

  /** Count pending escalations for a session */
  countPending(sessionKey: string): Promise<number>;
}

// ============================================
// REPOSITORY IMPLEMENTATION
// ============================================

export function createEscalationsRepository(
  ctx: RepositoryContext
): EscalationsRepository {
  const { sql } = ctx;

  return {
    async findById(id) {
      const rows = await sql<EscalationRow[]>`
        SELECT * FROM escalations WHERE id = ${id}
      `;
      if (rows.length === 0) return null;
      return rowToEscalation(rows[0]);
    },

    async list(options = {}) {
      const {
        limit = 50,
        offset = 0,
        sessionKey,
        status,
        type,
        orderBy = 'created_at',
        orderDirection = 'desc',
      } = options;

      // Build status filter
      const statusArr = status
        ? Array.isArray(status)
          ? status
          : [status]
        : null;
      const typeArr = type ? (Array.isArray(type) ? type : [type]) : null;

      const rows = await sql<EscalationRow[]>`
        SELECT * FROM escalations
        WHERE TRUE
          ${sessionKey ? sql`AND session_key = ${sessionKey}` : sql``}
          ${statusArr ? sql`AND status = ANY(${statusArr})` : sql``}
          ${typeArr ? sql`AND type = ANY(${typeArr})` : sql``}
        ORDER BY ${sql(orderBy)} ${orderDirection === 'asc' ? sql`ASC` : sql`DESC`}
        LIMIT ${limit}
        OFFSET ${offset}
      `;

      return rows.map(rowToEscalation);
    },

    async count(options = {}) {
      const { sessionKey, status, type } = options;

      const statusArr = status
        ? Array.isArray(status)
          ? status
          : [status]
        : null;
      const typeArr = type ? (Array.isArray(type) ? type : [type]) : null;

      const result = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM escalations
        WHERE TRUE
          ${sessionKey ? sql`AND session_key = ${sessionKey}` : sql``}
          ${statusArr ? sql`AND status = ANY(${statusArr})` : sql``}
          ${typeArr ? sql`AND type = ANY(${typeArr})` : sql``}
      `;

      return parseInt(result[0]?.count ?? '0', 10);
    },

    async create(input) {
      const id = ulid();
      const now = new Date();

      const rows = await sql<EscalationRow[]>`
        INSERT INTO escalations (
          id, type, status, session_key, work_item_id,
          title, context, tradeoffs_json, options_json, references_json,
          created_at, updated_at
        ) VALUES (
          ${id},
          ${input.type},
          'pending',
          ${input.sessionKey},
          ${input.workItemId ?? null},
          ${input.title},
          ${input.context},
          ${input.tradeoffs ? JSON.stringify(input.tradeoffs) : null},
          ${input.options ? JSON.stringify(input.options) : null},
          ${JSON.stringify(input.references ?? [])},
          ${now},
          ${now}
        )
        RETURNING *
      `;

      return rowToEscalation(rows[0]);
    },

    async updateStatus(id, status) {
      const rows = await sql<EscalationRow[]>`
        UPDATE escalations
        SET status = ${status},
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;

      if (rows.length === 0) return null;
      return rowToEscalation(rows[0]);
    },

    async resolve(id, input) {
      const resolution: EscalationResolution = {
        optionId: input.optionId,
        freeformResponse: input.freeformResponse,
        resolvedBy: 'user',
      };

      const rows = await sql<EscalationRow[]>`
        UPDATE escalations
        SET
          status = 'resolved',
          resolution_json = ${JSON.stringify(resolution)},
          resolved_at = NOW()
        WHERE id = ${id}
          AND status IN ('pending', 'acknowledged')
        RETURNING *
      `;

      if (rows.length === 0) return null;
      return rowToEscalation(rows[0]);
    },

    async dismiss(id) {
      const resolution: EscalationResolution = {
        resolvedBy: 'user',
      };

      const rows = await sql<EscalationRow[]>`
        UPDATE escalations
        SET
          status = 'dismissed',
          resolution_json = ${JSON.stringify(resolution)},
          resolved_at = NOW()
        WHERE id = ${id}
          AND status IN ('pending', 'acknowledged')
        RETURNING *
      `;

      if (rows.length === 0) return null;
      return rowToEscalation(rows[0]);
    },

    async countPending(sessionKey) {
      const result = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM escalations
        WHERE session_key = ${sessionKey}
          AND status = 'pending'
      `;

      return parseInt(result[0]?.count ?? '0', 10);
    },
  };
}
