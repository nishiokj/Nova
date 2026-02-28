import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  createHook,
  getHookDefinition,
  loadHookDefinitions,
  normalizeHookTrigger,
  updateHook,
} from 'harness-daemon/harness/skills_loader.js';

describe('skills_loader trigger normalization', () => {
  it('normalizes legacy and canonical trigger names', () => {
    expect(normalizeHookTrigger('PreToolUse')).toBe('pre_tool_use');
    expect(normalizeHookTrigger('workitem_created')).toBe('workitem_created');
    expect(normalizeHookTrigger('not_a_real_event')).toBeNull();
  });

  it('stores normalized triggers when creating legacy hook definitions', () => {
    const hooksDir = mkdtempSync(path.join(os.tmpdir(), 'hooks-create-'));
    try {
      const created = createHook(hooksDir, {
        name: 'Legacy Trigger Hook',
        trigger: 'PostToolUse',
        hooks: [{ type: 'command', command: 'echo ok' }],
      });

      expect(created.success).toBe(true);
      expect(created.id).toBe('legacy-trigger-hook');

      const raw = JSON.parse(
        readFileSync(path.join(hooksDir, `${created.id}.json`), 'utf-8')
      ) as { trigger?: string };
      expect(raw.trigger).toBe('post_tool_use');

      const full = getHookDefinition(hooksDir, created.id);
      expect(full?.trigger).toBe('post_tool_use');

      const stubs = loadHookDefinitions(hooksDir);
      expect(stubs).toHaveLength(1);
      expect(stubs[0]?.trigger).toBe('post_tool_use');
    } finally {
      rmSync(hooksDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid trigger updates', () => {
    const hooksDir = mkdtempSync(path.join(os.tmpdir(), 'hooks-update-'));
    try {
      const created = createHook(hooksDir, {
        name: 'Valid Hook',
        trigger: 'pre_tool_use',
        hooks: [{ type: 'command', command: 'echo ok' }],
      });
      expect(created.success).toBe(true);

      const result = updateHook(hooksDir, created.id, {
        trigger: 'invalid_event' as never,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid hook trigger 'invalid_event'");
    } finally {
      rmSync(hooksDir, { recursive: true, force: true });
    }
  });

  it('treats persisted hooks with unknown triggers as invalid definitions', () => {
    const hooksDir = mkdtempSync(path.join(os.tmpdir(), 'hooks-invalid-'));
    try {
      writeFileSync(
        path.join(hooksDir, 'bad.json'),
        JSON.stringify({
          id: 'bad',
          name: 'Bad Hook',
          enabled: true,
          trigger: 'DefinitelyNotValid',
          priority: 0,
          hooks: [{ type: 'command', command: 'echo ok' }],
        }),
        'utf-8'
      );

      expect(getHookDefinition(hooksDir, 'bad')).toBeNull();
      const stubs = loadHookDefinitions(hooksDir);
      expect(stubs).toHaveLength(1);
      expect(stubs[0]?.trigger).toBe('DefinitelyNotValid');
    } finally {
      rmSync(hooksDir, { recursive: true, force: true });
    }
  });
});
