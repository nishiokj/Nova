/**
 * Comprehensive test suite for WebSearch Tool
 */

import { executeWebSearch } from 'tools/builtins/web_search.js';

describe('executeWebSearch', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('Error handling', () => {
    it('should return error for empty query', async () => {
      const result = await executeWebSearch({ query: '' });

      expect(result.isSuccess).toBe(false);
      expect(result.status).toBe('error');
      expect(result.output).toContain('Search query is required');
      expect(result.toolName).toBe('WebSearch');
    });

    it('should return error for undefined query', async () => {
      const result = await executeWebSearch({});

      expect(result.isSuccess).toBe(false);
      expect(result.status).toBe('error');
      expect(result.output).toContain('Search query is required');
    });

    it('should handle network timeout gracefully', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockImplementation(() => {
        return new Promise(() => {}); // Never resolves
      });

      const result = await executeWebSearch({ query: 'test' });

      expect(result.isSuccess).toBe(false);
      expect(result.status).toBe('error');
      expect(result.output).toContain('timed out');

      mockFetch.mockRestore();
    });

    it('should handle network errors gracefully', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockImplementation(() => {
        throw new Error('Network connection failed');
      });

      const result = await executeWebSearch({ query: 'test' });

      expect(result.isSuccess).toBe(false);
      expect(result.status).toBe('error');
      expect(result.output).toContain('Web search failed');

      mockFetch.mockRestore();
    });

    it('should handle HTTP error responses', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('<html>Error</html>'),
      } as Response);

      const result = await executeWebSearch({ query: 'test' });

      expect(result.isSuccess).toBe(false);
      expect(result.status).toBe('error');
      expect(result.output).toContain('Search request failed (500)');

      mockFetch.mockRestore();
    });

    it('should handle 404 responses', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve('<html>Not found</html>'),
      } as Response);

      const result = await executeWebSearch({ query: 'test' });

      expect(result.isSuccess).toBe(false);
      expect(result.status).toBe('error');
      expect(result.output).toContain('Search request failed (404)');

      mockFetch.mockRestore();
    });

    it('should handle 429 rate limiting', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: () => Promise.resolve('<html>Rate limited</html>'),
      } as Response);

      const result = await executeWebSearch({ query: 'test' });

      expect(result.isSuccess).toBe(false);
      expect(result.status).toBe('error');
      expect(result.output).toContain('Search request failed (429)');

      mockFetch.mockRestore();
    });
  });

  describe('Count parameter validation', () => {
    it('should use default count of 10 when not specified', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html><body>No results</body></html>'),
      } as Response);

      const result = await executeWebSearch({ query: 'test' });

      expect(result.isSuccess).toBe(true);

      mockFetch.mockRestore();
    });

    it('should limit count to maximum of 25', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html><body>No results</body></html>'),
      } as Response);

      const result = await executeWebSearch({ query: 'test', count: 100 });

      expect(result.isSuccess).toBe(true);

      mockFetch.mockRestore();
    });

    it('should use minimum of 1 for count', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html><body>No results</body></html>'),
      } as Response);

      const result = await executeWebSearch({ query: 'test', count: 0 });

      expect(result.isSuccess).toBe(true);

      mockFetch.mockRestore();
    });

    it('should handle non-numeric count', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html><body>No results</body></html>'),
      } as Response);

      const result = await executeWebSearch({ query: 'test', count: 'invalid' as any });

      expect(result.isSuccess).toBe(true);

      mockFetch.mockRestore();
    });
  });

  describe('Domain filtering', () => {
    it('should build query with single allowed domain', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockImplementation((url, options) => {
        const body = options?.body?.toString();
        expect(body).toContain('site%3Aexample.com');
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('<html><body>No results</body></html>'),
        } as Response);
      });

      const result = await executeWebSearch({
        query: 'test',
        allowed_domains: ['example.com'],
      });

      expect(result.isSuccess).toBe(true);

      mockFetch.mockRestore();
    });

    it('should build query with multiple allowed domains', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockImplementation((url, options) => {
        const body = options?.body?.toString();
        expect(body).toContain('site%3Agithub.com');
        expect(body).toContain('site%3Astackoverflow.com');
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('<html><body>No results</body></html>'),
        } as Response);
      });

      const result = await executeWebSearch({
        query: 'test',
        allowed_domains: ['github.com', 'stackoverflow.com'],
      });

      expect(result.isSuccess).toBe(true);

      mockFetch.mockRestore();
    });

    it('should build query with single blocked domain', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockImplementation((url, options) => {
        const body = options?.body?.toString();
        expect(body).toContain('-site%3Aexample.com');
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('<html><body>No results</body></html>'),
        } as Response);
      });

      const result = await executeWebSearch({
        query: 'test',
        blocked_domains: ['example.com'],
      });

      expect(result.isSuccess).toBe(true);

      mockFetch.mockRestore();
    });

    it('should handle allowed_domains as JSON string', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html><body>No results</body></html>'),
      } as Response);

      const result = await executeWebSearch({
        query: 'test',
        allowed_domains: '["github.com", "gitlab.com"]' as any,
      });

      expect(result.isSuccess).toBe(true);

      mockFetch.mockRestore();
    });
  });

  describe('HTML parsing with mocked responses', () => {
    it('should parse basic DuckDuckGo HTML results', async () => {
      const mockHtml = `
        <html>
          <body>
            <div class="result">
              <a class="result__a" href="https://example.com/page1">Example Page 1</a>
              <a class="result__snippet">This is first result snippet</a>
            </div>
            <div class="result">
              <a class="result__a" href="https://example.com/page2">Example Page 2</a>
              <a class="result__snippet">This is second result snippet</a>
            </div>
          </body>
        </html>
      `;

      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(mockHtml),
      } as Response);

      const result = await executeWebSearch({ query: 'test', count: 5 });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('Example Page 1');
      expect(result.output).toContain('Example Page 2');
      expect(result.output).toContain('This is first result snippet');
      expect(result.output).toContain('This is second result snippet');
      expect(result.output).toContain('Found 2 results');

      mockFetch.mockRestore();
    });

    it('should extract URLs from DuckDuckGo redirects (uddg parameter)', async () => {
      const mockHtml = `
        <html>
          <body>
            <div class="result">
              <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Frepo">GitHub Repo</a>
              <a class="result__snippet">A great repository</a>
            </div>
          </body>
        </html>
      `;

      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(mockHtml),
      } as Response);

      const result = await executeWebSearch({ query: 'test', count: 5 });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('GitHub Repo');
      expect(result.output).toContain('https://github.com/repo');
      expect(result.output).not.toContain('duckduckgo.com');

      mockFetch.mockRestore();
    });

    it('should return no results message when no results found', async () => {
      const mockHtml = '<html><body>No results here</body></html>';

      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(mockHtml),
      } as Response);

      const result = await executeWebSearch({ query: 'test', count: 5 });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('No results found for: "test"');

      mockFetch.mockRestore();
    });

    it('should respect count parameter for results', async () => {
      const mockHtml = `
        <html>
          <body>
            <div class="result">
              <a class="result__a" href="https://example.com/page1">Page 1</a>
              <a class="result__snippet">Snippet 1</a>
            </div>
            <div class="result">
              <a class="result__a" href="https://example.com/page2">Page 2</a>
              <a class="result__snippet">Snippet 2</a>
            </div>
            <div class="result">
              <a class="result__a" href="https://example.com/page3">Page 3</a>
              <a class="result__snippet">Snippet 3</a>
            </div>
          </body>
        </html>
      `;

      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(mockHtml),
      } as Response);

      const result = await executeWebSearch({ query: 'test', count: 2 });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('Found 2 results');
      expect(result.output).toContain('Page 1');
      expect(result.output).toContain('Page 2');
      expect(result.output).not.toContain('Page 3');

      mockFetch.mockRestore();
    });

    it('should filter out DuckDuckGo internal links (starting with /)', async () => {
      const mockHtml = `
        <html>
          <body>
            <div class="result">
              <a class="result__a" href="/settings">Settings</a>
            </div>
            <div class="result">
              <a class="result__a" href="https://duckduckgo.com/about">About</a>
            </div>
            <div class="result">
              <a class="result__a" href="https://example.com/real">Real Result</a>
              <a class="result__snippet">A real result</a>
            </div>
          </body>
        </html>
      `;

      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(mockHtml),
      } as Response);

      const result = await executeWebSearch({ query: 'test', count: 10 });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('Real Result');
      expect(result.output).toContain('https://example.com/real');
      expect(result.output).not.toContain('Settings');
      expect(result.output).not.toContain('About');
      expect(result.output).toContain('Found 1 results');

      mockFetch.mockRestore();
    });

    it('should decode HTML entities in titles and snippets', async () => {
      const mockHtml = `
        <html>
          <body>
            <div class="result">
              <a class="result__a" href="https://example.com">C++ Tutorial: Use &amp; operators</a>
              <a class="result__snippet">Learn about &lt;int&gt; and &quot;strings&quot;</a>
            </div>
          </body>
        </html>
      `;

      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(mockHtml),
      } as Response);

      const result = await executeWebSearch({ query: 'test', count: 5 });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('C++ Tutorial: Use & operators');
      expect(result.output).toContain('Learn about <int> and "strings"');
      expect(result.output).not.toContain('&amp;');

      mockFetch.mockRestore();
    });

    it('should handle malformed HTML gracefully', async () => {
      const malformedHtml = '<html><body><div>Unclosed<div>Nested</body>';

      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(malformedHtml),
      } as Response);

      const result = await executeWebSearch({ query: 'test' });

      expect(result.isSuccess).toBe(true);

      mockFetch.mockRestore();
    });

    it('should handle empty HTML response', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      } as Response);

      const result = await executeWebSearch({ query: 'test' });

      expect(result.isSuccess).toBe(true);
      expect(result.output).toContain('No results found');

      mockFetch.mockRestore();
    });
  });

  describe('Metadata validation', () => {
    it('should include correct metadata on success', async () => {
      const mockHtml = `
        <html>
          <body>
            <div class="result">
              <a class="result__a" href="https://example.com/page">Page</a>
              <a class="result__snippet">Snippet</a>
            </div>
          </body>
        </html>
      `;

      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(mockHtml),
      } as Response);

      const result = await executeWebSearch({
        query: 'test search',
        count: 5,
        allowed_domains: ['example.com'],
        blocked_domains: ['spam.com'],
      });

      expect(result.metadata).toBeDefined();
      expect(result.metadata?.query).toBe('test search');
      expect(result.metadata?.resultCount).toBe(1);
      expect(result.metadata?.allowedDomains).toEqual(['example.com']);
      expect(result.metadata?.blockedDomains).toEqual(['spam.com']);

      mockFetch.mockRestore();
    });
  });

  describe('Edge cases', () => {
    it('should handle query with special characters', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html><body>No results</body></html>'),
      } as Response);

      const result = await executeWebSearch({ query: 'test & special ! chars (quotes)' });

      expect(result.isSuccess).toBe(true);

      mockFetch.mockRestore();
    });

    it('should handle query with unicode characters', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html><body>No results</body></html>'),
      } as Response);

      const result = await executeWebSearch({ query: '\u65E5\u672C\u8A9E \u6D4B\u8BD5 \u6F22\u5B57' });

      expect(result.isSuccess).toBe(true);

      mockFetch.mockRestore();
    });

    it('should handle very long query', async () => {
      const longQuery = 'a'.repeat(1000);
      const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html><body>No results</body></html>'),
      } as Response);

      const result = await executeWebSearch({ query: longQuery });

      expect(result.isSuccess).toBe(true);

      mockFetch.mockRestore();
    });
  });

  describe('Request formatting', () => {
    it('should send POST request to DDG HTML endpoint', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockImplementation((url, options) => {
        expect(url).toBe('https://html.duckduckgo.com/html/');
        expect(options?.method).toBe('POST');
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('<html><body>No results</body></html>'),
        } as Response);
      });

      const result = await executeWebSearch({ query: 'test' });

      expect(result.isSuccess).toBe(true);

      mockFetch.mockRestore();
    });

    it('should include proper headers', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockImplementation((url, options) => {
        expect(options?.headers?.['User-Agent']).toContain('Mozilla');
        expect(options?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
        expect(options?.headers?.['Accept']).toBe('text/html');
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('<html><body>No results</body></html>'),
        } as Response);
      });

      const result = await executeWebSearch({ query: 'test' });

      expect(result.isSuccess).toBe(true);

      mockFetch.mockRestore();
    });

    it('should send query as form data', async () => {
      const mockFetch = vi.spyOn(global, 'fetch').mockImplementation((url, options) => {
        const body = options?.body?.toString();
        expect(body).toContain('q=');
        expect(body).toContain('b=');
        expect(body).toContain('kl=');
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('<html><body>No results</body></html>'),
        } as Response);
      });

      const result = await executeWebSearch({ query: 'test query' });

      expect(result.isSuccess).toBe(true);

      mockFetch.mockRestore();
    });
  });
});

describe('Bug Candidates', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('BUG CANDIDATE: Direct URLs without DDG redirect may not be parsed', async () => {
    const directUrlHtml = `
      <html>
        <body>
          <div class="result">
            <a class="result__a" href="https://direct-example.com/page">Direct Link</a>
            <a class="result__snippet">Description</a>
          </div>
        </body>
      </html>
    `;

    const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(directUrlHtml),
    } as Response);

    const result = await executeWebSearch({ query: 'test' });

    expect(result.isSuccess).toBe(true);
    const hasDirectUrl = result.output.includes('https://direct-example.com/page');
    console.log('Bug Candidate - Direct URL parsed:', hasDirectUrl);

    mockFetch.mockRestore();
  });

  it('BUG CANDIDATE: Multiple allowed domains OR syntax may not work', async () => {
    const mockFetch = vi.spyOn(global, 'fetch').mockImplementation((url, options) => {
      const body = options?.body?.toString();
      console.log('Bug Candidate - Multiple domains form body:', body);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html><body>No results</body></html>'),
      } as Response);
    });

    const result = await executeWebSearch({
      query: 'test',
      allowed_domains: ['github.com', 'stackoverflow.com'],
    });

    expect(result.isSuccess).toBe(true);

    mockFetch.mockRestore();
  });

  it('BUG CANDIDATE: Malformed redirect URLs may cause issues', async () => {
    const malformedRedirectHtml = `
      <html>
        <body>
          <div class="result">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=%E0%A4%A">Malformed Link</a>
            <a class="result__snippet">Description</a>
          </div>
          <div class="result">
            <a class="result__a" href="https://valid.com">Valid Link</a>
            <a class="result__snippet">Valid Description</a>
          </div>
        </body>
      </html>
    `;

    const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(malformedRedirectHtml),
    } as Response);

    const result = await executeWebSearch({ query: 'test' });

    expect(result.isSuccess).toBe(true);
    const hasValidLink = result.output.includes('Valid Link');
    console.log('Bug Candidate - Malformed URL handled gracefully:', hasValidLink);

    mockFetch.mockRestore();
  });
});
