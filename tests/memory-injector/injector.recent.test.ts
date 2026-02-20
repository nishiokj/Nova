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
const mockEvidenceRetrieve = vi.fn(() => Promise.resolve({
  content: '',
  atoms: [],
  metrics: {
    totalTokens: 0,
    attentionTax: 0,
    coverage: {},
    discriminatorsIncluded: 0,
    latencyMs: 0,
  },
}));

let memoryEnabled = true;

vi.mock('agent-memory', () => ({
  SyncClient: class MockSyncClient {
    preferences = { search: mockPreferencesSearch };
    decisions = { search: mockDecisionsSearch };
    evidence = { retrieve: mockEvidenceRetrieve };
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
    mockEvidenceRetrieve.mockReset();
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

  test('injectEvidence forwards request to evidence endpoint', async () => {
    mockEvidenceRetrieve.mockResolvedValue({
      content: 'Evidence block',
      atoms: [{ id: 'a1' }],
      metrics: {
        totalTokens: 21,
        attentionTax: 0.1,
        coverage: { decision: 1 },
        discriminatorsIncluded: 1,
        latencyMs: 12,
      },
    });

    const injector = createMemoryInjector({ baseUrl: 'http://test' });
    if (!injector.injectEvidence) {
      throw new Error('injectEvidence missing');
    }

    const request = {
      task: {
        objective: 'summarize prior choices',
        recentMessages: ['please recall context'],
        touchedFiles: ['src/a.ts'],
        iteration: 0,
        sessionId: 's1',
      },
      budget: {
        maxTokens: 400,
      },
    };
    const result = await injector.injectEvidence(request);

    expect(mockEvidenceRetrieve).toHaveBeenCalledWith(request);
    expect(result?.content).toBe('Evidence block');
  });

  test('injectEvidence returns null when response content is empty', async () => {
    mockEvidenceRetrieve.mockResolvedValue({
      content: '',
      atoms: [],
      metrics: {
        totalTokens: 0,
        attentionTax: 0,
        coverage: {},
        discriminatorsIncluded: 0,
        latencyMs: 5,
      },
    });

    const injector = createMemoryInjector({ baseUrl: 'http://test' });
    if (!injector.injectEvidence) {
      throw new Error('injectEvidence missing');
    }
    const result = await injector.injectEvidence({
      task: {
        objective: 'empty',
        recentMessages: [],
        iteration: 0,
        sessionId: 's1',
      },
      budget: { maxTokens: 100 },
    });

    expect(result).toBeNull();
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
