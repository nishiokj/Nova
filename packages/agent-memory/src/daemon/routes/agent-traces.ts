import type { HttpServer } from '../server.js'
import type { AgentTracesRepository } from '../../db/repositories/agent-traces.js'
import { badRequest } from '../server.js'
import type { TraceRecord } from 'types'

export function registerTracesRoutes(server: HttpServer, tracesRepo: AgentTracesRepository): void {
  // List traces with optional filters
  server.get('/traces', async (req) => {
    const { session_key, tool_name, limit = '50', offset = '0' } = req.query

    const [traces, total] = await Promise.all([
      tracesRepo.findMany({
        session_key: session_key as string | undefined,
        tool_name: tool_name as string | undefined,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
      }),
      tracesRepo.count({
        session_key: session_key as string | undefined,
        tool_name: tool_name as string | undefined,
      }),
    ])

    return {
      body: {
        traces,
        total,
      },
    }
  })

  // Get recent traces
  server.get('/traces/recent', async (req) => {
    const { limit = '50' } = req.query
    const traces = await tracesRepo.getRecent(parseInt(limit, 10))

    return {
      body: {
        traces,
        total: traces.length,
      },
    }
  })

  // Get traces by session
  server.get('/traces/session/:sessionKey', async (req) => {
    const { sessionKey } = req.params
    const { limit = '50' } = req.query
    const traces = await tracesRepo.findBySession(sessionKey, parseInt(limit, 10))

    return {
      body: {
        traces,
        total: traces.length,
      },
    }
  })

  // Get traces by model ID
  server.get('/traces/model/:modelId', async (req) => {
    const { modelId } = req.params
    const { limit = '50' } = req.query
    // Model ID might be URL-encoded (e.g., anthropic%2Fclaude-opus-4-5-20251101)
    const decodedModelId = decodeURIComponent(modelId)
    const traces = await tracesRepo.findByModelId(decodedModelId, parseInt(limit, 10))

    return {
      body: {
        traces,
        total: traces.length,
      },
    }
  })

  // Get a single trace by ID
  server.get('/traces/:id', async (req) => {
    const { id } = req.params
    const trace = await tracesRepo.findById(id)

    if (!trace) {
      throw badRequest('Trace not found')
    }

    return { body: { trace } }
  })

  // Get trace by git revision (commit SHA)
  server.get('/traces/revision/:revision', async (req) => {
    const { revision } = req.params
    const trace = await tracesRepo.findByRevision(revision)

    if (!trace) {
      throw badRequest('Trace not found for revision')
    }

    return { body: { trace } }
  })

  // Create a new trace
  server.post('/traces', async (req) => {
    const body = req.body as Record<string, unknown> | undefined

    if (!body?.revision) {
      throw badRequest('revision is required')
    }

    if (!body?.trace) {
      throw badRequest('trace is required')
    }

    const trace = await tracesRepo.create({
      id: typeof body.id === 'string' ? body.id : undefined,
      revision: String(body.revision),
      session_key: typeof body.session_key === 'string' ? body.session_key : undefined,
      tool_name: typeof body.tool_name === 'string' ? body.tool_name : undefined,
      tool_version: typeof body.tool_version === 'string' ? body.tool_version : undefined,
      trace: body.trace as TraceRecord,
    })

    return {
      body: { trace },
    }
  })

  // Update a trace
  server.patch('/traces/:id', async (req) => {
    const { id } = req.params
    const body = req.body as Record<string, unknown> | undefined

    const updated = await tracesRepo.update(id, {
      session_key: typeof body?.session_key === 'string' ? body.session_key : undefined,
      tool_name: typeof body?.tool_name === 'string' ? body.tool_name : undefined,
      tool_version: typeof body?.tool_version === 'string' ? body.tool_version : undefined,
      trace: body?.trace as TraceRecord | undefined,
    })

    if (!updated) {
      throw badRequest('Trace not found')
    }

    return { body: { trace: updated } }
  })

  // Delete a trace
  server.delete('/traces/:id', async (req) => {
    const { id } = req.params
    const deleted = await tracesRepo.delete(id)

    if (!deleted) {
      throw badRequest('Trace not found')
    }

    return { body: { deleted: true } }
  })
}
