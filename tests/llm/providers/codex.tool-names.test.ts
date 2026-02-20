import { CodexProvider } from 'llm/providers/codex.js';

describe('CodexProvider tool name normalization', () => {
  it('normalizes namespaced function_call history names for request input', () => {
    const provider = new CodexProvider();

    const input = (provider as any).formatInput([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'functions.exec_command',
        arguments: { command: 'ls -la' },
      },
    ]);

    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      name: 'shell_command',
      arguments: { command: 'ls -la' },
    });
  });

  it('translates namespaced codex tool calls back to rex tool names', () => {
    const provider = new CodexProvider();

    const calls = (provider as any).parseToolCalls({
      output: [
        {
          type: 'function_call',
          call_id: 'call_2',
          name: 'functions.exec_command',
          arguments: JSON.stringify({ command: 'pwd', timeout_ms: 2000 }),
        },
      ],
    });

    expect(calls).toEqual([
      {
        id: 'call_2',
        name: 'Bash',
        arguments: { command: 'pwd', timeout: 2 },
      },
    ]);
  });
});
