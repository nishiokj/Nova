/**
 * Tests for BridgeGateway wiring.
 */

import { BusServer, BusClient, BRIDGE_COMMAND_CHANNEL, runChannel } from 'comms-bus';
import { BridgeGateway } from 'harness-daemon/harness/bridge_gateway.js';
import { createReadyEvent } from 'harness-daemon/harness/event_translator.js';
import type { AgentRunHandle, BridgeEvent } from 'harness-daemon/harness/types.js';
import type { FullHarnessConfig } from 'harness-daemon/harness/config.js';

function waitFor(predicate: () => boolean, timeoutMs = 300): Promise<void> {
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
  lastRunSessionKey: string | null = null;
  controlCalls: Array<{
    sessionKey: string;
    action: 'pause' | 'resume' | 'cancel';
    reason?: string;
    requestedBy?: 'user' | 'system' | 'policy';
  }> = [];
  private readonly config: FullHarnessConfig;

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
      tools: { workingDir: process.cwd(), bashTimeoutMs: 1, maxOutputLength: 1 },
      graphd: { enabled: false, host: '127.0.0.1', port: 0, dbPath: '' },
      context: { maxTokens: 1 },
      skills: { enabled: false, directory: 'config/skills', definitions: [] },
      hooks: { enabled: false, directory: 'config/hooks', definitions: [] },
    };
  }

  run(params: { requestId: string; inputText: string; sessionKey: string }): AgentRunHandle {
    this.lastRunSessionKey = params.sessionKey;
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

  getSessionSelectedModel(_sessionKey: string, _agentType: string): { provider: string; model: string } {
    return { provider: 'openai', model: 'test-model' };
  }

  getDebugMemoryInfo(): {
    sessionCount: number;
    maxSessions: number;
    sessions: Array<{
      sessionKey: string;
      contextItemCount: number;
      contextEstimatedTokens: number;
      workItemsCreatedCount: number;
      lastAccessMs: number;
      isExecuting: boolean;
    }>;
  } {
    return {
      sessionCount: 1,
      maxSessions: 200,
      sessions: [{
        sessionKey: 'sess-memory',
        contextItemCount: 0,
        contextEstimatedTokens: 0,
        workItemsCreatedCount: 0,
        lastAccessMs: Date.now(),
        isExecuting: false,
      }],
    };
  }

  getConfig(): FullHarnessConfig {
    return this.config;
  }

  isShuttingDown(): boolean {
    return false;
  }

  async shutdown(): Promise<void> {
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
}

describe('BridgeGateway', () => {
  it('routes init and send_text over the bus', async () => {
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
    client.on('event', (payload) => {
      events.push(payload as BridgeEvent);
    });
    await client.connect();

    client.publish(BRIDGE_COMMAND_CHANNEL, { type: 'init', data: {} });
    await waitFor(() => events.some((event) => event.type === 'ready'));

    const ready = events.find((event) => event.type === 'ready')!;
    const sessionKey = (ready.data as { session_key?: string }).session_key ?? '';
    expect(sessionKey).not.toBe('');

    const requestId = 'req_test';
    client.subscribe(runChannel(requestId));
    client.publish(BRIDGE_COMMAND_CHANNEL, {
      type: 'send_text',
      data: { text: 'hello', client_request_id: requestId },
    });

    await waitFor(
      () => events.some((event) => event.type === 'response' && event.data?.request_id === requestId),
      500
    );

    expect(harness.lastRunSessionKey).toBe(sessionKey);

    client.close();
    await server.stop();
  });

  it('emits an error when bridge payload is invalid', async () => {
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
    client.on('event', (payload) => {
      events.push(payload as BridgeEvent);
    });
    await client.connect();

    client.publish(BRIDGE_COMMAND_CHANNEL, 'bad payload');
    await waitFor(() => events.some((event) => event.type === 'error'));

    const errorEvent = events.find((event) => event.type === 'error');
    expect(String(errorEvent?.data?.message ?? '')).toContain('Invalid bridge command payload');

    client.close();
    await server.stop();
  });

  it('returns debug memory info over control-plane bridge command', async () => {
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
    client.on('event', (payload) => {
      events.push(payload as BridgeEvent);
    });
    await client.connect();

    client.publish(BRIDGE_COMMAND_CHANNEL, { type: 'control_plane_memory_info', data: {} });
    await waitFor(() => events.some((event) =>
      event.type === 'response'
      && isRecord(event.data?.metadata)
      && event.data.metadata.kind === 'control_plane_memory_info'
    ));

    const response = events.find((event) =>
      event.type === 'response'
      && isRecord(event.data?.metadata)
      && event.data.metadata.kind === 'control_plane_memory_info'
    );
    if (!response || !isRecord(response.data?.metadata)) {
      throw new Error('Expected control_plane_memory_info response');
    }
    const payload = response.data.metadata.payload;
    expect(isRecord(payload)).toBe(true);
    if (!isRecord(payload)) {
      throw new Error('Expected payload record');
    }
    expect(payload.success).toBe(true);
    expect(payload.sessionCount).toBe(1);
    expect(Array.isArray(payload.sessions)).toBe(true);

    client.close();
    await server.stop();
  });

  it('routes /pause and /resume commands through runtime control operations', async () => {
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
    client.on('event', (payload) => {
      events.push(payload as BridgeEvent);
    });
    await client.connect();

    client.publish(BRIDGE_COMMAND_CHANNEL, { type: 'init', data: {} });
    await waitFor(() => events.some((event) => event.type === 'ready'));

    client.publish(BRIDGE_COMMAND_CHANNEL, {
      type: 'send_text',
      data: { text: '/pause hold here' },
    });
    await waitFor(() =>
      events.some((event) =>
        event.type === 'response'
        && isRecord(event.data?.metadata)
        && event.data.metadata.kind === 'control_plane_stop'
      )
    );

    client.publish(BRIDGE_COMMAND_CHANNEL, {
      type: 'send_text',
      data: { text: '/resume continue' },
    });
    await waitFor(() => harness.controlCalls.length >= 2);

    expect(harness.controlCalls[0]?.action).toBe('pause');
    expect(harness.controlCalls[0]?.reason).toContain('hold here');
    expect(harness.controlCalls[1]?.action).toBe('resume');
    expect(harness.controlCalls[1]?.reason).toContain('continue');

    client.close();
    await server.stop();
  });

  it('routes control_plane_stop cancel action through runtime control operation', async () => {
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
    client.on('event', (payload) => {
      events.push(payload as BridgeEvent);
    });
    await client.connect();

    const sessionKey = 'cp-stop-session';
    client.publish(BRIDGE_COMMAND_CHANNEL, { type: 'init', data: { session_key: sessionKey } });
    await waitFor(() => events.some((event) => event.type === 'ready'));

    client.publish(BRIDGE_COMMAND_CHANNEL, {
      type: 'control_plane_stop',
      data: {
        session_key: sessionKey,
        action: 'cancel',
        note: 'cancel from control plane',
      },
    });
    await waitFor(() => harness.controlCalls.length >= 1);

    expect(harness.controlCalls[0]?.action).toBe('cancel');
    expect(harness.controlCalls[0]?.reason).toBe('cancel from control plane');
    expect(harness.controlCalls[0]?.requestedBy).toBe('system');

    client.close();
    await server.stop();
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
