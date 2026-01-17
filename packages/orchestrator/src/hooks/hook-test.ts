/**
 * Hook Test (Turn Completed)
 *
 * Enable with REX_TEST_HOOK=1 to verify async hook execution.
 */

import type { InternalHookEvent, InternalHookContext } from 'agent';

type TurnCompletedEvent = Extract<InternalHookEvent, { type: 'turn_completed' }>;

export async function handle(
  event: TurnCompletedEvent,
  ctx: InternalHookContext
): Promise<void> {
  if (!process.env.REX_TEST_HOOK) {
    return;
  }

  console.info(
    `[HOOK:test] session=${ctx.sessionKey} workId=${ctx.workId} ` +
    `iteration=${event.iteration} tools=${event.toolCallsMade} llm=${event.llmCallsMade} ` +
    `response=${event.hasResponse}`
  );
}
