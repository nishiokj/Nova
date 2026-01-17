/**
 * Agent Completed Hook
 *
 * Fired when agent execution completes (success or failure).
 * Use for: work settlement, finding consolidation, cleanup.
 */

import type { InternalHookEvent, InternalHookContext } from 'agent';

type AgentCompletedEvent = Extract<InternalHookEvent, { type: 'agent_completed' }>;

export async function handle(
  event: AgentCompletedEvent,
  ctx: InternalHookContext
): Promise<void> {
  console.error(
    `[HOOK:agent_completed] workId=${event.workId} success=${event.success} ` +
    `reason=${event.terminationReason} filesRead=${event.filesRead.length} ` +
    `invalidated=${event.invalidatedPaths.length}`
  );

  // TODO: Implement actual handlers
  // - Settle work item in ledger
  // - Consolidate findings
  // - Clean up temporary state
}
