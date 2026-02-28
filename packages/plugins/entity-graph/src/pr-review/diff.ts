/**
 * Unified Diff Parser
 *
 * Parses standard unified diff output (git diff) into structured FileChange objects.
 * Handles added, modified, deleted, and renamed files.
 */

import type { FileChange, Hunk } from './types.js'

/**
 * Parse unified diff text into structured file changes.
 */
export function parseDiff(diffText: string): FileChange[] {
  const changes: FileChange[] = []
  // Normalize CRLF/CR to LF so header parsing remains stable across platforms.
  const lines = diffText.replace(/\r/g, '').split('\n')
  let i = 0

  while (i < lines.length) {
    // Find next "diff --git" header
    if (!lines[i].startsWith('diff --git ')) {
      i++
      continue
    }

    const { change, nextIndex } = parseFileDiff(lines, i)
    if (change) {
      changes.push(change)
    }
    i = nextIndex
  }

  return changes
}

function parseFileDiff(
  lines: string[],
  start: number,
): { change: FileChange | null; nextIndex: number } {
  let i = start

  // Parse "diff --git a/path b/path"
  const diffLine = lines[i]
  const gitMatch = diffLine.match(/^diff --git a\/(.+) b\/(.+)$/)
  if (!gitMatch) return { change: null, nextIndex: i + 1 }

  const aPath = gitMatch[1]
  const bPath = gitMatch[2]
  i++

  // Consume metadata lines (old mode, new mode, similarity, index, etc.)
  let status: FileChange['status'] = 'modified'
  let oldFilepath: string | undefined

  while (i < lines.length && !lines[i].startsWith('diff --git ')) {
    const line = lines[i]

    if (line.startsWith('new file mode')) {
      status = 'added'
    } else if (line.startsWith('deleted file mode')) {
      status = 'deleted'
    } else if (line.startsWith('rename from ')) {
      status = 'renamed'
      oldFilepath = line.slice('rename from '.length)
    } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      // Skip --- / +++ lines, handled by hunk parsing
    } else if (line.startsWith('@@')) {
      break // Start of hunks
    }
    i++
  }

  // Parse hunks
  const hunks: Hunk[] = []
  while (i < lines.length && !lines[i].startsWith('diff --git ')) {
    if (lines[i].startsWith('@@')) {
      const hunk = parseHunkHeader(lines[i])
      if (hunk) hunks.push(hunk)
    }
    i++
  }

  return {
    change: {
      filepath: bPath,
      status,
      oldFilepath,
      hunks,
    },
    nextIndex: i,
  }
}

/**
 * Parse a unified diff hunk header: @@ -oldStart,oldCount +newStart,newCount @@
 */
export function parseHunkHeader(line: string): Hunk | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
  if (!match) return null

  return {
    oldStart: parseInt(match[1], 10),
    oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
  }
}
