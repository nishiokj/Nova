#!/usr/bin/env bun
/**
 * Resy Notification Subscriber
 *
 * Checks if Valentine's Day 2026 reservations have been released on Resy.
 * Once released, subscribes to "Notify Me" for each target restaurant.
 * Runs daily until subscriptions are complete.
 */

import { execSync } from 'child_process'
import path from 'path'
import type {
  DerivedRunContext,
  DerivedRunResult,
  DerivedMetadataSchema,
} from '../src/derived/runner.js'

// ─── Config ────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(import.meta.dir, '..', '..', '..')
const AUTH_STATE_PATH = path.join(PROJECT_ROOT, 'auth-states', 'resy-auth.json')

const TARGET_DATE = '2026-02-14'
const PARTY_SIZE = 2

// Target restaurants
const TARGET_RESTAURANTS = [
  { slug: 'bavettes-bar-and-boeuf', name: "Bavette's Bar & Boeuf" },
  { slug: 'monteverde-restaurant-and-pastificio', name: 'Monteverde' },
  { slug: 'kasama', name: 'Kasama' },
  { slug: 'kyoten-next', name: 'Kyoten' },
  { slug: 'armitage-alehouse', name: 'Armitage Alehouse' },
  { slug: 'trivoli-tavern', name: 'Trivoli Tavern' },
  { slug: 'giant', name: 'Giant' },
  { slug: 'gilt-bar', name: 'Gilt Bar' },
  { slug: 'ciccio-mio', name: 'Ciccio Mio' },
  { slug: 'the-purple-pig', name: 'The Purple Pig' },
  { slug: 'beatnik-on-the-river', name: 'Beatnik on the River' },
  { slug: 'maxwells-trading', name: "Maxwell's Trading" },
  { slug: 'the-duck-inn', name: 'The Duck Inn' },
  { slug: 'the-meadowlark', name: 'The Meadowlark' },
  { slug: 'galit', name: 'Galit' },
  { slug: 'gemini', name: 'Gemini' },
  { slug: 'the-gundis-kurdish-kitchen', name: "The Gundi's" },
  { slug: 'dimmi-dimmi', name: 'Dimmi Dimmi' },
  { slug: 'petit-pomeroy', name: 'Petit Pomeroy' },
  { slug: 'trino', name: 'Trino' },
  { slug: 'brulee', name: 'Brulee' },
  { slug: 'americano-il', name: 'Americano' },
  { slug: 'denuccis', name: "DeNucci's" },
  { slug: 'parsons-chicken-and-fish-lincoln-park', name: 'Parsons Lincoln Park' },
  { slug: 'lardon', name: 'Lardon' },
  { slug: 'cafe-yaya', name: 'Cafe Yaya' },
  { slug: 'kinzie-chophouse', name: 'Kinzie Chophouse' },
]

// ─── Metadata Schema ─────────────────────────────────────────────────────────

export const metadata: DerivedMetadataSchema = {
  fields: {
    subscribed_restaurants: {
      type: 'array',
      description: 'List of restaurant slugs already subscribed to',
    },
  },
}

// ─── Browser Helpers ─────────────────────────────────────────────────────────

function runBrowser(args: string): string {
  try {
    const result = execSync(`agent-browser --session resy-sub ${args}`, {
      encoding: 'utf-8',
      timeout: 30000,
      cwd: PROJECT_ROOT,
    })
    return result.trim()
  } catch (error: any) {
    return error.stdout?.toString() || error.message
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function initBrowser(): Promise<boolean> {
  runBrowser('close')
  await sleep(500)
  const result = runBrowser(`--state "${AUTH_STATE_PATH}" open "https://resy.com"`)
  return result.includes('✓')
}

async function closeBrowser(): Promise<void> {
  runBrowser('close')
}

// ─── Subscription Logic ─────────────────────────────────────────────────────

interface SubscriptionResult {
  slug: string
  name: string
  status: 'subscribed' | 'already_available' | 'not_released' | 'no_notify_button' | 'error'
  availableSlots?: string[]
  error?: string
}

async function checkAndSubscribe(
  slug: string,
  name: string,
  logger: DerivedRunContext['logger']
): Promise<SubscriptionResult> {
  const url = `https://resy.com/cities/chicago-il/venues/${slug}?date=${TARGET_DATE}&seats=${PARTY_SIZE}`

  logger.info(`Checking ${name}...`)
  runBrowser(`open "${url}"`)
  await sleep(2500) // Wait for page load

  // Get page content
  const pageText = runBrowser('eval "document.body.innerText"')

  // Check if date is even available (not disabled)
  const snapshot = runBrowser('snapshot -i')

  // Look for Feb 14 in the date picker - check if it's disabled
  const feb14Match = snapshot.match(/February 14.*?\[ref=(e\d+)\](\s*\[disabled\])?/i)
  if (feb14Match && feb14Match[2]?.includes('disabled')) {
    logger.info(`  ✗ ${name}: Feb 14 not released yet (disabled)`)
    return { slug, name, status: 'not_released' }
  }

  // Check for available time slots (6-8:30 PM)
  const timeSlotPattern = /(6:00|6:30|7:00|7:30|8:00|8:30)\s*PM/gi
  const availableSlots: string[] = []

  // Look for actual slot buttons (not dropdown options)
  const slotButtons = snapshot
    .split('\n')
    .filter((line) => {
      const isButton = line.includes('button') && !line.includes('option')
      const hasTime = timeSlotPattern.test(line)
      timeSlotPattern.lastIndex = 0 // Reset regex
      return isButton && hasTime
    })

  for (const line of slotButtons) {
    const timeMatch = line.match(/(6:00|6:30|7:00|7:30|8:00|8:30)\s*PM/i)
    if (timeMatch) {
      availableSlots.push(timeMatch[0])
    }
  }

  if (availableSlots.length > 0) {
    logger.info(`  ✓ ${name}: Has available slots! (${availableSlots.join(', ')})`)
    return { slug, name, status: 'already_available', availableSlots }
  }

  // Look for Notify button
  const notifyMatch = snapshot.match(/button.*[Nn]otify.*?\[ref=(e\d+)\]/i) ||
    snapshot.match(/\[ref=(e\d+)\].*button.*[Nn]otify/i)

  if (!notifyMatch) {
    // Try finding by text content
    const notifyButtonEval = runBrowser(`eval "
      const buttons = Array.from(document.querySelectorAll('button, [role=button]'));
      const notifyBtn = buttons.find(b =>
        b.innerText.toLowerCase().includes('notify') ||
        b.getAttribute('aria-label')?.toLowerCase().includes('notify')
      );
      notifyBtn ? 'found' : 'not found';
    "`)

    if (!notifyButtonEval.includes('found')) {
      logger.info(`  ✗ ${name}: No Notify button found`)
      return { slug, name, status: 'no_notify_button' }
    }

    // Click via JS
    const clickResult = runBrowser(`eval "
      const buttons = Array.from(document.querySelectorAll('button, [role=button]'));
      const notifyBtn = buttons.find(b =>
        b.innerText.toLowerCase().includes('notify') ||
        b.getAttribute('aria-label')?.toLowerCase().includes('notify')
      );
      if (notifyBtn) { notifyBtn.click(); 'clicked'; } else { 'not found'; }
    "`)

    if (clickResult.includes('clicked')) {
      await sleep(1500)
      logger.info(`  ✓ ${name}: Subscribed to notifications!`)
      return { slug, name, status: 'subscribed' }
    }

    return { slug, name, status: 'no_notify_button' }
  }

  // Click the notify button by ref
  const ref = notifyMatch[1]
  logger.info(`  Clicking Notify button (${ref})...`)
  runBrowser(`click @${ref}`)
  await sleep(1500)

  // Verify subscription (look for confirmation)
  const afterClick = runBrowser('eval "document.body.innerText"')
  if (
    afterClick.toLowerCase().includes("you'll be notified") ||
    afterClick.toLowerCase().includes('notification set') ||
    afterClick.toLowerCase().includes('subscribed')
  ) {
    logger.info(`  ✓ ${name}: Subscribed to notifications!`)
    return { slug, name, status: 'subscribed' }
  }

  logger.info(`  ✓ ${name}: Clicked Notify (assuming subscribed)`)
  return { slug, name, status: 'subscribed' }
}

// ─── Telegram Notification ─────────────────────────────────────────────────────

async function sendNotification(
  message: string,
  logger: DerivedRunContext['logger']
): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const allowedUsers = process.env.TELEGRAM_ALLOWED_USERS

  if (!botToken || !allowedUsers) {
    logger.info('Telegram notification skipped (no credentials)')
    return
  }

  try {
    const { notifyAllUsers } = await import('../src/connectors/telegram/notify.js')
    const chatIds = allowedUsers
      .split(',')
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id))
    await notifyAllUsers(botToken, chatIds, message, 'Markdown')
    logger.info('Telegram notification sent')
  } catch (error) {
    logger.error(`Failed to send notification: ${error}`)
  }
}

// ─── Main Run Function ─────────────────────────────────────────────────────────

export async function run(ctx: DerivedRunContext): Promise<DerivedRunResult> {
  const { logger } = ctx
  const config = (ctx.task.metadata || {}) as Record<string, unknown>

  // Track which restaurants we've already subscribed to
  const alreadySubscribed = new Set<string>(
    (config.subscribed_restaurants as string[]) || []
  )

  logger.info(`Resy Notification Subscriber starting`)
  logger.info(`Target date: ${TARGET_DATE}, Party size: ${PARTY_SIZE}`)
  logger.info(`Already subscribed: ${alreadySubscribed.size} restaurants`)

  // Filter to restaurants not yet subscribed
  const toCheck = TARGET_RESTAURANTS.filter((r) => !alreadySubscribed.has(r.slug))

  if (toCheck.length === 0) {
    logger.info('All restaurants already subscribed!')
    return { metadata: { status: 'complete', subscribed_count: alreadySubscribed.size } }
  }

  logger.info(`Checking ${toCheck.length} restaurants...`)

  // Initialize browser
  const browserReady = await initBrowser()
  if (!browserReady) {
    logger.error('Failed to initialize browser')
    return { metadata: { error: 'browser_init_failed' } }
  }

  const results: SubscriptionResult[] = []
  const newlySubscribed: string[] = []
  const availableNow: SubscriptionResult[] = []
  let notReleasedCount = 0

  try {
    for (const restaurant of toCheck) {
      const result = await checkAndSubscribe(restaurant.slug, restaurant.name, logger)
      results.push(result)

      if (result.status === 'subscribed') {
        newlySubscribed.push(result.slug)
        alreadySubscribed.add(result.slug)
      } else if (result.status === 'already_available') {
        availableNow.push(result)
      } else if (result.status === 'not_released') {
        notReleasedCount++
      }

      await sleep(1000) // Be nice to Resy
    }
  } finally {
    await closeBrowser()
  }

  // Summary
  logger.info('─'.repeat(50))
  logger.info(`Results:`)
  logger.info(`  Newly subscribed: ${newlySubscribed.length}`)
  logger.info(`  Already available: ${availableNow.length}`)
  logger.info(`  Not released yet: ${notReleasedCount}`)
  logger.info(`  Total subscribed: ${alreadySubscribed.size}/${TARGET_RESTAURANTS.length}`)

  // Send notification if we found available slots
  if (availableNow.length > 0) {
    const message = [
      `🍽️ *Resy: Tables Available Now!*`,
      ``,
      `The following restaurants have ${TARGET_DATE} slots:`,
      ...availableNow.map(
        (r) => `• *${r.name}*: ${r.availableSlots?.join(', ')}`
      ),
      ``,
      `Book now before they're gone!`,
    ].join('\n')

    await sendNotification(message, logger)
  }

  // Send notification if we subscribed to new restaurants
  if (newlySubscribed.length > 0) {
    const message = [
      `🔔 *Resy Notifications Set Up*`,
      ``,
      `Subscribed to ${newlySubscribed.length} restaurants for ${TARGET_DATE}:`,
      ...newlySubscribed.slice(0, 10).map((slug) => {
        const r = TARGET_RESTAURANTS.find((t) => t.slug === slug)
        return `• ${r?.name || slug}`
      }),
      newlySubscribed.length > 10 ? `...and ${newlySubscribed.length - 10} more` : '',
    ]
      .filter(Boolean)
      .join('\n')

    await sendNotification(message, logger)
  }

  // Update task metadata with subscribed restaurants
  return {
    metadata: {
      status: notReleasedCount === toCheck.length ? 'waiting_for_release' : 'partial',
      subscribed_restaurants: [...alreadySubscribed],
      newly_subscribed: newlySubscribed.length,
      available_now: availableNow.map((r) => ({
        name: r.name,
        slots: r.availableSlots,
      })),
      not_released_count: notReleasedCount,
    },
  }
}
