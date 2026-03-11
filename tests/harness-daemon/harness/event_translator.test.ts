import type { AgentEvent } from 'types';
import { translateAgentEvent } from 'harness-daemon/harness/event_translator.js';

// Helper to create a minimal AgentEvent
function makeEvent(type: string, data: Record<string, unknown>, requestId = 'req-1'): AgentEvent {
  return { type, data, requestId, timestamp: Date.now() / 1000 } as AgentEvent;
}

describe('translateAgentEvent', () => {
  describe('workitem_status does not fall through to tool_call', () => {
    it('returns progress event for known statuses', () => {
      for (const status of ['started', 'completed', 'failed', 'skipped'] as const) {
        const event = makeEvent('workitem_status', {
          status,
          objective: 'test objective',
        });
        const result = translateAgentEvent(event);
        expect(result).not.toBeNull();
        expect(result!.type).toBe('progress');
        const data = result!.data as Record<string, unknown>;
        expect(data.kind).toBe('work');
      }
    });

    it('returns null (not a tool_call event) when inner status is unrecognized', () => {
      // This is the P0 fallthrough bug: before the fix, an unrecognized status
      // would fall through from the workitem_status case into the tool_call case,
      // producing a tool_call progress event from workitem data.
      const event = makeEvent('workitem_status', {
        status: 'some_future_status',
        objective: 'test',
      });
      const result = translateAgentEvent(event);

      // Should be null — unrecognized inner status, nothing to translate
      if (result !== null) {
        // If we get here, the fallthrough bug exists: workitem data is being
        // processed as tool_call data
        const data = result.data as Record<string, unknown>;
        expect(data.kind).not.toBe('tool'); // This would fail before the fix
      }
      expect(result).toBeNull();
    });

    it('tool_call events still translate correctly', () => {
      const event = makeEvent('tool_call', {
        toolName: 'Bash',
        phase: 'starting',
      });
      const result = translateAgentEvent(event);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('progress');
      const data = result!.data as Record<string, unknown>;
      expect(data.kind).toBe('tool');
      expect(data.tool_name).toBe('Bash');
    });
  });

  describe('unhandled event types return null', () => {
    it('returns null for events without a translation', () => {
      const event = makeEvent('files_modified', { paths: ['/foo.ts'] });
      expect(translateAgentEvent(event)).toBeNull();
    });
  });
});
