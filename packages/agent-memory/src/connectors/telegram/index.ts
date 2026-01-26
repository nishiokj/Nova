/**
 * Telegram Connector
 *
 * Bridges Telegram webhooks to the harness-daemon via harness-client.
 * Handles message routing, session management, and user prompts.
 */

import { HarnessClient, type BridgeEvent } from 'harness-client'
import type {
  TelegramConnectorConfig,
  TelegramUpdate,
  TelegramMessage,
  PendingRequest,
  ChatSession,
} from './types.js'

export * from './types.js'

// ============================================================================
// TelegramConnector
// ============================================================================

export class TelegramConnector {
  private readonly botToken: string
  private readonly apiBaseUrl: string
  private readonly maxMessageLength: number
  private readonly workingDir: string
  private readonly allowedUserIds: Set<number> | null
  private readonly dangerousMode: boolean

  private client: HarnessClient
  private connected = false

  /** chatId → session state */
  private sessions = new Map<number, ChatSession>()
  /** requestId → pending request info */
  private pendingRequests = new Map<string, PendingRequest>()
  /** requestId → accumulated response text */
  private responseBuffers = new Map<string, string>()

  constructor(config: TelegramConnectorConfig) {
    this.botToken = config.botToken
    this.workingDir = config.workingDir
    this.apiBaseUrl = config.apiBaseUrl ?? 'https://api.telegram.org'
    this.maxMessageLength = config.maxMessageLength ?? 4096
    this.allowedUserIds = config.allowedUserIds?.length
      ? new Set(config.allowedUserIds)
      : null
    this.dangerousMode = config.dangerousMode ?? true

    this.client = new HarnessClient({
      host: config.harnessHost ?? '127.0.0.1',
      port: config.harnessPort ?? 9555,
    })

    this.client.on('event', (event: BridgeEvent, channel: string) => {
      this.handleEvent(event, channel)
    })

    this.client.on('close', () => {
      console.log('[TelegramConnector] Disconnected from harness')
      this.connected = false
    })

    this.client.on('error', (err) => {
      console.error('[TelegramConnector] Client error:', err)
    })

    if (!this.allowedUserIds) {
      console.warn('[TelegramConnector] No allowedUserIds - bot is open to ALL users')
    }
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.connected) return

    await this.client.connect()
    this.connected = true
    console.log('[TelegramConnector] Connected to harness')
  }

  disconnect(): void {
    this.client.close()
    this.connected = false
    this.sessions.clear()
    this.pendingRequests.clear()
    this.responseBuffers.clear()
  }

  isConnected(): boolean {
    return this.connected
  }

  // ===========================================================================
  // Webhook Handler
  // ===========================================================================

  /**
   * Handle an incoming Telegram webhook update.
   * Returns true if the update was processed, false if ignored.
   */
  async handleUpdate(update: TelegramUpdate): Promise<boolean> {
    const message = update.message ?? update.edited_message ??
      update.channel_post ?? update.edited_channel_post

    if (!message) return false

    const userId = message.from?.id
    if (this.allowedUserIds && userId && !this.allowedUserIds.has(userId)) {
      console.log(`[TelegramConnector] Rejected unauthorized user: ${userId}`)
      await this.sendMessage(message.chat.id, 'Unauthorized.')
      return false
    }

    const text = message.text ?? message.caption
    if (!text?.trim()) return false

    // Handle commands
    if (text.startsWith('/')) {
      return this.handleCommand(message, text)
    }

    // Check if this is a response to a pending user_prompt
    const session = this.sessions.get(message.chat.id)
    if (session?.pendingUserPrompt) {
      return this.handleUserPromptResponse(message, text, session.pendingUserPrompt)
    }

    // Regular message - send to harness
    return this.processMessage(update, message, text)
  }

  // ===========================================================================
  // Message Processing
  // ===========================================================================

  private async handleCommand(message: TelegramMessage, command: string): Promise<boolean> {
    const chatId = message.chat.id
    const cmd = command.split(' ')[0].toLowerCase()

    switch (cmd) {
      case '/start':
      case '/help':
        await this.sendMessage(chatId,
          `Hello${message.from?.first_name ? ` ${message.from.first_name}` : ''}!\n\n` +
          `I'm an AI assistant. Send me a message and I'll help you.\n\n` +
          `Session: \`telegram:${chatId}\`\n\n` +
          `Commands:\n` +
          `/new - Start fresh conversation\n` +
          `/help - Show this message`,
          'Markdown'
        )
        return true

      case '/new':
        this.sessions.delete(chatId)
        await this.sendMessage(chatId,
          `Started new session: \`telegram:${chatId}\`\n\nPrevious context cleared.`,
          'Markdown'
        )
        return true

      default:
        // Unknown command - treat as regular message
        return this.processMessage(
          { update_id: 0, message },
          message,
          command
        )
    }
  }

  private async processMessage(
    update: TelegramUpdate,
    message: TelegramMessage,
    text: string
  ): Promise<boolean> {
    if (!this.connected) {
      try {
        await this.connect()
      } catch (err) {
        console.error('[TelegramConnector] Failed to connect:', err)
        await this.sendMessage(message.chat.id, 'Service unavailable. Try again later.')
        return false
      }
    }

    const chatId = message.chat.id
    const sessionKey = `telegram:${chatId}`
    const requestId = this.generateRequestId(update.update_id, message.message_id)

    // Initialize session if needed
    let session = this.sessions.get(chatId)
    if (!session?.initialized) {
      await this.initSession(chatId, sessionKey)
      session = this.sessions.get(chatId)!
    }

    // Track this request
    this.pendingRequests.set(requestId, {
      chatId,
      messageId: message.message_id,
      text,
      startedAt: Date.now(),
    })
    this.responseBuffers.set(requestId, '')

    // Subscribe to run events and send message
    this.client.subscribeRun(requestId)
    this.client.send({
      type: 'send_text',
      data: {
        text,
        client_request_id: requestId,
      },
    })

    // Send typing indicator
    await this.sendChatAction(chatId, 'typing')

    return true
  }

  private async handleUserPromptResponse(
    message: TelegramMessage,
    text: string,
    requestId: string
  ): Promise<boolean> {
    const chatId = message.chat.id
    const session = this.sessions.get(chatId)

    if (!session) return false

    // Clear pending prompt
    session.pendingUserPrompt = undefined

    // Parse response - could be a number (option index) or freeform text
    let response = text.trim()
    const optionIndex = parseInt(response, 10)
    if (!isNaN(optionIndex) && optionIndex > 0) {
      // Convert 1-indexed to 0-indexed
      response = String(optionIndex - 1)
    }

    // Send response to harness
    this.client.send({
      type: 'user_prompt_response',
      data: {
        request_id: requestId,
        response,
      },
    })

    await this.sendChatAction(chatId, 'typing')
    return true
  }

  private async initSession(chatId: number, sessionKey: string): Promise<void> {
    this.client.subscribeSession(sessionKey)

    this.client.send({
      type: 'init',
      data: {
        session_key: sessionKey,
        working_dir: this.workingDir,
      },
    })

    // Enable dangerous mode if configured
    if (this.dangerousMode) {
      await this.client.setDangerousMode(true)
    }

    this.sessions.set(chatId, { initialized: true })
  }

  // ===========================================================================
  // Event Handling
  // ===========================================================================

  private handleEvent(event: BridgeEvent, channel: string): void {
    // Handle direct channel events (errors, provider_key_required, etc.)
    if (channel === 'direct') {
      this.handleDirectEvent(event)
      return
    }

    // Extract requestId from channel (run:requestId)
    const requestId = channel.startsWith('run:') ? channel.slice(4) : null
    if (!requestId) return

    const pending = this.pendingRequests.get(requestId)
    if (!pending) return

    switch (event.type) {
      case 'stream':
        this.handleStreamEvent(requestId, event, pending)
        break

      case 'response':
        this.handleResponseEvent(requestId, pending)
        break

      case 'error':
        this.handleErrorEvent(requestId, event, pending)
        break

      case 'user_prompt':
        this.handleUserPromptEvent(requestId, event, pending)
        break

      case 'status':
      case 'progress':
        // Keep typing indicator active
        void this.sendChatAction(pending.chatId, 'typing')
        break
    }
  }

  private handleDirectEvent(event: BridgeEvent): void {
    const data = event.data as Record<string, unknown> | undefined

    switch (event.type) {
      case 'error': {
        const message = typeof data?.message === 'string' ? data.message : 'Unknown error'
        console.error('[TelegramConnector] Direct error:', message)
        // Send to all active sessions - we don't know which chat triggered this
        for (const [chatId] of this.sessions) {
          void this.sendMessage(chatId, `⚠️ ${message}`)
        }
        break
      }

      case 'provider_key_required': {
        const provider = typeof data?.provider === 'string' ? data.provider : 'unknown'
        const model = typeof data?.model === 'string' ? data.model : 'unknown'
        console.warn(`[TelegramConnector] Provider key required: ${provider} for ${model}`)
        for (const [chatId] of this.sessions) {
          void this.sendMessage(chatId, `⚠️ API key required for ${provider} (${model})`)
        }
        break
      }

      case 'model_changed': {
        const model = typeof data?.model === 'string' ? data.model : null
        const provider = typeof data?.provider === 'string' ? data.provider : null
        if (model && provider) {
          console.log(`[TelegramConnector] Model changed: ${provider}/${model}`)
        }
        break
      }

      default:
        // Log but don't crash on unknown direct events
        console.log(`[TelegramConnector] Direct event: ${event.type}`)
    }
  }

  private handleStreamEvent(
    requestId: string,
    event: BridgeEvent,
    pending: PendingRequest
  ): void {
    const data = event.data as { chunk?: string; is_reasoning?: boolean } | undefined
    if (data?.chunk && !data.is_reasoning) {
      const buffer = this.responseBuffers.get(requestId) ?? ''
      this.responseBuffers.set(requestId, buffer + data.chunk)
    }
    void this.sendChatAction(pending.chatId, 'typing')
  }

  private handleResponseEvent(requestId: string, pending: PendingRequest): void {
    const text = this.responseBuffers.get(requestId) ?? ''

    // Cleanup
    this.pendingRequests.delete(requestId)
    this.responseBuffers.delete(requestId)

    // Send response to Telegram
    if (text.trim()) {
      void this.sendLongMessage(pending.chatId, text, pending.messageId)
    } else {
      void this.sendMessage(pending.chatId, '(No response)', undefined, pending.messageId)
    }
  }

  private handleErrorEvent(
    requestId: string,
    event: BridgeEvent,
    pending: PendingRequest
  ): void {
    const data = event.data as { message?: string } | undefined
    const errorMsg = data?.message ?? 'Unknown error'

    // Cleanup
    this.pendingRequests.delete(requestId)
    this.responseBuffers.delete(requestId)

    void this.sendMessage(pending.chatId, `Error: ${errorMsg}`, undefined, pending.messageId)
  }

  private handleUserPromptEvent(
    requestId: string,
    event: BridgeEvent,
    pending: PendingRequest
  ): void {
    const data = event.data as {
      question?: string
      options?: Array<string | { label: string; description?: string }>
    } | undefined

    const question = data?.question ?? 'The assistant has a question:'
    const options = data?.options

    // Mark session as waiting for user prompt response
    const session = this.sessions.get(pending.chatId)
    if (session) {
      session.pendingUserPrompt = requestId
    }

    // Format question with options
    let formattedQuestion = `*Question:*\n\n${question}`
    if (options?.length) {
      formattedQuestion += '\n\n*Options:*\n'
      options.forEach((opt, i) => {
        const label = typeof opt === 'string' ? opt : opt.label
        formattedQuestion += `${i + 1}. ${label}\n`
      })
      formattedQuestion += '\n_Reply with a number or type your answer._'
    }

    void this.sendMessage(pending.chatId, formattedQuestion, 'Markdown')
  }

  // ===========================================================================
  // Telegram API
  // ===========================================================================

  async sendMessage(
    chatId: number,
    text: string,
    parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML',
    replyToMessageId?: number
  ): Promise<boolean> {
    try {
      const body: Record<string, unknown> = { chat_id: chatId, text }
      if (parseMode) body.parse_mode = parseMode
      if (replyToMessageId) body.reply_to_message_id = replyToMessageId

      const response = await fetch(
        `${this.apiBaseUrl}/bot${this.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      )

      if (!response.ok) {
        const err = await response.text()
        console.error('[TelegramConnector] sendMessage failed:', err)
        return false
      }

      return true
    } catch (err) {
      console.error('[TelegramConnector] sendMessage error:', err)
      return false
    }
  }

  async sendLongMessage(
    chatId: number,
    text: string,
    replyToMessageId?: number
  ): Promise<void> {
    const chunks = this.splitMessage(text)

    for (let i = 0; i < chunks.length; i++) {
      await this.sendMessage(
        chatId,
        chunks[i],
        undefined,
        i === 0 ? replyToMessageId : undefined
      )

      // Small delay between chunks to avoid rate limits
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }

  async sendChatAction(
    chatId: number,
    action: 'typing' | 'upload_photo' | 'upload_document'
  ): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.apiBaseUrl}/bot${this.botToken}/sendChatAction`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, action }),
        }
      )
      return response.ok
    } catch {
      return false
    }
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private generateRequestId(updateId: number, messageId: number): string {
    return `tg_${updateId}_${messageId}_${Date.now()}`
  }

  private splitMessage(text: string): string[] {
    if (text.length <= this.maxMessageLength) {
      return [text]
    }

    const chunks: string[] = []
    let remaining = text

    while (remaining.length > 0) {
      if (remaining.length <= this.maxMessageLength) {
        chunks.push(remaining)
        break
      }

      // Try to break at newline
      let breakPoint = remaining.lastIndexOf('\n', this.maxMessageLength)
      if (breakPoint < this.maxMessageLength * 0.5) {
        // Try space
        breakPoint = remaining.lastIndexOf(' ', this.maxMessageLength)
      }
      if (breakPoint < this.maxMessageLength * 0.5) {
        // Hard break
        breakPoint = this.maxMessageLength
      }

      chunks.push(remaining.slice(0, breakPoint))
      remaining = remaining.slice(breakPoint).trimStart()
    }

    return chunks
  }

  getBotId(): string {
    return this.botToken.split(':')[0]
  }

  // ===========================================================================
  // Long Polling (alternative to webhooks)
  // ===========================================================================

  private pollingActive = false
  private lastUpdateId = 0
  private pollingConflictCount = 0

  /**
   * Start long polling for updates.
   * Use this instead of webhooks when you don't want to expose a public endpoint.
   */
  async startPolling(intervalMs = 1000): Promise<void> {
    if (this.pollingActive) return
    this.pollingActive = true

    // Delete any existing webhook first (required before using getUpdates)
    console.log('[TelegramConnector] Deleting webhook before starting polling...')
    try {
      const deleteResponse = await fetch(
        `${this.apiBaseUrl}/bot${this.botToken}/deleteWebhook?drop_pending_updates=true`
      )
      const deleteResult = await deleteResponse.json() as { ok: boolean; description?: string }
      if (deleteResult.ok) {
        console.log('[TelegramConnector] Webhook deleted successfully')
      } else {
        console.error('[TelegramConnector] Failed to delete webhook:', deleteResult.description)
        this.pollingActive = false
        throw new Error(`Failed to delete webhook: ${deleteResult.description}`)
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Failed to delete webhook')) {
        throw err
      }
      console.error('[TelegramConnector] Error deleting webhook:', err)
      this.pollingActive = false
      throw err
    }

    // Wait a moment for Telegram to process the webhook deletion
    await new Promise(r => setTimeout(r, 1000))

    // Verify webhook is deleted by checking getWebhookInfo
    try {
      const infoResponse = await fetch(
        `${this.apiBaseUrl}/bot${this.botToken}/getWebhookInfo`
      )
      const info = await infoResponse.json() as { ok: boolean; result: { url: string } }
      if (info.ok && info.result.url) {
        console.error('[TelegramConnector] Webhook still set to:', info.result.url)
        this.pollingActive = false
        throw new Error('Webhook deletion did not take effect')
      }
      console.log('[TelegramConnector] Verified: no webhook set')
    } catch (err) {
      if (err instanceof Error && err.message === 'Webhook deletion did not take effect') {
        throw err
      }
      console.warn('[TelegramConnector] Could not verify webhook status:', err)
    }

    console.log('[TelegramConnector] Starting long polling...')

    // Flush any stale long-poll requests from previous runs with timeout=0
    // This immediately returns and "claims" the polling slot
    try {
      const flushResponse = await fetch(
        `${this.apiBaseUrl}/bot${this.botToken}/getUpdates?offset=-1&timeout=0`
      )
      if (flushResponse.ok) {
        const flushData = await flushResponse.json() as { ok: boolean; result: TelegramUpdate[] }
        if (flushData.result?.length) {
          this.lastUpdateId = Math.max(...flushData.result.map(u => u.update_id))
        }
        console.log('[TelegramConnector] Flushed stale requests, ready for polling')
      }
    } catch (err) {
      console.warn('[TelegramConnector] Flush failed (will retry):', err)
    }

    while (this.pollingActive) {
      try {
        const response = await fetch(
          `${this.apiBaseUrl}/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30`,
          { signal: AbortSignal.timeout(35000) }
        )

        if (!response.ok) {
          const errorText = await response.text()
          if (response.status === 409) {
            this.pollingConflictCount += 1
            if (this.pollingConflictCount === 1) {
              console.warn('[TelegramConnector] getUpdates conflict:', errorText)
              console.warn('[TelegramConnector] Ensure only one bot instance is polling and no webhook is set.')
            }
            const backoffMs = Math.min(30000, Math.max(intervalMs, 1000) * this.pollingConflictCount)
            await new Promise(r => setTimeout(r, backoffMs))
            continue
          }

          console.error('[TelegramConnector] getUpdates failed:', errorText)
          await new Promise(r => setTimeout(r, intervalMs))
          continue
        }

        const data = await response.json() as { ok: boolean; result: TelegramUpdate[] }
        this.pollingConflictCount = 0

        for (const update of data.result || []) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id)
          this.handleUpdate(update).catch(err => {
            console.error('[TelegramConnector] Error processing update:', err)
          })
        }
      } catch (err) {
        if (this.pollingActive) {
          console.error('[TelegramConnector] Polling error:', err)
          await new Promise(r => setTimeout(r, intervalMs))
        }
      }
    }

    console.log('[TelegramConnector] Polling stopped')
  }

  /**
   * Stop the polling loop.
   */
  stopPolling(): void {
    this.pollingActive = false
  }

  /**
   * Check if polling is active.
   */
  isPolling(): boolean {
    return this.pollingActive
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createTelegramConnector(config: TelegramConnectorConfig): TelegramConnector {
  return new TelegramConnector(config)
}
