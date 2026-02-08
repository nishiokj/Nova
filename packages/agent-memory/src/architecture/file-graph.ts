import { createHash } from 'node:crypto'
import type { Sql } from 'postgres'
import type { ArchitectureConfig, BuildFileGraphResult, DirectedStaticEdge, PairSignals, TermVector } from './types.js'

interface EntityRow {
  id: string
  filepath: string
  name: string
}

interface StaticEdgeRow {
  source_file: string
  target_file: string
  edge_count: string
}

interface TraceRow {
  revision: string
  session_key: string | null
  trace: unknown
}

interface TestSpecSignalRow {
  entity_id: string
  tests_entity_ids: string[] | null
}

interface RuntimeSignalRow {
  related_entity_ids: string[] | null
  occurrence_count: number
}

interface PairAccumulator {
  fileA: string
  fileB: string
  rawStatic: number
  rawChange: number
  rawTouch: number
  rawTest: number
  rawRuntime: number
  semantic: number
  weight: number
}

const STATIC_COEFFICIENTS = {
  imports: 1.0,
  calls: 1.25,
  uses: 0.75,
  extends: 1.10,
  implements: 1.10,
  owns: 0.40,
} as const

const INTERFACE_PATH_RE = /(route|routes|controller|api|transport|gateway|client|handler|http|grpc|rpc|contract|schema|dto)/i

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function pairKey(fileA: string, fileB: string): string {
  return fileA < fileB ? `${fileA}\u0000${fileB}` : `${fileB}\u0000${fileA}`
}

function directedKey(source: string, target: string): string {
  return `${source}\u0000${target}`
}

function splitPairKey(key: string): [string, string] {
  const [a, b] = key.split('\u0000')
  return [a, b]
}

function clip(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1))))
  return sorted[idx]
}

function choose2(n: number): number {
  return (n * (n - 1)) / 2
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
}

function getOrCreatePair(map: Map<string, PairAccumulator>, fileA: string, fileB: string): PairAccumulator {
  const key = pairKey(fileA, fileB)
  const existing = map.get(key)
  if (existing) return existing

  const [left, right] = splitPairKey(key)
  const created: PairAccumulator = {
    fileA: left,
    fileB: right,
    rawStatic: 0,
    rawChange: 0,
    rawTouch: 0,
    rawTest: 0,
    rawRuntime: 0,
    semantic: 0,
    weight: 0,
  }
  map.set(key, created)
  return created
}

function extractTraceFiles(trace: unknown): string[] {
  if (!trace || typeof trace !== 'object') return []
  const maybeFiles = (trace as { files?: unknown }).files
  if (!Array.isArray(maybeFiles)) return []
  const out: string[] = []
  for (const file of maybeFiles) {
    if (!file || typeof file !== 'object') continue
    const path = (file as { path?: unknown }).path
    if (typeof path !== 'string' || path.length === 0) continue
    out.push(normalizePath(path))
  }
  return out
}

function addPairContributions(
  files: Set<string>,
  assign: (pair: PairAccumulator, delta: number) => void,
  pairMap: Map<string, PairAccumulator>
): void {
  if (files.size < 2) return
  const list = [...files].sort()
  const denom = choose2(list.length)
  if (denom <= 0) return
  const delta = 1 / denom
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const pair = getOrCreatePair(pairMap, list[i], list[j])
      assign(pair, delta)
    }
  }
}

function cosineSimilarity(left: Map<string, number>, right: Map<string, number>): number {
  if (left.size === 0 || right.size === 0) return 0
  let dot = 0
  for (const [term, leftWeight] of left.entries()) {
    const rightWeight = right.get(term)
    if (rightWeight !== undefined) {
      dot += leftWeight * rightWeight
    }
  }
  return clip(dot, 0, 1)
}

async function collectStaticEdges(
  sql: Sql,
  relationTable: 'imports' | 'calls' | 'uses' | 'extends' | 'implements' | 'owns',
  fileList: string[]
): Promise<StaticEdgeRow[]> {
  if (relationTable === 'imports') {
    return sql<StaticEdgeRow[]>`
      SELECT
        s.filepath AS source_file,
        t.filepath AS target_file,
        COUNT(*)::text AS edge_count
      FROM entity_graph.imports r
      JOIN entity_graph.entities s ON s.id = r.importer_id
      JOIN entity_graph.entities t ON t.id = r.imported_id
      WHERE s.filepath != t.filepath
        AND s.filepath = ANY(${sql.array(fileList)})
        AND t.filepath = ANY(${sql.array(fileList)})
      GROUP BY s.filepath, t.filepath
    `
  }
  if (relationTable === 'calls') {
    return sql<StaticEdgeRow[]>`
      SELECT
        s.filepath AS source_file,
        t.filepath AS target_file,
        COUNT(*)::text AS edge_count
      FROM entity_graph.calls r
      JOIN entity_graph.entities s ON s.id = r.caller_id
      JOIN entity_graph.entities t ON t.id = r.callee_id
      WHERE s.filepath != t.filepath
        AND s.filepath = ANY(${sql.array(fileList)})
        AND t.filepath = ANY(${sql.array(fileList)})
      GROUP BY s.filepath, t.filepath
    `
  }
  if (relationTable === 'uses') {
    return sql<StaticEdgeRow[]>`
      SELECT
        s.filepath AS source_file,
        t.filepath AS target_file,
        COUNT(*)::text AS edge_count
      FROM entity_graph.uses r
      JOIN entity_graph.entities s ON s.id = r.user_id
      JOIN entity_graph.entities t ON t.id = r.used_id
      WHERE s.filepath != t.filepath
        AND s.filepath = ANY(${sql.array(fileList)})
        AND t.filepath = ANY(${sql.array(fileList)})
      GROUP BY s.filepath, t.filepath
    `
  }
  if (relationTable === 'extends') {
    return sql<StaticEdgeRow[]>`
      SELECT
        s.filepath AS source_file,
        t.filepath AS target_file,
        COUNT(*)::text AS edge_count
      FROM entity_graph.extends r
      JOIN entity_graph.entities s ON s.id = r.child_id
      JOIN entity_graph.entities t ON t.id = r.parent_id
      WHERE s.filepath != t.filepath
        AND s.filepath = ANY(${sql.array(fileList)})
        AND t.filepath = ANY(${sql.array(fileList)})
      GROUP BY s.filepath, t.filepath
    `
  }
  if (relationTable === 'implements') {
    return sql<StaticEdgeRow[]>`
      SELECT
        s.filepath AS source_file,
        t.filepath AS target_file,
        COUNT(*)::text AS edge_count
      FROM entity_graph.implements r
      JOIN entity_graph.entities s ON s.id = r.implementor_id
      JOIN entity_graph.entities t ON t.id = r.interface_id
      WHERE s.filepath != t.filepath
        AND s.filepath = ANY(${sql.array(fileList)})
        AND t.filepath = ANY(${sql.array(fileList)})
      GROUP BY s.filepath, t.filepath
    `
  }
  return sql<StaticEdgeRow[]>`
    SELECT
      s.filepath AS source_file,
      t.filepath AS target_file,
      COUNT(*)::text AS edge_count
    FROM entity_graph.owns r
    JOIN entity_graph.entities s ON s.id = r.owner_id
    JOIN entity_graph.entities t ON t.id = r.owned_id
    WHERE s.filepath != t.filepath
      AND s.filepath = ANY(${sql.array(fileList)})
      AND t.filepath = ANY(${sql.array(fileList)})
    GROUP BY s.filepath, t.filepath
  `
}

function tfidfVectors(tokenCountsByFile: Map<string, Map<string, number>>): Map<string, TermVector> {
  const filePaths = [...tokenCountsByFile.keys()]
  const fileCount = filePaths.length
  const df = new Map<string, number>()

  for (const terms of tokenCountsByFile.values()) {
    for (const term of terms.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }

  const out = new Map<string, TermVector>()

  for (const [filePath, termCounts] of tokenCountsByFile.entries()) {
    const totalTerms = [...termCounts.values()].reduce((sum, n) => sum + n, 0)
    const rawVector = new Map<string, number>()
    if (totalTerms > 0) {
      for (const [term, count] of termCounts.entries()) {
        const tf = count / totalTerms
        const termDf = df.get(term) ?? 0
        const idf = Math.log((fileCount + 1) / (termDf + 1)) + 1
        rawVector.set(term, tf * idf)
      }
    }

    const norm = Math.sqrt([...rawVector.values()].reduce((sum, v) => sum + (v * v), 0))
    const normalized = new Map<string, number>()
    if (norm > 0) {
      for (const [term, weight] of rawVector.entries()) {
        normalized.set(term, weight / norm)
      }
    }

    out.set(filePath, { filePath, vector: normalized })
  }

  return out
}

export async function buildFileGraph(sql: Sql, config: ArchitectureConfig): Promise<BuildFileGraphResult> {
  const fileRows = await sql<{ filepath: string }[]>`
    SELECT DISTINCT filepath
    FROM entity_graph.entities
    WHERE filepath IS NOT NULL
    ORDER BY filepath ASC
    LIMIT ${config.maxFiles}
  `
  const files = fileRows.map((row) => normalizePath(row.filepath))
  const fileSet = new Set(files)

  if (files.length === 0) {
    return {
      files: [],
      edges: [],
      pairSignals: [],
      directedStaticEdges: [],
      interfaceLikeFiles: new Set(),
      termVectors: new Map(),
      graphHash: createHash('sha1').update('empty').digest('hex'),
      stats: {
        filesConsidered: 0,
        entityCount: 0,
        candidatePairs: 0,
        keptEdges: 0,
        sparseThresholdEdges: 0,
        sparseTopKOnlyEdges: 0,
        skippedLargeChangeGroups: 0,
        skippedLargeTouchGroups: 0,
      },
    }
  }

  const entityRows = await sql<EntityRow[]>`
    SELECT id, filepath, name
    FROM entity_graph.entities
    WHERE filepath = ANY(${sql.array(files)})
  `

  const entityToFile = new Map<string, string>()
  const tokenCountsByFile = new Map<string, Map<string, number>>()
  for (const file of files) {
    const termCounts = new Map<string, number>()
    for (const term of tokenize(file)) {
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1)
    }
    tokenCountsByFile.set(file, termCounts)
  }

  for (const row of entityRows) {
    const filePath = normalizePath(row.filepath)
    entityToFile.set(row.id, filePath)
    const termCounts = tokenCountsByFile.get(filePath)
    if (!termCounts) continue
    for (const term of tokenize(row.name)) {
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1)
    }
  }

  const pairMap = new Map<string, PairAccumulator>()
  const directedStatic = new Map<string, number>()

  const staticSpecs: Array<{
    relation: keyof typeof STATIC_COEFFICIENTS
  }> = [
    { relation: 'imports' },
    { relation: 'calls' },
    { relation: 'uses' },
    { relation: 'extends' },
    { relation: 'implements' },
    { relation: 'owns' },
  ]

  for (const spec of staticSpecs) {
    const rows = await collectStaticEdges(sql, spec.relation, files)
    const coef = STATIC_COEFFICIENTS[spec.relation]
    for (const row of rows) {
      const sourceFile = normalizePath(row.source_file)
      const targetFile = normalizePath(row.target_file)
      if (sourceFile === targetFile) continue
      if (!fileSet.has(sourceFile) || !fileSet.has(targetFile)) continue
      const count = Number.parseInt(row.edge_count, 10)
      if (!Number.isFinite(count) || count <= 0) continue
      const contribution = coef * count

      const pair = getOrCreatePair(pairMap, sourceFile, targetFile)
      pair.rawStatic += contribution

      const dKey = directedKey(sourceFile, targetFile)
      directedStatic.set(dKey, (directedStatic.get(dKey) ?? 0) + contribution)
    }
  }

  const lookbackDays = Math.max(1, config.lookbackDays)
  const traceRows = await sql<TraceRow[]>`
    SELECT revision, session_key, trace
    FROM agent_traces
    WHERE created_at >= now() - make_interval(days => ${lookbackDays})
  `

  const revisionGroups = new Map<string, Set<string>>()
  const sessionGroups = new Map<string, Set<string>>()
  const maxGroupSize = 600
  let skippedLargeChangeGroups = 0
  let skippedLargeTouchGroups = 0

  for (const row of traceRows) {
    const traceFiles = extractTraceFiles(row.trace)
      .map(normalizePath)
      .filter((filePath) => fileSet.has(filePath))
    if (traceFiles.length === 0) continue

    const filesForRow = new Set(traceFiles)
    if (filesForRow.size === 0) continue

    if (row.revision && !row.revision.startsWith('session:')) {
      const group = revisionGroups.get(row.revision) ?? new Set<string>()
      for (const filePath of filesForRow) group.add(filePath)
      revisionGroups.set(row.revision, group)
    }

    if (row.session_key) {
      const group = sessionGroups.get(row.session_key) ?? new Set<string>()
      for (const filePath of filesForRow) group.add(filePath)
      sessionGroups.set(row.session_key, group)
    }
  }

  for (const filesInRevision of revisionGroups.values()) {
    if (filesInRevision.size > maxGroupSize) {
      skippedLargeChangeGroups += 1
      continue
    }
    addPairContributions(
      filesInRevision,
      (pair, delta) => {
        pair.rawChange += delta
      },
      pairMap
    )
  }

  for (const filesInSession of sessionGroups.values()) {
    if (filesInSession.size > maxGroupSize) {
      skippedLargeTouchGroups += 1
      continue
    }
    addPairContributions(
      filesInSession,
      (pair, delta) => {
        pair.rawTouch += delta
      },
      pairMap
    )
  }

  const testRows = await sql<TestSpecSignalRow[]>`
    SELECT entity_id, tests_entity_ids
    FROM test_specs
  `
  for (const row of testRows) {
    const relatedFiles = new Set<string>()
    const primaryFile = entityToFile.get(row.entity_id)
    if (primaryFile) relatedFiles.add(primaryFile)
    for (const entityId of row.tests_entity_ids ?? []) {
      const filePath = entityToFile.get(entityId)
      if (filePath) relatedFiles.add(filePath)
    }
    addPairContributions(
      relatedFiles,
      (pair, delta) => {
        pair.rawTest += delta
      },
      pairMap
    )
  }

  const runtimeRows = await sql<RuntimeSignalRow[]>`
    SELECT related_entity_ids, occurrence_count
    FROM runtime_facts
    WHERE last_seen_at >= now() - make_interval(days => ${lookbackDays})
  `
  for (const row of runtimeRows) {
    const relatedFiles = new Set<string>()
    for (const entityId of row.related_entity_ids ?? []) {
      const filePath = entityToFile.get(entityId)
      if (filePath) relatedFiles.add(filePath)
    }
    if (relatedFiles.size < 2) continue
    const denom = choose2(relatedFiles.size)
    if (denom <= 0) continue
    const delta = Math.log(1 + Math.max(1, row.occurrence_count)) / denom
    addPairContributions(
      relatedFiles,
      (pair) => {
        pair.rawRuntime += delta
      },
      pairMap
    )
  }

  const vectors = tfidfVectors(tokenCountsByFile)
  const staticLogs: number[] = []
  const rawChanges: number[] = []
  const rawTouches: number[] = []
  const rawTests: number[] = []
  const rawRuntimes: number[] = []

  for (const pair of pairMap.values()) {
    if (pair.rawStatic > 0) staticLogs.push(Math.log(1 + pair.rawStatic))
    if (pair.rawChange > 0) rawChanges.push(pair.rawChange)
    if (pair.rawTouch > 0) rawTouches.push(pair.rawTouch)
    if (pair.rawTest > 0) rawTests.push(pair.rawTest)
    if (pair.rawRuntime > 0) rawRuntimes.push(pair.rawRuntime)

    const leftVector = vectors.get(pair.fileA)?.vector ?? new Map<string, number>()
    const rightVector = vectors.get(pair.fileB)?.vector ?? new Map<string, number>()
    pair.semantic = cosineSimilarity(leftVector, rightVector)
  }

  const p95Static = percentile95(staticLogs)
  const p95Change = percentile95(rawChanges)
  const p95Touch = percentile95(rawTouches)
  const p95Test = percentile95(rawTests)
  const p95Runtime = percentile95(rawRuntimes)

  for (const pair of pairMap.values()) {
    const sStatic = p95Static > 0 ? clip(Math.log(1 + pair.rawStatic) / p95Static) : 0
    const sChange = p95Change > 0 ? clip(pair.rawChange / p95Change) : 0
    const sTouch = p95Touch > 0 ? clip(pair.rawTouch / p95Touch) : 0
    const sTest = p95Test > 0 ? clip(pair.rawTest / p95Test) : 0
    const sRuntime = p95Runtime > 0 ? clip(pair.rawRuntime / p95Runtime) : 0
    const sSemantic = clip(pair.semantic)
    pair.weight = (
      (0.40 * sStatic) +
      (0.20 * sChange) +
      (0.15 * sTouch) +
      (0.10 * sTest) +
      (0.10 * sRuntime) +
      (0.05 * sSemantic)
    )
  }

  const neighborEdges = new Map<string, Array<{ other: string; weight: number; key: string }>>()
  for (const pair of pairMap.values()) {
    if (pair.weight <= 0) continue
    const key = pairKey(pair.fileA, pair.fileB)
    if (!neighborEdges.has(pair.fileA)) neighborEdges.set(pair.fileA, [])
    if (!neighborEdges.has(pair.fileB)) neighborEdges.set(pair.fileB, [])
    neighborEdges.get(pair.fileA)?.push({ other: pair.fileB, weight: pair.weight, key })
    neighborEdges.get(pair.fileB)?.push({ other: pair.fileA, weight: pair.weight, key })
  }

  const topNeighborKeys = new Set<string>()
  for (const [filePath, neighbors] of neighborEdges.entries()) {
    neighbors.sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight
      return a.other.localeCompare(b.other)
    })
    for (const neighbor of neighbors.slice(0, 8)) {
      topNeighborKeys.add(neighbor.key)
    }
    if (neighbors.length > config.maxPairsPerFile) {
      neighborEdges.set(filePath, neighbors.slice(0, config.maxPairsPerFile))
    }
  }

  const edges = []
  let sparseThresholdEdges = 0
  let sparseTopKOnlyEdges = 0
  for (const pair of pairMap.values()) {
    if (pair.weight <= 0) continue
    const key = pairKey(pair.fileA, pair.fileB)
    const keepByThreshold = pair.weight >= config.minEdgeWeight
    const keepByTopK = topNeighborKeys.has(key)
    if (!keepByThreshold && !keepByTopK) continue
    if (keepByThreshold) sparseThresholdEdges += 1
    else sparseTopKOnlyEdges += 1
    edges.push({
      fileA: pair.fileA,
      fileB: pair.fileB,
      weight: pair.weight,
    })
  }

  edges.sort((a, b) => {
    if (a.fileA !== b.fileA) return a.fileA.localeCompare(b.fileA)
    if (a.fileB !== b.fileB) return a.fileB.localeCompare(b.fileB)
    return a.weight - b.weight
  })

  const directedStaticEdges: DirectedStaticEdge[] = [...directedStatic.entries()]
    .map(([key, weight]) => {
      const [sourceFile, targetFile] = splitPairKey(key)
      return { sourceFile, targetFile, weight }
    })
    .sort((a, b) => {
      if (a.sourceFile !== b.sourceFile) return a.sourceFile.localeCompare(b.sourceFile)
      return a.targetFile.localeCompare(b.targetFile)
    })

  const interfaceLikeFiles = new Set<string>()
  for (const filePath of files) {
    if (INTERFACE_PATH_RE.test(filePath)) {
      interfaceLikeFiles.add(filePath)
    }
  }

  const typedInterfaceRows = await sql<{ filepath: string }[]>`
    SELECT DISTINCT filepath
    FROM entity_graph.entities
    WHERE filepath = ANY(${sql.array(files)})
      AND kind IN ('interface', 'type')
      AND exported = true
  `
  for (const row of typedInterfaceRows) {
    interfaceLikeFiles.add(normalizePath(row.filepath))
  }

  const transportRows = await sql<{ filepath: string }[]>`
    SELECT DISTINCT filepath
    FROM entity_graph.entities
    WHERE filepath = ANY(${sql.array(files)})
      AND raw_text IS NOT NULL
      AND (
        raw_text ILIKE '%fetch(%' OR
        raw_text ILIKE '%axios%' OR
        raw_text ILIKE '%express%' OR
        raw_text ILIKE '%fastify%' OR
        raw_text ILIKE '%grpc%' OR
        raw_text ILIKE '%request(%'
      )
  `
  for (const row of transportRows) {
    interfaceLikeFiles.add(normalizePath(row.filepath))
  }

  const graphHashMaterial = edges
    .map((edge) => `${edge.fileA}|${edge.fileB}|${edge.weight.toFixed(8)}`)
    .join('\n')
  const graphHash = createHash('sha1').update(graphHashMaterial).digest('hex')

  const pairSignals: PairSignals[] = [...pairMap.values()]
    .filter((pair) => pair.weight > 0)
    .sort((a, b) => {
      if (a.fileA !== b.fileA) return a.fileA.localeCompare(b.fileA)
      return a.fileB.localeCompare(b.fileB)
    })
    .map((pair) => ({
      fileA: pair.fileA,
      fileB: pair.fileB,
      rawStatic: pair.rawStatic,
      rawChange: pair.rawChange,
      rawTouch: pair.rawTouch,
      rawTest: pair.rawTest,
      rawRuntime: pair.rawRuntime,
      semantic: pair.semantic,
      weight: pair.weight,
    }))

  return {
    files,
    edges,
    pairSignals,
    directedStaticEdges,
    interfaceLikeFiles,
    termVectors: vectors,
    graphHash,
    stats: {
      filesConsidered: files.length,
      entityCount: entityRows.length,
      candidatePairs: pairMap.size,
      keptEdges: edges.length,
      sparseThresholdEdges,
      sparseTopKOnlyEdges,
      skippedLargeChangeGroups,
      skippedLargeTouchGroups,
    },
  }
}
