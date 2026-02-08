export interface ArchitectureConfig {
  lookbackDays: number
  minEdgeWeight: number
  strongEdgeWeight: number
  maxPairsPerFile: number
  maxFiles: number
  emitAlerts: boolean
  concernMode: 'graph_cluster' | 'module'
}

export const DEFAULT_ARCHITECTURE_CONFIG: ArchitectureConfig = {
  lookbackDays: 30,
  minEdgeWeight: 0.12,
  strongEdgeWeight: 0.20,
  maxPairsPerFile: 128,
  maxFiles: 20000,
  emitAlerts: true,
  concernMode: 'module',
}

export interface PairSignals {
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

export interface WeightedFileEdge {
  fileA: string
  fileB: string
  weight: number
}

export interface DirectedStaticEdge {
  sourceFile: string
  targetFile: string
  weight: number
}

export interface GraphStats {
  filesConsidered: number
  entityCount: number
  candidatePairs: number
  keptEdges: number
  sparseThresholdEdges: number
  sparseTopKOnlyEdges: number
  skippedLargeChangeGroups: number
  skippedLargeTouchGroups: number
}

export interface TermVector {
  filePath: string
  vector: Map<string, number>
}

export interface BuildFileGraphResult {
  files: string[]
  edges: WeightedFileEdge[]
  pairSignals: PairSignals[]
  directedStaticEdges: DirectedStaticEdge[]
  interfaceLikeFiles: Set<string>
  termVectors: Map<string, TermVector>
  graphHash: string
  stats: GraphStats
}

export interface ConcernAssignment {
  byFile: Map<string, string>
  concernFiles: Map<string, Set<string>>
}

export interface ConcernFileScore {
  filePath: string
  membershipScore: number
  isCore: boolean
}

export interface ConcernBoundary {
  leftConcernId: string
  rightConcernId: string
  crossWeight: number
  internalLeft: number
  internalRight: number
  pressure: number
  pressureNorm: number
  hardness: number
  interfaceRatio: number
  directBypassRatio: number
  directionalLeftToRight: number
  directionalRightToLeft: number
  symmetryRatio: number
  topCrossFiles: Array<{
    leftFile: string
    rightFile: string
    weight: number
  }>
}

export interface ConcernMetrics {
  concernId: string
  label: string
  confidence: number
  sizeFiles: number
  internalWeight: number
  externalWeight: number
  cohesion: number
  stability: number
  volatility: number
  signalDensity: number
  metadata: Record<string, unknown>
}

export interface DerivedConcernCluster {
  provisionalId: string
  files: Set<string>
  fileScores: ConcernFileScore[]
}
