/**
 * Tests for BridgeGateway wiring.
 */

import { BusServer, BusClient, BRIDGE_COMMAND_CHANNEL, runChannel } from 'comms-bus';
import { isRpcResponse } from '@nova/client';
import { BridgeGateway } from 'harness-daemon/harness/bridge_gateway.js';
import { createReadyEvent } from 'harness-daemon/harness/event_translator.js';
import type { AgentRunHandle, BridgeEvent } from 'harness-daemon/harness/types.js';
import type { FullHarnessConfig } from 'harness-daemon/harness/config.js';
import type { GraphDManager } from 'graphd';
import { readFileSync } from 'fs';
import path from 'path';

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
  private readonly sessionAsyncRuns = new Map<string, { requestId: string; goal: string; cancelled: boolean; startedAt: number }>();
  graphdEnabled = false;
  graphdCalls: Array<{
    method: 'sessionTouch' | 'sessionUpdateStatus' | 'sessionSetGoalIfEmpty';
    sessionKey: string;
    workingDir?: string;
    status?: string;
    goal?: string;
  }> = [];
  closedSessions: string[] = [];
  graphdGoalWriteError: Error | null = null;
  controlCalls: Array<{
    sessionKey: string;
    action: 'pause' | 'resume' | 'cancel';
    reason?: string;
    requestedBy?: 'user' | 'system' | 'policy';
  }> = [];
  controlDelayMs = 0;
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
      skills: { enabled: false, directory: '.agent/skills', definitions: [] },
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

  getSessionSelectedModel(_sessionKey: string, _agentType: string): { provider: string; model: string; contextWindow: number } {
    return { provider: 'openai', model: 'test-model', contextWindow: 128_000 };
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

  getGraphD(): GraphDManager | null {
    if (!this.graphdEnabled) {
      return null;
    }
    return {
      sessionTouch: (sessionKey: string, workingDir?: string) => {
        this.graphdCalls.push({ method: 'sessionTouch', sessionKey, workingDir });
        return { success: true };
      },
      sessionUpdateStatus: (sessionKey: string, status: string) => {
        this.graphdCalls.push({ method: 'sessionUpdateStatus', sessionKey, status });
        return { success: true };
      },
      sessionSetGoalIfEmpty: (sessionKey: string, goal: string) => {
        if (this.graphdGoalWriteError) {
          throw this.graphdGoalWriteError;
        }
        this.graphdCalls.push({ method: 'sessionSetGoalIfEmpty', sessionKey, goal });
        return true;
      },
    } as unknown as GraphDManager;
  }

  closeSession(sessionKey: string): { success: boolean } {
    this.closedSessions.push(sessionKey);
    if (this.graphdEnabled) {
      this.graphdCalls.push({ method: 'sessionUpdateStatus', sessionKey, status: 'inactive' });
    }
    return { success: true };
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
    if (this.controlDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.controlDelayMs));
    }
    this.controlCalls.push(params);
    return {
      success: true,
      requestId: 'req_control',
      quiesced: params.action !== 'resume',
    };
  }

  setSessionAsyncRun(sessionKey: string, info: { requestId: string; goal: string; cancelled: boolean; startedAt: number }): void {
    this.sessionAsyncRuns.set(sessionKey, info);
  }

  getSessionAsyncRun(sessionKey: string): { requestId: string; goal: string; cancelled: boolean; startedAt: number } | null {
    return this.sessionAsyncRuns.get(sessionKey) ?? null;
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
    // no-op in test harness
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

  it('writes GraphD session lifecycle state from bus init and close', async () => {
    const harness = new FakeHarness();
    harness.graphdEnabled = true;
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

    const sessionKey = 'graphd-session-lifecycle';
    const workingDir = '/workspace/project';
    client.publish(BRIDGE_COMMAND_CHANNEL, {
      type: 'init',
      data: { session_key: sessionKey, working_dir: workingDir },
    });
    await waitFor(() => events.some((event) => event.type === 'ready'));

    expect(harness.graphdCalls).toContainEqual({
      method: 'sessionTouch',
      sessionKey,
      workingDir,
    });
    expect(harness.graphdCalls).toContainEqual({
      method: 'sessionUpdateStatus',
      sessionKey,
      status: 'active',
    });

    client.publish(BRIDGE_COMMAND_CHANNEL, {
      rpc: 1,
      id: 'rpc_session_close',
      method: 'session.close',
      params: {},
    });
    await waitFor(() => rpcResponses.some((response) => response.id === 'rpc_session_close'));

    expect(harness.closedSessions).toContain(sessionKey);
    expect(harness.graphdCalls).toContainEqual({
      method: 'sessionUpdateStatus',
      sessionKey,
      status: 'inactive',
    });

    client.close();
    await server.stop();
  });

  it('does not let GraphD goal write failures block a user message', async () => {
    const harness = new FakeHarness();
    harness.graphdEnabled = true;
    harness.graphdGoalWriteError = new Error('GraphD goal write failed');
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
      if (isRecord(payload) && typeof payload.type === 'string') {
        events.push(payload as BridgeEvent);
      }
    });
    await client.connect();

    const sessionKey = 'graphd-goal-failure';
    const requestId = 'req_graphd_goal_failure';
    client.subscribe(runChannel(requestId));
    client.publish(BRIDGE_COMMAND_CHANNEL, { type: 'init', data: { session_key: sessionKey } });
    await waitFor(() => events.some((event) => event.type === 'ready'));

    client.publish(BRIDGE_COMMAND_CHANNEL, {
      type: 'send_text',
      data: { text: 'hello despite graphd', client_request_id: requestId },
    });
    await waitFor(
      () => events.some((event) => event.type === 'response' && event.data?.request_id === requestId),
      500
    );

    expect(harness.lastRunSessionKey).toBe(sessionKey);
    expect(events.some((event) =>
      event.type === 'error'
      && String(event.data?.message ?? '').includes('GraphD goal write failed')
    )).toBe(false);

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

  it('rejects legacy unary commands after rpc cutover', async () => {
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

    client.publish(BRIDGE_COMMAND_CHANNEL, { type: 'get_models', data: {} });
    await waitFor(() => events.some((event) => event.type === 'error'));

    const errorEvent = events.find((event) => event.type === 'error');
    expect(String(errorEvent?.data?.message ?? '')).toContain('Legacy unary command removed');

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
    const rpcResponses: Array<Record<string, unknown>> = [];
    client.on('event', (payload) => {
      if (isRpcResponse(payload)) {
        rpcResponses.push(payload as Record<string, unknown>);
      }
    });
    await client.connect();

    client.publish(BRIDGE_COMMAND_CHANNEL, { rpc: 1, id: 'rpc_memory', method: 'control.memory_info', params: {} });
    await waitFor(() => rpcResponses.length > 0);

    const response = rpcResponses[0];
    if (!response || !isRecord(response.result)) {
      throw new Error('Expected RPC control.memory_info response');
    }
    const payload = response.result;
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
      rpc: 1,
      id: 'rpc_cp_stop',
      method: 'control.stop',
      params: {
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

  it('preserves async.cancel rpc response when async_complete side-effect event is emitted', async () => {
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
    const rpcResponses: Array<Record<string, unknown>> = [];
    const allEvents: BridgeEvent[] = [];
    const responseEvents: BridgeEvent[] = [];
    client.on('event', (payload) => {
      if (isRpcResponse(payload)) {
        rpcResponses.push(payload as Record<string, unknown>);
      }
      if (isRecord(payload) && typeof payload.type === 'string') {
        allEvents.push(payload as BridgeEvent);
      }
      if (isRecord(payload) && payload.type === 'response') {
        responseEvents.push(payload as BridgeEvent);
      }
    });
    await client.connect();

    const sessionKey = 'async-cancel-session';
    client.publish(BRIDGE_COMMAND_CHANNEL, { type: 'init', data: { session_key: sessionKey } });
    await waitFor(() => allEvents.some((event) => event.type === 'ready'));

    harness.setSessionAsyncRun(sessionKey, {
      requestId: 'req_async_cancel',
      goal: 'test goal',
      cancelled: false,
      startedAt: Date.now() - 1_000,
    });

    client.publish(BRIDGE_COMMAND_CHANNEL, {
      rpc: 1,
      id: 'rpc_async_cancel',
      method: 'async.cancel',
      params: { session_key: sessionKey },
    });

    await waitFor(() => rpcResponses.length > 0 && responseEvents.some((event) =>
      event.type === 'response'
      && isRecord(event.data?.metadata)
      && event.data.metadata.kind === 'async_complete'
    ));

    const rpc = rpcResponses[0];
    expect(isRecord(rpc?.result)).toBe(true);
    if (!isRecord(rpc?.result)) {
      throw new Error('Expected rpc async.cancel result payload');
    }
    expect(rpc.result.success).toBe(true);
    expect(rpc.result.requestId).toBe('req_async_cancel');
    expect(rpc.result.goal).toBe('test goal');

    const asyncComplete = responseEvents.find((event) =>
      event.type === 'response'
      && isRecord(event.data?.metadata)
      && event.data.metadata.kind === 'async_complete'
    );
    expect(asyncComplete).toBeDefined();

    client.close();
    await server.stop();
  });

  it('serializes concurrent same-method rpc calls on one connection', async () => {
    const harness = new FakeHarness();
    harness.controlDelayMs = 15;
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

    const sessionKey = 'rpc-queue-session';
    client.publish(BRIDGE_COMMAND_CHANNEL, { type: 'init', data: { session_key: sessionKey } });
    await waitFor(() => events.some((event) => event.type === 'ready'));

    client.publish(BRIDGE_COMMAND_CHANNEL, {
      rpc: 1,
      id: 'rpc_stop_1',
      method: 'control.stop',
      params: { session_key: sessionKey, action: 'cancel', note: 'first' },
    });
    client.publish(BRIDGE_COMMAND_CHANNEL, {
      rpc: 1,
      id: 'rpc_stop_2',
      method: 'control.stop',
      params: { session_key: sessionKey, action: 'cancel', note: 'second' },
    });

    await waitFor(() => rpcResponses.length >= 2, 800);
    const first = rpcResponses.find((entry) => entry.id === 'rpc_stop_1');
    const second = rpcResponses.find((entry) => entry.id === 'rpc_stop_2');
    expect(isRecord(first?.result)).toBe(true);
    expect(isRecord(second?.result)).toBe(true);
    if (isRecord(first?.result)) {
      expect(first.result.success).toBe(true);
    }
    if (isRecord(second?.result)) {
      expect(second.result.success).toBe(true);
    }
    expect(harness.controlCalls).toHaveLength(2);
    expect(harness.controlCalls[0]?.reason).toBe('first');
    expect(harness.controlCalls[1]?.reason).toBe('second');

    client.close();
    await server.stop();
  });

  it('keeps migrated unary rpc handlers out of bridge_gateway.ts', () => {
    const sourcePath = path.resolve(process.cwd(), 'packages/infra/harness-daemon/src/harness/bridge_gateway.ts');
    const source = readFileSync(sourcePath, 'utf8');
    const bannedSignatures = [
      'private handleGetConfig(',
      'private handleGetStatus(',
      'private handleGetModels(',
      'private handleModelsDelete(',
      'private handleSkills',
      'private handleHooks',
      'private handleAuth',
      'private handleProviders',
      'private handleSessionFork(',
      'private handleSessionClose(',
      'private handleSessionDelete(',
      'private handleUsageSummary(',
      'private handleCompactContext(',
      'private handleSetModel(',
      'private handleGetModel(',
      'private handleSetDangerousMode(',
      'private handleControlPlane',
      'private handleAsyncStart(',
      'private handleAsyncCancel(',
      'private handleAsyncStatus(',
      'private invokeRpcMethod(',
    ];
    for (const signature of bannedSignatures) {
      expect(source).not.toContain(signature);
    }
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
