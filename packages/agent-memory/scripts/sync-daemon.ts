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
 *   WEBHOOK_BASE_URL              Public URL for webhooks (optional if using polling)
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
import { TelegramConnector } from '../src/connectors/telegram/index.js'

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

  // Load registered connectors from database
  console.log('📦 Loading registered connectors...')
  const loadResult = await daemon.loadRegisteredConnectors()

  if (loadResult.loaded.length === 0 && loadResult.errors.length === 0) {
    console.log('   No connectors registered.')
    console.log('   Use: bun run scripts/sync-api-cli.ts connectors register <type>')
    console.log('   Available: bun run scripts/sync-api-cli.ts connectors available')
  } else {
    for (const type of loadResult.loaded) {
      console.log(`   ✓ ${type}`)
    }
    for (const { type, error } of loadResult.errors) {
      console.error(`   ✗ ${type}: ${error.message}`)
    }
    for (const type of loadResult.skipped) {
      console.log(`   - ${type} (no factory)`)
    }
  }

  // Register Telegram connector (if configured)
  // Note: Telegram is a real-time harness bridge, not a sync connector
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

    // Connect to harness with retry
    const connectWithRetry = async (maxAttempts = 5): Promise<boolean> => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await telegram!.connect()
          console.log('   Connected to harness')
          return true
        } catch (err) {
          console.error(`   Failed to connect to harness (attempt ${attempt}/${maxAttempts}):`, err)
          if (attempt < maxAttempts) {
            const delay = Math.min(2000 * attempt, 10000)
            console.log(`   Retrying in ${delay / 1000}s...`)
            await new Promise(resolve => setTimeout(resolve, delay))
          }
        }
      }
      console.error('   Make sure harness-daemon is running')
      return false
    }

    const connected = await connectWithRetry()
    if (!connected) {
      telegram = null
    }

    if (telegram) {
      // Start long polling (no public webhook needed)
      void telegram.startPolling().catch(err => {
        console.error('   Telegram polling failed:', err)
      })
      console.log('   Using long polling (no public endpoint required)')
    }
  }

  // Start daemon
  console.log(`\n▶️  Starting daemon on port ${config.port}...\n`)
  await daemon.start()

  console.log('✅ Sync daemon is running!')
  console.log('\n📋 API Endpoints:')
  console.log('  GET  /api/health     - Health check')
  console.log('  GET  /api/accounts   - List accounts')
  console.log('\n🔌 Connectors:')
  console.log('  GET  /api/connectors           - List registered')
  console.log('  GET  /api/connectors/available - List available')
  console.log('  POST /api/connectors/register  - Register connector')
  console.log('\n🔐 OAuth:')
  console.log(`  GET  /api/auth/:connector/url   - Get OAuth URL`)
  console.log(`  GET  /api/auth/callback         - Browser OAuth callback`)
  console.log('\n📊 Sync Tasks:')
  console.log('  POST /api/tasks/backfill   - Historical sync')
  console.log('  POST /api/tasks/subscribe  - Recurring sync')

  if (telegram) {
    console.log('\n📱 Telegram:')
    console.log('  Long polling active (no public endpoint needed)')
  }

  console.log('\n📌 Start OAuth:')
  console.log('  bun run scripts/sync-api-cli.ts auth login gmail')
  console.log('\nCtrl+C to stop\n')

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n\n🛑 Shutting down daemon...')
    if (telegram) {
      telegram.stopPolling()
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

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception (continuing):', error)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection (continuing):', reason)
})

// Start with restart capability
async function startWithRetry(maxRetries = 3) {
  let retries = 0

  while (retries < maxRetries) {
    try {
      await main()
      // If main() exits normally (shouldn't happen in a daemon), just return
      return
    } catch (error) {
      retries++
      console.error(`❌ Fatal error (attempt ${retries}/${maxRetries}):`, error)

      if (retries < maxRetries) {
        const delay = Math.min(5000 * retries, 30000)
        console.log(`🔄 Restarting in ${delay / 1000}s...`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  console.error('❌ Max retries exceeded, exiting')
  process.exit(1)
}

startWithRetry().catch((error) => {
  console.error('❌ Startup failed:', error)
  process.exit(1)
})
