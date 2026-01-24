/**
 * Data Routes
 *
 * HTTP endpoints for querying schemas and entities.
 */

import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { notFound, badRequest } from '../server.js'
import type { EntityType } from '../../models/canonical.js'

export function registerDataRoutes(server: HttpServer, daemon: SyncDaemon): void {
  const { entityRepo, mappingRepo, envelopeRepo } = daemon

  // Get entity schemas for a connector
  server.get('/schemas/:connector', async (req) => {
    const { connector } = req.params

    const connectorInstance = daemon.getConnector(connector as any)
    if (!connectorInstance) {
      throw notFound(`Connector not found: ${connector}`)
    }

    // Get all supported entity types and their schemas
    const schemas: Record<string, { source: any; canonical: string }> = {}

    for (const entityType of connectorInstance.capabilities.supportedEntityTypes) {
      const sourceSchema = connectorInstance.getSourceSchema(entityType)
      const mapper = connectorInstance.getMapper(entityType)

      schemas[entityType] = {
        source: sourceSchema ? (sourceSchema as any).description || 'Schema available' : null,
        canonical: mapper?.targetEntityType || 'unknown',
      }
    }

    return { body: { connector, schemas } }
  })

  // Query canonical entities
  server.get('/entities', async (req) => {
    const { type, limit = '100', cursor } = req.query

    if (!type) {
      throw badRequest('Missing required query parameter: type')
    }

    // Query entities by type
    const result = await entityRepo.findByType(type as EntityType, {
      limit: parseInt(limit, 10),
      offset: cursor ? parseInt(cursor, 10) : 0,
    })

    return {
      body: {
        entities: result.items,
        total: result.total,
        hasMore: result.hasMore,
        nextCursor: result.hasMore ? String((cursor ? parseInt(cursor, 10) : 0) + parseInt(limit, 10)) : undefined,
      },
    }
  })

  // Get entity by ID with full lineage
  server.get('/entities/:id', async (req) => {
    const entity = await entityRepo.findById(req.params.id)
    if (!entity) {
      throw notFound(`Entity not found: ${req.params.id}`)
    }

    // Get source mappings
    const mappings = await mappingRepo.findByCanonicalEntity(entity.id)

    // Get raw envelopes for this entity
    const sources = await Promise.all(
      mappings.map((m) => envelopeRepo.findById(m.raw_envelope_id))
    )

    return {
      body: {
        entity,
        sources: sources.filter(Boolean),
        mappings,
      },
    }
  })

  // Get entity by source reference
  server.get('/entities/by-source/:sourceRefKey', async (req) => {
    const { sourceRefKey } = req.params

    // Find mapping by source
    const mapping = await mappingRepo.findBySourceRefKey(decodeURIComponent(sourceRefKey))
    if (!mapping) {
      throw notFound(`No entity found for source: ${sourceRefKey}`)
    }

    // Get the entity
    const entity = await entityRepo.findById(mapping.canonical_entity_id)
    if (!entity) {
      throw notFound(`Entity not found: ${mapping.canonical_entity_id}`)
    }

    return { body: { entity, mapping } }
  })

  // Search entities
  server.get('/entities/search', async (req) => {
    const { q, type, limit = '20' } = req.query

    if (!q) {
      return { body: { entities: [], total: 0 } }
    }

    // Text search
    const entities = await entityRepo.search(q, {
      limit: parseInt(limit, 10),
      entity_type: type as EntityType | undefined,
    })

    return {
      body: {
        entities,
        total: entities.length,
        query: q,
      },
    }
  })
}
