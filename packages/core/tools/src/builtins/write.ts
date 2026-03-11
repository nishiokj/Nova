/**
 * Write and Edit tools - Create and modify files.
 *
 * Ported from: src/harness/agent/tool_registry.py (_file_write, _file_create, _file_edit)
 */

import { writeFile, readFile, mkdir, stat, rename, unlink } from 'fs/promises';
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

/**
 * Atomically write content to a file using a temporary file.
 *
 * This function writes content to a temporary file and then atomically
 * renames it to the target path. This ensures that either the full write
 * succeeds or no partial write occurs.
 *
 * @param filePath - The target file path to write to
 * @param content - The content to write
 * @param encoding - The character encoding to use (default: 'utf-8')
 * @returns Promise that resolves when the write is complete
 * @throws Error if the write fails, with temporary file cleaned up
 */
async function atomicWrite(
  filePath: string,
  content: string,
  encoding: BufferEncoding = 'utf-8'
): Promise<void> {
  const dirPath = dirname(filePath);
  const tmpPath = resolve(dirPath, `.tmp_${randomBytes(8).toString('hex')}.tmp`);

  try {
    await writeFile(tmpPath, content, encoding);
    await rename(tmpPath, filePath);
  } catch (e) {
    // Clean up temp file on failure
    try {
      await unlink(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw e;
  }
}

/**
 * Write content to a new file (fails if exists).
 */
export async function executeWrite(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const path = args.path as string;
  const cwd = context?.workdirOverride ?? process.cwd();
  const content = args.content as string;

  // content is always a string via the `as string` cast above

  const startTime = Date.now();
  const resolvedPath = resolve(cwd, path);

  try {
    // Check if file already exists
    try {
      await stat(resolvedPath);
      return errorResult(
        'Write',
        `File already exists: ${resolvedPath}. Use Edit to modify existing files.`,
        Date.now() - startTime
      );
    } catch (e) {
      // File doesn't exist, which is what we want
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw e;
      }
    }

    // Create directory if needed
    const dirPath = dirname(resolvedPath);
    await mkdir(dirPath, { recursive: true });

    // Atomic write using shared utility
    await atomicWrite(resolvedPath, content, 'utf-8');

    // Build informative output so model knows write succeeded
    const lines = content.split('\n');
    const lineCount = lines.length;
    const preview = lines.slice(0, 5).join('\n');
    const previewSuffix = lineCount > 5 ? `\n... (${lineCount - 5} more lines)` : '';

    return {
      ...successResult(
        'Write',
        `Created ${resolvedPath} (${content.length} bytes, ${lineCount} lines)\n\nPreview:\n${preview}${previewSuffix}`,
        Date.now() - startTime
      ),
      metadata: {
        path: resolvedPath,
        bytesWritten: content.length,
        action: 'write',
        atomic: true,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult('Write', `File write failed: ${message}`, Date.now() - startTime);
  }
}

/**
 * Edit an existing file with string replacement.
 */
export async function executeEdit(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const path = args.path as string;
  const cwd = context?.workdirOverride ?? process.cwd();
  const oldString = args.oldString as string;
  const newString = args.newString as string;
  const replaceAll = typeof args.replaceAll === 'boolean' ? args.replaceAll : false;

  if (!oldString) {
    return errorResult(
      'Edit',
      "Must provide 'oldString' and 'newString' for edit",
      0
    );
  }

  const startTime = Date.now();
  const resolvedPath = resolve(cwd, path);


  try {
    // Read existing content
    let originalContent: string;
    try {
      originalContent = await readFile(resolvedPath, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return errorResult(
          'Edit',
          `File not found for edit: ${resolvedPath}. Use Write to create new files.`,
          Date.now() - startTime
        );
      }
      throw e;
    }

    // Count occurrences
    let count = 0;
    let idx = 0;
    while ((idx = originalContent.indexOf(oldString, idx)) !== -1) {
      count++;
      idx += oldString.length;
    }

    if (count === 0) {
      return errorResult(
        'Edit',
        `oldString not found in ${resolvedPath}. Verify the exact text including whitespace.`,
        Date.now() - startTime,
        { path: resolvedPath, action: 'edit' }
      );
    }

    if (count > 1 && !replaceAll) {
      // Provide context
      const firstIdx = originalContent.indexOf(oldString);
      const snippetStart = Math.max(0, firstIdx - 30);
      const snippetEnd = Math.min(
        originalContent.length,
        firstIdx + oldString.length + 30
      );
      const snippet = originalContent.slice(snippetStart, snippetEnd);

      return errorResult(
        'Edit',
        `oldString found ${count} times - not unique. ` +
          `Add surrounding context to make unique, or use replaceAll=true. ` +
          `First occurrence near: ...${snippet}...`,
        Date.now() - startTime,
        { path: resolvedPath, action: 'edit', occurrences: count }
      );
    }

    // Apply replacement
    let newContent: string;
    let replacements: number;
    if (replaceAll) {
      newContent = originalContent.split(oldString).join(newString);
      replacements = count;
    } else {
      newContent = originalContent.replace(oldString, newString);
      replacements = 1;
    }

    // Atomic write using shared utility
    await atomicWrite(resolvedPath, newContent, 'utf-8');

    // Build informative output with replacement context
    // Find where the replacement occurred to show context
    const newLines = newContent.split('\n');
    const firstNewIdx = newContent.indexOf(newString);
    let contextLines = '';
    if (firstNewIdx !== -1) {
      // Count lines before the replacement
      const linesBefore = newContent.slice(0, firstNewIdx).split('\n').length - 1;
      const startLine = Math.max(0, linesBefore - 1);
      const endLine = Math.min(newLines.length, linesBefore + newString.split('\n').length + 2);
      contextLines = newLines.slice(startLine, endLine)
        .map((line, i) => `${startLine + i + 1}: ${line}`)
        .join('\n');
    }

    const output = [
      `Edited ${resolvedPath}`,
      `Replaced ${replacements} occurrence(s)`,
      '',
      contextLines ? `Context after edit:\n${contextLines}` : '',
    ].filter(Boolean).join('\n');

    return {
      ...successResult('Edit', output, Date.now() - startTime),
      metadata: {
        path: resolvedPath,
        bytesWritten: newContent.length,
        action: 'edit',
        replacements,
        atomic: true,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult('Edit', `File edit failed: ${message}`, Date.now() - startTime);
  }
}

/**
 * Write tool registration options.
 */
export const writeToolOptions: ToolRegistrationOptions = {
  name: 'Write',
  description: 'Create new files in the working directory.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the new file (relative or absolute)',
      },
      content: {
        type: 'string',
        description: 'Full file content to write',
      },
    },
    required: ['path', 'content'],
  },
  required: ['path', 'content'],
  executor: executeWriteEffect,
  timeoutMs: 10000,
  readOnly: false,
  parallelizable: false,
  costHint: 'standard',
};

/**
 * Edit tool registration options.
 */
export const editToolOptions: ToolRegistrationOptions = {
  name: 'Edit',
  description: 'Make precise edits to existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to edit (relative or absolute)',
      },
      oldString: {
        type: 'string',
        description: 'Exact string to find',
      },
      newString: {
        type: 'string',
        description: 'Replacement string',
      },
      replaceAll: {
        type: 'boolean',
        description: 'Replace all occurrences (default: false)',
      },
    },
    required: ['path', 'oldString', 'newString'],
  },
  required: ['path', 'oldString', 'newString'],
  executor: executeEditEffect,
  timeoutMs: 10000,
  readOnly: false,
  parallelizable: false,
  costHint: 'standard',
};

// ============================================
// BATCH EDIT
// ============================================

interface EditOperation {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

interface ValidationError {
  index: number;
  path: string;
  error: string;
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = content.indexOf(search, idx)) !== -1) {
    count++;
    idx += search.length;
  }
  return count;
}

/**
 * Apply multiple edits atomically. All edits succeed or all fail.
 */
export async function executeBatchEdit(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const cwd = context?.workdirOverride ?? process.cwd();
  const edits = args.edits as EditOperation[];

  if (edits.length === 0) {
    return errorResult('BatchEdit', 'Must provide non-empty edits array', 0);
  }

  const startTime = Date.now();

  // Phase 1: Read all files and validate all edits
  const fileContents = new Map<string, string>();
  const validationErrors: ValidationError[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (!edit.path || !edit.oldString) {
      validationErrors.push({
        index: i,
        path: edit.path || '<missing>',
        error: 'Missing required fields (path, oldString, newString)',
      });
      continue;
    }

    const resolvedPath = resolve(cwd, edit.path);

    // Cache file reads
    if (!fileContents.has(resolvedPath)) {
      try {
        fileContents.set(resolvedPath, await readFile(resolvedPath, 'utf-8'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          validationErrors.push({ index: i, path: edit.path, error: 'File not found' });
        } else {
          validationErrors.push({
            index: i,
            path: edit.path,
            error: `Read error: ${(e as Error).message}`,
          });
        }
        continue;
      }
    }

    const content = fileContents.get(resolvedPath);
    if (content === undefined) continue;
    const count = countOccurrences(content, edit.oldString);

    if (count === 0) {
      validationErrors.push({ index: i, path: edit.path, error: 'oldString not found' });
    } else if (count > 1 && !edit.replaceAll) {
      validationErrors.push({
        index: i,
        path: edit.path,
        error: `oldString found ${count} times - not unique`,
      });
    }
  }

  // If any validation failed, return errors without applying anything
  if (validationErrors.length > 0) {
    return errorResult(
      'BatchEdit',
      'Validation failed',
      Date.now() - startTime,
      { success: false, details: validationErrors }
    );
  }

  // Phase 2: Apply all edits (grouped by file, in order)
  const editsByFile = new Map<string, { edit: EditOperation; index: number }[]>();
  for (let i = 0; i < edits.length; i++) {
    const resolvedPath = resolve(cwd, edits[i].path);
    if (!editsByFile.has(resolvedPath)) {
      editsByFile.set(resolvedPath, []);
    }
    editsByFile.get(resolvedPath)?.push({ edit: edits[i], index: i });
  }

  const results: { path: string; replacements: number }[] = [];
  let totalReplacements = 0;

  for (const [resolvedPath, fileEdits] of editsByFile) {
    let content = fileContents.get(resolvedPath) ?? '';

    for (const { edit } of fileEdits) {
      const replaceAll = edit.replaceAll ?? false;
      if (replaceAll) {
        const count = countOccurrences(content, edit.oldString);
        content = content.split(edit.oldString).join(edit.newString);
        totalReplacements += count;
        results.push({ path: edit.path, replacements: count });
      } else {
        content = content.replace(edit.oldString, edit.newString);
        totalReplacements += 1;
        results.push({ path: edit.path, replacements: 1 });
      }
    }

    // Atomic write using shared utility
    try {
      await atomicWrite(resolvedPath, content, 'utf-8');
    } catch (e) {
      return errorResult(
        'BatchEdit',
        `Write failed for ${resolvedPath}: ${(e as Error).message}`,
        Date.now() - startTime
      );
    }
  }

  // Build detailed output showing what was changed
  const details = results.map((r) => `  - ${r.path}: ${r.replacements} replacement(s)`).join('\n');
  const output = [
    `BatchEdit complete: ${edits.length} edits to ${editsByFile.size} file(s)`,
    `Total replacements: ${totalReplacements}`,
    '',
    'Files modified:',
    details,
  ].join('\n');

  return {
    ...successResult('BatchEdit', output, Date.now() - startTime),
    metadata: {
      success: true,
      filesModified: editsByFile.size,
      totalReplacements,
      edits: results,
    },
  };
}

export function executeWriteEffect(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Effect.Effect<ToolResult, ToolExecutionError> {
  return Effect.tryPromise({
    try: () => executeWrite(args, context),
    catch: (error) =>
      toToolExecutionError(error, 'execution_error', {
        toolName: 'Write',
        path: args.path,
      }),
  });
}

export function executeEditEffect(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Effect.Effect<ToolResult, ToolExecutionError> {
  return Effect.tryPromise({
    try: () => executeEdit(args, context),
    catch: (error) =>
      toToolExecutionError(error, 'execution_error', {
        toolName: 'Edit',
        path: args.path,
      }),
  });
}

export function executeBatchEditEffect(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Effect.Effect<ToolResult, ToolExecutionError> {
  return Effect.tryPromise({
    try: () => executeBatchEdit(args, context),
    catch: (error) =>
      toToolExecutionError(error, 'execution_error', {
        toolName: 'BatchEdit',
      }),
  });
}

/**
 * BatchEdit tool registration options.
 */
export const batchEditToolOptions: ToolRegistrationOptions = {
  name: 'BatchEdit',
  description: 'Apply multiple edits atomically. Plan all changes, execute in one call.',
  parameters: {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        description: 'Array of edit operations to apply atomically',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            oldString: { type: 'string', description: 'Exact string to find' },
            newString: { type: 'string', description: 'Replacement string' },
            replaceAll: { type: 'boolean', description: 'Replace all occurrences' },
          },
          required: ['path', 'oldString', 'newString'],
        },
      },
    },
    required: ['edits'],
  },
  required: ['edits'],
  executor: executeBatchEditEffect,
  timeoutMs: 30000,
  readOnly: false,
  parallelizable: false,
  costHint: 'standard',
};
