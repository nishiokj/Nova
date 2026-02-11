import type {
  ConcernAssignment,
  ConcernBoundary,
  ConcernFileScore,
  ConcernMetrics,
  DirectedStaticEdge,
  WeightedFileEdge,
} from './types.js'

const EPSILON = 1e-6
const LAMBDA_INTERNAL = 0.5

function clip(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

function choose2(n: number): number {
  return (n * (n - 1)) / 2
}

function pairKey(left: string, right: string): string {
  return `${left}\u0000${right}`
}

function splitPairKey(key: string): [string, string] {
  const [left, right] = key.split('\u0000')
  return [left, right]
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1
  let intersection = 0
  for (const item of left) {
    if (right.has(item)) intersection += 1
  }
  const union = left.size + right.size - intersection
  return union <= 0 ? 0 : intersection / union
}

export function computeConcernFileScores(
  assignment: ConcernAssignment,
  edges: WeightedFileEdge[]
): Map<string, ConcernFileScore[]> {
  const adjacency = new Map<string, Array<{ other: string; weight: number }>>()
  for (const filePath of assignment.byFile.keys()) {
    adjacency.set(filePath, [])
  }
  for (const edge of edges) {
    adjacency.get(edge.fileA)?.push({ other: edge.fileB, weight: edge.weight })
    adjacency.get(edge.fileB)?.push({ other: edge.fileA, weight: edge.weight })
  }

  const byConcern = new Map<string, ConcernFileScore[]>()
  for (const [filePath, concernId] of assignment.byFile.entries()) {
    let internalDegree = 0
    let totalDegree = 0
    for (const neighbor of adjacency.get(filePath) ?? []) {
      totalDegree += neighbor.weight
      if (assignment.byFile.get(neighbor.other) === concernId) {
        internalDegree += neighbor.weight
      }
    }
    const membershipScore = internalDegree / (totalDegree + EPSILON)
    if (!byConcern.has(concernId)) byConcern.set(concernId, [])
    byConcern.get(concernId)?.push({
      filePath,
      membershipScore,
      isCore: false,
    })
  }

  for (const scores of byConcern.values()) {
    scores.sort((a, b) => {
      if (b.membershipScore !== a.membershipScore) return b.membershipScore - a.membershipScore
      return a.filePath.localeCompare(b.filePath)
    })
    const coreCount = Math.max(1, Math.ceil(scores.length * 0.25))
    for (let i = 0; i < scores.length; i++) {
      scores[i] = {
        ...scores[i],
        isCore: i < coreCount,
      }
    }
  }

  return byConcern
}

export interface ComputeMetricsInput {
  assignment: ConcernAssignment
  edges: WeightedFileEdge[]
  directedStaticEdges: DirectedStaticEdge[]
  interfaceLikeFiles: Set<string>
  concernLabels: Map<string, string>
  previousConcernFilesById?: Map<string, Set<string>>
}

export interface ComputeMetricsResult {
  concerns: ConcernMetrics[]
  concernFiles: Array<{
    concernId: string
    filePath: string
    membershipScore: number
    isCore: boolean
  }>
  boundaries: ConcernBoundary[]
}

export function computeMetrics(input: ComputeMetricsInput): ComputeMetricsResult {
  const {
    assignment,
    edges,
    directedStaticEdges,
    interfaceLikeFiles,
    concernLabels,
    previousConcernFilesById = new Map(),
  } = input

  const concernIds = [...assignment.concernFiles.keys()].sort()
  const internalWeight = new Map<string, number>()
  const externalWeight = new Map<string, number>()
  const withinEdgeCount = new Map<string, number>()
  const crossByPair = new Map<string, number>()
  const topCrossByPair = new Map<string, Array<{ leftFile: string; rightFile: string; weight: number }>>()

  for (const concernId of concernIds) {
    internalWeight.set(concernId, 0)
    externalWeight.set(concernId, 0)
    withinEdgeCount.set(concernId, 0)
  }

  for (const edge of edges) {
    const leftConcern = assignment.byFile.get(edge.fileA)
    const rightConcern = assignment.byFile.get(edge.fileB)
    if (!leftConcern || !rightConcern) continue

    if (leftConcern === rightConcern) {
      internalWeight.set(leftConcern, (internalWeight.get(leftConcern) ?? 0) + edge.weight)
      withinEdgeCount.set(leftConcern, (withinEdgeCount.get(leftConcern) ?? 0) + 1)
      continue
    }

    externalWeight.set(leftConcern, (externalWeight.get(leftConcern) ?? 0) + edge.weight)
    externalWeight.set(rightConcern, (externalWeight.get(rightConcern) ?? 0) + edge.weight)

    const [pairLeft, pairRight] = leftConcern < rightConcern
      ? [leftConcern, rightConcern]
      : [rightConcern, leftConcern]
    const key = pairKey(pairLeft, pairRight)
    crossByPair.set(key, (crossByPair.get(key) ?? 0) + edge.weight)

    if (!topCrossByPair.has(key)) topCrossByPair.set(key, [])
    const list = topCrossByPair.get(key)!
    const leftFile = pairLeft === leftConcern ? edge.fileA : edge.fileB
    const rightFile = pairLeft === leftConcern ? edge.fileB : edge.fileA
    list.push({ leftFile, rightFile, weight: edge.weight })
  }

  for (const list of topCrossByPair.values()) {
    list.sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight
      if (a.leftFile !== b.leftFile) return a.leftFile.localeCompare(b.leftFile)
      return a.rightFile.localeCompare(b.rightFile)
    })
    if (list.length > 10) list.splice(10)
  }

  const fileScores = computeConcernFileScores(assignment, edges)

  const concerns: ConcernMetrics[] = []
  const concernFiles: Array<{
    concernId: string
    filePath: string
    membershipScore: number
    isCore: boolean
  }> = []

  for (const concernId of concernIds) {
    const files = assignment.concernFiles.get(concernId) ?? new Set<string>()
    const size = files.size
    const internal = internalWeight.get(concernId) ?? 0
    const external = externalWeight.get(concernId) ?? 0
    const cohesion = internal / (internal + external + EPSILON)
    const densityDenom = choose2(size)
    const density = densityDenom > 0
      ? (withinEdgeCount.get(concernId) ?? 0) / densityDenom
      : 0

    const previous = previousConcernFilesById.get(concernId) ?? new Set<string>()
    const stability = previous.size > 0 ? jaccard(files, previous) : 0
    const volatility = 1 - stability
    const confidence = clip((0.50 * cohesion) + (0.30 * stability) + (0.20 * density))

    concerns.push({
      concernId,
      label: concernLabels.get(concernId) ?? `concern_${concernId.slice(-6)}`,
      confidence,
      sizeFiles: size,
      internalWeight: internal,
      externalWeight: external,
      cohesion,
      stability,
      volatility,
      signalDensity: density,
      metadata: {},
    })

    const scores = fileScores.get(concernId) ?? []
    for (const score of scores) {
      concernFiles.push({
        concernId,
        filePath: score.filePath,
        membershipScore: score.membershipScore,
        isCore: score.isCore,
      })
    }
  }

  const directionByPair = new Map<string, { leftToRight: number; rightToLeft: number; crossStatic: number; interfaceCross: number }>()
  for (const edge of directedStaticEdges) {
    const sourceConcern = assignment.byFile.get(edge.sourceFile)
    const targetConcern = assignment.byFile.get(edge.targetFile)
    if (!sourceConcern || !targetConcern || sourceConcern === targetConcern) continue

    const [pairLeft, pairRight] = sourceConcern < targetConcern
      ? [sourceConcern, targetConcern]
      : [targetConcern, sourceConcern]
    const key = pairKey(pairLeft, pairRight)
    if (!directionByPair.has(key)) {
      directionByPair.set(key, {
        leftToRight: 0,
        rightToLeft: 0,
        crossStatic: 0,
        interfaceCross: 0,
      })
    }
    const direction = directionByPair.get(key)!
    direction.crossStatic += edge.weight
    if (sourceConcern === pairLeft) direction.leftToRight += edge.weight
    else direction.rightToLeft += edge.weight

    if (interfaceLikeFiles.has(edge.sourceFile) || interfaceLikeFiles.has(edge.targetFile)) {
      direction.interfaceCross += edge.weight
    }
  }

  const boundaries: ConcernBoundary[] = []
  for (const [key, crossWeight] of crossByPair.entries()) {
    const [leftConcernId, rightConcernId] = splitPairKey(key)
    const internalLeft = internalWeight.get(leftConcernId) ?? 0
    const internalRight = internalWeight.get(rightConcernId) ?? 0
    const pressure = crossWeight / (Math.sqrt((internalLeft + LAMBDA_INTERNAL) * (internalRight + LAMBDA_INTERNAL)) + EPSILON)
    const pressureNorm = pressure / (1 + pressure)

    const direction = directionByPair.get(key) ?? {
      leftToRight: 0,
      rightToLeft: 0,
      crossStatic: 0,
      interfaceCross: 0,
    }
    const interfaceRatio = direction.interfaceCross / (direction.crossStatic + EPSILON)
    const directBypassRatio = 1 - interfaceRatio
    const symmetryRatio = Math.min(direction.leftToRight, direction.rightToLeft) /
      (Math.max(direction.leftToRight, direction.rightToLeft) + EPSILON)
    const hardness = clip((1 - pressureNorm) * (0.6 + (0.4 * interfaceRatio)))

    boundaries.push({
      leftConcernId,
      rightConcernId,
      crossWeight,
      internalLeft,
      internalRight,
      pressure,
      pressureNorm,
      hardness,
      interfaceRatio,
      directBypassRatio,
      directionalLeftToRight: direction.leftToRight,
      directionalRightToLeft: direction.rightToLeft,
      symmetryRatio,
      topCrossFiles: topCrossByPair.get(key) ?? [],
    })
  }

  boundaries.sort((a, b) => {
    if (b.pressureNorm !== a.pressureNorm) return b.pressureNorm - a.pressureNorm
    if (a.hardness !== b.hardness) return a.hardness - b.hardness
    if (a.leftConcernId !== b.leftConcernId) return a.leftConcernId.localeCompare(b.leftConcernId)
    return a.rightConcernId.localeCompare(b.rightConcernId)
  })

  concerns.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence
    return a.concernId.localeCompare(b.concernId)
  })

  concernFiles.sort((a, b) => {
    if (a.concernId !== b.concernId) return a.concernId.localeCompare(b.concernId)
    if (b.membershipScore !== a.membershipScore) return b.membershipScore - a.membershipScore
    return a.filePath.localeCompare(b.filePath)
  })

  return {
    concerns,
    concernFiles,
    boundaries,
  }
}
