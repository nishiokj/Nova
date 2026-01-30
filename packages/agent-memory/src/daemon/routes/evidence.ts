import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { EvidenceRetriever, type RetrievalRequest } from '../../evidence/retriever.js'
import { createEvidenceRetrievalLogRepository } from '../../db/repositories/evidence-retrieval-log.js'
import { generateCanonicalId } from '../../ids.js'

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseRequest(body: unknown): RetrievalRequest | null {
  if (!isObject(body)) return null
  const task = body.task
  const budget = body.budget
  if (!isObject(task) || !isObject(budget)) return null
  if (typeof task.objective !== 'string' || typeof task.sessionId !== 'string') return null

  const minCoverage = isObject(budget.minCoverage) ? budget.minCoverage : {}

  return {
    task: {
      objective: task.objective,
      recentMessages: Array.isArray(task.recentMessages)
        ? task.recentMessages.filter((m) => typeof m === 'string')
        : [],
      touchedFiles: Array.isArray(task.touchedFiles)
        ? task.touchedFiles.filter((p) => typeof p === 'string')
        : undefined,
      iteration: typeof task.iteration === 'number' ? task.iteration : 0,
      sessionId: task.sessionId,
      workItemId: typeof task.workItemId === 'string' ? task.workItemId : undefined,
    },
    budget: {
      maxTokens: typeof budget.maxTokens === 'number' ? budget.maxTokens : 1000,
      maxItems: typeof budget.maxItems === 'number' ? budget.maxItems : 20,
      minCoverage: minCoverage as Record<string, number>,
    },
  }
}

function buildQueryText(task: RetrievalRequest['task']): string {
  const parts: string[] = []
  if (task.objective) parts.push(task.objective)
  if (Array.isArray(task.recentMessages)) {
    parts.push(...task.recentMessages.filter((m) => typeof m === 'string' && m.trim().length > 0))
  }
  return parts.join(' ').slice(0, 500)
}

export function registerEvidenceRoutes(server: HttpServer, daemon: SyncDaemon): void {
  server.post('/evidence/retrieve', async (req) => {
    const parsed = parseRequest(req.body)
    if (!parsed) {
      return { status: 400, body: { error: 'Invalid request body' } }
    }

    const retriever = new EvidenceRetriever(daemon.sql)

    try {
      const result = await retriever.retrieve(parsed)
      return {
        body: {
          content: result.content,
          atoms: result.atoms,
          metrics: result.metrics,
        },
      }
    } catch (error) {
      const repo = createEvidenceRetrievalLogRepository({ sql: daemon.sql })
      await repo.create({
        id: generateCanonicalId(),
        session_id: parsed.task.sessionId,
        work_item_id: parsed.task.workItemId ?? null,
        request_id: generateCanonicalId(),
        injector_version: 'v2',
        task_objective: parsed.task.objective,
        query_text: buildQueryText(parsed.task),
        budget: parsed.budget,
        status: 'error',
        error_code: 'RETRIEVER_ERROR',
        error_message: error instanceof Error ? error.message : String(error),
      })
      return { status: 500, body: { error: 'Evidence retrieval failed' } }
    }
  })
}
