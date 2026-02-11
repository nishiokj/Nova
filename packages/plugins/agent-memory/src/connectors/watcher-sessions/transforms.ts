/**
 * Watcher Sessions Transformations
 *
 * NOTE: The watcher session data doesn't map to canonical entities
 * (message, conversation, etc.). Instead, it's synced as raw envelopes
 * and processed by a derived task into the agent_actions table.
 *
 * @see packages/plugins/agent-memory/scripts/derive-watcher-actions.ts
 *
 * @module connectors/watcher-sessions/transforms
 */

import type { Transformation } from '../../transform/types.js'

// No canonical transformations - data flows:
// .watcher/*.jsonl -> raw_envelopes -> derive-watcher-actions.ts -> agent_actions

export const watcherSessionsTransforms: Transformation[] = []
