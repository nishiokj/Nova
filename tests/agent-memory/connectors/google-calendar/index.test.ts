/**
 * Google Calendar Connector Tests
 *
 * Tests for Google Calendar connector functionality.
 *
 * @module connectors/google-calendar/index.test
 */

import { GoogleCalendarConnector, type GoogleCalendarConnectorConfig } from 'agent-memory/connectors/google-calendar/index.js'
import type {
  ConnectorContext,
} from 'agent-memory/connector/sdk/index.js'

// ============ Test Setup ============

describe('GoogleCalendarConnector', () => {
  let config: GoogleCalendarConnectorConfig

  beforeEach(() => {
    config = {
      rateLimit: 1,
      calendarIds: ['primary'],
    }
  })

  // ============ Constructor Tests ============

  describe('constructor', () => {
    it('sets correct connector properties', () => {
      const connector = new GoogleCalendarConnector(config)
      expect(connector.type).toBe('google-calendar')
      expect(connector.displayName).toBe('Google Calendar')
    })

    it('sets correct capabilities', () => {
      const connector = new GoogleCalendarConnector(config)
      const caps = connector.capabilities
      expect(caps.supportsBackfill).toBe(true)
      expect(caps.supportsIncrementalSync).toBe(true)
      expect(caps.supportsWebhook).toBe(true)
      expect(caps.supportsWrite).toBe(false)
      expect(caps.supportedEntityTypes).toEqual(['event'])
    })

    it('configures OAuth2 settings', () => {
      const connector = new GoogleCalendarConnector(config)
      expect(connector.authConfig.type).toBe('oauth2_provider')
      expect(connector.authConfig.provider).toBe('google')
      expect(connector.authConfig.scopes).toContain('https://www.googleapis.com/auth/calendar.readonly')
    })
  })

  // ============ Config Tests ============

  describe('config', () => {
    it('uses default calendarId when none provided', () => {
      const connector = new GoogleCalendarConnector({})
      expect((connector as any).calendarIds).toEqual(['primary'])
    })

    it('uses custom calendarIds when provided', () => {
      const connector = new GoogleCalendarConnector({
        calendarIds: ['cal1', 'cal2'],
      })
      expect((connector as any).calendarIds).toEqual(['cal1', 'cal2'])
    })

    it('includes canceled events when configured', () => {
      const connector = new GoogleCalendarConnector({
        includeCanceled: true,
      })
      expect((connector as any).includeCanceled).toBe(true)
    })

    it('filters canceled events by default', () => {
      const connector = new GoogleCalendarConnector({})
      expect((connector as any).includeCanceled).toBe(false)
    })
  })
})
