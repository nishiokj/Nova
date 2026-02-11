import type { ConcernAssignment, WeightedFileEdge } from './types.js'

interface Neighbor {
  filePath: string
  weight: number
}

function buildAdjacency(files: string[], edges: WeightedFileEdge[]): Map<string, Neighbor[]> {
  const adjacency = new Map<string, Neighbor[]>()
  for (const file of files) {
    adjacency.set(file, [])
  }

  for (const edge of edges) {
    if (edge.fileA === edge.fileB) continue
    adjacency.get(edge.fileA)?.push({ filePath: edge.fileB, weight: edge.weight })
    adjacency.get(edge.fileB)?.push({ filePath: edge.fileA, weight: edge.weight })
  }

  for (const neighbors of adjacency.values()) {
    neighbors.sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight
      return a.filePath.localeCompare(b.filePath)
    })
  }

  return adjacency
}

function strongComponents(
  files: string[],
  edges: WeightedFileEdge[],
  strongEdgeWeight: number
): ConcernAssignment {
  const strongAdjacency = new Map<string, Set<string>>()
  for (const file of files) strongAdjacency.set(file, new Set())

  for (const edge of edges) {
    if (edge.weight < strongEdgeWeight) continue
    strongAdjacency.get(edge.fileA)?.add(edge.fileB)
    strongAdjacency.get(edge.fileB)?.add(edge.fileA)
  }

  const byFile = new Map<string, string>()
  const concernFiles = new Map<string, Set<string>>()
  const visited = new Set<string>()
  let index = 0

  for (const file of [...files].sort()) {
    if (visited.has(file)) continue
    index += 1
    const concernId = `c${String(index).padStart(4, '0')}`
    const stack = [file]
    const members = new Set<string>()

    while (stack.length > 0) {
      const current = stack.pop()
      if (!current || visited.has(current)) continue
      visited.add(current)
      members.add(current)
      byFile.set(current, concernId)
      for (const next of strongAdjacency.get(current) ?? []) {
        if (!visited.has(next)) stack.push(next)
      }
    }

    concernFiles.set(concernId, members)
  }

  return { byFile, concernFiles }
}

function scoreToConcern(
  filePath: string,
  concernId: string,
  adjacency: Map<string, Neighbor[]>,
  assignment: Map<string, string>
): number {
  let total = 0
  for (const neighbor of adjacency.get(filePath) ?? []) {
    if (assignment.get(neighbor.filePath) === concernId) {
      total += neighbor.weight
    }
  }
  return total
}

function normalizeConcernIds(assignment: Map<string, string>): ConcernAssignment {
  const byOld = new Map<string, Set<string>>()
  for (const [filePath, concernId] of assignment.entries()) {
    if (!byOld.has(concernId)) byOld.set(concernId, new Set())
    byOld.get(concernId)?.add(filePath)
  }

  const ordered = [...byOld.entries()]
    .map(([oldId, files]) => ({
      oldId,
      files,
      firstFile: [...files].sort()[0] ?? oldId,
      size: files.size,
    }))
    .sort((a, b) => {
      if (b.size !== a.size) return b.size - a.size
      return a.firstFile.localeCompare(b.firstFile)
    })

  const remap = new Map<string, string>()
  for (let i = 0; i < ordered.length; i++) {
    remap.set(ordered[i].oldId, `c${String(i + 1).padStart(4, '0')}`)
  }

  const byFile = new Map<string, string>()
  const concernFiles = new Map<string, Set<string>>()
  for (const [filePath, oldConcernId] of assignment.entries()) {
    const newConcernId = remap.get(oldConcernId)
    if (!newConcernId) continue
    byFile.set(filePath, newConcernId)
    if (!concernFiles.has(newConcernId)) concernFiles.set(newConcernId, new Set())
    concernFiles.get(newConcernId)?.add(filePath)
  }

  return { byFile, concernFiles }
}

export function discoverConcerns(
  files: string[],
  edges: WeightedFileEdge[],
  strongEdgeWeight: number
): ConcernAssignment {
  const sortedFiles = [...files].sort()
  const adjacency = buildAdjacency(sortedFiles, edges)
  const initial = strongComponents(sortedFiles, edges, strongEdgeWeight)
  const assignment = new Map(initial.byFile)

  const maxPasses = 10
  const minGain = 0.005

  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false
    for (const filePath of sortedFiles) {
      const currentConcern = assignment.get(filePath)
      if (!currentConcern) continue

      const candidateConcerns = new Set<string>()
      for (const neighbor of adjacency.get(filePath) ?? []) {
        const candidate = assignment.get(neighbor.filePath)
        if (candidate) candidateConcerns.add(candidate)
      }
      candidateConcerns.delete(currentConcern)
      if (candidateConcerns.size === 0) continue

      const currentScore = scoreToConcern(filePath, currentConcern, adjacency, assignment)
      let bestConcern: string | null = null
      let bestScore = currentScore

      for (const candidate of [...candidateConcerns].sort()) {
        const candidateScore = scoreToConcern(filePath, candidate, adjacency, assignment)
        if (candidateScore > bestScore) {
          bestScore = candidateScore
          bestConcern = candidate
        } else if (candidateScore === bestScore && bestConcern && candidate < bestConcern) {
          bestConcern = candidate
        }
      }

      if (bestConcern && (bestScore - currentScore) >= minGain) {
        assignment.set(filePath, bestConcern)
        moved = true
      }
    }

    if (!moved) break
  }

  return normalizeConcernIds(assignment)
}

