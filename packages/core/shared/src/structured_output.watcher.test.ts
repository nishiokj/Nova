import { describe, expect, it } from 'bun:test';
import { getWatcherSchemaJsonForActions, parseAndValidateOutput } from './structured_output.js';

describe('watcher_action stop_work_item consistency', () => {
  it('parses stop_work_item output with escalationId', () => {
    const parsed = parseAndValidateOutput(
      'watcher_action',
      JSON.stringify({
        action: 'done',
        response: 'pause this work item',
        goalStateReached: true,
        awaitingUserInput: false,
        watcherAction: 'stop_work_item',
        reason: 'Escalation required for policy decision',
        escalationId: 'escalation_123',
      })
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.watcherAction).toBe('stop_work_item');
    if (parsed?.watcherAction === 'stop_work_item') {
      expect(parsed.escalationId).toBe('escalation_123');
    }
  });

  it('builds trigger-specific schema that includes stop_work_item', () => {
    const schema = getWatcherSchemaJsonForActions(['stop_work_item']);
    expect(JSON.stringify(schema.schema)).toContain('stop_work_item');
  });
});
