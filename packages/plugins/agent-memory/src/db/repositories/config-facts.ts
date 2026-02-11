import type { RepositoryContext } from './types.js'
import { generateCanonicalId } from '../../ids.js'
import type { Sql } from 'postgres'

export type ConfigType = 'env_var' | 'feature_flag' | 'build_config' | 'runtime_config'
export type ValueType = 'string' | 'number' | 'boolean' | 'object' | 'array'

export interface ConfigFactRow {
  id: string
  key_path: string
  config_type: ConfigType
  value_type: ValueType | null
  default_value: unknown | null
  current_value: unknown | null
  redacted_value: unknown | null
  value_hash: string | null
  is_sensitive: boolean
  redaction_reason: string | null
  description: string | null
  source_file: string | null
  source_line: number | null
  affects_entity_ids: string[] | null
  discovered_at: Date
  last_observed_at: Date
  discovery_method: string | null
  search_vector?: unknown
}

export interface ConfigFactInput {
  id?: string
  key_path: string
  config_type: ConfigType
  value_type?: ValueType | null
  default_value?: unknown | null
  current_value?: unknown | null
  redacted_value?: unknown | null
  value_hash?: string | null
  is_sensitive?: boolean
  redaction_reason?: string | null
  description?: string | null
  source_file?: string | null
  source_line?: number | null
  affects_entity_ids?: string[] | null
  discovery_method?: string | null
}

export interface ConfigFactsRepository {
  findById(id: string): Promise<ConfigFactRow | null>
  findByKeyPath(keyPath: string, sourceFile?: string | null): Promise<ConfigFactRow[]>
  upsert(input: ConfigFactInput): Promise<ConfigFactRow>
}

export function createConfigFactsRepository(
  ctx: RepositoryContext
): ConfigFactsRepository {
  const { sql } = ctx as { sql: Sql }

  return {
    async findById(id) {
      const rows = await sql<ConfigFactRow[]>`
        SELECT * FROM config_facts WHERE id = ${id}
      `
      return rows[0] || null
    },

    async findByKeyPath(keyPath, sourceFile) {
      const rows = await sql<ConfigFactRow[]>`
        SELECT * FROM config_facts
        WHERE key_path = ${keyPath}
          ${sourceFile ? sql`AND source_file = ${sourceFile}` : sql``}
        ORDER BY last_observed_at DESC
      `
      return rows
    },

    async upsert(input) {
      const id = input.id ?? generateCanonicalId()
      const rows = await sql<ConfigFactRow[]>`
        INSERT INTO config_facts (
          id,
          key_path,
          config_type,
          value_type,
          default_value,
          current_value,
          redacted_value,
          value_hash,
          is_sensitive,
          redaction_reason,
          description,
          source_file,
          source_line,
          affects_entity_ids,
          discovery_method
        ) VALUES (
          ${id},
          ${input.key_path},
          ${input.config_type},
          ${input.value_type ?? null},
          ${input.default_value !== undefined ? sql.json(input.default_value as any) : null},
          ${input.current_value !== undefined ? sql.json(input.current_value as any) : null},
          ${input.redacted_value !== undefined ? sql.json(input.redacted_value as any) : null},
          ${input.value_hash ?? null},
          ${input.is_sensitive ?? false},
          ${input.redaction_reason ?? null},
          ${input.description ?? null},
          ${input.source_file ?? null},
          ${input.source_line ?? null},
          ${input.affects_entity_ids ? sql.array(input.affects_entity_ids) : null},
          ${input.discovery_method ?? null}
        )
        ON CONFLICT (key_path, source_file) DO UPDATE SET
          config_type = EXCLUDED.config_type,
          value_type = EXCLUDED.value_type,
          default_value = EXCLUDED.default_value,
          current_value = EXCLUDED.current_value,
          redacted_value = EXCLUDED.redacted_value,
          value_hash = EXCLUDED.value_hash,
          is_sensitive = EXCLUDED.is_sensitive,
          redaction_reason = EXCLUDED.redaction_reason,
          description = EXCLUDED.description,
          source_line = EXCLUDED.source_line,
          affects_entity_ids = EXCLUDED.affects_entity_ids,
          discovery_method = EXCLUDED.discovery_method,
          last_observed_at = now()
        RETURNING *
      `
      return rows[0]
    },
  }
}
