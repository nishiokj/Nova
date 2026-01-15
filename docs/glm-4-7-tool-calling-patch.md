# Patch: Improve Tool Calling Accuracy for GLM-4.7

## Problem Statement

GLM-4.7 struggles with tool calling in larger repositories:
1. **Stalling**: Overly cautious about reading files, checks history excessively, hesitates on uncertainty
2. **Insufficient tool calls**: Emits 1-2 calls when 5-10 would be appropriate
3. **Lack of creativity**: Follows rigid patterns, doesn't try alternative search strategies
4. **Search failures**: Gives up after first attempt, doesn't try case variations or parent directories

## Root Cause Analysis

The current prompts over-emphasize caution:
- "NEVER re-read files" creates hesitation
- No explicit numeric targets for parallelization
- Anti-patterns are framed as absolute prohibitions
- No guidance on fallback strategies when initial searches fail
- Grep defaults to case-sensitive, making it unforgiving

## Proposed Changes

### 1. STANDARD_PROMPT - Strengthen Parallelization Guidance

**Location**: `packages/agent/src/prompts.ts` (lines 292-365)

**Change**: Add explicit parallelization targets and reduce paralysis-inducing language.

**Current section** (Trade-off: Parallel Tool Calls):
```typescript
## Trade-off: Parallel Tool Calls

**Bad**: 1 Glob call, wait, then another = 2 iterations minimum.
**Good**: 5 Glob calls at once = slightly more context but high chance one hits. 1 iteration.

**Rule**: Emit MANY tool calls per response. Independent calls belong together. Never serialize what can parallelize.
```

**Proposed replacement**:
```typescript
## Trade-off: Parallel Tool Calls

**Bad**: 1 Glob call, wait, then another = 2 iterations minimum.
**Good**: 5 Glob calls at once = slightly more context but high chance one hits. 1 iteration.

**Rule**: Emit MANY tool calls per response. Independent calls belong together. Never serialize what can parallelize.

### Parallelization Targets - Be Aggressive

When searching or exploring, aim for **5-10 tool calls per response**:
- Searching for a file? Try multiple patterns: `**/filename.ts`, `**/filename.js`, `../**/filename.ts`
- Unsure of case? Use both variations in parallel: `className`, `ClassName`, `class_name`
- Don't know the exact location? Search multiple directories: `src/**/*`, `lib/**/*`, `app/**/*`

**A wide net is better than a narrow miss.** 10 calls with 2 hits is progress. 2 calls with 0 hits is a wasted iteration.

### When in Doubt, Emit

If you're uncertain about which tool call to make:
- **Don't wait** - emit multiple exploratory calls in parallel
- **Don't check history excessively** - if you're not 100% sure a file was read, read it
- **Try alternative strategies** - different patterns, case variations, parent directories

The cost of a redundant tool call is tiny compared to the cost of a stalled iteration.
```

**Change**: Soften anti-patterns to reduce paralysis.

**Current section**:
```typescript
## Anti-Patterns - NEVER DO THESE

- **NEVER re-read files already in your context.** If you see file contents in the conversation history, you already have them. Re-reading wastes iterations AND tokens.
- Do not repeat identical or near-identical tool calls.
- Check conversation history before Read calls.
```

**Proposed replacement**:
```typescript
## Anti-Patterns

Avoid these patterns, but don't let fear of them cause you to stall:

- **Avoid redundant reads** when you're certain the content is in your recent context. But if you're unsure, it's better to re-read than to stall.
- **Don't repeat identical tool calls** from the immediately preceding response. But trying variations (different patterns, case) is good.
- **Check history efficiently** - scan recent messages, don't obsess over every detail.

**Priority**: Make progress over being perfectly optimal. A slightly redundant tool call that moves you forward is better than paralysis.
```

---

### 2. EXPLORER_PROMPT - Add Explicit Numeric Targets

**Location**: `packages/agent/src/prompts.ts` (lines 18-230)

**Change**: Add concrete numeric guidance to the parallelization section.

**Current section** (Tool Strategy):
```typescript
### Parallel Execution

You can emit MULTIPLE tool calls in a single response. The system executes them concurrently.

- Need 5 files? Call Read 5 times in ONE response—not 5 iterations.
- Unsure which pattern matches? Call Glob with `**/*.ts`, `**/*.js`, `../**/*.ts` simultaneously.
- Searching for a term? Grep with variations in parallel: `className`, `ClassName`, `class_name`.

**Never serialize independent calls.** If call B doesn't depend on call A's result, they belong in the same response.

A 10-call iteration with 2 hits beats a 3-call iteration with 0 hits. The former made progress; the latter wasted a turn.
```

**Proposed replacement**:
```typescript
### Parallel Execution - Be Aggressive

You can emit MULTIPLE tool calls in a single response. The system executes them concurrently.

**Target: 5-10 tool calls per response** when exploring or searching.

- Need 5 files? Call Read 5 times in ONE response—not 5 iterations.
- Unsure which pattern matches? Call Glob with `**/*.ts`, `**/*.js`, `../**/*.ts` simultaneously.
- Searching for a term? Grep with variations in parallel: `className`, `ClassName`, `class_name`.
- Don't know the location? Search multiple directories: `src/**/*`, `lib/**/*`, `app/**/*`, `../packages/**/*`

**Never serialize independent calls.** If call B doesn't depend on call A's result, they belong in the same response.

A 10-call iteration with 2 hits beats a 3-call iteration with 0 hits. The former made progress; the latter wasted a turn.

### Fallback Strategies - When Initial Searches Fail

If your first search returns empty, **don't give up**. Try these in parallel:

1. **Case variations**: `MyClass`, `myClass`, `MYCLASS`, `my_class`
2. **Parent directories**: `../**/pattern`, `../../**/pattern`
3. **Related terms**: If `className` fails, try `type`, `interface`, `struct`
4. **File extensions**: `.ts`, `.js`, `.tsx`, `.jsx`, `.mjs`, `.cjs`
5. **Broader patterns**: `**/utils/**/*` instead of `**/utils/myFile.ts`

**Emit fallback calls in the same response as your initial search**. Don't wait for results to fail before trying alternatives.
```

---

### 3. Tool Schemas - Make Grep More Forgiving

**Location**: `packages/tools/src/tool_schemas.ts` (lines 76-97)

**Change**: Add `caseSensitive` default to `false` for Grep tool.

**Current schema**:
```typescript
export const GrepArgsSchema = z.object({
  pattern: z.string().min(1, 'Pattern cannot be empty'),
  path: z.string().optional(),
  glob: z.string().optional(),
  type: z.string().optional(),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  '-A': z.number().nonnegative().int().optional(),
  '-B': z.number().nonnegative().int().optional(),
  '-C': z.number().nonnegative().int().optional(),
  '-i': z.boolean().optional(),
  '-n': z.boolean().optional(),
  head_limit: z.number().nonnegative().int().optional(),
  offset: z.number().nonnegative().int().optional(),
  multiline: z.boolean().optional(),
  maxResults: z.number().positive().int().optional(),
  caseInsensitive: z.boolean().optional(),
  cwd: z.string().optional(),
});
```

**Proposed change**:
```typescript
export const GrepArgsSchema = z.object({
  pattern: z.string().min(1, 'Pattern cannot be empty'),
  path: z.string().optional(),
  glob: z.string().optional(),
  type: z.string().optional(),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  '-A': z.number().nonnegative().int().optional(),
  '-B': z.number().nonnegative().int().optional(),
  '-C': z.number().nonnegative().int().optional(),
  '-i': z.boolean().optional(),
  '-n': z.boolean().optional(),
  head_limit: z.number().nonnegative().int().optional(),
  offset: z.number().nonnegative().int().optional(),
  multiline: z.boolean().optional(),
  maxResults: z.number().positive().int().optional(),
  caseInsensitive: z.boolean().default(false), // CHANGED: Add default to make tool more forgiving
  cwd: z.string().optional(),
});
```

**Rationale**: By defaulting to case-sensitive, models that get case wrong get zero results and may stall. Defaulting to case-insensitive (or changing the default to `true`) makes the tool more forgiving. However, this might be a platform-level decision - the schema reflects what the underlying tool supports.

**Alternative**: If changing the default is not desired, update the tool descriptions in the tool registry to explicitly mention case-insensitive searching as a strategy.

---

### 4. Tool Descriptions - Add Case-Insensitive Guidance

**Location**: This would be in the tool registration/description file (not in the provided files)

**Proposed addition to Grep tool description**:
```
"Tip: If your search returns no results, try setting caseInsensitive: true to match regardless of case. This is especially helpful when searching for class names, identifiers, or terms where you're unsure of the exact casing."
```

---

## Summary of Changes

| File | Change | Impact |
|------|--------|--------|
| `packages/agent/src/prompts.ts` - STANDARD_PROMPT | Add explicit parallelization targets (5-10 calls) | Reduces hesitation, encourages more tool calls |
| `packages/agent/src/prompts.ts` - STANDARD_PROMPT | Add "When in Doubt, Emit" section | Prevents stalling on uncertainty |
| `packages/agent/src/prompts.ts` - STANDARD_PROMPT | Soften anti-patterns language | Reduces paralysis from fear of mistakes |
| `packages/agent/src/prompts.ts` - EXPLORER_PROMPT | Add numeric targets to parallelization | Explicit guidance for tool call volume |
| `packages/agent/src/prompts.ts` - EXPLORER_PROMPT | Add fallback strategies section | Encourages creative search attempts |
| `packages/tools/src/tool_schemas.ts` | Consider changing Grep default for caseInsensitive | Makes tool more forgiving (optional) |

## Expected Results

1. **Reduced stalling**: Models will emit exploratory tool calls instead of hesitating
2. **More tool calls per response**: 5-10 calls instead of 1-2, increasing hit rate
3. **More creative searching**: Models will try case variations, parent directories, and related terms
4. **Faster goal completion**: Higher hit rate per iteration means fewer total iterations

## Testing Recommendations

1. Test on large repositories with deep directory structures
2. Verify models try multiple search patterns when initial searches fail
3. Monitor average tool calls per response - should increase to 5-10 range
4. Check for reduced stalling on ambiguous search terms
5. Verify fallback strategies are used (case variations, parent dirs)

## Alternative Considerations

If the above changes are insufficient, consider:

1. **Few-shot examples**: Add examples of good parallel tool call sequences in the prompts
2. **Explicit failure recovery**: Add a "recovery mode" section that triggers when searches fail
3. **Tool call budgets**: Explicitly state "you have budget for 150 tool calls, use them aggressively"
4. **Temperature adjustments**: GLM-4.7 may benefit from higher temperature for more creative search strategies