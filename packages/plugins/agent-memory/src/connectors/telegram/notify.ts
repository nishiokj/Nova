/**
 * Standalone Telegram notification sender.
 *
 * Zero dependencies on TelegramConnector — safe to call from crash handlers,
 * CLI tools, or any context where the connector may not be initialized.
 */

const TELEGRAM_API = 'https://api.telegram.org'
const MAX_MESSAGE_LENGTH = 4096

/**
 * Send a message to a single Telegram chat via Bot API.
 * Automatically splits messages that exceed the 4096-char limit.
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: number,
  text: string,
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML',
): Promise<boolean> {
  const chunks = splitMessage(text)

  for (const chunk of chunks) {
    const body: Record<string, unknown> = { chat_id: chatId, text: chunk }
    if (parseMode) body.parse_mode = parseMode

    try {
      const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })

      if (!res.ok) {
        const err = await res.text()
        console.error(`[TelegramNotify] sendMessage failed (${res.status}):`, err)
        return false
      }
    } catch (err) {
      console.error('[TelegramNotify] sendMessage error:', err)
      return false
    }
  }

  return true
}

/**
 * Send a message to all provided chat IDs. Best-effort — failures for
 * individual chats are logged but don't prevent delivery to others.
 */
export async function notifyAllUsers(
  botToken: string,
  chatIds: number[],
  text: string,
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML',
): Promise<void> {
  await Promise.allSettled(
    chatIds.map(id => sendTelegramMessage(botToken, id, text, parseMode)),
  )
}

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining)
      break
    }

    // Try to break at newline, then space, then hard-cut
    let breakPoint = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH)
    if (breakPoint < MAX_MESSAGE_LENGTH * 0.5) {
      breakPoint = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH)
    }
    if (breakPoint < MAX_MESSAGE_LENGTH * 0.5) {
      breakPoint = MAX_MESSAGE_LENGTH
    }

    chunks.push(remaining.slice(0, breakPoint))
    remaining = remaining.slice(breakPoint).trimStart()
  }

  return chunks
}
