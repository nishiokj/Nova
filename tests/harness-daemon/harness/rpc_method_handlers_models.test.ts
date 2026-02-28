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
        .filter((model) => gatewayProviders.has(model.provider))
        .map((model) => toGatewayModel(model.id, model.provider))
    );
    for (const expectedId of expectedGatewayIds) {
      expect(gatewayIds.has(expectedId)).toBe(true);
    }
  });
});
