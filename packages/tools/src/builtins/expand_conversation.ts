/**
 * ExpandConversation tool - fetch a full conversation transcript from agent-memory.
 *
 * Given a conversation_id (ULID), returns ordered messages with timestamps and content.
 */

import type { ToolResult } from 'types';
import { successResult, errorResult } from 'types';
import type { ToolExecutionContext, ToolRegistrationOptions } from '../types.js';

export interface ExpandConversationArgs {
  conversation_id: string;
  limit?: number;
  offset?: number;
  max_chars_per_message?: number;
  include_subject?: boolean;
  base_url?: string;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_CHARS = 1200;

function resolveBaseUrl(args: Record<string, unknown>, context?: ToolExecutionContext): string {
  const env = { ...process.env, ...(context?.envOverrides ?? {}) };
  const baseUrlOverride = typeof args.base_url === 'string' ? args.base_url : undefined;
  const candidate = baseUrlOverride
    || env.AGENT_MEMORY_BASE_URL
    || env.AGENT_MEMORY_URL
    || 'http://localhost:3001';
  return candidate.replace(/\/+$/, '');
}

function clampText(value: string, max: number): string {
  const trimmed = value.replace(/\r\n/g, '\n').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trim()}…`;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatTimestamp(value?: string): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toISOString();
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Expand a conversation by ID and return its message chain.
 */
export async function executeExpandConversation(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const startTime = Date.now();
  const conversationId = String(args.conversation_id ?? '').trim();
  if (!conversationId) {
    return errorResult('ExpandConversation', 'conversation_id is required', Date.now() - startTime);
  }

  const limitRaw = Number(args.limit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : DEFAULT_LIMIT;
  const offsetRaw = Number(args.offset ?? 0);
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;
  const maxCharsRaw = Number(args.max_chars_per_message ?? DEFAULT_MAX_CHARS);
  const maxChars = Number.isFinite(maxCharsRaw) ? Math.max(200, maxCharsRaw) : DEFAULT_MAX_CHARS;
  const includeSubject = typeof args.include_subject === 'boolean' ? args.include_subject : true;

  const baseUrl = resolveBaseUrl(args, context);
  const url = new URL(`${baseUrl}/memory/conversations/${encodeURIComponent(conversationId)}/messages`);
  url.searchParams.set('limit', String(limit));
  if (offset > 0) url.searchParams.set('offset', String(offset));

  try {
    const data = await fetchJson(url.toString(), DEFAULT_TIMEOUT_MS) as {
      conversation?: {
        id: string;
        topic?: string;
        started_at?: string;
        ended_at?: string;
        message_count?: number;
        participants?: unknown[];
      };
      messages?: Array<{
        id: string;
        sender_identity_id?: string;
        subject?: string;
        body_text?: string;
        body_html?: string;
        sent_at?: string;
        received_at?: string;
        created_at?: string;
        source_timestamp?: string;
      }>;
      total?: number;
      offset?: number;
      limit?: number;
    };

    const conversation = data.conversation;
    const messages = data.messages ?? [];
    const total = data.total ?? messages.length;
    const actualOffset = data.offset ?? offset;
    const actualLimit = data.limit ?? limit;

    const lines: string[] = [];
    lines.push(`## Conversation ${conversation?.id ?? conversationId}`);
    if (conversation?.topic) lines.push(`Topic: ${conversation.topic}`);
    if (conversation?.started_at) lines.push(`Started: ${formatTimestamp(conversation.started_at)}`);
    if (conversation?.ended_at) lines.push(`Ended: ${formatTimestamp(conversation.ended_at)}`);
    lines.push(`Messages: ${messages.length} of ${total} (offset ${actualOffset}, limit ${actualLimit})`);
    lines.push('');

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const index = actualOffset + i + 1;
      const timestamp = message.sent_at || message.received_at || message.source_timestamp || message.created_at;
      const sender = message.sender_identity_id ? `sender:${message.sender_identity_id}` : '';
      const headerParts = [
        `### ${index}.`,
        timestamp ? formatTimestamp(timestamp) : null,
        sender || null,
        message.id ? `id:${message.id}` : null,
      ].filter(Boolean);
      lines.push(headerParts.join(' '));

      const bodyParts: string[] = [];
      if (includeSubject && message.subject) {
        bodyParts.push(`Subject: ${message.subject}`);
      }
      if (message.body_text) {
        bodyParts.push(message.body_text);
      } else if (message.body_html) {
        bodyParts.push(stripHtml(message.body_html));
      }

      const body = clampText(bodyParts.join('\n').trim() || '(no content)', maxChars);
      lines.push(body);
      lines.push('');
    }

    return successResult('ExpandConversation', lines.join('\n'), Date.now() - startTime);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult('ExpandConversation', `Failed to expand conversation: ${message}`, Date.now() - startTime);
  }
}

/**
 * ExpandConversation tool registration options.
 */
export const expandConversationToolOptions: ToolRegistrationOptions = {
  name: 'ExpandConversation',
  description: 'Expand a conversation summary into its full message chain using the agent-memory service. Useful when a recent conversation summary seems relevant and you want the full transcript.',
  parameters: {
    type: 'object',
    properties: {
      conversation_id: {
        type: 'string',
        description: 'Conversation ULID to expand (use the Id shown in Recent Conversations)',
      },
      limit: {
        type: 'number',
        description: `Max messages to return (default: ${DEFAULT_LIMIT})`,
      },
      offset: {
        type: 'number',
        description: 'Offset into the conversation message list (default: 0)',
      },
      max_chars_per_message: {
        type: 'number',
        description: `Maximum characters per message (default: ${DEFAULT_MAX_CHARS})`,
      },
      include_subject: {
        type: 'boolean',
        description: 'Include subject lines when available (default: true)',
      },
      base_url: {
        type: 'string',
        description: 'Override agent-memory base URL (default uses AGENT_MEMORY_BASE_URL/URL)',
      },
    },
    required: ['conversation_id'],
  },
  required: ['conversation_id'],
  executor: executeExpandConversation,
  readOnly: true,
  parallelizable: true,
  costHint: 'low',
  timeoutMs: DEFAULT_TIMEOUT_MS,
};
