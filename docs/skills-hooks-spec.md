# Skills & Hooks Integration Spec

Minimum patch specification for Claude-style skills and hooks in the harness.

## Overview

**Skills** = modular instruction sets + optional tools that Claude auto-activates based on task context
**Hooks** = lifecycle event handlers that run shell commands or prompt evaluations at specific points

Both are file-based, directory-scoped, and loaded at runtime.

---

## 1. Skills System

### 1.1 Directory Structure

```
config/skills/
├── code-review/
│   ├── SKILL.md           # Required: frontmatter + instructions
│   └── templates/         # Optional: supporting files
│       └── checklist.md
├── api-design/
│   ├── SKILL.md
│   └── openapi-template.yaml
└── my-skill.json          # Alternative: inline JSON definition
```

### 1.2 SKILL.md Format

```yaml
---
name: code-review
description: Performs thorough code review with security and performance analysis
allowed-tools: Read, Grep, Glob
model: inherit                # inherit | sonnet | opus | haiku
enabled: true
tags: [review, quality]
---

## Instructions

When reviewing code, analyze:
1. Security vulnerabilities (OWASP top 10)
2. Performance bottlenecks
3. Code style consistency
...
```

**Frontmatter fields:**
| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | - | Unique identifier |
| `description` | string | yes | - | Trigger phrase for auto-activation |
| `allowed-tools` | string[] | no | all | Tools available during skill execution |
| `model` | string | no | inherit | LLM model override |
| `enabled` | boolean | no | true | Active state |
| `tags` | string[] | no | [] | Categorization |

### 1.3 JSON Alternative

```json
{
  "id": "code-review",
  "name": "Code Review",
  "description": "Performs thorough code review",
  "enabled": true,
  "type": "instructions",
  "tags": ["review"],
  "prompt": "When reviewing code, analyze:\n1. Security...",
  "allowedTools": ["Read", "Grep", "Glob"],
  "model": "inherit"
}
```

### 1.4 Skill Activation

Skills activate via two mechanisms:

1. **Auto-activation** (model-invoked): Agent matches user request against skill descriptions
2. **Explicit invocation**: `/skills run <id>` or mentioning skill name

**Auto-activation flow:**
```
User request → Routing agent scores skill relevance → Load matching skills → Inject into context
```

### 1.5 Skill Runtime

When a skill activates:
1. Load SKILL.md instructions into system prompt
2. Restrict tool access to `allowed-tools` if specified
3. Override model if specified (not `inherit`)
4. Execute until completion or budget exhaustion

---

## 2. Hooks System

### 2.1 Hook Types (Lifecycle Events)

| Event | Trigger Point | Use Cases |
|-------|--------------|-----------|
| `PreToolUse` | Before tool execution | Validation, logging, blocking |
| `PostToolUse` | After tool completes | Linting, formatting, notifications |
| `UserPromptSubmit` | Before processing user input | Input sanitization, routing |
| `Stop` | Agent run completes | Cleanup, reporting |
| `SessionStart` | New session created | Setup, initialization |
| `Notification` | Idle timeout, permission requests | Alerts |

### 2.2 Hook Definition Format

```json
{
  "id": "lint-on-write",
  "name": "Auto-lint on Write",
  "description": "Runs ESLint after file writes",
  "enabled": true,
  "trigger": "PostToolUse",
  "matcher": "Write|Edit",
  "priority": 100,
  "timeout_ms": 10000,
  "fail_open": true,
  "hooks": [
    {
      "type": "command",
      "command": "./scripts/lint.sh \"$TOOL_FILE_PATH\""
    }
  ]
}
```

### 2.3 Hook Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique identifier |
| `name` | string | yes | Display name |
| `description` | string | no | Purpose description |
| `enabled` | boolean | no | Active state (default: true) |
| `trigger` | string | yes | Lifecycle event name |
| `matcher` | string | no | Regex to filter tool names (for *ToolUse events) |
| `priority` | number | no | Execution order (higher = first) |
| `timeout_ms` | number | no | Max execution time |
| `fail_open` | boolean | no | Continue on hook failure (default: true) |
| `hooks` | Hook[] | yes | Actions to execute |

### 2.4 Hook Action Types

**Command Hook** - Runs shell command:
```json
{
  "type": "command",
  "command": "eslint --fix \"$TOOL_FILE_PATH\"",
  "env": { "NODE_ENV": "development" }
}
```

**Prompt Hook** - LLM evaluation:
```json
{
  "type": "prompt",
  "prompt": "Review this file edit for security issues. Block if critical vulnerabilities found.",
  "model": "haiku",
  "decision": "block|allow|modify"
}
```

### 2.5 Environment Variables

Hooks receive context via environment:

| Variable | Description |
|----------|-------------|
| `HOOK_EVENT` | Event type (PreToolUse, PostToolUse, etc.) |
| `TOOL_NAME` | Tool being invoked |
| `TOOL_FILE_PATH` | File path (for file operations) |
| `TOOL_RESULT` | Tool output (PostToolUse only) |
| `SESSION_KEY` | Current session ID |
| `REQUEST_ID` | Current request ID |
| `WORKING_DIR` | Project working directory |

### 2.6 Hook Results

Hooks return JSON to stdout:

```json
{
  "action": "allow",           // allow | block | modify
  "message": "Lint passed",    // Optional feedback
  "modified": { ... }          // For modify: replacement tool params
}
```

Non-JSON output or exit code > 0 = failure (respects `fail_open`).

---

## 3. Gateway API

### 3.1 Skills Commands

| Command | Data | Response |
|---------|------|----------|
| `skills_list` | - | `{ items: SkillStub[], errors: [] }` |
| `skills_get` | `{ id }` | `{ skill: SkillFull }` |
| `skills_create` | `{ skill: SkillInput }` | `{ id, success }` |
| `skills_update` | `{ id, updates }` | `{ success }` |
| `skills_delete` | `{ id }` | `{ success }` |
| `skills_run` | `{ id, input? }` | `{ request_id }` (streams events) |
| `skills_enable` | `{ id }` | `{ success }` |
| `skills_disable` | `{ id }` | `{ success }` |

### 3.2 Hooks Commands

| Command | Data | Response |
|---------|------|----------|
| `hooks_list` | - | `{ items: HookStub[], errors: [] }` |
| `hooks_get` | `{ id }` | `{ hook: HookFull }` |
| `hooks_create` | `{ hook: HookInput }` | `{ id, success }` |
| `hooks_update` | `{ id, updates }` | `{ success }` |
| `hooks_delete` | `{ id }` | `{ success }` |
| `hooks_enable` | `{ id }` | `{ success }` |
| `hooks_disable` | `{ id }` | `{ success }` |
| `hooks_test` | `{ id, mockEvent }` | `{ result }` |

---

## 4. Type Definitions

### 4.1 Skills Types

```typescript
// ============================================
// SKILL TYPES
// ============================================

export interface SkillFrontmatter {
  name: string;
  description: string;
  allowedTools?: string[];
  model?: 'inherit' | 'sonnet' | 'opus' | 'haiku';
  enabled?: boolean;
  tags?: string[];
}

export interface SkillDefinition extends SkillFrontmatter {
  id: string;
  instructions: string;        // Markdown body after frontmatter
  sourcePath: string;          // Absolute path to SKILL.md or .json
  sourceType: 'markdown' | 'json';
}

export interface SkillStub {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  tags: string[];
}

export interface SkillInput {
  name: string;
  description: string;
  instructions: string;
  allowedTools?: string[];
  model?: string;
  tags?: string[];
}
```

### 4.2 Hooks Types

```typescript
// ============================================
// HOOK TYPES
// ============================================

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SessionStart'
  | 'Notification';

export type HookActionType = 'command' | 'prompt';

export interface CommandHook {
  type: 'command';
  command: string;
  env?: Record<string, string>;
}

export interface PromptHook {
  type: 'prompt';
  prompt: string;
  model?: string;
  decision?: 'block' | 'allow' | 'modify';
}

export type HookAction = CommandHook | PromptHook;

export interface HookDefinition {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: HookEvent;
  matcher?: string;            // Regex for tool filtering
  priority: number;
  timeout_ms?: number;
  fail_open?: boolean;
  hooks: HookAction[];
  sourcePath: string;
}

export interface HookStub {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: string;
  priority: number;
}

export interface HookResult {
  action: 'allow' | 'block' | 'modify';
  message?: string;
  modified?: Record<string, unknown>;
}

export interface HookContext {
  event: HookEvent;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  toolResult?: unknown;
  sessionKey: string;
  requestId: string;
  workingDir: string;
}
```

---

## 5. Execution Engine

### 5.1 HookExecutor

```typescript
export class HookExecutor {
  constructor(
    private hooksDir: string,
    private workingDir: string
  ) {}

  /**
   * Execute hooks for a lifecycle event.
   * Returns aggregated result (block if any hook blocks).
   */
  async execute(
    event: HookEvent,
    context: HookContext
  ): Promise<HookResult> {
    const hooks = this.getMatchingHooks(event, context.toolName);

    for (const hook of hooks) {
      if (!hook.enabled) continue;

      const result = await this.runHook(hook, context);

      if (result.action === 'block') {
        return result;  // Short-circuit on block
      }

      if (result.action === 'modify' && result.modified) {
        context.toolParams = result.modified;
      }
    }

    return { action: 'allow' };
  }

  private async runHook(
    hook: HookDefinition,
    context: HookContext
  ): Promise<HookResult> {
    // Runs command or prompt hook with timeout
  }
}
```

### 5.2 SkillManager

```typescript
export class SkillManager {
  constructor(
    private skillsDir: string,
    private workingDir: string
  ) {}

  /**
   * Find skills relevant to the user's request.
   * Returns skills sorted by relevance score.
   */
  async matchSkills(
    userInput: string,
    maxResults: number = 3
  ): Promise<SkillDefinition[]> {
    // Semantic matching against skill descriptions
  }

  /**
   * Load a skill by ID for execution.
   */
  async loadSkill(id: string): Promise<SkillDefinition | null> {
    // Load and parse SKILL.md or JSON
  }

  /**
   * Create a new skill from input.
   */
  async createSkill(input: SkillInput): Promise<string> {
    // Write SKILL.md to skillsDir/{id}/SKILL.md
  }
}
```

---

## 6. Integration Points

### 6.1 Agent Integration

```typescript
// In agent run loop:
async function runAgent(input: string, context: AgentContext) {
  const hookExecutor = new HookExecutor(hooksDir, workingDir);
  const skillManager = new SkillManager(skillsDir, workingDir);

  // 1. UserPromptSubmit hook
  const submitResult = await hookExecutor.execute('UserPromptSubmit', {
    event: 'UserPromptSubmit',
    sessionKey: context.sessionKey,
    requestId: context.requestId,
    workingDir: context.workingDir,
  });

  if (submitResult.action === 'block') {
    return { blocked: true, message: submitResult.message };
  }

  // 2. Auto-activate relevant skills
  const activeSkills = await skillManager.matchSkills(input);
  const skillInstructions = activeSkills
    .map(s => `## Skill: ${s.name}\n${s.instructions}`)
    .join('\n\n');

  // 3. Inject skills into system prompt
  const systemPrompt = baseSystemPrompt + '\n\n' + skillInstructions;

  // 4. Run agent loop with PreToolUse/PostToolUse hooks
  for (const turn of agentLoop) {
    if (turn.type === 'tool_use') {
      const preResult = await hookExecutor.execute('PreToolUse', {
        event: 'PreToolUse',
        toolName: turn.tool,
        toolParams: turn.params,
        ...context,
      });

      if (preResult.action === 'block') {
        // Skip tool, report block
        continue;
      }

      const result = await executeTool(turn.tool, turn.params);

      await hookExecutor.execute('PostToolUse', {
        event: 'PostToolUse',
        toolName: turn.tool,
        toolParams: turn.params,
        toolResult: result,
        ...context,
      });
    }
  }

  // 5. Stop hook
  await hookExecutor.execute('Stop', { ...context, event: 'Stop' });
}
```

### 6.2 TUI Integration

```
/skills                    → List all skills (name, description, enabled status)
/skills new                → Interactive skill creation wizard
/skills edit <id>          → Open skill in editor
/skills run <id>           → Execute skill immediately
/skills enable|disable <id>→ Toggle skill state
/skills delete <id>        → Remove skill

/hooks                     → List all hooks (name, trigger, priority, enabled)
/hooks new                 → Interactive hook creation wizard
/hooks edit <id>           → Open hook in editor
/hooks enable|disable <id> → Toggle hook state
/hooks delete <id>         → Remove hook
/hooks test <id>           → Dry-run hook with mock event
```

---

## 7. Implementation Order

### Phase 1: Core Types & Loading (Done)
- [x] SkillStub, HookStub types
- [x] loadSkillDefinitions(), loadHookDefinitions()
- [x] skills_list, hooks_list gateway commands
- [x] /skills, /hooks TUI commands (list only)

### Phase 2: Full CRUD (Done)
- [x] skills_get, hooks_get (read full definition)
- [x] skills_create, hooks_create (write to filesystem)
- [x] skills_update, hooks_update (modify existing)
- [x] skills_delete, hooks_delete (remove files)
- [x] skills_enable/disable, hooks_enable/disable (toggle state)
- [x] TUI commands are read-only; agent uses gateway commands for CRUD

### Phase 3: Execution Engine (Done)
- [x] HookExecutor class with command execution
- [x] Hook environment variable injection
- [x] Hook result parsing
- [x] UserPromptSubmit/Stop integration in harness
- [x] PreToolUse/PostToolUse integration via AgentHooks callback injection

### Phase 4: Skills Runtime (Deferred)
Skills are instructions injected into prompts, not executable units.
- [ ] SkillManager with semantic matching
- [ ] Skill auto-activation in routing agent
- [ ] /skills run <id> explicit invocation
- [ ] Tool restriction during skill execution

### Phase 5: Advanced Features (Deferred)
- [ ] Prompt hooks (LLM-based evaluation)
- [ ] Skill hooks (scoped to skill execution)
- [ ] Hook chaining and dependencies
- [ ] Metrics and logging

---

## 8. File Changes Summary

| File | Changes |
|------|---------|
| `skills_loader.ts` | Full SkillDefinition/HookDefinition types, CRUD operations |
| `hook_executor.ts` | Hook execution engine with command/env support |
| `bridge_gateway.ts` | All skills_*/hooks_* CRUD command handlers |
| `harness.ts` | HookExecutor integration, AgentHooks for PreToolUse/PostToolUse |
| `agent-core/agent/types.ts` | AgentHooks, ToolHookResult interfaces |
| `agent-core/agent/agent.ts` | Hooks param, pre/post hook calls in processToolCalls |
| `agent-core/orchestrator/orchestrator.ts` | Hooks param passed to Agent creation |
| `apps/tui/commands.ts` | Help text with skill/hook subcommands (read-only TUI) |

---

## 9. Example Configurations

### Example Skill: Code Review

```
config/skills/code-review/SKILL.md
```

```yaml
---
name: code-review
description: Thorough code review with security and performance analysis
allowed-tools: Read, Grep, Glob
tags: [review, security, quality]
---

## Code Review Protocol

When reviewing code changes:

1. **Security Analysis**
   - Check for injection vulnerabilities (SQL, XSS, command injection)
   - Validate input sanitization at boundaries
   - Review authentication/authorization logic

2. **Performance Review**
   - Identify N+1 queries
   - Check for unnecessary iterations
   - Review memory allocation patterns

3. **Code Quality**
   - Verify naming conventions
   - Check for dead code
   - Ensure proper error handling

Output a structured review with severity ratings.
```

### Example Hook: Lint on Write

```json
// config/hooks/lint-on-write.json
{
  "id": "lint-on-write",
  "name": "Auto-lint on Write",
  "description": "Runs ESLint and Prettier after file writes",
  "enabled": true,
  "trigger": "PostToolUse",
  "matcher": "Write|Edit",
  "priority": 100,
  "timeout_ms": 30000,
  "fail_open": true,
  "hooks": [
    {
      "type": "command",
      "command": "npx eslint --fix \"$TOOL_FILE_PATH\" 2>/dev/null || true"
    },
    {
      "type": "command",
      "command": "npx prettier --write \"$TOOL_FILE_PATH\" 2>/dev/null || true"
    }
  ]
}
```

### Example Hook: Block Secrets

```json
// config/hooks/block-secrets.json
{
  "id": "block-secrets",
  "name": "Block Secret Commits",
  "description": "Prevents committing files containing secrets",
  "enabled": true,
  "trigger": "PreToolUse",
  "matcher": "Write|Edit",
  "priority": 200,
  "timeout_ms": 5000,
  "fail_open": false,
  "hooks": [
    {
      "type": "command",
      "command": "! grep -qE '(api[_-]?key|secret|password|token)\\s*[:=]\\s*[\"'\\']?[a-zA-Z0-9]' \"$TOOL_FILE_PATH\" 2>/dev/null"
    }
  ]
}
```
