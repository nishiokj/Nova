/**
 * Telegram Connector
 *
 * Bridges Telegram webhooks to the harness-daemon via harness-client.
 * Handles message routing, session management, and user prompts.
 */

import { HarnessClient, type BridgeEvent, type Attachment, type ConnectionState } from 'harness-client'
import type {
  TelegramConnectorConfig,
  TelegramUpdate,
  TelegramMessage,
  TelegramFile,
  PhotoSize,
  RequestState,
  ChatSession,
} from './types.js'

export * from './types.js'
export { sendTelegramMessage, notifyAllUsers } from './notify.js'

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
  private readonly fetchTimeoutMs: number = 30000 // 30s timeout for API calls

  private client: HarnessClient
  private connectionState: ConnectionState = 'disconnected'

  /** chatId → session state */
  private sessions = new Map<number, ChatSession>()
  /** requestId → request state */
  private requests = new Map<string, RequestState>()

  /** Background cleanup interval */
  private reaperInterval: NodeJS.Timeout | null = null
  /** Reconnection queue for messages sent while disconnected */
  private messageQueue: Array<{ update: TelegramUpdate; retryCount: number }> = []

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
    })

    this.client.on('connection_state', (state: ConnectionState) => {
      this.connectionState = state
      if (state === 'connected') {
        void this.flushQueuedMessages()
      }
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
    if (this.connectionState === 'connected') return

    await this.client.connect()
    console.log('[TelegramConnector] Connected to harness')

    // Start background cleanup interval
    this.startReaper()
  }

  disconnect(): void {
    // Stop reaper
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval)
      this.reaperInterval = null
    }

    this.client.close()
    this.connectionState = 'disconnected'
    this.sessions.clear()
    this.requests.clear()
    this.messageQueue = []
  }

  /**
   * Start background reaper to clean up stale requests periodically.
   * Runs every 60 seconds instead of only on new messages.
   */
  private startReaper(): void {
    if (this.reaperInterval) return

    this.reaperInterval = setInterval(() => {
      this.reapStaleRequests()
    }, 60_000) // Check every minute
  }

  isConnected(): boolean {
    return this.connectionState === 'connected'
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

    const text = message.text ?? message.caption ?? ''
    const hasMedia = message.photo?.length || message.document

    // Reject if no text and no media
    if (!text.trim() && !hasMedia) {
      return false
    }

    // Handle commands (only if there's text)
    if (text.startsWith('/')) {
      return this.handleCommand(message, text)
    }

    // Check if this is a response to a pending user_prompt
    const session = this.sessions.get(message.chat.id)
    if (session?.pendingUserPrompt) {
      return this.handleUserPromptResponse(message, text, session.pendingUserPrompt)
    }

    // Regular message - send to harness
    const photoFileId = message.photo?.[message.photo.length - 1]?.file_id
    const documentFileId = message.document?.file_id

    return this.processMessage(update, message, text, {
      photo: photoFileId ? { file_id: photoFileId } : undefined,
      document: documentFileId ? { file_id: documentFileId } : undefined,
    })
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
          `Session: \`${this.getSessionKey(chatId)}\`\n\n` +
          `Commands:\n` +
          `/new - Start fresh conversation\n` +
          `/async <goal> - Start an async session\n` +
          `/help - Show this message`,
          'Markdown'
        )
        return true

      case '/new': {
        // Close the existing session on the bridge side so context is persisted + cleared
        const oldSession = this.sessions.get(chatId)
        if (oldSession?.initialized) {
          this.client.send({ type: 'session_close', data: {} })
        }
        this.sessions.delete(chatId)

        // Generate a unique session key so init doesn't reload old context
        const newSessionKey = `telegram:${chatId}:${Date.now()}`
        await this.initSession(chatId, newSessionKey)

        await this.sendMessage(chatId,
          `Started new session: \`${newSessionKey}\`\n\nPrevious context cleared.`,
          'Markdown'
        )
        return true
      }

      case '/async': {
        const goal = command.slice(cmd.length).trim()
        if (!goal) {
          await this.sendMessage(
            chatId,
            `Usage: /async <goal>\n\n` +
              `Starts an async session with watcher oversight.\n` +
              `Example:\n` +
              `/async refactor the payment module to use Stripe`
          )
          return true
        }

        if (!this.isConnected()) {
          await this.sendMessage(chatId, '🔄 Reconnecting... Please try /async again in a moment.')
          void this.client.connect().catch(err => {
            console.error('[TelegramConnector] Reconnect failed:', err)
          })
          return true
        }

        let session = this.sessions.get(chatId)
        if (!session?.initialized) {
          const sessionKey = this.getSessionKey(chatId)
          await this.initSession(chatId, sessionKey)
          session = this.sessions.get(chatId)!
        }

        session.lastActivityAt = Date.now()
        this.reapStaleRequests()

        await this.sendMessage(chatId, `🟡 Starting async session...\nGoal: ${goal}`)

        const result = await this.client.asyncStart(goal, this.workingDir)
        if (!result.success) {
          await this.sendMessage(chatId, `⚠️ Failed to start async session: ${result.error ?? 'Unknown error'}`)
          return true
        }

        if (result.requestId) {
          this.requests.set(result.requestId, {
            status: 'streaming',
            requestId: result.requestId,
            chatId,
            messageId: message.message_id,
            text: goal,
            startedAt: Date.now(),
            buffer: '',
          })
          this.client.subscribeRun(result.requestId)
        }

        await this.sendMessage(
          chatId,
          `✅ Async session started.\nRequest: ${result.requestId ?? 'unknown'}`
        )
        return true
      }

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
    text: string,
    attachments?: { photo?: { file_id: string }, document?: { file_id: string } }
  ): Promise<boolean> {
    // Handle disconnection with reconnection queue
    if (!this.isConnected()) {
      // Queue the message for retry and inform user
      this.messageQueue.push({ update, retryCount: 0 })

      // Try to reconnect in background
      void this.client.connect().catch(err => {
        console.error('[TelegramConnector] Reconnect failed:', err)
      })

      await this.sendMessage(message.chat.id, '🔄 Reconnecting... Your message is queued.')
      return true
    }

    const chatId = message.chat.id
    const requestId = this.generateRequestId(update.update_id, message.message_id)

    // Initialize session if needed
    let session = this.sessions.get(chatId)
    if (!session?.initialized) {
      const sessionKey = this.getSessionKey(chatId)
      await this.initSession(chatId, sessionKey)
      session = this.sessions.get(chatId)!
    }

    // Update session activity timestamp
    session.lastActivityAt = Date.now()

    // Clean up any stale requests before adding new ones
    this.reapStaleRequests()

    // Build attachment list if present
    const attachmentList: Attachment[] = []
    let attachmentFailed = false

    if (attachments?.photo) {
      try {
        const file = await this.getFile(attachments.photo.file_id)
        if (file?.file_path) {
          attachmentList.push({
            type: 'image',
            url: this.getFileUrl(file),
            file_id: file.file_id,
            mimeType: 'image/jpeg',
            size: file.file_size,
          })
          await this.sendChatAction(chatId, 'upload_photo')
        } else {
          attachmentFailed = true
          await this.sendMessage(chatId, '⚠️ Failed to retrieve photo. Message will be sent without attachment.')
        }
      } catch (err) {
        console.error('[TelegramConnector] Photo fetch error:', err)
        attachmentFailed = true
        await this.sendMessage(chatId, '⚠️ Failed to retrieve photo. Message will be sent without attachment.')
      }
    }

    if (attachments?.document) {
      try {
        const file = await this.getFile(attachments.document.file_id)
        if (file?.file_path) {
          attachmentList.push({
            type: 'document',
            url: this.getFileUrl(file),
            file_id: file.file_id,
          })
          await this.sendChatAction(chatId, 'upload_document')
        } else {
          attachmentFailed = true
          await this.sendMessage(chatId, '⚠️ Failed to retrieve document. Message will be sent without attachment.')
        }
      } catch (err) {
        console.error('[TelegramConnector] Document fetch error:', err)
        attachmentFailed = true
        await this.sendMessage(chatId, '⚠️ Failed to retrieve document. Message will be sent without attachment.')
      }
    }

    // Track this request
    this.requests.set(requestId, {
      status: 'streaming',
      requestId,
      chatId,
      messageId: message.message_id,
      text,
      startedAt: Date.now(),
      buffer: '',
      attachments: attachmentList.length > 0 ? attachmentList : undefined,
    })

    if (!text.trim() && attachmentList.length > 0) {
      await this.sendMessage(
        chatId,
        '⚠️ Attachments require a caption for now. Please resend with text.'
      )
      this.requests.delete(requestId)
      return true
    }

    // Subscribe to run events and send message
    this.client.subscribeRun(requestId)

    // Harness bridge doesn't support send_media yet; always use send_text
    if (attachmentList.length > 0) {
      await this.sendMessage(
        chatId,
        '⚠️ Attachments are not yet supported by the service. Sending text only.'
      )
    }
    const commandType = 'send_text'
    const sent = this.client.send({
      type: commandType,
      data: {
        text,
        client_request_id: requestId,
        attachments: attachmentList.length > 0 ? attachmentList : undefined,
      },
    })

    if (!sent) {
      console.error('[TelegramConnector] Failed to send message to harness')
      await this.sendMessage(chatId, '⚠️ Failed to send message to service. Please try again.')
      this.requests.delete(requestId)
      return false
    }

    // Send typing indicator
    await this.sendChatAction(chatId, 'typing')

    return true
  }

  /**
   * Attempt to reconnect to harness and process queued messages.
   */
  private async flushQueuedMessages(): Promise<void> {
    if (this.messageQueue.length === 0) return

    const queue = [...this.messageQueue]
    this.messageQueue = []

    for (const item of queue) {
      try {
        await this.handleUpdate(item.update)
      } catch (err) {
        console.error('[TelegramConnector] Failed to process queued message:', err)
      }
    }
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
    const sent = this.client.send({
      type: 'user_prompt_response',
      data: {
        request_id: requestId,
        answer: response,
      },
    })

    if (!sent) {
      await this.sendMessage(chatId, '⚠️ Failed to send your response. Please try again.')
      return true
    }

    const request = this.requests.get(requestId)
    if (request) {
      request.status = 'streaming'
      request.prompt = undefined
    }

    await this.sendChatAction(chatId, 'typing')
    return true
  }

  /**
   * Get the session key for a chat, falling back to the deterministic default.
   */
  private getSessionKey(chatId: number): string {
    return this.sessions.get(chatId)?.sessionKey ?? `telegram:${chatId}`
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

    this.sessions.set(chatId, { initialized: true, sessionKey })
  }

  // ===========================================================================
  // Event Handling
  // ===========================================================================

  private handleEvent(event: BridgeEvent, channel: string): void {
    try {
      // Handle direct channel events (errors, provider_key_required, etc.)
      if (channel === 'direct') {
        this.handleDirectEvent(event)
        return
      }

      // Extract requestId from channel (run:requestId)
      const requestId = channel.startsWith('run:') ? channel.slice(4) : null
      if (!requestId) return

      const request = this.requests.get(requestId)
      if (!request) return

      switch (event.type) {
        case 'stream':
          this.handleStreamEvent(requestId, event, request)
          break

        case 'response':
          void this.handleResponseEvent(requestId, event, request)
          break

        case 'error':
          void this.handleErrorEvent(requestId, event, request)
          break

        case 'user_prompt':
          this.handleUserPromptEvent(requestId, event, request)
          break

        case 'status':
          void this.sendChatAction(request.chatId, 'typing')
          break

        case 'progress': {
          const progData = event.data
          void this.sendChatAction(request.chatId, 'typing')

          // Send progress text for tool/work events, throttled to 1 per 10s
          if (progData?.message && (progData.kind === 'tool' || progData.kind === 'work')) {
            const now = Date.now()
            if (!request.lastProgressAt || now - request.lastProgressAt > 10_000) {
              request.lastProgressAt = now
              void this.sendMessage(request.chatId, progData.message)
            }
          }
          break
        }
      }
    } catch (err) {
      console.error('[TelegramConnector] Unhandled error in handleEvent:', err)
    }
  }

  private handleDirectEvent(event: BridgeEvent): void {
    try {
      switch (event.type) {
        case 'error': {
          const message = event.data?.message ?? 'Unknown error'
          console.error('[TelegramConnector] Direct error:', message)
          // Send to all active sessions - we don't know which chat triggered this
          for (const [chatId] of this.sessions) {
            void this.sendMessage(chatId, `⚠️ ${message}`)
          }
          break
        }

        case 'provider_key_required': {
          const provider = event.data?.provider ?? 'unknown'
          const model = event.data?.model ?? 'unknown'
          console.warn(`[TelegramConnector] Provider key required: ${provider} for ${model}`)
          for (const [chatId] of this.sessions) {
            void this.sendMessage(chatId, `⚠️ API key required for ${provider} (${model}). Please configure in your settings.`)
          }
          break
        }

        case 'model_changed': {
          const model = event.data?.model ?? null
          const provider = event.data?.provider ?? null
          if (model && provider) {
            console.log(`[TelegramConnector] Model changed: ${provider}/${model}`)
          }
          break
        }

        default:
          // Log but don't crash on unknown direct events
          console.log(`[TelegramConnector] Direct event: ${event.type}`)
      }
    } catch (err) {
      console.error('[TelegramConnector] Unhandled error in handleDirectEvent:', err)
    }
  }

  private handleStreamEvent(
    requestId: string,
    event: Extract<BridgeEvent, { type: 'stream' }>,
    request: RequestState
  ): void {
    try {
      const data = event.data
      if (data?.chunk && !data.is_reasoning) {
        request.status = 'streaming'
        request.buffer += data.chunk
      }
      void this.sendChatAction(request.chatId, 'typing')
    } catch (err) {
      console.error('[TelegramConnector] Error in handleStreamEvent:', err)
    }
  }

  private async handleResponseEvent(
    requestId: string,
    event: Extract<BridgeEvent, { type: 'response' }>,
    request: RequestState
  ): Promise<void> {
    try {
      let text = request.buffer
      if (!text.trim()) {
        if (typeof event.data?.content === 'string') {
          text = event.data.content
        }
      }
      if (text.trim()) {
        await this.sendLongMessage(request.chatId, text, request.messageId)
      } else {
        await this.sendMessage(request.chatId, '(No response)', undefined, request.messageId)
      }
    } catch (err) {
      console.error('[TelegramConnector] Error in handleResponseEvent:', err)
      await this.sendMessage(request.chatId, '⚠️ Failed to send response. Please try again.', undefined, request.messageId)
    } finally {
      // Always clean up
      this.requests.delete(requestId)
    }
  }

  private async handleErrorEvent(
    requestId: string,
    event: Extract<BridgeEvent, { type: 'error' }>,
    request: RequestState
  ): Promise<void> {
    try {
      // Flush accumulated buffer first
      if (request.buffer.trim()) {
        await this.sendLongMessage(request.chatId, request.buffer, request.messageId)
      }

      const errorMsg = event.data?.message ?? 'Unknown error'

      // Provide more actionable error messages
      let userMessage = `Error: ${errorMsg}`
      if (errorMsg.includes('timeout') || errorMsg.includes('timed out')) {
        userMessage += '\n\n💡 Tip: The request took too long. Try breaking it into smaller tasks.'
      } else if (errorMsg.includes('rate limit')) {
        userMessage += '\n\n💡 Tip: Please wait a moment before trying again.'
      }

      await this.sendMessage(request.chatId, userMessage, undefined, request.messageId)
    } catch (err) {
      console.error('[TelegramConnector] Error in handleErrorEvent:', err)
    } finally {
      // Always clean up to prevent memory leaks
      this.requests.delete(requestId)
    }
  }

  private handleUserPromptEvent(
    requestId: string,
    event: Extract<BridgeEvent, { type: 'user_prompt' }>,
    request: RequestState
  ): void {
    try {
      const question = event.data?.question ?? 'The assistant has a question:'
      const options = event.data?.options

      // Mark session as waiting for user prompt response
      const session = this.sessions.get(request.chatId)
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

      request.status = 'awaiting_prompt'
      request.prompt = { question, options }

      void this.sendMessage(request.chatId, formattedQuestion, 'Markdown')
    } catch (err) {
      console.error('[TelegramConnector] Error in handleUserPromptEvent:', err)
    }
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
    const result = await this._sendMessageRaw(chatId, text, parseMode, replyToMessageId)
    if (!result && parseMode) {
      // Markdown rejected — retry as plain text and log fallback
      console.log('[TelegramConnector] Markdown rejected, falling back to plain text')
      return this._sendMessageRaw(chatId, text, undefined, replyToMessageId)
    }
    return result
  }

  private async _sendMessageRaw(
    chatId: number,
    text: string,
    parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML',
    replyToMessageId?: number
  ): Promise<boolean> {
    try {
      const body: Record<string, unknown> = { chat_id: chatId, text }
      if (parseMode) body.parse_mode = parseMode
      if (replyToMessageId) body.reply_to_message_id = replyToMessageId

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.fetchTimeoutMs)

      const response = await fetch(
        `${this.apiBaseUrl}/bot${this.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      )

      clearTimeout(timeoutId)

      if (!response.ok) {
        const err = await response.text()
        console.error('[TelegramConnector] sendMessage failed:', err)
        return false
      }

      return true
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.error('[TelegramConnector] sendMessage timeout')
      } else {
        console.error('[TelegramConnector] sendMessage error:', err)
      }
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

  // ===========================================================================
  // Telegram API - File Operations
  // ===========================================================================

  /**
   * Get file info from Telegram servers.
   * Returns file_path which can be used to construct a download URL.
   */
  async getFile(fileId: string): Promise<TelegramFile | null> {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.fetchTimeoutMs)

      const response = await fetch(
        `${this.apiBaseUrl}/bot${this.botToken}/getFile`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_id: fileId }),
          signal: controller.signal,
        }
      )

      clearTimeout(timeoutId)

      if (!response.ok) {
        const err = await response.text()
        console.error('[TelegramConnector] getFile failed:', err)
        return null
      }

      const data = await response.json() as { ok: boolean; result: TelegramFile }
      return data.result
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.error('[TelegramConnector] getFile timeout')
      } else {
        console.error('[TelegramConnector] getFile error:', err)
      }
      return null
    }
  }

  /**
   * Get the download URL for a file from Telegram.
   */
  getFileUrl(file: TelegramFile): string {
    if (!file.file_path) return ''
    return `${this.apiBaseUrl}/file/bot${this.botToken}/${file.file_path}`
  }

  // ===========================================================================
  // Telegram API - Sending
  // ===========================================================================

  async sendChatAction(
    chatId: number,
    action: 'typing' | 'upload_photo' | 'upload_document'
  ): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.fetchTimeoutMs)

      const response = await fetch(
        `${this.apiBaseUrl}/bot${this.botToken}/sendChatAction`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, action }),
          signal: controller.signal,
        }
      )

      clearTimeout(timeoutId)
      return response.ok
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.error('[TelegramConnector] sendChatAction timeout')
      }
      return false
    }
  }

  async sendPhoto(
    chatId: number,
    photo: string,
    caption?: string
  ): Promise<boolean> {
    try {
      const formData = new FormData()
      formData.append('chat_id', String(chatId))

      // If photo is a URL or file path, send as string
      // If it's binary data (starts with base64 pattern), send as Buffer
      if (photo.startsWith('http://') || photo.startsWith('https://') || photo.startsWith('/')) {
        formData.append('photo', photo)
      } else {
        // Assume it's base64 encoded image data
        const buffer = Buffer.from(photo, 'base64')
        formData.append('photo', new Blob([buffer]), 'image.png')
      }

      if (caption) {
        formData.append('caption', caption)
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.fetchTimeoutMs)

      const response = await fetch(
        `${this.apiBaseUrl}/bot${this.botToken}/sendPhoto`,
        {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        }
      )

      clearTimeout(timeoutId)

      if (!response.ok) {
        const err = await response.text()
        console.error('[TelegramConnector] sendPhoto failed:', err)
        return false
      }

      return true
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.error('[TelegramConnector] sendPhoto timeout')
      } else {
        console.error('[TelegramConnector] sendPhoto error:', err)
      }
      return false
    }
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private reapStaleRequests(): void {
    const now = Date.now()
    const TIMEOUT_MS = 3 * 60 * 1000 // Reduced to 3 minutes for better UX
    const PROMPT_TIMEOUT_MS = 24 * 60 * 60 * 1000

    for (const [requestId, request] of this.requests) {
      const timeout = request.status === 'awaiting_prompt' ? PROMPT_TIMEOUT_MS : TIMEOUT_MS
      if (now - request.startedAt <= timeout) continue

      // Stale: flush buffer, notify user, clean up
      if (request.buffer.trim()) {
        void this.sendLongMessage(request.chatId, request.buffer, request.messageId)
      }
      void this.sendMessage(
        request.chatId,
        '⏰ Request timed out. The service may be overloaded. Please try again.',
        undefined,
        request.messageId
      )

      this.requests.delete(requestId)
    }

    // Clean up old sessions (inactive for > 24 hours and not pending)
    const ONE_DAY = 24 * 60 * 60 * 1000
    for (const [chatId, session] of this.sessions) {
      if (!session.pendingUserPrompt && session.lastActivityAt) {
        if (now - session.lastActivityAt > ONE_DAY) {
          this.sessions.delete(chatId)
          console.log(`[TelegramConnector] Cleaned up inactive session: ${chatId}`)
        }
      }
    }
  }

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

          // Reset conflict counter on other errors to avoid unnecessary backoff
          if (this.pollingConflictCount > 0) {
            this.pollingConflictCount = 0
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
