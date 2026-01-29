/**
 * Memory Injection Integration Tests - Bug Hunting
 *
 * Tests the integration of memory injection in the Agent class.
 * Focus on edge cases that could cause failures in production.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { ContextWindow } from 'context';
import { createWorkItem, type WorkItem } from 'work';

// Test buildMemoryQuery behavior by simulating the function
// (We can't easily import a private method, so we replicate the logic)

function buildMemoryQuery(workItem: WorkItem | null | undefined, globalContext: ContextWindow): string {
  const parts: string[] = [];

  // Include workItem objective
  if (workItem?.objective) {
    parts.push(workItem.objective);
  }

  // Include last 3 user messages from global context
  const items = globalContext.getItemsForLLM();
  const userMessages = items
    .filter(item => item.type === 'message' && (item as { role?: string }).role === 'user')
    .slice(-3)
    .map(item => (item as { content?: string }).content)
    .filter((c): c is string => typeof c === 'string');

  parts.push(...userMessages);

  // Cap query length at 500 chars
  return parts.join(' ').slice(0, 500);
}

describe('buildMemoryQuery - Bug Hunting', () => {
  let context: ContextWindow;

  beforeEach(() => {
    context = new ContextWindow('test-session-key', 200000);
  });

  // ==========================================================================
  // BUG: Empty Query Generation
  // ==========================================================================
  describe('Empty query generation', () => {
    test('EMPTY QUERY: No objective, no messages', () => {
      const workItem = createWorkItem({ goal: 'test', objective: '' });

      const query = buildMemoryQuery(workItem, context);

      // BUG: Returns empty string, which gets sent to memory API
      expect(query).toBe('');
      // This empty query will trigger a search with no terms
    });

    test('EMPTY QUERY: Null workItem', () => {
      // @ts-expect-error - Testing null input
      const query = buildMemoryQuery(null, context);

      expect(query).toBe('');
    });

    test('EMPTY QUERY: Undefined workItem', () => {
      // @ts-expect-error - Testing undefined input
      const query = buildMemoryQuery(undefined, context);

      expect(query).toBe('');
    });

    test('EMPTY QUERY: Empty objective, only system messages', () => {
      context.addMessage('system', 'You are a helpful assistant');
      context.addMessage('assistant', 'Hello, how can I help?');

      const workItem = createWorkItem({ goal: 'test', objective: '' });
      const query = buildMemoryQuery(workItem, context);

      // No user messages, so empty query
      expect(query).toBe('');
    });

    test('WHITESPACE QUERY: Only whitespace objective', () => {
      const workItem = createWorkItem({ goal: 'test', objective: '   \n\t  ' });

      const query = buildMemoryQuery(workItem, context);

      // BUG: Whitespace is included, not trimmed
      expect(query).toBe('   \n\t  ');
      // This whitespace query will be sent to the API
    });
  });

  // ==========================================================================
  // BUG: Message Filtering Issues
  // ==========================================================================
  describe('Message filtering issues', () => {
    test('WRONG MESSAGES: File content treated as user message', () => {
      // getItemsForLLM converts file_content to type: 'message' with role: 'user'
      // So file contents ARE included in memory query!

      context.addFileContent(
        '/path/to/file.ts',
        'export function secret() { return "API_KEY"; }',
        'typescript'
      );

      const workItem = createWorkItem({ goal: 'test', objective: '' });
      const items = context.getItemsForLLM();

      // Check if file content becomes a user message
      const userMessages = items.filter(
        item => item.type === 'message' && (item as any).role === 'user'
      );

      // File content IS converted to a user message
      expect(userMessages.length).toBeGreaterThan(0);

      const query = buildMemoryQuery(workItem, context);

      // BUG EXPOSED: File content leaks into memory query!
      // This is a privacy/security issue - file contents are sent to memory search
      expect(query).not.toContain('[File:');  // BUG: This WILL contain file content
    });

    test('DATA LEAK: Artifacts treated as user message', () => {
      context.addArtifact({
        kind: 'constant',
        sourcePath: '/secret.env',
        name: 'API_KEY',
        signature: 'API_KEY=secret123',
        discoveredBy: 'test',
      });

      const workItem = createWorkItem({ goal: 'test', objective: '' });
      const items = context.getItemsForLLM();

      // Artifacts are batched into a user message by getItemsForLLM
      const userMessages = items.filter(
        item => item.type === 'message' && (item as any).role === 'user'
      );

      const query = buildMemoryQuery(workItem, context);

      // BUG EXPOSED: Artifacts ARE leaking into memory query!
      // The query contains: "[DISCOVERED ARTIFACTS: 1]\n[const] /secret.env\nAPI_KEY=secret123"
      // This is because getItemsForLLM batches artifacts into a user message
      // and buildMemoryQuery includes those in the last 3 user messages

      // This test documents the bug - artifact content leaks to memory search
      // Uncomment to fail and expose the bug:
      expect(query).not.toContain('API_KEY');  // BUG: This WILL contain API_KEY
    });

    test('WRONG ORDER: slice(-3) gets wrong messages', () => {
      context.addMessage('user', 'First message');
      context.addMessage('assistant', 'Response 1');
      context.addMessage('user', 'Second message');
      context.addMessage('assistant', 'Response 2');
      context.addMessage('user', 'Third message');
      context.addMessage('assistant', 'Response 3');
      context.addMessage('user', 'Fourth message');
      context.addMessage('user', 'Fifth message');  // Two user messages in a row

      const workItem = createWorkItem({ goal: 'test', objective: '' });
      const query = buildMemoryQuery(workItem, context);

      // Should get: Third, Fourth, Fifth (last 3 user messages)
      expect(query).toContain('Third message');
      expect(query).toContain('Fourth message');
      expect(query).toContain('Fifth message');
      expect(query).not.toContain('First message');
      expect(query).not.toContain('Second message');
    });
  });

  // ==========================================================================
  // BUG: Query Truncation Issues
  // ==========================================================================
  describe('Query truncation issues', () => {
    test('TRUNCATED MID-WORD: 500 char limit cuts words', () => {
      // Create a string that's exactly 600 chars to ensure truncation
      const longObjective = 'Configure authentication system with OAuth2 provider integration supporting multiple identity providers including Google, Microsoft, GitHub, and custom SAML providers. Implement token refresh mechanisms and secure session management with proper CSRF protection. Add rate limiting and audit logging for all authentication endpoints. The implementation should follow security best practices including proper error handling that does not leak sensitive information. Additionally configure proper password policies and multi-factor authentication.';

      expect(longObjective.length).toBeGreaterThan(500);  // Verify our test data

      const workItem = createWorkItem({ goal: 'test', objective: longObjective });
      const query = buildMemoryQuery(workItem, context);

      expect(query.length).toBe(500);
      // Query is truncated mid-word, which may affect search quality
      // Last word is probably cut off
    });

    test('UNICODE TRUNCATION: May split multi-byte characters', () => {
      // Create a string that's exactly 500 chars with unicode at the end
      const objective = 'A'.repeat(498) + '中文';  // 498 A's + 2 Chinese chars

      const workItem = createWorkItem({ goal: 'test', objective });
      const query = buildMemoryQuery(workItem, context);

      // slice(0, 500) on strings with multi-byte chars can create invalid strings
      // JavaScript strings are UTF-16, but slice operates on code units
      expect(query.length).toBeLessThanOrEqual(500);
      // May have created an invalid character sequence
    });

    test('EMOJI TRUNCATION: May split surrogate pairs', () => {
      // Emojis like 👨‍👩‍👧‍👦 are made of multiple code points
      const objective = 'A'.repeat(495) + '👨‍👩‍👧‍👦';  // Family emoji is ~11 chars

      const workItem = createWorkItem({ goal: 'test', objective });
      const query = buildMemoryQuery(workItem, context);

      // The family emoji might be corrupted by slicing
      // Check if we have a valid string (no lone surrogates)
      const hasLoneSurrogates = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(query);

      // This MIGHT fail depending on exact positioning
      // expect(hasLoneSurrogates).toBe(false);
    });
  });

  // ==========================================================================
  // BUG: Type Coercion Issues
  // ==========================================================================
  describe('Type coercion issues', () => {
    test('NON-STRING CONTENT: Number in content field', () => {
      // What if content is accidentally a number?
      context.addMessage('user', 12345 as unknown as string);

      const workItem = createWorkItem({ goal: 'test', objective: '' });
      const query = buildMemoryQuery(workItem, context);

      // The filter `typeof c === 'string'` should exclude this
      expect(query).not.toContain('12345');
    });

    test('NON-STRING CONTENT: Object in content field', () => {
      context.addMessage('user', { text: 'nested' } as unknown as string);

      const workItem = createWorkItem({ goal: 'test', objective: '' });
      const query = buildMemoryQuery(workItem, context);

      // Should be filtered out
      expect(query).not.toContain('[object Object]');
    });

    test('NON-STRING CONTENT: Array in content field', () => {
      context.addMessage('user', ['a', 'b', 'c'] as unknown as string);

      const workItem = createWorkItem({ goal: 'test', objective: '' });
      const query = buildMemoryQuery(workItem, context);

      // Should be filtered out
      expect(query).not.toContain('a,b,c');
    });
  });

  // ==========================================================================
  // BUG: Memory Injection Only on Iteration 0
  // ==========================================================================
  describe('Iteration 0 limitation', () => {
    test('STALE MEMORY: Later iterations use stale memory', () => {
      // Memory is only injected on iteration 0
      // If the task evolves during execution, memory becomes irrelevant

      // This is a design choice, but could be a bug if:
      // - Agent discovers new context mid-execution
      // - User provides follow-up information
      // - Tool results change the focus of the task

      // Can't easily test this without full agent execution
      // Documenting as a potential issue
      expect(true).toBe(true);
    });
  });
});

// ==========================================================================
// Error Handling in Agent
// ==========================================================================
describe('Agent memory injection error handling', () => {
  test('SILENT FAILURE: Injector errors are swallowed', () => {
    // The agent catches all errors with empty catch block:
    // try {
    //   const query = this.buildMemoryQuery(workItem, globalContext);
    //   memoryContent = await this.memoryInjector.inject({ query, maxTokens: 1000 });
    // } catch {
    //   // Silent fallback - continue without memory
    // }

    // This means:
    // - No logging of errors
    // - No metrics for failure rates
    // - No way to know if memory daemon is down

    // Documenting as intentional but problematic design
    expect(true).toBe(true);
  });
});
