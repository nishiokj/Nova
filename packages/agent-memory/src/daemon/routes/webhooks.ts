/**
 * Webhook Routes
 *
 * HTTP endpoints for receiving webhooks from external services.
 */

import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest, notFound, unauthorized } from '../server.js'
import type { WebhookEvent } from '../../connector/sdk/types.js'

export function registerWebhookRoutes(server: HttpServer, daemon: SyncDaemon): void {
  // Receive webhook from external service
  server.post('/webhooks/:connector/:accountId', async (req) => {
    const { connector, accountId } = req.params

    // Get connector
    const connectorInstance = daemon.getConnector(connector as any)
    if (!connectorInstance) {
      throw notFound(`Connector not found: ${connector}`)
    }

    // Verify account exists
    const account = await daemon.accountRepo.findById(accountId)
    if (!account) {
      throw notFound(`Account not found: ${accountId}`)
    }

    if (!account.is_active) {
      throw badRequest('Account is inactive')
    }

    // Build webhook event
    const event: WebhookEvent = {
      deliveryId: req.headers['x-webhook-delivery'] || req.headers['x-github-delivery'],
      eventType: req.headers['x-webhook-event'] || req.headers['x-github-event'] || 'unknown',
      payload: req.body,
      headers: req.headers,
      signature: req.headers['x-hub-signature-256'] || req.headers['x-webhook-signature'],
      receivedAt: new Date(),
    }

    // Verify signature if connector supports it
    if (connectorInstance.verifyWebhookSignature) {
      // Get webhook secret from account metadata or environment
      const webhookSecret = (account as any).webhook_secret || process.env[`${connector.toUpperCase()}_WEBHOOK_SECRET`]

      if (webhookSecret) {
        const verification = await connectorInstance.verifyWebhookSignature(event, webhookSecret)
        if (!verification.valid) {
          throw unauthorized(`Webhook signature verification failed: ${verification.error}`)
        }
      }
    }

    // Parse webhook payload
    let items: any[] = []
    if (connectorInstance.parseWebhookPayload) {
      items = await connectorInstance.parseWebhookPayload(event)
    }

    // If we have items, ingest them through the collector
    if (items.length > 0) {
      // Store items as raw envelopes
      await daemon.collector.ingestWebhook(connector as any, accountId, items)
    }

    // Emit internal event for webhook-derived task triggers
    daemon.emitInternalEvent({
      type: 'webhook:received',
      source: 'webhook',
      data: {
        connector,
        accountId,
        eventType: event.eventType,
        deliveryId: event.deliveryId,
        itemCount: items.length,
        timestamp: event.receivedAt.toISOString(),
      },
    })

    // Trigger matching event-based derived tasks
    const triggeredTasks = await daemon.derivedTaskRepo.findWebhookTriggers(
      connector,
      event.eventType
    )

    for (const task of triggeredTasks) {
      try {
        // Schedule derived task with webhook context
        await daemon.derivedIntegration.scheduleTask(daemon.engine, task, {
          priority: 10, // High priority for webhook triggers
          metadata: {
            _trigger: 'webhook',
            _webhook: {
              deliveryId: event.deliveryId,
              eventType: event.eventType,
              connector,
              accountId,
              itemCount: items.length,
            },
            // Merge task-level filters into metadata for the script
            ...(task.trigger_config?.filters as Record<string, unknown> || {}),
          },
        })

        console.log('[Webhook] Triggered derived task:', {
          taskId: task.id,
          taskName: task.name,
          connector,
          eventType: event.eventType,
        })
      } catch (error) {
        console.error('[Webhook] Failed to trigger derived task:', {
          taskId: task.id,
          taskName: task.name,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Return 200 OK to acknowledge receipt
    return {
      body: {
        received: true,
        itemsProcessed: items.length,
        deliveryId: event.deliveryId,
        derivedTasksTriggered: triggeredTasks.length,
      },
    }
  })

  // Webhook verification endpoint (for services that require URL verification)
  server.get('/webhooks/:connector/:accountId', async (req) => {
    const { connector } = req.params

    // Handle various webhook verification challenges
    const challenge = req.query.challenge || req.query['hub.challenge']

    if (challenge) {
      // Return the challenge for verification (Facebook, Slack, etc.)
      return { body: challenge }
    }

    // Some services just need a 200 OK
    return { body: { status: 'ok' } }
  })
}
