import type { RepositoryContext } from './types.js'

export interface CodingPreferenceRow {
  id: string
  category: string
  kind: string
  preference: string
  entity_free_formulation: string
  scope: string
  context: string
  failure_mode_prevented: string
  signal_strength: string
  evidence_count: number
  evidence_notes: unknown
  counterexample: string
  confidence: string
  created_at: Date
  search_vector?: unknown
  embedding?: number[] | null
}

export interface CodingPreferenceRowWithRank extends CodingPreferenceRow {
  rank: number
}

export interface CodingPreferenceRowWithSimilarity extends CodingPreferenceRow {
  similarity: number
}

export interface SearchOptions {
  limit?: number
  offset?: number
  category?: string
  kind?: string
  confidence?: string
}

export interface SimilarityOptions {
  limit?: number
  threshold?: number
  category?: string
  kind?: string
  confidence?: string
}

export interface CodingPreferencesRepository {
  search(query: string, options?: SearchOptions): Promise<CodingPreferenceRowWithRank[]>
  similarByEmbedding(embedding: number[], options?: SimilarityOptions): Promise<CodingPreferenceRowWithSimilarity[]>
  updateEmbedding(id: string, embedding: number[]): Promise<boolean>
}

export function createCodingPreferencesRepository(
  ctx: RepositoryContext
): CodingPreferencesRepository {
  const { sql } = ctx

  return {
    async search(query, options = {}) {
      const {
        limit = 20,
        offset = 0,
        category,
        kind,
        confidence,
      } = options

      const rows = await sql<CodingPreferenceRowWithRank[]>`
        SELECT *, ts_rank(search_vector, plainto_tsquery('english', ${query})) as rank
        FROM coding_preferences
        WHERE search_vector @@ plainto_tsquery('english', ${query})
          ${category ? sql`AND category = ${category}` : sql``}
          ${kind ? sql`AND kind = ${kind}` : sql``}
          ${confidence ? sql`AND confidence = ${confidence}` : sql``}
        ORDER BY rank DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `

      return rows
    },

    async similarByEmbedding(embedding, options = {}) {
      const {
        limit = 10,
        threshold = 0.7,
        category,
        kind,
        confidence,
      } = options

      const vectorLiteral = `[${embedding.join(',')}]`
      const rows = await sql<CodingPreferenceRowWithSimilarity[]>`
        SELECT *, 1 - (embedding <=> ${vectorLiteral}::vector) as similarity
        FROM coding_preferences
        WHERE embedding IS NOT NULL
          AND 1 - (embedding <=> ${vectorLiteral}::vector) >= ${threshold}
          ${category ? sql`AND category = ${category}` : sql``}
          ${kind ? sql`AND kind = ${kind}` : sql``}
          ${confidence ? sql`AND confidence = ${confidence}` : sql``}
        ORDER BY embedding <=> ${vectorLiteral}::vector
        LIMIT ${limit}
      `

      return rows
    },

    async updateEmbedding(id, embedding) {
      const vectorLiteral = `[${embedding.join(',')}]`
      const result = await sql`
        UPDATE coding_preferences
        SET embedding = ${vectorLiteral}::vector
        WHERE id = ${id}
      `
      return result.count > 0
    },
  }
}
