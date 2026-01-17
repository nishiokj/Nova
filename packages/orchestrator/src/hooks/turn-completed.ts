/**
 * Turn Completed Hook
 *
 * Fired after each agent turn (LLM call + tool execution).
 * Use for: progress tracking, metrics, review triggers.
 */

import type { InternalHookEvent, InternalHookContext } from 'agent';

type TurnCompletedEvent = Extract<InternalHookEvent, { type: 'turn_completed' }>;

export async function handle(
  event: TurnCompletedEvent,
  ctx: InternalHookContext
): Promise<void> {
  console.error(
    `[HOOK:turn_completed] agent=${ctx.agentType} iteration=${event.iteration} ` +
    `tools=${event.toolCallsMade} llm=${event.llmCallsMade} hasResponse=${event.hasResponse}`
  );

  // TODO: Implement actual handlers
  // - Update progress metrics
  // - Check for stagnation patterns
  // - Trigger progress review if needed
}
