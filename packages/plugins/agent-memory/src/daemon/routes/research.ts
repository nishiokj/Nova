/**
 * Research API Routes
 *
 * CRUD for the deep-research pipeline: projects, nodes, sources, claims.
 */

import type { HttpServer } from '../server.js'
import { badRequest } from '../server.js'
import type { ResearchRepository } from '../../db/repositories/research.js'

export function registerResearchRoutes(server: HttpServer, repo: ResearchRepository): void {

  // ── Projects ──

  server.post('/research/projects', async (req) => {
    const body = req.body as Record<string, unknown> | undefined
    if (!body?.title || typeof body.title !== 'string') throw badRequest('title is required')
    if (!body?.seedQuery || typeof body.seedQuery !== 'string') throw badRequest('seedQuery is required')

    const project = await repo.createProject({
      title: body.title,
      seedQuery: body.seedQuery,
      depthBudget: typeof body.depthBudget === 'number' ? body.depthBudget : undefined,
      maxSourcesPerNode: typeof body.maxSourcesPerNode === 'number' ? body.maxSourcesPerNode : undefined,
      outputPath: typeof body.outputPath === 'string' ? body.outputPath : undefined,
    })
    return { body: project }
  })

  server.get('/research/projects', async (req) => {
    const status = typeof req.query?.status === 'string' ? req.query.status as any : undefined
    const projects = await repo.findProjects(status ? { status } : undefined)
    return { body: projects }
  })

  server.get('/research/projects/:id', async (req) => {
    const project = await repo.findProjectById(req.params.id)
    if (!project) throw badRequest('Project not found')
    return { body: project }
  })

  server.patch('/research/projects/:id/status', async (req) => {
    const body = req.body as Record<string, unknown> | undefined
    if (!body?.status || typeof body.status !== 'string') throw badRequest('status is required')
    const project = await repo.updateProjectStatus(req.params.id, body.status as any)
    if (!project) throw badRequest('Project not found')
    return { body: project }
  })

  server.patch('/research/projects/:id/output-path', async (req) => {
    const body = req.body as Record<string, unknown> | undefined
    if (!body?.outputPath || typeof body.outputPath !== 'string') throw badRequest('outputPath is required')
    const project = await repo.updateProjectOutputPath(req.params.id, body.outputPath)
    if (!project) throw badRequest('Project not found')
    return { body: project }
  })

  server.delete('/research/projects/:id', async (req) => {
    const deleted = await repo.deleteProject(req.params.id)
    return { body: { deleted } }
  })

  // ── Nodes ──

  server.post('/research/nodes', async (req) => {
    const body = req.body as Record<string, unknown> | undefined
    if (!body?.projectId || typeof body.projectId !== 'string') throw badRequest('projectId is required')
    if (!body?.query || typeof body.query !== 'string') throw badRequest('query is required')

    const node = await repo.createNode({
      projectId: body.projectId,
      parentId: typeof body.parentId === 'string' ? body.parentId : undefined,
      depth: typeof body.depth === 'number' ? body.depth : 0,
      query: body.query,
      queryType: typeof body.queryType === 'string' ? body.queryType as any : undefined,
    })
    return { body: node }
  })

  server.get('/research/nodes/:id', async (req) => {
    const node = await repo.findNodeById(req.params.id)
    if (!node) throw badRequest('Node not found')
    return { body: node }
  })

  server.get('/research/projects/:projectId/nodes', async (req) => {
    const filters: { status?: any; depth?: number } = {}
    if (typeof req.query?.status === 'string') filters.status = req.query.status
    if (typeof req.query?.depth === 'string') filters.depth = parseInt(req.query.depth)
    const nodes = await repo.findNodesByProject(req.params.projectId, Object.keys(filters).length ? filters : undefined)
    return { body: nodes }
  })

  server.get('/research/projects/:projectId/nodes/top', async (req) => {
    const limit = typeof req.query?.limit === 'string' ? parseInt(req.query.limit) : 5
    const nodes = await repo.findTopScoredNodes(req.params.projectId, limit)
    return { body: nodes }
  })

  server.get('/research/projects/:projectId/tree', async (req) => {
    const nodes = await repo.findFullTree(req.params.projectId)
    return { body: nodes }
  })

  server.patch('/research/nodes/:id/status', async (req) => {
    const body = req.body as Record<string, unknown> | undefined
    if (!body?.status || typeof body.status !== 'string') throw badRequest('status is required')
    const node = await repo.updateNodeStatus(req.params.id, body.status as any)
    if (!node) throw badRequest('Node not found')
    return { body: node }
  })

  server.patch('/research/nodes/:id/synthesis', async (req) => {
    const body = req.body as Record<string, unknown> | undefined
    if (!body?.synthesis || typeof body.synthesis !== 'string') throw badRequest('synthesis is required')
    if (!body?.significance || typeof body.significance !== 'string') throw badRequest('significance is required')
    if (!Array.isArray(body?.firstPrinciples)) throw badRequest('firstPrinciples is required')
    if (!Array.isArray(body?.gaps)) throw badRequest('gaps is required')

    const node = await repo.updateNodeSynthesis(req.params.id, {
      synthesis: body.synthesis,
      significance: body.significance,
      firstPrinciples: body.firstPrinciples as any,
      gaps: body.gaps as any,
    })
    if (!node) throw badRequest('Node not found')
    return { body: node }
  })

  server.patch('/research/nodes/:id/scores', async (req) => {
    const body = req.body as Record<string, unknown> | undefined
    if (typeof body?.priorityScore !== 'number') throw badRequest('priorityScore is required')
    if (typeof body?.noveltyScore !== 'number') throw badRequest('noveltyScore is required')
    if (typeof body?.gapDensity !== 'number') throw badRequest('gapDensity is required')

    const node = await repo.updateNodeScores(req.params.id, {
      priorityScore: body.priorityScore,
      noveltyScore: body.noveltyScore,
      gapDensity: body.gapDensity,
    })
    if (!node) throw badRequest('Node not found')
    return { body: node }
  })

  // ── Sources ──

  server.post('/research/sources', async (req) => {
    const body = req.body as Record<string, unknown> | undefined
    if (!body?.nodeId || typeof body.nodeId !== 'string') throw badRequest('nodeId is required')
    if (!body?.url || typeof body.url !== 'string') throw badRequest('url is required')

    const source = await repo.createSource({
      nodeId: body.nodeId,
      url: body.url,
      title: typeof body.title === 'string' ? body.title : undefined,
      domain: typeof body.domain === 'string' ? body.domain : undefined,
      rawContent: typeof body.rawContent === 'string' ? body.rawContent : undefined,
      extractedContent: typeof body.extractedContent === 'string' ? body.extractedContent : undefined,
      qualityScore: typeof body.qualityScore === 'number' ? body.qualityScore : undefined,
    })
    return { body: source }
  })

  server.get('/research/nodes/:nodeId/sources', async (req) => {
    const sources = await repo.findSourcesByNode(req.params.nodeId)
    return { body: sources }
  })

  server.get('/research/nodes/:nodeId/domains', async (req) => {
    const domains = await repo.findDomainsByNode(req.params.nodeId)
    return { body: domains }
  })

  // ── Claims ──

  server.post('/research/claims', async (req) => {
    const body = req.body as Record<string, unknown> | undefined
    if (!body?.nodeId || typeof body.nodeId !== 'string') throw badRequest('nodeId is required')
    if (!body?.claimText || typeof body.claimText !== 'string') throw badRequest('claimText is required')

    const claim = await repo.createClaim({
      nodeId: body.nodeId,
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      claimText: body.claimText,
      evidenceText: typeof body.evidenceText === 'string' ? body.evidenceText : undefined,
      confidence: typeof body.confidence === 'string' ? body.confidence as any : undefined,
      volatility: typeof body.volatility === 'string' ? body.volatility as any : undefined,
    })
    return { body: claim }
  })

  server.get('/research/nodes/:nodeId/claims', async (req) => {
    const claims = await repo.findClaimsByNode(req.params.nodeId)
    return { body: claims }
  })

  server.get('/research/claims/stale', async (req) => {
    const limit = typeof req.query?.limit === 'string' ? parseInt(req.query.limit) : 20
    const claims = await repo.findStaleClaims(limit)
    return { body: claims }
  })

  server.post('/research/claims/:id/verify', async (req) => {
    const claim = await repo.updateClaimVerified(req.params.id)
    if (!claim) throw badRequest('Claim not found')
    return { body: claim }
  })

  server.patch('/research/claims/:id/status', async (req) => {
    const body = req.body as Record<string, unknown> | undefined
    if (!body?.status || typeof body.status !== 'string') throw badRequest('status is required')
    const claim = await repo.updateClaimStatus(
      req.params.id,
      body.status as any,
      typeof body.supersededBy === 'string' ? body.supersededBy : undefined,
    )
    if (!claim) throw badRequest('Claim not found')
    return { body: claim }
  })
}
