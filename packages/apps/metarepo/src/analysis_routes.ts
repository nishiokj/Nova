import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ArtifactNotFoundError,
  BlueHandoffNotFoundError,
  RepoNotFoundError,
  RunNotFoundError,
  ValidationError,
} from './service.js'
import type {
  BlueAssignRequest,
  BlueHandoffInput,
  CreateBugInput,
  CreateBlueHandoffRequest,
  CreateEnvProfileInput,
  CreateRepoInput,
  CreateSecretRefInput,
  MetarepoApi,
  RefereeRunRequest,
  UpdateRepoInput,
} from './types.js'

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(payload))
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const body = await readRequestBody(req)
  if (!body) throw new HttpError(400, 'missing json body')
  try {
    return JSON.parse(body) as T
  } catch {
    throw new HttpError(400, 'invalid json body')
  }
}

function asObject(value: unknown, label = 'body'): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new HttpError(400, `invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${field} is required`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  return optionalString(value)
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  throw new HttpError(400, `${field} must be a positive integer`)
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, `${field} must be an array of strings`)
  }
  const normalized = value.map(item => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new HttpError(400, `${field} must contain only non-empty strings`)
    }
    return item.trim()
  })
  return [...new Set(normalized)]
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  return stringArray(value, field)
}

function parseCreateRepoInput(body: unknown): CreateRepoInput {
  const payload = asObject(body)
  const source = asObject(payload.source, 'source')
  const kind = asString(source.kind, 'source.kind')

  if (kind === 'local') {
    return {
      name: optionalString(payload.name),
      defaultEnvProfileId: optionalString(payload.defaultEnvProfileId),
      source: {
        kind: 'local',
        rootPath: asString(source.rootPath, 'source.rootPath'),
        registryPath: optionalString(source.registryPath),
      },
    }
  }

  if (kind === 'git') {
    return {
      name: optionalString(payload.name),
      defaultEnvProfileId: optionalString(payload.defaultEnvProfileId),
      source: {
        kind: 'git',
        cloneUrl: asString(source.cloneUrl, 'source.cloneUrl'),
        defaultBranch: optionalString(source.defaultBranch),
        authRef: optionalString(source.authRef),
        registryPath: optionalString(source.registryPath),
      },
    }
  }

  throw new HttpError(400, 'source.kind must be local or git')
}

function parseUpdateRepoInput(body: unknown): UpdateRepoInput {
  const payload = asObject(body)
  return {
    name: optionalString(payload.name),
    defaultBranch: optionalNullableString(payload.defaultBranch),
    authRef: optionalNullableString(payload.authRef),
    registryPath: optionalNullableString(payload.registryPath),
    defaultEnvProfileId: optionalNullableString(payload.defaultEnvProfileId),
  }
}

function parseCreateBugInput(body: unknown): CreateBugInput {
  const payload = asObject(body)
  return {
    title: asString(payload.title, 'title'),
    description: optionalString(payload.description),
    status: optionalString(payload.status),
    payload: payload.payload,
    runId: optionalString(payload.runId),
    sourceFingerprint: payload.sourceFingerprint as CreateBugInput['sourceFingerprint'],
  }
}

function parseCreateEnvProfileInput(body: unknown): CreateEnvProfileInput {
  const payload = asObject(body)
  return {
    name: asString(payload.name, 'name'),
    variables: (payload.variables && typeof payload.variables === 'object' ? payload.variables : undefined) as Record<string, string> | undefined,
    secretBindings: (payload.secretBindings && typeof payload.secretBindings === 'object' ? payload.secretBindings : undefined) as Record<string, string> | undefined,
  }
}

function parseCreateSecretRefInput(body: unknown): CreateSecretRefInput {
  const payload = asObject(body)
  return {
    kind: asString(payload.kind, 'kind'),
    name: asString(payload.name, 'name'),
    provider: asString(payload.provider, 'provider'),
    value: optionalString(payload.value),
    externalRef: optionalString(payload.externalRef),
  }
}

function parseCreateBlueHandoffInput(body: unknown): CreateBlueHandoffRequest {
  const payload = asObject(body)
  const handoff = asObject(payload.handoff, 'handoff')
  return {
    repoId: asString(payload.repoId, 'repoId'),
    requestedBy: optionalString(payload.requestedBy),
    source: payload.source as { ref?: string } | undefined,
    handoff: {
      assignmentArtifactId: asString(handoff.assignmentArtifactId, 'handoff.assignmentArtifactId'),
      testFiles: stringArray(handoff.testFiles, 'handoff.testFiles'),
      changedFiles: optionalStringArray(handoff.changedFiles, 'handoff.changedFiles'),
      testCommand: stringArray(handoff.testCommand, 'handoff.testCommand'),
      summary: optionalString(handoff.summary),
      notes: optionalString(handoff.notes),
      bugIds: optionalStringArray(handoff.bugIds, 'handoff.bugIds'),
    } satisfies BlueHandoffInput,
  }
}

function parseRpcRequest(body: unknown): Record<string, unknown> {
  return asObject(body)
}

function mapError(error: unknown): { statusCode: number; message: string } {
  if (error instanceof HttpError) {
    return { statusCode: error.statusCode, message: error.message }
  }
  if (error instanceof ValidationError) {
    return { statusCode: 400, message: error.message }
  }
  if (
    error instanceof RepoNotFoundError
    || error instanceof RunNotFoundError
    || error instanceof ArtifactNotFoundError
    || error instanceof BlueHandoffNotFoundError
  ) {
    return { statusCode: 404, message: error.message }
  }
  return {
    statusCode: 500,
    message: error instanceof Error ? error.message : 'internal error',
  }
}

async function dispatchRpc(api: MetarepoApi, method: string, body: unknown): Promise<unknown> {
  const payload = parseRpcRequest(body)

  switch (method) {
    case 'graph.boundaries':
      return api.graphBoundaries({
        repoId: asString(payload.repoId, 'repoId'),
        filepath: optionalString(payload.filepath),
        requestedBy: optionalString(payload.requestedBy),
        source: payload.source as { ref?: string } | undefined,
      })
    case 'graph.deps':
      return api.graphDeps({
        repoId: asString(payload.repoId, 'repoId'),
        entityId: asString(payload.entityId, 'entityId'),
        requestedBy: optionalString(payload.requestedBy),
        source: payload.source as { ref?: string } | undefined,
      })
    case 'graph.tree':
      return api.graphTree({
        repoId: asString(payload.repoId, 'repoId'),
        entityId: asString(payload.entityId, 'entityId'),
        maxDepth: optionalNumber(payload.maxDepth, 'maxDepth'),
        requestedBy: optionalString(payload.requestedBy),
        source: payload.source as { ref?: string } | undefined,
      })
    case 'graph.env':
      return api.graphEnv({
        repoId: asString(payload.repoId, 'repoId'),
        entityId: asString(payload.entityId, 'entityId'),
        requestedBy: optionalString(payload.requestedBy),
        source: payload.source as { ref?: string } | undefined,
      })
    case 'graph.readiness':
      return api.graphReadiness({
        repoId: asString(payload.repoId, 'repoId'),
        entityId: asString(payload.entityId, 'entityId'),
        requestedBy: optionalString(payload.requestedBy),
        source: payload.source as { ref?: string } | undefined,
      })
    case 'graph.gaps':
      return api.graphGaps({
        repoId: asString(payload.repoId, 'repoId'),
        filepath: optionalString(payload.filepath),
        requestedBy: optionalString(payload.requestedBy),
        source: payload.source as { ref?: string } | undefined,
      })
    case 'graph.index':
      return api.graphIndex({
        repoId: asString(payload.repoId, 'repoId'),
        filepath: optionalString(payload.filepath),
        maxDepth: optionalNumber(payload.maxDepth, 'maxDepth'),
        requestedBy: optionalString(payload.requestedBy),
        source: payload.source as { ref?: string } | undefined,
      })
    case 'blue.assign':
      return api.blueAssign({
        repoId: asString(payload.repoId, 'repoId'),
        selector: optionalString(payload.selector),
        maxDepth: optionalNumber(payload.maxDepth, 'maxDepth'),
        requestedBy: optionalString(payload.requestedBy),
        source: payload.source as BlueAssignRequest['source'],
      })
    case 'test.recent_paths':
      return api.testRecentPaths({
        repoId: asString(payload.repoId, 'repoId'),
        selector: optionalString(payload.selector),
        requestedBy: optionalString(payload.requestedBy),
        source: payload.source as { ref?: string } | undefined,
      })
    case 'test.smells':
      return api.testSmells({
        repoId: asString(payload.repoId, 'repoId'),
        selector: optionalString(payload.selector),
        requestedBy: optionalString(payload.requestedBy),
        source: payload.source as { ref?: string } | undefined,
      })
    case 'review.run':
      return api.reviewRun({
        repoId: asString(payload.repoId, 'repoId'),
        baseSha: asString(payload.baseSha, 'baseSha'),
        headSha: asString(payload.headSha, 'headSha'),
        maxDepth: optionalNumber(payload.maxDepth, 'maxDepth'),
        requestedBy: optionalString(payload.requestedBy),
        source: payload.source as { ref?: string } | undefined,
      })
    case 'red.targets':
      return api.redTargets({
        repoId: asString(payload.repoId, 'repoId'),
        selector: optionalString(payload.selector),
        maxDepth: optionalNumber(payload.maxDepth, 'maxDepth'),
        requestedBy: optionalString(payload.requestedBy),
        source: payload.source as { ref?: string } | undefined,
      })
    case 'red.dossier':
      return api.redDossier({
        repoId: asString(payload.repoId, 'repoId'),
        boundaryId: asString(payload.boundaryId, 'boundaryId'),
        maxDepth: optionalNumber(payload.maxDepth, 'maxDepth'),
        requestedBy: optionalString(payload.requestedBy),
        source: payload.source as { ref?: string } | undefined,
      })
    case 'red.mutate':
      return api.redMutate({
        repoId: asString(payload.repoId, 'repoId'),
        proposal: asObject(payload.proposal, 'proposal') as never,
        requestedBy: optionalString(payload.requestedBy),
        source: payload.source as { ref?: string } | undefined,
      })
    case 'referee.run':
      return api.refereeRun({
        proposalArtifactId: asString(payload.proposalArtifactId, 'proposalArtifactId'),
        requestedBy: optionalString(payload.requestedBy),
      } satisfies RefereeRunRequest)
    default:
      throw new HttpError(404, 'unknown rpc method')
  }
}

export function createRequestListener(api: MetarepoApi) {
  return async function requestListener(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname

    try {
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, api.health())
        return
      }

      if (method === 'GET' && pathname === '/readyz') {
        sendJson(res, 200, await api.ready())
        return
      }

      if (method === 'POST' && pathname === '/repos') {
        sendJson(res, 201, await api.createRepo(parseCreateRepoInput(await readJsonBody(req))))
        return
      }

      const repoMatch = pathname.match(/^\/repos\/([^/]+)$/)
      if (repoMatch && method === 'GET') {
        sendJson(res, 200, await api.getRepo(decodeURIComponent(repoMatch[1])))
        return
      }
      if (repoMatch && method === 'PATCH') {
        sendJson(res, 200, await api.updateRepo(decodeURIComponent(repoMatch[1]), parseUpdateRepoInput(await readJsonBody(req))))
        return
      }

      const repoBlueHandoffsMatch = pathname.match(/^\/repos\/([^/]+)\/blue-handoffs$/)
      if (repoBlueHandoffsMatch && method === 'POST') {
        const parsed = parseCreateBlueHandoffInput(await readJsonBody(req))
        sendJson(res, 201, await api.createBlueHandoff({
          ...parsed,
          repoId: decodeURIComponent(repoBlueHandoffsMatch[1]),
        }))
        return
      }

      const repoLatestBlueHandoffMatch = pathname.match(/^\/repos\/([^/]+)\/blue-handoffs\/latest$/)
      if (repoLatestBlueHandoffMatch && method === 'GET') {
        sendJson(res, 200, await api.getLatestBlueHandoff(decodeURIComponent(repoLatestBlueHandoffMatch[1])))
        return
      }

      const repoArtifactsMatch = pathname.match(/^\/repos\/([^/]+)\/artifacts$/)
      if (repoArtifactsMatch && method === 'GET') {
        sendJson(res, 200, await api.listRepoArtifacts(
          decodeURIComponent(repoArtifactsMatch[1]),
          url.searchParams.get('kind') ?? undefined,
        ))
        return
      }

      const repoBugsMatch = pathname.match(/^\/repos\/([^/]+)\/bugs$/)
      if (repoBugsMatch && method === 'GET') {
        sendJson(res, 200, await api.listRepoBugs(decodeURIComponent(repoBugsMatch[1])))
        return
      }
      if (repoBugsMatch && method === 'POST') {
        sendJson(res, 201, await api.createBug(
          decodeURIComponent(repoBugsMatch[1]),
          parseCreateBugInput(await readJsonBody(req)),
        ))
        return
      }

      const repoEnvProfilesMatch = pathname.match(/^\/repos\/([^/]+)\/env-profiles$/)
      if (repoEnvProfilesMatch && method === 'POST') {
        sendJson(res, 201, await api.createEnvProfile(
          decodeURIComponent(repoEnvProfilesMatch[1]),
          parseCreateEnvProfileInput(await readJsonBody(req)),
        ))
        return
      }

      const repoSecretRefsMatch = pathname.match(/^\/repos\/([^/]+)\/secret-refs$/)
      if (repoSecretRefsMatch && method === 'POST') {
        sendJson(res, 201, await api.createSecretRef(
          decodeURIComponent(repoSecretRefsMatch[1]),
          parseCreateSecretRefInput(await readJsonBody(req)),
        ))
        return
      }

      const runMatch = pathname.match(/^\/runs\/([^/]+)$/)
      if (runMatch && method === 'GET') {
        sendJson(res, 200, await api.getRun(decodeURIComponent(runMatch[1])))
        return
      }

      const runArtifactsMatch = pathname.match(/^\/runs\/([^/]+)\/artifacts$/)
      if (runArtifactsMatch && method === 'GET') {
        sendJson(res, 200, await api.listRunArtifacts(decodeURIComponent(runArtifactsMatch[1])))
        return
      }

      const artifactMatch = pathname.match(/^\/artifacts\/([^/]+)$/)
      if (artifactMatch && method === 'GET') {
        sendJson(res, 200, await api.getArtifact(decodeURIComponent(artifactMatch[1])))
        return
      }

      const rpcMatch = pathname.match(/^\/rpc\/(.+)$/)
      if (rpcMatch && method === 'POST') {
        sendJson(res, 200, await dispatchRpc(api, decodeURIComponent(rpcMatch[1]), await readJsonBody(req)))
        return
      }

      throw new HttpError(404, 'not found')
    } catch (error) {
      const mapped = mapError(error)
      sendJson(res, mapped.statusCode, { ok: false, error: mapped.message })
    }
  }
}
