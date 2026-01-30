#!/usr/bin/env bun
/**
 * Resy Auto-Booker Derived Task
 *
 * Monitors for Valentine's Day 2026 reservations and auto-books when available.
 * Can be triggered by:
 *   1. Gmail webhook when Resy notification email arrives
 *   2. Recurring schedule to check availability directly
 *
 * Uses agent-browser for the booking flow.
 */

import { execSync, spawn, spawnSync } from 'child_process'
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
const MIN_TIME = 18 // 6:00 PM in 24h
const MAX_TIME = 20.5 // 8:30 PM in 24h

// Top Chicago restaurants (excluding Indian, Mexican, South American)
const TARGET_RESTAURANTS = [
  { slug: 'bavettes-bar-and-boeuf', name: "Bavette's Bar & Boeuf", neighborhood: 'River North' },
  { slug: 'monteverde-restaurant-and-pastificio', name: 'Monteverde', neighborhood: 'West Loop' },
  { slug: 'kasama', name: 'Kasama', neighborhood: 'Ukrainian Village' },
  { slug: 'kyoten-next', name: 'Kyoten', neighborhood: 'Logan Square' },
  { slug: 'armitage-alehouse', name: 'Armitage Alehouse', neighborhood: 'Lincoln Park' },
  { slug: 'trivoli-tavern', name: 'Trivoli Tavern', neighborhood: 'West Loop' },
  { slug: 'giant', name: 'Giant', neighborhood: 'West Loop' },
  { slug: 'gilt-bar', name: 'Gilt Bar', neighborhood: 'River North' },
  { slug: 'ciccio-mio', name: 'Ciccio Mio', neighborhood: 'River North' },
  { slug: 'the-purple-pig', name: 'The Purple Pig', neighborhood: 'River North' },
  { slug: 'beatnik-on-the-river', name: 'Beatnik on the River', neighborhood: 'River North' },
  { slug: 'maxwells-trading', name: "Maxwell's Trading", neighborhood: 'West Loop' },
  { slug: 'the-duck-inn', name: 'The Duck Inn', neighborhood: 'Bridgeport' },
  { slug: 'the-meadowlark', name: 'The Meadowlark', neighborhood: 'Logan Square' },
  { slug: 'galit', name: 'Galit', neighborhood: 'Lakeview' },
  { slug: 'gemini', name: 'Gemini', neighborhood: 'West Loop' },
  { slug: 'the-gundis-kurdish-kitchen', name: "The Gundi's", neighborhood: 'Lakeview' },
  { slug: 'dimmi-dimmi', name: 'Dimmi Dimmi', neighborhood: 'Lincoln Park' },
  { slug: 'petit-pomeroy', name: 'Petit Pomeroy', neighborhood: 'West Loop' },
  { slug: 'trino', name: 'Trino', neighborhood: 'West Loop' },
  { slug: 'brulee', name: 'Brulee', neighborhood: 'South Loop' },
  { slug: 'americano-il', name: 'Americano', neighborhood: 'Chicago' },
  { slug: 'denuccis', name: "DeNucci's", neighborhood: 'Lincoln Park' },
  { slug: 'parsons-chicken-and-fish-lincoln-park', name: 'Parsons Lincoln Park', neighborhood: 'Lincoln Park' },
  { slug: 'lardon', name: 'Lardon', neighborhood: 'West Loop' },
  { slug: 'cafe-yaya', name: 'Cafe Yaya', neighborhood: 'Ukrainian Village' },
  { slug: 'kinzie-chophouse', name: 'Kinzie Chophouse', neighborhood: 'River North' },
]

// Priority neighborhoods for Valentine's Day
const PRIORITY_NEIGHBORHOODS = ['River North', 'West Loop', 'Lakeview', 'Lincoln Park']

// ─── Metadata Schema ─────────────────────────────────────────────────────────

export const metadata: DerivedMetadataSchema = {
  fields: {
    trigger_source: {
      type: 'string',
      description: 'What triggered this run: "gmail", "schedule", or "manual"',
    },
    email_body: {
      type: 'string',
      description: 'Email body if triggered by Gmail webhook',
    },
    restaurant_slug: {
      type: 'string',
      description: 'Specific restaurant to check (optional)',
    },
    dry_run: {
      type: 'boolean',
      default: false,
      description: 'If true, find availability but do not book',
    },
  },
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface TimeSlot {
  time: string // "6:00 PM"
  hour24: number // 18
  available: boolean
}

interface RestaurantAvailability {
  slug: string
  name: string
  neighborhood: string
  url: string
  slots: TimeSlot[]
  hasTargetSlots: boolean
}

interface BookingResult {
  success: boolean
  restaurant: string
  time: string
  confirmationNumber?: string
  error?: string
}

// ─── Browser Helpers ─────────────────────────────────────────────────────────

function runAgentBrowser(args: string): string {
  try {
    const result = execSync(`agent-browser --session resy-booker ${args}`, {
      encoding: 'utf-8',
      timeout: 30000,
      cwd: PROJECT_ROOT,
    })
    return result.trim()
  } catch (error: any) {
    return error.stdout?.toString() || error.message
  }
}

function runAgentBrowserJson(args: string): any {
  try {
    const result = execSync(`agent-browser --session resy-booker --json ${args}`, {
      encoding: 'utf-8',
      timeout: 30000,
      cwd: PROJECT_ROOT,
    })
    return JSON.parse(result)
  } catch (error: any) {
    return null
  }
}

async function initBrowser(): Promise<boolean> {
  // Close any existing session
  runAgentBrowser('close')
  await sleep(500)

  // Open with auth state
  const result = runAgentBrowser(
    `--state "${AUTH_STATE_PATH}" open "https://resy.com/cities/chicago-il?date=${TARGET_DATE}&seats=${PARTY_SIZE}"`
  )
  return result.includes('✓')
}

async function closeBrowser(): Promise<void> {
  runAgentBrowser('close')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Availability Checking ─────────────────────────────────────────────────────

function parseTimeSlot(timeStr: string): number | null {
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i)
  if (!match) return null

  let hour = parseInt(match[1], 10)
  const minute = parseInt(match[2], 10)
  const period = match[3].toUpperCase()

  if (period === 'PM' && hour !== 12) hour += 12
  if (period === 'AM' && hour === 12) hour = 0

  return hour + minute / 60
}

function isInTargetTimeWindow(timeStr: string): boolean {
  const hour24 = parseTimeSlot(timeStr)
  if (hour24 === null) return false
  return hour24 >= MIN_TIME && hour24 <= MAX_TIME
}

async function checkRestaurantAvailability(
  slug: string,
  name: string,
  neighborhood: string,
  logger: DerivedRunContext['logger']
): Promise<RestaurantAvailability | null> {
  const url = `https://resy.com/cities/chicago-il/venues/${slug}?date=${TARGET_DATE}&seats=${PARTY_SIZE}`

  logger.info(`Checking ${name}...`)
  runAgentBrowser(`open "${url}"`)
  await sleep(2000) // Wait for page load

  // Get page content to check for available slots
  const pageText = runAgentBrowser('eval "document.body.innerText"')

  // Check if there are time slot buttons (indicates availability)
  const slotPattern = /(\d{1,2}:\d{2}\s*(?:AM|PM))/gi
  const potentialSlots = pageText.match(slotPattern) || []

  // Filter to actual reservation slots (appear multiple times if available)
  // Time dropdowns also show times, so we need to look for actual slot buttons
  const snapshot = runAgentBrowser('snapshot -i')
  const slotButtons = snapshot
    .split('\n')
    .filter((line) => {
      const isButton = line.includes('button') || line.includes('Button')
      const hasTime = /\d{1,2}:\d{2}\s*(?:AM|PM)/i.test(line)
      const isDropdown = line.includes('option') || line.includes('combobox')
      return isButton && hasTime && !isDropdown
    })
    .map((line) => {
      const timeMatch = line.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)
      return timeMatch ? timeMatch[1] : null
    })
    .filter(Boolean) as string[]

  const slots: TimeSlot[] = slotButtons.map((time) => ({
    time,
    hour24: parseTimeSlot(time) || 0,
    available: true,
  }))

  const targetSlots = slots.filter((s) => isInTargetTimeWindow(s.time))

  return {
    slug,
    name,
    neighborhood,
    url,
    slots,
    hasTargetSlots: targetSlots.length > 0,
  }
}

// ─── Booking Flow ─────────────────────────────────────────────────────────────

async function bookReservation(
  availability: RestaurantAvailability,
  logger: DerivedRunContext['logger']
): Promise<BookingResult> {
  const targetSlots = availability.slots.filter((s) => isInTargetTimeWindow(s.time))
  if (targetSlots.length === 0) {
    return {
      success: false,
      restaurant: availability.name,
      time: '',
      error: 'No slots in target time window',
    }
  }

  // Prefer times closer to 7:00 PM
  const sortedSlots = targetSlots.sort((a, b) => {
    const aDist = Math.abs(a.hour24 - 19)
    const bDist = Math.abs(b.hour24 - 19)
    return aDist - bDist
  })

  const targetSlot = sortedSlots[0]
  logger.info(`Attempting to book ${availability.name} at ${targetSlot.time}`)

  // Navigate to restaurant page
  runAgentBrowser(`open "${availability.url}"`)
  await sleep(2000)

  // Find and click the time slot button
  const snapshot = runAgentBrowser('snapshot -i')
  const lines = snapshot.split('\n')

  let slotRef: string | null = null
  for (const line of lines) {
    if (line.includes(targetSlot.time) && line.includes('[ref=')) {
      const refMatch = line.match(/\[ref=(e\d+)\]/)
      if (refMatch) {
        slotRef = refMatch[1]
        break
      }
    }
  }

  if (!slotRef) {
    return {
      success: false,
      restaurant: availability.name,
      time: targetSlot.time,
      error: 'Could not find slot button',
    }
  }

  // Click the slot
  logger.info(`Clicking slot ${slotRef}`)
  runAgentBrowser(`click @${slotRef}`)
  await sleep(2000)

  // Look for "Reserve" or "Complete Reservation" button
  const modalSnapshot = runAgentBrowser('snapshot -i')
  const reserveMatch = modalSnapshot.match(/button.*(?:Reserve|Complete|Confirm|Book).*\[ref=(e\d+)\]/i)

  if (!reserveMatch) {
    // Take screenshot for debugging
    runAgentBrowser('screenshot /tmp/resy-booking-modal.png')
    return {
      success: false,
      restaurant: availability.name,
      time: targetSlot.time,
      error: 'Could not find reserve button. Screenshot saved to /tmp/resy-booking-modal.png',
    }
  }

  const reserveRef = reserveMatch[1]
  logger.info(`Clicking reserve button ${reserveRef}`)
  runAgentBrowser(`click @${reserveRef}`)
  await sleep(3000)

  // Check for confirmation
  const resultPage = runAgentBrowser('eval "document.body.innerText"')
  const hasConfirmation =
    resultPage.includes('confirmed') ||
    resultPage.includes('Confirmed') ||
    resultPage.includes('reservation') ||
    resultPage.includes('You\'re going')

  // Try to extract confirmation number
  const confirmMatch = resultPage.match(/(?:confirmation|#)\s*[:.]?\s*([A-Z0-9]+)/i)

  // Take success screenshot
  runAgentBrowser('screenshot /tmp/resy-booking-result.png')

  return {
    success: hasConfirmation,
    restaurant: availability.name,
    time: targetSlot.time,
    confirmationNumber: confirmMatch?.[1],
    error: hasConfirmation ? undefined : 'Could not confirm booking. Screenshot saved.',
  }
}

// ─── Gmail Notification Parsing ───────────────────────────────────────────────

interface ParsedNotification {
  isResyNotification: boolean
  isAvailabilityAlert: boolean
  restaurantSlug?: string
  restaurantName?: string
  timeSlot?: string
}

function parseResyNotificationEmail(emailBody: string): ParsedNotification {
  const result: ParsedNotification = {
    isResyNotification: false,
    isAvailabilityAlert: false,
  }

  // Check if it's from Resy
  if (!emailBody.toLowerCase().includes('resy')) {
    return result
  }
  result.isResyNotification = true

  // Check if it's an availability notification
  const availabilityKeywords = [
    'table available',
    'reservation available',
    'now available',
    'just opened',
    'cancellation',
    'spot open',
    'table opened',
    'notify',
  ]

  result.isAvailabilityAlert = availabilityKeywords.some((kw) =>
    emailBody.toLowerCase().includes(kw)
  )

  if (!result.isAvailabilityAlert) {
    return result
  }

  // Try to extract restaurant
  const urlMatch = emailBody.match(/resy\.com\/cities\/chicago-il\/venues\/([a-z0-9-]+)/i)
  if (urlMatch) {
    result.restaurantSlug = urlMatch[1]
    const restaurant = TARGET_RESTAURANTS.find((r) => r.slug === result.restaurantSlug)
    result.restaurantName = restaurant?.name
  }

  // Try to extract time
  const timeMatch = emailBody.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)
  if (timeMatch) {
    result.timeSlot = timeMatch[1]
  }

  return result
}

// ─── Database Query for Recent Resy Emails ────────────────────────────────────

async function queryRecentResyEmails(
  logger: DerivedRunContext['logger']
): Promise<ParsedNotification[]> {
  // Query the canonical_message table for recent Resy emails
  // Data is stored in JSONB 'data' column with fields: body_text, sender, subject, source
  try {
    const { createDatabaseFromEnv } = await import('../src/db/index.js')
    const sql = createDatabaseFromEnv()

    // Use raw SQL to query JSONB fields
    const recentMessages = await sql<{
      id: string
      data: {
        body_text?: string
        sender?: string
        subject?: string
        source?: string
        timestamp?: string
      }
    }[]>`
      SELECT id, data
      FROM canonical_message
      WHERE deleted_at IS NULL
        AND data->>'source' = 'gmail'
        AND (
          data->>'body_text' ILIKE '%resy%'
          OR data->>'subject' ILIKE '%resy%'
          OR data->>'sender' ILIKE '%resy%'
        )
        AND created_at > NOW() - INTERVAL '1 hour'
      ORDER BY created_at DESC
      LIMIT 20
    `

    logger.info(`Found ${recentMessages.length} recent Resy-related emails`)

    return recentMessages
      .map((msg) => parseResyNotificationEmail(msg.data.body_text || ''))
      .filter((p) => p.isResyNotification && p.isAvailabilityAlert)
  } catch (error) {
    logger.error(`Failed to query emails: ${error}`)
    return []
  }
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
    const chatIds = allowedUsers.split(',').map((id) => parseInt(id.trim(), 10)).filter((id) => !isNaN(id))
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

  const triggerSource = (config.trigger_source as string) || 'schedule'
  const emailBody = config.email_body as string | undefined
  const specificRestaurant = config.restaurant_slug as string | undefined
  const dryRun = (config.dry_run as boolean) || false

  logger.info(`Resy Auto-Booker starting (trigger: ${triggerSource}, dryRun: ${dryRun})`)

  // If triggered by Gmail webhook, query the database for recent Resy emails
  let targetRestaurants = TARGET_RESTAURANTS
  if (triggerSource === 'gmail') {
    logger.info('Triggered by Gmail webhook, querying recent Resy emails...')

    const resyAlerts = await queryRecentResyEmails(logger)

    if (resyAlerts.length === 0) {
      logger.info('No recent Resy availability alerts found, skipping')
      return { metadata: { skipped: true, reason: 'no_resy_alerts' } }
    }

    // Filter to alerts for target restaurants
    const matchingAlerts = resyAlerts.filter((alert) => {
      if (!alert.restaurantSlug) return false
      const matched = TARGET_RESTAURANTS.find((r) => r.slug === alert.restaurantSlug)
      if (!matched) return false
      // Check time if present
      if (alert.timeSlot && !isInTargetTimeWindow(alert.timeSlot)) return false
      return true
    })

    if (matchingAlerts.length === 0) {
      logger.info('No matching alerts for target restaurants/times')
      return { metadata: { skipped: true, reason: 'no_matching_alerts' } }
    }

    // Prioritize restaurants from alerts
    const alertSlugs = matchingAlerts.map((a) => a.restaurantSlug).filter(Boolean) as string[]
    targetRestaurants = TARGET_RESTAURANTS.filter((r) => alertSlugs.includes(r.slug))

    logger.info(`Found ${targetRestaurants.length} target restaurants from alerts`)
  } else if (emailBody) {
    // Direct email body passed (for testing)
    const parsed = parseResyNotificationEmail(emailBody)

    if (!parsed.isResyNotification) {
      logger.info('Email is not from Resy, skipping')
      return { metadata: { skipped: true, reason: 'not_resy_email' } }
    }

    if (!parsed.isAvailabilityAlert) {
      logger.info('Email is not an availability alert, skipping')
      return { metadata: { skipped: true, reason: 'not_availability_alert' } }
    }

    if (parsed.restaurantSlug) {
      const matched = TARGET_RESTAURANTS.find((r) => r.slug === parsed.restaurantSlug)
      if (matched) {
        logger.info(`Gmail alert for target restaurant: ${matched.name}`)
        targetRestaurants = [matched]
      } else {
        logger.info(`Restaurant ${parsed.restaurantSlug} not in target list, skipping`)
        return { metadata: { skipped: true, reason: 'restaurant_not_in_target_list' } }
      }
    }

    // Check if time slot is in target window
    if (parsed.timeSlot && !isInTargetTimeWindow(parsed.timeSlot)) {
      logger.info(`Time ${parsed.timeSlot} outside target window (6-8:30pm), skipping`)
      return { metadata: { skipped: true, reason: 'time_outside_window' } }
    }
  }

  // If specific restaurant requested, filter to that
  if (specificRestaurant) {
    const matched = TARGET_RESTAURANTS.find((r) => r.slug === specificRestaurant)
    if (matched) {
      targetRestaurants = [matched]
    }
  }

  // Sort by priority neighborhoods
  targetRestaurants = [...targetRestaurants].sort((a, b) => {
    const aPriority = PRIORITY_NEIGHBORHOODS.indexOf(a.neighborhood)
    const bPriority = PRIORITY_NEIGHBORHOODS.indexOf(b.neighborhood)
    const aScore = aPriority === -1 ? 100 : aPriority
    const bScore = bPriority === -1 ? 100 : bPriority
    return aScore - bScore
  })

  // Initialize browser
  logger.info('Initializing browser with auth state...')
  const browserReady = await initBrowser()
  if (!browserReady) {
    logger.error('Failed to initialize browser')
    return { metadata: { error: 'browser_init_failed' } }
  }

  try {
    // Check availability for each restaurant
    const availableRestaurants: RestaurantAvailability[] = []

    for (const restaurant of targetRestaurants) {
      const availability = await checkRestaurantAvailability(
        restaurant.slug,
        restaurant.name,
        restaurant.neighborhood,
        logger
      )

      if (availability?.hasTargetSlots) {
        logger.info(`✓ ${restaurant.name} has slots in target window!`)
        availableRestaurants.push(availability)

        // If not dry run, try to book immediately
        if (!dryRun) {
          const result = await bookReservation(availability, logger)
          if (result.success) {
            const message = [
              `🎉 *Resy Reservation Booked!*`,
              ``,
              `*Restaurant:* ${result.restaurant}`,
              `*Date:* ${TARGET_DATE}`,
              `*Time:* ${result.time}`,
              `*Party Size:* ${PARTY_SIZE}`,
              result.confirmationNumber ? `*Confirmation:* ${result.confirmationNumber}` : '',
            ]
              .filter(Boolean)
              .join('\n')

            await sendNotification(message, logger)

            return {
              metadata: {
                success: true,
                restaurant: result.restaurant,
                time: result.time,
                confirmationNumber: result.confirmationNumber,
              },
            }
          } else {
            logger.warn(`Booking failed: ${result.error}`)
          }
        }
      } else {
        logger.info(`✗ ${restaurant.name} - no slots in target window`)
      }
    }

    // Summary
    if (availableRestaurants.length > 0) {
      if (dryRun) {
        logger.info(`Dry run complete. Found ${availableRestaurants.length} restaurants with availability.`)
        return {
          metadata: {
            dryRun: true,
            availableCount: availableRestaurants.length,
            restaurants: availableRestaurants.map((r) => ({
              name: r.name,
              slots: r.slots.filter((s) => isInTargetTimeWindow(s.time)).map((s) => s.time),
            })),
          },
        }
      } else {
        // We tried to book but failed
        const message = [
          `⚠️ *Resy Availability Found but Booking Failed*`,
          ``,
          `Restaurants with slots:`,
          ...availableRestaurants.map(
            (r) => `- ${r.name}: ${r.slots.filter((s) => isInTargetTimeWindow(s.time)).map((s) => s.time).join(', ')}`
          ),
        ].join('\n')

        await sendNotification(message, logger)

        return {
          metadata: {
            success: false,
            availableCount: availableRestaurants.length,
            reason: 'booking_failed',
          },
        }
      }
    }

    logger.info('No availability found in target restaurants')
    return { metadata: { success: false, reason: 'no_availability' } }
  } finally {
    await closeBrowser()
  }
}
