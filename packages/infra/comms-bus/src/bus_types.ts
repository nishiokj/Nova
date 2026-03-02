/**
 * Bus protocol types for WebSocket transport.
 */

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
