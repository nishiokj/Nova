import type { ConcernAssignment } from './types.js'

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function moduleKeyForFile(filePath: string): string {
  const normalized = normalizeFilePath(filePath)
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return 'root'

  if ((parts[0] === 'packages' || parts[0] === 'apps' || parts[0] === 'services') && parts[1]) {
    return `${parts[0]}/${parts[1]}`
  }

  if (parts[0] === 'src' && parts[1]) {
    return `src/${parts[1]}`
  }

  if (parts[0] === 'tests' && parts[1]) {
    return `tests/${parts[1]}`
  }

  return parts[0]
}

function concernIdForModule(moduleKey: string): string {
  return `module:${moduleKey}`
}

export function assignModuleConcerns(files: string[]): ConcernAssignment {
  const byFile = new Map<string, string>()
  const concernFiles = new Map<string, Set<string>>()

  for (const filePath of [...files].sort()) {
    const moduleKey = moduleKeyForFile(filePath)
    const concernId = concernIdForModule(moduleKey)
    byFile.set(filePath, concernId)
    if (!concernFiles.has(concernId)) concernFiles.set(concernId, new Set())
    concernFiles.get(concernId)?.add(filePath)
  }

  return { byFile, concernFiles }
}

export function labelsForModuleConcerns(assignment: ConcernAssignment): Map<string, string> {
  const labels = new Map<string, string>()
  for (const concernId of assignment.concernFiles.keys()) {
    if (concernId.startsWith('module:')) {
      labels.set(concernId, concernId.slice('module:'.length))
    } else {
      labels.set(concernId, concernId)
    }
  }
  return labels
}
