import { describe, expect, it } from 'vitest';
import { RpcMethodHandlers, type RpcConnectionState } from 'harness-daemon/harness/rpc_method_handlers.js';
import { GATEWAY_MODEL_PROVIDER_IDS, getAllModels, toGatewayModel } from 'types';

describe('RpcMethodHandlers models.list gateway variants', () => {
  it('includes gateway model variants for all supported gateway providers', async () => {
    const handlers = new RpcMethodHandlers({
      harness: {
        run: () => {
          throw new Error('not used');
        },
        createReadyEvent: () => ({ type: 'ready', data: {} }),
        getConfig: () => ({
          defaultAgent: 'default',
          agents: {
            default: { llm: { provider: 'openai', model: 'gpt-5-mini' } },
          },
          models: { default: 'gpt-5-mini' },
          graphd: { enabled: false },
          skills: { enabled: false, directory: '.skills' },
          hooks: { enabled: false, directory: '.hooks' },
        }),
        isShuttingDown: () => false,
        shutdown: async () => undefined,
        hasApiKey: (provider: string) => provider === 'vercel-gateway',
        listProviderModels: async () => {
          throw new Error('catalog unavailable');
        },
      },
      authService: null,
      localProviders: null,
      workingDir: process.cwd(),
      skillsDir: process.cwd(),
      hooksDir: process.cwd(),
      sessionOwners: new Map(),
      getOrCreateConnectionState: () => ({
        sessionKey: null,
        lastSessionKey: null,
        workingDir: null,
        activeRequestId: null,
        asyncRun: null,
      }),
      sendEvent: () => undefined,
      streamRunEvents: () => undefined,
    });

    const state: RpcConnectionState = {
      sessionKey: null,
      lastSessionKey: null,
      workingDir: null,
      activeRequestId: null,
      asyncRun: null,
    };

    const result = await handlers.invoke('conn_1', state, 'models.list', {});
    expect(result.success).toBe(true);

    const models = result.models as Array<{ id: string; provider: string }>;
    const gatewayIds = new Set(
      models
        .filter((model) => model.provider === 'vercel-gateway')
        .map((model) => model.id),
    );

    const gatewayProviders = new Set<string>(GATEWAY_MODEL_PROVIDER_IDS);
    const expectedGatewayIds = new Set(
      getAllModels()
        .filter((model: { provider: string }) => gatewayProviders.has(model.provider))
        .map((model: { id: string; provider: string }) => toGatewayModel(model.id, model.provider))
    );
    for (const expectedId of expectedGatewayIds) {
      if (typeof expectedId === 'string') {
        expect(gatewayIds.has(expectedId)).toBe(true);
      }
    }
  });

  it('replaces static provider entries with discovered models and caches the catalog', async () => {
    let discoveryCalls = 0;
    let selectedModel: { provider: string; model: string; contextWindow?: number } | null = null;
    const handlers = new RpcMethodHandlers({
      harness: {
        run: () => {
          throw new Error('not used');
        },
        createReadyEvent: () => ({ type: 'ready', data: {} }),
        getConfig: () => ({
          defaultAgent: 'default',
          agents: {
            default: { llm: { provider: 'codex', model: 'gpt-remote' } },
          },
          models: { default: 'gpt-remote' },
          graphd: { enabled: false },
          skills: { enabled: false, directory: '.skills' },
          hooks: { enabled: false, directory: '.hooks' },
        }),
        isShuttingDown: () => false,
        shutdown: async () => undefined,
        hasApiKey: (provider: string) => provider === 'codex',
        listProviderModels: async () => {
          discoveryCalls++;
          return {
            models: [{
              id: 'gpt-remote',
              name: 'GPT Remote',
              context_window: 300_000,
              reasoning: ['low', 'high'],
            }],
            etag: 'catalog-etag',
          };
        },
        setSessionSelectedModel: (_sessionKey: string, _agentType: string, model: { provider: string; model: string; contextWindow?: number } | null) => {
          selectedModel = model;
        },
        getSessionSelectedModel: () => selectedModel as any,
      },
      authService: null,
      localProviders: null,
      workingDir: process.cwd(),
      skillsDir: process.cwd(),
      hooksDir: process.cwd(),
      sessionOwners: new Map(),
      getOrCreateConnectionState: () => ({
        sessionKey: 'session_1',
        lastSessionKey: null,
        workingDir: null,
        activeRequestId: null,
        asyncRun: null,
      }),
      sendEvent: () => undefined,
      streamRunEvents: () => undefined,
    });
    const state: RpcConnectionState = {
      sessionKey: 'session_1',
      lastSessionKey: null,
      workingDir: null,
      activeRequestId: null,
      asyncRun: null,
    };

    const first = await handlers.invoke('conn_1', state, 'models.list', {});
    const second = await handlers.invoke('conn_1', state, 'models.list', {});
    const selection = await handlers.invoke('conn_1', state, 'model.set', {
      provider: 'codex',
      model: 'gpt-remote',
    });

    expect(first.models).toEqual([{
      id: 'gpt-remote',
      name: 'GPT Remote',
      provider: 'codex',
      reasoning: ['low', 'high'],
    }]);
    expect(second.models).toEqual(first.models);
    expect(selection.success).toBe(true);
    expect(selectedModel).toMatchObject({
      provider: 'codex',
      model: 'gpt-remote',
      contextWindow: 300_000,
    });
    expect(discoveryCalls).toBe(1);
  });
});
