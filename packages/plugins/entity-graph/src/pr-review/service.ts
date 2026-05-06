import { execFileSync } from 'node:child_process'
import postgres from 'postgres'
import type { Sql } from 'postgres'
import { buildFullGraph } from '../pipeline.js'
import { SCHEMA_DDL } from '../schema.js'
import { reviewDiff } from './review.js'
import type { PRReview } from './types.js'

export const COMMENT_MARKER = '<!-- nova-pr-review -->'
export const DEFAULT_GRAPH_EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/*.d.ts']

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function buildDiff(input: {
  baseSha: string
  headSha: string
  cwd?: string
  gitBin?: string
}): string {
  const { baseSha, headSha, cwd, gitBin = 'git' } = input
  const maxBuffer = 50 * 1024 * 1024
  const common = {
    cwd,
    encoding: 'utf-8' as BufferEncoding,
    maxBuffer,
  }

  try {
    return execFileSync(gitBin, ['diff', '--find-renames', '--unified=3', `${baseSha}...${headSha}`], common)
  } catch {
    return execFileSync(gitBin, ['diff', '--find-renames', '--unified=3', baseSha, headSha], common)
  }
}

export async function runReview(input: {
  databaseUrl: string
  diffText: string
  maxDepth: number
  sourceRoot?: string
  rebuildGraph?: boolean
  exclude?: string[]
}): Promise<PRReview> {
  const sql = postgres(input.databaseUrl, { max: 5, idle_timeout: 30, connect_timeout: 10 })

  try {
    if (input.rebuildGraph) {
      if (!input.sourceRoot) {
        throw new Error('runReview(sourceRoot) is required when rebuildGraph=true')
      }
      await sql.unsafe('DROP SCHEMA IF EXISTS entity_graph CASCADE')
      await sql.unsafe(SCHEMA_DDL)
      await buildFullGraph(sql as unknown as Sql, {
        sourceRoot: input.sourceRoot,
        exclude: input.exclude ?? DEFAULT_GRAPH_EXCLUDE,
      })
    } else {
      await sql.unsafe(SCHEMA_DDL)
    }

    return await reviewDiff(sql as unknown as Sql, input.diffText, input.maxDepth)
  } finally {
    await sql.end()
  }
}

export function formatReviewMarkdown(
  baseSha: string,
  headSha: string,
  maxDepth: number,
  review: PRReview,
): string {
  const critical = review.risks.filter(r => r.score >= 70)
  const warnings = review.risks.filter(r => r.score >= 40 && r.score < 70)
  const topRisks = review.risks.slice(0, 12)
  const changed = review.changedEntities.slice(0, 20)
  const deadCode = review.deadCode.slice(0, 20)

  const lines: string[] = []
  lines.push(COMMENT_MARKER)
  lines.push('## Entity Graph PR Review')
  lines.push('')
  lines.push(`Compared \`${shortSha(baseSha)}...${shortSha(headSha)}\` with max depth \`${maxDepth}\`.`)
  lines.push('')
  lines.push(`Summary: ${review.summary}`)
  lines.push('')
  lines.push('### Counts')
  lines.push(`- Changed entities: ${review.changedEntities.length}`)
  lines.push(`- Blast radius (direct): ${review.blastRadius.direct.length}`)
  lines.push(`- Blast radius (transitive): ${review.blastRadius.transitive.length}`)
  lines.push(`- Risk signals: ${review.risks.length} (critical ${critical.length}, warning ${warnings.length})`)
  lines.push(`- Contract impact gaps: ${review.impactGaps.length}`)
  lines.push(`- Dead code candidates: ${review.deadCode.length}`)

  if (topRisks.length > 0) {
    lines.push('')
    lines.push('### Top Risks')
    lines.push('| Score | Entity | File | Key factor |')
    lines.push('|---:|---|---|---|')
    for (const risk of topRisks) {
      const factor = sanitizeCell(risk.factors[0] || '')
      lines.push(`| ${risk.score} | \`${sanitizeCell(risk.entity.name)}\` | \`${sanitizeCell(risk.entity.filepath)}\` | ${factor} |`)
    }
  }

  if (changed.length > 0) {
    lines.push('')
    lines.push('### Changed Entities')
    for (const item of changed) {
      lines.push(`- \`${item.changeKind}\` \`${item.entity.name}\` in \`${item.entity.filepath}\``)
    }
    if (review.changedEntities.length > changed.length) {
      lines.push(`- ...and ${review.changedEntities.length - changed.length} more`)
    }
  }

  appendMarkdownImpactGraph(lines, review)

  if (deadCode.length > 0) {
    lines.push('')
    lines.push('### Dead Code Candidates')
    for (const entity of deadCode) {
      lines.push(`- \`${entity.name}\` in \`${entity.filepath}\``)
    }
    if (review.deadCode.length > deadCode.length) {
      lines.push(`- ...and ${review.deadCode.length - deadCode.length} more`)
    }
  }

  if (review.impactGaps.length > 0) {
    lines.push('')
    lines.push('### Unresolved Contract Dependents')
    for (const gap of review.impactGaps.slice(0, 12)) {
      lines.push(
        `- \`${gap.seedChangeKind}\` on \`${gap.seed.name}\` in \`${gap.seed.filepath}\` `
        + `has ${gap.unresolvedDependents.length}/${gap.directDependents.length} direct dependents not updated: `
        + gap.unresolvedDependents.slice(0, 5).map(dep => `\`${sanitizeCell(dep.name)}\``).join(', '),
      )
    }
    if (review.impactGaps.length > 12) {
      lines.push(`- ...and ${review.impactGaps.length - 12} more`)
    }
  }

  const markdown = lines.join('\n')
  return markdown.length > 60000
    ? `${markdown.slice(0, 60000)}\n\n_Comment truncated due to size._`
    : markdown
}

function appendMarkdownImpactGraph(lines: string[], review: PRReview): void {
  if (review.changedEntities.length === 0) return

  const dependentsBySeed = new Map<string, PRReview['blastRadius']['direct']>()
  for (const entry of [...review.blastRadius.direct, ...review.blastRadius.transitive]) {
    const entries = dependentsBySeed.get(entry.seedId) ?? []
    entries.push(entry)
    dependentsBySeed.set(entry.seedId, entries)
  }

  lines.push('')
  lines.push('### Impact Graph')

  for (const change of review.changedEntities.slice(0, 12)) {
    lines.push(`- ${formatEntityNode(change.entity)} - \`${change.changeKind}\``)

    const dependents = (dependentsBySeed.get(change.entity.id) ?? [])
      .sort((a, b) => a.depth - b.depth || a.via.localeCompare(b.via) || a.entity.filepath.localeCompare(b.entity.filepath) || a.entity.id.localeCompare(b.entity.id))

    if (dependents.length === 0) {
      lines.push('  - No dependent entities found.')
      continue
    }

    for (const entry of dependents.slice(0, 8)) {
      lines.push(`  - depth ${entry.depth} via \`${entry.via}\`: ${formatEntityNode(entry.entity)}`)
    }
    if (dependents.length > 8) {
      lines.push(`  - ...and ${dependents.length - 8} more dependents`)
    }
  }

  if (review.changedEntities.length > 12) {
    lines.push(`- ...and ${review.changedEntities.length - 12} more changed entities`)
  }
}

function formatEntityNode(entity: PRReview['changedEntities'][number]['entity']): string {
  return `\`${sanitizeInlineCode(entity.name)}\` in \`${sanitizeInlineCode(entity.filepath)}\``
}

function sanitizeInlineCode(value: string): string {
  return value.replace(/`/g, '\\`').replace(/\n/g, ' ').trim()
}

export function sanitizeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()
}

export function shortSha(sha: string): string {
  return sha.slice(0, 8)
}
