#!/usr/bin/env bun
/**
 * Sync Daemon Startup Script
 *
 * Starts the agent-memory sync daemon server with connectors.
 *
 * Usage:
 *   bun run packages/agent-memory/scripts/sync-daemon.ts
 *
 * Environment variables required:
 *   DATABASE_URL                  PostgreSQL connection string
 *   CREDENTIAL_ENCRYPTION_KEY     32-byte hex string for encrypting credentials
 *   WEBHOOK_BASE_URL              Public URL for webhooks (e.g., https://your-domain.com)
 *   SYNC_DAEMON_PORT              HTTP server port (default: 3001)
 *   GOOGLE_CLIENT_ID              Google OAuth client ID (for Gmail, Calendar, Drive, etc.)
 *   GOOGLE_CLIENT_SECRET          Google OAuth client secret
 *
 * Telegram (optional):
 *   TELEGRAM_BOT_TOKEN            Bot token from @BotFather
 *   TELEGRAM_ALLOWED_USERS        Comma-separated user IDs (optional, dangerous if empty)
 *   HARNESS_HOST                  Harness daemon host (default: 127.0.0.1)
 *   HARNESS_PORT                  Harness daemon port (default: 9555)
 *   WORKING_DIR                   Working directory for agent (default: cwd)
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'
import ngrok from 'ngrok'
import { SyncDaemon } from '../src/daemon/index.js'
import { createGmailConnector } from '../src/connectors/gmail/index.js'
import { TelegramConnector, type TelegramUpdate } from '../src/connectors/telegram/index.js'

// Load .env from project root
await loadEnvFile(join(import.meta.dir, '../../../.env'))

// Log which Google OAuth credentials are being used
console.log('🔑 Google OAuth Configuration:')
console.log(`   Client ID: ${process.env.GOOGLE_CLIENT_ID || 'NOT SET'}`)
console.log(`   Client Secret: ${process.env.GOOGLE_CLIENT_SECRET ? '*** SET ***' : 'NOT SET'}`)
console.log('')

async function loadEnvFile(path: string): Promise<void> {
  try {
    const content = await readFile(path, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const match = trimmed.match(/^([^=]+)=(.*)$/)
      if (match) {
        const key = match[1].trim()
        let value = match[2].trim()
        // Remove surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        // Always set from .env (for development convenience)
        process.env[key] = value
      }
    }
  } catch {
    // .env file not found, continue with existing env
  }
}

interface DaemonConfig {
  databaseUrl: string
  encryptionKey: string
  webhookBaseUrl?: string
  port: number
  // Telegram (optional)
  telegramBotToken?: string
  telegramAllowedUsers?: number[]
  harnessHost: string
  harnessPort: number
  workingDir: string
}

function loadConfig(): DaemonConfig {
  const required: (keyof DaemonConfig)[] = [
    'databaseUrl',
    'encryptionKey',
  ]

  // Parse Telegram allowed users
  const telegramAllowedUsers = process.env.TELEGRAM_ALLOWED_USERS
    ? process.env.TELEGRAM_ALLOWED_USERS.split(',')
        .map(id => parseInt(id.trim(), 10))
        .filter(id => !isNaN(id))
    : undefined

  const config: DaemonConfig = {
    databaseUrl: process.env.DATABASE_URL || '',
    encryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY || '',
    webhookBaseUrl: process.env.WEBHOOK_BASE_URL || '',
    port: parseInt(process.env.SYNC_DAEMON_PORT || '3001', 10),
    // Telegram
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramAllowedUsers,
    harnessHost: process.env.HARNESS_HOST ?? '127.0.0.1',
    harnessPort: parseInt(process.env.HARNESS_PORT ?? '9555', 10),
    workingDir: process.env.WORKING_DIR ?? process.cwd(),
  }

  const missing = required.filter(key => !config[key])
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:')
    missing.forEach(key => {
      const envKey = key.toUpperCase().replace(/([A-Z])/g, '_$1')
      console.error(`  - ${envKey}`)
    })
    console.error('\nSet these in your .env file and try again.')
    process.exit(1)
  }

  // Validate encryption key is 32-byte hex
  if (config.encryptionKey.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(config.encryptionKey)) {
    console.error('❌ CREDENTIAL_ENCRYPTION_KEY must be a 32-byte hex string')
    console.error('   Generate with: openssl rand -hex 32')
    process.exit(1)
  }

  return config
}

async function main() {
  console.log('╔═══════════════════════════════════════╗')
  console.log('║       Agent Memory Sync Daemon        ║')
  console.log('╚═══════════════════════════════════════╝\n')

  const config = loadConfig()

  // Start ngrok tunnel if no webhook URL provided
  let webhookBaseUrl = config.webhookBaseUrl
  if (!webhookBaseUrl) {
    if (!process.env.NGROK_AUTHTOKEN) {
      console.error('❌ NGROK_AUTHTOKEN is required when WEBHOOK_BASE_URL is not set')
      console.error('   1. Sign up at https://dashboard.ngrok.com/signup')
      console.error('   2. Get your token from https://dashboard.ngrok.com/get-started/your-authtoken')
      console.error('   3. Add NGROK_AUTHTOKEN="your-token" to .env')
      process.exit(1)
    }
    console.log('🔗 Starting ngrok tunnel...')
    webhookBaseUrl = await ngrok.connect({
      addr: config.port,
      authtoken: process.env.NGROK_AUTHTOKEN,
    })
    console.log(`   Tunnel: ${webhookBaseUrl}`)
  }

  console.log('\nConfiguration:')
  console.log(`  Database: ${config.databaseUrl.replace(/:[^:@]+@/, ':****@')}`)
  console.log(`  Webhook Base: ${webhookBaseUrl}`)
  console.log(`  Port: ${config.port}`)

  // Create database connection
  console.log('\n📡 Connecting to database...')
  const sql = postgres(config.databaseUrl, {
    max: 10,
  })

  // Create daemon
  console.log('🚀 Creating sync daemon...')
  const daemon = await SyncDaemon.create({
    sql,
    encryptionKey: Buffer.from(config.encryptionKey, 'hex'),
    port: config.port,
    webhookBaseUrl,
  })

  // Register Gmail connector
  console.log('📧 Registering Gmail connector...')
  daemon.registerConnector(createGmailConnector({}))

  // Register Telegram connector (if configured)
  let telegram: TelegramConnector | null = null
  if (config.telegramBotToken) {
    console.log('📱 Registering Telegram connector...')
    telegram = new TelegramConnector({
      botToken: config.telegramBotToken,
      harnessHost: config.harnessHost,
      harnessPort: config.harnessPort,
      workingDir: config.workingDir,
      allowedUserIds: config.telegramAllowedUsers,
      dangerousMode: true, // Telegram can't prompt for permissions
    })

    // Connect to harness
    try {
      await telegram.connect()
      console.log('   Connected to harness')
    } catch (err) {
      console.error('   Failed to connect to harness:', err)
      console.error('   Make sure harness-daemon is running')
      telegram = null
    }

    if (telegram) {
      // Register webhook route
      const botId = telegram.getBotId()
      daemon.server.raw('POST', `/webhook/telegram/${botId}`, async (req) => {
        const update = req.body as TelegramUpdate
        if (!update || typeof update.update_id !== 'number') {
          return { status: 400, body: { error: 'Invalid update' } }
        }

        // Process asynchronously - Telegram expects quick 200 response
        telegram!.handleUpdate(update).catch(err => {
          console.error('[Telegram] Error processing update:', err)
        })

        return { status: 200, body: { ok: true } }
      })

      console.log(`   Webhook: POST /webhook/telegram/${botId}`)
    }
  }

  // Start daemon
  console.log(`\n▶️  Starting daemon on port ${config.port}...\n`)
  await daemon.start()

  console.log('✅ Sync daemon is running!')
  console.log('\n📋 API Endpoints:')
  console.log('  GET  /api/health     - Health check')
  console.log('  GET  /api/accounts   - List accounts')
  console.log('\n🔐 OAuth:')
  console.log(`  GET  /api/auth/:connector/url   - Get OAuth URL`)
  console.log(`  GET  /api/auth/callback         - Browser OAuth callback`)
  console.log('\n📊 Sync Tasks:')
  console.log('  POST /api/tasks/backfill   - Historical sync')
  console.log('  POST /api/tasks/subscribe  - Recurring sync')

  if (telegram) {
    const botId = telegram.getBotId()
    console.log('\n📱 Telegram:')
    console.log(`  POST /webhook/telegram/${botId}`)
    console.log(`  Set webhook: curl "https://api.telegram.org/bot${config.telegramBotToken}/setWebhook?url=${webhookBaseUrl}/webhook/telegram/${botId}"`)
  }

  console.log('\n📌 Start OAuth:')
  console.log(`  curl "http://localhost:${config.port}/api/auth/gmail/url?redirectUri=${webhookBaseUrl}/api/auth/callback"`)
  console.log('\nCtrl+C to stop\n')

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n\n🛑 Shutting down daemon...')
    if (telegram) {
      telegram.disconnect()
    }
    await daemon.stop()
    await ngrok.disconnect()
    await sql.end({ timeout: 5 })
    console.log('✅ Daemon stopped')
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('❌ Fatal error:', error)
  process.exit(1)
})
