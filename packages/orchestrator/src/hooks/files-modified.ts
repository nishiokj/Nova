/**
 * Files Modified Hook
 *
 * Fired when agent writes/edits files.
 * Use for: cache invalidation, lint queueing, change tracking.
 */

import type { InternalHookEvent, InternalHookContext } from 'agent';

type FilesModifiedEvent = Extract<InternalHookEvent, { type: 'files_modified' }>;

export async function handle(
  event: FilesModifiedEvent,
  ctx: InternalHookContext
): Promise<void> {
  console.error(
    `[HOOK:files_modified] agent=${ctx.agentType} paths=[${event.paths.join(',')}]`
  );

  // TODO: Implement actual handlers
  // - Invalidate file cache entries
  // - Queue files for linting/validation
  // - Track changes for rollback capability
}
