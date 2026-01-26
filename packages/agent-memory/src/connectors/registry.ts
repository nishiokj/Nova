/**
 * Connector Registry
 *
 * Maps connector types to factory functions for config-driven loading.
 * This is the bridge between implementing a connector and the daemon recognizing it.
 *
 * To add a new connector:
 * 1. Implement the Connector interface
 * 2. Add factory function here
 * 3. Add config schema in config/schema.ts
 * 4. Enable in config
 *
 * @module connectors/registry
 */

import type { Connector } from '../connector/sdk/types.js'
import type { ConnectorType } from '../ids.js'
import { createGmailConnector, type GmailConnectorConfig } from './gmail/index.js'
import { createGitHubConnector, type GitHubConnectorConfig } from './github/index.js'
import { createClaudeSessionConnector, type ClaudeSessionConnectorConfig } from './coding-sessions/claude.js'
import { createRexSessionConnector, type RexSessionConnectorConfig } from './coding-sessions/rex.js'

// ============ Types ============

/**
 * Factory function that creates a connector from config.
 * May be async for connectors that need initialization.
 */
export type ConnectorFactory<C = unknown> = (config: C) => Connector | Promise<Connector>

/**
 * Registry entry for a connector factory.
 */
export interface ConnectorFactoryEntry<C = unknown> {
  factory: ConnectorFactory<C>
  /** Whether the connector requires async initialization */
  async?: boolean
}

// ============ Registry ============

/**
 * Map of connector types to their factory functions.
 */
const factories = new Map<ConnectorType, ConnectorFactoryEntry>()

/**
 * Register a connector factory.
 */
export function registerFactory<C>(
  type: ConnectorType,
  factory: ConnectorFactory<C>,
  options?: { async?: boolean }
): void {
  factories.set(type, { factory: factory as ConnectorFactory, async: options?.async })
}

/**
 * Get a connector factory by type.
 */
export function getFactory(type: ConnectorType): ConnectorFactoryEntry | undefined {
  return factories.get(type)
}

/**
 * List all registered connector types.
 */
export function listFactoryTypes(): ConnectorType[] {
  return Array.from(factories.keys())
}

/**
 * Check if a factory exists for a connector type.
 */
export function hasFactory(type: ConnectorType): boolean {
  return factories.has(type)
}

// ============ Built-in Factories ============

// Gmail (uses oauth2_provider for centralized OAuth)
registerFactory<GmailConnectorConfig>('gmail', (config) => {
  return createGmailConnector(config)
})

// GitHub (uses direct oauth2)
registerFactory<GitHubConnectorConfig>('github', (config) => {
  return createGitHubConnector(config)
})

// Claude Code Sessions (local filesystem)
registerFactory<ClaudeSessionConnectorConfig>('claude_sessions', (config) => {
  return createClaudeSessionConnector(config)
})

// Rex Sessions (local filesystem)
registerFactory<RexSessionConnectorConfig>('rex_sessions', (config) => {
  return createRexSessionConnector(config)
})

// Note: Telegram is handled separately in the daemon startup
// because it's a real-time harness bridge, not a sync connector

// ============ Loader ============

/**
 * Result of loading connectors.
 */
export interface LoadConnectorsResult {
  /** Successfully loaded connectors */
  loaded: ConnectorType[]
  /** Connectors that failed to load */
  errors: Array<{ type: ConnectorType; error: Error }>
  /** Connectors that were skipped (disabled or missing config) */
  skipped: ConnectorType[]
}

/**
 * Connector config with enabled flag.
 */
export interface EnabledConnectorConfig {
  enabled?: boolean
  [key: string]: unknown
}

/**
 * Load connectors from config.
 *
 * @param config - Connector configuration (from AppConfig.connectors)
 * @param register - Function to register each loaded connector
 * @returns Load results
 */
export async function loadConnectors(
  config: Record<string, EnabledConnectorConfig>,
  register: (connector: Connector) => void
): Promise<LoadConnectorsResult> {
  const result: LoadConnectorsResult = {
    loaded: [],
    errors: [],
    skipped: [],
  }

  for (const [type, connectorConfig] of Object.entries(config)) {
    // Skip if not a registered connector type
    if (!hasFactory(type as ConnectorType)) {
      continue
    }

    // Skip if disabled
    if (!connectorConfig.enabled) {
      result.skipped.push(type as ConnectorType)
      continue
    }

    const entry = getFactory(type as ConnectorType)!

    try {
      const connector = await entry.factory(connectorConfig)
      register(connector)
      result.loaded.push(type as ConnectorType)
    } catch (error) {
      result.errors.push({
        type: type as ConnectorType,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }

  return result
}
