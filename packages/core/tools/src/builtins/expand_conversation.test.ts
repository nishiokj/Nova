/**
 * ExpandConversation Tool Tests
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { executeExpandConversation } from './expand_conversation.js';

function createMockResponse(body: unknown, ok = true, status = 200, statusText = 'OK') {
  return {
    ok,
    status,
    statusText,
    json: async () => body,
  } as Response;
}

describe('executeExpandConversation', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.AGENT_MEMORY_BASE_URL;
    delete process.env.AGENT_MEMORY_URL;
  });

  it('returns error when conversation_id is missing', async () => {
    const result = await executeExpandConversation({});

    expect(result.isSuccess).toBe(false);
    expect(result.error).toContain('conversation_id is required');
  });

  it('uses base_url override, applies offset, and formats messages', async () => {
    let requestedUrl = '';
    const mockFetch = spyOn(global, 'fetch').mockImplementation((url) => {
      requestedUrl = String(url);
      return Promise.resolve(createMockResponse({
        conversation: {
          id: 'conv-1',
          topic: 'Tooling',
          started_at: '2026-02-01T00:00:00.000Z',
          message_count: 2,
        },
        messages: [
          {
            id: 'msg-1',
            sender_identity_id: 'user',
            subject: 'Hello',
            body_text: 'Hi there',
            sent_at: '2026-02-01T00:00:00.000Z',
          },
          {
            id: 'msg-2',
            sender_identity_id: 'assistant',
            body_html: '<p>Hi <b>there</b></p>',
            received_at: '2026-02-01T00:01:00.000Z',
          },
        ],
        total: 2,
        offset: 2,
        limit: 3,
      }));
    });

    const result = await executeExpandConversation({
      conversation_id: 'conv-1',
      base_url: 'http://memory/',
      limit: 3,
      offset: 2,
    });

    expect(mockFetch).toHaveBeenCalled();
    expect(requestedUrl).toBe('http://memory/memory/conversations/conv-1/messages?limit=3&offset=2');

    expect(result.isSuccess).toBe(true);
    expect(result.output).toContain('## Conversation conv-1');
    expect(result.output).toContain('Topic: Tooling');
    expect(result.output).toContain('Messages: 2 of 2');
    expect(result.output).toContain('Subject: Hello');
    expect(result.output).toContain('Hi there');
    expect(result.output).toContain('Hi there');

    mockFetch.mockRestore();
  });

  it('strips HTML and clamps long message bodies', async () => {
    const longBody = 'a'.repeat(500);
    const mockFetch = spyOn(global, 'fetch').mockResolvedValue(createMockResponse({
      conversation: { id: 'conv-2' },
      messages: [
        {
          id: 'msg-1',
          body_html: '<p>hello <b>world</b></p>',
        },
        {
          id: 'msg-2',
          body_text: longBody,
        },
      ],
      total: 2,
      offset: 0,
      limit: 50,
    }));

    const result = await executeExpandConversation({
      conversation_id: 'conv-2',
      base_url: 'http://memory',
      max_chars_per_message: 200,
      include_subject: false,
    });

    expect(result.isSuccess).toBe(true);
    expect(result.output).toContain('hello world');
    expect(result.output).not.toContain('Subject:');
    const ellipsis = '\u2026';
    expect(result.output).toContain(`${'a'.repeat(200)}${ellipsis}`);

    mockFetch.mockRestore();
  });

  it('uses AGENT_MEMORY_BASE_URL when base_url is not provided', async () => {
    process.env.AGENT_MEMORY_BASE_URL = 'http://env-memory';

    let requestedUrl = '';
    const mockFetch = spyOn(global, 'fetch').mockImplementation((url) => {
      requestedUrl = String(url);
      return Promise.resolve(createMockResponse({
        conversation: { id: 'conv-3' },
        messages: [],
        total: 0,
        offset: 0,
        limit: 50,
      }));
    });

    const result = await executeExpandConversation({ conversation_id: 'conv-3' });

    expect(result.isSuccess).toBe(true);
    expect(requestedUrl).toBe('http://env-memory/memory/conversations/conv-3/messages?limit=50');

    mockFetch.mockRestore();
  });

  it('returns error when the request fails', async () => {
    const mockFetch = spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as Response);

    const result = await executeExpandConversation({
      conversation_id: 'conv-4',
      base_url: 'http://memory',
    });

    expect(result.isSuccess).toBe(false);
    expect(result.error).toContain('Failed to expand conversation');
    expect(result.error).toContain('HTTP 500');

    mockFetch.mockRestore();
  });
});
