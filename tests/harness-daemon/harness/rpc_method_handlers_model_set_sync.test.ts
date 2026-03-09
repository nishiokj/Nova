import { describe, expect, it } from 'vitest';
import type { ModelSelection } from 'agent';
import { RpcMethodHandlers, type RpcConnectionState } from 'harness-daemon/harness/rpc_method_handlers.js';

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'lmstudio:qwen3-coder-next': 32_768,
  'openai:gpt-5-mini': 200_000,
  'codex:gpt-5.3-codex': 64_000,
};

function normalizeSelection(selection: ModelSelection): ModelSelection {
  if (Number.isFinite(selection.contextWindow) && selection.contextWindow > 0) {
    return selection;
  }

  const contextWindow = MODEL_CONTEXT_WINDOWS[`${selection.provider}:${selection.model}`];
  if (!contextWindow) {
    throw new Error(`Missing test context window for ${selection.provider}/${selection.model}`);
  }

  return { ...selection, contextWindow };
}

function buildHandlers(
  initialSelections: Record<string, ModelSelection>,
  hasApiKey = true
): {
  handlers: RpcMethodHandlers;
  state: RpcConnectionState;
  selections: Map<string, ModelSelection>;
  events: Array<{ type: string; data?: Record<string, unknown> }>;
} {
  const selections = new Map<string, ModelSelection>(
    Object.entries(initialSelections).map(([agentType, selection]) => [agentType, normalizeSelection(selection)])
  );
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];

  const handlers = new RpcMethodHandlers({
    harness: {
      run: () => {
        throw new Error('not used');
      },
      createReadyEvent: () => ({ type: 'ready', data: {} }),
      getConfig: () => ({
        defaultAgent: 'standard',
        agents: {
          standard: { llm: { provider: 'openai', model: 'gpt-5-mini' } },
        },
        models: { default: 'gpt-5-mini' },
        graphd: { enabled: false },
        skills: { enabled: false, directory: '.skills' },
        hooks: { enabled: false, directory: '.hooks' },
      }),
      isShuttingDown: () => false,
      shutdown: async () => undefined,
      hasApiKey: () => hasApiKey,
      setSessionSelectedModel: (_sessionKey: string, agentType: string, selectedModel: ModelSelection | null) => {
        if (!selectedModel) {
          selections.delete(agentType);
          return;
        }
        selections.set(agentType, normalizeSelection(selectedModel));
      },
      getSessionSelectedModel: (_sessionKey: string, agentType: string) => {
        return selections.get(agentType) ?? null;
      },
      getAllSessionSelectedModels: () => new Map(selections),
    } as any,
    authService: null,
    localProviders: null,
    workingDir: process.cwd(),
    skillsDir: process.cwd(),
    hooksDir: process.cwd(),
    sessionOwners: new Map(),
    getOrCreateConnectionState: () => ({
      sessionKey: 'session_sync',
      lastSessionKey: null,
      workingDir: null,
      activeRequestId: null,
      asyncRun: null,
    }),
    sendEvent: (_connectionId, event) => {
      events.push({ type: event.type, data: event.data as Record<string, unknown> | undefined });
    },
    streamRunEvents: () => undefined,
  });

  const state: RpcConnectionState = {
    sessionKey: 'session_sync',
    lastSessionKey: null,
    workingDir: null,
    activeRequestId: null,
    asyncRun: null,
  };

  return { handlers, state, selections, events };
}

describe('RpcMethodHandlers model.set companion sync', () => {
  it('syncs explorer/coding when they still match previous standard selection', async () => {
    const oldSelection: ModelSelection = { provider: 'lmstudio', model: 'qwen3-coder-next', contextWindow: 32_768 };
    const { handlers, state, selections, events } = buildHandlers({
      standard: oldSelection,
      explorer: oldSelection,
      coding: oldSelection,
    });

    const result = await handlers.invoke('conn_sync_1', state, 'model.set', {
      agent_type: 'standard',
      provider: 'codex',
      model: 'gpt-5.3-codex',
    });

    expect(result.success).toBe(true);
    expect(selections.get('standard')).toEqual({ provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 64_000 });
    expect(selections.get('explorer')).toEqual({ provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 64_000 });
    expect(selections.get('coding')).toEqual({ provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 64_000 });

    const modelChangedAgents = new Set(
      events
        .filter((event) => event.type === 'model_changed')
        .map((event) => String(event.data?.agentType ?? ''))
    );
    expect(modelChangedAgents).toEqual(new Set(['standard', 'explorer', 'coding']));
  });

  it('preserves companion selections that intentionally diverged from standard', async () => {
    const oldStandard: ModelSelection = { provider: 'lmstudio', model: 'qwen3-coder-next', contextWindow: 32_768 };
    const customExplorer: ModelSelection = { provider: 'openai', model: 'gpt-5-mini', contextWindow: 200_000 };
    const { handlers, state, selections, events } = buildHandlers({
      standard: oldStandard,
      explorer: customExplorer,
      coding: oldStandard,
    });

    const result = await handlers.invoke('conn_sync_2', state, 'model.set', {
      agent_type: 'standard',
      provider: 'codex',
      model: 'gpt-5.3-codex',
    });

    expect(result.success).toBe(true);
    expect(selections.get('standard')).toEqual({ provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 64_000 });
    expect(selections.get('coding')).toEqual({ provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 64_000 });
    expect(selections.get('explorer')).toEqual(customExplorer);

    const modelChangedAgents = events
      .filter((event) => event.type === 'model_changed')
      .map((event) => String(event.data?.agentType ?? ''));
    expect(modelChangedAgents).toContain('standard');
    expect(modelChangedAgents).toContain('coding');
    expect(modelChangedAgents).not.toContain('explorer');
  });
});
