export type EvidenceCategory =
  | 'code_entity'
  | 'config_fact'
  | 'runtime_fact'
  | 'test_spec'
  | 'preference'
  | 'decision'

export interface EvidenceAtom<T = unknown> {
  id: string
  category: EvidenceCategory

  provenance: {
    source: string
    sourceTable: string
    version: string
    filepath?: string
    lineRange?: [number, number]
    confidence: number
  }

  data: T
  displayText: string

  safety: {
    isSensitive: boolean
    redacted: boolean
    redactionReason?: string
  }

  retrieval: {
    score: number
    embeddingScore?: number | null
    bm25Score?: number | null
    heuristicScore?: number | null
    rerankerScore?: number | null
    matchType: 'lexical' | 'semantic' | 'structural' | 'graph'
    isDiscriminator: boolean
    novelty: number
    retrievedAt: number
  }

  cost: {
    tokens: number
    attentionTax: number
  }
}

export interface CodeEntity {
  id: string
  kind: string
  name: string
  filepath: string
  start_line: number | null
  end_line: number | null
  exported: boolean
  async: boolean
  raw_text: string | null
}

export interface CodeEntityAtom extends EvidenceAtom<CodeEntity> {
  category: 'code_entity'
  graph: {
    callers: string[]
    callees: string[]
    importers: string[]
  }
}

export interface ConfigFactAtom extends EvidenceAtom<{
  keyPath: string
  configType: string
  defaultValue: unknown
  currentValue?: unknown
  description?: string
  affectsEntityIds: string[]
}> {
  category: 'config_fact'
}

export interface RuntimeFactAtom extends EvidenceAtom<{
  factType: string
  message: string
  occurrenceCount: number
  relatedEntityIds: string[]
}> {
  category: 'runtime_fact'
}

export interface TestSpecAtom extends EvidenceAtom<{
  testName: string
  testSuite?: string
  description?: string
  assertions?: unknown[]
  testsEntityIds: string[]
  lastResult?: string
  passRate?: number
}> {
  category: 'test_spec'
}

export type AnyEvidenceAtom =
  | CodeEntityAtom
  | ConfigFactAtom
  | RuntimeFactAtom
  | TestSpecAtom
  | EvidenceAtom
