import type { RepositoryContext } from './types.js'

export interface CodingDecisionRow {
  id: string
  category: string
  decision: string
  rationale: string
  alternatives_considered: string
  tradeoffs: string
  scope: string
  project_context: string
  task_context: string
  confidence: string
  signal_strength: string
  reversibility: string
  created_at: Date
  source_timestamp?: Date | null
  search_vector?: unknown
  embedding?: number[] | null
}

export interface CodingDecisionRowWithRank extends CodingDecisionRow {
  rank: number
}

export interface CodingDecisionRowWithSimilarity extends CodingDecisionRow {
  similarity: number
}

export interface DecisionSearchOptions {
  limit?: number
  offset?: number
  category?: string
  confidence?: string
  mode?: 'fts' | 'trgm'
  minSimilarity?: number
}

export interface DecisionSimilarityOptions {
  limit?: number
  threshold?: number
  category?: string
  confidence?: string
}

export interface CodingDecisionsRepository {
  search(query: string, options?: DecisionSearchOptions): Promise<Array<CodingDecisionRowWithRank | CodingDecisionRowWithSimilarity>>
  similarByEmbedding(embedding: number[], options?: DecisionSimilarityOptions): Promise<CodingDecisionRowWithSimilarity[]>
  updateEmbedding(id: string, embedding: number[]): Promise<boolean>
}

export function createCodingDecisionsRepository(
  ctx: RepositoryContext
): CodingDecisionsRepository {
  const { sql } = ctx

  return {
    async search(query, options = {}) {
      const {
        limit = 20,
        offset = 0,
        category,
        confidence,
        mode = 'fts',
        minSimilarity = 0.18,
      } = options

      if (mode === 'trgm') {
        const searchExpr = sql`concat_ws(' ', decision, rationale, tradeoffs, alternatives_considered, category, scope, project_context, task_context)`
        const rows = await sql<CodingDecisionRowWithSimilarity[]>`
          SELECT *, similarity(${searchExpr}, ${query}) as similarity
          FROM coding_decisions
          WHERE ${searchExpr} % ${query}
            AND similarity(${searchExpr}, ${query}) >= ${minSimilarity}
            ${category ? sql`AND category = ${category}` : sql``}
            ${confidence ? sql`AND confidence = ${confidence}` : sql``}
          ORDER BY similarity DESC
          LIMIT ${limit}
          OFFSET ${offset}
        `

        return rows
      }

      const rows = await sql<CodingDecisionRowWithRank[]>`
          SELECT *, ts_rank(search_vector, plainto_tsquery('english', ${query})) as rank
          FROM coding_decisions
          WHERE search_vector @@ plainto_tsquery('english', ${query})
            ${category ? sql`AND category = ${category}` : sql``}
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
        confidence,
      } = options

      const vectorLiteral = `[${embedding.join(',')}]`
      const rows = await sql<CodingDecisionRowWithSimilarity[]>`
        SELECT *, 1 - (embedding <=> ${vectorLiteral}::vector) as similarity
        FROM coding_decisions
        WHERE embedding IS NOT NULL
          AND 1 - (embedding <=> ${vectorLiteral}::vector) >= ${threshold}
          ${category ? sql`AND category = ${category}` : sql``}
          ${confidence ? sql`AND confidence = ${confidence}` : sql``}
        ORDER BY embedding <=> ${vectorLiteral}::vector
        LIMIT ${limit}
      `

      return rows
    },

    async updateEmbedding(id, embedding) {
      const vectorLiteral = `[${embedding.join(',')}]`
      const result = await sql`
        UPDATE coding_decisions
        SET embedding = ${vectorLiteral}::vector
        WHERE id = ${id}
      `
      return result.count > 0
    },
  }
}
