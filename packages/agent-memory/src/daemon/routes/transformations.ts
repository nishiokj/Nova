/**
 * Transformation Routes
 *
 * HTTP endpoints for listing registered transformations.
 */

import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'

export function registerTransformationRoutes(server: HttpServer, daemon: SyncDaemon): void {
  const { engine } = daemon

  server.get('/transformations', async (req) => {
    const { connector, entityType } = req.query

    const entityTypes = typeof entityType === 'string'
      ? entityType.split(',').map((t) => t.trim()).filter(Boolean)
      : []

    const transforms = connector
      ? engine.listTransformations(connector as any)
      : engine.listTransformations()

    const filtered = entityTypes.length > 0
      ? transforms.filter((t) => entityTypes.includes(t.source.entityType))
      : transforms

    const result = filtered.map((t) => ({
      id: t.id,
      name: t.name,
      source: t.source,
      outputType: t.outputType,
      enabled: t.enabled,
      version: t.version,
      description: t.description,
    }))

    return { body: { transformations: result } }
  })
}
