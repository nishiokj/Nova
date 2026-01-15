# Write Optimizations - Low Hanging Fruit for Tools

This document identifies low-hanging optimizations to speed up and reduce complexity in the tools implementation.

## Overview

The tools in `packages/tools/src/builtins/` are generally well-structured, but there are several opportunities for optimization and complexity reduction. These are categorized by tool.

---

## Write/Edit/BatchEdit (`write.ts`)

### 1. Simplify `countOccurrences` Implementation

**Current:** Manual loop with `indexOf`:
```typescript
function countOccurrences(content: string, search: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = content.indexOf(search, idx)) !== -1) {
    count++;
    idx += search.length;
  }
  return count;
}
```

**Optimization:** Use `split().length - 1`:
```typescript
function countOccurrences(content: string, search: string): number {
  return search.length > 0 ? content.split(search).length - 1 : 0;
}
```

**Benefits:**
- Simpler, more readable
- Potentially faster for small strings (native implementation)
- Handles empty string edge case explicitly

**Tradeoffs:**
- Creates intermediate array, which could be memory-intensive for very large content
- If content is large and search string is rare, the loop approach may be more efficient

**Recommendation:** Keep the loop approach for large files (e.g., > 100KB), use `split` for small files.

---

### 2. Remove Debug Logging

**Current:** `console.error` statements in `executeEdit`:
```typescript
console.error(`[EDIT_DEBUG] Edit called: path=${path}, cwd=${cwd}, resolvedPath=${resolvedPath}`);
console.error(`[EDIT_DEBUG] Edit write succeeded: ${resolvedPath} (${newContent.length} bytes)`);
console.error(`[EDIT_DEBUG] Edit write FAILED: ${resolvedPath}, error=${e}`);
```

**Optimization:** Remove or make conditional via environment variable.

**Benefits:**
- Reduces noise in logs
- Slight performance improvement (avoiding string formatting)

**Recommendation:** Remove entirely, or add via a debug flag like `process.env.DEBUG_TOOLS`.

---

### 3. Optimize Context Line Calculation

**Current:** Multiple operations on the same content:
```typescript
const linesBefore = newContent.slice(0, firstNewIdx).split('\n').length - 1;
const startLine = Math.max(0, linesBefore - 1);
const endLine = Math.min(newLines.length, linesBefore + newString.split('\n').length + 2);
```

**Optimization:** Calculate once and reuse:
```typescript
const contextLines = getContextLines(newContent, firstNewIdx, newString, 2);
```

Extract to helper function:
```typescript
function getContextLines(
  content: string,
  replacementIndex: number,
  replacement: string,
  context: number
): string {
  const lines = content.split('\n');
  const linesBefore = content.slice(0, replacementIndex).split('\n').length - 1;
  const startLine = Math.max(0, linesBefore - context);
  const endLine = Math.min(lines.length, linesBefore + replacement.split('\n').length + context);
  return lines.slice(startLine, endLine)
    .map((line, i) => `${startLine + i + 1}: ${line}`)
    .join('\n');
}
```

**Benefits:**
- Reduces code duplication
- Easier to test
- More maintainable

---

### 4. Consolidate Atomic Write Pattern

**Current:** Replicated in `executeWrite`, `executeEdit`, and `executeBatchEdit`:
```typescript
const tmpPath = resolve(dirPath, `.tmp_${tool}_${randomBytes(8).toString('hex')}.tmp`);
try {
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, resolvedPath);
} catch (e) {
  try { await unlink(tmpPath); } catch {}
  throw e;
}
```

**Optimization:** Extract to shared utility:
```typescript
async function atomicWrite(
  filePath: string,
  content: string,
  encoding: BufferEncoding = 'utf-8'
): Promise<void> {
  const dirPath = dirname(filePath);
  const tmpPath = resolve(dirPath, `.tmp_${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(tmpPath, content, encoding);
    await rename(tmpPath, filePath);
  } catch (e) {
    try { await unlink(tmpPath); } catch {}
    throw e;
  }
}
```

**Benefits:**
- Reduces code duplication by ~30 lines
- Single place to fix bugs
- Easier to add features (e.g., retry logic)

---

## Read (`read.ts`)

### 1. Simplify Large File Handling

**Current:** Manual stream copying into buffer:
```typescript
const buffer = Buffer.alloc(maxBytes);
const { createReadStream } = await import('fs');
const stream = createReadStream(resolvedPath, { end: maxBytes - 1 });
let bytesRead = 0;
for await (const chunk of stream) {
  const chunkBuffer = chunk as Buffer;
  chunkBuffer.copy(buffer, bytesRead);
  bytesRead += chunkBuffer.length;
  if (bytesRead >= maxBytes) break;
}
content = buffer.slice(0, bytesRead).toString(encoding);
```

**Optimization:** Use `readFile` with slicing:
```typescript
const fd = await open(resolvedPath, 'r');
const buffer = Buffer.alloc(maxBytes);
const { bytesRead } = await fd.read(buffer, 0, maxBytes, 0);
await fd.close();
content = buffer.slice(0, bytesRead).toString(encoding);
```

Or even simpler, use `fs.createReadStream` with pipe:
```typescript
const { createReadStream } = await import('fs');
const chunks: Buffer[] = [];
let totalBytes = 0;
for await (const chunk of createReadStream(resolvedPath, { end: maxBytes - 1 })) {
  chunks.push(chunk as Buffer);
  totalBytes += (chunk as Buffer).length;
  if (totalBytes >= maxBytes) break;
}
content = Buffer.concat(chunks).toString(encoding);
```

**Benefits:**
- Simpler code
- Potentially faster (no manual buffer copying)
- More memory-efficient with chunks

---

### 2. Avoid Unnecessary Line Counting

**Current:** Always counts lines:
```typescript
let totalLines = 0;
if (startLine !== undefined || endLine !== undefined) {
  const lines = content.split('\n');
  totalLines = lines.length;
  // ...
}
```

**Optimization:** Only count lines when needed:
```typescript
if (startLine !== undefined || endLine !== undefined) {
  const lines = content.split('\n');
  const totalLines = lines.length;
  const start = Math.max(0, (startLine ?? 1) - 1);
  const end = Math.min(lines.length, endLine ?? lines.length);
  const slice = lines.slice(start, end);
  content = `// Lines ${start + 1}-${Math.min(end, totalLines)} of ${totalLines} total\n${slice.join('\n')}`;
  return { ...successResult('Read', content, duration), metadata: { path: resolvedPath, size: fileSize, action: 'read', totalLines, startLine, endLine } };
}
return { ...successResult('Read', content, duration), metadata: { path: resolvedPath, size: fileSize, action: 'read' } };
```

**Benefits:**
- Avoids unnecessary `split('\n')` for non-line-range reads
- Reduces memory allocation

---

## Glob (`glob.ts`)

### 1. Simplify `shouldUseRipgrep` Logic

**Current:** Multiple condition checks:
```typescript
function shouldUseRipgrep(pattern: string): boolean {
  if (pattern.startsWith('!')) return false;
  if (pattern.startsWith('/')) return false;
  if (pattern.endsWith('/')) return false;
  if (pattern.includes('{') || pattern.includes('}')) return false;
  const lastSegment = pattern.split('/').pop() ?? '';
  if (!lastSegment || lastSegment === '.' || lastSegment === '..') return false;
  return lastSegment.includes('.');
}
```

**Optimization:** Use regex:
```typescript
const RIPGREP_COMPATIBLE_PATTERN = /^[^.!{}].*\.[^.]+$/;

function shouldUseRipgrep(pattern: string): boolean {
  if (pattern.startsWith('!') || pattern.startsWith('/') || pattern.endsWith('/')) return false;
  if (pattern.includes('{') || pattern.includes('}')) return false;
  const lastSegment = pattern.split('/').pop() ?? '';
  return lastSegment !== '.' && lastSegment !== '..' && RIPGREP_COMPATIBLE_PATTERN.test(lastSegment);
}
```

**Benefits:**
- More declarative
- Easier to understand valid patterns

---

### 2. Sort Only Limited Results

**Current:** Sorts all matches before slicing:
```typescript
const limitedMatches = matches.slice(0, maxResults);
limitedMatches.sort();
```

**Optimization:** Sort first, then slice:
```typescript
matches.sort();
const limitedMatches = matches.slice(0, maxResults);
```

**Benefits:**
- More accurate results (sorting all ensures consistent ordering)
- Same performance for typical use cases

---

## Grep (`grep.ts`)

### 1. Simplify `globToRegex`

**Current:** Complex string replacement:
```typescript
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`(^|/)${escaped}$`);
}
```

**Optimization:** Use a library like `minimatch` or `picomatch`:
```typescript
import { minimatch } from 'minimatch';

function globToRegex(glob: string): RegExp {
  return minimatch.makeRe(glob, { dot: true });
}
```

**Benefits:**
- More robust glob handling
- Handles edge cases better
- Well-tested implementation

**Tradeoffs:**
- Adds a dependency
- May be overkill for simple patterns

**Recommendation:** If only simple patterns are needed, keep current implementation. If complex patterns are required, use a library.

---

### 2. Batch File Reading in Fallback

**Current:** Reads files one at a time in recursive search:
```typescript
async function searchFile(filePath: string): Promise<void> {
  if (matches.length >= maxResults) return;
  try {
    const content = await readFile(filePath, 'utf-8');
    // ...
  } catch { /* skip */ }
}
```

**Optimization:** Use `Promise.all` for batching:
```typescript
const BATCH_SIZE = 10;
async function searchFilesBatch(filePaths: string[]): Promise<void> {
  if (matches.length >= maxResults) return;
  const batch = filePaths.slice(0, BATCH_SIZE);
  const results = await Promise.all(
    batch.map(async (filePath) => {
      try {
        const content = await readFile(filePath, 'utf-8');
        // ... find matches
      } catch { return []; }
    })
  );
  // ... combine results
}
```

**Benefits:**
- Parallel I/O for better performance
- Reduces total latency for directory searches

**Tradeoffs:**
- More memory usage (multiple files read at once)
- More complex code

**Recommendation:** Only implement if profiling shows this is a bottleneck.

---

## Bash (`bash.ts`)

### 1. Extract Output Truncation Helper

**Current:** Inline truncation logic:
```typescript
let output = stdout;
if (stderr) {
  output += `\n[stderr]: ${stderr}`;
}
if (output.length > 100000) {
  output = output.slice(0, 100000) + '\n...[truncated]';
}
```

**Optimization:** Extract to helper:
```typescript
function truncateOutput(output: string, maxLength: number = 100000): string {
  return output.length > maxLength
    ? output.slice(0, maxLength) + '\n...[truncated]'
    : output;
}
```

**Benefits:**
- Reusable across tools
- Consistent truncation behavior
- Easier to test

---

### 2. Cache Environment Merging

**Current:** Spreads environment every call:
```typescript
const env = (args.env as Record<string, string>) ?? {
  ...process.env,
  ...context?.envOverrides,
};
```

**Optimization:** Cache merged environment:
```typescript
const mergedEnv = { ...process.env, ...(context?.envOverrides ?? {}) };
const env = args.env as Record<string, string> ?? mergedEnv;
```

**Benefits:**
- Minor performance improvement
- Cleaner code

---

## General Recommendations

### 1. Add Performance Benchmarks

Create a benchmark suite to measure tool performance:
```typescript
// packages/tools/benchmarks/bench.ts
import { executeRead, executeGrep, executeGlob } from '../src/builtins/index.js';

async function benchmark() {
  // Benchmark Read with various file sizes
  // Benchmark Grep with various patterns
  // Benchmark Glob with various patterns
}
```

### 2. Add Profiling Hooks

Add optional profiling to identify hotspots:
```typescript
const PROFILE = process.env.PROFILE_TOOLS === 'true';

function profile<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!PROFILE) return fn();
  const start = Date.now();
  return fn().finally(() => {
    console.log(`[PROFILE] ${name}: ${Date.now() - start}ms`);
  });
}
```

### 3. Consider Streaming for Large Outputs

For tools that produce large outputs (Read, Grep), consider streaming results:
```typescript
async function* streamGrepResults(pattern: string, path: string): AsyncGenerator<string> {
  // Yield matches as they're found
}
```

**Benefits:**
- Lower memory usage
- Faster time-to-first-result

**Tradeoffs:**
- More complex implementation
- Requires changes to tool result handling

---

## Priority Matrix

| Optimization | Impact | Effort | Priority |
|--------------|--------|--------|----------|
| Consolidate atomic write | Medium | Low | High |
| Remove debug logging | Low | Low | High |
| Extract output truncation | Low | Low | High |
| Simplify large file handling | Medium | Medium | Medium |
| Batch file reading | High | High | Medium |
| Simplify globToRegex | Low | Medium | Low |
| Add benchmarks | High | Medium | Medium |

---

## Next Steps

1. **High Priority:** Implement consolidations (atomic write, truncation helper)
2. **Medium Priority:** Add benchmarks to validate optimizations
3. **Low Priority:** Consider more complex optimizations after profiling

---

*Last Updated: 2026-01-15*

## Changelog

- 2026-01-15: Initial document created with comprehensive optimization recommendations