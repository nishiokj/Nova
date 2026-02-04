import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest } from '../server.js'

export function registerPreferencesRoutes(server: HttpServer, daemon: SyncDaemon): void {
  const { preferencesRepo } = daemon

  // Full-text keyword search
  server.get('/preferences/search', async (req) => {
    const { q, category, kind, confidence, mode, min_similarity, limit = '20', offset = '0' } = req.query

    if (!q) {
      return { body: { preferences: [], total: 0 } }
    }

    const parsedMinSimilarity = typeof min_similarity === 'string' ? Number(min_similarity) : undefined
    const results = await preferencesRepo.search(q, {
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      category: category as string | undefined,
      kind: kind as string | undefined,
      confidence: confidence as string | undefined,
      mode: typeof mode === 'string' ? (mode as 'fts' | 'trgm') : undefined,
      minSimilarity: Number.isFinite(parsedMinSimilarity) ? parsedMinSimilarity : undefined,
    })

    return {
      body: {
        preferences: results,
        total: results.length,
        query: q,
        filters: { category, kind, confidence, mode, min_similarity },
      },
    }
  })

  // Semantic similarity search (accepts a pre-computed embedding vector)
  server.post('/preferences/similar', async (req) => {
    const body = req.body as Record<string, unknown> | undefined
    const embedding = body?.embedding as number[] | undefined
    if (!embedding || !Array.isArray(embedding)) {
      throw badRequest('embedding (number[]) is required')
    }

    const results = await preferencesRepo.similarByEmbedding(embedding, {
      limit: typeof body?.limit === 'number' ? body.limit : 10,
      threshold: typeof body?.threshold === 'number' ? body.threshold : 0.7,
      category: typeof body?.category === 'string' ? body.category : undefined,
      kind: typeof body?.kind === 'string' ? body.kind : undefined,
      confidence: typeof body?.confidence === 'string' ? body.confidence : undefined,
    })

    return {
      body: {
        preferences: results,
        total: results.length,
        filters: { category: body?.category, kind: body?.kind, confidence: body?.confidence },
      },
    }
  })

  // Update embedding for a single preference
  server.patch('/preferences/:id/embedding', async (req) => {
    const { id } = req.params
    const body = req.body as Record<string, unknown> | undefined
    const embedding = body?.embedding as number[] | undefined
    if (!embedding || !Array.isArray(embedding)) {
      throw badRequest('embedding (number[]) is required')
    }

    const updated = await preferencesRepo.updateEmbedding(id, embedding)
    return { body: { updated } }
  })
}
