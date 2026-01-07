/**
 * Channel helpers for bridge bus routing.
 */

export const BRIDGE_COMMAND_CHANNEL = 'bridge_command';

export function runChannel(requestId: string): string {
  return `run:${requestId}`;
}

export function sessionChannel(sessionKey: string): string {
  return `session:${sessionKey}`;
}
