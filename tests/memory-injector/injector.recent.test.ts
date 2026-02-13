/**
 * Memory Injector - Recent Conversations and Recall Intent Tests
 *
 * Focus: ensure recall queries route to conversational memory, and recent summaries
 * are formatted and trimmed correctly.
 */


const mockPreferencesSearch = vi.fn(() => Promise.resolve({ preferences: [] }));
const mockDecisionsSearch = vi.fn(() => Promise.resolve({ decisions: [] }));
const mockMemorySearch = vi.fn(() => Promise.resolve({ items: [] }));
const mockMemoryRecent = vi.fn(() => Promise.resolve({ items: [] }));

let memoryEnabled = true;

vi.mock('agent-memory', () => ({
  SyncClient: class MockSyncClient {
    preferences = { search: mockPreferencesSearch };
    decisions = { search: mockDecisionsSearch };
    get memory() {
      return memoryEnabled
        ? { search: mockMemorySearch, recent: mockMemoryRecent }
        : undefined;
    }
  },
}));

let createMemoryInjector: typeof import('memory-injector/injector.js').createMemoryInjector;
let detectQueryIntent: typeof import('memory-injector/injector.js').detectQueryIntent;

describe('Memory Injector - recall + recent', () => {
  beforeEach(() => {
    memoryEnabled = true;
    mockPreferencesSearch.mockReset();
    mockDecisionsSearch.mockReset();
    mockMemorySearch.mockReset();
    mockMemoryRecent.mockReset();
  });
  beforeAll(async () => {
    const mod = await import('memory-injector/injector.js');
    createMemoryInjector = mod.createMemoryInjector;
    detectQueryIntent = mod.detectQueryIntent;
  });

  test('detectQueryIntent prioritizes recall over other cues', () => {
    const intent = detectQueryIntent('What did we talk about last time and what are our preferences?');
    expect(intent).toBe('recall');
  });

  test('recall intent searches conversational memory only', async () => {
    mockMemorySearch.mockResolvedValue({
      items: [
        {
          conversation_id: 'conv-1',
          summary: 'Discussed logging preferences for the harness',
          topic: 'Logging',
          updated_at: '2026-02-01T00:00:00.000Z',
          source_timestamp: '2026-02-01T00:00:00.000Z',
        },
      ],
    });

    mockPreferencesSearch.mockResolvedValue({
      preferences: [
        { id: 'pref-1', preference: 'Prefer structured logs', rank: 0.9 },
      ],
    });
    mockDecisionsSearch.mockResolvedValue({
      decisions: [
        { id: 'dec-1', decision: 'Use JSON logs', rank: 0.9 },
      ],
    });

    const injector = createMemoryInjector({ baseUrl: 'http://test' });
    const result = await injector.inject({
      query: 'What did we talk about last time?',
      maxTokens: 200,
    });

    expect(mockMemorySearch).toHaveBeenCalledTimes(1);
    expect(mockPreferencesSearch).not.toHaveBeenCalled();
    expect(mockDecisionsSearch).not.toHaveBeenCalled();
    expect(result).toContain('## Relevant Memory');
    expect(result).toContain('Id: conv-1');
    expect(result).toContain('Topic: Logging');
    expect(result).toContain('(2026-02-01)');
  });

  test('non-recall intent skips conversational memory search', async () => {
    mockPreferencesSearch.mockResolvedValue({
      preferences: [
        { id: 'pref-1', preference: 'Prefer typed interfaces for tools', rank: 0.9 },
      ],
    });

    const injector = createMemoryInjector({ baseUrl: 'http://test' });
    const result = await injector.inject({
      query: 'Prefer typed interfaces for tools',
      maxTokens: 200,
    });

    expect(mockMemorySearch).not.toHaveBeenCalled();
    expect(mockPreferencesSearch).toHaveBeenCalled();
    expect(result).toContain('## Relevant Decisions & Preferences');
  });

  test('injectRecentConversations formats summaries with Id and topic', async () => {
    mockMemoryRecent.mockResolvedValue({
      items: [
        {
          conversation_id: 'conv-2',
          summary: 'Reviewed memory injection changes for recall flows',
          topic: 'Memory Injection',
          updated_at: '2026-02-02T00:00:00.000Z',
          source_timestamp: '2026-02-02T00:00:00.000Z',
        },
      ],
    });

    const injector = createMemoryInjector({ baseUrl: 'http://test' });
    if (!injector.injectRecentConversations) {
      throw new Error('injectRecentConversations missing');
    }

    const result = await injector.injectRecentConversations({
      maxTokens: 200,
      limit: 5,
      connectors: 'custom',
    });

    expect(mockMemoryRecent).toHaveBeenCalledWith({
      limit: 5,
      connectors: 'custom',
    });
    expect(result).toContain('## Recent Conversations');
    expect(result).toContain('Id: conv-2');
    expect(result).toContain('Topic: Memory Injection');
  });

  test('injectRecentConversations returns null when memory client is unavailable', async () => {
    memoryEnabled = false;

    const injector = createMemoryInjector({ baseUrl: 'http://test' });
    if (!injector.injectRecentConversations) {
      throw new Error('injectRecentConversations missing');
    }

    const result = await injector.injectRecentConversations({ maxTokens: 200 });

    expect(result).toBeNull();
    expect(mockMemoryRecent).not.toHaveBeenCalled();
  });

  test('injectRecentConversations respects token budget', async () => {
    mockMemoryRecent.mockResolvedValue({
      items: [
        {
          conversation_id: 'conv-3',
          summary: 'A'.repeat(500),
          updated_at: '2026-02-02T00:00:00.000Z',
        },
      ],
    });

    const injector = createMemoryInjector({ baseUrl: 'http://test' });
    if (!injector.injectRecentConversations) {
      throw new Error('injectRecentConversations missing');
    }

    const result = await injector.injectRecentConversations({ maxTokens: 1 });

    expect(result).toBeNull();
  });
});
