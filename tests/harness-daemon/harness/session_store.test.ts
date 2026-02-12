import { existsSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import type { GraphDManager } from 'graphd';
import { ContextWindow } from 'context';
import type { ContextWindowSnapshot, MessageItem, FunctionCallOutputItem, FileContentItem } from 'types';
import { SessionStore, type HarnessLogger } from 'harness-daemon/harness/session_store.js';

const logger: HarnessLogger = {
  info: () => {},
  debug: () => {},
  warning: () => {},
  error: () => {},
};

const DISK_TEST_DIR = path.join(import.meta.dir, '__session_test_tmp__');

describe('SessionStore paused_work_items', () => {
  it('upserts and resolves paused work items idempotently', () => {
    const store = new SessionStore({
      sessionKey: 'session_test',
      maxTokens: 1000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: process.cwd(),
    });

    store.upsertPausedWorkItem({
      workId: 'work_1',
      agentType: 'standard',
      objective: 'Implement feature',
      reason: 'Needs escalation',
      escalationId: 'esc_1',
      timestamp: 100,
    });

    store.upsertPausedWorkItem({
      workId: 'work_1',
      agentType: 'standard',
      reason: 'Still waiting on escalation',
      escalationId: 'esc_1',
      timestamp: 200,
    });

    const [paused] = store.listPausedWorkItems();
    expect(paused.workId).toBe('work_1');
    expect(paused.status).toBe('pending');
    expect(paused.createdAt).toBe(100);
    expect(paused.updatedAt).toBe(200);
    expect(paused.reason).toContain('Still waiting');

    const resolved = store.resolvePausedWorkItem('work_1', 'Resolved by user', 300);
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolvedAt).toBe(300);

    const idempotent = store.resolvePausedWorkItem('work_1', 'Ignored', 400);
    expect(idempotent?.updatedAt).toBe(300);

    const cancelledAfterResolve = store.cancelPausedWorkItem('work_1', 'Should not cancel', 500);
    expect(cancelledAfterResolve?.status).toBe('resolved');
  });

  it('hydrates paused work items from GraphD metadata', () => {
    const fakeGraphd = {
      sessionGet: () => ({
        metadata: {
          paused_work_items: [
            {
              workId: 'work_2',
              agentType: 'explorer',
              objective: 'Investigate issue',
              reason: 'Escalated for decision',
              escalationId: 'esc_2',
              status: 'pending',
              createdAt: 10,
              updatedAt: 11,
            },
          ],
        },
      }),
      contextGet: () => ({}),
      sessionUpdateMetadata: () => ({ success: true }),
    } as unknown as GraphDManager;

    const store = new SessionStore({
      sessionKey: 'session_hydrate',
      maxTokens: 1000,
      graphd: fakeGraphd,
      isGraphDReady: () => true,
      logger,
      workingDir: process.cwd(),
    });

    store.getContext();

    const items = store.listPausedWorkItems();
    expect(items.length).toBe(1);
    expect(items[0].workId).toBe('work_2');
    expect(items[0].agentType).toBe('explorer');
    expect(items[0].escalationId).toBe('esc_2');
    expect(items[0].status).toBe('pending');
  });
});

describe('SessionStore model selections', () => {
  it('clears one model selection and persists metadata', () => {
    const metadataUpdates: Record<string, unknown>[] = [];
    const fakeGraphd = {
      sessionGet: () => ({ metadata: {} }),
      contextGet: () => ({}),
      sessionUpdateMetadata: (_sessionKey: string, patch: Record<string, unknown>) => {
        metadataUpdates.push(patch);
        return { success: true };
      },
    } as unknown as GraphDManager;

    const store = new SessionStore({
      sessionKey: 'session_model_clear_one',
      maxTokens: 1000,
      graphd: fakeGraphd,
      isGraphDReady: () => true,
      logger,
      workingDir: process.cwd(),
    });

    store.setModelSelection('standard', { provider: 'openai', model: 'gpt-4o' });
    const latestSetPatch = metadataUpdates.at(-1) as { model_selections?: Record<string, unknown> } | undefined;
    expect(latestSetPatch?.model_selections?.standard).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });

    const removed = store.clearModelSelection('standard');
    expect(removed).toBe(true);
    expect(metadataUpdates.at(-1)?.model_selections).toEqual({});
  });

  it('clearModelSelections persists empty selections once', () => {
    const metadataUpdates: Record<string, unknown>[] = [];
    const fakeGraphd = {
      sessionGet: () => ({ metadata: {} }),
      contextGet: () => ({}),
      sessionUpdateMetadata: (_sessionKey: string, patch: Record<string, unknown>) => {
        metadataUpdates.push(patch);
        return { success: true };
      },
    } as unknown as GraphDManager;

    const store = new SessionStore({
      sessionKey: 'session_model_clear_all',
      maxTokens: 1000,
      graphd: fakeGraphd,
      isGraphDReady: () => true,
      logger,
      workingDir: process.cwd(),
    });

    store.setModelSelection('standard', { provider: 'openai', model: 'gpt-4o' });
    store.setModelSelection('planner', { provider: 'openai', model: 'gpt-4o-mini' });
    const updateCountBeforeClear = metadataUpdates.length;

    store.clearModelSelections();
    expect(metadataUpdates.length).toBe(updateCountBeforeClear + 1);
    expect(metadataUpdates.at(-1)?.model_selections).toEqual({});

    store.clearModelSelections();
    expect(metadataUpdates.length).toBe(updateCountBeforeClear + 1);
  });
});

// ============================================
// DISK-BACKED CONTEXT INTEGRATION
// ============================================

describe('SessionStore disk-backed context', () => {
  beforeEach(() => {
    if (existsSync(DISK_TEST_DIR)) {
      rmSync(DISK_TEST_DIR, { recursive: true });
    }
  });
  afterEach(() => {
    if (existsSync(DISK_TEST_DIR)) {
      rmSync(DISK_TEST_DIR, { recursive: true });
    }
  });

  it('getContext creates disk-backed ContextWindow that writes to disk', () => {
    const store = new SessionStore({
      sessionKey: 'disk-test-1',
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx = store.getContext();

    // filePath should be set
    expect(ctx.filePath).not.toBeNull();
    expect(ctx.filePath).toContain('.haiku/sessions');
    expect(ctx.filePath).toContain('disk-test-1');
    expect(ctx.filePath!.endsWith('context.md')).toBe(true);

    // File should exist on disk
    expect(existsSync(ctx.filePath!)).toBe(true);
  });

  it('mutations write through to disk', () => {
    const store = new SessionStore({
      sessionKey: 'disk-wt',
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx = store.getContext();
    ctx.addMessage('user', 'Hello from the harness');
    ctx.addFunctionCall('call-1', 'Read', { path: '/foo.ts' });
    ctx.addFunctionCallOutput('call-1', 'export const foo = 42;');

    const content = readFileSync(ctx.filePath!, 'utf-8');
    expect(content).toContain('### message:user');
    expect(content).toContain('Hello from the harness');
    expect(content).toContain('### function_call');
    expect(content).toContain('@name Read');
    expect(content).toContain('### function_call_output');
    expect(content).toContain('export const foo = 42;');
  });

  it('second getContext call returns cached (same) instance', () => {
    const store = new SessionStore({
      sessionKey: 'disk-cache',
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx1 = store.getContext();
    ctx1.addMessage('user', 'First');

    const ctx2 = store.getContext();
    expect(ctx2).toBe(ctx1); // Same instance
    expect(ctx2.items).toHaveLength(1);
  });

  it('clearContext creates fresh disk-backed context at same path', () => {
    const store = new SessionStore({
      sessionKey: 'disk-clear',
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx1 = store.getContext();
    ctx1.addMessage('user', 'Old message');
    const firstPath = ctx1.filePath;

    const ctx2 = store.clearContext();
    expect(ctx2.filePath).toBe(firstPath); // Same path
    expect(ctx2.items).toHaveLength(0); // Fresh context

    // Disk file should be empty (no items)
    const content = readFileSync(ctx2.filePath!, 'utf-8');
    expect(content).not.toContain('### message');
    expect(content).toContain('session: disk-clear');
  });

  it('new SessionStore on same workingDir loads persisted items from disk', () => {
    const sessionKey = 'disk-reload';

    // First store: create context and add items
    const store1 = new SessionStore({
      sessionKey,
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx1 = store1.getContext();
    ctx1.addMessage('user', 'Persisted message');
    ctx1.addFileContent('/src/app.ts', 'const app = express();', 'typescript');
    ctx1.addFunctionCall('c1', 'Grep', { pattern: 'TODO' });
    ctx1.addFunctionCallOutput('c1', 'Found 3 TODOs');

    // Close first store (simulates process end)
    store1.close();

    // Second store: same workingDir, same sessionKey — should reload from disk
    const store2 = new SessionStore({
      sessionKey,
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx2 = store2.getContext();

    // Items should be reloaded from disk
    expect(ctx2.items).toHaveLength(4);

    const msg = ctx2.items[0] as MessageItem;
    expect(msg.type).toBe('message');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Persisted message');

    const fc = ctx2.items[1] as FileContentItem;
    expect(fc.type).toBe('file_content');
    expect(fc.path).toBe('/src/app.ts');
    expect(fc.content).toBe('const app = express();');
    expect(fc.language).toBe('typescript');

    // readFiles should be rebuilt from disk
    expect(ctx2.hasReadFile('/src/app.ts')).toBe(true);
  });

  it('content with --- survives the full SessionStore roundtrip', () => {
    const sessionKey = 'disk-dashes';

    const store1 = new SessionStore({
      sessionKey,
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx1 = store1.getContext();
    ctx1.addFunctionCallOutput('c1', 'line1\n---\nline2\n---\nline3');
    ctx1.addMessage('assistant', '---');
    ctx1.addFileContent('/x.md', '---\ntitle: test\n---\ncontent');
    store1.close();

    const store2 = new SessionStore({
      sessionKey,
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx2 = store2.getContext();
    expect(ctx2.items).toHaveLength(3);

    expect((ctx2.items[0] as FunctionCallOutputItem).output).toBe('line1\n---\nline2\n---\nline3');
    expect((ctx2.items[1] as MessageItem).content).toBe('---');
    expect((ctx2.items[2] as FileContentItem).content).toBe('---\ntitle: test\n---\ncontent');
  });

  it('hydrateFromSnapshot writes snapshot to disk', () => {
    const store = new SessionStore({
      sessionKey: 'disk-hydrate',
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    // Create a snapshot from another context
    const sourceCtx = new ContextWindow('disk-hydrate', 100_000);
    sourceCtx.addMessage('user', 'Hydrated message');
    sourceCtx.addMessage('assistant', 'Hydrated response');
    const snapshot = sourceCtx.serialize() as ContextWindowSnapshot;

    store.hydrateFromSnapshot(snapshot);

    const ctx = store.getContext();
    expect(ctx.items).toHaveLength(2);
    expect(ctx.filePath).not.toBeNull();
    expect(existsSync(ctx.filePath!)).toBe(true);

    // Verify disk file has the items
    const content = readFileSync(ctx.filePath!, 'utf-8');
    expect(content).toContain('Hydrated message');
    expect(content).toContain('Hydrated response');
  });

  it('GraphD hydration path also produces disk-backed context', () => {
    const sourceCtx = new ContextWindow('disk-graphd', 100_000);
    sourceCtx.addMessage('user', 'From GraphD');
    const snapshot = sourceCtx.serialize();

    const fakeGraphd = {
      sessionGet: () => ({ metadata: {} }),
      contextGet: () => ({ snapshot: { context: snapshot } }),
      sessionUpdateMetadata: () => ({ success: true }),
    } as unknown as GraphDManager;

    const store = new SessionStore({
      sessionKey: 'disk-graphd',
      maxTokens: 100_000,
      graphd: fakeGraphd,
      isGraphDReady: () => true,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx = store.getContext();
    expect(ctx.filePath).not.toBeNull();
    expect(ctx.items).toHaveLength(1);
    expect((ctx.items[0] as MessageItem).content).toBe('From GraphD');

    // Disk file should exist with the hydrated content
    expect(existsSync(ctx.filePath!)).toBe(true);
    const content = readFileSync(ctx.filePath!, 'utf-8');
    expect(content).toContain('From GraphD');
  });
});
