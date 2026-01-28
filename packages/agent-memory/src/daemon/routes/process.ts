/**
 * Processing Routes
 *
 * HTTP endpoints for processing raw envelopes into canonical entities.
 */

import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import type { ConnectorType } from '../../ids.js'
import { notFound } from '../server.js'

export function registerProcessRoutes(server: HttpServer, daemon: SyncDaemon): void {
  const { engine, syncJobRepo } = daemon

  // Process a specific sync job by ID
  server.post('/process/jobs/:id', async (req) => {
    const body = req.body as { transformationIds?: string[] } | undefined
    const job = await syncJobRepo.findById(req.params.id)
    if (!job) {
      throw notFound(`Job not found: ${req.params.id}`)
    }

    const result = await engine.processSyncJob(job.id, {
      transformationIds: body?.transformationIds,
    })
    return { body: { job, result } }
  })

  // Process all unprocessed envelopes
  server.post('/process/all', async (req) => {
    const body = req.body as { transformationIds?: string[] } | undefined
    const result = await engine.processAll({
      transformationIds: body?.transformationIds,
    })
    return { body: { result } }
  })

  // Reprocess all errored envelopes
  server.post('/process/errored', async (req) => {
    const body = req.body as { transformationIds?: string[] } | undefined
    const result = await engine.processErrored({
      transformationIds: body?.transformationIds,
    })
    return { body: { result } }
  })

  // Reprocess all envelopes matching a scope filter
  server.post('/process/reprocess', async (req) => {
    const body = req.body as {
      connector?: string
      entityType?: string
      transformationIds?: string[]
    } | undefined

    const result = await engine.reprocessFiltered(
      { connector: body?.connector as ConnectorType | undefined, entityType: body?.entityType },
      { transformationIds: body?.transformationIds }
    )
    return { body: { result } }
  })
}
