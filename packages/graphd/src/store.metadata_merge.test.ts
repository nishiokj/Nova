import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { GraphStore } from './store.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (!path) continue;
    await rm(path, { recursive: true, force: true });
  }
});

describe('GraphStore.updateSessionMetadata', () => {
  it('replaces stateful arrays and appends event-log arrays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'graphd-store-merge-'));
    cleanupPaths.push(dir);
    const store = new GraphStore(join(dir, 'graphd.db'));
    try {
      store.initialize();
      store.createSession(
        'sess-1',
        'cockpit',
        process.cwd(),
        undefined,
        {
          paused_work_items: [{ workId: 'wk-1', status: 'pending' }],
          agent_events: [{ type: 'agent_message', request_id: 'req-1' }],
        }
      );

      store.updateSessionMetadata('sess-1', {
        paused_work_items: [{ workId: 'wk-2', status: 'resolved' }],
        agent_events: [{ type: 'agent_message', request_id: 'req-2' }],
      });

      const session = store.getSession('sess-1');
      expect(session).not.toBeNull();
      const metadata = session?.metadata ?? {};

      expect(Array.isArray(metadata.paused_work_items)).toBe(true);
      expect((metadata.paused_work_items as unknown[])).toEqual([
        { workId: 'wk-2', status: 'resolved' },
      ]);

      expect(Array.isArray(metadata.agent_events)).toBe(true);
      expect((metadata.agent_events as unknown[])).toHaveLength(2);
      expect((metadata.agent_events as Array<Record<string, unknown>>)[0]?.request_id).toBe('req-1');
      expect((metadata.agent_events as Array<Record<string, unknown>>)[1]?.request_id).toBe('req-2');
    } finally {
      store.close();
    }
  });
});
