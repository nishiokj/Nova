/**
 * Connector Factory Registry
 *
 * Static lookup table mapping connector types to their factory functions.
 * This defines which connectors CAN exist (code). The database defines
 * which connectors ARE active (state).
 *
 * To add a new connector:
 * 1. Implement the Connector interface in src/connectors/{name}/
 * 2. Add the factory to CONNECTOR_FACTORIES below
 * 3. Add ConnectorType to src/ids.ts
 *
 * @module connectors/registry
 */

import type { Connector } from '../connector/sdk/types.js'
import type { ConnectorType } from '../ids.js'
import { createGmailConnector } from './gmail/index.js'
import { createGitHubConnector } from './github/index.js'
import { createClaudeSessionConnector } from './coding-sessions/claude.js'
import { createRexSessionConnector } from './coding-sessions/rex.js'
import { createIMessageConnector } from './imessage/index.js'
import { createGoogleCalendarConnector } from './google-calendar/index.js'
import { createObsidianConnector } from './obsidian/index.js'
import { createWatcherSessionsConnector } from './watcher-sessions/index.js'

// ============ Types ============

/**
 * Factory function that creates a connector from config.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ConnectorFactory = (config: any) => Connector | Promise<Connector>

/**
 * Registry entry for a connector factory.
 */
export interface ConnectorFactoryEntry {
  factory: ConnectorFactory
  /** Human-readable display name */
  displayName: string
  /** Whether the connector requires async initialization */
  async?: boolean
}

/**
 * Result of loading connectors.
 */
export interface LoadConnectorsResult {
  loaded: ConnectorType[]
  errors: Array<{ type: ConnectorType; error: Error }>
  skipped: ConnectorType[]
}

// ============ Static Factory Registry ============

/**
 * All available connector factories.
 * Add new connectors here.
 */
export const CONNECTOR_FACTORIES: Record<ConnectorType, ConnectorFactoryEntry> = {
  gmail: {
    factory: createGmailConnector,
    displayName: 'Gmail',
  },
  github: {
    factory: createGitHubConnector,
    displayName: 'GitHub',
  },
  claude_sessions: {
    factory: createClaudeSessionConnector,
    displayName: 'Claude Code Sessions',
  },
  rex_sessions: {
    factory: createRexSessionConnector,
    displayName: 'Rex Sessions (GraphD)',
  },
  imessage: {
    factory: createIMessageConnector,
    displayName: 'iMessage',
  },
  'google-calendar': {
    factory: createGoogleCalendarConnector,
    displayName: 'Google Calendar',
  },
  obsidian: {
    factory: createObsidianConnector,
    displayName: 'Obsidian',
  },
  // Telegram is handled separately - it's a real-time harness bridge, not a sync connector
  telegram: {
    factory: () => { throw new Error('Telegram connector is initialized separately via TelegramConnector') },
    displayName: 'Telegram',
  },
  // X.com placeholder
  xcom: {
    factory: () => { throw new Error('X.com connector not yet implemented') },
    displayName: 'X (Twitter)',
  },
  watcher_sessions: {
    factory: createWatcherSessionsConnector,
    displayName: 'Watcher Sessions',
  },
}

// ============ Factory Lookup Functions ============

/**
 * Get a connector factory by type.
 */
export function getFactory(type: ConnectorType): ConnectorFactoryEntry | undefined {
  return CONNECTOR_FACTORIES[type]
}

/**
 * List all available connector types.
 */
export function listFactoryTypes(): ConnectorType[] {
  return Object.keys(CONNECTOR_FACTORIES) as ConnectorType[]
}

/**
 * Check if a factory exists for a connector type.
 */
export function hasFactory(type: ConnectorType): boolean {
  return type in CONNECTOR_FACTORIES
}

/**
 * Create a connector instance from a factory.
 */
export async function createConnector(
  type: ConnectorType,
  config: Record<string, unknown> = {}
): Promise<Connector> {
  const entry = CONNECTOR_FACTORIES[type]
  if (!entry) {
    throw new Error(`Unknown connector type: ${type}`)
  }
  return entry.factory(config)
}
