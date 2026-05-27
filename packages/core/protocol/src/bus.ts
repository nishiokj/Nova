/**
 * Nova WebSocket bus protocol.
 *
 * This package is the language-neutral contract surface. Runtime packages can
 * implement transports in Node, Bun, browsers, Python, or elsewhere without
 * depending on daemon internals.
 */

export const NOVA_PROTOCOL_VERSION = '0.1';

export const BRIDGE_COMMAND_CHANNEL = 'bridge_command';

export function runChannel(requestId: string): string {
  return `run:${requestId}`;
}

export function sessionChannel(sessionKey: string): string {
  return `session:${sessionKey}`;
}

export type BusClientMessage =
  | {
      type: 'subscribe';
      channel: string;
    }
  | {
      type: 'unsubscribe';
      channel: string;
    }
  | {
      type: 'publish';
      channel: string;
      payload: unknown;
    };

export type BusServerMessage =
  | {
      type: 'event';
      channel: string;
      payload: unknown;
    }
  | {
      type: 'error';
      message: string;
      detail?: unknown;
    };

export type BusMessage = BusClientMessage | BusServerMessage;

export function isBusClientMessage(message: BusMessage): message is BusClientMessage {
  return (
    message.type === 'subscribe' ||
    message.type === 'unsubscribe' ||
    message.type === 'publish'
  );
}

export function isBusServerMessage(message: BusMessage): message is BusServerMessage {
  return message.type === 'event' || message.type === 'error';
}
