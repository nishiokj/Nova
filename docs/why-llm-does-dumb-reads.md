# Why LLM Does Full Read Then Partial Read (The "Moron" Problem)

## The Issue

LLM sequence:
1. `Read(path="file.ts")` → Gets full 200-line file
2. `Read(path="file.ts", startLine=1, endLine=50)` → Gets lines 1-50 (which are already in the first read!)

This is completely redundant. The partial read is a subset of the full read. Makes zero sense.

## Root Causes

### 1. Tool Description Confusion

```typescript
// read.ts:16
description: 'Read any file in the working directory. Supports line-range reads for surgical file access when you already know the target location.',
```

The LLM reads this as:
- "Surgical file access" = fancy/proper way to read
- "When you already know the target location" = you should do this when you're being precise

So it might think:
- "I read the full file, but now I want to be precise about lines 1-50"
- "I should do a 'surgical read' to show I know what I'm doing"

### 2. Prompt Instruction Confusion

```typescript
// prompts.ts:284-285
Only use Read directly when you need the FULL content for an edit you're about to make.
```

The LLM reads this as:
- "If I'm NOT about to edit, I shouldn't use full Read"
- "I should use partial reads for non-edit purposes"

So it might:
1. Read full file to understand it
2. Decide "I'm not editing right now, I'm just analyzing"
3. Call partial read to "be correct" according to the prompt

### 3. Output Header Confusion

When you do a partial read, the output includes:
```
// Lines 1-50 of 200 total
[content...]
```

The LLM might think:
- "Oh, this gives me metadata about line numbers!"
- "I should do partial reads to get line counts"
- "The full read doesn't tell me how many lines there are"

### 4. The LLM is Just Confused About Its Own Context

GLM-4.7 (and other models) sometimes:
- Don't realize the full read is still in their context
- Think partial reads are a "different kind of read"
- Don't understand that `Read()` without args = full file

## The Fixes

### Fix 1: Clarify Tool Description

**Current:**
```typescript
description: 'Read any file in the working directory. Supports line-range reads for surgical file access when you already know the target location.',
```

**Better:**
```typescript
description: 'Read any file in the working directory. By default reads the entire file. Use startLine/endLine ONLY when you want a specific range and ALREADY know the full file is too large or you only need a section. Do NOT use line ranges after already reading the full file.',
```

### Fix 2: Fix the Prompt Instruction

**Current:**
```typescript
Only use Read directly when you need the FULL content for an edit you're about to make.
```

**Better:**
```typescript
Only use Read directly when you need the FULL content (e.g., for edits or deep understanding).

Use startLine/endLine for surgical reads when:
- You already know the exact line range you need
- The file is very large (>1000 lines) and you don't need all of it
- You've already read the file and only need to re-check a specific section

Never read the same file with different arguments. If you already read the full file, you have all the content you need.
```

### Fix 3: Add a Warning to the Read Tool

Add this to the Read tool output when it detects a redundant read:

```typescript
// In executeRead, after checking if file was already read
if (localReadFiles.has(path) && !startLine && !endLine) {
  // This is a re-read of the full file
  // Add warning to output
  content = `[WARNING: File ${path} was already read in this session. This read may be redundant.]\n\n${content}`;
}
```

### Fix 4: Detect and Block Redundant Reads

In `agent.ts`, before executing a Read tool call:

```typescript
// In processToolCalls, for Read calls
if (nameLower === 'read' && call.arguments.path) {
  const path = String(call.arguments.path);
  const startLine = call.arguments.startLine;
  const endLine = call.arguments.endLine;

  // Check if this is redundant
  if (localReadFiles.has(path)) {
    // File was already read
    if (!startLine && !endLine) {
      // Re-reading full file - warn and maybe skip
      const toolResult = errorResult('Read', `File ${path} was already read in this session. Re-reading is unnecessary.`, 0);
      // ... handle error
      continue;
    }
    // Partial read after full read - warn
    const toolResult = errorResult('Read', `File ${path} was already read in full. Partial read is redundant since you already have the content.`, 0);
    // ... handle error
    continue;
  }
}
```

## Summary

The LLM is confused because:
1. Tool description makes partial reads sound like a "proper" way to read
2. Prompt instructions make it think partial reads are for non-edit purposes
3. It doesn't understand that full read = all partial reads combined
4. No mechanism prevents redundant reads

The fix is a combination of:
- Clearer tool descriptions
- Better prompt instructions
- Runtime detection and blocking of redundant reads
- Warning messages when redundant reads are attempted