import { describe, expect, it } from 'bun:test';
import { extractSessionFiles } from './entity_subgraph.js';

describe('extractSessionFiles', () => {
  it('normalizes absolute paths under working dir and preserves edited precedence', () => {
    const events = [
      {
        type: 'tool_call',
        data: {
          tool_name: 'Read',
          arguments: { path: '/repo/packages/app/src/a.ts' },
        },
      },
      {
        type: 'tool_call',
        data: {
          tool_name: 'Edit',
          phase: 'completed',
          success: true,
          arguments: { path: './packages/app/src/a.ts' },
        },
      },
      {
        type: 'tool_call',
        data: {
          tool_name: 'Write',
          phase: 'completed',
          success: true,
          arguments: { path: '/repo/packages/app/src/b.ts' },
        },
      },
    ];

    const files = extractSessionFiles(events, { workingDir: '/repo' });
    const statusByPath = new Map(files.map((f) => [f.filepath, f.status]));

    expect(statusByPath.get('packages/app/src/a.ts')).toBe('edited');
    expect(statusByPath.get('packages/app/src/b.ts')).toBe('edited');
  });

  it('ignores failed or non-completed edit/write calls', () => {
    const events = [
      {
        type: 'tool_call',
        data: {
          tool_name: 'Edit',
          phase: 'starting',
          success: true,
          arguments: { path: 'src/a.ts' },
        },
      },
      {
        type: 'tool_call',
        data: {
          tool_name: 'Write',
          phase: 'completed',
          success: false,
          arguments: { path: 'src/b.ts' },
        },
      },
      {
        type: 'tool_call',
        data: {
          tool_name: 'Read',
          phase: 'starting',
          arguments: { path: 'src/a.ts' },
        },
      },
    ];

    const files = extractSessionFiles(events);
    expect(files).toEqual([{ filepath: 'src/a.ts', status: 'read' }]);
  });

  it('filters extracted files by workItemId when provided', () => {
    const events = [
      {
        type: 'tool_call',
        work_item_id: 'work-1',
        data: {
          tool_name: 'Read',
          arguments: { path: 'src/a.ts' },
        },
      },
      {
        type: 'tool_call',
        work_item_id: 'work-2',
        data: {
          tool_name: 'Write',
          phase: 'completed',
          success: true,
          arguments: { path: 'src/b.ts' },
        },
      },
      {
        type: 'tool_call',
        data: {
          tool_name: 'Read',
          arguments: { path: 'src/c.ts' },
        },
      },
    ];

    const files = extractSessionFiles(events, { workItemId: 'work-2' });
    expect(files).toEqual([{ filepath: 'src/b.ts', status: 'edited' }]);
  });

  it('accepts workId variants when filtering by work item', () => {
    const events = [
      {
        type: 'tool_call',
        workId: 'work-A',
        data: {
          tool_name: 'Read',
          arguments: { path: 'src/a.ts' },
        },
      },
      {
        type: 'tool_call',
        data: {
          workId: 'work-B',
          tool_name: 'Write',
          phase: 'completed',
          success: true,
          arguments: { path: 'src/b.ts' },
        },
      },
    ];

    expect(extractSessionFiles(events, { workItemId: 'work-A' })).toEqual([
      { filepath: 'src/a.ts', status: 'read' },
    ]);
    expect(extractSessionFiles(events, { workItemId: 'work-B' })).toEqual([
      { filepath: 'src/b.ts', status: 'edited' },
    ]);
  });
});
