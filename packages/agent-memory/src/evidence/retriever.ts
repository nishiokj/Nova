import type { Sql } from 'postgres'
import { generateCanonicalId } from '../ids.js'
import {
  createEvidenceRetrievalLogRepository,
} from '../db/repositories/evidence-retrieval-log.js'
import { redactPII } from '../normalization/pii.js'
import { collapseWhitespace, normalizeLineEndings, removeControlChars, truncate } from '../normalization/text.js'
import { stableStringify } from '../stable-stringify.js'
import type {
  AnyEvidenceAtom,
  EvidenceCategory,
  CodeEntity,
  CodeEntityAtom,
  ConfigFactAtom,
  RuntimeFactAtom,
  TestSpecAtom,
} from './types.js'

export interface RetrievalRequest {
  task: {
    objective: string
    recentMessages: string[]
    touchedFiles?: string[]
    iteration: number
    sessionId: string
    workItemId?: string
  }
  budget: {
    maxTokens: number
    maxItems: number
    minCoverage: Partial<Record<EvidenceCategory, number>>
  }
}

export interface RetrievalResult {
  content: string
  atoms: AnyEvidenceAtom[]
  metrics: {
    totalCandidates: number
    totalTokens: number
    attentionTax: number
    coverage: Record<EvidenceCategory, number>
    discriminatorsIncluded: number
    latencyMs: number
  }
  audit: {
    retrievedIds: string[]
    packedIds: string[]
    rejectionReasons: Record<string, string>
  }
}

interface Approach {
  id: string
  description: string
  keyEntityIds: string[]
}

interface PackingResult {
  selected: AnyEvidenceAtom[]
  totalTokens: number
  totalAttentionTax: number
  coverage: Record<EvidenceCategory, number>
  rejectionReasons: Record<string, string>
}

export class EvidenceRetriever {
  private readonly sql: Sql

  constructor(sql: Sql) {
    this.sql = sql
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const startedAt = Date.now()
    const audit = { retrievedIds: [] as string[], packedIds: [] as string[], rejectionReasons: {} as Record<string, string> }

    const retrievalStart = Date.now()
    const approaches = await this.inferApproaches(request.task)
    const queryText = this.buildQueryText(request.task)
    const candidates = await this.hybridRetrieve(request.task, approaches, queryText)
    const retrievalLatency = Date.now() - retrievalStart
    audit.retrievedIds = candidates.map((c) => c.id)

    const scored = this.scoreWithDiscriminators(candidates)

    const packingStart = Date.now()
    const packed = this.packWithCoverage(scored, request.budget)
    const packingLatency = Date.now() - packingStart
    audit.packedIds = packed.selected.map((a) => a.id)
    audit.rejectionReasons = packed.rejectionReasons

    const content = this.format(packed.selected)

    const metrics = {
      totalCandidates: candidates.length,
      totalTokens: packed.totalTokens,
      attentionTax: packed.totalAttentionTax,
      coverage: packed.coverage,
      discriminatorsIncluded: packed.selected.filter((a) => a.retrieval.isDiscriminator).length,
      latencyMs: Date.now() - startedAt,
    }

    await this.logRetrieval(request, queryText, packed, audit, {
      retrievalLatency,
      packingLatency,
      totalLatency: metrics.latencyMs,
    })

    return {
      content,
      atoms: packed.selected,
      metrics,
      audit,
    }
  }

  private async inferApproaches(task: RetrievalRequest['task']): Promise<Approach[]> {
    const approaches: Approach[] = []
    const touchedFiles = task.touchedFiles?.slice(0, 3) ?? []

    for (const file of touchedFiles) {
      const entities = await this.sql<CodeEntity[]>`
        SELECT * FROM entity_graph.entities
        WHERE filepath = ${file}
        ORDER BY kind DESC
        LIMIT 5
      `
      const main = entities.find((e) => e.kind === 'class' || e.kind === 'function' || e.kind === 'method')
      if (main) {
        approaches.push({
          id: `modify-${main.id}`,
          description: `Modify ${main.name}`,
          keyEntityIds: [main.id],
        })
      }
    }

    const keywords = this.extractKeywords(task.objective)
    for (const keyword of keywords.slice(0, 3)) {
      const entities = await this.searchEntities(keyword)
      if (entities.length > 0) {
        approaches.push({
          id: `touch-${keyword}`,
          description: `Work with ${keyword}-related code`,
          keyEntityIds: entities.slice(0, 5).map((e) => e.id),
        })
      }
    }

    return approaches.slice(0, 4)
  }

  private extractKeywords(text: string): string[] {
    return text
      .toLowerCase()
      .split(/\\W+/)
      .filter((word) => word.length > 3)
      .filter((word) => !['this', 'that', 'with', 'from', 'have', 'will', 'into', 'your', 'they', 'them'].includes(word))
  }

  private buildQueryText(task: RetrievalRequest['task']): string {
    const parts: string[] = []
    if (task.objective) parts.push(task.objective)
    if (Array.isArray(task.recentMessages)) {
      parts.push(...task.recentMessages.filter((m) => typeof m === 'string' && m.trim().length > 0))
    }
    return parts.join(' ').slice(0, 500)
  }

  private async searchEntities(keyword: string): Promise<CodeEntity[]> {
    return this.sql<CodeEntity[]>`
      SELECT * FROM entity_graph.entities
      WHERE name ILIKE ${'%' + keyword + '%'}
      ORDER BY exported DESC, kind DESC
      LIMIT 8
    `
  }

  private async hybridRetrieve(
    task: RetrievalRequest['task'],
    approaches: Approach[],
    queryText: string
  ): Promise<AnyEvidenceAtom[]> {
    const candidates: AnyEvidenceAtom[] = []

    // Structural: entities in touched files
    if (task.touchedFiles?.length) {
      const files = task.touchedFiles
      const entities = await this.sql<CodeEntity[]>`
        SELECT * FROM entity_graph.entities
        WHERE filepath = ANY(${files})
      `
      for (const entity of entities) {
        candidates.push(this.wrapEntity(entity, 'structural'))
      }

      // Graph expansion: files that import/call/use entities from touched files
      const touchedEntityIds = entities.map((e) => e.id)
      if (touchedEntityIds.length > 0) {
        const expandedFiles = await this.sql<{ filepath: string }[]>`
          SELECT DISTINCT e.filepath FROM entity_graph.entities e
          JOIN entity_graph.imports i ON i.importer_id = e.id
          WHERE i.imported_id = ANY(${touchedEntityIds})
          UNION
          SELECT DISTINCT e.filepath FROM entity_graph.entities e
          JOIN entity_graph.calls c ON c.caller_id = e.id
          WHERE c.callee_id = ANY(${touchedEntityIds})
          UNION
          SELECT DISTINCT e.filepath FROM entity_graph.entities e
          JOIN entity_graph.uses u ON u.user_id = e.id
          WHERE u.used_id = ANY(${touchedEntityIds})
        `
        const expandedFilePaths = expandedFiles.map((row) => row.filepath)
        if (expandedFilePaths.length > 0) {
          const expandedEntities = await this.sql<CodeEntity[]>`
            SELECT * FROM entity_graph.entities
            WHERE filepath = ANY(${expandedFilePaths})
              AND exported = true
            LIMIT 80
          `
          for (const entity of expandedEntities) {
            candidates.push(this.wrapEntity(entity, 'graph'))
          }
        }
      }
    }

    // Lexical search across evidence tables + preferences/decisions
    const lexicalResults = await this.lexicalSearch(queryText)
    candidates.push(...lexicalResults)

    // Discriminator queries
    for (const approach of approaches) {
      const targetId = approach.keyEntityIds[0]
      if (!targetId) continue
      const discriminatorAtoms = await this.discriminatorSearch(targetId)
      for (const atom of discriminatorAtoms) {
        atom.retrieval.isDiscriminator = true
      }
      candidates.push(...discriminatorAtoms)
    }

    // Deduplicate by ID
    const seen = new Set<string>()
    return candidates.filter((c) => {
      if (seen.has(c.id)) return false
      seen.add(c.id)
      return true
    })
  }

  private async lexicalSearch(query: string): Promise<AnyEvidenceAtom[]> {
    if (!query || !query.trim()) return []

    const atoms: AnyEvidenceAtom[] = []

    const configFacts = await this.sql<any[]>`
      SELECT *, ts_rank(search_vector, plainto_tsquery('english', ${query})) as rank
      FROM config_facts
      WHERE search_vector @@ plainto_tsquery('english', ${query})
      ORDER BY rank DESC
      LIMIT 10
    `
    for (const row of configFacts) {
      atoms.push(this.wrapConfigFact(row, row.rank ?? 0.4))
    }

    const runtimeFacts = await this.sql<any[]>`
      SELECT *, ts_rank(search_vector, plainto_tsquery('english', ${query})) as rank
      FROM runtime_facts
      WHERE search_vector @@ plainto_tsquery('english', ${query})
      ORDER BY rank DESC
      LIMIT 10
    `
    for (const row of runtimeFacts) {
      atoms.push(this.wrapRuntimeFact(row, row.rank ?? 0.4))
    }

    const testSpecs = await this.sql<any[]>`
      SELECT *, ts_rank(search_vector, plainto_tsquery('english', ${query})) as rank
      FROM test_specs
      WHERE search_vector @@ plainto_tsquery('english', ${query})
      ORDER BY rank DESC
      LIMIT 10
    `
    for (const row of testSpecs) {
      atoms.push(this.wrapTestSpec(row, row.rank ?? 0.4))
    }

    const preferences = await this.sql<any[]>`
      SELECT *, ts_rank(search_vector, plainto_tsquery('english', ${query})) as rank
      FROM coding_preferences
      WHERE search_vector @@ plainto_tsquery('english', ${query})
      ORDER BY rank DESC
      LIMIT 8
    `
    for (const row of preferences) {
      atoms.push(this.wrapPreference(row, row.rank ?? 0.4))
    }

    const decisions = await this.sql<any[]>`
      SELECT *, ts_rank(search_vector, plainto_tsquery('english', ${query})) as rank
      FROM coding_decisions
      WHERE search_vector @@ plainto_tsquery('english', ${query})
      ORDER BY rank DESC
      LIMIT 8
    `
    for (const row of decisions) {
      atoms.push(this.wrapDecision(row, row.rank ?? 0.4))
    }

    return atoms
  }

  private async discriminatorSearch(entityId: string): Promise<AnyEvidenceAtom[]> {
    const atoms: AnyEvidenceAtom[] = []

    const tests = await this.sql<any[]>`
      SELECT * FROM test_specs
      WHERE tests_entity_ids @> ARRAY[${entityId}] OR entity_id = ${entityId}
      ORDER BY last_run_at DESC NULLS LAST
      LIMIT 5
    `
    for (const row of tests) {
      atoms.push(this.wrapTestSpec(row, 0.7))
    }

    const configs = await this.sql<any[]>`
      SELECT * FROM config_facts
      WHERE affects_entity_ids @> ARRAY[${entityId}]
      ORDER BY last_observed_at DESC
      LIMIT 5
    `
    for (const row of configs) {
      atoms.push(this.wrapConfigFact(row, 0.7))
    }

    const runtime = await this.sql<any[]>`
      SELECT * FROM runtime_facts
      WHERE related_entity_ids @> ARRAY[${entityId}]
      ORDER BY last_seen_at DESC
      LIMIT 5
    `
    for (const row of runtime) {
      atoms.push(this.wrapRuntimeFact(row, 0.7))
    }

    return atoms
  }

  private scoreWithDiscriminators(candidates: AnyEvidenceAtom[]): AnyEvidenceAtom[] {
    const sorted = [...candidates].sort((a, b) => b.retrieval.score - a.retrieval.score)
    for (let i = 0; i < sorted.length; i++) {
      const atom = sorted[i]
      const higherRanked = sorted.slice(0, i)
      atom.retrieval.novelty = this.computeNovelty(atom, higherRanked)
      if (atom.retrieval.isDiscriminator) {
        atom.retrieval.score *= 1.5
      }
      atom.retrieval.score *= (0.5 + 0.5 * atom.retrieval.novelty)
    }
    return sorted.sort((a, b) => b.retrieval.score - a.retrieval.score)
  }

  private packWithCoverage(
    candidates: AnyEvidenceAtom[],
    budget: RetrievalRequest['budget']
  ): PackingResult {
    const selected: AnyEvidenceAtom[] = []
    const rejectionReasons: Record<string, string> = {}
    const coverage: Record<EvidenceCategory, number> = {
      code_entity: 0,
      config_fact: 0,
      runtime_fact: 0,
      test_spec: 0,
      preference: 0,
      decision: 0,
    }
    let totalTokens = 0
    let totalAttentionTax = 0

    for (const [category, minCount] of Object.entries(budget.minCoverage)) {
      const inCategory = candidates.filter((c) => c.category === category)
      let added = 0
      for (const atom of inCategory) {
        if (added >= (minCount ?? 0)) break
        if (selected.length >= budget.maxItems) {
          rejectionReasons[atom.id] = 'max_items_coverage_phase'
          break
        }
        if (totalTokens + atom.cost.tokens > budget.maxTokens) continue
        if (this.tooSimilar(atom, selected)) {
          rejectionReasons[atom.id] = 'too_similar_coverage_phase'
          continue
        }
        selected.push(atom)
        totalTokens += atom.cost.tokens
        totalAttentionTax += atom.cost.attentionTax
        coverage[category as EvidenceCategory]++
        added++
      }
    }

    for (const atom of candidates) {
      if (selected.includes(atom)) continue
      if (selected.length >= budget.maxItems) {
        rejectionReasons[atom.id] = 'max_items'
        continue
      }
      if (totalTokens + atom.cost.tokens > budget.maxTokens) {
        rejectionReasons[atom.id] = 'budget_exceeded'
        continue
      }
      if (this.tooSimilar(atom, selected)) {
        rejectionReasons[atom.id] = 'too_similar'
        continue
      }
      selected.push(atom)
      totalTokens += atom.cost.tokens
      totalAttentionTax += atom.cost.attentionTax
      coverage[atom.category]++
    }

    return { selected, totalTokens, totalAttentionTax, coverage, rejectionReasons }
  }

  private wrapEntity(entity: CodeEntity, matchType: 'structural' | 'graph'): CodeEntityAtom {
    return {
      id: entity.id,
      category: 'code_entity',
      provenance: {
        source: 'entity-graph',
        sourceTable: 'entity_graph.entities',
        version: 'current',
        filepath: entity.filepath,
        lineRange: entity.start_line && entity.end_line ? [entity.start_line, entity.end_line] : undefined,
        confidence: 1.0,
      },
      data: entity,
      displayText: this.sanitizeDisplayText(this.formatEntity(entity)),
      safety: {
        isSensitive: false,
        redacted: false,
      },
      retrieval: {
        score: matchType === 'structural' ? 0.9 : 0.7,
        matchType,
        isDiscriminator: false,
        novelty: 1.0,
        retrievedAt: Date.now(),
      },
      cost: {
        tokens: this.estimateTokens(entity.raw_text ?? entity.name),
        attentionTax: this.computeAttentionTax(entity.raw_text ?? entity.name),
      },
      graph: {
        callers: [],
        callees: [],
        importers: [],
      },
    }
  }

  private wrapConfigFact(row: any, score: number): ConfigFactAtom {
    const isSensitive = row.is_sensitive ?? false
    const redacted = isSensitive || row.redacted_value !== null
    const value = isSensitive ? row.redacted_value ?? '[REDACTED]' : row.current_value ?? row.default_value
    const renderedValue = this.safeStringify(value)
    const displayText = this.sanitizeDisplayText(
      `CONFIG ${row.key_path} = ${renderedValue}${row.description ? ` — ${row.description}` : ''}`
    )
    return {
      id: row.id,
      category: 'config_fact',
      provenance: {
        source: 'agent-memory',
        sourceTable: 'config_facts',
        version: row.last_observed_at?.toISOString?.() ?? 'current',
        filepath: row.source_file ?? undefined,
        lineRange: row.source_line ? [row.source_line, row.source_line] : undefined,
        confidence: 0.9,
      },
      data: {
        keyPath: row.key_path,
        configType: row.config_type,
        defaultValue: isSensitive ? null : row.default_value,
        currentValue: isSensitive ? null : row.current_value,
        description: row.description ?? undefined,
        affectsEntityIds: row.affects_entity_ids ?? [],
      },
      displayText,
      safety: {
        isSensitive,
        redacted,
        redactionReason: row.redaction_reason ?? undefined,
      },
      retrieval: {
        score,
        matchType: 'lexical',
        isDiscriminator: false,
        novelty: 1.0,
        retrievedAt: Date.now(),
      },
      cost: {
        tokens: this.estimateTokens(displayText),
        attentionTax: this.computeAttentionTax(displayText),
      },
    }
  }

  private wrapRuntimeFact(row: any, score: number): RuntimeFactAtom {
    const original = row.sanitized_message ?? row.message ?? ''
    const message = this.sanitizeRuntimeMessage(original)
    const wasRedacted = row.sanitized_message ? true : message !== (row.message ?? '')
    const displayText = this.sanitizeDisplayText(`RUNTIME [${row.fact_type}] ${message}`, 320)
    return {
      id: row.id,
      category: 'runtime_fact',
      provenance: {
        source: 'agent-memory',
        sourceTable: 'runtime_facts',
        version: row.last_seen_at?.toISOString?.() ?? 'current',
        confidence: 0.8,
      },
      data: {
        factType: row.fact_type,
        message,
        occurrenceCount: row.occurrence_count ?? 1,
        relatedEntityIds: row.related_entity_ids ?? [],
      },
      displayText,
      safety: {
        isSensitive: false,
        redacted: wasRedacted,
      },
      retrieval: {
        score,
        matchType: 'lexical',
        isDiscriminator: false,
        novelty: 1.0,
        retrievedAt: Date.now(),
      },
      cost: {
        tokens: this.estimateTokens(displayText),
        attentionTax: this.computeAttentionTax(displayText),
      },
    }
  }

  private wrapTestSpec(row: any, score: number): TestSpecAtom {
    const suite = row.test_suite ? ` (${row.test_suite})` : ''
    const displayText = this.sanitizeDisplayText(
      `TEST ${row.test_name}${suite}${row.last_result ? ` — last: ${row.last_result}` : ''}`
    )
    return {
      id: row.id,
      category: 'test_spec',
      provenance: {
        source: 'agent-memory',
        sourceTable: 'test_specs',
        version: row.extracted_at?.toISOString?.() ?? 'current',
        filepath: undefined,
        confidence: 0.8,
      },
      data: {
        testName: row.test_name,
        testSuite: row.test_suite ?? undefined,
        description: row.description ?? undefined,
        assertions: row.assertions ?? undefined,
        testsEntityIds: row.tests_entity_ids ?? [],
        lastResult: row.last_result ?? undefined,
        passRate: row.pass_rate ?? undefined,
      },
      displayText,
      safety: {
        isSensitive: false,
        redacted: false,
      },
      retrieval: {
        score,
        matchType: 'lexical',
        isDiscriminator: false,
        novelty: 1.0,
        retrievedAt: Date.now(),
      },
      cost: {
        tokens: this.estimateTokens(displayText),
        attentionTax: this.computeAttentionTax(displayText),
      },
    }
  }

  private wrapPreference(row: any, score: number): AnyEvidenceAtom {
    const displayText = this.sanitizeDisplayText(`PREF ${row.preference} — ${row.scope}`)
    return {
      id: row.id,
      category: 'preference',
      provenance: {
        source: 'agent-memory',
        sourceTable: 'coding_preferences',
        version: row.created_at?.toISOString?.() ?? 'current',
        confidence: 0.7,
      },
      data: row,
      displayText,
      safety: {
        isSensitive: false,
        redacted: false,
      },
      retrieval: {
        score,
        matchType: 'lexical',
        isDiscriminator: false,
        novelty: 1.0,
        retrievedAt: Date.now(),
      },
      cost: {
        tokens: this.estimateTokens(displayText),
        attentionTax: this.computeAttentionTax(displayText),
      },
    }
  }

  private wrapDecision(row: any, score: number): AnyEvidenceAtom {
    const displayText = this.sanitizeDisplayText(`DECISION ${row.decision} — ${row.rationale}`)
    return {
      id: row.id,
      category: 'decision',
      provenance: {
        source: 'agent-memory',
        sourceTable: 'coding_decisions',
        version: row.created_at?.toISOString?.() ?? 'current',
        confidence: 0.7,
      },
      data: row,
      displayText,
      safety: {
        isSensitive: false,
        redacted: false,
      },
      retrieval: {
        score,
        matchType: 'lexical',
        isDiscriminator: false,
        novelty: 1.0,
        retrievedAt: Date.now(),
      },
      cost: {
        tokens: this.estimateTokens(displayText),
        attentionTax: this.computeAttentionTax(displayText),
      },
    }
  }

  private format(atoms: AnyEvidenceAtom[]): string {
    if (atoms.length === 0) return ''
    const sections: string[] = ['## Relevant Evidence']

    const byCategory = atoms.reduce<Record<string, AnyEvidenceAtom[]>>((acc, atom) => {
      ;(acc[atom.category] ||= []).push(atom)
      return acc
    }, {})

    if (byCategory.code_entity?.length) {
      sections.push('\n### Code Context')
      for (const atom of byCategory.code_entity) {
        const tag = atom.retrieval.isDiscriminator ? ' [discriminator]' : ''
        sections.push(`- ${atom.displayText}${tag}`)
      }
    }

    if (byCategory.test_spec?.length) {
      sections.push('\n### Relevant Tests')
      for (const atom of byCategory.test_spec) {
        sections.push(`- ${atom.displayText}`)
      }
    }

    if (byCategory.config_fact?.length) {
      sections.push('\n### Configuration')
      for (const atom of byCategory.config_fact) {
        sections.push(`- ${atom.displayText}`)
      }
    }

    if (byCategory.runtime_fact?.length) {
      sections.push('\n### Runtime Context')
      for (const atom of byCategory.runtime_fact) {
        sections.push(`- ${atom.displayText}`)
      }
    }

    const prefs = [...(byCategory.preference || []), ...(byCategory.decision || [])]
    if (prefs.length) {
      sections.push('\n### Prior Context')
      for (const atom of prefs) {
        sections.push(`- ${atom.displayText}`)
      }
    }

    return sections.join('\n')
  }

  private formatEntity(entity: CodeEntity): string {
    const location = entity.start_line ? `${entity.filepath}:${entity.start_line}` : entity.filepath
    const exported = entity.exported ? ' (exported)' : ''
    const asyncMark = entity.async ? 'async ' : ''
    switch (entity.kind) {
      case 'function':
      case 'method':
        return `${asyncMark}${entity.name}${exported} — ${entity.kind} at \`${location}\``
      case 'class':
        return `class ${entity.name}${exported} at \`${location}\``
      case 'interface':
      case 'type':
        return `${entity.kind} ${entity.name}${exported} at \`${location}\``
      default:
        return `${entity.name} (${entity.kind}) at \`${location}\``
    }
  }

  private estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4))
  }

  private safeStringify(value: unknown): string {
    if (typeof value === 'string') return value
    try {
      return stableStringify(value)
    } catch {
      try {
        return JSON.stringify(value)
      } catch {
        return '[UNSTRINGIFIABLE]'
      }
    }
  }

  private redactSecrets(text: string): string {
    return text
      .replace(/(sk-|rk-|pk-|whsec_|ghp_|gho_|ya29\.)[A-Za-z0-9_\-]+/g, '$1REDACTED')
      .replace(/(Bearer\s+)[A-Za-z0-9_\-\.]+/gi, '$1REDACTED')
      .replace(/([A-Z_]*KEY=)[^\s]+/g, '$1REDACTED')
      .replace(/([A-Z_]*TOKEN=)[^\s]+/g, '$1REDACTED')
      .replace(/([A-Z_]*SECRET=)[^\s]+/g, '$1REDACTED')
      .replace(/(https?:\/\/)([^@\s]+)@/gi, '$1[REDACTED]@')
  }

  private sanitizeRuntimeMessage(message: string): string {
    if (!message) return ''
    const pii = redactPII(message)
    const scrubbed = this.redactSecrets(pii.text)
    return this.sanitizeDisplayText(scrubbed, 320)
  }

  private sanitizeDisplayText(text: string, maxLength = 420): string {
    if (!text) return ''
    let cleaned = removeControlChars(text)
    cleaned = normalizeLineEndings(cleaned)
    cleaned = cleaned.replace(/\n+/g, ' ')
    cleaned = collapseWhitespace(cleaned).trim()
    return truncate(cleaned, maxLength)
  }

  private computeAttentionTax(text: string): number {
    const tokens = this.estimateTokens(text)
    const base = 0.01
    const complexity = tokens > 500 ? 0.3 : tokens > 200 ? 0.1 : 0
    return base + complexity
  }

  private computeNovelty(atom: AnyEvidenceAtom, existing: AnyEvidenceAtom[]): number {
    if (existing.length === 0) return 1.0
    const atomTokens = new Set(atom.displayText.toLowerCase().split(/\\W+/))
    let maxSimilarity = 0
    for (const ex of existing) {
      const exTokens = new Set(ex.displayText.toLowerCase().split(/\\W+/))
      const intersection = [...atomTokens].filter((t) => exTokens.has(t)).length
      const union = new Set([...atomTokens, ...exTokens]).size
      const similarity = union === 0 ? 0 : intersection / union
      if (similarity > maxSimilarity) maxSimilarity = similarity
    }
    return 1 - maxSimilarity
  }

  private tooSimilar(atom: AnyEvidenceAtom, selected: AnyEvidenceAtom[]): boolean {
    return this.computeNovelty(atom, selected) < 0.3
  }

  private async logRetrieval(
    request: RetrievalRequest,
    queryText: string,
    packed: PackingResult,
    audit: RetrievalResult['audit'],
    timing: { retrievalLatency: number; packingLatency: number; totalLatency: number }
  ): Promise<void> {
    const repo = createEvidenceRetrievalLogRepository({ sql: this.sql })
    await repo.create({
      id: generateCanonicalId(),
      session_id: request.task.sessionId,
      work_item_id: request.task.workItemId ?? null,
      request_id: generateCanonicalId(),
      injector_version: 'v2',
      task_objective: request.task.objective,
      query_text: queryText,
      budget: request.budget,
      retrieved_count: audit.retrievedIds.length,
      packed_count: audit.packedIds.length,
      total_tokens: packed.totalTokens,
      attention_tax: packed.totalAttentionTax,
      coverage: packed.coverage,
      discriminators_count: packed.selected.filter((a) => a.retrieval.isDiscriminator).length,
      retrieval_latency_ms: timing.retrievalLatency,
      packing_latency_ms: timing.packingLatency,
      total_latency_ms: timing.totalLatency,
      status: 'ok',
      retrieved_ids: audit.retrievedIds,
      packed_ids: audit.packedIds,
      rejection_reasons: audit.rejectionReasons,
    })
  }
}
