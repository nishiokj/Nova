# Disk-Based ContextWindow Implementation Spec

Externalize the context window to disk as a markdown file for observability, memory efficiency, and multi-process access.

## Motivation

- **Memory**: 10 sessions × 400KB context = 4GB RAM. Disk-based keeps memory constant.
- **Observability**: `tail -f context.md`, grep patterns, diff between turns.
- **Multi-process**: Watcher and other tools can read context without IPC.
- **Crash resilience**: Context survives process death.
- **Tool reuse**: Agents can Read/Grep their own history with existing tools.

## Interface

```typescript
interface ContextWindow {
  /** Append a message to the context */
  append(role: 'user' | 'assistant' | 'system', content: string): void;

  /** Read all messages as structured data */
  read(): Message[];

  /** Render full context as string for LLM prompt */
  render(): string;

  /** Get file path for external readers */
  path(): string;

  /** Clear context (new session or post-compaction) */
  clear(): void;

  /** Current message count */
  length(): number;
}

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}
```

## File Format

```markdown
---
session: abc123
created: 2024-01-15T10:30:00Z
---

### system
You are a helpful assistant...

---

### user
What is X?

---

### assistant
X is...

---

### user
Follow up question...

---
```

**Rationale:**
- YAML frontmatter for metadata (standard, parseable)
- `---` delimiters between messages (grep-friendly, unambiguous)
- `### role` headers (parseable, human-readable)
- No escaping needed - content is literal
- Cheaper to parse than JSONL (string ops vs JSON.parse per line)

## File Location

```typescript
// Follows existing session-paths pattern
function contextPath(workingDir: string, sessionId: string, date?: Date): string {
  return path.join(sessionDir(workingDir, sessionId, date), 'context.md');
}
```

Lives alongside existing session artifacts:
```
.haiku/sessions/2024-01-15/abc123/
├── context.md          ← NEW
├── decisions.jsonl
├── work.log
├── salience.md
└── workitems/
```

## Implementation

```typescript
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import path from 'path';

class DiskContextWindow implements ContextWindow {
  private filePath: string;
  private sessionId: string;
  private created: string;

  constructor(workingDir: string, sessionId: string, date?: Date) {
    this.filePath = contextPath(workingDir, sessionId, date);
    this.sessionId = sessionId;
    this.created = (date ?? new Date()).toISOString();

    // Ensure directory exists
    mkdirSync(path.dirname(this.filePath), { recursive: true });

    // Initialize file if doesn't exist
    if (!existsSync(this.filePath)) {
      this.writeFile(this.renderFrontmatter());
    }
  }

  append(role: 'user' | 'assistant' | 'system', content: string): void {
    const current = this.readFile();
    const message = `\n### ${role}\n${content}\n\n---\n`;
    this.writeFile(current + message);
  }

  read(): Message[] {
    const raw = this.readFile();
    return this.parse(raw);
  }

  render(): string {
    // Return content without frontmatter for LLM
    const raw = this.readFile();
    const bodyStart = raw.indexOf('---', 4) + 4; // Skip frontmatter
    return raw.slice(bodyStart).trim();
  }

  path(): string {
    return this.filePath;
  }

  clear(): void {
    this.writeFile(this.renderFrontmatter());
  }

  length(): number {
    return this.read().length;
  }

  // --- Private ---

  private readFile(): string {
    return existsSync(this.filePath)
      ? readFileSync(this.filePath, 'utf-8')
      : this.renderFrontmatter();
  }

  private writeFile(content: string): void {
    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, this.filePath);  // Atomic
  }

  private renderFrontmatter(): string {
    return `---
session: ${this.sessionId}
created: ${this.created}
---
`;
  }

  private parse(raw: string): Message[] {
    const messages: Message[] = [];
    const blocks = raw.split(/\n---\n/).slice(1); // Skip frontmatter

    for (const block of blocks) {
      const match = block.match(/^### (user|assistant|system)\n([\s\S]*)/);
      if (match) {
        messages.push({
          role: match[1] as Message['role'],
          content: match[2].trim(),
        });
      }
    }
    return messages;
  }
}
```

## Concurrency Model

**Single-writer, multi-reader:**
- Writer: Agent/Harness (atomic writes via `.tmp` → `rename`)
- Readers: Watcher, dashboard, debug tools (read-only)

No locks needed. `rename()` is atomic on POSIX. Readers never see partial state.

**I/O considerations:**
- Native `fs` APIs = no child processes
- Agent tool calls (Read, Grep) = child processes (acceptable, infrequent)
- Watcher auto-injection uses native APIs (hot path, no child processes)

## Integration Points

### 1. SessionState owns ContextWindow

```typescript
// session_state.ts
interface SessionStateData {
  // ... existing fields
  contextWindow: ContextWindow;
}

function createInitialState(workingDir: string, sessionId: string): SessionStateData {
  return {
    // ... existing
    contextWindow: new DiskContextWindow(workingDir, sessionId),
  };
}
```

### 2. Agent uses context before LLM call

```typescript
// agent.ts (or wherever LLM calls happen)
const prompt = state.contextWindow.render();
const response = await llm.complete(prompt);
state.contextWindow.append('assistant', response);
```

### 3. Watcher reads context via path

```typescript
// watcher-agent.ts - context path injected into watcher prompt
const contextFile = state.contextWindow.path();
// Watcher can Read(contextFile) using standard Read tool when needed
```

### 4. Session paths export

```typescript
// session-paths.ts - add to existing exports
export function contextPath(workingDir: string, sessionId: string, date?: Date): string {
  return path.join(sessionDir(workingDir, sessionId, date), 'context.md');
}
```

## Compaction

When `/compact` runs:

```typescript
async function compact(contextWindow: ContextWindow): Promise<void> {
  const current = contextWindow.read();
  const summary = await summarize(current);

  contextWindow.clear();
  contextWindow.append('system', `Previous conversation summary:\n${summary}`);
}
```

1. Summarizer reads `context.md` via Read tool (or native for hot path)
2. Generates summary
3. Calls `contextWindow.clear()`
4. Appends system message with summary

## Migration

1. Add `contextWindow` to SessionStateData
2. On session init, create DiskContextWindow
3. Existing message handling calls `contextWindow.append()`
4. LLM call sites use `contextWindow.render()`
5. Remove in-memory message arrays

No data migration needed - new sessions use new format, old sessions unaffected.

## Open Questions

1. **Timestamps per-message?** Currently only in frontmatter. Per-message adds observability but increases file size.
2. **Additional frontmatter metadata?** Model ID, working directory, agent type?
3. **Current message array location?** Need to identify where in-memory messages currently live for removal.
