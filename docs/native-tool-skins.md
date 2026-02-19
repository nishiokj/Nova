# Native Tool Skins

## Problem

LLMs perform best when tool definitions match their training distribution. Claude was fine-tuned on Anthropic's `tool_use`/`tool_result` content blocks with specific tool names and descriptions (Edit, Read, Bash, etc.). OpenAI models (GPT-4.1, o3, o4-mini) were fine-tuned on the Responses API format with Codex-native tools (apply_patch, shell_command, read_file, etc.).

Sending an OpenAI model Claude-style tool definitions doesn't error — it silently degrades tool selection accuracy, argument quality, and multi-step planning. The model works, just worse. This is the hardest performance bug to diagnose because there's no stack trace, just slightly dumber behavior.

## Approach

Per-provider tool "skins" — present each model with the exact tool names, descriptions, and schemas it was trained on, but execute everything against Rex's shared tool implementations.

The only tool that requires new implementation is `apply_patch`. Everything else is argument renaming in the provider's `formatTools()` path.

## Tool Mappings

### 1:1 Mappings (argument translation only)

#### Bash → shell_command

Rex definition:
```
Bash(command: string, timeout?: number)
```

Codex-native definition:
```
shell_command(command: string, workdir?: string, login?: boolean, timeout_ms?: number)
```

Translation:
- `command` → `command` (identity)
- `timeout` (seconds) → `timeout_ms` (milliseconds), multiply by 1000
- `workdir` — inject from session working directory if not provided by model
- `login` — default true, pass through

Codex description (verbatim):
```
"Runs a shell command and returns its output.
- Always set the `workdir` param when using the shell_command function.
  Do not use `cd` unless absolutely necessary."
```

Executor: existing `executeBash`

#### Read → read_file

Rex definition:
```
Read(path: string, encoding?: string, maxBytes?: number, startLine?: number, endLine?: number)
```

Codex-native definition:
```
read_file(file_path: string, offset?: number, limit?: number, mode?: string)
```

Translation:
- `file_path` → `path`
- `offset` → `startLine`
- `limit` → compute `endLine = startLine + limit - 1`
- `mode: "indentation"` — not supported, ignore (return slice anyway)

Codex description (verbatim):
```
"Reads a local file with 1-indexed line numbers, supporting slice and
indentation-aware block modes."
```

Executor: existing `executeRead`

#### Grep → grep_files

Rex definition:
```
Grep(pattern: string, path?: string, glob?: string, type?: string, maxResults?: number, caseSensitive?: boolean)
```

Codex-native definition:
```
grep_files(pattern: string, include?: string, path?: string, limit?: number)
```

Translation:
- `pattern` → `pattern` (identity)
- `include` → `glob`
- `path` → `path` (identity)
- `limit` → `maxResults`

Codex description (verbatim):
```
"Finds files whose contents match the pattern and lists them by
modification time."
```

Executor: existing `executeGrep`

#### Glob → list_dir

Rex definition:
```
Glob(pattern: string, maxResults?: number, maxDepth?: number, includeHidden?: boolean)
```

Codex-native definition:
```
list_dir(dir_path: string, offset?: number, limit?: number, depth?: number)
```

Translation:
- `dir_path` → use as base path, combine with glob `**/*`
- `limit` → `maxResults`
- `depth` → `maxDepth`

Codex description (verbatim):
```
"Lists entries in a local directory with 1-indexed entry numbers and
simple type labels."
```

Executor: existing `executeGlob`, but output format should match Codex's (numbered entries with type labels, not just paths).

#### WebSearch → web_search (built-in)

For OpenAI models, expose as a first-class Responses API tool type:
```json
{ "type": "web_search", "external_web_access": true }
```

No schema needed — the model knows this tool natively. Results come back as `web_search_call` items in the response.

Executor: existing `executeWebSearch`, but invocation path differs (built-in tool type, not function call).

#### PromptUser → request_user_input

Rex definition:
```
PromptUser(question: string, options?: array, context?: string, ...)
```

Codex-native definition:
```
request_user_input(questions: array of {id, header, question, options[]})
```

Translation:
- Codex bundles multiple questions in one call
- Each question has `id` (snake_case identifier), `header` (12 char label), `question`, `options[]`
- Map first question to Rex's `question` + `options`

Codex description (from function, dynamically built):
```
"Present the user with one or more structured questions, each with a
short header and 2-3 mutually exclusive options."
```

Executor: existing `executePromptUser`

### No Codex Equivalent (Rex-only tools)

These tools have no Codex counterpart. When using OpenAI models, expose them as generic function tools with current Rex descriptions:

- **WebFetch** — keep as-is
- **ExpandConversation** — keep as-is

### No Rex Equivalent (Codex-only, not needed)

These Codex tools have no Rex counterpart and are not needed:

- **exec_command / write_stdin** — PTY-based interactive sessions. Rex uses Bash.
- **view_image** — Rex handles images through Read.
- **js_repl / js_repl_reset** — Codex-specific JS REPL. Not needed.
- **spawn_agent / send_input / wait / close_agent / resume_agent** — Codex multi-agent orchestration. Rex has its own orchestrator.
- **list_mcp_resources / read_mcp_resource** — Codex MCP. Rex has its own MCP integration (if any).

## apply_patch Implementation

### Overview

`apply_patch` is the only tool that requires new code. It replaces Edit, Write, and BatchEdit for OpenAI models. The model emits a freeform text patch (not JSON), and we parse + apply it.

### Tool Definition

Freeform variant (for models that support it — GPT-4.1, o3, o4-mini):
```json
{
  "type": "custom",
  "name": "apply_patch",
  "description": "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
  "format": {
    "type": "grammar",
    "syntax": "lark",
    "definition": "<lark grammar>"
  }
}
```

JSON fallback (for models that don't support freeform):
```json
{
  "type": "function",
  "name": "apply_patch",
  "description": "Use the `apply_patch` tool to edit files. ...<full grammar docs>...",
  "parameters": {
    "type": "object",
    "properties": {
      "input": { "type": "string", "description": "The entire contents of the apply_patch command" }
    },
    "required": ["input"]
  }
}
```

### Patch Format

```
*** Begin Patch
*** Add File: <relative-path>
+<line1>
+<line2>

*** Delete File: <relative-path>

*** Update File: <relative-path>
[*** Move to: <new-path>]
@@ [optional context header]
 <context line>
-<removed line>
+<added line>
 <context line>

*** End Patch
```

### Parser Spec

State machine with these states:

```
IDLE → BEGIN_PATCH (on "*** Begin Patch")
BEGIN_PATCH → FILE_OP_HEADER (on "*** Add File:" | "*** Delete File:" | "*** Update File:")
FILE_OP_HEADER → HUNK_HEADER (on "@@") | FILE_OP_HEADER (on next "***") | END (on "*** End Patch")
HUNK_HEADER → HUNK_BODY (on " " | "+" | "-" prefix)
HUNK_BODY → HUNK_HEADER (on "@@") | FILE_OP_HEADER (on "***") | END (on "*** End Patch")
```

Output: array of `PatchOperation`:
```typescript
type PatchOperation =
  | { type: 'add'; path: string; content: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; moveTo?: string; hunks: Hunk[] }

interface Hunk {
  contextHeader?: string;    // class/function name from @@ line
  lines: HunkLine[];
}

interface HunkLine {
  type: 'context' | 'add' | 'remove';
  content: string;
}
```

### Hunk Application Algorithm

For each `update` operation:

1. Read the target file into lines
2. For each hunk:
   a. Collect context lines (` ` prefix) and remove lines (`-` prefix) into a "search pattern"
   b. If `contextHeader` exists, narrow search scope to lines matching that header
   c. Find the unique location in the file where the search pattern matches
   d. Apply the hunk: remove `-` lines, insert `+` lines, keep ` ` lines
3. Write the modified file atomically (tmp + rename)

Context matching must be exact (whitespace-sensitive). If a hunk can't be uniquely located, return an error to the model.

### File Operations

- **Add**: Write new file. Fail if file already exists. Content is all `+` lines concatenated.
- **Delete**: Remove file. Fail if file doesn't exist.
- **Update**: Apply hunks to existing file. Fail if file doesn't exist.
- **Move**: Read old file, apply hunks, write to new path, delete old file.

### Atomicity

All operations in a single patch are validated before any are applied. If any operation would fail (file not found, ambiguous hunk match, etc.), none are applied. Error message returned to model describes which operation failed and why.

## Type System Changes

### ToolDefinition

Current:
```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameterSchema>;
    required: string[];
    additionalProperties?: boolean;
  };
  strict?: boolean;
}
```

Add a discriminated union for freeform tools:
```typescript
type ToolDefinition = FunctionToolDefinition | FreeformToolDefinition;

interface FunctionToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameterSchema>;
    required: string[];
    additionalProperties?: boolean;
  };
  strict?: boolean;
}

interface FreeformToolDefinition {
  type: 'custom';
  name: string;
  description: string;
  format: {
    type: 'grammar';
    syntax: string;
    definition: string;
  };
}
```

### ToolCall

Current tool calls carry parsed `arguments: Record<string, unknown>`. Freeform tool calls carry raw text:

```typescript
type ToolCallPayload =
  | { type: 'function'; arguments: Record<string, unknown> }
  | { type: 'custom'; input: string }
```

### Context Window Items

Add `custom_tool_call` and `custom_tool_call_output` to the `function_call` / `function_call_output` item types, or extend existing types with an optional `input: string` field for freeform payloads.

## Provider Changes

### OpenAI Provider

`formatTools()`:
- Map Rex tool definitions to Codex-native definitions using the skin mappings above
- Emit `{ type: "custom", ... }` for `apply_patch`
- Emit `{ type: "web_search", ... }` for WebSearch
- Emit `{ type: "function", ... }` with Codex names/descriptions for everything else

`parseToolCalls()`:
- Handle `custom_tool_call` response items (raw text payload, not JSON arguments)
- Translate Codex tool names back to Rex tool names for executor dispatch
- Translate Codex arguments to Rex argument shapes

### Anthropic Provider

No changes. Continue using current Rex tool definitions with Claude-native names and descriptions.

## Implementation Order

1. **apply_patch parser + executor** — new file in `packages/core/tools/src/builtins/apply_patch.ts`. Pure function: string → PatchOperation[]. Plus executor that applies operations to filesystem.
2. **Type system** — extend `ToolDefinition` to support freeform tools, extend `ToolCall` for custom payloads.
3. **OpenAI provider skin** — modify `formatTools()` to emit Codex-native definitions. Modify `parseToolCalls()` to handle custom tool calls and translate arguments.
4. **Conditional tool registration** — when provider is OpenAI, register `apply_patch` instead of Edit/Write/BatchEdit. Register shell_command/read_file/grep_files skins instead of Bash/Read/Grep.
5. **Tests** — patch parser unit tests (add, delete, update, move, multi-file, ambiguous hunk error). Integration test: OpenAI model call with native tools → correct executor dispatch.
