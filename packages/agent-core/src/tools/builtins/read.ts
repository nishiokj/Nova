/**
 * Read tool - Read file contents.
 *
 * Ported from: src/harness/agent/tool_registry.py (_file_read)
 */

import { readFile, stat } from 'fs/promises';
import { resolve } from 'path';
import type { ToolResult } from '../../types/tools.js';
import { successResult, errorResult } from '../../types/tools.js';
import type { ToolExecutionContext, ToolRegistrationOptions } from '../types.js';

/**
 * Read a file's contents.
 */
export async function executeRead(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const path = args.path as string;
  const cwd = (args.cwd as string) ?? context?.workdirOverride ?? process.cwd();
  const encoding = (args.encoding as BufferEncoding) ?? 'utf-8';
  const maxBytes = (args.maxBytes as number) ?? 100000;

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

      content = buffer.slice(0, bytesRead).toString(encoding);
      content += `\n...[truncated, file size: ${fileSize} bytes]`;
    } else {
      content = await readFile(resolvedPath, { encoding });
    }

    return {
      ...successResult('Read', content, Date.now() - startTime),
      metadata: {
        path: resolvedPath,
        size: fileSize,
        action: 'read',
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

/**
 * Read tool registration options.
 */
export const readToolOptions: ToolRegistrationOptions = {
  name: 'Read',
  description: 'Read any file in the working directory.',
  parameters: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: 'Working directory to resolve relative paths against',
      },
      path: {
        type: 'string',
        description: 'Path to the file to read (relative to cwd or absolute)',
      },
      encoding: {
        type: 'string',
        description: 'File encoding (default: utf-8)',
      },
      maxBytes: {
        type: 'number',
        description: 'Maximum bytes to read (default: 100000)',
      },
    },
    required: ['cwd', 'path'],
  },
  required: ['cwd', 'path'],
  executor: executeRead,
  timeoutMs: 10000,
  readOnly: true,
  parallelizable: true,
  costHint: 'low',
};
