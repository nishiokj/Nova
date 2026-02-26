#!/usr/bin/env bun
/**
 * Research Tree → Markdown Renderer for deep-research skill.
 *
 * Fetches the full research tree from the DB and renders a comprehensive
 * markdown document with findings, significance, first principles, and gaps.
 *
 * Usage:
 *   bun run scripts/render.ts --project <id> [--output <path>]
 *
 * If --output is provided, writes to that file. Otherwise prints to stdout.
 */

import { writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'

const API_BASE = process.env.RESEARCH_API_BASE ?? 'http://localhost:3001/api/research'

async function api(path: string) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
  return res.json()
}

interface Project {
  id: string; title: string; seedQuery: string; status: string
  depthBudget: number; createdAt: string; updatedAt: string
}

interface Node {
  id: string; projectId: string; parentId: string | null; depth: number
  query: string; queryType: string | null; status: string
  synthesis: string | null; significance: string | null
  firstPrinciples: Array<{ text: string; category: string; dependsOn: string[] }> | null
  gaps: Array<{ question: string; importance: number }> | null
  priorityScore: number | null; noveltyScore: number | null; gapDensity: number | null
}

interface Claim {
  id: string; nodeId: string; claimText: string; evidenceText: string | null
  confidence: string; volatility: string; status: string
  lastVerifiedAt: string
}

interface Source {
  id: string; nodeId: string; url: string; title: string | null
  domain: string | null; qualityScore: number | null
}

function buildTree(nodes: Node[]): Map<string | null, Node[]> {
  const tree = new Map<string | null, Node[]>()
  for (const node of nodes) {
    const siblings = tree.get(node.parentId) ?? []
    siblings.push(node)
    tree.set(node.parentId, siblings)
  }
  return tree
}

function renderNode(
  node: Node,
  tree: Map<string | null, Node[]>,
  claimsByNode: Map<string, Claim[]>,
  sourcesByNode: Map<string, Source[]>,
  headingLevel: number,
): string {
  const h = '#'.repeat(Math.min(headingLevel, 6))
  const lines: string[] = []

  const typeTag = node.queryType ? ` [${node.queryType}]` : ''
  const statusBadge = node.status === 'terminal' ? ' **(terminal)**' : node.status === 'scored' ? '' : ` *(${node.status})*`
  lines.push(`${h} ${node.query}${typeTag}${statusBadge}`)
  lines.push('')

  if (node.priorityScore !== null) {
    lines.push(`> Priority: ${node.priorityScore.toFixed(2)} | Novelty: ${node.noveltyScore?.toFixed(2) ?? '–'} | Gap density: ${node.gapDensity?.toFixed(2) ?? '–'}`)
    lines.push('')
  }

  // Synthesis
  if (node.synthesis) {
    lines.push(`${h}# Findings`)
    lines.push('')
    lines.push(node.synthesis)
    lines.push('')
  }

  // Significance
  if (node.significance) {
    lines.push(`${h}# So What`)
    lines.push('')
    lines.push(node.significance)
    lines.push('')
  }

  // First Principles
  if (node.firstPrinciples?.length) {
    lines.push(`${h}# First Principles`)
    lines.push('')
    for (const fp of node.firstPrinciples) {
      const deps = fp.dependsOn.length ? ` (depends on: ${fp.dependsOn.join(', ')})` : ''
      lines.push(`- **[${fp.category}]** ${fp.text}${deps}`)
    }
    lines.push('')
  }

  // Claims
  const claims = claimsByNode.get(node.id)
  if (claims?.length) {
    lines.push(`${h}# Evidence (${claims.length} claims)`)
    lines.push('')
    for (const c of claims) {
      const vol = c.volatility !== 'moderate' ? ` [${c.volatility}]` : ''
      const conf = c.confidence !== 'medium' ? ` (${c.confidence} confidence)` : ''
      const stale = c.status !== 'active' ? ` ~~${c.status}~~` : ''
      lines.push(`- ${c.claimText}${conf}${vol}${stale}`)
      if (c.evidenceText) {
        lines.push(`  > ${c.evidenceText}`)
      }
    }
    lines.push('')
  }

  // Sources
  const sources = sourcesByNode.get(node.id)
  if (sources?.length) {
    lines.push(`${h}# Sources`)
    lines.push('')
    for (const s of sources) {
      const title = s.title ?? s.domain ?? 'Link'
      const qual = s.qualityScore !== null ? ` (quality: ${s.qualityScore.toFixed(1)})` : ''
      lines.push(`- [${title}](${s.url})${qual}`)
    }
    lines.push('')
  }

  // Gaps → future work
  if (node.gaps?.length) {
    lines.push(`${h}# Open Questions`)
    lines.push('')
    for (const g of node.gaps) {
      lines.push(`- ${g.question} (importance: ${g.importance})`)
    }
    lines.push('')
  }

  // Recurse into children
  const children = tree.get(node.id)
  if (children?.length) {
    for (const child of children) {
      lines.push(renderNode(child, tree, claimsByNode, sourcesByNode, headingLevel + 1))
    }
  }

  return lines.join('\n')
}

async function main() {
  const argv = process.argv.slice(2)
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '')
    const val = argv[i + 1]
    if (key && val) args[key] = val
  }

  const projectId = args.project
  if (!projectId) {
    console.error(JSON.stringify({ error: 'Missing --project <id>' }))
    process.exit(1)
  }

  // Fetch data
  const project: Project = await api(`/projects/${projectId}`)
  const nodes: Node[] = await api(`/projects/${projectId}/tree`)

  // Fetch claims and sources for each node
  const claimsByNode = new Map<string, Claim[]>()
  const sourcesByNode = new Map<string, Source[]>()

  await Promise.all(nodes.map(async (n) => {
    const [claims, sources] = await Promise.all([
      api(`/nodes/${n.id}/claims`) as Promise<Claim[]>,
      api(`/nodes/${n.id}/sources`) as Promise<Source[]>,
    ])
    claimsByNode.set(n.id, claims)
    sourcesByNode.set(n.id, sources)
  }))

  // Build tree
  const tree = buildTree(nodes)
  const roots = tree.get(null) ?? []

  // Render
  const lines: string[] = []
  lines.push(`# ${project.title}`)
  lines.push('')
  lines.push(`> Seed query: "${project.seedQuery}"`)
  lines.push(`> Status: ${project.status} | Depth budget: ${project.depthBudget}`)
  lines.push(`> Last updated: ${project.updatedAt}`)
  lines.push('')

  // Summary stats
  const totalNodes = nodes.length
  const completedNodes = nodes.filter(n => n.status === 'scored' || n.status === 'terminal').length
  const totalClaims = [...claimsByNode.values()].reduce((acc, c) => acc + c.length, 0)
  const totalSources = [...sourcesByNode.values()].reduce((acc, s) => acc + s.length, 0)
  lines.push(`**${totalNodes}** nodes explored | **${completedNodes}** synthesized | **${totalClaims}** claims | **${totalSources}** sources`)
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const root of roots) {
    lines.push(renderNode(root, tree, claimsByNode, sourcesByNode, 2))
  }

  const markdown = lines.join('\n')

  if (args.output) {
    await mkdir(dirname(args.output), { recursive: true })
    await writeFile(args.output, markdown, 'utf8')

    // Update project output path in DB
    await fetch(`${API_BASE}/projects/${projectId}/output-path`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath: args.output }),
    })

    console.log(JSON.stringify({
      success: true,
      outputPath: args.output,
      stats: { totalNodes, completedNodes, totalClaims, totalSources },
    }, null, 2))
  } else {
    console.log(markdown)
  }
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }))
  process.exit(1)
})
