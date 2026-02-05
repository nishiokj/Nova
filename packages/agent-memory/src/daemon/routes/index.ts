/**
 * Route Registration
 *
 * Registers all API routes with the HTTP server.
 */

import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { registerAccountRoutes } from './accounts.js'
import { registerTaskRoutes } from './tasks.js'
import { registerJobRoutes } from './jobs.js'
import { registerDerivedTaskRoutes } from './derived-tasks.js'
import { registerDerivedJobRoutes } from './derived-jobs.js'
import { registerProcessRoutes } from './process.js'
import { registerTransformationRoutes } from './transformations.js'
import { registerAuthRoutes } from './auth.js'
import { registerWebhookRoutes } from './webhooks.js'
import { registerDataRoutes } from './data.js'
import { registerConnectorRoutes } from './connectors.js'
import { registerPreferencesRoutes } from './preferences.js'
import { registerDecisionsRoutes } from './decisions.js'
import { registerEventRoutes } from './events.js'
import { registerGoalsRoutes } from './agent-goals.js'
import { registerActionsRoutes } from './agent-actions.js'
import { registerTracesRoutes } from './agent-traces.js'
import { registerEvidenceRoutes } from './evidence.js'
import { registerMemoryRoutes } from './memory.js'
import { registerControlPlaneRoutes } from './control-plane.js'

/**
 * Register all API routes.
 */
export function registerRoutes(server: HttpServer, daemon: SyncDaemon): void {
  registerAccountRoutes(server, daemon)
  registerTaskRoutes(server, daemon)
  registerJobRoutes(server, daemon)
  registerDerivedTaskRoutes(server, daemon)
  registerDerivedJobRoutes(server, daemon)
  registerProcessRoutes(server, daemon)
  registerTransformationRoutes(server, daemon)
  registerAuthRoutes(server, daemon)
  registerWebhookRoutes(server, daemon)
  registerDataRoutes(server, daemon)
  registerConnectorRoutes(server, daemon)
  registerPreferencesRoutes(server, daemon)
  registerDecisionsRoutes(server, daemon.decisionsRepo)
  registerEventRoutes(server, daemon)
  registerGoalsRoutes(server, daemon.goalsRepo)
  registerActionsRoutes(server, daemon.actionsRepo)
  registerTracesRoutes(server, daemon.tracesRepo)
  registerEvidenceRoutes(server, daemon)
  registerMemoryRoutes(server, daemon)
  registerControlPlaneRoutes(server, daemon)
}

export { registerAccountRoutes } from './accounts.js'
export { registerTaskRoutes } from './tasks.js'
export { registerJobRoutes } from './jobs.js'
export { registerDerivedTaskRoutes } from './derived-tasks.js'
export { registerDerivedJobRoutes } from './derived-jobs.js'
export { registerProcessRoutes } from './process.js'
export { registerTransformationRoutes } from './transformations.js'
export { registerAuthRoutes } from './auth.js'
export { registerWebhookRoutes } from './webhooks.js'
export { registerDataRoutes } from './data.js'
export { registerConnectorRoutes } from './connectors.js'
export { registerPreferencesRoutes } from './preferences.js'
export { registerDecisionsRoutes } from './decisions.js'
export { registerEventRoutes } from './events.js'
export { registerGoalsRoutes } from './agent-goals.js'
export { registerActionsRoutes } from './agent-actions.js'
export { registerTracesRoutes } from './agent-traces.js'
export { registerEvidenceRoutes } from './evidence.js'
export { registerMemoryRoutes } from './memory.js'
export { registerControlPlaneRoutes } from './control-plane.js'
