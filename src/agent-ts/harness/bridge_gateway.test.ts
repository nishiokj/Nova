/**
 * Tests for BridgeGateway wiring.
 */

import { describe, it, expect } from 'bun:test';
import { BusServer } from '../communication/bus_server.js';
import { BusClient } from '../communication/bus_client.js';
import { BRIDGE_COMMAND_CHANNEL, runChannel } from '../communication/bus_channels.js';
import { BridgeGateway } from './bridge_gateway.js';
import { createReadyEvent } from './event_translator.js';
import type { AgentRunHandle, BridgeEvent } from './types.js';
import type { FullHarnessConfig } from './config_types.js';

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
    return createReadyEvent(sessionKey);
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
});
