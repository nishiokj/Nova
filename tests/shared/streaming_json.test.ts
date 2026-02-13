import { StreamingJsonExtractor } from 'shared/streaming_json.js';

describe('StreamingJsonExtractor', () => {
  it('extracts response field from complete JSON', () => {
    const extractor = new StreamingJsonExtractor();
    const result = extractor.addChunk('{"action": "done", "response": "Hello world"}');
    expect(result).toBe('Hello world');
    expect(extractor.isDone()).toBe(true);
  });

  it('streams response field incrementally', () => {
    const extractor = new StreamingJsonExtractor();
    const chunks = [
      '{"action": "done", ',
      '"response": "Hello',
      ' world',
      '!"}',
    ];

    const results: (string | null)[] = [];
    for (const chunk of chunks) {
      results.push(extractor.addChunk(chunk));
    }

    expect(results[0]).toBeNull(); // Still searching
    expect(results[1]).toBe('Hello'); // Found start, got first part
    expect(results[2]).toBe(' world'); // More content
    expect(results[3]).toBe('!'); // Final part
    expect(extractor.getContent()).toBe('Hello world!');
    expect(extractor.isDone()).toBe(true);
  });

  it('handles JSON escape sequences', () => {
    const extractor = new StreamingJsonExtractor();
    const result = extractor.addChunk('{"response": "Hello\\nWorld\\t\\"quoted\\""}');
    expect(result).toBe('Hello\nWorld\t"quoted"');
  });

  it('handles unicode escapes', () => {
    const extractor = new StreamingJsonExtractor();
    const result = extractor.addChunk('{"response": "Hello \\u0048\\u0069"}');
    expect(result).toBe('Hello Hi');
  });

  it('handles response field appearing first', () => {
    const extractor = new StreamingJsonExtractor();
    const result = extractor.addChunk('{"response": "First!", "action": "done"}');
    expect(result).toBe('First!');
  });

  it('returns null when no response field found', () => {
    const extractor = new StreamingJsonExtractor();
    const result = extractor.addChunk('{"action": "continue", "foo": "bar"}');
    expect(result).toBeNull();
    expect(extractor.getContent()).toBe('');
  });

  it('handles split escape sequences across chunks', () => {
    const extractor = new StreamingJsonExtractor();

    // Split in the middle of an escape sequence
    const r1 = extractor.addChunk('{"response": "Hello\\');
    expect(r1).toBe('Hello');

    const r2 = extractor.addChunk('nWorld"}');
    expect(r2).toBe('\nWorld');

    expect(extractor.getContent()).toBe('Hello\nWorld');
  });

  it('handles split unicode escape across chunks', () => {
    const extractor = new StreamingJsonExtractor();

    const r1 = extractor.addChunk('{"response": "Hi\\u00');
    expect(r1).toBe('Hi');

    const r2 = extractor.addChunk('41!"}');
    expect(r2).toBe('A!');

    expect(extractor.getContent()).toBe('HiA!');
  });

  it('can be reset for reuse', () => {
    const extractor = new StreamingJsonExtractor();
    extractor.addChunk('{"response": "First"}');
    expect(extractor.getContent()).toBe('First');

    extractor.reset();

    extractor.addChunk('{"response": "Second"}');
    expect(extractor.getContent()).toBe('Second');
  });

  it('handles whitespace variations in JSON', () => {
    const extractor = new StreamingJsonExtractor();
    const result = extractor.addChunk('{  "response"  :  "spaced out"  }');
    expect(result).toBe('spaced out');
  });

  it('handles empty response', () => {
    const extractor = new StreamingJsonExtractor();
    const result = extractor.addChunk('{"response": ""}');
    expect(result).toBeNull(); // Empty string returns null (no new content)
    expect(extractor.getContent()).toBe('');
    expect(extractor.isDone()).toBe(true);
  });
});
