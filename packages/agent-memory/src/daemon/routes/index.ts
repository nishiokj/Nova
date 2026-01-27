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
