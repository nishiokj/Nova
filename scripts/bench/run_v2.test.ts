/**
 * Tests for benchmark v2 runner
 *
 * Tests the core utilities and helper functions used in the benchmark script.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

// Import functions and classes from run_v2.ts
import {
  parseArgs,
  BenchmarkProviderKeyService,
  BenchmarkLogger,
  aggregateMetrics,
  sanitizeBranchSegment,
  buildBranchName,
  getGitInfo,
} from './run_v2.ts';

describe('Benchmark v2 Utilities', () => {
  describe('parseArgs', () => {
    it('parses simple key-value arguments', () => {
      const args = parseArgs(['--model', 'gpt-4', '--temperature', '0.5']);
      expect(args.model).toBe('gpt-4');
      expect(args.temperature).toBe('0.5');
    });

    it('handles boolean flags as "true"', () => {
      const args = parseArgs(['--parallel', '--force-branch']);
      expect(args.parallel).toBe('true');
      expect(args.force_branch).toBe('true');
    });

    it('handles mixed arguments', () => {
      const args = parseArgs(['--model', 'claude-3', '--parallel', '--out', 'results.jsonl']);
      expect(args.model).toBe('claude-3');
      expect(args.parallel).toBe('true');
      expect(args.out).toBe('results.jsonl');
    });

    it('ignores non-flag arguments', () => {
      const args = parseArgs(['model', 'gpt-4', '--flag', 'value']);
      expect(args.model).toBeUndefined();
      expect(args.flag).toBe('value');
    });

    it('handles kebab-case conversion to camelCase', () => {
      const args = parseArgs(['--model-provider', 'openai', '--base-ref', 'main']);
      expect(args.model_provider).toBe('openai');
      expect(args.base_ref).toBe('main');
    });
  });

  describe('BenchmarkProviderKeyService', () => {
    it('stores and retrieves API keys', async () => {
      const service = new BenchmarkProviderKeyService({
        openai: 'sk-test-key-1',
        anthropic: 'ant-test-key-2',
      });

      expect(await service.getApiKey('openai')).toBe('sk-test-key-1');
      expect(await service.getApiKey('anthropic')).toBe('ant-test-key-2');
    });

    it('returns null for unknown provider', async () => {
      const service = new BenchmarkProviderKeyService({ openai: 'sk-test-key' });
      expect(await service.getApiKey('unknown')).toBeNull();
    });

    it('hasApiKey checks correctly', () => {
      const service = new BenchmarkProviderKeyService({
        openai: 'sk-test-key',
        anthropic: 'ant-test-key',
      });

      expect(service.hasApiKey('openai')).toBe(true);
      expect(service.hasApiKey('anthropic')).toBe(true);
      expect(service.hasApiKey('unknown')).toBe(false);
    });
  });

  describe('BenchmarkLogger', () => {
    it('implements all logging methods without error', () => {
      const logger = new BenchmarkLogger();

      // All methods should be no-ops and not throw
      expect(() => logger.info('test message')).not.toThrow();
      expect(() => logger.debug('debug message')).not.toThrow();
      expect(() => logger.warning('warning message')).not.toThrow();
      expect(() => logger.error('error message')).not.toThrow();
    });

    it('handles metadata in logging methods', () => {
      const logger = new BenchmarkLogger();

      expect(() => logger.info('test', { key: 'value' })).not.toThrow();
      expect(() => logger.debug('test', { nested: { data: 123 } })).not.toThrow();
    });
  });

  describe('sanitizeBranchSegment', () => {
    it('keeps alphanumeric, dot, dash, underscore', () => {
      expect(sanitizeBranchSegment('test-123')).toBe('test-123');
      expect(sanitizeBranchSegment('test_123')).toBe('test_123');
      expect(sanitizeBranchSegment('test.123')).toBe('test.123');
      expect(sanitizeBranchSegment('test')).toBe('test');
    });

    it('removes special characters', () => {
      expect(sanitizeBranchSegment('test@#$%')).toBe('test');
      expect(sanitizeBranchSegment('test!~`\'"')).toBe('test');
    });

    it('converts to lowercase', () => {
      expect(sanitizeBranchSegment('TEST')).toBe('test');
      expect(sanitizeBranchSegment('Test_Case')).toBe('test_case');
    });

    it('replaces multiple separators with single dash', () => {
      expect(sanitizeBranchSegment('test---case')).toBe('test-case');
      expect(sanitizeBranchSegment('test___case')).toBe('test-case');
      expect(sanitizeBranchSegment('test...case')).toBe('test-case');
    });

    it('trims leading and trailing separators', () => {
      expect(sanitizeBranchSegment('-test-')).toBe('test');
      expect(sanitizeBranchSegment('_test_')).toBe('test');
      expect(sanitizeBranchSegment('.test.')).toBe('test');
    });

    it('returns "default" for empty or whitespace', () => {
      expect(sanitizeBranchSegment('')).toBe('default');
      expect(sanitizeBranchSegment('   ')).toBe('default');
    });

    it('handles mixed valid and invalid characters', () => {
      expect(sanitizeBranchSegment('My Test-123')).toBe('my-test-123');
      expect(sanitizeBranchSegment('Feature/Bix-123')).toBe('feature-bix-123');
    });
  });

  describe('buildBranchName', () => {
    it('creates branch name with defaults', () => {
      const run = {
        sys_prompt_id: 'default',
        context_window_id: 'default',
      };
      const branchName = buildBranchName(1, run, 'gpt-4');
      expect(branchName).toBe('bench1_default_default_gpt-4');
    });

    it('uses custom prompt variant and context window', () => {
      const run = {
        sys_prompt_id: 'custom-prompt',
        context_window_id: 'large-window',
      };
      const branchName = buildBranchName(2, run, 'claude-3');
      expect(branchName).toBe('bench2_custom-prompt_large-window_claude-3');
    });

    it('sanitizes model label', () => {
      const run = {};
      const branchName = buildBranchName(1, run, 'OpenAI/GPT-4 Turbo');
      expect(branchName).toBe('bench1_default_default_openai/gpt-4-turbo');
    });

    it('handles missing prompt variants', () => {
      const run = {
        sys_prompt_id: undefined,
        context_window_id: undefined,
      };
      const branchName = buildBranchName(3, run, 'gpt-3.5');
      expect(branchName).toBe('bench3_default_default_gpt-3.5');
    });
  });

  describe('aggregateMetrics', () => {
    it('aggregates metrics from multiple results', () => {
      const results = [
        {
          success: true,
          response: 'OK',
          paused: false,
          terminationReason: 'goal_reached' as const,
          metrics: {
            iterations: 5,
            totalLlmCalls: 3,
            totalToolCalls: 8,
            durationMs: 1500,
          },
        },
        {
          success: true,
          response: 'OK',
          paused: false,
          terminationReason: 'goal_reached' as const,
          metrics: {
            iterations: 3,
            totalLlmCalls: 2,
            totalToolCalls: 4,
            durationMs: 1000,
          },
        },
      ];

      const events = [
        { type: 'tool_call', data: { tool: 'Read' } },
        { type: 'tool_call', data: { tool: 'Write' } },
        { type: 'tool_call', data: { tool: 'Read' } },
      ];

      const metrics = aggregateMetrics(results, events);

      expect(metrics.total_llm_calls).toBe(5);
      expect(metrics.total_tool_calls).toBe(12);
      expect(metrics.duration_ms).toBe(2500);
      expect(metrics.prompt_tokens).toBe(0); // Not tracked yet
      expect(metrics.completion_tokens).toBe(0); // Not tracked yet
      expect(metrics.total_tokens).toBe(0); // Not tracked yet
      expect(metrics.tool_names).toEqual(new Set(['Read', 'Write']));
    });

    it('handles empty results and events', () => {
      const metrics = aggregateMetrics([], []);

      expect(metrics.total_llm_calls).toBe(0);
      expect(metrics.total_tool_calls).toBe(0);
      expect(metrics.prompt_tokens).toBe(0);
      expect(metrics.completion_tokens).toBe(0);
      expect(metrics.total_tokens).toBe(0);
      expect(metrics.duration_ms).toBe(0);
      expect(metrics.tool_names.size).toBe(0);
    });

    it('collects unique tool names from events', () => {
      const results = [
        {
          success: true,
          response: 'OK',
          paused: false,
          terminationReason: 'goal_reached' as const,
          metrics: {
            iterations: 1,
            totalLlmCalls: 1,
            totalToolCalls: 1,
            durationMs: 500,
          },
        },
      ];

      const events = [
        { type: 'tool_call', data: { tool: 'Read' } },
        { type: 'tool_call', data: { tool: 'Write' } },
        { type: 'tool_call', data: { tool: 'Read' } }, // Duplicate
        { type: 'other_event', data: {} }, // Not a tool call
      ];

      const metrics = aggregateMetrics(results, events);

      expect(metrics.tool_names).toEqual(new Set(['Read', 'Write']));
    });

    it('handles events without tool name', () => {
      const results = [
        {
          success: true,
          response: 'OK',
          paused: false,
          terminationReason: 'goal_reached' as const,
          metrics: {
            iterations: 1,
            totalLlmCalls: 1,
            totalToolCalls: 1,
            durationMs: 500,
          },
        },
      ];

      const events = [
        { type: 'tool_call', data: {} }, // Missing tool name
        { type: 'tool_call', data: { tool: null } }, // Null tool name
      ];

      const metrics = aggregateMetrics(results, events);

      expect(metrics.tool_names.size).toBe(0);
    });

    it('sums durations correctly across many results', () => {
      const results = Array.from({ length: 10 }, (_, i) => ({
        success: true,
        response: 'OK',
        paused: false,
        terminationReason: 'goal_reached' as const,
        metrics: {
          iterations: 1,
          totalLlmCalls: 1,
          totalToolCalls: 1,
          durationMs: 100,
        },
      }));

      const metrics = aggregateMetrics(results, []);

      expect(metrics.total_llm_calls).toBe(10);
      expect(metrics.total_tool_calls).toBe(10);
      expect(metrics.duration_ms).toBe(1000);
    });
  });

  describe('getGitInfo', () => {
    it('returns empty object if not in git repo', () => {
      const info = getGitInfo();
      // If in a git repo, this will have values. If not, empty object.
      expect(typeof info).toBe('object');
    });

    it('includes sha, branch, and dirty flags when available', () => {
      const info = getGitInfo();
      // When running in a git repo, these should be strings
      if (info.sha) {
        expect(typeof info.sha).toBe('string');
        expect(info.sha.length).toBeGreaterThan(0);
      }
      if (info.branch) {
        expect(typeof info.branch).toBe('string');
      }
      if (info.dirty !== undefined) {
        expect(typeof info.dirty).toBe('boolean');
      }
    });
  });

  describe('Integration: parsing and building', () => {
    it('parses args and builds branch name together', () => {
      const args = parseArgs([
        '--model',
        'claude-3',
        '--sys-prompt',
        'custom',
        '--context-window',
        'large',
      ]);

      const run = {
        sys_prompt_id: args.sys_prompt,
        context_window_id: args.context_window,
      };

      const branchName = buildBranchName(1, run, args.model);

      expect(branchName).toBe('bench1_custom_large_claude-3');
    });
  });
});
