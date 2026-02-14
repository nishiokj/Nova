#!/usr/bin/env bun
/**
 * Research DB CLI — CRUD helper for the deep-research skill.
 *
 * Wraps the daemon REST API so the agent can manage research entities via Bash.
 * All output is JSON for easy parsing.
 *
 * Usage:
 *   bun run scripts/db.ts create-project --title "Topic" --seed "query"
 *   bun run scripts/db.ts get-project --id <id>
 *   bun run scripts/db.ts list-projects [--status active]
 *   bun run scripts/db.ts create-node --project <id> --query "sub-question" [--parent <id>] [--depth 1] [--type mechanistic]
 *   bun run scripts/db.ts get-node --id <id>
 *   bun run scripts/db.ts list-nodes --project <id> [--status pending] [--depth 0]
 *   bun run scripts/db.ts top-nodes --project <id> [--limit 5]
 *   bun run scripts/db.ts update-node-status --id <id> --status collecting
 *   bun run scripts/db.ts update-node-synthesis --id <id> --synthesis <text> --significance <text> --principles <json> --gaps <json>
 *   bun run scripts/db.ts update-node-scores --id <id> --priority 0.8 --novelty 0.7 --gap-density 0.6
 *   bun run scripts/db.ts create-source --node <id> --url <url> [--title <t>] [--domain <d>] [--content <text>] [--extracted <text>] [--quality 0.8]
 *   bun run scripts/db.ts list-sources --node <id>
 *   bun run scripts/db.ts domains --node <id>
 *   bun run scripts/db.ts create-claim --node <id> --claim <text> [--source <id>] [--evidence <text>] [--confidence high] [--volatility stable]
 *   bun run scripts/db.ts list-claims --node <id>
 *   bun run scripts/db.ts stale-claims [--limit 20]
 *   bun run scripts/db.ts verify-claim --id <id>
 *   bun run scripts/db.ts update-claim-status --id <id> --status superseded [--superseded-by <id>]
 *   bun run scripts/db.ts full-tree --project <id>
 *   bun run scripts/db.ts update-project-status --id <id> --status complete
 *   bun run scripts/db.ts update-output-path --id <id> --path <path>
 *   bun run scripts/db.ts delete-project --id <id>
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

function json(data: unknown) {
  console.log(JSON.stringify(data, null, 2))
}

function required(args: Record<string, string | undefined>, key: string): string {
  const val = args[key]
  if (!val) {
    console.error(JSON.stringify({ error: `Missing required argument: --${key}` }))
    process.exit(1)
  }
  return val
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  // Parse --key value pairs
  const args: Record<string, string> = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '')
    const val = rest[i + 1]
    if (key && val !== undefined) args[key] = val
  }

  switch (command) {
    // ---- Projects ----
    case 'create-project':
      json(await api('/projects', {
        method: 'POST',
        body: JSON.stringify({
          title: required(args, 'title'),
          seedQuery: required(args, 'seed'),
          depthBudget: args['depth-budget'] ? parseInt(args['depth-budget']) : undefined,
          maxSourcesPerNode: args['max-sources'] ? parseInt(args['max-sources']) : undefined,
          outputPath: args['output-path'],
        }),
      }))
      break

    case 'get-project':
      json(await api(`/projects/${required(args, 'id')}`))
      break

    case 'list-projects': {
      const qs = args.status ? `?status=${args.status}` : ''
      json(await api(`/projects${qs}`))
      break
    }

    case 'update-project-status':
      json(await api(`/projects/${required(args, 'id')}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: required(args, 'status') }),
      }))
      break

    case 'update-output-path':
      json(await api(`/projects/${required(args, 'id')}/output-path`, {
        method: 'PATCH',
        body: JSON.stringify({ outputPath: required(args, 'path') }),
      }))
      break

    case 'delete-project':
      json(await api(`/projects/${required(args, 'id')}`, { method: 'DELETE' }))
      break

    // ---- Nodes ----
    case 'create-node':
      json(await api('/nodes', {
        method: 'POST',
        body: JSON.stringify({
          projectId: required(args, 'project'),
          parentId: args.parent,
          depth: parseInt(args.depth ?? '0'),
          query: required(args, 'query'),
          queryType: args.type,
        }),
      }))
      break

    case 'get-node':
      json(await api(`/nodes/${required(args, 'id')}`))
      break

    case 'list-nodes': {
      const params = new URLSearchParams()
      if (args.status) params.set('status', args.status)
      if (args.depth) params.set('depth', args.depth)
      const qs = params.toString() ? `?${params}` : ''
      json(await api(`/projects/${required(args, 'project')}/nodes${qs}`))
      break
    }

    case 'top-nodes':
      json(await api(`/projects/${required(args, 'project')}/nodes/top?limit=${args.limit ?? '5'}`))
      break

    case 'update-node-status':
      json(await api(`/nodes/${required(args, 'id')}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: required(args, 'status') }),
      }))
      break

    case 'update-node-synthesis':
      json(await api(`/nodes/${required(args, 'id')}/synthesis`, {
        method: 'PATCH',
        body: JSON.stringify({
          synthesis: required(args, 'synthesis'),
          significance: required(args, 'significance'),
          firstPrinciples: JSON.parse(required(args, 'principles')),
          gaps: JSON.parse(required(args, 'gaps')),
        }),
      }))
      break

    case 'update-node-scores':
      json(await api(`/nodes/${required(args, 'id')}/scores`, {
        method: 'PATCH',
        body: JSON.stringify({
          priorityScore: parseFloat(required(args, 'priority')),
          noveltyScore: parseFloat(required(args, 'novelty')),
          gapDensity: parseFloat(required(args, 'gap-density')),
        }),
      }))
      break

    // ---- Sources ----
    case 'create-source':
      json(await api('/sources', {
        method: 'POST',
        body: JSON.stringify({
          nodeId: required(args, 'node'),
          url: required(args, 'url'),
          title: args.title,
          domain: args.domain,
          rawContent: args.content,
          extractedContent: args.extracted,
          qualityScore: args.quality ? parseFloat(args.quality) : undefined,
        }),
      }))
      break

    case 'list-sources':
      json(await api(`/nodes/${required(args, 'node')}/sources`))
      break

    case 'domains':
      json(await api(`/nodes/${required(args, 'node')}/domains`))
      break

    // ---- Claims ----
    case 'create-claim':
      json(await api('/claims', {
        method: 'POST',
        body: JSON.stringify({
          nodeId: required(args, 'node'),
          sourceId: args.source,
          claimText: required(args, 'claim'),
          evidenceText: args.evidence,
          confidence: args.confidence,
          volatility: args.volatility,
        }),
      }))
      break

    case 'list-claims':
      json(await api(`/nodes/${required(args, 'node')}/claims`))
      break

    case 'stale-claims':
      json(await api(`/claims/stale?limit=${args.limit ?? '20'}`))
      break

    case 'verify-claim':
      json(await api(`/claims/${required(args, 'id')}/verify`, { method: 'POST' }))
      break

    case 'update-claim-status':
      json(await api(`/claims/${required(args, 'id')}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: required(args, 'status'),
          supersededBy: args['superseded-by'],
        }),
      }))
      break

    // ---- Tree ----
    case 'full-tree':
      json(await api(`/projects/${required(args, 'project')}/tree`))
      break

    default:
      console.error(JSON.stringify({
        error: `Unknown command: ${command}`,
        commands: [
          'create-project', 'get-project', 'list-projects', 'update-project-status', 'delete-project',
          'create-node', 'get-node', 'list-nodes', 'top-nodes',
          'update-node-status', 'update-node-synthesis', 'update-node-scores',
          'create-source', 'list-sources', 'domains',
          'create-claim', 'list-claims', 'stale-claims', 'verify-claim', 'update-claim-status',
          'full-tree',
        ],
      }))
      process.exit(1)
  }
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }))
  process.exit(1)
})
