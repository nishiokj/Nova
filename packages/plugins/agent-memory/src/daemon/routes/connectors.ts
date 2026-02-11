/**
 * Connector Routes
 *
 * HTTP endpoints for discovering and managing connectors.
 * Supports both static discovery and dynamic registration.
 */

import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import type { ConnectorType } from '../../ids.js'
import { notFound, badRequest, conflict } from '../server.js'
import { hasFactory, listFactoryTypes } from '../../connectors/registry.js'

export function registerConnectorRoutes(server: HttpServer, daemon: SyncDaemon): void {
  // ============ Discovery ============

  // List all registered (loaded) connectors
  server.get('/connectors', async () => {
    const connectors = daemon.listConnectors()
    return { body: { connectors } }
  })

  // List available factories (not yet registered)
  server.get('/connectors/available', async () => {
    const available = daemon.listAvailableFactories()
    return { body: { available } }
  })

  // Get single connector info
  server.get('/connectors/:type', async (req) => {
    const type = req.params.type as ConnectorType

    // First check if it's loaded
    const info = daemon.getConnectorInfo(type)
    if (info) {
      // Include registration status
      const registration = await daemon.connectorRepo.findByType(type)
      return {
        body: {
          connector: info,
          registration: registration ?? undefined,
        },
      }
    }

    // Check if it's a valid factory but not loaded
    if (hasFactory(type)) {
      const registration = await daemon.connectorRepo.findByType(type)
      return {
        body: {
          connector: null,
          factoryAvailable: true,
          registration: registration ?? undefined,
        },
      }
    }

    throw notFound(`Connector not found: ${type}`)
  })

  // List accounts for a connector
  server.get('/connectors/:type/accounts', async (req) => {
    const connector = daemon.getConnector(req.params.type as ConnectorType)
    if (!connector) {
      throw notFound(`Connector not found: ${req.params.type}`)
    }

    const accounts = await daemon.accountRepo.findAllByConnector(req.params.type as ConnectorType)
    return { body: { accounts: accounts.filter((a) => a.is_active) } }
  })

  // Run connector sanity checks
  server.post('/connectors/:type/sanity', async (req) => {
    const type = req.params.type as ConnectorType
    const { config } = req.body as { config?: Record<string, unknown> }
    const sanity = await daemon.checkConnectorSanity({ type, config })
    return { body: { sanity } }
  })

  // ============ Dynamic Registration ============

  // Register a new connector
  server.post('/connectors/register', async (req) => {
    const { type, config } = req.body as { type?: string; config?: Record<string, unknown> }

    if (!type) {
      throw badRequest('Missing required field: type')
    }

    const connectorType = type as ConnectorType

    if (!hasFactory(connectorType)) {
      throw badRequest(`No factory available for connector type: ${type}. Available: ${listFactoryTypes().join(', ')}`)
    }

    // Check if already registered and loaded
    if (daemon.hasConnector(connectorType)) {
      throw conflict(`Connector already registered: ${type}`)
    }

    try {
      const registration = await daemon.registerConnectorDynamic(connectorType, config)
      const info = daemon.getConnectorInfo(connectorType)

      return {
        status: 201,
        body: {
          connector: info,
          registration,
        },
      }
    } catch (error) {
      throw badRequest(`Failed to register connector: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // Update connector config
  server.patch('/connectors/:type/config', async (req) => {
    const type = req.params.type as ConnectorType
    const { config } = req.body as { config?: Record<string, unknown> }

    if (!config) {
      throw badRequest('Missing required field: config')
    }

    const registration = await daemon.connectorRepo.findByType(type)
    if (!registration) {
      throw notFound(`Connector not registered: ${type}`)
    }

    // Update config in database
    const updated = await daemon.connectorRepo.updateConfig(type, config)

    // Reload the connector with new config
    if (registration.enabled) {
      await daemon.reloadConnector(type)
    }

    const info = daemon.getConnectorInfo(type)

    return {
      body: {
        connector: info,
        registration: updated,
      },
    }
  })

  // Enable or disable a connector
  server.patch('/connectors/:type', async (req) => {
    const type = req.params.type as ConnectorType
    const { enabled } = req.body as { enabled?: boolean }

    if (typeof enabled !== 'boolean') {
      throw badRequest('Missing required field: enabled (boolean)')
    }

    const registration = await daemon.connectorRepo.findByType(type)
    if (!registration) {
      throw notFound(`Connector not registered: ${type}`)
    }

    // Update enabled status
    const updated = await daemon.connectorRepo.setEnabled(type, enabled)

    if (enabled && !daemon.hasConnector(type)) {
      // Enable: reload connector
      await daemon.reloadConnector(type)
    } else if (!enabled && daemon.hasConnector(type)) {
      // Disable: unload connector
      daemon.unloadConnector(type)
    }

    const info = daemon.getConnectorInfo(type)

    return {
      body: {
        connector: info,
        registration: updated,
      },
    }
  })

  // Unregister a connector
  server.delete('/connectors/:type', async (req) => {
    const type = req.params.type as ConnectorType

    const registration = await daemon.connectorRepo.findByType(type)
    if (!registration) {
      throw notFound(`Connector not registered: ${type}`)
    }

    // Unload if loaded
    if (daemon.hasConnector(type)) {
      daemon.unloadConnector(type)
    }

    // Remove from database
    await daemon.connectorRepo.unregister(type)

    return {
      body: { success: true, message: `Connector ${type} unregistered` },
    }
  })
}
