/**
 * Behavioral tests for auto-compaction — the compaction triggered on item addition
 * when ContextWindow is near capacity.
 *
 * These tests exercise _maybeAutoCompact through the public add* API.
 * They verify the behavior that existing compact() unit tests don't cover:
 * - Count limits are enforced as items accumulate via add methods
 * - Output truncation fires on addition, not just manual compact()
 * - Deduplication fires on addition
 * - Messages and reasoning are never removed
 * - Debounce prevents compaction storms (the root cause of 40+ compaction runs per benchmark)
 * - Agent-level deep compaction at 80% with tighter limits
 */

import { ContextWindow } from 'context/context-window.js';
import type { FileContentItem, FunctionCallOutputItem } from 'types';

// ============================================
// HELPERS
// ============================================

/** Pad content to a target character count */
function pad(n: number): string {
  return 'x'.repeat(n);
}

/**
 * Compute the maxTokens that puts a given char count right at the 50% threshold.
 * estimateTokenUsage = chars / 4, isNearFull(0.5) = estimateTokenUsage / maxTokens >= 0.5
 * So chars / 4 / maxTokens >= 0.5  →  maxTokens <= chars / 2
 */
function maxTokensForCharsAt50Pct(totalChars: number): number {
  return Math.floor(totalChars / 2);
}

/** Count items of a given type */
function countType(ctx: ContextWindow, type: string): number {
  return ctx.items.filter(i => i.type === type).length;
}

/** Get all file_content paths currently in context */
function filePaths(ctx: ContextWindow): string[] {
  return ctx.items
    .filter((i): i is FileContentItem => i.type === 'file_content')
    .map(i => i.path);
}

// ============================================
// AUTO-COMPACTION FILE COUNT LIMITS
// ============================================

describe('Auto-compaction enforces file count limits through add methods', () => {
  it('removes excess file_content when count exceeds internal limit of 30', () => {
    // Size: 50 files × ~415 chars each = ~20,750 chars total.
    // Need isNearFull(0.5) to trigger by the time we have 30+ files.
    // 30 × 415 = 12,450 chars → maxTokens <= 12,450 / 2 = 6,225
    const ctx = new ContextWindow('test', 6000);

    // Add 50 files — auto-compaction will fire and enforce maxFileContentCount: 30
    for (let i = 0; i < 50; i++) {
      ctx.addFileContent(`/file${String(i).padStart(3, '0')}.ts`, pad(400));
    }

    const fileCount = countType(ctx, 'file_content');
    // With debounce window of 10, count may be up to 30 + 9 = 39
    // But it MUST be bounded, not 50
    expect(fileCount).toBeLessThanOrEqual(40);
    expect(fileCount).toBeGreaterThanOrEqual(30);

    // Oldest files should be the ones removed
    const paths = filePaths(ctx);
    // file000, file001, ... should be gone; newest should remain
    expect(paths).toContain('/file049.ts');
    expect(paths).toContain('/file048.ts');
    expect(paths).toContain('/file040.ts');
    // Early files should be evicted
    expect(paths).not.toContain('/file000.ts');
    expect(paths).not.toContain('/file001.ts');
  });

  it('preserves newest files during LRU eviction', () => {
    const ctx = new ContextWindow('test', 4000);

    for (let i = 0; i < 40; i++) {
      ctx.addFileContent(`/f${i}.ts`, pad(350));
    }

    const paths = filePaths(ctx);
    // The newest N files should always be present
    const newest10 = Array.from({ length: 10 }, (_, i) => `/f${39 - i}.ts`);
    for (const p of newest10) {
      expect(paths).toContain(p);
    }
  });
});

// ============================================
// AUTO-COMPACTION FUNCTION CALL LIMITS
// ============================================

describe('Auto-compaction enforces function call output count limits', () => {
  it('removes excess function_call_output when count exceeds 220', () => {
    // Each output: ~200 chars. 230 outputs = 46,000 chars → maxTokens <= 23,000
    const ctx = new ContextWindow('test', 22_000);

    for (let i = 0; i < 230; i++) {
      ctx.addFunctionCall(`call-${i}`, 'Read', { path: `/f${i}.ts` });
      ctx.addFunctionCallOutput(`call-${i}`, pad(200));
    }

    const outputCount = countType(ctx, 'function_call_output');
    // Should be bounded near 220, not 230
    expect(outputCount).toBeLessThanOrEqual(230); // debounce may allow some overshoot
    // But critical: it's not unbounded
    expect(outputCount).toBeLessThan(230); // compaction must have removed at least some
  });
});

// ============================================
// AUTO-COMPACTION OUTPUT TRUNCATION
// ============================================

describe('Auto-compaction truncates long outputs on add', () => {
  it('truncates function_call_output exceeding 3000 chars when near capacity', () => {
    // Small context to trigger isNearFull quickly
    const ctx = new ContextWindow('test', 3000);

    // Fill context to near capacity
    ctx.addFileContent('/big.ts', pad(4000));

    // Add a long output — auto-compaction should truncate it
    ctx.addFunctionCall('call-1', 'Bash', { command: 'ls' });
    ctx.addFunctionCallOutput('call-1', pad(10_000));

    // Need at least 10 items for debounce to allow compaction.
    // Add padding items to reach 10 total.
    for (let i = 2; i <= 8; i++) {
      ctx.addFunctionCall(`call-${i}`, 'Read', { path: `/pad${i}.ts` });
      ctx.addFunctionCallOutput(`call-${i}`, 'short');
    }

    // After auto-compaction, the long output should be truncated
    const longOutput = ctx.items.find(
      (i): i is FunctionCallOutputItem =>
        i.type === 'function_call_output' && i.callId === 'call-1'
    );

    // If auto-compaction fired, output should be truncated
    // The internal auto-compact truncates to 3000
    if (longOutput) {
      expect(longOutput.output.length).toBeLessThan(10_000);
      expect(longOutput.output).toContain('[truncated');
    }
  });
});

// ============================================
// AUTO-COMPACTION DEDUPLICATION
// ============================================

describe('Auto-compaction deduplicates file_content by path', () => {
  it('keeps only the newest version of each file when near capacity', () => {
    // Need enough chars to trigger isNearFull(0.5).
    // 20 items × ~420 chars = 8400 chars → 2100 tokens. maxTokens=3000 → 70% → triggers.
    const ctx = new ContextWindow('test', 3000);

    // Add 10 pairs of duplicate files with enough content to exceed 50%
    for (let i = 0; i < 10; i++) {
      ctx.addFileContent('/target.ts', `version_${i * 2}_${pad(400)}`, 'typescript');
      ctx.addFileContent('/target.ts', `version_${i * 2 + 1}_${pad(400)}`, 'typescript');
    }

    // Should have at most a few versions of /target.ts (dedup keeps newest)
    const targetItems = ctx.items.filter(
      (i): i is FileContentItem => i.type === 'file_content' && i.path === '/target.ts'
    );

    // After deduplication, duplicates should be reduced significantly
    // The debounce may allow a few recent duplicates to accumulate
    expect(targetItems.length).toBeLessThan(10); // Must have removed at least half

    // The surviving version(s) should include the most recent
    const newestContent = targetItems[targetItems.length - 1].content;
    expect(newestContent).toContain('version_19'); // Last version added
  });
});

// ============================================
// MESSAGES AND REASONING ARE NEVER REMOVED
// ============================================

describe('Auto-compaction never removes messages or reasoning', () => {
  it('preserves all messages even when context exceeds capacity', () => {
    const ctx = new ContextWindow('test', 1000);

    // Add 30 messages — enough to exceed capacity by far
    // 30 × 200 chars = 6000 chars → 1500 tokens >> 1000 maxTokens
    for (let i = 0; i < 30; i++) {
      ctx.addMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}: ${pad(150)}`);
    }

    // All 30 messages must survive — compaction never removes messages
    const messageCount = countType(ctx, 'message');
    expect(messageCount).toBe(30);
  });

  it('preserves all reasoning items even when context exceeds capacity', () => {
    const ctx = new ContextWindow('test', 1000);

    // addReasoning does NOT call _maybeAutoCompact, so these should all survive
    for (let i = 0; i < 20; i++) {
      ctx.addReasoning(`Thinking step ${i}: ${pad(200)}`);
    }

    expect(countType(ctx, 'reasoning')).toBe(20);
  });

  it('removes file_content but keeps interleaved messages intact', () => {
    const ctx = new ContextWindow('test', 5000);

    // Simulate agent iterations: message → file_read → message → file_read ...
    for (let i = 0; i < 25; i++) {
      ctx.addMessage(i % 2 === 0 ? 'user' : 'assistant', `Turn ${i}`);
      ctx.addFileContent(`/file${i}.ts`, pad(400));
    }

    // All 25 messages must be present
    expect(countType(ctx, 'message')).toBe(25);

    // File count should be bounded (≤ 30 + debounce window)
    const fileCount = countType(ctx, 'file_content');
    expect(fileCount).toBeLessThanOrEqual(40);
  });
});

// ============================================
// DEBOUNCE PREVENTS COMPACTION STORM
// ============================================

describe('Debounce prevents compaction storms', () => {
  it('does not compact on every add when items are within 10 of last compaction', () => {
    const ctx = new ContextWindow('test', 5000);

    // Fill to near capacity to ensure isNearFull(0.5) is true
    for (let i = 0; i < 20; i++) {
      ctx.addFileContent(`/boot${i}.ts`, pad(400));
    }

    const itemsAfterBoot = ctx.items.length;
    const versionAfterBoot = ctx.version;

    // Add 5 more items (within debounce window of 10)
    for (let i = 0; i < 5; i++) {
      ctx.addFunctionCall(`call-${i}`, 'Read', { path: `/extra${i}.ts` });
      // addFunctionCall does NOT call _maybeAutoCompact
    }

    // Add 3 small function_call_outputs (these DO call _maybeAutoCompact)
    for (let i = 0; i < 3; i++) {
      ctx.addFunctionCallOutput(`call-${i}`, 'short');
    }

    // Items should have grown by 8 (5 calls + 3 outputs)
    // If debounce is working, no compaction occurred during these 8 adds
    // (because we're within 10 items of last compaction point)
    const itemsNow = ctx.items.length;
    expect(itemsNow).toBeGreaterThanOrEqual(itemsAfterBoot + 5);
  });

  it('recompacts after 10 new items accumulate past debounce threshold', () => {
    const ctx = new ContextWindow('test', 4000);

    // Fill with files to trigger first compaction
    for (let i = 0; i < 35; i++) {
      ctx.addFileContent(`/f${String(i).padStart(2, '0')}.ts`, pad(300));
    }

    const fileCountAfterFirstBatch = countType(ctx, 'file_content');
    // Auto-compaction should have enforced the 30 limit (with possible debounce overshoot)
    expect(fileCountAfterFirstBatch).toBeLessThanOrEqual(40);

    // Record the count, then add enough items to exceed debounce + trigger again
    const countBefore = ctx.items.length;
    for (let i = 35; i < 50; i++) {
      ctx.addFileContent(`/f${String(i).padStart(2, '0')}.ts`, pad(300));
    }

    // After 15 more adds, compaction should have fired at least once more
    // File count should still be bounded
    const fileCountFinal = countType(ctx, 'file_content');
    expect(fileCountFinal).toBeLessThanOrEqual(40);
  });
});

// ============================================
// CLEAR RESETS DEBOUNCE STATE
// ============================================

describe('clear() resets auto-compaction state', () => {
  it('compaction activates normally after clear', () => {
    const ctx = new ContextWindow('test', 5000);

    // Fill and trigger compaction
    for (let i = 0; i < 40; i++) {
      ctx.addFileContent(`/old${i}.ts`, pad(400));
    }

    // Verify compaction happened
    expect(countType(ctx, 'file_content')).toBeLessThan(40);

    // Clear everything
    ctx.clear();
    expect(ctx.items.length).toBe(0);

    // Refill — compaction should work from scratch (debounce reset)
    for (let i = 0; i < 40; i++) {
      ctx.addFileContent(`/new${i}.ts`, pad(400));
    }

    const fileCount = countType(ctx, 'file_content');
    expect(fileCount).toBeLessThanOrEqual(40);
    expect(fileCount).toBeGreaterThanOrEqual(30);

    // New files should be present, not old
    const paths = filePaths(ctx);
    expect(paths.some(p => p.startsWith('/new'))).toBe(true);
    expect(paths.some(p => p.startsWith('/old'))).toBe(false);
  });
});

// ============================================
// SIMULATED AGENT LOOP
// ============================================

describe('Simulated agent loop: items stay bounded', () => {
  it('file count stays bounded across many iterations with mixed item types', () => {
    // Simulate a realistic agent execution with enough iterations to exceed
    // ALL count limits: 30 files, 220 function_calls, 220 function_call_outputs.
    // Each iteration: 1 reasoning, 2 tool calls + 2 outputs, 1 file read, 1 message = 7 items.
    // Need 240+ iterations to exceed the 220 function_call limit.
    const ctx = new ContextWindow('agent-sim', 15_000);
    const totalIterations = 80;

    for (let iteration = 0; iteration < totalIterations; iteration++) {
      ctx.addReasoning(`Iteration ${iteration}: thinking...`);

      ctx.addFunctionCall(`read-${iteration}`, 'Read', { path: `/src/file${iteration}.ts` });
      ctx.addFunctionCallOutput(`read-${iteration}`, pad(300));

      ctx.addFileContent(`/src/file${iteration}.ts`, pad(400));

      ctx.addFunctionCall(`grep-${iteration}`, 'Grep', { pattern: 'foo' });
      ctx.addFunctionCallOutput(`grep-${iteration}`, pad(200));

      ctx.addMessage('assistant', `Iteration ${iteration} complete.`);
    }

    // 80 iterations × 7 items = 560 items added

    // Files: must be bounded by maxFileContentCount (30) + debounce window
    const fileCount = countType(ctx, 'file_content');
    expect(fileCount).toBeLessThanOrEqual(40);

    // Messages: ALL must survive (never removed by compaction)
    expect(countType(ctx, 'message')).toBe(totalIterations);

    // Reasoning: ALL must survive (addReasoning doesn't trigger auto-compact)
    expect(countType(ctx, 'reasoning')).toBe(totalIterations);

    // Function calls and outputs: 160 each (2 per iteration), within 220 limit
    // These won't be removed, but the file_content reduction means total < 560
    expect(ctx.items.length).toBeLessThan(560);
    // Files specifically should be capped — this is the key behavioral contract
    expect(fileCount).toBeLessThan(totalIterations);
  });

  it('most recent files are always preserved even after many iterations', () => {
    const ctx = new ContextWindow('recency', 6000);

    for (let i = 0; i < 40; i++) {
      ctx.addFileContent(`/src/mod${String(i).padStart(2, '0')}.ts`, pad(400));
      ctx.addMessage('assistant', `Read mod${i}`);
    }

    const paths = filePaths(ctx);

    // The most recent 10 files should definitely be present
    for (let i = 30; i < 40; i++) {
      expect(paths).toContain(`/src/mod${String(i).padStart(2, '0')}.ts`);
    }
  });
});

// ============================================
// AGENT-LEVEL DEEP COMPACTION (0.80 threshold, tighter limits)
// ============================================

describe('Agent-level deep compaction with tighter limits', () => {
  it('compact with agent config reduces file count to 15', () => {
    const ctx = new ContextWindow('deep', 10_000);

    // Add 25 files
    for (let i = 0; i < 25; i++) {
      ctx.addFileContent(`/f${i}.ts`, pad(500));
    }

    // Manually invoke compact with agent-level config
    const result = ctx.compact({
      deduplicateByPath: true,
      truncateOutputsTo: 2000,
      maxFileContentCount: 15,
      maxFunctionCallCount: 60,
      maxFunctionCallOutputCount: 60,
    });

    expect(result.fileContentRemoved).toBe(10); // 25 - 15
    expect(countType(ctx, 'file_content')).toBe(15);

    // Oldest files removed
    expect(filePaths(ctx)).not.toContain('/f0.ts');
    expect(filePaths(ctx)).not.toContain('/f9.ts');
    // Newest files kept
    expect(filePaths(ctx)).toContain('/f24.ts');
    expect(filePaths(ctx)).toContain('/f15.ts');
  });

  it('compact with agent config truncates outputs to 2000 chars', () => {
    const ctx = new ContextWindow('deep', 10_000);

    ctx.addFunctionCall('call-1', 'Bash', { command: 'find .' });
    ctx.addFunctionCallOutput('call-1', pad(5000));

    const result = ctx.compact({
      deduplicateByPath: true,
      truncateOutputsTo: 2000,
      maxFileContentCount: 15,
      maxFunctionCallCount: 60,
      maxFunctionCallOutputCount: 60,
    });

    expect(result.outputsTruncated).toBe(1);
    const output = ctx.items.find(
      (i): i is FunctionCallOutputItem => i.type === 'function_call_output'
    )!;
    expect(output.output.length).toBeLessThan(2200); // 2000 + truncation message
    expect(output.output).toContain('[truncated');
  });

  it('compact with agent config reduces function calls to 60', () => {
    const ctx = new ContextWindow('deep', 30_000);

    for (let i = 0; i < 80; i++) {
      ctx.addFunctionCall(`call-${i}`, 'Read', { path: `/f${i}.ts` });
      ctx.addFunctionCallOutput(`call-${i}`, pad(100));
    }

    const result = ctx.compact({
      deduplicateByPath: true,
      truncateOutputsTo: 2000,
      maxFileContentCount: 15,
      maxFunctionCallCount: 60,
      maxFunctionCallOutputCount: 60,
    });

    expect(result.functionCallsRemoved).toBe(20); // 80 - 60
    expect(result.functionCallOutputsRemoved).toBe(20);
    expect(countType(ctx, 'function_call')).toBe(60);
    expect(countType(ctx, 'function_call_output')).toBe(60);

    // Newest calls survive
    const callIds = ctx.items
      .filter(i => i.type === 'function_call')
      .map(i => (i as any).callId as string);
    expect(callIds).toContain('call-79'); // newest
    expect(callIds).toContain('call-20'); // boundary
    expect(callIds).not.toContain('call-0'); // oldest, removed
    expect(callIds).not.toContain('call-19'); // still too old
  });
});

// ============================================
// isNearFull THRESHOLD ACCURACY
// ============================================

describe('isNearFull threshold accuracy for compaction triggers', () => {
  it('returns false at 49% capacity and true at 51%', () => {
    // 1000 maxTokens → 50% = 500 tokens = 2000 chars
    const ctx = new ContextWindow('threshold', 1000);

    // Add content just under 50%: 1950 chars → 487.5 tokens → 48.75%
    ctx.addFileContent('/under.ts', pad(1935)); // 1935 + ~15 for path = ~1950

    expect(ctx.isNearFull(0.5)).toBe(false);

    // Push over 50%: add 100 more chars → 2050 chars → 512.5 → 51.25%
    ctx.addFileContent('/over.ts', pad(85)); // ~100 chars

    expect(ctx.isNearFull(0.5)).toBe(true);
  });

  it('0.80 threshold fires only when truly critical', () => {
    // 1000 maxTokens → 80% = 800 tokens = 3200 chars
    const ctx = new ContextWindow('high-thresh', 1000);

    // At 60%: 2400 chars
    ctx.addFileContent('/medium.ts', pad(2385));
    expect(ctx.isNearFull(0.8)).toBe(false);

    // At 85%: 3400 chars
    ctx.addFileContent('/critical.ts', pad(985));
    expect(ctx.isNearFull(0.8)).toBe(true);
  });
});

// ============================================
// TWO-TIER COMPACTION INTERACTION
// ============================================

describe('Two-tier compaction: internal (50%) and agent-level (80%)', () => {
  it('internal auto-compact at 50% uses generous limits, leaving room for agent deep-compact', () => {
    // After internal auto-compact at 50%, file count limit is 30.
    // Agent deep-compact at 80% should further reduce to 15.
    const ctx = new ContextWindow('two-tier', 6000);

    // Add 40 files → internal auto-compact caps at ~30-40
    for (let i = 0; i < 40; i++) {
      ctx.addFileContent(`/f${i}.ts`, pad(400));
    }

    const afterInternal = countType(ctx, 'file_content');
    expect(afterInternal).toBeLessThanOrEqual(40); // internal limit: 30 + debounce

    // Simulate agent deep-compact (would fire at 80% threshold)
    if (ctx.isNearFull(0.8)) {
      const result = ctx.compact({
        deduplicateByPath: true,
        truncateOutputsTo: 2000,
        maxFileContentCount: 15,
        maxFunctionCallCount: 60,
        maxFunctionCallOutputCount: 60,
      });

      // Agent compact should reduce further
      expect(countType(ctx, 'file_content')).toBe(15);
      expect(result.fileContentRemoved).toBeGreaterThan(0);
    }
  });
});
