import type { NormalizedSessionEvent } from './api';
import { formatRelativeFromIso } from './format';

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeMessageRole(role: unknown): 'assistant' | 'user' | 'system' | 'message' {
  const normalized = String(role ?? '').trim().toLowerCase();
  if (normalized === 'assistant' || normalized === 'agent') return 'assistant';
  if (normalized === 'user') return 'user';
  if (normalized === 'system') return 'system';
  return 'message';
}

export function isMessageLikeEvent(event: NormalizedSessionEvent): boolean {
  if (event.type === 'message') return true;
  const eventType = String(event.payload.eventType ?? '').trim().toLowerCase();
  if (!eventType) return false;
  return eventType.includes('message') || eventType === 'send_text' || eventType === 'response';
}

export function messageRoleForEvent(event: NormalizedSessionEvent): 'assistant' | 'user' | 'system' | 'message' {
  const normalizedRole = normalizeMessageRole(event.payload.role);
  if (normalizedRole !== 'message') return normalizedRole;
  const eventType = String(event.payload.eventType ?? '').trim().toLowerCase();
  if (eventType === 'send_text' || eventType === 'user_message') return 'user';
  if (eventType === 'agent_message' || eventType === 'response') return 'assistant';
  return normalizedRole;
}

export function extractTextValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractTextValue(item))
      .filter(Boolean);
    return parts.join('\n').trim();
  }
  const record = asRecord(value);
  if (!record) return '';
  const directText = record.text;
  if (typeof directText === 'string' && directText.trim()) return directText.trim();
  const nestedContent = record.content;
  if (nestedContent !== undefined) {
    const nested = extractTextValue(nestedContent);
    if (nested) return nested;
  }
  const message = record.message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  const chunk = record.chunk;
  if (typeof chunk === 'string' && chunk.trim()) return chunk.trim();
  const response = record.response;
  if (typeof response === 'string' && response.trim()) return response.trim();
  const output = record.output;
  if (typeof output === 'string' && output.trim()) return output.trim();
  return '';
}

export function extractMessageContent(payload: Record<string, unknown>): string {
  const topLevelContent = extractTextValue(payload.content);
  if (topLevelContent) return topLevelContent;
  const topLevelMessage = extractTextValue(payload.message);
  if (topLevelMessage) return topLevelMessage;
  const topLevelText = extractTextValue(payload.text);
  if (topLevelText) return topLevelText;
  const topLevelResponse = extractTextValue(payload.response);
  if (topLevelResponse) return topLevelResponse;
  const data = asRecord(payload.data);
  const contentFromData = extractTextValue(data?.content);
  if (contentFromData) return contentFromData;
  const messageFromData = extractTextValue(data?.message);
  if (messageFromData) return messageFromData;
  const chunkFromData = extractTextValue(data?.chunk);
  if (chunkFromData) return chunkFromData;
  const textFromData = extractTextValue(data?.text);
  if (textFromData) return textFromData;
  const responseFromData = extractTextValue(data?.response);
  if (responseFromData) return responseFromData;
  return '';
}

export function toolLabelFromName(name: string, isBrowser = false): { icon: string; label: string } {
  if (isBrowser) {
    return { icon: '\u25C9', label: `Browser ${name}` };
  }
  const lower = name.toLowerCase();
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('exec')) {
    return { icon: '>', label: 'Bash' };
  }
  if (lower.includes('edit') || lower.includes('write') || lower.includes('patch')) {
    return { icon: '\u270E', label: 'Edit' };
  }
  if (lower.includes('search') || lower.includes('grep') || lower.includes('find')) {
    return { icon: '\u2315', label: 'Search' };
  }
  return { icon: '\u2699', label: name };
}

export function describeLatestToolSignal(events: NormalizedSessionEvent[]): { icon: string; label: string; detail: string } | null {
  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const event = events[idx];
    if (event.type !== 'tool') continue;
    const data = asRecord(event.payload.data);
    const eventType = String(event.payload.eventType ?? '').toLowerCase();
    if (eventType.includes('memory') || eventType.includes('inject')) continue;

    const browserName = eventType.startsWith('browser_')
      ? eventType.replace('browser_', '').replace(/_/g, ' ')
      : null;
    const toolName = typeof data?.tool_name === 'string' && data.tool_name.trim()
      ? data.tool_name.trim()
      : null;
    const name = browserName ?? toolName ?? (eventType || 'tool');
    const display = toolLabelFromName(name, !!browserName);

    const status = String(data?.status ?? data?.phase ?? data?.state ?? '').trim().toLowerCase();
    const detailParts: string[] = [];
    if (status) {
      detailParts.push(status === 'started' ? 'running' : status);
    }
    if (typeof data?.duration_ms === 'number') {
      detailParts.push(`${data.duration_ms}ms`);
    }
    detailParts.push(`${formatRelativeFromIso(event.at)} ago`);

    return {
      icon: display.icon,
      label: display.label,
      detail: detailParts.join(' · '),
    };
  }
  return null;
}

export function isFailureEvent(event: NormalizedSessionEvent): boolean {
  const payload = event.payload ?? {};
  const eventType = String(payload.eventType ?? '').toLowerCase();
  const data = asRecord(payload.data);

  if (event.type === 'test') {
    const verdict = String(data?.verdict ?? payload.verdict ?? '').toLowerCase();
    if (verdict === 'fail' || verdict === 'failed' || verdict === 'error') return true;
    return eventType.includes('fail') || eventType.includes('error');
  }

  if (event.type === 'tool') {
    const success = data?.success;
    if (success === false) return true;
    const status = String(data?.status ?? '').toLowerCase();
    if (status === 'error' || status === 'failed' || status === 'fail') return true;
    return eventType.includes('error') || eventType.includes('fail');
  }

  if (event.type === 'workflow') {
    return eventType.includes('error') || eventType.includes('fail') || eventType.includes('blocked');
  }

  return false;
}

export function eventLabel(event: NormalizedSessionEvent): string {
  if (isMessageLikeEvent(event)) {
    return messageRoleForEvent(event);
  }
  if (event.type === 'tool') {
    const data = event.payload.data as Record<string, unknown> | undefined;
    const tool = typeof data?.tool_name === 'string' ? data.tool_name : event.payload.eventType;
    return String(tool ?? 'tool');
  }
  return String(event.payload.eventType ?? event.type);
}
