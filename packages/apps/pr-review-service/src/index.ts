import { createServer } from 'node:http'
import { loadConfigFromEnv } from './config.js'
import { parsePullRequestJob, verifyGitHubSignature } from './github.js'
import { runPrReviewJob } from './runner.js'
import type { PRReviewJob } from './types.js'

function sendJson(
  res: import('node:http').ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  const body = JSON.stringify(payload)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json')
  res.end(body)
}

async function readRequestBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

let queue = Promise.resolve()
function enqueueJob(job: PRReviewJob, config: ReturnType<typeof loadConfigFromEnv>): void {
  queue = queue
    .then(async () => {
      console.log(`[pr-review-service] Starting job repo=${job.repoFullName} pr=#${job.prNumber} action=${job.action}`)
      const result = await runPrReviewJob(job, config)
      console.log(
        `[pr-review-service] Completed job repo=${job.repoFullName} pr=#${job.prNumber}` +
        `${result.summary ? ` summary="${result.summary}"` : ''}`,
      )
    })
    .catch(error => {
      console.error(
        `[pr-review-service] Job failed repo=${job.repoFullName} pr=#${job.prNumber}:`,
        error,
      )
    })
}

async function main(): Promise<void> {
  const config = loadConfigFromEnv()
  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET'
    const url = req.url ?? '/'

    if (method === 'GET' && (url === '/healthz' || url === '/readyz')) {
      sendJson(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && url === '/webhooks/github') {
      const rawBody = await readRequestBody(req)
      const signature = req.headers['x-hub-signature-256']
      const signatureHeader = typeof signature === 'string' ? signature : undefined
      if (!verifyGitHubSignature(config.webhookSecret, rawBody, signatureHeader)) {
        sendJson(res, 401, { ok: false, error: 'invalid signature' })
        return
      }

      let payload: unknown
      try {
        payload = JSON.parse(rawBody)
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid json body' })
        return
      }

      const event = req.headers['x-github-event']
      const eventName = typeof event === 'string' ? event : undefined

      if (eventName === 'ping') {
        sendJson(res, 200, { ok: true, event: 'ping' })
        return
      }

      const job = parsePullRequestJob(eventName, payload)
      if (!job) {
        sendJson(res, 202, { ok: true, ignored: true })
        return
      }

      enqueueJob(job, config)
      sendJson(res, 202, {
        ok: true,
        queued: true,
        repo: job.repoFullName,
        pr: job.prNumber,
        action: job.action,
      })
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  })

  server.listen(config.port, () => {
    console.log(`[pr-review-service] Listening on :${config.port}`)
  })
}

main().catch(error => {
  console.error('[pr-review-service] Fatal startup error:', error)
  process.exit(1)
})
