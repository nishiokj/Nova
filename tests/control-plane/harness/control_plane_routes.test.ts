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

vi.mock('postgres', () => ({
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

import { handleControlPlaneRequest, type ControlPlaneContext } from 'control-plane/harness/control_plane_routes.js';

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
  permissionResponses: Array<{
    sessionKey: string;
    requestId: string;
    decision: 'allow' | 'always_allow' | 'deny';
    pattern?: string;
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
  const permissionResponses: Array<{
    sessionKey: string;
    requestId: string;
    decision: 'allow' | 'always_allow' | 'deny';
    pattern?: string;
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
    respondToPermissionRequest: (sessionKey, input) => {
      permissionResponses.push({
        sessionKey,
        requestId: input.requestId,
        decision: input.decision,
        ...(typeof input.pattern === 'string' ? { pattern: input.pattern } : {}),
      });
      return { success: true };
    },
  };

  return { ctx, dispatchCalls, metadataUpdates, permissionUpdates, permissionResponses };
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
    expect(harness.dispatchCalls[0].options?.context).toContain('scopeMode: global');

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
    expect(activeMarkdown.scopeMode).toBe('global');
    expect(typeof activeMarkdown.writeTargetPath).toBe('string');
    expect(String(activeMarkdown.writeTargetPath)).toContain(`${process.cwd()}/.cockpit/scratch/`);
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
    expect(activeMarkdown.scopeMode).toBe('global');
    expect(typeof activeMarkdown.writeTargetPath).toBe('string');
    expect(String(activeMarkdown.writeTargetPath)).toContain(`${process.cwd()}/.cockpit/scratch/`);
    expect(String(activeMarkdown.writeTargetPath)).toMatch(/untitled-\d+\.md$/);
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
    expect(contextText).toContain('path: notes/todo.md');
    expect(contextText).toContain('If the user requests document edits, persist changes to writeTargetPath above');

    expect(harness.metadataUpdates).toHaveLength(1);
    const activeMarkdown = harness.metadataUpdates[0].cockpit_active_markdown;
    expect(isRecord(activeMarkdown)).toBe(true);
    if (!isRecord(activeMarkdown)) {
      throw new Error('Expected cockpit_active_markdown metadata record');
    }
    expect(activeMarkdown.scopeMode).toBe('global');
    expect(activeMarkdown.scopeSessionKey).toBeNull();
    expect(typeof activeMarkdown.writeTargetPath).toBe('string');
    expect(String(activeMarkdown.writeTargetPath)).toContain('.cockpit/scratch/notes/todo.md');
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
      expect(contextText).toContain('path: docs/plan.md');
      expect(contextText).not.toContain('.cockpit/scratch/docs/plan.md');

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
      expect(activeMarkdown.scopeMode).toBe('project');
      expect(typeof activeMarkdown.writeTargetPath).toBe('string');
      expect(String(activeMarkdown.writeTargetPath)).toContain(`${projectRoot}/`);
      expect(String(activeMarkdown.writeTargetPath)).toMatch(/untitled-\d+\.md$/);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
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
          content: '',
          metadata: { template: 'History Template' },
        },
      },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json?.success).toBe(true);
    expect(result.json?.workflowTemplateApplied).toBe(false);

    expect(harness.dispatchCalls).toHaveLength(1);

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
          content: '',
          metadata: { template: 'Missing Template' },
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
          content: '',
          metadata: { template: 'Already Applied' },
        },
      },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json?.success).toBe(true);
    expect(result.json?.workflowTemplateApplied).toBe(false);
    expect(harness.dispatchCalls).toHaveLength(1);
    expect(postgresMockState.queries).toHaveLength(0);
  });
});

describe('control-plane cockpit permission response routes', () => {
  it('forwards permission response decisions to the daemon context', async () => {
    const harness = createHarness();
    const result = await invokeRoute({
      method: 'POST',
      url: '/control-plane/cockpit/permissions/response',
      ctx: harness.ctx,
      body: {
        sessionKey: 'sess-1',
        requestId: 'perm-req-1',
        decision: 'always_allow',
        pattern: 'Write(src/**)',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.json?.success).toBe(true);
    expect(harness.permissionResponses).toEqual([
      {
        sessionKey: 'sess-1',
        requestId: 'perm-req-1',
        decision: 'always_allow',
        pattern: 'Write(src/**)',
      },
    ]);
  });

  it('validates request body fields', async () => {
    const harness = createHarness();
    const result = await invokeRoute({
      method: 'POST',
      url: '/control-plane/cockpit/permissions/response',
      ctx: harness.ctx,
      body: {
        sessionKey: 'sess-1',
        requestId: 'perm-req-1',
        decision: 'invalid',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(400);
    expect(result.json?.success).toBe(false);
    expect(String(result.json?.error ?? '')).toContain('Invalid decision');
    expect(harness.permissionResponses).toHaveLength(0);
  });
});

describe('control-plane cockpit session permissions routes', () => {
  it('returns normalized session permission state for GET requests', async () => {
    const harness = createHarness({
      sessionMetadata: {
        permission_state: { dangerousMode: true },
        permission_flags: {
          allowOutsideRoot: true,
          webSearchEnabled: false,
          writesNoDeletes: true,
          restrictWriteToPaths: ['src', 'docs'],
        },
      },
    });

    const result = await invokeRoute({
      method: 'GET',
      url: '/control-plane/cockpit/session/sess-1/permissions',
      ctx: harness.ctx,
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.json?.sessionKey).toBe('sess-1');
    expect(isRecord(result.json?.state)).toBe(true);
    if (!isRecord(result.json?.state)) {
      throw new Error('Expected state object');
    }
    expect(result.json.state.dangerousMode).toBe(true);
    expect(result.json.state.allowOutsideRoot).toBe(true);
    expect(result.json.state.webSearchEnabled).toBe(false);
    expect(result.json.state.writesNoDeletes).toBe(true);
    expect(Array.isArray(result.json.state.restrictWriteToPaths)).toBe(true);
  });

  it('forwards permission updates to daemon context for POST requests', async () => {
    const harness = createHarness();
    const result = await invokeRoute({
      method: 'POST',
      url: '/control-plane/cockpit/session/sess-1/permissions',
      ctx: harness.ctx,
      body: {
        writesNoDeletes: true,
        webSearchEnabled: false,
      },
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.json?.success).toBe(true);
    expect(harness.permissionUpdates).toHaveLength(1);
    expect(harness.permissionUpdates[0].sessionKey).toBe('sess-1');
    expect(harness.permissionUpdates[0].input).toMatchObject({
      writesNoDeletes: true,
      webSearchEnabled: false,
    });
  });

  it('rejects POST updates with no permission fields', async () => {
    const harness = createHarness();
    const result = await invokeRoute({
      method: 'POST',
      url: '/control-plane/cockpit/session/sess-1/permissions',
      ctx: harness.ctx,
      body: {},
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(400);
    expect(result.json?.success).toBe(false);
    expect(String(result.json?.error ?? '')).toContain('No permission updates provided');
    expect(harness.permissionUpdates).toHaveLength(0);
  });
});

describe('control-plane cockpit session model routes', () => {
  it('forwards model selections to daemon context and returns current selections', async () => {
    const harness = createHarness();
    const setCalls: Array<{
      sessionKey: string;
      agentType: string;
      selection: { provider: string; model: string; reasoning?: string };
    }> = [];
    const selections = {
      standard: { provider: 'openai', model: 'gpt-4o-mini' },
      observer: { provider: 'openai', model: 'gpt-4o-mini' },
    };
    const ctx: ControlPlaneContext = {
      ...harness.ctx,
      setSessionModelSelection: (sessionKey, agentType, selection) => {
        setCalls.push({ sessionKey, agentType, selection });
        return { success: true, agentType, selection };
      },
      getSessionModelSelections: () => ({ success: true, selections }),
    };

    const update = await invokeRoute({
      method: 'POST',
      url: '/control-plane/cockpit/session/sess-1/model',
      ctx,
      body: {
        agentType: 'standard',
        provider: 'openai',
        model: 'gpt-4o-mini',
      },
    });

    expect(update.handled).toBe(true);
    expect(update.statusCode).toBe(200);
    expect(update.json?.success).toBe(true);
    expect(setCalls).toEqual([{
      sessionKey: 'sess-1',
      agentType: 'standard',
      selection: { provider: 'openai', model: 'gpt-4o-mini' },
    }]);

    const query = await invokeRoute({
      method: 'GET',
      url: '/control-plane/cockpit/session/sess-1/model',
      ctx,
    });

    expect(query.handled).toBe(true);
    expect(query.statusCode).toBe(200);
    expect(isRecord(query.json?.selections)).toBe(true);
    expect((query.json?.selections as Record<string, unknown>)?.standard).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    expect(Array.isArray(query.json?.models)).toBe(true);
  });

  it('validates required model route fields', async () => {
    const harness = createHarness();
    const ctx: ControlPlaneContext = {
      ...harness.ctx,
      setSessionModelSelection: (sessionKey, agentType, selection) => ({ success: true, agentType, selection }),
      getSessionModelSelections: () => ({ success: true, selections: {} }),
    };

    const result = await invokeRoute({
      method: 'POST',
      url: '/control-plane/cockpit/session/sess-1/model',
      ctx,
      body: { provider: 'openai' },
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(400);
    expect(String(result.json?.error ?? '')).toContain('provider and model are required');
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
      url: '/control-plane/cockpit/rollups/snapshot?sessionLimit=120&repoLimit=50&includeRepo=0',
      ctx,
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(Array.isArray(result.json?.runningSessions)).toBe(true);
    expect((result.json?.runningSessions as unknown[] | undefined)?.length).toBe(1);
    expect(result.json?.error).toBeUndefined();
  });
});

describe('control-plane cockpit event/message routes', () => {
  it('normalizes millisecond message timestamps for session messages', async () => {
    const harness = createHarness({ historyCount: 1 });
    const result = await invokeRoute({
      method: 'GET',
      url: '/control-plane/sessions/sess-1/messages',
      ctx: harness.ctx,
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    const messages = Array.isArray(result.json?.messages) ? result.json?.messages : [];
    expect(messages.length).toBe(1);
    const createdAt = String((messages[0] as Record<string, unknown>)?.createdAt ?? '');
    expect(Number.isFinite(Date.parse(createdAt))).toBe(true);
    expect(new Date(createdAt).getUTCFullYear()).toBeLessThan(2100);
  });

  it('returns recent messages even when limit=1', async () => {
    const harness = createHarness({ historyCount: 3 });
    const result = await invokeRoute({
      method: 'GET',
      url: '/control-plane/cockpit/session/sess-1/events?limit=1',
      ctx: harness.ctx,
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    const events = Array.isArray(result.json?.events) ? result.json?.events : [];
    expect(events.length).toBe(1);
    expect(typeof result.json?.nextCursor).toBe('number');
  });

  it('falls back to default event limit for non-numeric limit values', async () => {
    const harness = createHarness({ historyCount: 2 });
    const result = await invokeRoute({
      method: 'GET',
      url: '/control-plane/cockpit/session/sess-1/events?limit=not-a-number',
      ctx: harness.ctx,
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    const events = Array.isArray(result.json?.events) ? result.json?.events : [];
    expect(events.length).toBeGreaterThan(0);
  });

  it('maps data.work_id to payload.workItemId for normalized events', async () => {
    const harness = createHarness({
      sessionMetadata: {
        agent_events: [
          {
            type: 'iteration_completed',
            timestamp: new Date('2026-02-08T10:01:00.000Z').toISOString(),
            data: {
              work_id: 'wk-2',
              result: { success: true },
            },
          },
        ],
      },
    });
    const result = await invokeRoute({
      method: 'GET',
      url: '/control-plane/cockpit/session/sess-1/events?limit=20',
      ctx: harness.ctx,
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    const events = Array.isArray(result.json?.events) ? result.json.events : [];
    expect(events.length).toBe(1);
    const payload = (events[0] as Record<string, unknown>)?.payload as Record<string, unknown> | undefined;
    expect(payload?.workItemId).toBe('wk-2');
  });

  it('backfills objective from iteration_started goal keyed by data.work_id', async () => {
    const harness = createHarness({
      sessionMetadata: {
        agent_events: [
          {
            type: 'iteration_started',
            timestamp: new Date('2026-02-08T10:00:00.000Z').toISOString(),
            data: {
              iteration: 1,
              work_id: 'wk-9',
              goal: 'Implement checkout objective',
            },
          },
          {
            type: 'tool_call',
            timestamp: new Date('2026-02-08T10:00:01.000Z').toISOString(),
            work_item_id: 'wk-9',
            data: {
              tool_name: 'Read',
              phase: 'completed',
              success: true,
            },
          },
        ],
      },
    });
    const result = await invokeRoute({
      method: 'GET',
      url: '/control-plane/cockpit/session/sess-1/events?limit=20',
      ctx: harness.ctx,
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    const events = Array.isArray(result.json?.events) ? result.json.events : [];
    const toolEvent = events.find((raw) => {
      const event = raw as Record<string, unknown>;
      const payload = event.payload as Record<string, unknown> | undefined;
      return payload?.eventType === 'tool_call';
    }) as Record<string, unknown> | undefined;
    expect(toolEvent).toBeDefined();
    const payload = toolEvent?.payload as Record<string, unknown> | undefined;
    expect(payload?.workItemId).toBe('wk-9');
    const data = payload?.data as Record<string, unknown> | undefined;
    expect(data?.objective).toBe('Implement checkout objective');
  });

  it('deduplicates table-vs-agent message duplicates independent of ordering', async () => {
    const invokeWithAgentTimestamp = async (agentTimestamp: string) => {
      const ctx: ControlPlaneContext = {
        graphd: {
          sessionGet: () => ({
            session: createSessionRow({
              agent_events: [
                {
                  type: 'agent_message',
                  timestamp: agentTimestamp,
                  request_id: 'req-1',
                  data: {
                    role: 'assistant',
                    message: 'Hello world',
                  },
                },
              ],
            }),
          }),
          messagesGet: () => ({
            messages: [
              {
                id: 101,
                role: 'assistant',
                content: 'Hello world',
                requestId: 'req-1',
                createdAt: Date.parse('2026-02-08T10:00:01.000Z'),
              },
            ],
          }),
        } as unknown as ControlPlaneContext['graphd'],
        isGraphDReady: () => true,
        workingDir: process.cwd(),
      };
      return invokeRoute({
        method: 'GET',
        url: '/control-plane/cockpit/session/sess-1/events?limit=20',
        ctx,
      });
    };

    const olderAgent = await invokeWithAgentTimestamp('2026-02-08T10:00:00.000Z');
    const newerAgent = await invokeWithAgentTimestamp('2026-02-08T10:00:02.000Z');

    for (const result of [olderAgent, newerAgent]) {
      expect(result.handled).toBe(true);
      expect(result.statusCode).toBe(200);
      const events = Array.isArray(result.json?.events) ? result.json.events : [];
      const assistantMessages = events.filter((raw) => {
        const event = raw as Record<string, unknown>;
        if (event.type !== 'message') return false;
        const payload = event.payload as Record<string, unknown> | undefined;
        return payload?.role === 'assistant';
      }) as Array<Record<string, unknown>>;
      expect(assistantMessages).toHaveLength(1);
      const payload = assistantMessages[0].payload as Record<string, unknown>;
      expect(payload.id).toBe(101);
      expect(payload.requestId).toBe('req-1');
    }
  });

  it('keeps streamed assistant content when canonical table row is empty', async () => {
    const ctx: ControlPlaneContext = {
      graphd: {
        sessionGet: () => ({
          session: createSessionRow({
            agent_events: [
              {
                type: 'agent_message',
                timestamp: '2026-02-08T10:00:00.000Z',
                request_id: 'req-1',
                data: {
                  role: 'assistant',
                  message: 'Love ',
                },
              },
              {
                type: 'agent_message',
                timestamp: '2026-02-08T10:00:01.000Z',
                request_id: 'req-1',
                data: {
                  role: 'assistant',
                  message: 'it',
                },
              },
            ],
          }),
        }),
        messagesGet: () => ({
          messages: [
            {
              id: 201,
              role: 'assistant',
              content: '',
              requestId: 'req-1',
              createdAt: Date.parse('2026-02-08T10:00:02.000Z'),
            },
          ],
        }),
      } as unknown as ControlPlaneContext['graphd'],
      isGraphDReady: () => true,
      workingDir: process.cwd(),
    };

    const result = await invokeRoute({
      method: 'GET',
      url: '/control-plane/cockpit/session/sess-1/events?limit=20',
      ctx,
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    const events = Array.isArray(result.json?.events) ? result.json.events : [];
    const nonEmptyAssistantMessages = events.filter((raw) => {
      const event = raw as Record<string, unknown>;
      if (event.type !== 'message') return false;
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload?.role !== 'assistant') return false;
      return typeof payload.content === 'string' && payload.content.trim().length > 0;
    }) as Array<Record<string, unknown>>;
    expect(nonEmptyAssistantMessages).toHaveLength(1);
    const payload = nonEmptyAssistantMessages[0].payload as Record<string, unknown>;
    expect(payload.content).toBe('Love it');
    expect(payload.requestId).toBe('req-1');
  });

  it('coalesces agent_message chunks into a single assistant message per request', async () => {
    const ctx: ControlPlaneContext = {
      graphd: {
        sessionGet: () => ({
          session: createSessionRow({
            agent_events: [
              {
                type: 'agent_message',
                timestamp: '2026-02-08T10:00:00.000Z',
                request_id: 'req-1',
                data: {
                  role: 'assistant',
                  message: 'Love ',
                },
              },
              {
                type: 'agent_message',
                timestamp: '2026-02-08T10:00:01.000Z',
                request_id: 'req-1',
                data: {
                  role: 'assistant',
                  message: 'it',
                },
              },
              {
                type: 'agent_message',
                timestamp: '2026-02-08T10:00:02.000Z',
                request_id: 'req-1',
                data: {
                  role: 'assistant',
                  message: ' \u2014 let',
                },
              },
            ],
          }),
        }),
        messagesGet: () => ({ messages: [] }),
      } as unknown as ControlPlaneContext['graphd'],
      isGraphDReady: () => true,
      workingDir: process.cwd(),
    };

    const result = await invokeRoute({
      method: 'GET',
      url: '/control-plane/cockpit/session/sess-1/events?limit=20',
      ctx,
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    const events = Array.isArray(result.json?.events) ? result.json.events : [];
    const assistantMessages = events.filter((raw) => {
      const event = raw as Record<string, unknown>;
      if (event.type !== 'message') return false;
      const payload = event.payload as Record<string, unknown> | undefined;
      return payload?.role === 'assistant';
    }) as Array<Record<string, unknown>>;
    expect(assistantMessages).toHaveLength(1);
    const payload = assistantMessages[0].payload as Record<string, unknown>;
    expect(payload.requestId).toBe('req-1');
    expect(payload.eventType).toBe('agent_message');
    expect(payload.content).toBe('Love it \u2014 let');
  });

  it('drops agent_message chunks when a non-empty harness response exists for the same request', async () => {
    const ctx: ControlPlaneContext = {
      graphd: {
        sessionGet: () => ({
          session: createSessionRow({
            agent_events: [
              {
                type: 'agent_message',
                timestamp: '2026-02-08T10:00:00.000Z',
                request_id: 'req-1',
                data: {
                  role: 'assistant',
                  message: 'Love ',
                },
              },
              {
                type: 'agent_message',
                timestamp: '2026-02-08T10:00:01.000Z',
                request_id: 'req-1',
                data: {
                  role: 'assistant',
                  message: 'it',
                },
              },
              {
                type: 'harness_response',
                timestamp: '2026-02-08T10:00:02.000Z',
                request_id: 'req-1',
                data: {
                  role: 'assistant',
                  content: 'Love it for real',
                },
              },
            ],
          }),
        }),
        messagesGet: () => ({ messages: [] }),
      } as unknown as ControlPlaneContext['graphd'],
      isGraphDReady: () => true,
      workingDir: process.cwd(),
    };

    const result = await invokeRoute({
      method: 'GET',
      url: '/control-plane/cockpit/session/sess-1/events?limit=20',
      ctx,
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    const events = Array.isArray(result.json?.events) ? result.json.events : [];
    const assistantMessages = events.filter((raw) => {
      const event = raw as Record<string, unknown>;
      if (event.type !== 'message') return false;
      const payload = event.payload as Record<string, unknown> | undefined;
      return payload?.role === 'assistant';
    }) as Array<Record<string, unknown>>;
    expect(assistantMessages).toHaveLength(1);
    const payload = assistantMessages[0].payload as Record<string, unknown>;
    expect(payload.requestId).toBe('req-1');
    expect(payload.eventType).toBe('harness_response');
    expect(payload.content).toBe('Love it for real');
  });

  it('does not dedupe messages when requestId is missing', async () => {
    const ctx: ControlPlaneContext = {
      graphd: {
        sessionGet: () => ({
          session: createSessionRow({
            agent_events: [
              {
                type: 'agent_message',
                timestamp: '2026-02-08T10:00:00.000Z',
                data: {
                  role: 'assistant',
                  message: 'Live no request id',
                },
              },
            ],
          }),
        }),
        messagesGet: () => ({
          messages: [
            {
              id: 102,
              role: 'assistant',
              content: 'Persisted no request id',
              requestId: null,
              createdAt: Date.parse('2026-02-08T10:00:01.000Z'),
            },
          ],
        }),
      } as unknown as ControlPlaneContext['graphd'],
      isGraphDReady: () => true,
      workingDir: process.cwd(),
    };

    const result = await invokeRoute({
      method: 'GET',
      url: '/control-plane/cockpit/session/sess-1/events?limit=20',
      ctx,
    });

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    const events = Array.isArray(result.json?.events) ? result.json.events : [];
    const assistantMessages = events.filter((raw) => {
      const event = raw as Record<string, unknown>;
      if (event.type !== 'message') return false;
      const payload = event.payload as Record<string, unknown> | undefined;
      return payload?.role === 'assistant';
    });
    expect(assistantMessages).toHaveLength(2);
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
