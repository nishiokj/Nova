/**
 * apply_patch tool - Parse and apply Codex-style file patches.
 *
 * Supports Add/Delete/Update/Move file operations with multi-hunk patches.
 * Validates all operations before applying any (atomic semantics).
 */

import { readFile, writeFile, mkdir, stat, rename, unlink } from 'fs/promises';
import { resolve, dirname } from 'path';
import { randomBytes } from 'crypto';
import { Effect } from 'effect';
import type { ToolResult } from 'types';
import { successResult, errorResult } from 'types';
import type {
  ToolExecutionContext,
  ToolExecutionError,
  ToolRegistrationOptions,
} from '../types.js';
import { toToolExecutionError } from '../types.js';

// ============================================
// TYPES
// ============================================

export type PatchOperation =
  | { type: 'add'; path: string; content: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; moveTo?: string; hunks: Hunk[] };

export interface Hunk {
  contextHeader?: string;
  lines: HunkLine[];
}

export interface HunkLine {
  type: 'context' | 'add' | 'remove';
  content: string;
}

// ============================================
// PARSER
// ============================================

const enum State {
  IDLE,
  BEGIN_PATCH,
  FILE_OP,
  HUNK_HEADER,
  HUNK_BODY,
}

/**
 * Parse a Codex apply_patch text into structured operations.
 */
export function parsePatch(input: string): PatchOperation[] {
  const rawLines = input.split('\n');
  const operations: PatchOperation[] = [];
  let state: State = State.IDLE;

  // Current operation being built
  let currentOp: PatchOperation | null = null;
  let currentHunk: Hunk | null = null;

  const finalizeHunk = () => {
    if (currentHunk && currentOp?.type === 'update') {
      if (currentHunk.lines.length > 0) {
        currentOp.hunks.push(currentHunk);
      }
      currentHunk = null;
    }
  };

  const finalizeOp = () => {
    finalizeHunk();
    if (currentOp) {
      operations.push(currentOp);
      currentOp = null;
    }
  };

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    // Handle state transitions for control lines
    if (line === '*** Begin Patch') {
      if (state !== State.IDLE) {
        throw new PatchParseError('Unexpected "*** Begin Patch" — already inside a patch');
      }
      state = State.BEGIN_PATCH;
      continue;
    }

    if (line === '*** End Patch') {
      if (state === State.IDLE) {
        throw new PatchParseError('Unexpected "*** End Patch" — no matching Begin');
      }
      finalizeOp();
      state = State.IDLE;
      continue;
    }

    if (line.startsWith('*** Add File: ')) {
      if (state === State.IDLE) {
        throw new PatchParseError(`Line ${i + 1}: file operation outside of patch block`);
      }
      finalizeOp();
      const path = line.slice('*** Add File: '.length).trim();
      currentOp = { type: 'add', path, content: '' };
      state = State.FILE_OP;
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      if (state === State.IDLE) {
        throw new PatchParseError(`Line ${i + 1}: file operation outside of patch block`);
      }
      finalizeOp();
      const path = line.slice('*** Delete File: '.length).trim();
      currentOp = { type: 'delete', path };
      state = State.FILE_OP;
      continue;
    }

    if (line.startsWith('*** Update File: ')) {
      if (state === State.IDLE) {
        throw new PatchParseError(`Line ${i + 1}: file operation outside of patch block`);
      }
      finalizeOp();
      const path = line.slice('*** Update File: '.length).trim();
      currentOp = { type: 'update', path, hunks: [] };
      state = State.FILE_OP;
      continue;
    }

    if (line.startsWith('*** Move to: ')) {
      if (currentOp?.type !== 'update') {
        throw new PatchParseError(`Line ${i + 1}: "Move to" without preceding "Update File"`);
      }
      currentOp.moveTo = line.slice('*** Move to: '.length).trim();
      continue;
    }

    // Hunk header
    if (line.startsWith('@@')) {
      if (currentOp?.type !== 'update') {
        throw new PatchParseError(`Line ${i + 1}: hunk header outside of Update operation`);
      }
      finalizeHunk();
      // Extract optional context header after @@
      const headerMatch = /^@@\s*(.*)$/.exec(line);
      const contextHeader = headerMatch?.[1]?.trim() ?? undefined;
      currentHunk = { contextHeader, lines: [] };
      state = State.HUNK_BODY;
      continue;
    }

    // Content lines (inside hunk body or add file)
    if (state === State.HUNK_BODY && currentHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({ type: 'add', content: line.slice(1) });
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({ type: 'remove', content: line.slice(1) });
      } else if (line.startsWith(' ') || line === '') {
        // Space-prefixed context line, or empty line treated as empty context
        currentHunk.lines.push({ type: 'context', content: line === '' ? '' : line.slice(1) });
      } else {
        throw new PatchParseError(
          `Line ${i + 1}: unexpected line in hunk body: "${line.slice(0, 60)}"`
        );
      }
      continue;
    }

    // Add file content lines (all lines are +prefixed)
    if (state === State.FILE_OP && currentOp?.type === 'add') {
      if (line.startsWith('+')) {
        currentOp.content += (currentOp.content ? '\n' : '') + line.slice(1);
      } else if (line === '') {
        // Empty line in add block — append newline
        currentOp.content += '\n';
      } else {
        throw new PatchParseError(
          `Line ${i + 1}: expected '+' prefix in Add File block, got: "${line.slice(0, 60)}"`
        );
      }
      continue;
    }

    // Skip empty lines in non-content states
    if (line.trim() === '' && (state === State.BEGIN_PATCH || state === State.FILE_OP)) {
      continue;
    }

    if (state !== State.IDLE) {
      throw new PatchParseError(`Line ${i + 1}: unexpected line: "${line.slice(0, 80)}"`);
    }
  }

  if (state !== State.IDLE) {
    throw new PatchParseError('Patch block not closed — missing "*** End Patch"');
  }

  if (operations.length === 0) {
    throw new PatchParseError('No patch operations found — missing "*** Begin Patch"');
  }

  return operations;
}

export class PatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchParseError';
  }
}

// ============================================
// HUNK APPLICATION
// ============================================

/**
 * Apply a hunk to file lines, returning modified lines.
 * Finds a unique match for the hunk's context+remove pattern and applies the substitution.
 */
function applyHunk(fileLines: string[], hunk: Hunk, filePath: string): string[] {
  // Build the search pattern: context and remove lines in order
  const searchLines: string[] = [];
  for (const hl of hunk.lines) {
    if (hl.type === 'context' || hl.type === 'remove') {
      searchLines.push(hl.content);
    }
  }

  if (searchLines.length === 0) {
    // Pure addition hunk — append at end (or at context header location)
    const insertLines = hunk.lines.filter((l) => l.type === 'add').map((l) => l.content);
    if (hunk.contextHeader) {
      const headerIdx = findContextHeaderLine(fileLines, hunk.contextHeader);
      if (headerIdx >= 0) {
        const result = [...fileLines];
        result.splice(headerIdx + 1, 0, ...insertLines);
        return result;
      }
    }
    return [...fileLines, ...insertLines];
  }

  // Determine search scope
  let searchStart = 0;
  let searchEnd = fileLines.length;
  if (hunk.contextHeader) {
    const headerIdx = findContextHeaderLine(fileLines, hunk.contextHeader);
    if (headerIdx >= 0) {
      searchStart = headerIdx;
      // Scope extends to the next context-header-level line or end of file
      const nextHeaderIdx = findNextContextHeaderLine(fileLines, headerIdx + 1);
      searchEnd = nextHeaderIdx >= 0 ? nextHeaderIdx : fileLines.length;
    }
  }

  // Find all matches of the search pattern within scope
  const matchPositions: number[] = [];
  for (let startIdx = searchStart; startIdx <= searchEnd - searchLines.length; startIdx++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (fileLines[startIdx + j] !== searchLines[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      matchPositions.push(startIdx);
    }
  }

  if (matchPositions.length === 0) {
    const preview = searchLines.slice(0, 3).map((l) => `  "${l}"`).join('\n');
    throw new PatchApplyError(
      `Hunk match failed in ${filePath}: could not find pattern:\n${preview}`
    );
  }

  if (matchPositions.length > 1) {
    throw new PatchApplyError(
      `Ambiguous hunk match in ${filePath}: pattern matches ${matchPositions.length} locations (lines ${matchPositions.map((p) => p + 1).join(', ')})`
    );
  }

  // Apply the hunk at the single match position
  const matchStart = matchPositions[0];
  const replacement: string[] = [];
  for (const hl of hunk.lines) {
    if (hl.type === 'context') {
      replacement.push(hl.content);
    } else if (hl.type === 'add') {
      replacement.push(hl.content);
    }
    // 'remove' lines are omitted
  }

  const result = [...fileLines];
  result.splice(matchStart, searchLines.length, ...replacement);
  return result;
}

function findContextHeaderLine(lines: string[], header: string): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(header)) {
      return i;
    }
  }
  return -1;
}

function findNextContextHeaderLine(lines: string[], startFrom: number): number {
  // A context header line is typically a function/class definition
  // For now, look for lines that match common patterns (not indented, looks like a declaration)
  for (let i = startFrom; i < lines.length; i++) {
    const line = lines[i];
    if (
      line.length > 0 &&
      !line.startsWith(' ') &&
      !line.startsWith('\t') &&
      (line.startsWith('function ') ||
        line.startsWith('class ') ||
        line.startsWith('export ') ||
        line.startsWith('def ') ||
        line.startsWith('async '))
    ) {
      return i;
    }
  }
  return -1;
}

export class PatchApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchApplyError';
  }
}

// ============================================
// EXECUTOR
// ============================================

/**
 * Atomically write content to a file using a temporary file.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dirPath = dirname(filePath);
  const tmpPath = resolve(dirPath, `.tmp_${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(tmpPath, content, 'utf-8');
    await rename(tmpPath, filePath);
  } catch (e) {
    try {
      await unlink(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw e;
  }
}

/**
 * Validate and prepare all patch operations.
 * Returns prepared data needed for application, or throws on validation failure.
 */
interface PreparedAdd {
  type: 'add';
  resolvedPath: string;
  content: string;
}

interface PreparedDelete {
  type: 'delete';
  resolvedPath: string;
}

interface PreparedUpdate {
  type: 'update';
  resolvedPath: string;
  moveTo?: string;
  newContent: string;
  oldPath?: string;
}

type PreparedOp = PreparedAdd | PreparedDelete | PreparedUpdate;

async function validateAndPrepare(
  operations: PatchOperation[],
  basePath: string
): Promise<PreparedOp[]> {
  const prepared: PreparedOp[] = [];

  for (const op of operations) {
    const resolvedPath = resolve(basePath, op.path);

    switch (op.type) {
      case 'add': {
        // Verify file doesn't already exist
        try {
          await stat(resolvedPath);
          throw new PatchApplyError(`Add failed: file already exists: ${op.path}`);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            if (e instanceof PatchApplyError) throw e;
            throw new PatchApplyError(`Add failed: cannot stat ${op.path}: ${(e as Error).message}`);
          }
        }
        prepared.push({ type: 'add', resolvedPath, content: op.content });
        break;
      }

      case 'delete': {
        // Verify file exists
        try {
          await stat(resolvedPath);
        } catch {
          throw new PatchApplyError(`Delete failed: file not found: ${op.path}`);
        }
        prepared.push({ type: 'delete', resolvedPath });
        break;
      }

      case 'update': {
        // Read file and apply hunks
        let fileContent: string;
        try {
          fileContent = await readFile(resolvedPath, 'utf-8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new PatchApplyError(`Update failed: file not found: ${op.path}`);
          }
          throw new PatchApplyError(`Update failed: cannot read ${op.path}: ${(e as Error).message}`);
        }

        let lines = fileContent.split('\n');
        for (const hunk of op.hunks) {
          lines = applyHunk(lines, hunk, op.path);
        }

        const newContent = lines.join('\n');
        const resolvedMoveTo = op.moveTo ? resolve(basePath, op.moveTo) : undefined;
        prepared.push({
          type: 'update',
          resolvedPath: resolvedMoveTo ?? resolvedPath,
          newContent,
          oldPath: op.moveTo ? resolvedPath : undefined,
        });
        break;
      }
    }
  }

  return prepared;
}

/**
 * Apply all prepared operations to the filesystem.
 */
async function applyPrepared(prepared: PreparedOp[]): Promise<string[]> {
  const changedPaths: string[] = [];

  for (const op of prepared) {
    switch (op.type) {
      case 'add': {
        await mkdir(dirname(op.resolvedPath), { recursive: true });
        await atomicWrite(op.resolvedPath, op.content);
        changedPaths.push(op.resolvedPath);
        break;
      }
      case 'delete': {
        await unlink(op.resolvedPath);
        changedPaths.push(op.resolvedPath);
        break;
      }
      case 'update': {
        await mkdir(dirname(op.resolvedPath), { recursive: true });
        await atomicWrite(op.resolvedPath, op.newContent);
        changedPaths.push(op.resolvedPath);
        if (op.oldPath) {
          await unlink(op.oldPath);
          changedPaths.push(op.oldPath);
        }
        break;
      }
    }
  }

  return changedPaths;
}

/**
 * Parse and apply a patch atomically.
 * Validates all operations before applying any.
 */
export async function applyPatchOperations(
  operations: PatchOperation[],
  basePath: string
): Promise<string[]> {
  // Phase 1: validate all operations and prepare results
  const prepared = await validateAndPrepare(operations, basePath);
  // Phase 2: apply all operations
  return applyPrepared(prepared);
}

/**
 * Tool executor entry point.
 */
export async function executeApplyPatch(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const cwd = context?.workdirOverride ?? (args.cwd as string | undefined) ?? process.cwd();
  const startTime = Date.now();

  // The input is either raw text (freeform) or wrapped in { input: string }
  let patchText: string;
  if (typeof args.input === 'string') {
    patchText = args.input;
  } else if (typeof args.patch === 'string') {
    patchText = args.patch;
  } else {
    // Try to find any string argument
    const firstStringArg = Object.values(args).find((v) => typeof v === 'string' && v.includes('*** Begin Patch'));
    if (typeof firstStringArg === 'string') {
      patchText = firstStringArg;
    } else {
      return errorResult('apply_patch', 'No patch text provided', 0);
    }
  }

  try {
    const operations = parsePatch(patchText);
    const changedPaths = await applyPatchOperations(operations, cwd);

    const summary = operations.map((op) => {
      switch (op.type) {
        case 'add':
          return `  + ${op.path} (created)`;
        case 'delete':
          return `  - ${op.path} (deleted)`;
        case 'update':
          return op.moveTo
            ? `  ~ ${op.path} -> ${op.moveTo} (${op.hunks.length} hunks)`
            : `  ~ ${op.path} (${op.hunks.length} hunks)`;
      }
    }).join('\n');

    return {
      ...successResult(
        'apply_patch',
        `Patch applied: ${operations.length} operation(s)\n${summary}`,
        Date.now() - startTime
      ),
      metadata: {
        operations: operations.length,
        changedPaths,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult('apply_patch', `Patch failed: ${message}`, Date.now() - startTime);
  }
}

export function executeApplyPatchEffect(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Effect.Effect<ToolResult, ToolExecutionError> {
  return Effect.tryPromise({
    try: () => executeApplyPatch(args, context),
    catch: (error) =>
      toToolExecutionError(error, 'execution_error', {
        toolName: 'apply_patch',
      }),
  });
}

// ============================================
// REGISTRATION
// ============================================

export const applyPatchToolOptions: ToolRegistrationOptions = {
  name: 'apply_patch',
  description:
    'Apply file patches. Supports Add, Delete, Update, and Move operations ' +
    'with context-based hunk matching. All operations are validated before any are applied.',
  parameters: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'The patch text in apply_patch format',
      },
    },
    required: ['input'],
  },
  required: ['input'],
  executor: executeApplyPatchEffect,
  timeoutMs: 30000,
  readOnly: false,
  parallelizable: false,
  costHint: 'standard',
};
