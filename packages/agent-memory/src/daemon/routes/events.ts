/**
 * Internal Events Routes
 *
 * HTTP endpoints for subscribing to internal daemon events.
 * Supports Server-Sent Events (SSE) for real-time streaming.
 */

import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import type { InternalEvent } from '../../client/types.js'

export interface EventListResponse {
  events: InternalEvent[]
}

export function registerEventRoutes(server: HttpServer, daemon: SyncDaemon): void {
  /**
   * List recent internal events.
   * Not a live stream - returns a snapshot of recent events.
   */
  server.get('/events', async (req) => {
    // For now, return empty list - we can add event history persistence later
    // The primary use case is the SSE stream below
    return {
      body: {
        events: [],
      },
    }
  })

  /**
   * Server-Sent Events (SSE) stream for internal daemon events.
   * Clients can subscribe to get real-time event notifications.
   *
   * Query params:
   * - types: Comma-separated event types to filter by (e.g., "webhook:received,scheduler:task_executed")
   * - source: Event source to filter by ("webhook", "scheduler", "engine", "daemon")
   */
  server.get('/events/stream', async (req) => {
    const filters = {
      types: req.query.types?.split(',') || [],
      source: req.query.source as 'webhook' | 'scheduler' | 'engine' | 'daemon' | undefined,
    }

    // Create a readable stream for SSE
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        let closed = false

        // Helper to send SSE data
        const sendEvent = (event: InternalEvent) => {
          if (closed) return

          // Apply filters
          if (filters.source && filters.source !== event.source) {
            return
          }
          if (filters.types.length > 0 && !filters.types.includes(event.type)) {
            return
          }

          try {
            const data = JSON.stringify(event)
            controller.enqueue(encoder.encode(`data: ${data}\n\n`))
          } catch (error) {
            // Stream might be closed, ignore
            console.error('[Events] Failed to send event to stream:', error)
          }
        }

        // Subscribe to daemon events
        const unsubscribe = daemon.onInternalEvent(sendEvent)

        // Send initial "connected" event
        sendEvent({
          type: 'events:connected',
          source: 'daemon',
          timestamp: new Date().toISOString(),
          data: {
            filters,
          },
        })

        // Mark as closed when connection closes
        // Note: HttpServer doesn't expose req.on('close') for response streams,
        // so we rely on the controller being closed by the client
        const closeHandler = () => {
          if (!closed) {
            closed = true
            unsubscribe()
            try {
              controller.close()
            } catch {
              // Already closed
            }
          }
        }

        // Try to attach close listener if available
        if ('on' in req) {
          (req as any).on('close', closeHandler)
        }


        // Keep connection alive with periodic keepalive
        const keepaliveInterval = setInterval(() => {
          if (closed) {
            clearInterval(keepaliveInterval)
            return
          }
          try {
            controller.enqueue(encoder.encode(': keepalive\n\n'))
          } catch {
            // Stream closed, stop interval
            clearInterval(keepaliveInterval)
            closeHandler()
          }
        }, 30000) // 30 seconds
      },
    })

    return {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
      body: stream,
    }
  })
}
