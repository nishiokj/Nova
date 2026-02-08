import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

interface MockTemplateRow {
  id: string;
  name: string;
  description: string;
  specs: string | unknown[];
}

const postgresMockState: {
  templates: MockTemplateRow[];
  queries: Array<{ text: string; values: unknown[] }>;
} = {
  templates: [],
  queries: [],
};

mock.module('postgres', () => ({
  default: () => {
    const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join(' ').replace(/\s+/g, ' ').trim();
      postgresMockState.queries.push({ text, values });
      const normalized = text.toLowerCase();

      if (!normalized.includes('from workitem_templates')) {
        return [];
      }

      if (normalized.includes('where id =')) {
        const requestedId = String(values[0] ?? '');
        const row = postgresMockState.templates.find((template) => template.id === requestedId);
        return row ? [row] : [];
      }

      if (normalized.includes('where lower(name) = lower(')) {
        const requestedName = String(values[0] ?? '').toLowerCase();
        const row = postgresMockState.templates.find((template) => template.name.toLowerCase() === requestedName);
        return row ? [row] : [];
      }

      return [...postgresMockState.templates];
    };
    (sql as Record<string, unknown>).array = (value: unknown[]) => value;
    (sql as Record<string, unknown>).end = async () => {};
    return sql;
  },
}));

import { handleControlPlaneRequest, type ControlPlaneContext } from './control_plane_routes.js';

interface DispatchCall {
  sessionKey: string;
  message: string;
  options?: { context?: string; metadata?: Record<string, unknown> };
}

interface TestHarness {
  ctx: ControlPlaneContext;
  dispatchCalls: DispatchCall[];
  metadataUpdates: Record<string, unknown>[];
  permissionUpdates: Array<{
    sessionKey: string;
    workingDir?: string;
    input: Record<string, unknown>;
  }>;
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  ended = false;
  body = '';
  headers = new Map<string, string | number | readonly string[]>();

  setHeader(name: string, value: string | number | readonly string[]): void {
    this.headers.set(name.toLowerCase(), value);
  }

  writeHead(statusCode: number, headers?: Record<string, string | number | readonly string[]>): this {
    this.statusCode = statusCode;
    if (headers) {
      for (const [name, value] of Object.entries(headers)) {
        this.setHeader(name, value);
      }
    }
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) {
      this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    }
    this.ended = true;
    this.emit('finish');
    return this;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createSessionRow(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionKey: 'sess-1',
    clientType: 'cockpit',
    workingDir: process.cwd(),
    status: 'active',
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    metadata,
  };
}

function createHarness(options?: {
  sessionMetadata?: Record<string, unknown>;
  historyCount?: number;
}): TestHarness {
  const dispatchCalls: DispatchCall[] = [];
  const metadataUpdates: Record<string, unknown>[] = [];
  const permissionUpdates: Array<{
    sessionKey: string;
    workingDir?: string;
    input: Record<string, unknown>;
  }> = [];

  const graphd = {
    sessionGet: () => ({ session: createSessionRow(options?.sessionMetadata ?? {}) }),
    messagesGet: () => ({
      messages: Array.from({ length: options?.historyCount ?? 0 }, (_, index) => ({
        id: index + 1,
        role: 'user',
        content: `message-${index + 1}`,
        createdAt: Date.now(),
      })),
    }),
    sessionUpdateMetadata: (_sessionKey: string, patch: Record<string, unknown>) => {
      metadataUpdates.push(patch);
      return { success: true };
    },
  };

  const ctx: ControlPlaneContext = {
    graphd: graphd as unknown as ControlPlaneContext['graphd'],
    isGraphDReady: () => true,
    workingDir: process.cwd(),
    dispatchSessionInput: (sessionKey, message, optionsArg) => {
      dispatchCalls.push({ sessionKey, message, options: optionsArg });
      return { success: true, requestId: 'req-123', queued: false };
    },
    updateSessionPermissionState: (sessionKey, input, optionsArg) => {
      permissionUpdates.push({
        sessionKey,
        input: { ...input } as Record<string, unknown>,
        ...(typeof optionsArg?.workingDir === 'string' ? { workingDir: optionsArg.workingDir } : {}),
      });
      return {
        persistent: { allow: [], deny: [] },
        sessionGrants: [],
        sessionDenials: [],
        dangerousMode: input.dangerousMode === true,
        allowOutsideRoot: input.allowOutsideRoot === true,
        webSearchEnabled: input.webSearchEnabled !== false,
        writesNoDeletes: input.writesNoDeletes === true,
        ...(Array.isArray(input.restrictWriteToPaths) ? { restrictWriteToPaths: input.restrictWriteToPaths } : {}),
      };
    },
  };

  return { ctx, dispatchCalls, metadataUpdates, permissionUpdates };
}

async function waitForFinish(res: MockResponse, timeoutMs = 500): Promise<void> {
  if (res.ended) return;
  await Promise.race([
    new Promise<void>((resolve) => {
      res.once('finish', () => resolve());
    }),
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for response to finish')), timeoutMs);
    }),
  ]);
}

async function invokeRoute(input: {
  method: string;
  url: string;
  ctx: ControlPlaneContext;
  body?: Record<string, unknown>;
}): Promise<{ handled: boolean; statusCode: number; json: Record<string, unknown> | null }> {
  const req = new PassThrough() as unknown as IncomingMessage;
  const reqMutable = req as unknown as {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  reqMutable.method = input.method;
  reqMutable.url = input.url;
  reqMutable.headers = { 'content-type': 'application/json' };

  const res = new MockResponse();
  const handled = handleControlPlaneRequest(
    req as IncomingMessage,
    res as unknown as ServerResponse,
    input.ctx
  );

  queueMicrotask(() => {
    if (input.body !== undefined) {
      (req as unknown as PassThrough).write(JSON.stringify(input.body));
    }
    (req as unknown as PassThrough).end();
  });

  await waitForFinish(res);

  let parsed: Record<string, unknown> | null = null;
  if (res.body.trim().length > 0) {
    const candidate = JSON.parse(res.body) as unknown;
    parsed = isRecord(candidate) ? candidate : null;
  }

  return {
    handled,
    statusCode: res.statusCode,
    json: parsed,
  };
}

describe('control-plane cockpit session message routes', () => {
  const originalDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://mock.local/test';
    postgresMockState.templates = [];
    postgresMockState.queries = [];
  });

  afterEach(() => {
    if (typeof originalDbUrl === 'string') {
      process.env.DATABASE_URL = originalDbUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    postgresMockState.templates = [];
    postgresMockState.queries = [];
  });

  it('attaches markdown context and dispatches message without template handoff', async () => {
    const harness = createHarness();
    const result = await invokeRoute({
      method: 'POST',
      url: '/control-plane/cockpit/session/sess-1/message',
      ctx: harness.ctx,
      body: {
        message: 'Summarize this note',
        markdownContext: {
          content: '# Notes\n\nhello',
          workspaceScope: 'global',
          isDirty: true,
          metadata: { documentType: 'note' },
        },
      },
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.json?.success).toBe(true);
    expect(result.json?.workflowTemplateApplied).toBe(false);
    expect(result.json?.markdownContextAttached).toBe(true);

    expect(harness.dispatchCalls).toHaveLength(1);
    expect(harness.dispatchCalls[0].sessionKey).toBe('sess-1');
    expect(harness.dispatchCalls[0].message).toBe('Summarize this note');
    expect(typeof harness.dispatchCalls[0].options?.context).toBe('string');
    expect(harness.dispatchCalls[0].options?.context).toContain('Control-plane active markdown context:');
    expect(harness.dispatchCalls[0].options?.context).toContain('scopeMode: session');
    expect(harness.dispatchCalls[0].options?.context).toContain('isDraft: true');
    expect(harness.dispatchCalls[0].options?.metadata?.cockpit_handoff_spec).toBeUndefined();

    expect(harness.permissionUpdates).toHaveLength(1);
    expect(harness.permissionUpdates[0].sessionKey).toBe('sess-1');
    expect(harness.permissionUpdates[0].input.dangerousMode).toBe(false);
    expect(harness.permissionUpdates[0].input.allowOutsideRoot).toBe(false);
    expect(Array.isArray(harness.permissionUpdates[0].input.restrictWriteToPaths)).toBe(true);

    expect(harness.metadataUpdates).toHaveLength(1);
    expect(isRecord(harness.metadataUpdates[0].cockpit_active_markdown)).toBe(true);
    const activeMarkdown = harness.metadataUpdates[0].cockpit_active_markdown;
    if (!isRecord(activeMarkdown)) {
      throw new Error('Expected cockpit_active_markdown metadata record');
    }
    expect(activeMarkdown.isDraft).toBe(true);
    expect(typeof activeMarkdown.writeTargetPath).toBe('string');
    expect(String(activeMarkdown.writeTargetPath)).toContain(`${process.cwd()}/.cockpit/markdown/.drafts/session-sess-1/`);
    expect(String(activeMarkdown.writeTargetPath)).toMatch(/\.md$/);
  });

  it('reuses client draftId for unsaved markdown context', async () => {
    const harness = createHarness();
    const result = await invokeRoute({
      method: 'POST',
      url: '/control-plane/cockpit/session/sess-1/message',
      ctx: harness.ctx,
      body: {
        message: 'Keep editing this draft',
        markdownContext: {
          content: '# Draft',
          metadata: {
            draftId: 'draft-abc-123',
          },
        },
      },
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.json?.success).toBe(true);
    expect(harness.metadataUpdates).toHaveLength(1);
    const activeMarkdown = harness.metadataUpdates[0].cockpit_active_markdown;
    if (!isRecord(activeMarkdown)) {
      throw new Error('Expected cockpit_active_markdown metadata record');
    }
    expect(activeMarkdown.isDraft).toBe(true);
    expect(activeMarkdown.draftId).toBe('draft-abc-123');
    expect(typeof activeMarkdown.writeTargetPath).toBe('string');
    expect(String(activeMarkdown.writeTargetPath)).toContain('draft-abc-123.md');
  });

  it('respects global markdown scope and includes an explicit write target in context', async () => {
    const harness = createHarness();
    const result = await invokeRoute({
      method: 'POST',
      url: '/control-plane/cockpit/session/sess-1/message',
      ctx: harness.ctx,
      body: {
        message: 'Please update this document',
        markdownContext: {
          path: 'notes/todo.md',
          content: '# Todo\n\n- [ ] Ship fix',
          workspaceScope: 'global',
        },
      },
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.json?.success).toBe(true);
    expect(result.json?.markdownContextAttached).toBe(true);

    expect(harness.dispatchCalls).toHaveLength(1);
    const contextText = harness.dispatchCalls[0].options?.context ?? '';
    expect(contextText).toContain('scopeMode: global');
    expect(contextText).toContain('workspacePath: .cockpit/markdown/notes/todo.md');
    expect(contextText).toContain('If the user requests document edits, persist changes to writeTargetPath/absolutePath above');

    expect(harness.metadataUpdates).toHaveLength(1);
    const activeMarkdown = harness.metadataUpdates[0].cockpit_active_markdown;
    expect(isRecord(activeMarkdown)).toBe(true);
    if (!isRecord(activeMarkdown)) {
      throw new Error('Expected cockpit_active_markdown metadata record');
    }
    expect(activeMarkdown.scopeMode).toBe('global');
    expect(activeMarkdown.scopeSessionKey).toBeNull();
    expect(typeof activeMarkdown.writeTargetPath).toBe('string');
    expect(String(activeMarkdown.writeTargetPath)).toContain('.cockpit/markdown/notes/todo.md');
  });

  it('respects project markdown scope and targets the real project directory', async () => {
    const harness = createHarness();
    const projectRoot = await mkdtemp(join(tmpdir(), 'cockpit-project-scope-'));
    try {
      const result = await invokeRoute({
        method: 'POST',
        url: '/control-plane/cockpit/session/sess-1/message',
        ctx: harness.ctx,
        body: {
          message: 'Please edit this project document',
          markdownContext: {
            path: 'docs/plan.md',
            content: '# Plan\n\n- [ ] Ship',
            workspaceScope: 'project',
            projectPath: projectRoot,
          },
        },
      });

      expect(result.handled).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.json?.success).toBe(true);
      expect(result.json?.markdownContextAttached).toBe(true);

      expect(harness.dispatchCalls).toHaveLength(1);
      const contextText = harness.dispatchCalls[0].options?.context ?? '';
      expect(contextText).toContain('scopeMode: project');
      expect(contextText).toContain('workspacePath: docs/plan.md');
      expect(contextText).not.toContain('.cockpit/markdown/docs/plan.md');

      expect(harness.metadataUpdates).toHaveLength(1);
      const activeMarkdown = harness.metadataUpdates[0].cockpit_active_markdown;
      expect(isRecord(activeMarkdown)).toBe(true);
      if (!isRecord(activeMarkdown)) {
        throw new Error('Expected cockpit_active_markdown metadata record');
      }
      expect(activeMarkdown.scopeMode).toBe('project');
      expect(activeMarkdown.scopeProjectPath).toBe(projectRoot);
      expect(typeof activeMarkdown.writeTargetPath).toBe('string');
      expect(String(activeMarkdown.writeTargetPath)).toBe(join(projectRoot, 'docs/plan.md'));
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('materializes unsaved project-scope markdown into project draft namespace', async () => {
    const harness = createHarness();
    const projectRoot = await mkdtemp(join(tmpdir(), 'cockpit-project-draft-'));
    try {
      const result = await invokeRoute({
        method: 'POST',
        url: '/control-plane/cockpit/session/sess-1/message',
        ctx: harness.ctx,
        body: {
          message: 'Work on this unsaved project draft',
          markdownContext: {
            content: '# Project Draft',
            workspaceScope: 'project',
            projectPath: projectRoot,
            metadata: {
              draftId: 'project-draft-001',
            },
          },
        },
      });

      expect(result.handled).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.json?.success).toBe(true);
      expect(harness.metadataUpdates).toHaveLength(1);
      const activeMarkdown = harness.metadataUpdates[0].cockpit_active_markdown;
      if (!isRecord(activeMarkdown)) {
        throw new Error('Expected cockpit_active_markdown metadata record');
      }
      expect(activeMarkdown.scopeMode).toBe('project');
      expect(activeMarkdown.scopeProjectPath).toBe(projectRoot);
      expect(activeMarkdown.isDraft).toBe(true);
      expect(activeMarkdown.draftId).toBe('project-draft-001');
      expect(typeof activeMarkdown.writeTargetPath).toBe('string');
      expect(String(activeMarkdown.writeTargetPath)).toBe(
        join(projectRoot, '.cockpit/drafts/project/project-draft-001.md')
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('loads template and injects cockpit_handoff_spec for first workflow message', async () => {
    postgresMockState.templates = [
      {
        id: 'tpl-alpha',
        name: 'Ship API',
        description: 'Roll out API changes',
        specs: JSON.stringify([
          {
            id: 'design',
            objective: 'Design endpoint changes',
            agent: 'standard',
            dependencies: [],
            domain: 'backend',
            targetPaths: ['src/api/routes.ts'],
          },
          {
            id: 'tests',
            objective: 'Add coverage',
            agent: 'standard',
            dependencies: ['design'],
            targetPaths: ['src/api/routes.test.ts'],
          },
        ]),
      },
    ];

    const harness = createHarness();
    const result = await invokeRoute({
      method: 'POST',
      url: '/control-plane/cockpit/session/sess-1/message',
      ctx: harness.ctx,
      body: {
        message: 'Implement this workflow now',
        markdownContext: {
          path: 'plans/ship-api.md',
          content: [
            '---',
            'type: workflow',
            'template: "  Ship API  "',
            '---',
            '# Workflow',
          ].join('\n'),
          metadata: { documentType: 'workflow' },
        },
      },
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.json?.success).toBe(true);
    expect(result.json?.workflowTemplateApplied).toBe(true);
    expect(result.json?.workflowTemplate).toEqual({ id: 'tpl-alpha', name: 'Ship API' });

    expect(harness.dispatchCalls).toHaveLength(1);
    const metadata = harness.dispatchCalls[0].options?.metadata ?? {};
    expect(isRecord(metadata.cockpit_handoff_spec)).toBe(true);
    const handoffSpec = metadata.cockpit_handoff_spec as Record<string, unknown>;
    expect(handoffSpec.goal).toBe('Implement this workflow now');
    expect(Array.isArray(handoffSpec.workItems)).toBe(true);
    expect((handoffSpec.workItems as unknown[]).length).toBe(2);

    expect(harness.metadataUpdates).toHaveLength(2);
    expect(isRecord(harness.metadataUpdates[0].cockpit_active_markdown)).toBe(true);
    expect(harness.metadataUpdates[1].workflow_template_applied).toBe(true);
    expect(harness.metadataUpdates[1].workflow_template_id).toBe('tpl-alpha');

    expect(postgresMockState.queries.some((query) => query.text.toLowerCase().includes('from workitem_templates'))).toBe(true);
  });

  it('does not apply a workflow template when session already has message history', async () => {
    postgresMockState.templates = [
      {
        id: 'tpl-history',
        name: 'History Template',
        description: 'Should not run',
        specs: JSON.stringify([{ id: 'x', objective: 'x', agent: 'standard', dependencies: [] }]),
      },
    ];

    const harness = createHarness({ historyCount: 1 });
    const result = await invokeRoute({
      method: 'POST',
      url: '/control-plane/cockpit/session/sess-1/message',
      ctx: harness.ctx,
      body: {
        message: 'Follow-up prompt',
        markdownContext: {
          content: '---\ntype: workflow\ntemplate: History Template\n---\n',
          metadata: { documentType: 'workflow' },
        },
      },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json?.success).toBe(true);
    expect(result.json?.workflowTemplateApplied).toBe(false);

    expect(harness.dispatchCalls).toHaveLength(1);
    expect(harness.dispatchCalls[0].options?.metadata?.cockpit_handoff_spec).toBeUndefined();

    expect(postgresMockState.queries).toHaveLength(0);
    expect(harness.metadataUpdates).toHaveLength(1);
  });

  it('returns 404 when workflow template hint is present but template is missing', async () => {
    const harness = createHarness();
    const result = await invokeRoute({
      method: 'POST',
      url: '/control-plane/cockpit/session/sess-1/message',
      ctx: harness.ctx,
      body: {
        message: 'Start missing template',
        markdownContext: {
          content: '---\ntype: workflow\ntemplate: Missing Template\n---\n',
          metadata: { documentType: 'workflow' },
        },
      },
    });

    expect(result.statusCode).toBe(404);
    expect(result.json?.success).toBe(false);
    expect(String(result.json?.error ?? '')).toContain('Workflow template not found');

    expect(harness.dispatchCalls).toHaveLength(0);
    expect(harness.metadataUpdates).toHaveLength(0);
  });

  it('skips template lookup when session metadata marks template as already applied', async () => {
    postgresMockState.templates = [
      {
        id: 'tpl-applied',
        name: 'Already Applied',
        description: 'Should be ignored',
        specs: JSON.stringify([{ id: 'a', objective: 'a', agent: 'standard', dependencies: [] }]),
      },
    ];

    const harness = createHarness({
      sessionMetadata: { workflow_template_applied: true },
    });

    const result = await invokeRoute({
      method: 'POST',
      url: '/control-plane/cockpit/session/sess-1/message',
      ctx: harness.ctx,
      body: {
        message: 'Another follow-up',
        markdownContext: {
          content: '---\ntype: workflow\ntemplate: Already Applied\n---\n',
          metadata: { documentType: 'workflow' },
        },
      },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json?.success).toBe(true);
    expect(result.json?.workflowTemplateApplied).toBe(false);
    expect(harness.dispatchCalls).toHaveLength(1);
    expect(harness.dispatchCalls[0].options?.metadata?.cockpit_handoff_spec).toBeUndefined();
    expect(postgresMockState.queries).toHaveLength(0);
  });
});

describe('control-plane cockpit rollup routes', () => {
  it('normalizes string session timestamps for rollup snapshot responses', async () => {
    const ctx: ControlPlaneContext = {
      graphd: {
        sessionsList: () => ({
          sessions: [{
            sessionKey: 'sess-rollup',
            clientType: 'cockpit',
            workingDir: process.cwd(),
            status: 'active',
            createdAt: '2026-02-06T12:00:00.000Z',
            lastAccessedAt: '2026-02-06T13:00:00.000Z',
            metadata: {},
          }],
        }),
      } as unknown as ControlPlaneContext['graphd'],
      isGraphDReady: () => true,
      workingDir: process.cwd(),
    };

    const result = await invokeRoute({
      method: 'GET',
      url: '/control-plane/cockpit/rollups/snapshot?sessionLimit=120&escalationLimit=120&repoLimit=50&includeRepo=0',
      ctx,
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(Array.isArray(result.json?.runningSessions)).toBe(true);
    expect((result.json?.runningSessions as unknown[] | undefined)?.length).toBe(1);
    expect(result.json?.error).toBeUndefined();
  });
});

describe('control-plane cockpit session create routes', () => {
  it('creates document-scoped sessions with restricted write targets', async () => {
    const permissionUpdates: Array<{
      sessionKey: string;
      input: Record<string, unknown>;
      workingDir?: string;
    }> = [];
    const sessionCreateCalls: Array<Record<string, unknown>> = [];

    const ctx: ControlPlaneContext = {
      graphd: {
        sessionCreate: (...args: unknown[]) => {
          sessionCreateCalls.push({
            sessionKey: args[0],
            clientType: args[1],
            workingDir: args[2],
            metadata: args[4],
          });
          return { success: true };
        },
      } as unknown as ControlPlaneContext['graphd'],
      isGraphDReady: () => true,
      workingDir: process.cwd(),
      updateSessionPermissionState: (sessionKey, input, optionsArg) => {
        permissionUpdates.push({
          sessionKey,
          input: { ...input } as Record<string, unknown>,
          ...(typeof optionsArg?.workingDir === 'string' ? { workingDir: optionsArg.workingDir } : {}),
        });
        return {
          persistent: { allow: [], deny: [] },
          sessionGrants: [],
          sessionDenials: [],
          dangerousMode: input.dangerousMode === true,
          allowOutsideRoot: input.allowOutsideRoot === true,
          webSearchEnabled: input.webSearchEnabled !== false,
          writesNoDeletes: input.writesNoDeletes === true,
          ...(Array.isArray(input.restrictWriteToPaths) ? { restrictWriteToPaths: input.restrictWriteToPaths } : {}),
        };
      },
    };

    const result = await invokeRoute({
      method: 'POST',
      url: '/control-plane/cockpit/session/create',
      ctx,
      body: {
        goal: 'Draft this note',
        markdownPath: 'notes/example.md',
        metadata: {
          source: 'cockpit-document',
        },
      },
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.json?.success).toBe(true);
    expect(typeof result.json?.sessionKey).toBe('string');
    expect(sessionCreateCalls).toHaveLength(1);
    expect(permissionUpdates).toHaveLength(1);
    expect(permissionUpdates[0].input.dangerousMode).toBe(false);
    expect(permissionUpdates[0].input.restrictWriteToPaths).toEqual([join(process.cwd(), 'notes/example.md')]);
  });
});

describe('control-plane cockpit markdown routes', () => {
  it('blocks folder deletion in project scope', async () => {
    const harness = createHarness();
    const projectRoot = await mkdtemp(join(tmpdir(), 'cockpit-project-delete-'));
    try {
      await mkdir(join(projectRoot, 'docs'), { recursive: true });
      const result = await invokeRoute({
        method: 'POST',
        url: '/control-plane/cockpit/markdown/delete',
        ctx: harness.ctx,
        body: {
          projectPath: projectRoot,
          path: 'docs',
          type: 'folder',
          recursive: true,
        },
      });

      expect(result.handled).toBe(true);
      expect(result.statusCode).toBe(400);
      expect(result.json?.success).toBe(false);
      expect(String(result.json?.error ?? '')).toContain('Folder deletion is disabled in project scope');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('control-plane cockpit architecture routes', () => {
  it('requires sessionKey for architecture overview', async () => {
    const harness = createHarness();
    const result = await invokeRoute({
      method: 'GET',
      url: '/control-plane/cockpit/architecture/overview',
      ctx: harness.ctx,
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(400);
    expect(result.json?.error).toBe('sessionKey is required');
  });

  it('validates architecture alerts severity values', async () => {
    const harness = createHarness();
    const result = await invokeRoute({
      method: 'GET',
      url: '/control-plane/cockpit/architecture/alerts?severity=severe',
      ctx: harness.ctx,
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(400);
    expect(String(result.json?.error ?? '')).toContain('Invalid severity');
  });

});
