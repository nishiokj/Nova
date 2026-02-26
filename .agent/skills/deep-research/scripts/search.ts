#!/usr/bin/env bun
/**
 * Search Execution Helper for deep-research skill.
 *
 * Executes web searches via the daemon's search proxy, fetches full pages,
 * and stores results as research_sources. Handles domain diversity tracking.
 *
 * Usage:
 *   bun run scripts/search.ts --node <nodeId> --queries '["query1","query2"]' [--max-per-query 3]
 *   bun run scripts/search.ts --fetch --url <url> --node <nodeId> [--title <t>]
 *
 * Output: JSON array of created source records.
 */

const API_BASE = process.env.RESEARCH_API_BASE ?? 'http://localhost:3001/api/research'

async function api(path: string, options?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`API ${res.status}: ${text}`)
  }
  return res.json()
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'unknown'
  }
}

async function getExistingDomains(nodeId: string): Promise<Set<string>> {
  const domains: string[] = await api(`/nodes/${nodeId}/domains`)
  return new Set(domains)
}

async function storeSource(nodeId: string, url: string, title: string | undefined, content: string | undefined) {
  return api('/sources', {
    method: 'POST',
    body: JSON.stringify({
      nodeId,
      url,
      title: title ?? null,
      domain: extractDomain(url),
      rawContent: content ?? null,
    }),
  })
}

async function main() {
  const argv = process.argv.slice(2)
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]?.startsWith('--')) {
      const key = argv[i]!.replace(/^--/, '')
      // Flags without values
      if (!argv[i + 1] || argv[i + 1]!.startsWith('--')) {
        args[key] = 'true'
      } else {
        args[key] = argv[++i]!
      }
    }
  }

  if (args.fetch) {
    // Single URL fetch mode — the agent calls this after picking URLs from search results
    const url = args.url
    const nodeId = args.node
    if (!url || !nodeId) {
      console.error(JSON.stringify({ error: 'Missing --url or --node' }))
      process.exit(1)
    }

    const source = await storeSource(nodeId, url, args.title, undefined)
    console.log(JSON.stringify(source, null, 2))
    return
  }

  // Batch search mode — store URL stubs, agent will WebFetch individually
  const nodeId = args.node
  const queriesRaw = args.queries
  if (!nodeId || !queriesRaw) {
    console.error(JSON.stringify({ error: 'Missing --node or --queries' }))
    process.exit(1)
  }

  const queries: string[] = JSON.parse(queriesRaw)
  const maxPerQuery = parseInt(args['max-per-query'] ?? '3')
  const existingDomains = await getExistingDomains(nodeId)
  const results: unknown[] = []

  // Output a plan of what to search, with domain diversity context
  console.log(JSON.stringify({
    action: 'search_plan',
    nodeId,
    queries,
    maxPerQuery,
    existingDomains: [...existingDomains],
    instructions: [
      'Use WebSearch for each query.',
      'For each result, check if its domain is already in existingDomains.',
      'Prefer results from NEW domains for diversity.',
      `Pick up to ${maxPerQuery} URLs per query.`,
      'Then use WebFetch on each URL to get full content.',
      'Finally, call: bun run scripts/search.ts --fetch --url <url> --node <nodeId> --title <title>',
      'to store each fetched source.',
    ],
  }, null, 2))
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }))
  process.exit(1)
})
