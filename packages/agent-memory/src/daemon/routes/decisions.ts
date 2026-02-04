import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import type { CodingDecisionsRepository } from '../../db/repositories/coding-decisions.js'
import { badRequest } from '../server.js'

export function registerDecisionsRoutes(server: HttpServer, decisionsRepo: CodingDecisionsRepository): void {
  // Full-text keyword search
  server.get('/decisions/search', async (req) => {
    const { q, category, confidence, mode, min_similarity, limit = '20', offset = '0' } = req.query

    if (!q) {
      return { body: { decisions: [], total: 0 } }
    }

    const parsedMinSimilarity = typeof min_similarity === 'string' ? Number(min_similarity) : undefined
    const results = await decisionsRepo.search(q, {
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      category: category as string | undefined,
      confidence: confidence as string | undefined,
      mode: typeof mode === 'string' ? (mode as 'fts' | 'trgm') : undefined,
      minSimilarity: Number.isFinite(parsedMinSimilarity) ? parsedMinSimilarity : undefined,
    })

    return {
      body: {
        decisions: results,
        total: results.length,
        query: q,
        filters: { category, confidence, mode, min_similarity },
      },
    }
  })

  // Semantic similarity search (accepts a pre-computed embedding vector)
  server.post('/decisions/similar', async (req) => {
    const body = req.body as Record<string, unknown> | undefined
    const embedding = body?.embedding as number[] | undefined
    if (!embedding || !Array.isArray(embedding)) {
      throw badRequest('embedding (number[]) is required')
    }

    const results = await decisionsRepo.similarByEmbedding(embedding, {
      limit: typeof body?.limit === 'number' ? body.limit : 10,
      threshold: typeof body?.threshold === 'number' ? body.threshold : 0.7,
      category: typeof body?.category === 'string' ? body.category : undefined,
      confidence: typeof body?.confidence === 'string' ? body.confidence : undefined,
    })

    return {
      body: {
        decisions: results,
        total: results.length,
        filters: { category: body?.category, confidence: body?.confidence },
      },
    }
  })

  // Update embedding for a single decision
  server.patch('/decisions/:id/embedding', async (req) => {
    const { id } = req.params
    const body = req.body as Record<string, unknown> | undefined
    const embedding = body?.embedding as number[] | undefined
    if (!embedding || !Array.isArray(embedding)) {
      throw badRequest('embedding (number[]) is required')
    }

    const updated = await decisionsRepo.updateEmbedding(id, embedding)
    return { body: { updated } }
  })
}
