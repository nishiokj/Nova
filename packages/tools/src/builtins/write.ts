/**
 * Write and Edit tools - Create and modify files.
 *
 * Ported from: src/harness/agent/tool_registry.py (_file_write, _file_create, _file_edit)
 */

import { writeFile, readFile, mkdir, stat, rename, unlink } from 'fs/promises';
import { resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import type { ToolResult } from 'types';
import { successResult, errorResult } from 'types';
import type { ToolExecutionContext, ToolRegistrationOptions } from '../types.js';

/**
 * Write content to a new file (fails if exists).
 */
export async function executeWrite(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const path = args.path as string;
  const cwd = (args.cwd as string) ?? context?.workdirOverride ?? process.cwd();
  const content = args.content as string;

  if (content === undefined || content === null) {
    return errorResult('Write', "Must provide 'content' to create a new file", 0);
  }

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

    // Atomic write: write to temp file, then rename
    const tmpPath = resolve(
      dirPath,
      `.tmp_write_${randomBytes(8).toString('hex')}.tmp`
    );

    try {
      await writeFile(tmpPath, content, 'utf-8');
      await rename(tmpPath, resolvedPath);
    } catch (e) {
      // Clean up temp file on failure
      try {
        await unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw e;
    }

    return {
      ...successResult(
        'Write',
        `Successfully wrote ${resolvedPath}`,
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
  const cwd = (args.cwd as string) ?? context?.workdirOverride ?? process.cwd();
  const oldString = args.oldString as string;
  const newString = args.newString as string;
  const replaceAll = (args.replaceAll as boolean) ?? false;

  if (!oldString || newString === undefined) {
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
        `old_string not found in ${resolvedPath}. Verify the exact text including whitespace.`,
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
        `old_string found ${count} times - not unique. ` +
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

    // Atomic write
    const dirPath = dirname(resolvedPath);
    const tmpPath = resolve(
      dirPath,
      `.tmp_edit_${randomBytes(8).toString('hex')}.tmp`
    );

    try {
      await writeFile(tmpPath, newContent, 'utf-8');
      await rename(tmpPath, resolvedPath);
    } catch (e) {
      try {
        await unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw e;
    }

    return {
      ...successResult(
        'Edit',
        `Replaced ${replacements} occurrence(s) in ${resolvedPath}`,
        Date.now() - startTime
      ),
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
      cwd: {
        type: 'string',
        description: 'Working directory to resolve relative paths against',
      },
      path: {
        type: 'string',
        description: 'Path to the new file (relative to cwd or absolute)',
      },
      content: {
        type: 'string',
        description: 'Full file content to write',
      },
    },
    required: ['cwd', 'path', 'content'],
  },
  required: ['cwd', 'path', 'content'],
  executor: executeWrite,
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
      cwd: {
        type: 'string',
        description: 'Working directory to resolve relative paths against',
      },
      path: {
        type: 'string',
        description: 'Path to the file to edit (relative to cwd or absolute)',
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
    required: ['cwd', 'path', 'oldString', 'newString'],
  },
  required: ['cwd', 'path', 'oldString', 'newString'],
  executor: executeEdit,
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
  const cwd = (args.cwd as string) ?? context?.workdirOverride ?? process.cwd();
  const edits = args.edits as EditOperation[];

  if (!edits || !Array.isArray(edits) || edits.length === 0) {
    return errorResult('BatchEdit', 'Must provide non-empty edits array', 0);
  }

  const startTime = Date.now();

  // Phase 1: Read all files and validate all edits
  const fileContents = new Map<string, string>();
  const validationErrors: ValidationError[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (!edit.path || !edit.oldString || edit.newString === undefined) {
      validationErrors.push({
        index: i,
        path: edit.path ?? '<missing>',
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

    const content = fileContents.get(resolvedPath)!;
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
    editsByFile.get(resolvedPath)!.push({ edit: edits[i], index: i });
  }

  const results: { path: string; replacements: number }[] = [];
  let totalReplacements = 0;

  for (const [resolvedPath, fileEdits] of editsByFile) {
    let content = fileContents.get(resolvedPath)!;

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

    // Atomic write
    const dirPath = dirname(resolvedPath);
    const tmpPath = resolve(dirPath, `.tmp_batch_${randomBytes(8).toString('hex')}.tmp`);

    try {
      await writeFile(tmpPath, content, 'utf-8');
      await rename(tmpPath, resolvedPath);
    } catch (e) {
      try {
        await unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      return errorResult(
        'BatchEdit',
        `Write failed for ${resolvedPath}: ${(e as Error).message}`,
        Date.now() - startTime
      );
    }
  }

  return {
    ...successResult(
      'BatchEdit',
      `Applied ${edits.length} edits to ${editsByFile.size} file(s)`,
      Date.now() - startTime
    ),
    metadata: {
      success: true,
      filesModified: editsByFile.size,
      totalReplacements,
      edits: results,
    },
  };
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
      cwd: {
        type: 'string',
        description: 'Working directory to resolve relative paths against',
      },
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
    required: ['cwd', 'edits'],
  },
  required: ['cwd', 'edits'],
  executor: executeBatchEdit,
  timeoutMs: 30000,
  readOnly: false,
  parallelizable: false,
  costHint: 'standard',
};
