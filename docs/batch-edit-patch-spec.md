# Batch Edit Patch Spec

**Problem**: Agent makes too many iterations, often one edit per turn. This burns tokens and creates fragile edit chains.

**Solution**: Minimal two-part patch:
1. **BatchEdit tool** - Accept multiple edits in one call
2. **Prompt amendment** - Encourage edit planning before execution

---

## Part 1: BatchEdit Tool

Add to `packages/agent-core/src/tools/builtins/write.ts`:

### Interface

```typescript
interface EditOperation {
  path: string;           // File path (relative to cwd or absolute)
  oldString: string;      // Exact string to find
  newString: string;      // Replacement string
  replaceAll?: boolean;   // Replace all occurrences (default: false)
}

interface BatchEditArgs {
  cwd: string;
  edits: EditOperation[];
}
```

### Semantics

- **Atomic execution**: All edits succeed or all fail (rollback on error)
- **Order preserved**: Edits applied in array order (allows chained edits in same file)
- **Per-edit validation**: Each edit must pass uniqueness check before any are applied
- **Cross-file support**: Edits can span multiple files

### Execution Flow

```
1. Validate all edits (file exists, oldString found, uniqueness)
2. If any validation fails → return error, apply nothing
3. Apply all edits atomically
4. Return summary: { filesModified, totalReplacements, edits: [...] }
```

### Tool Registration

```typescript
export const batchEditToolOptions: ToolRegistrationOptions = {
  name: 'BatchEdit',
  description: 'Apply multiple edits atomically. Plan all changes, execute in one call.',
  parameters: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: 'Working directory to resolve relative paths against',
      },
      edits: {
        type: 'array',
        description: 'Array of edit operations to apply atomically',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            oldString: { type: 'string', description: 'Exact string to find' },
            newString: { type: 'string', description: 'Replacement string' },
            replaceAll: { type: 'boolean', description: 'Replace all occurrences' },
          },
          required: ['path', 'oldString', 'newString'],
        },
      },
    },
    required: ['cwd', 'edits'],
  },
  required: ['cwd', 'edits'],
  executor: executeBatchEdit,
  timeoutMs: 30000,
  readOnly: false,
  parallelizable: false,
  costHint: 'standard',
};
```

### Error Response Format

```typescript
// Validation failure (no edits applied)
{
  success: false,
  error: "Validation failed",
  details: [
    { index: 0, path: "src/foo.ts", error: "oldString not found" },
    { index: 2, path: "src/bar.ts", error: "oldString found 3 times - not unique" }
  ]
}

// Success
{
  success: true,
  filesModified: 2,
  totalReplacements: 5,
  edits: [
    { path: "src/foo.ts", replacements: 1 },
    { path: "src/bar.ts", replacements: 4 }
  ]
}
```

---

## Part 2: Prompt Amendment

Add to `STANDARD_PROMPT` and `CODING_AGENT_PROMPT` in `prompts.ts`:

### Insert After "Tool Strategy" Section

```markdown
## Edit Strategy

**Plan before you edit.** Before making file changes:

1. **Read all files** you intend to modify
2. **List your edits** mentally: what changes, in which files, in what order
3. **Execute in batches**: Use BatchEdit for multiple changes, Edit for single surgical fixes

### When to use which tool:

| Scenario | Tool | Why |
|----------|------|-----|
| Single targeted fix | Edit | Minimal, surgical |
| Multiple changes to one file | BatchEdit | Atomic, one iteration |
| Changes across multiple files | BatchEdit | Atomic, coordinated |
| Large block replacement | Edit with bigger oldString | Capture sufficient context |
| Wholesale file rewrite | Write (after Read) | When structure changes completely |

### Anti-patterns to avoid:

- ❌ One edit per iteration (burns tokens, fragile)
- ❌ Tiny oldString matches (whitespace-fragile, non-unique)
- ❌ Editing without reading first (blind changes fail)
- ❌ Sequential single-file edits that could be batched

### Good patterns:

- ✅ Read → Plan all changes → BatchEdit in one call
- ✅ Include 2-3 lines of context in oldString for uniqueness
- ✅ Group related changes (rename + update references = one BatchEdit)
```

---

## Part 3: Registration

Update `packages/agent-core/src/tools/builtins/index.ts`:

```typescript
// Write & Edit
export {
  executeWrite,
  executeEdit,
  executeBatchEdit,  // ADD
  writeToolOptions,
  editToolOptions,
  batchEditToolOptions,  // ADD
} from './write.js';

// In builtinToolOptions array:
export const builtinToolOptions = [
  bashToolOptions,
  readToolOptions,
  writeToolOptions,
  editToolOptions,
  batchEditToolOptions,  // ADD
  grepToolOptions,
  globToolOptions,
];
```

Update `packages/agent-core/src/tools/types.ts`:

```typescript
// In DEFAULT_TOOL_CONFIG.enabledTools:
enabledTools: ['Read', 'Write', 'Edit', 'BatchEdit', 'Bash', 'Glob', 'Grep'],
```

---

## Implementation Notes

### Rollback Strategy

For atomicity, two approaches:

**Option A: In-memory validation (simpler)**
```typescript
// 1. Read all files into memory
// 2. Validate all edits against in-memory content
// 3. If all valid, write all files
// 4. If any write fails, restore from backup (best-effort)
```

**Option B: Temp file staging (safer)**
```typescript
// 1. For each file, create .tmp version with edits applied
// 2. Validate all .tmp files exist and are correct
// 3. Atomic rename all .tmp → original
// 4. If any rename fails, restore from .bak files
```

Recommend Option A for simplicity. True atomic cross-file writes require filesystem transactions (not available on most systems).

### Uniqueness Validation

Validate ALL edits before applying ANY:

```typescript
async function validateEdits(edits: EditOperation[], cwd: string): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  const fileContents = new Map<string, string>();

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const path = resolve(cwd, edit.path);

    // Cache file reads
    if (!fileContents.has(path)) {
      try {
        fileContents.set(path, await readFile(path, 'utf-8'));
      } catch (e) {
        results.push({ index: i, path: edit.path, error: 'File not found' });
        continue;
      }
    }

    const content = fileContents.get(path)!;
    const count = countOccurrences(content, edit.oldString);

    if (count === 0) {
      results.push({ index: i, path: edit.path, error: 'oldString not found' });
    } else if (count > 1 && !edit.replaceAll) {
      results.push({ index: i, path: edit.path, error: `oldString found ${count} times - not unique` });
    }
  }

  return results;
}
```

### Chained Edits in Same File

When multiple edits target the same file, apply in order with updated content:

```typescript
// Group edits by file
const editsByFile = groupBy(edits, e => resolve(cwd, e.path));

for (const [path, fileEdits] of editsByFile) {
  let content = await readFile(path, 'utf-8');

  for (const edit of fileEdits) {
    // Each edit sees the result of previous edits
    content = applyEdit(content, edit);
  }

  await writeFile(path, content);
}
```

---

## Success Metrics

After implementation, measure:

1. **Edits per iteration**: Should increase from ~1 to 3-5
2. **Iterations per task**: Should decrease
3. **Edit failure rate**: Should stay same or decrease (atomicity catches errors early)

---

## Files to Modify

| File | Change |
|------|--------|
| `packages/agent-core/src/tools/builtins/write.ts` | Add `executeBatchEdit` and `batchEditToolOptions` |
| `packages/agent-core/src/tools/builtins/index.ts` | Export new tool |
| `packages/agent-core/src/tools/types.ts` | Add to `enabledTools` |
| `packages/agent-core/src/agent/prompts.ts` | Add Edit Strategy section to STANDARD_PROMPT and CODING_AGENT_PROMPT |

**Total LOC**: ~150 for tool, ~30 for prompt changes
