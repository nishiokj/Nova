import { statSync } from 'fs'
import path from 'path'

export const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

export function stripQuotes(text: string): string {
  if (
    (text.startsWith("'") && text.endsWith("'"))
    || (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith('`') && text.endsWith('`'))
  ) {
    return text.slice(1, -1)
  }
  return text
}

export function normalizeRelPath(filepath: string): string {
  return filepath.replaceAll(path.sep, '/')
}

export function isLikelyTestPath(filepath: string): boolean {
  const normalized = normalizeRelPath(filepath)
  return (
    normalized.includes('/__tests__/')
    || normalized.includes('/tests/')
    || normalized.includes('.test.')
    || normalized.includes('.spec.')
    || normalized.includes('/test_')
  )
}

export function resolveImportSource(
  specifier: string,
  currentFilepath: string,
  sourceRoot: string
): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return null
  }

  const currentDir = path.dirname(path.resolve(sourceRoot, currentFilepath))
  const base = path.resolve(currentDir, specifier)
  const stripped = /\.(js|jsx)$/.test(base)
    ? base.replace(/\.(js|jsx)$/, '')
    : null

  const candidates = [
    base,
    ...(stripped ? RESOLVE_EXTENSIONS.map(ext => stripped + ext) : []),
    ...RESOLVE_EXTENSIONS.map(ext => base + ext),
    ...RESOLVE_EXTENSIONS.map(ext => path.join(base, `index${ext}`)),
  ]

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return normalizeRelPath(path.relative(sourceRoot, candidate))
      }
    } catch {
      continue
    }
  }

  return null
}
