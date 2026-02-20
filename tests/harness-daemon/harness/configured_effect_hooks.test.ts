import { ConfiguredEffectHooksRunner } from 'harness-daemon/harness/configured_effect_hooks.js';
import type { HookContext, HookDefinition } from 'harness-daemon/harness/skills_loader.js';

describe('ConfiguredEffectHooksRunner', () => {
  it('cancels command hooks when the abort signal is triggered', async () => {
    const runner = new ConfiguredEffectHooksRunner(process.cwd());
    const controller = new AbortController();

    const hook: HookDefinition = {
      id: 'abortable-hook',
      name: 'Abortable Hook',
      description: 'Long-running command for abort test',
      enabled: true,
      trigger: 'PreToolUse',
      priority: 0,
      timeout_ms: 30_000,
      fail_open: true,
      hooks: [
        {
          type: 'command',
          command: 'sleep 10',
        },
      ],
      sourcePath: 'inline',
    };

    const context: HookContext = {
      event: 'PreToolUse',
      sessionKey: 'session-abort',
      requestId: 'req-abort',
      workingDir: process.cwd(),
    };

    setTimeout(() => controller.abort('test_abort'), 50);
    const startedAt = Date.now();
    const result = await runner.execute(hook, context, controller.signal);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2_500);
    expect(result.action).toBe('allow');
    expect(controller.signal.aborted).toBe(true);
  });
});
