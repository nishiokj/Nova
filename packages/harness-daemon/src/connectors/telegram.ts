/**
 * Telegram Connector
 *
 * Handles Telegram webhook payloads and sends responses via the Telegram Bot API.
 * Integrates with the harness via sessionKey-based conversation management.
 */

import type { AgentRunHandle, BridgeEvent } from '../harness/types.js';

// ============================================================================
// Telegram API Types
// ============================================================================

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

export interface TelegramSendMessageOptions {
  chat_id: number | string;
  text: string;
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  reply_to_message_id?: number;
  disable_notification?: boolean;
}

// ============================================================================
// Harness Integration Types
// ============================================================================

interface HarnessLike {
  run(params: {
    requestId: string;
    inputText: string;
    tier?: 'simple' | 'standard' | 'complex';
    sessionKey: string;
    workingDir: string;
    context?: string;
    planMode?: boolean;
  }): AgentRunHandle;
  hasApiKey(provider: string): boolean;
  getSessionSelectedModel?(sessionKey: string, agentType: string): { provider?: string; model?: string } | null;
}

// ============================================================================
// Telegram Connector
// ============================================================================

export interface TelegramConnectorConfig {
  /** Bot token from @BotFather */
  botToken: string;
  /** Working directory for harness runs */
  workingDir: string;
  /** Optional: Telegram API base URL (for testing) */
  apiBaseUrl?: string;
  /** Optional: Maximum message length before splitting (default: 4096) */
  maxMessageLength?: number;
  /** Optional: Timeout for harness runs in ms (default: 120000) */
  runTimeoutMs?: number;
}

export class TelegramConnector {
  private readonly botToken: string;
  private readonly workingDir: string;
  private readonly apiBaseUrl: string;
  private readonly maxMessageLength: number;
  private readonly runTimeoutMs: number;
  private harness: HarnessLike | null = null;

  constructor(config: TelegramConnectorConfig) {
    this.botToken = config.botToken;
    this.workingDir = config.workingDir;
    this.apiBaseUrl = config.apiBaseUrl ?? 'https://api.telegram.org';
    this.maxMessageLength = config.maxMessageLength ?? 4096;
    this.runTimeoutMs = config.runTimeoutMs ?? 120_000;
  }

  /**
   * Set the harness reference for processing messages.
   */
  setHarness(harness: HarnessLike): void {
    this.harness = harness;
  }

  /**
   * Generate a session key from a Telegram chat ID.
   * This provides conversation continuity per chat.
   */
  private getSessionKey(chatId: number): string {
    return `telegram:${chatId}`;
  }

  /**
   * Generate a request ID for a message.
   */
  private generateRequestId(updateId: number, messageId: number): string {
    return `tg_${updateId}_${messageId}_${Date.now()}`;
  }

  /**
   * Handle an incoming Telegram webhook update.
   * Returns true if the update was processed, false if skipped.
   */
  async handleUpdate(update: TelegramUpdate): Promise<boolean> {
    // Extract the message (could be message, edited_message, channel_post, etc.)
    const message = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;

    if (!message) {
      return false;
    }

    // Extract text content
    const text = message.text ?? message.caption;
    if (!text?.trim()) {
      return false;
    }

    // Skip bot commands that aren't for us (e.g., /start, /help handled separately)
    if (text.startsWith('/start') || text.startsWith('/help')) {
      await this.handleCommand(message, text);
      return true;
    }

    // Process with harness
    await this.processMessage(update, message, text);
    return true;
  }

  /**
   * Handle bot commands like /start and /help.
   */
  private async handleCommand(message: TelegramMessage, command: string): Promise<void> {
    const chatId = message.chat.id;

    if (command.startsWith('/start')) {
      await this.sendMessage({
        chat_id: chatId,
        text: `👋 Hello${message.from?.first_name ? ` ${message.from.first_name}` : ''}!\n\nI'm an AI assistant. Send me a message and I'll help you with coding, questions, or tasks.\n\nYour conversation history is preserved - I'll remember our previous messages.`,
      });
      return;
    }

    if (command.startsWith('/help')) {
      await this.sendMessage({
        chat_id: chatId,
        text: `📚 *Commands*\n\n/start - Start a conversation\n/help - Show this help message\n\nJust send me any text message to chat!`,
        parse_mode: 'Markdown',
      });
      return;
    }
  }

  /**
   * Process a message through the harness.
   */
  private async processMessage(
    update: TelegramUpdate,
    message: TelegramMessage,
    text: string
  ): Promise<void> {
    if (!this.harness) {
      console.error('[TelegramConnector] Harness not set');
      await this.sendMessage({
        chat_id: message.chat.id,
        text: '⚠️ Service not ready. Please try again later.',
      });
      return;
    }

    const chatId = message.chat.id;
    const sessionKey = this.getSessionKey(chatId);
    const requestId = this.generateRequestId(update.update_id, message.message_id);

    // Check if model is selected
    const activeSelection = this.harness.getSessionSelectedModel?.(sessionKey, 'standard');
    if (!activeSelection?.model || !activeSelection?.provider) {
      await this.sendMessage({
        chat_id: chatId,
        text: '⚠️ No model selected for this session. Please configure a model first.',
      });
      return;
    }

    // Check if API key is available
    if (!this.harness.hasApiKey(activeSelection.provider)) {
      await this.sendMessage({
        chat_id: chatId,
        text: `⚠️ No API key configured for provider: ${activeSelection.provider}`,
      });
      return;
    }

    // Send typing indicator
    await this.sendChatAction(chatId, 'typing');

    // Run the harness
    const handle = this.harness.run({
      requestId,
      inputText: text,
      sessionKey,
      workingDir: this.workingDir,
    });

    // Collect response and stream back to Telegram
    await this.streamResponseToTelegram(chatId, handle, message.message_id);
  }

  /**
   * Stream harness events back to Telegram.
   * Collects the full response and sends it, handling chunking for long messages.
   */
  private async streamResponseToTelegram(
    chatId: number,
    handle: AgentRunHandle,
    replyToMessageId?: number
  ): Promise<void> {
    let fullResponse = '';
    let hasError = false;
    let errorMessage = '';

    // Set up a timeout
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Request timed out')), this.runTimeoutMs);
    });

    try {
      // Race between event processing and timeout
      await Promise.race([
        (async () => {
          for await (const event of handle.events) {
            await this.handleEvent(chatId, event, (chunk) => {
              fullResponse += chunk;
            });

            if (event.type === 'error') {
              hasError = true;
              errorMessage = (event.data as { message?: string })?.message ?? 'Unknown error';
            }
          }
        })(),
        timeoutPromise,
      ]);

      // Wait for the final result
      const result = await handle.result;

      // If we have content in the result, use that
      if (result.finalText && result.finalText !== fullResponse) {
        fullResponse = result.finalText;
      }

      if (result.errorMessage && !hasError) {
        hasError = true;
        errorMessage = result.errorMessage;
      }
    } catch (error) {
      hasError = true;
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    // Send the final response
    if (fullResponse.trim()) {
      await this.sendLongMessage(chatId, fullResponse, replyToMessageId);
    } else if (hasError) {
      await this.sendMessage({
        chat_id: chatId,
        text: `⚠️ ${errorMessage}`,
        reply_to_message_id: replyToMessageId,
      });
    } else {
      await this.sendMessage({
        chat_id: chatId,
        text: '✅ Done (no response text)',
        reply_to_message_id: replyToMessageId,
      });
    }
  }

  /**
   * Handle a single event from the harness.
   */
  private async handleEvent(
    chatId: number,
    event: BridgeEvent,
    appendContent: (chunk: string) => void
  ): Promise<void> {
    switch (event.type) {
      case 'stream': {
        const data = event.data as { chunk?: string; is_reasoning?: boolean };
        // Skip reasoning content - only include actual response
        if (data?.chunk && !data.is_reasoning) {
          appendContent(data.chunk);
        }
        break;
      }

      case 'response': {
        const data = event.data as { content?: string; success?: boolean };
        if (data?.content) {
          // Response event contains the full content - replace accumulated stream
          appendContent(''); // Clear might be needed depending on implementation
        }
        break;
      }

      case 'status': {
        const data = event.data as { state?: string; message?: string };
        // Send typing indicator while processing
        if (data?.state === 'sending' || data?.state === 'streaming') {
          await this.sendChatAction(chatId, 'typing');
        }
        break;
      }

      case 'progress': {
        // Optionally send progress updates for long-running operations
        // For now, just maintain typing indicator
        await this.sendChatAction(chatId, 'typing');
        break;
      }

      // Ignore other event types
      default:
        break;
    }
  }

  /**
   * Send a message, splitting into chunks if necessary.
   */
  private async sendLongMessage(
    chatId: number,
    text: string,
    replyToMessageId?: number
  ): Promise<void> {
    // Split message if too long
    const chunks = this.splitMessage(text);

    for (let i = 0; i < chunks.length; i++) {
      await this.sendMessage({
        chat_id: chatId,
        text: chunks[i],
        // Only reply to the original message for the first chunk
        reply_to_message_id: i === 0 ? replyToMessageId : undefined,
      });

      // Small delay between chunks to avoid rate limiting
      if (i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  /**
   * Split a message into chunks that fit within Telegram's limit.
   */
  private splitMessage(text: string): string[] {
    if (text.length <= this.maxMessageLength) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= this.maxMessageLength) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point (newline, space, or hard cut)
      let breakPoint = remaining.lastIndexOf('\n', this.maxMessageLength);
      if (breakPoint < this.maxMessageLength * 0.5) {
        breakPoint = remaining.lastIndexOf(' ', this.maxMessageLength);
      }
      if (breakPoint < this.maxMessageLength * 0.5) {
        breakPoint = this.maxMessageLength;
      }

      chunks.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint).trimStart();
    }

    return chunks;
  }

  /**
   * Send a message via the Telegram Bot API.
   */
  async sendMessage(options: TelegramSendMessageOptions): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.apiBaseUrl}/bot${this.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        console.error('[TelegramConnector] sendMessage failed:', error);
        return false;
      }

      return true;
    } catch (error) {
      console.error('[TelegramConnector] sendMessage error:', error);
      return false;
    }
  }

  /**
   * Send a chat action (e.g., "typing").
   */
  async sendChatAction(chatId: number, action: 'typing' | 'upload_photo' | 'upload_document'): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.apiBaseUrl}/bot${this.botToken}/sendChatAction`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, action }),
        }
      );

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Set the webhook URL for this bot.
   */
  async setWebhook(url: string, options?: { secret_token?: string }): Promise<{ success: boolean; error?: string }> {
    try {
      const body: Record<string, unknown> = { url };
      if (options?.secret_token) {
        body.secret_token = options.secret_token;
      }

      const response = await fetch(
        `${this.apiBaseUrl}/bot${this.botToken}/setWebhook`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );

      const result = await response.json() as { ok: boolean; description?: string };

      if (!result.ok) {
        return { success: false, error: result.description };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Delete the webhook for this bot.
   */
  async deleteWebhook(): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(
        `${this.apiBaseUrl}/bot${this.botToken}/deleteWebhook`,
        { method: 'POST' }
      );

      const result = await response.json() as { ok: boolean; description?: string };

      if (!result.ok) {
        return { success: false, error: result.description };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Get the bot token (for verification).
   */
  getBotToken(): string {
    return this.botToken;
  }

  /**
   * Extract bot ID from token (format: BOT_ID:SECRET).
   */
  getBotId(): string {
    return this.botToken.split(':')[0];
  }
}

// ============================================================================
// Webhook Handler Factory
// ============================================================================

/**
 * Create a webhook handler for the HTTP server.
 */
export function createTelegramWebhookHandler(connector: TelegramConnector) {
  return async (body: unknown, headers: Record<string, string>): Promise<{ status: number; body: unknown }> => {
    // Validate the update
    if (!body || typeof body !== 'object') {
      return { status: 400, body: { error: 'Invalid request body' } };
    }

    const update = body as TelegramUpdate;

    if (typeof update.update_id !== 'number') {
      return { status: 400, body: { error: 'Missing update_id' } };
    }

    try {
      // Process the update asynchronously
      // Telegram expects a quick 200 OK response
      void connector.handleUpdate(update).catch((error) => {
        console.error('[TelegramWebhook] Error processing update:', error);
      });

      return { status: 200, body: { ok: true } };
    } catch (error) {
      console.error('[TelegramWebhook] Error:', error);
      return { status: 500, body: { error: 'Internal server error' } };
    }
  };
}
