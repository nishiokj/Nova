import { describe, expect, it } from 'bun:test';
import type { SessionFile } from '../entity_subgraph.js';
import { buildSessionArchitectureContext, deriveActiveConcerns } from './cockpit_architecture.js';

describe('cockpit architecture helpers', () => {
  it('normalizes paths and keeps edited precedence', () => {
    const files: SessionFile[] = [
      { filepath: './packages/app/src/index.ts', status: 'read' },
      { filepath: 'packages/app/src/index.ts', status: 'edited' },
      { filepath: '/repo/packages/app/src/utils.ts', status: 'read' },
      { filepath: 'packages/app/src/utils.ts', status: 'edited' },
      { filepath: 'packages/app/src/helper.ts', status: 'read' },
    ];

    const context = buildSessionArchitectureContext(files, '/repo');

    expect(context.summary.totalFiles).toBe(3);
    expect(context.summary.editedFiles).toBe(2);
    expect(context.summary.readFiles).toBe(1);
    expect(context.touchedFiles.get('packages/app/src/index.ts')).toBe('edited');
    expect(context.touchedFiles.get('packages/app/src/utils.ts')).toBe('edited');
    expect(context.touchedFiles.get('packages/app/src/helper.ts')).toBe('read');
  });

  it('derives active concerns by weighted touch score', () => {
    const touched = new Map<string, 'read' | 'edited'>([
      ['packages/a/one.ts', 'edited'],
      ['packages/a/two.ts', 'read'],
      ['packages/b/one.ts', 'read'],
    ]);

    const concerns = deriveActiveConcerns([
      { file_path: 'packages/a/one.ts', concern_id: 'concern.a', label: 'alpha', size_files: 10 },
      { file_path: 'packages/a/two.ts', concern_id: 'concern.a', label: 'alpha', size_files: 10 },
      { file_path: 'packages/b/one.ts', concern_id: 'concern.b', label: 'beta', size_files: 4 },
    ], touched, 5);

    expect(concerns).toHaveLength(2);
    expect(concerns[0].concernId).toBe('concern.a');
    expect(concerns[0].activeScore).toBe(3); // edited(2) + read(1)
    expect(concerns[0].touchRatio).toBe(0.2);
    expect(concerns[1].concernId).toBe('concern.b');
    expect(concerns[1].activeScore).toBe(1);
  });
});
