/**
 * Read tool - Read file contents.
 *
 * Ported from: src/harness/agent/tool_registry.py (_file_read)
 */

import { readFile, stat } from 'fs/promises';
import { resolve } from 'path';
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
 * Read a file's contents.
 */
export async function executeRead(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const path = args.path as string | undefined;
  if (!path) {
    return errorResult('Read', 'file_path parameter is required. Provide the path to the file you want to read.', 0);
  }
  const cwd = context?.workdirOverride ?? process.cwd();
  const encoding = (typeof args.encoding === 'string' ? args.encoding : 'utf-8') as BufferEncoding;
  const maxBytes = typeof args.maxBytes === 'number' ? args.maxBytes : 100000;
  const startLine = typeof args.startLine === 'number' ? args.startLine : undefined;
  const endLine = typeof args.endLine === 'number' ? args.endLine : undefined;

  const startTime = Date.now();
  const resolvedPath = resolve(cwd, path);

  try {
    // Check if file exists
    const stats = await stat(resolvedPath);

    if (!stats.isFile()) {
      return errorResult(
        'Read',
        `Path is not a file: ${resolvedPath}`,
        Date.now() - startTime
      );
    }

    const fileSize = stats.size;
    let content: string;

    if (fileSize > maxBytes) {
      // Read only up to maxBytes
      const buffer = Buffer.alloc(maxBytes);
      const { createReadStream } = await import('fs');
      const stream = createReadStream(resolvedPath, { end: maxBytes - 1 });

      let bytesRead = 0;
      for await (const chunk of stream) {
        const chunkBuffer = chunk as Buffer;
        chunkBuffer.copy(buffer, bytesRead);
        bytesRead += chunkBuffer.length;
        if (bytesRead >= maxBytes) break;
      }

      content = buffer.subarray(0, bytesRead).toString(encoding);
      content += `\n...[truncated, file size: ${fileSize} bytes]`;
    } else {
      content = await readFile(resolvedPath, { encoding });
    }

    // Apply line-range slicing for scalpel reads
    let totalLines = 0;
    if (startLine !== undefined || endLine !== undefined) {
      const lines = content.split('\n');
      totalLines = lines.length;
      const start = Math.max(0, (startLine ?? 1) - 1);  // Convert to 0-indexed
      const end = Math.min(lines.length, endLine ?? lines.length);

      const slice = lines.slice(start, end);
      const header = `// Lines ${start + 1}-${Math.min(end, totalLines)} of ${totalLines} total\n`;
      content = header + slice.join('\n');
    }

    return {
      ...successResult('Read', content, Date.now() - startTime),
      metadata: {
        path: resolvedPath,
        size: fileSize,
        action: 'read',
        ...(totalLines > 0 && { totalLines, startLine, endLine }),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Handle specific error types
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return errorResult(
        'Read',
        `File not found: ${resolvedPath}`,
        Date.now() - startTime
      );
    }

    return errorResult('Read', `File read failed: ${message}`, Date.now() - startTime);
  }
}

export function executeReadEffect(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Effect.Effect<ToolResult, ToolExecutionError> {
  return Effect.tryPromise({
    try: () => executeRead(args, context),
    catch: (error) =>
      toToolExecutionError(error, 'execution_error', {
        toolName: 'Read',
        path: args.path,
      }),
  });
}

/**
 * Read tool registration options.
 */
export const readToolOptions: ToolRegistrationOptions = {
  name: 'Read',
  description: 'Read any file in the working directory. Supports line-range reads for surgical file access when you already know the target location.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to read (relative or absolute)',
      },
      encoding: {
        type: 'string',
        description: 'File encoding (default: utf-8)',
      },
      maxBytes: {
        type: 'number',
        description: 'Maximum bytes to read (default: 100000)',
      },
      startLine: {
        type: 'number',
        description: 'Start line for partial reads (1-indexed, inclusive). Use with endLine for surgical reads when you know the target location.',
      },
      endLine: {
        type: 'number',
        description: 'End line for partial reads (1-indexed, inclusive). Use with startLine for surgical reads.',
      },
    },
    required: ['path'],
  },
  required: ['path'],
  executor: executeReadEffect,
  timeoutMs: 10000,
  readOnly: true,
  parallelizable: true,
  costHint: 'low',
};
