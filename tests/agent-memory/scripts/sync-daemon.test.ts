/**
 * Sync Daemon Startup Script Tests
 *
 * Unit tests for helper functions and configuration parsing.
 * Tests loadEnvFile(), parseBooleanEnv(), and loadConfig() in isolation.
 *
 * Tests in this file do not require a database.
 */

import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'

// Import the actual exported functions from sync-daemon.ts
import {
  loadEnvFile,
  parseBooleanEnv,
  loadConfig,
  type DaemonConfig
} from 'agent-memory-scripts/sync-daemon.js'

// ============ Test Suite ============

describe('Sync Daemon - Unit Tests', () => {
  let tempDir: string
  let envPath: string

  beforeEach(() => {
    // Create temp directory for test env files
    tempDir = join(tmpdir(), `sync-daemon-test-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
    envPath = join(tempDir, '.env')

    // Clear relevant environment variables
    delete process.env.DATABASE_URL
    delete process.env.CREDENTIAL_ENCRYPTION_KEY
    delete process.env.WEBHOOK_BASE_URL
    delete process.env.SYNC_DAEMON_PORT
    delete process.env.AGENT_MEMORY_SYNC_AUTO_PROCESS
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_ALLOWED_USERS
    delete process.env.HARNESS_HOST
    delete process.env.HARNESS_PORT
    delete process.env.WORKING_DIR
  })

  afterEach(() => {
    // Clean up temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe('loadEnvFile', () => {
    it('loads key-value pairs from .env file', async () => {
      writeFileSync(envPath, 'DATABASE_URL=postgres://localhost/test\n')

      await loadEnvFile(envPath)

      expect(process.env.DATABASE_URL).toBe('postgres://localhost/test')
    })

    it('handles multiple key-value pairs', async () => {
      writeFileSync(envPath, `
        DATABASE_URL=postgres://localhost/test
        ENCRYPTION_KEY=abc123
        PORT=3002
      `)

      await loadEnvFile(envPath)

      expect(process.env.DATABASE_URL).toBe('postgres://localhost/test')
      expect(process.env.ENCRYPTION_KEY).toBe('abc123')
      expect(process.env.PORT).toBe('3002')
    })

    it('ignores comments starting with #', async () => {
      writeFileSync(envPath, `
        # This is a comment
        DATABASE_URL=postgres://localhost/test
        # Another comment
        ENCRYPTION_KEY=abc123
      `)

      await loadEnvFile(envPath)

      expect(process.env.DATABASE_URL).toBe('postgres://localhost/test')
      expect(process.env.ENCRYPTION_KEY).toBe('abc123')
      expect(process.env['# This is a comment']).toBeUndefined()
    })

    it('ignores empty lines', async () => {
      writeFileSync(envPath, '\n\nDATABASE_URL=postgres://localhost/test\n\n')

      await loadEnvFile(envPath)

      expect(process.env.DATABASE_URL).toBe('postgres://localhost/test')
    })

    it('trims whitespace from keys and values', async () => {
      writeFileSync(envPath, '  DATABASE_URL  =  postgres://localhost/test  ')

      await loadEnvFile(envPath)

      expect(process.env.DATABASE_URL).toBe('postgres://localhost/test')
    })

    it('removes surrounding quotes from values (double quotes)', async () => {
      writeFileSync(envPath, 'DATABASE_URL="postgres://localhost/test"')

      await loadEnvFile(envPath)

      expect(process.env.DATABASE_URL).toBe('postgres://localhost/test')
    })

    it('removes surrounding quotes from values (single quotes)', async () => {
      writeFileSync(envPath, "DATABASE_URL='postgres://localhost/test'")

      await loadEnvFile(envPath)

      expect(process.env.DATABASE_URL).toBe('postgres://localhost/test')
    })

    it('keeps internal quotes in values', async () => {
      writeFileSync(envPath, 'MESSAGE="This is a message"')

      await loadEnvFile(envPath)

      expect(process.env.MESSAGE).toBe('This is a message')
    })

    it('does not throw when file does not exist', async () => {
      const nonExistentPath = join(tempDir, 'nonexistent.env')

      await expect(loadEnvFile(nonExistentPath)).resolves.not.toThrow()
    })

    it('overwrites existing process.env values', async () => {
      process.env.DATABASE_URL = 'old-value'

      writeFileSync(envPath, 'DATABASE_URL=new-value')

      await loadEnvFile(envPath)

      expect(process.env.DATABASE_URL).toBe('new-value')
    })

    it('handles values with equals signs', async () => {
      writeFileSync(envPath, 'DATABASE_URL=postgres://localhost/test?ssl=true&foo=bar')

      await loadEnvFile(envPath)

      expect(process.env.DATABASE_URL).toBe('postgres://localhost/test?ssl=true&foo=bar')
    })
  })

  describe('parseBooleanEnv', () => {
    it('returns true for "true"', () => {
      expect(parseBooleanEnv('true', false)).toBe(true)
    })

    it('returns true for "TRUE"', () => {
      expect(parseBooleanEnv('TRUE', false)).toBe(true)
    })

    it('returns true for "1"', () => {
      expect(parseBooleanEnv('1', false)).toBe(true)
    })

    it('returns true for "yes"', () => {
      expect(parseBooleanEnv('yes', false)).toBe(true)
    })

    it('returns true for "YES"', () => {
      expect(parseBooleanEnv('YES', false)).toBe(true)
    })

    it('returns true for "y"', () => {
      expect(parseBooleanEnv('y', false)).toBe(true)
    })

    it('returns true for "on"', () => {
      expect(parseBooleanEnv('on', false)).toBe(true)
    })

    it('returns false for "false"', () => {
      expect(parseBooleanEnv('false', true)).toBe(false)
    })

    it('returns false for "FALSE"', () => {
      expect(parseBooleanEnv('FALSE', true)).toBe(false)
    })

    it('returns false for "0"', () => {
      expect(parseBooleanEnv('0', true)).toBe(false)
    })

    it('returns false for "no"', () => {
      expect(parseBooleanEnv('no', true)).toBe(false)
    })

    it('returns false for "NO"', () => {
      expect(parseBooleanEnv('NO', true)).toBe(false)
    })

    it('returns false for "n"', () => {
      expect(parseBooleanEnv('n', true)).toBe(false)
    })

    it('returns false for "off"', () => {
      expect(parseBooleanEnv('off', true)).toBe(false)
    })

    it('returns default value for undefined', () => {
      expect(parseBooleanEnv(undefined, true)).toBe(true)
      expect(parseBooleanEnv(undefined, false)).toBe(false)
    })

    it('returns default value for empty string', () => {
      expect(parseBooleanEnv('', true)).toBe(true)
      expect(parseBooleanEnv('', false)).toBe(false)
    })

    it('returns default value for whitespace-only string', () => {
      expect(parseBooleanEnv('   ', true)).toBe(true)
      expect(parseBooleanEnv('   ', false)).toBe(false)
    })

    it('returns default value for unrecognized values', () => {
      expect(parseBooleanEnv('maybe', true)).toBe(true)
      expect(parseBooleanEnv('maybe', false)).toBe(false)
    })

    it('handles whitespace around values', () => {
      expect(parseBooleanEnv(' true ', false)).toBe(true)
      expect(parseBooleanEnv(' false ', true)).toBe(false)
    })
  })

  describe('loadConfig', () => {
    it('loads config with required fields', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)

      const config = loadConfig()

      expect(config.databaseUrl).toBe('postgres://localhost/test')
      expect(config.encryptionKey).toBe('a'.repeat(64))
      expect(config.port).toBe(3001) // Default
      expect(config.autoProcess).toBe(true) // Default
    })

    it('uses default port when SYNC_DAEMON_PORT not set', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)

      const config = loadConfig()

      expect(config.port).toBe(3001)
    })

    it('uses custom port from SYNC_DAEMON_PORT', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)
      process.env.SYNC_DAEMON_PORT = '4000'

      const config = loadConfig()

      expect(config.port).toBe(4000)
    })

    it('uses default autoProcess when not set', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)

      const config = loadConfig()

      expect(config.autoProcess).toBe(true)
    })

    it('uses custom autoProcess from environment', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)
      process.env.AGENT_MEMORY_SYNC_AUTO_PROCESS = 'false'

      const config = loadConfig()

      expect(config.autoProcess).toBe(false)
    })

    it('uses default harness host and port when not set', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)

      const config = loadConfig()

      expect(config.harnessHost).toBe('127.0.0.1')
      expect(config.harnessPort).toBe(9555)
    })

    it('uses custom harness host and port from environment', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)
      process.env.HARNESS_HOST = '192.168.1.1'
      process.env.HARNESS_PORT = '8000'

      const config = loadConfig()

      expect(config.harnessHost).toBe('192.168.1.1')
      expect(config.harnessPort).toBe(8000)
    })

    it('parses webhookBaseUrl from environment', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)
      process.env.WEBHOOK_BASE_URL = 'https://api.example.com'

      const config = loadConfig()

      expect(config.webhookBaseUrl).toBe('https://api.example.com')
    })

    it('uses empty string for webhookBaseUrl when not set', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)

      const config = loadConfig()

      expect(config.webhookBaseUrl).toBe('')
    })

    it('parses Telegram bot token from environment', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)
      process.env.TELEGRAM_BOT_TOKEN = 'bot123:abc'

      const config = loadConfig()

      expect(config.telegramBotToken).toBe('bot123:abc')
    })

    it('parses Telegram allowed users from environment', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)
      process.env.TELEGRAM_ALLOWED_USERS = '123,456,789'

      const config = loadConfig()

      expect(config.telegramAllowedUsers).toEqual([123, 456, 789])
    })

    it('handles Telegram allowed users with whitespace', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)
      process.env.TELEGRAM_ALLOWED_USERS = ' 123 , 456 , 789 '

      const config = loadConfig()

      expect(config.telegramAllowedUsers).toEqual([123, 456, 789])
    })

    it('filters invalid Telegram user IDs', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)
      process.env.TELEGRAM_ALLOWED_USERS = '123,abc,456'

      const config = loadConfig()

      expect(config.telegramAllowedUsers).toEqual([123, 456])
    })

    it('returns undefined for telegramAllowedUsers when empty', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)
      process.env.TELEGRAM_ALLOWED_USERS = ''

      const config = loadConfig()

      expect(config.telegramAllowedUsers).toBeUndefined()
    })

    it('throws error when DATABASE_URL is missing', () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)

      expect(() => loadConfig()).toThrow('Missing required environment variables: DATABASE_URL')
    })

    it('throws error when CREDENTIAL_ENCRYPTION_KEY is missing', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'

      expect(() => loadConfig()).toThrow('Missing required environment variables: CREDENTIAL_ENCRYPTION_KEY')
    })

    it('throws error when both required fields are missing', () => {
      expect(() => loadConfig()).toThrow('Missing required environment variables: DATABASE_URL, CREDENTIAL_ENCRYPTION_KEY')
    })

    it('parses WORKING_DIR from environment', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)
      process.env.WORKING_DIR = '/custom/path'

      const config = loadConfig()

      expect(config.workingDir).toBe('/custom/path')
    })

    it('uses default working directory when not set', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64)

      const config = loadConfig()

      // Default is '/tmp/agent-memory' in our test version
      expect(config.workingDir).toBe('/tmp/agent-memory')
    })
  })
})
