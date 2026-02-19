/**
 * Tests for apply_patch parser and executor.
 *
 * Focus areas:
 * - Parser: all operation types, multi-file, error cases
 * - Executor: filesystem operations, atomicity, edge cases
 */

import { mkdir, writeFile, readFile, rm, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import {
  parsePatch,
  applyPatchOperations,
  executeApplyPatch,
  PatchParseError,
  PatchApplyError,
} from 'tools/builtins/apply_patch.js';
import type { PatchOperation } from 'tools/builtins/apply_patch.js';

function createTempDir(): string {
  return join(tmpdir(), `apply-patch-test-${randomBytes(8).toString('hex')}`);
}

// ============================================
// PARSER TESTS
// ============================================

describe('parsePatch', () => {
  it('should parse Add File operation', () => {
    const input = [
      '*** Begin Patch',
      '*** Add File: src/hello.ts',
      '+export function hello() {',
      '+  return "world";',
      '+}',
      '*** End Patch',
    ].join('\n');

    const ops = parsePatch(input);
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('add');
    if (ops[0].type === 'add') {
      expect(ops[0].path).toBe('src/hello.ts');
      expect(ops[0].content).toBe(
        'export function hello() {\n  return "world";\n}'
      );
    }
  });

  it('should parse Delete File operation', () => {
    const input = [
      '*** Begin Patch',
      '*** Delete File: src/old.ts',
      '*** End Patch',
    ].join('\n');

    const ops = parsePatch(input);
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('delete');
    expect(ops[0].path).toBe('src/old.ts');
  });

  it('should parse Update File with one hunk', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/main.ts',
      '@@ export function main',
      ' export function main() {',
      '-  return 1;',
      '+  return 2;',
      ' }',
      '*** End Patch',
    ].join('\n');

    const ops = parsePatch(input);
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('update');
    if (ops[0].type === 'update') {
      expect(ops[0].path).toBe('src/main.ts');
      expect(ops[0].hunks).toHaveLength(1);
      expect(ops[0].hunks[0].contextHeader).toBe('export function main');
      expect(ops[0].hunks[0].lines).toHaveLength(4);
      expect(ops[0].hunks[0].lines[0]).toEqual({ type: 'context', content: 'export function main() {' });
      expect(ops[0].hunks[0].lines[1]).toEqual({ type: 'remove', content: '  return 1;' });
      expect(ops[0].hunks[0].lines[2]).toEqual({ type: 'add', content: '  return 2;' });
      expect(ops[0].hunks[0].lines[3]).toEqual({ type: 'context', content: '}' });
    }
  });

  it('should parse Update File with multiple hunks', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/main.ts',
      '@@ function foo',
      ' function foo() {',
      '-  return 1;',
      '+  return 2;',
      ' }',
      '@@ function bar',
      ' function bar() {',
      '-  return "a";',
      '+  return "b";',
      ' }',
      '*** End Patch',
    ].join('\n');

    const ops = parsePatch(input);
    expect(ops).toHaveLength(1);
    if (ops[0].type === 'update') {
      expect(ops[0].hunks).toHaveLength(2);
      expect(ops[0].hunks[0].contextHeader).toBe('function foo');
      expect(ops[0].hunks[1].contextHeader).toBe('function bar');
    }
  });

  it('should parse Move File operation', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/old.ts',
      '*** Move to: src/new.ts',
      '@@ ',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 3;',
      '*** End Patch',
    ].join('\n');

    const ops = parsePatch(input);
    expect(ops).toHaveLength(1);
    if (ops[0].type === 'update') {
      expect(ops[0].path).toBe('src/old.ts');
      expect(ops[0].moveTo).toBe('src/new.ts');
    }
  });

  it('should parse multi-file patch', () => {
    const input = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+// new file',
      '*** Delete File: src/old.ts',
      '*** Update File: src/main.ts',
      '@@ ',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 3;',
      '*** End Patch',
    ].join('\n');

    const ops = parsePatch(input);
    expect(ops).toHaveLength(3);
    expect(ops[0].type).toBe('add');
    expect(ops[1].type).toBe('delete');
    expect(ops[2].type).toBe('update');
  });

  it('should parse hunk with only additions (no context or removals)', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/main.ts',
      '@@ function foo',
      '+  // new line 1',
      '+  // new line 2',
      '*** End Patch',
    ].join('\n');

    const ops = parsePatch(input);
    expect(ops).toHaveLength(1);
    if (ops[0].type === 'update') {
      expect(ops[0].hunks[0].lines).toHaveLength(2);
      expect(ops[0].hunks[0].lines[0].type).toBe('add');
      expect(ops[0].hunks[0].lines[1].type).toBe('add');
    }
  });

  it('should error on missing Begin Patch', () => {
    const input = [
      '*** Update File: src/main.ts',
      '@@ ',
      ' const x = 1;',
      '*** End Patch',
    ].join('\n');

    expect(() => parsePatch(input)).toThrow(PatchParseError);
  });

  it('should error on missing End Patch', () => {
    const input = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+content',
    ].join('\n');

    expect(() => parsePatch(input)).toThrow(PatchParseError);
    expect(() => parsePatch(input)).toThrow(/End Patch/);
  });

  it('should error on empty patch (no operations)', () => {
    const input = '*** Begin Patch\n*** End Patch';
    expect(() => parsePatch(input)).toThrow(PatchParseError);
  });

  it('should error on unexpected line in hunk body', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/main.ts',
      '@@ ',
      ' context line',
      'INVALID LINE',
      '*** End Patch',
    ].join('\n');

    expect(() => parsePatch(input)).toThrow(PatchParseError);
    expect(() => parsePatch(input)).toThrow(/unexpected line/);
  });

  it('should handle hunk header without context header text', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/main.ts',
      '@@',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 3;',
      '*** End Patch',
    ].join('\n');

    const ops = parsePatch(input);
    if (ops[0].type === 'update') {
      expect(ops[0].hunks[0].contextHeader).toBeUndefined();
    }
  });
});

// ============================================
// EXECUTOR TESTS
// ============================================

describe('applyPatchOperations', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = createTempDir();
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should create a new file with parent dirs', async () => {
    const ops: PatchOperation[] = [
      { type: 'add', path: 'deep/nested/file.ts', content: 'hello world' },
    ];

    const changed = await applyPatchOperations(ops, tempDir);
    expect(changed).toHaveLength(1);

    const content = await readFile(join(tempDir, 'deep/nested/file.ts'), 'utf-8');
    expect(content).toBe('hello world');
  });

  it('should delete an existing file', async () => {
    const filePath = join(tempDir, 'to-delete.ts');
    await writeFile(filePath, 'content');

    const ops: PatchOperation[] = [
      { type: 'delete', path: 'to-delete.ts' },
    ];

    await applyPatchOperations(ops, tempDir);

    await expect(stat(filePath)).rejects.toThrow();
  });

  it('should apply a hunk to an existing file', async () => {
    await writeFile(
      join(tempDir, 'main.ts'),
      'function foo() {\n  return 1;\n}\n'
    );

    const ops: PatchOperation[] = [
      {
        type: 'update',
        path: 'main.ts',
        hunks: [
          {
            lines: [
              { type: 'context', content: 'function foo() {' },
              { type: 'remove', content: '  return 1;' },
              { type: 'add', content: '  return 2;' },
              { type: 'context', content: '}' },
            ],
          },
        ],
      },
    ];

    await applyPatchOperations(ops, tempDir);

    const content = await readFile(join(tempDir, 'main.ts'), 'utf-8');
    expect(content).toBe('function foo() {\n  return 2;\n}\n');
  });

  it('should move a file', async () => {
    await writeFile(
      join(tempDir, 'old.ts'),
      'const x = 1;\nconst y = 2;\n'
    );

    const ops: PatchOperation[] = [
      {
        type: 'update',
        path: 'old.ts',
        moveTo: 'new.ts',
        hunks: [
          {
            lines: [
              { type: 'context', content: 'const x = 1;' },
              { type: 'remove', content: 'const y = 2;' },
              { type: 'add', content: 'const y = 3;' },
            ],
          },
        ],
      },
    ];

    await applyPatchOperations(ops, tempDir);

    const content = await readFile(join(tempDir, 'new.ts'), 'utf-8');
    expect(content).toBe('const x = 1;\nconst y = 3;\n');

    await expect(stat(join(tempDir, 'old.ts'))).rejects.toThrow();
  });

  it('should fail atomically when second operation is invalid', async () => {
    // First op: add a file (should succeed on its own)
    // Second op: delete a non-existent file (should fail)
    // Result: first file should NOT be created

    const ops: PatchOperation[] = [
      { type: 'add', path: 'new.ts', content: 'content' },
      { type: 'delete', path: 'nonexistent.ts' },
    ];

    await expect(applyPatchOperations(ops, tempDir)).rejects.toThrow(PatchApplyError);

    // The first file should NOT exist because atomicity requires all-or-nothing
    await expect(stat(join(tempDir, 'new.ts'))).rejects.toThrow();
  });

  it('should fail if Add targets an existing file', async () => {
    await writeFile(join(tempDir, 'exists.ts'), 'content');

    const ops: PatchOperation[] = [
      { type: 'add', path: 'exists.ts', content: 'new content' },
    ];

    await expect(applyPatchOperations(ops, tempDir)).rejects.toThrow(PatchApplyError);
    await expect(applyPatchOperations(ops, tempDir)).rejects.toThrow(/already exists/);
  });

  it('should fail if Delete targets a non-existent file', async () => {
    const ops: PatchOperation[] = [
      { type: 'delete', path: 'nonexistent.ts' },
    ];

    await expect(applyPatchOperations(ops, tempDir)).rejects.toThrow(PatchApplyError);
    await expect(applyPatchOperations(ops, tempDir)).rejects.toThrow(/not found/);
  });

  it('should fail if Update targets a non-existent file', async () => {
    const ops: PatchOperation[] = [
      {
        type: 'update',
        path: 'nonexistent.ts',
        hunks: [{ lines: [{ type: 'context', content: 'x' }] }],
      },
    ];

    await expect(applyPatchOperations(ops, tempDir)).rejects.toThrow(PatchApplyError);
    await expect(applyPatchOperations(ops, tempDir)).rejects.toThrow(/not found/);
  });

  it('should fail on ambiguous hunk match', async () => {
    await writeFile(
      join(tempDir, 'dup.ts'),
      'const x = 1;\nconst x = 1;\n'
    );

    const ops: PatchOperation[] = [
      {
        type: 'update',
        path: 'dup.ts',
        hunks: [
          {
            lines: [
              { type: 'context', content: 'const x = 1;' },
            ],
          },
        ],
      },
    ];

    await expect(applyPatchOperations(ops, tempDir)).rejects.toThrow(PatchApplyError);
    await expect(applyPatchOperations(ops, tempDir)).rejects.toThrow(/Ambiguous/);
  });

  it('should fail when hunk pattern not found', async () => {
    await writeFile(join(tempDir, 'file.ts'), 'const a = 1;\n');

    const ops: PatchOperation[] = [
      {
        type: 'update',
        path: 'file.ts',
        hunks: [
          {
            lines: [
              { type: 'context', content: 'const b = 2;' },
            ],
          },
        ],
      },
    ];

    await expect(applyPatchOperations(ops, tempDir)).rejects.toThrow(PatchApplyError);
    await expect(applyPatchOperations(ops, tempDir)).rejects.toThrow(/could not find pattern/);
  });

  it('should preserve exact whitespace in context matching', async () => {
    await writeFile(
      join(tempDir, 'ws.ts'),
      '  function foo() {\n    return 1;\n  }\n'
    );

    const ops: PatchOperation[] = [
      {
        type: 'update',
        path: 'ws.ts',
        hunks: [
          {
            lines: [
              { type: 'context', content: '  function foo() {' },
              { type: 'remove', content: '    return 1;' },
              { type: 'add', content: '    return 2;' },
              { type: 'context', content: '  }' },
            ],
          },
        ],
      },
    ];

    await applyPatchOperations(ops, tempDir);

    const content = await readFile(join(tempDir, 'ws.ts'), 'utf-8');
    expect(content).toBe('  function foo() {\n    return 2;\n  }\n');
  });
});

// ============================================
// TOOL EXECUTOR TESTS
// ============================================

describe('executeApplyPatch', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = createTempDir();
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should execute a valid patch from input arg', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: hello.ts',
      '+export const msg = "hello";',
      '*** End Patch',
    ].join('\n');

    const result = await executeApplyPatch(
      { input: patch },
      { workdirOverride: tempDir }
    );

    expect(result.isSuccess).toBe(true);
    expect(result.output).toContain('1 operation');

    const content = await readFile(join(tempDir, 'hello.ts'), 'utf-8');
    expect(content).toBe('export const msg = "hello";');
  });

  it('should return error for invalid patch', async () => {
    const result = await executeApplyPatch(
      { input: 'not a patch' },
      { workdirOverride: tempDir }
    );

    expect(result.isSuccess).toBe(false);
    expect(result.error).toContain('Patch failed');
  });

  it('should return error when no patch text provided', async () => {
    const result = await executeApplyPatch(
      { foo: 123 },
      { workdirOverride: tempDir }
    );

    expect(result.isSuccess).toBe(false);
    expect(result.error).toContain('No patch text');
  });
});
