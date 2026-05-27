import { BusClient, BusServer, BRIDGE_COMMAND_CHANNEL, runChannel } from 'comms-bus';
import { isRpcResponse } from '@nova/client';
import { BridgeGateway } from 'harness-daemon/harness/bridge_gateway.js';
import { createReadyEvent } from 'harness-daemon/harness/event_translator.js';
import type { AgentRunHandle, BridgeEvent } from 'harness-daemon/harness/types.js';
import type { FullHarnessConfig } from 'harness-daemon/harness/config.js';
import { GATEWAY_MODEL_PROVIDER_IDS, getAllModels, toGatewayModel } from 'types';

function waitFor(predicate: () => boolean, timeoutMs = 400): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timeout'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

class FakeHarness {
  private readonly sessionAsyncRuns = new Map<string, { requestId: string; goal: string; cancelled: boolean; startedAt: number }>();
  private readonly config: FullHarnessConfig;
  controlCalls: Array<{
    sessionKey: string;
    action: 'pause' | 'resume' | 'cancel';
    reason?: string;
    requestedBy?: 'user' | 'system' | 'policy';
  }> = [];

  constructor() {
    this.config = {
      agents: {
        standard: {
          llm: {
            provider: 'openai',
            model: 'test-model',
            apiKey: 'test-key',
            maxTokens: 1,
            temperature: 0,
            reasoning: { effort: 'none' },
          },
          budget: {
            maxIterations: 1,
            maxToolCalls: 0,
            maxDurationMs: 1,
          },
          tools: [],
        },
      },
      defaultAgent: 'standard',
      tools: { workingDir: process.cwd(), repoRoot: process.cwd(), bashTimeoutMs: 1, maxOutputLength: 1 },
      graphd: { enabled: false, host: '127.0.0.1', port: 0, dbPath: '' },
      context: { maxTokens: 1, sessionTtlMs: 1, maxSessions: 1 },
      skills: { enabled: false, directory: '.agent/skills', definitions: [] },
      hooks: { enabled: false, directory: 'config/hooks', definitions: [] },
      entityGraph: {
        enabled: false,
        leaseDurationSec: 1,
        startupScan: false,
        leaseWaitTimeoutMs: 1,
      },
      auth: {
        enabled: false,
        host: '127.0.0.1',
        port: 0,
        sessionExpiryDays: null,
      },
      models: {
        available: [],
        default: 'gpt-5-mini',
      },
      memory: {
        enabled: false,
        baseUrl: '',
        timeoutMs: 1,
      },
      dangerousMode: false,
    };
  }

  run(params: { requestId: string; inputText: string; sessionKey: string }): AgentRunHandle {
    const requestId = params.requestId;
    async function* events(): AsyncIterable<BridgeEvent> {
      yield { type: 'status', data: { state: 'sending' } };
      yield {
        type: 'response',
        data: {
          request_id: requestId,
          success: true,
          content: 'ok',
          tools_used: [],
          duration_ms: 1,
        },
      };
    }

    return {
      events: events(),
      result: Promise.resolve({
        requestId,
        sessionKey: params.sessionKey,
        success: true,
        finalText: 'ok',
        paused: false,
        toolsUsed: [],
        durationMs: 1,
      }),
    };
  }

  resume(requestId: string, _answer: string, sessionKey: string): AgentRunHandle {
    return this.run({ requestId, inputText: 'resume', sessionKey });
  }

  createReadyEvent(sessionKey: string): BridgeEvent {
    return createReadyEvent(sessionKey, []);
  }

  hasApiKey(_provider: string): boolean {
    return true;
  }

  getSessionSelectedModel(_sessionKey: string, _agentType: string): { provider: string; model: string; contextWindow: number } {
    return { provider: 'openai', model: 'test-model', contextWindow: 128_000 };
  }

  getConfig(): FullHarnessConfig {
    return this.config;
  }

  getSessionAsyncRun(sessionKey: string): { requestId: string; goal: string; cancelled: boolean; startedAt: number } | null {
    return this.sessionAsyncRuns.get(sessionKey) ?? null;
  }

  setSessionAsyncRun(sessionKey: string, info: { requestId: string; goal: string; cancelled: boolean; startedAt: number }): void {
    this.sessionAsyncRuns.set(sessionKey, info);
  }

  cancelSessionAsyncRun(sessionKey: string): void {
    const current = this.sessionAsyncRuns.get(sessionKey);
    if (!current) return;
    this.sessionAsyncRuns.set(sessionKey, { ...current, cancelled: true });
  }

  clearSessionAsyncRun(sessionKey: string): void {
    this.sessionAsyncRuns.delete(sessionKey);
  }

  setSessionAsyncModeEnabled(_sessionKey: string, _enabled: boolean): void {
    return;
  }

  async controlSessionExecution(params: {
    sessionKey: string;
    action: 'pause' | 'resume' | 'cancel';
    reason?: string;
    requestedBy?: 'user' | 'system' | 'policy';
  }): Promise<{ success: boolean; requestId?: string; quiesced?: boolean; error?: string }> {
    this.controlCalls.push(params);
    return {
      success: true,
      requestId: 'req_control',
      quiesced: params.action !== 'resume',
    };
  }

  isShuttingDown(): boolean {
    return false;
  }

  async shutdown(): Promise<void> {
    return;
  }
}

describe('bridge rpc cutover integration', () => {
  it('returns gateway model variants for all gateway-eligible providers via models.list rpc', async () => {
    const harness = new FakeHarness();
    let gateway: BridgeGateway;
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: (connectionId, channel, payload) =>
        gateway.handlePublish(connectionId, channel, payload),
    });
    gateway = new BridgeGateway(server, harness, process.cwd());
    const address = await server.start();

    const client = new BusClient({ host: address.host, port: address.port });
    const events: BridgeEvent[] = [];
    const rpcResponses: Array<Record<string, unknown>> = [];
    client.on('event', (payload) => {
      if (isRpcResponse(payload)) {
        rpcResponses.push(payload as Record<string, unknown>);
      }
      if (isRecord(payload) && typeof payload.type === 'string') {
        events.push(payload as BridgeEvent);
      }
    });
    await client.connect();

    client.publish(BRIDGE_COMMAND_CHANNEL, { type: 'init', data: {} });
    await waitFor(() => events.some((event) => event.type === 'ready'));

    client.publish(BRIDGE_COMMAND_CHANNEL, {
      rpc: 1,
      id: 'rpc_models_1',
      method: 'models.list',
      params: {},
    });

    await waitFor(() => rpcResponses.some((r) => r.id === 'rpc_models_1'));
    const response = rpcResponses.find((r) => r.id === 'rpc_models_1');
    expect(isRecord(response?.result)).toBe(true);
    if (!isRecord(response?.result)) {
      throw new Error('Expected models.list RPC result payload');
    }
    expect(response.result.success).toBe(true);

    const models = Array.isArray(response.result.models)
      ? response.result.models
      : [];
    const gatewayIds = new Set(
      models
        .filter((model): model is Record<string, unknown> => isRecord(model))
        .filter((model) => model.provider === 'vercel-gateway')
        .map((model) => String(model.id ?? ''))
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

    client.close();
    await server.stop();
  });

  it('keeps streaming intact while unary flows go through rpc', async () => {
    const harness = new FakeHarness();
    let gateway: BridgeGateway;
    const server = new BusServer({
      host: '127.0.0.1',
      port: 0,
      onPublish: (connectionId, channel, payload) =>
        gateway.handlePublish(connectionId, channel, payload),
    });
    gateway = new BridgeGateway(server, harness, process.cwd());
    const address = await server.start();

    const client = new BusClient({ host: address.host, port: address.port });
    const events: BridgeEvent[] = [];
    const rpcResponses: Array<Record<string, unknown>> = [];
    client.on('event', (payload) => {
      if (isRpcResponse(payload)) {
        rpcResponses.push(payload as Record<string, unknown>);
      }
      if (isRecord(payload) && typeof payload.type === 'string') {
        events.push(payload as BridgeEvent);
      }
    });
    await client.connect();

    client.publish(BRIDGE_COMMAND_CHANNEL, { type: 'init', data: {} });
    await waitFor(() => events.some((event) => event.type === 'ready'));
    const ready = events.find((event) => event.type === 'ready');
    const sessionKey = typeof ready?.data?.session_key === 'string' ? ready.data.session_key : '';
    expect(sessionKey).not.toBe('');

    const requestId = 'req_stream';
    client.subscribe(runChannel(requestId));
    client.publish(BRIDGE_COMMAND_CHANNEL, {
      type: 'send_text',
      data: { text: 'hello', client_request_id: requestId },
    });
    await waitFor(() =>
      events.some((event) => event.type === 'response' && event.data?.request_id === requestId)
    );

    client.publish(BRIDGE_COMMAND_CHANNEL, {
      rpc: 1,
      id: 'rpc_status_1',
      method: 'status.get',
      params: {},
    });
    client.publish(BRIDGE_COMMAND_CHANNEL, {
      rpc: 1,
      id: 'rpc_status_2',
      method: 'status.get',
      params: {},
    });
    await waitFor(() =>
      rpcResponses.some((r) => r.id === 'rpc_status_1') && rpcResponses.some((r) => r.id === 'rpc_status_2')
    );

    client.publish(BRIDGE_COMMAND_CHANNEL, { type: 'get_models', data: {} });
    await waitFor(() =>
      events.some((event) =>
        event.type === 'error'
        && String(event.data?.message ?? '').includes('Legacy unary command removed')
      )
    );

    harness.setSessionAsyncRun(sessionKey, {
      requestId: 'req_async',
      goal: 'integration goal',
      cancelled: false,
      startedAt: Date.now() - 500,
    });
    client.publish(BRIDGE_COMMAND_CHANNEL, {
      rpc: 1,
      id: 'rpc_async_cancel',
      method: 'async.cancel',
      params: { session_key: sessionKey },
    });
    await waitFor(() =>
      rpcResponses.some((r) => r.id === 'rpc_async_cancel')
      && events.some((event) =>
        event.type === 'response'
        && isRecord(event.data?.metadata)
        && event.data.metadata.kind === 'async_complete'
      )
    );

    client.publish(BRIDGE_COMMAND_CHANNEL, {
      rpc: 1,
      id: 'rpc_model_set',
      method: 'model.set',
      params: { provider: 'openai', model: 'gpt-4.1' },
    });
    await waitFor(() =>
      rpcResponses.some((r) => r.id === 'rpc_model_set')
      && events.some((event) => event.type === 'model_changed')
    );

    client.publish(BRIDGE_COMMAND_CHANNEL, {
      rpc: 1,
      id: 'rpc_cp_pause',
      method: 'control.stop',
      params: { session_key: sessionKey, action: 'pause', note: 'pause note' },
    });
    client.publish(BRIDGE_COMMAND_CHANNEL, {
      rpc: 1,
      id: 'rpc_cp_resume',
      method: 'control.stop',
      params: { session_key: sessionKey, action: 'resume', note: 'resume note' },
    });
    client.publish(BRIDGE_COMMAND_CHANNEL, {
      rpc: 1,
      id: 'rpc_cp_cancel',
      method: 'control.stop',
      params: { session_key: sessionKey, action: 'cancel', note: 'cancel note' },
    });
    await waitFor(() => harness.controlCalls.length >= 4);
    const lastThree = harness.controlCalls.slice(-3);
    expect(lastThree[0]?.action).toBe('pause');
    expect(lastThree[1]?.action).toBe('resume');
    expect(lastThree[2]?.action).toBe('cancel');
    expect(lastThree[0]?.requestedBy).toBe('system');
    expect(lastThree[1]?.requestedBy).toBe('system');
    expect(lastThree[2]?.requestedBy).toBe('system');

    client.close();
    await server.stop();
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
