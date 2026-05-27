import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_COMMAND_CHANNEL,
  NOVA_PROTOCOL_VERSION,
  isBridgeCommand,
  isBridgeEvent,
  isBusClientMessage,
  isBusServerMessage,
  isRpcRequest,
  isRpcResponse,
  runChannel,
  sessionChannel,
  type BusMessage,
} from '@nova/protocol';

interface ConformanceFixture {
  version: string;
  channels: {
    bridgeCommand: string;
    run: string;
    session: string;
  };
  busClientMessages: unknown[];
  busServerMessages: unknown[];
  bridgeCommands: unknown[];
  bridgeEvents: unknown[];
  rpcRequests: unknown[];
  rpcResponses: unknown[];
}

function loadFixture(): ConformanceFixture {
  const fixturePath = path.resolve(process.cwd(), 'packages/core/protocol/fixtures/conformance.json');
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as ConformanceFixture;
}

describe('protocol conformance fixtures', () => {
  it('match the exported protocol constants and validators', () => {
    const fixture = loadFixture();

    expect(fixture.version).toBe(NOVA_PROTOCOL_VERSION);
    expect(fixture.channels.bridgeCommand).toBe(BRIDGE_COMMAND_CHANNEL);
    expect(fixture.channels.run).toBe(runChannel('req_abc123'));
    expect(fixture.channels.session).toBe(sessionChannel('sess_abc123'));

    for (const message of fixture.busClientMessages) {
      expect(isBusClientMessage(message as BusMessage)).toBe(true);
    }
    for (const message of fixture.busServerMessages) {
      expect(isBusServerMessage(message as BusMessage)).toBe(true);
    }
    for (const command of fixture.bridgeCommands) {
      expect(isBridgeCommand(command)).toBe(true);
    }
    for (const event of fixture.bridgeEvents) {
      expect(isBridgeEvent(event)).toBe(true);
    }
    for (const request of fixture.rpcRequests) {
      expect(isRpcRequest(request)).toBe(true);
    }
    for (const response of fixture.rpcResponses) {
      expect(isRpcResponse(response)).toBe(true);
    }
  });
});
