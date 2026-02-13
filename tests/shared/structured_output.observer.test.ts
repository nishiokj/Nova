import { parseAndValidateOutput } from 'shared/structured_output.js';

describe('structured_output baseline parsing', () => {
  it('parses agent_action output', () => {
    const parsed = parseAndValidateOutput(
      'agent_action',
      JSON.stringify({
        action: 'done',
        response: 'done',
        goalStateReached: true,
        awaitingUserInput: false,
      })
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.action).toBe('done');
  });
});
