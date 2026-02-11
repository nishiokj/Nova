/**
 * WorkItem Templates Repository
 *
 * CRUD operations for workitem templates - precomputed DAGs for common workflow patterns.
 */

import type { RepositoryContext } from './types.js';
import type {
  WorkItemTemplate,
  WorkItemSpec,
  WorkItemTemplateCreateInput,
} from 'types';
import { ulid } from 'ulid';

// ============================================
// DATABASE ROW TYPE
// ============================================

export interface WorkItemTemplateRow {
  id: string;
  name: string;
  description: string | null;
  specs: WorkItemSpec[];
  created_at: Date;
  updated_at: Date;
}

// ============================================
// ROW MAPPING
// ============================================

function rowToTemplate(row: WorkItemTemplateRow): WorkItemTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    specs: row.specs,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

// ============================================
// REPOSITORY INTERFACE
// ============================================

export interface WorkItemTemplatesRepository {
  /** Find template by ID */
  findById(id: string): Promise<WorkItemTemplate | null>;

  /** Find template by name */
  findByName(name: string): Promise<WorkItemTemplate | null>;

  /** List all templates */
  list(): Promise<WorkItemTemplate[]>;

  /** Create a new template */
  create(input: WorkItemTemplateCreateInput): Promise<WorkItemTemplate>;

  /** Update a template's specs */
  update(id: string, input: Partial<WorkItemTemplateCreateInput>): Promise<WorkItemTemplate | null>;

  /** Delete a template */
  delete(id: string): Promise<boolean>;
}

// ============================================
// REPOSITORY IMPLEMENTATION
// ============================================

export function createWorkItemTemplatesRepository(
  ctx: RepositoryContext
): WorkItemTemplatesRepository {
  const { sql } = ctx;

  return {
    async findById(id) {
      const rows = await sql<WorkItemTemplateRow[]>`
        SELECT * FROM workitem_templates WHERE id = ${id}
      `;
      if (rows.length === 0) return null;
      return rowToTemplate(rows[0]);
    },

    async findByName(name) {
      const rows = await sql<WorkItemTemplateRow[]>`
        SELECT * FROM workitem_templates WHERE name = ${name}
      `;
      if (rows.length === 0) return null;
      return rowToTemplate(rows[0]);
    },

    async list() {
      const rows = await sql<WorkItemTemplateRow[]>`
        SELECT * FROM workitem_templates
        ORDER BY name ASC
      `;
      return rows.map(rowToTemplate);
    },

    async create(input) {
      const id = ulid();
      const now = new Date();

      const rows = await sql<WorkItemTemplateRow[]>`
        INSERT INTO workitem_templates (
          id, name, description, specs, created_at, updated_at
        ) VALUES (
          ${id},
          ${input.name},
          ${input.description},
          ${JSON.stringify(input.specs)}::jsonb,
          ${now},
          ${now}
        )
        RETURNING *
      `;

      return rowToTemplate(rows[0]);
    },

    async update(id, input) {
      const updates: string[] = [];
      const values: unknown[] = [];

      if (input.name !== undefined) {
        updates.push('name');
        values.push(input.name);
      }
      if (input.description !== undefined) {
        updates.push('description');
        values.push(input.description);
      }
      if (input.specs !== undefined) {
        updates.push('specs');
        values.push(JSON.stringify(input.specs));
      }

      if (updates.length === 0) {
        return this.findById(id);
      }

      const rows = await sql<WorkItemTemplateRow[]>`
        UPDATE workitem_templates
        SET
          name = COALESCE(${input.name ?? null}, name),
          description = COALESCE(${input.description ?? null}, description),
          specs = COALESCE(${input.specs ? JSON.stringify(input.specs) : null}::jsonb, specs)
        WHERE id = ${id}
        RETURNING *
      `;

      if (rows.length === 0) return null;
      return rowToTemplate(rows[0]);
    },

    async delete(id) {
      const result = await sql`
        DELETE FROM workitem_templates WHERE id = ${id}
      `;
      return result.count > 0;
    },
  };
}
