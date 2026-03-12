import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { runGitCommand } from './service.js'
import type { TestSmellFileReport, TestSmellHit, TestSmellSummary } from './types.js'

const TEST_PATH_RE = /(^|\/)(__tests__|tests)(\/|$)|\.(test|spec)\.[A-Za-z0-9]+$/
const IMPORT_RE = /^\s*import(?:["'\s\w{},*]+from\s+)?["']([^"']+)["']/gm

interface SmellPattern {
  code: string
  label: string
  points: number
  regex: RegExp
}

const LINE_PATTERNS: SmellPattern[] = [
  {
    code: 'shallow-assertion',
    label: 'Shallow assertion',
    points: -1,
    regex: /\.toBeDefined\(|\.toBeTruthy\(|\.toHaveProperty\(/,
  },
  {
    code: 'skip-gate',
    label: 'Silent skip or gating',
    points: -2,
    regex: /\b(?:describe|it|test)\.skip\(|\?\s*describe\s*:\s*describe\.skip/,
  },
  {
    code: 'owned-code-mock',
    label: 'Mocking or spying',
    points: -2,
    regex: /\b(?:vi|jest)\.(?:mock|fn|spyOn)\(|mockResolvedValue|mockRejectedValue/,
  },
  {
    code: 'snapshot',
    label: 'Snapshot assertion',
    points: -1,
    regex: /\.toMatchSnapshot\(/,
  },
  {
    code: 'nothrow-only',
    label: 'not.toThrow-style weak assertion',
    points: -1,
    regex: /\.not\.toThrow\(/,
  },
  {
    code: 'impl-rationalization',
    label: 'Comment rationalizes current implementation',
    points: -3,
    regex: /current implementation|by design|tried first|matches first|priority ordering/i,
  },
  {
    code: 'conditional-assertion',
    label: 'Conditional assertion block',
    points: -1,
    regex: /^\s*if\s*\(.*\)\s*\{?\s*$/,
  },
]

function isTestPath(filepath: string): boolean {
  return TEST_PATH_RE.test(filepath)
}

function normalizeRelPath(filepath: string): string {
  return filepath.split(path.sep).join('/')
}

function unique(items: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    if (seen.has(item)) continue
    seen.add(item)
    result.push(item)
  }
  return result
}

function expandTestPath(rootPath: string, candidatePath: string): string[] {
  const normalized = normalizeRelPath(candidatePath)
  return isTestPath(normalized) ? [normalized] : []
}

export async function recentTestPaths(rootPath: string, selector: string): Promise<string[]> {
  const paths: string[] = []
  const timeoutMs = 5_000

  if (selector === 'recent' || selector === 'working-tree') {
    const status = await runGitCommand({
      cwd: rootPath,
      args: ['status', '--porcelain'],
      timeoutMs,
      rejectOnNonZero: false,
    })
    for (const line of status.stdout.split('\n')) {
      if (!line) continue
      const candidatePath = line.length > 3 ? line.slice(3).trim() : ''
      paths.push(...expandTestPath(rootPath, candidatePath))
    }
  }

  if (selector === 'recent' || selector === 'head') {
    const head = await runGitCommand({
      cwd: rootPath,
      args: ['rev-parse', '--verify', 'HEAD~1'],
      timeoutMs,
      rejectOnNonZero: false,
    })
    if (head.exitCode === 0) {
      const diff = await runGitCommand({
        cwd: rootPath,
        args: ['diff', '--name-only', '--diff-filter=AM', 'HEAD~1', 'HEAD'],
        timeoutMs,
        rejectOnNonZero: false,
      })
      for (const line of diff.stdout.split('\n')) {
        if (!line) continue
        paths.push(...expandTestPath(rootPath, line.trim()))
      }
    }
  }

  return unique(paths)
}

function windowMatch(lines: string[], index: number, pattern: RegExp, window = 3): boolean {
  const blob = lines.slice(index, Math.min(lines.length, index + window + 1)).join('\n')
  return pattern.test(blob)
}

function sortHits(a: TestSmellHit, b: TestSmellHit): number {
  return a.line - b.line || a.code.localeCompare(b.code)
}

export async function smellReportForFile(rootPath: string, relativePath: string): Promise<TestSmellFileReport> {
  const absPath = path.join(rootPath, relativePath)
  const content = await readFile(absPath, 'utf-8')
  const lines = content.split('\n')
  const hits: TestSmellHit[] = []

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    for (const pattern of LINE_PATTERNS) {
      if (!pattern.regex.test(line)) continue
      if (
        pattern.code === 'conditional-assertion'
        && !windowMatch(lines, index, /\bexpect\(/, 4)
      ) {
        continue
      }
      hits.push({
        code: pattern.code,
        label: pattern.label,
        line: lineNumber,
        points: pattern.points,
        excerpt: line.trim(),
      })
    }

    const lower = line.toLowerCase()
    const suspiciousIdentity = (
      lower.includes('same reference')
      || lower.includes('identity')
      || lower.includes('in-place')
      || lower.includes('as-is')
      || lower.includes('pass-through')
      || /\.toBe\((?:existing|entry|err|obj|reg\d*|mock[A-Z_a-z]|CONNECTOR_|REGISTRY\.)/.test(line)
    )
    if (suspiciousIdentity && line.includes('.toBe(')) {
      hits.push({
        code: 'identity-assertion',
        label: 'Possible same-reference or identity assertion',
        line: lineNumber,
        points: -2,
        excerpt: line.trim(),
      })
    }

    if (line.includes('Object.keys(') && windowMatch(lines, index, /\.toHaveLength\(/)) {
      hits.push({
        code: 'exact-key-count',
        label: 'Exact object key count assertion',
        line: lineNumber,
        points: -2,
        excerpt: line.trim(),
      })
    }

    if ((line.includes('params.keys(') || line.includes('searchParams')) && windowMatch(lines, index, /\.toHaveLength\(/)) {
      hits.push({
        code: 'exact-param-count',
        label: 'Exact query-param count assertion',
        line: lineNumber,
        points: -2,
        excerpt: line.trim(),
      })
    }
  })

  const imports = Array.from(content.matchAll(IMPORT_RE))
    .map(match => match[1])
    .filter(value => value.startsWith('.') || value.includes('/'))
    .sort((a, b) => a.localeCompare(b))

  const testCount = (content.match(/\b(?:it|test)\s*(?:\.each)?\s*\(/g) ?? []).length

  return {
    path: relativePath,
    testCount,
    imports,
    penaltyPoints: hits.reduce((sum, hit) => sum + hit.points, 0),
    hitCount: hits.length,
    hits: hits.sort(sortHits),
  }
}

export async function summarizeSmells(
  rootPath: string,
  selector: string | null,
  paths: string[],
): Promise<TestSmellSummary> {
  const reports = await Promise.all(paths.map(filepath => smellReportForFile(rootPath, filepath)))
  const files = reports.sort((a, b) => (
    a.penaltyPoints - b.penaltyPoints
    || b.hitCount - a.hitCount
    || a.path.localeCompare(b.path)
  ))

  return {
    selector,
    fileCount: files.length,
    totalTests: files.reduce((sum, report) => sum + report.testCount, 0),
    totalPenaltyPoints: files.reduce((sum, report) => sum + report.penaltyPoints, 0),
    files,
  }
}
