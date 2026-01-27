/**
 * Telegram API Types
 *
 * Minimal type definitions for Telegram Bot API webhook handling.
 */

// ============================================================================
// Telegram API Types
// ============================================================================

export interface TelegramUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
}

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
  caption?: string
  reply_to_message?: TelegramMessage
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
  edited_channel_post?: TelegramMessage
}

// ============================================================================
// Connector Types
// ============================================================================

export interface TelegramConnectorConfig {
  /** Bot token from @BotFather */
  botToken: string
  /** Harness daemon host (default: '127.0.0.1') */
  harnessHost?: string
  /** Harness daemon port (default: 9555) */
  harnessPort?: number
  /** Working directory for harness sessions */
  workingDir: string
  /** Telegram API base URL (default: 'https://api.telegram.org') */
  apiBaseUrl?: string
  /** Max message length before splitting (default: 4096) */
  maxMessageLength?: number
  /** Allowlist of Telegram user IDs. If empty, all users allowed. */
  allowedUserIds?: number[]
  /** Bypass harness permission checks (default: true for Telegram) */
  dangerousMode?: boolean
}

export interface PendingRequest {
  chatId: number
  messageId: number
  text: string
  startedAt: number
  /** true once response or error has been sent to the user */
  settled: boolean
  /** timestamp of last progress message sent (throttle) */
  lastProgressAt?: number
}

export interface ChatSession {
  initialized: boolean
  /** Request ID waiting for user_prompt response */
  pendingUserPrompt?: string
}
