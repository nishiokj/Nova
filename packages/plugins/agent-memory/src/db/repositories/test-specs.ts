import type { RepositoryContext } from './types.js'
import { generateCanonicalId } from '../../ids.js'
import type { Sql } from 'postgres'

export type TestResult = 'pass' | 'fail' | 'skip' | 'flaky'

export interface TestSpecRow {
  id: string
  entity_id: string
  test_name: string
  test_suite: string | null
  description: string | null
  assertions: unknown | null
  fixtures: unknown | null
  tests_entity_ids: string[] | null
  last_result: TestResult | null
  last_run_at: Date | null
  pass_rate: number | null
  flakiness_score: number | null
  extracted_at: Date
  commit_hash: string | null
  search_vector?: unknown
}

export interface TestSpecInput {
  id?: string
  entity_id: string
  test_name: string
  test_suite?: string | null
  description?: string | null
  assertions?: unknown | null
  fixtures?: unknown | null
  tests_entity_ids?: string[] | null
  last_result?: TestResult | null
  last_run_at?: Date | null
  pass_rate?: number | null
  flakiness_score?: number | null
  commit_hash?: string | null
}

export interface TestSpecsRepository {
  findById(id: string): Promise<TestSpecRow | null>
  findByEntity(entityId: string): Promise<TestSpecRow | null>
  upsert(input: TestSpecInput): Promise<TestSpecRow>
}

export function createTestSpecsRepository(
  ctx: RepositoryContext
): TestSpecsRepository {
  const { sql } = ctx as { sql: Sql }

  return {
    async findById(id) {
      const rows = await sql<TestSpecRow[]>`
        SELECT * FROM test_specs WHERE id = ${id}
      `
      return rows[0] || null
    },

    async findByEntity(entityId) {
      const rows = await sql<TestSpecRow[]>`
        SELECT * FROM test_specs WHERE entity_id = ${entityId}
      `
      return rows[0] || null
    },

    async upsert(input) {
      const id = input.id ?? generateCanonicalId()
      const rows = await sql<TestSpecRow[]>`
        INSERT INTO test_specs (
          id,
          entity_id,
          test_name,
          test_suite,
          description,
          assertions,
          fixtures,
          tests_entity_ids,
          last_result,
          last_run_at,
          pass_rate,
          flakiness_score,
          commit_hash
        ) VALUES (
          ${id},
          ${input.entity_id},
          ${input.test_name},
          ${input.test_suite ?? null},
          ${input.description ?? null},
          ${input.assertions !== undefined ? sql.json(input.assertions as any) : null},
          ${input.fixtures !== undefined ? sql.json(input.fixtures as any) : null},
          ${input.tests_entity_ids ? sql.array(input.tests_entity_ids) : null},
          ${input.last_result ?? null},
          ${input.last_run_at ?? null},
          ${input.pass_rate ?? null},
          ${input.flakiness_score ?? null},
          ${input.commit_hash ?? null}
        )
        ON CONFLICT (entity_id) DO UPDATE SET
          test_name = EXCLUDED.test_name,
          test_suite = EXCLUDED.test_suite,
          description = EXCLUDED.description,
          assertions = EXCLUDED.assertions,
          fixtures = EXCLUDED.fixtures,
          tests_entity_ids = EXCLUDED.tests_entity_ids,
          last_result = EXCLUDED.last_result,
          last_run_at = EXCLUDED.last_run_at,
          pass_rate = EXCLUDED.pass_rate,
          flakiness_score = EXCLUDED.flakiness_score,
          commit_hash = EXCLUDED.commit_hash,
          extracted_at = now()
        RETURNING *
      `
      return rows[0]
    },
  }
}
