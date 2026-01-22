# Permission System Specification

## Overview

Default-deny permission system for agent tool execution. Only `Bash`, `Write`, and `Edit` tools require permission. Users can:
- **Allow** - one-time approval
- **Always allow [pattern] for this folder** - persistent rule
- **Deny** - block the action

A `--dangerous` CLI flag bypasses all permission checks.

---

## 1. Permission Rules Schema

### Storage Location (Claude Code-style hierarchy)

```
~/.jesus/settings.json                    # User-level (global defaults)
.jesus/settings.json                      # Project-level (team-shared)
.jesus/settings.local.json                # Local overrides (gitignored)
```

**Evaluation priority** (highest to lowest):
1. `--dangerous` flag (bypasses everything)
2. Session-level grants (in-memory, from "Allow" clicks)
3. `.jesus/settings.local.json`
4. `.jesus/settings.json`
5. `~/.jesus/settings.json`

### Schema

```typescript
// packages/types/src/permissions.ts

interface PermissionSettings {
  permissions: {
    allow: string[];  // Patterns that auto-approve
    deny: string[];   // Patterns that auto-reject (takes precedence over allow)
  };
}

// Pattern syntax:
// "Bash(npm *)"       - Bash commands starting with "npm "
// "Bash(git push *)"  - Bash commands starting with "git push "
// "Write(*.ts)"       - Write to any .ts file
// "Write(src/**)"     - Write to anything in src/
// "Edit(*.json)"      - Edit any .json file
// "*"                 - Match all (use in deny to block everything)
```

### Pattern Matching Rules

| Pattern | Matches |
|---------|---------|
| `Bash(npm *)` | `npm install`, `npm run build`, etc. |
| `Bash(git commit *)` | `git commit -m "msg"`, etc. |
| `Write(*.ts)` | `foo.ts`, `src/bar.ts` (glob on filename) |
| `Write(src/**)` | Any file under `src/` recursively |
| `Edit(package.json)` | Exact file match |

**Bash pattern extraction**: First two words of command.
```
"npm install lodash"     → pattern key: "npm install"
"git push origin main"   → pattern key: "git push"
"rm -rf node_modules"    → pattern key: "rm -rf"
"cat foo.txt"            → pattern key: "cat foo.txt" (if only 2 words)
```

### Example settings.json

```json
{
  "permissions": {
    "allow": [
      "Bash(npm *)",
      "Bash(git *)",
      "Bash(pnpm *)",
      "Bash(yarn *)",
      "Write(src/**)",
      "Edit(src/**)"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Bash(sudo *)",
      "Write(.env*)",
      "Edit(.env*)"
    ]
  }
}
```

---

## 2. Data Structures

### Runtime Permission State

```typescript
// packages/types/src/permissions.ts

interface PermissionRule {
  tool: 'Bash' | 'Write' | 'Edit';
  pattern: string;  // glob pattern
}

interface PermissionConfig {
  allow: PermissionRule[];
  deny: PermissionRule[];
}

interface SessionPermissionState {
  // Loaded from config files
  persistent: PermissionConfig;

  // Granted during this session via "Allow" (not "Always allow")
  sessionGrants: PermissionRule[];

  // Denied during this session (user clicked Deny)
  sessionDenials: PermissionRule[];

  // --dangerous mode
  dangerousMode: boolean;
}

// Permission check result
type PermissionDecision =
  | { granted: true; reason: 'dangerous_mode' | 'allow_rule' | 'session_grant' }
  | { granted: false; reason: 'deny_rule' | 'session_denial' | 'path_traversal' }
  | { granted: 'ask'; reason: 'no_matching_rule' };

// Priority order (check() implementation must follow this exactly):
// 1. --dangerous mode → always grant
// 2. Path traversal check → block if path escapes working directory
// 3. Session denials → block (user clicked Deny this session)
// 4. Session grants → allow (user clicked Allow this session)
// 5. Persistent deny rules → block (from config files)
// 6. Persistent allow rules → allow (from config files)
// 7. No match → ask user
```

### Permission Request (for TUI prompt)

```typescript
// packages/types/src/permissions.ts

interface PermissionRequest {
  requestId: string;
  tool: 'Bash' | 'Write' | 'Edit';

  // For Bash: the full command
  // For Write/Edit: the file path
  target: string;

  // Extracted pattern for "Always allow" option
  // Bash: "npm install" (first two words)
  // Write/Edit: the path or a suggested glob
  suggestedPattern: string;

  // Working directory (for inheritance context)
  workingDirectory: string;

  // Human-readable description
  description: string;
}

interface PermissionResponse {
  requestId: string;
  decision: 'allow' | 'always_allow' | 'deny';

  // If always_allow, optionally override the pattern
  pattern?: string;
}
```

---

## 3. TUI Components

### Permission Prompt Component

When agent requests a permissioned tool, TUI displays:

```
┌─────────────────────────────────────────────────────────────────┐
│  Permission Required                                            │
│                                                                 │
│  Agent wants to run:                                            │
│  $ npm install lodash                                           │
│                                                                 │
│  [Allow]  [Always allow "npm *" for /project]  [Deny]          │
└─────────────────────────────────────────────────────────────────┘
```

For Write/Edit:
```
┌─────────────────────────────────────────────────────────────────┐
│  Permission Required                                            │
│                                                                 │
│  Agent wants to write:                                          │
│  src/components/Button.tsx                                      │
│                                                                 │
│  [Allow]  [Always allow "Write(src/**)" for /project]  [Deny]  │
└─────────────────────────────────────────────────────────────────┘
```

### Component Location

```
packages/tui/src/components/PermissionPrompt.tsx  (new file)
```

### Props Interface

```typescript
interface PermissionPromptProps {
  request: PermissionRequest;
  queueLength: number;  // Total pending requests (for "1 of 3" display)
  onRespond: (response: PermissionResponse) => void;
}
```

### Rendering States

1. **Waiting** - Prompt visible, agent paused
2. **Responded** - Prompt dismissed, agent resumes

---

## 4. Event Flow: TUI ↔ Bridge

### New Event Types

```typescript
// packages/types/src/events.ts (add to existing)

interface PermissionRequestEvent {
  type: 'permission_request';
  request: PermissionRequest;
}

interface PermissionResponseCommand {
  type: 'permission_response';
  response: PermissionResponse;
}
```

### Flow Diagram

```
Agent calls Bash("npm install lodash")
         │
         ▼
┌─────────────────────────────────────────┐
│ preToolUse hook (agent.ts:1192)         │
│ → checkPermission()                     │
│ → decision = 'ask'                      │
│ → emit PermissionRequestEvent           │
│ → await response                        │
└─────────────────────────────────────────┘
         │
         ▼ (via BridgeGateway → Bus)
┌─────────────────────────────────────────┐
│ TUI receives permission_request         │
│ → renders PermissionPrompt              │
│ → user clicks [Allow]                   │
│ → sends permission_response             │
└─────────────────────────────────────────┘
         │
         ▼ (via Bus → BridgeGateway)
┌─────────────────────────────────────────┐
│ BridgeGateway.handlePermissionResponse()│
│ → resolves waiting promise              │
│ → agent continues                       │
└─────────────────────────────────────────┘
         │
         ▼
Tool executes (or blocked if denied)
```

### Bus Channel

```typescript
// Permission events use the existing run channel
const channel = `run:${requestId}`;

// Or dedicated permission channel
const channel = `permission:${sessionKey}`;
```

---

## 5. Harness/Bridge Implementation

### Permission Checker Module

```typescript
// packages/harness-daemon/src/harness/permissions.ts (new file)

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { minimatch } from 'minimatch';

export class PermissionChecker {
  private state: SessionPermissionState;
  private workingDirectory: string;

  // Map of pending permission requests awaiting user response
  // Exposed via registerPendingRequest() and resolvePendingRequest()
  private pendingRequests: Map<string, {
    resolve: (response: PermissionResponse) => void;
    request: PermissionRequest;
  }>;

  constructor(
    workingDirectory: string,
    dangerousMode: boolean
  ) {
    this.workingDirectory = workingDirectory;
    this.state = {
      persistent: this.loadConfig(workingDirectory),
      sessionGrants: [],
      sessionDenials: [],
      dangerousMode,
    };
    this.pendingRequests = new Map();
  }

  // Register a pending request (called by harness when awaiting user response)
  registerPendingRequest(
    requestId: string,
    request: PermissionRequest,
    resolve: (response: PermissionResponse) => void
  ): void {
    this.pendingRequests.set(requestId, { resolve, request });
  }

  // Load and merge config files with proper error handling
  private loadConfig(workingDir: string): PermissionConfig {
    const result: PermissionConfig = { allow: [], deny: [] };

    // Config files in priority order (lowest to highest)
    const configPaths = [
      path.join(os.homedir(), '.jesus', 'settings.json'),      // Global
      path.join(workingDir, '.jesus', 'settings.json'),        // Project
      path.join(workingDir, '.jesus', 'settings.local.json'),  // Local override
    ];

    for (const configPath of configPaths) {
      const config = this.loadConfigFile(configPath);
      if (config) {
        // Merge: later files override earlier ones
        // For allow/deny arrays, we append (user can add deny rules to override)
        result.allow.push(...config.allow);
        result.deny.push(...config.deny);
      }
    }

    return result;
  }

  // Load a single config file, returning null if it doesn't exist
  private loadConfigFile(configPath: string): PermissionConfig | null {
    try {
      if (!fs.existsSync(configPath)) {
        return null;
      }
      const content = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(content);

      // Validate and parse permission rules
      const permissions = parsed.permissions ?? {};
      return {
        allow: this.parseRules(permissions.allow ?? []),
        deny: this.parseRules(permissions.deny ?? []),
      };
    } catch (err) {
      // Log warning but don't crash - continue with other config files
      console.warn(`Failed to load config from ${configPath}:`, err);
      return null;
    }
  }

  // Parse string patterns like "Bash(npm *)" into PermissionRule objects
  private parseRules(patterns: string[]): PermissionRule[] {
    const rules: PermissionRule[] = [];
    const ruleRegex = /^(Bash|Write|Edit)\((.+)\)$/;

    for (const pattern of patterns) {
      const match = pattern.match(ruleRegex);
      if (match) {
        rules.push({
          tool: match[1] as 'Bash' | 'Write' | 'Edit',
          pattern: match[2],
        });
      }
    }

    return rules;
  }

  // Check if tool+target is allowed
  // Priority order (per spec): dangerous → session → local.json → settings.json → global
  check(tool: 'Bash' | 'Write' | 'Edit', target: string): PermissionDecision {
    // 1. If dangerousMode, always grant
    if (this.state.dangerousMode) {
      return { granted: true, reason: 'dangerous_mode' };
    }

    // For Write/Edit, resolve and validate path first
    const resolvedTarget = tool === 'Bash' ? target : this.resolveAndValidatePath(target);
    if (resolvedTarget === null) {
      return { granted: false, reason: 'deny_rule' }; // Path traversal blocked
    }

    // 2. Check session-level first (highest priority after dangerous mode)
    if (this.matchesAny(tool, resolvedTarget, this.state.sessionDenials)) {
      return { granted: false, reason: 'session_denial' };
    }
    if (this.matchesAny(tool, resolvedTarget, this.state.sessionGrants)) {
      return { granted: true, reason: 'session_grant' };
    }

    // 3. Check persistent rules (deny takes precedence over allow within same tier)
    if (this.matchesAny(tool, resolvedTarget, this.state.persistent.deny)) {
      return { granted: false, reason: 'deny_rule' };
    }
    if (this.matchesAny(tool, resolvedTarget, this.state.persistent.allow)) {
      return { granted: true, reason: 'allow_rule' };
    }

    // 4. No matching rule - need to ask
    return { granted: 'ask', reason: 'no_matching_rule' };
  }

  // Resolve path and validate it's within working directory
  // Returns null if path escapes working directory (path traversal attempt)
  private resolveAndValidatePath(target: string): string | null {
    const resolved = path.resolve(this.workingDirectory, target);
    const relative = path.relative(this.workingDirectory, resolved);

    // If relative path starts with "..", it escapes the working directory
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }

    return relative;
  }

  // Match target against a list of permission rules
  private matchesAny(
    tool: 'Bash' | 'Write' | 'Edit',
    target: string,
    rules: PermissionRule[]
  ): boolean {
    for (const rule of rules) {
      if (rule.tool !== tool) continue;

      if (tool === 'Bash') {
        // For Bash, match the full command against the pattern
        // Pattern "npm *" should match "npm install lodash"
        if (minimatch(target, rule.pattern)) {
          return true;
        }
      } else {
        // For Write/Edit, match the resolved relative path
        if (minimatch(target, rule.pattern)) {
          return true;
        }
      }
    }
    return false;
  }

  // Extract pattern for suggested "Always allow" (NOT for matching)
  private extractSuggestedPattern(tool: 'Bash' | 'Write' | 'Edit', target: string): string {
    if (tool === 'Bash') {
      // First word + wildcard for broader matching
      const words = target.trim().split(/\s+/);
      return `${words[0]} *`;
    }
    // For Write/Edit, return the path as-is
    return target;
  }

  // Create permission request for TUI
  createRequest(tool: 'Bash' | 'Write' | 'Edit', target: string, workingDir: string): PermissionRequest {
    return {
      requestId: crypto.randomUUID(),
      tool,
      target,
      suggestedPattern: tool === 'Bash'
        ? this.extractSuggestedPattern(tool, target)
        : this.suggestGlob(target, workingDir),
      workingDirectory: workingDir,
      description: this.formatDescription(tool, target),
    };
  }

  // Suggest a glob pattern for Write/Edit based on file path
  // "/project/src/components/Button.tsx" → "src/**" (if in src/)
  // "/project/config.json" → "*.json" (if at root)
  private suggestGlob(target: string, workingDir: string): string {
    const resolved = path.resolve(workingDir, target);
    const relative = path.relative(workingDir, resolved);

    // Get the top-level directory
    const parts = relative.split(path.sep);
    if (parts.length > 1) {
      // File is in a subdirectory - suggest "dir/**"
      return `${parts[0]}/**`;
    }

    // File is at root - suggest extension-based pattern
    const ext = path.extname(relative);
    return ext ? `*${ext}` : relative;
  }

  // Format human-readable description
  private formatDescription(tool: 'Bash' | 'Write' | 'Edit', target: string): string {
    switch (tool) {
      case 'Bash':
        return `Run command: ${target}`;
      case 'Write':
        return `Create/overwrite file: ${target}`;
      case 'Edit':
        return `Edit file: ${target}`;
    }
  }

  // Handle response from TUI
  handleResponse(response: PermissionResponse): void {
    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) return;

    const { request } = pending;
    const pattern = response.pattern ?? request.suggestedPattern;

    if (response.decision === 'always_allow') {
      // Add to persistent config
      this.addPersistentRule('allow', request.tool, pattern, request.workingDirectory);
    } else if (response.decision === 'allow') {
      // Add to session grants only
      this.state.sessionGrants.push({ tool: request.tool, pattern });
    } else if (response.decision === 'deny') {
      // Add to session denials
      this.state.sessionDenials.push({ tool: request.tool, pattern });
    }

    pending.resolve(response);
    this.pendingRequests.delete(response.requestId);
  }

  // Persist "always allow" to .jesus/settings.json
  private addPersistentRule(
    type: 'allow' | 'deny',
    tool: string,
    pattern: string,
    workingDir: string
  ): void {
    const configPath = path.join(workingDir, '.jesus', 'settings.json');
    // Read, merge, write
  }
}
```

### Integration with Agent Hooks

```typescript
// packages/harness-daemon/src/harness/harness.ts

import { EventEmitter } from 'events';

// Tool name normalization: hooks receive lowercase, but types use capitalized
type PermissionedTool = 'Bash' | 'Write' | 'Edit';
const PERMISSIONED_TOOLS: Record<string, PermissionedTool> = {
  bash: 'Bash',
  write: 'Write',
  edit: 'Edit',
};

class AgentHarness extends EventEmitter {
  private permissionChecker: PermissionChecker;
  private workingDirectory: string;

  constructor(config: HarnessConfig) {
    super();
    this.workingDirectory = config.workingDirectory;
    this.permissionChecker = new PermissionChecker(
      config.workingDirectory,
      config.dangerousMode ?? false
    );
  }

  // Expose permission checker for bridge gateway
  getPermissionChecker(): PermissionChecker {
    return this.permissionChecker;
  }

  private createAgentHooks(): AgentHooks {
    return {
      preToolUse: async (toolName: string, args: Record<string, unknown>) => {
        // Normalize tool name (lowercase → capitalized)
        const normalizedTool = PERMISSIONED_TOOLS[toolName.toLowerCase()];
        if (!normalizedTool) {
          return { action: 'allow' };
        }

        const target = this.extractTarget(normalizedTool, args);
        const decision = this.permissionChecker.check(normalizedTool, target);

        if (decision.granted === true) {
          return { action: 'allow' };
        }

        if (decision.granted === false) {
          return {
            action: 'block',
            message: `Permission denied: ${decision.reason}`
          };
        }

        // Need to ask user
        const request = this.permissionChecker.createRequest(
          normalizedTool,
          target,
          this.workingDirectory
        );

        // Emit event and wait for response
        const response = await this.requestPermission(request);

        if (response.decision === 'deny') {
          return { action: 'block', message: 'Permission denied by user' };
        }

        return { action: 'allow' };
      },
    };
  }

  private extractTarget(tool: PermissionedTool, args: Record<string, unknown>): string {
    switch (tool) {
      case 'Bash':
        return String(args.command ?? '');
      case 'Write':
      case 'Edit':
        return String(args.file_path ?? args.path ?? '');
    }
  }

  private async requestPermission(request: PermissionRequest): Promise<PermissionResponse> {
    // Emit permission_request event (handled by bridge gateway)
    this.emit('permission_request', request);

    // Wait for permission_response via the checker's pending request mechanism
    return new Promise((resolve) => {
      this.permissionChecker.registerPendingRequest(
        request.requestId,
        request,
        resolve
      );
    });
  }
}
```

### BridgeGateway Handler

```typescript
// packages/harness-daemon/src/harness/bridge_gateway.ts

// Add to handlePublish() switch statement (around line 150):
case 'permission_response':
  this.handlePermissionResponse(connectionState, payload as PermissionResponseCommand);
  break;

// New handler method:
private handlePermissionResponse(
  state: ConnectionState,
  command: PermissionResponseCommand
): void {
  const session = this.getSession(state.sessionKey);
  if (!session) return;

  // Forward to harness's permission checker via accessor method
  session.harness.getPermissionChecker().handleResponse(command.response);
}
```

---

## 6. --dangerous Mode

### CLI Flag

```typescript
// packages/harness-daemon/src/index.ts

import { parseArgs } from 'util';

const { values } = parseArgs({
  options: {
    dangerous: {
      type: 'boolean',
      default: false,
    },
    // ... other options
  },
});

const dangerousMode = values.dangerous ?? false;

// Pass to harness config
const harness = new AgentHarness({
  ...config,
  dangerousMode,
});
```

### Environment Variable (alternative)

```typescript
const dangerousMode = process.env.JESUS_DANGEROUS === '1' || values.dangerous;
```

### Propagation

```
CLI flag
    │
    ▼
HarnessConfig.dangerousMode
    │
    ▼
PermissionChecker constructor
    │
    ▼
SessionPermissionState.dangerousMode
    │
    ▼
check() returns { granted: true, reason: 'dangerous_mode' }
```

---

## 7. Files to Modify

### New Files

| File | Purpose |
|------|---------|
| `packages/types/src/permissions.ts` | Type definitions |
| `packages/harness-daemon/src/harness/permissions.ts` | Permission checker logic |
| `packages/tui/src/components/PermissionPrompt.tsx` | TUI prompt component |

### Modified Files

| File | Changes |
|------|---------|
| `packages/types/src/index.ts` | Export permission types |
| `packages/types/src/events.ts` | Add permission events |
| `packages/harness-daemon/src/index.ts` | Parse `--dangerous` flag |
| `packages/harness-daemon/src/harness/harness.ts` | Integrate PermissionChecker, create hooks |
| `packages/harness-daemon/src/harness/config.ts` | Add permission config schema |
| `packages/harness-daemon/src/harness/bridge_gateway.ts` | Handle `permission_response` command |
| `packages/tui/src/App.tsx` | Render PermissionPrompt when needed |
| `packages/tui/src/store.ts` | Add permission request state |
| `packages/tui/bridge_client.ts` | Add `sendPermissionResponse()` method |
| `packages/comms-bus/src/bus_types.ts` | Add permission message types |
| `packages/agent/src/agent.ts` | Ensure hooks integration works with async permission flow |

---

## 8. Permission Config File Bootstrap

When user first runs and `.jesus/settings.json` doesn't exist, create with sensible defaults:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm *)",
      "Bash(pnpm *)",
      "Bash(yarn *)",
      "Bash(bun *)",
      "Bash(git *)",
      "Bash(node *)",
      "Bash(npx *)",
      "Bash(tsc *)",
      "Bash(eslint *)",
      "Bash(prettier *)"
    ],
    "deny": [
      "Bash(rm -rf /)",
      "Bash(sudo *)",
      "Bash(chmod 777 *)"
    ]
  }
}
```

---

## 9. Edge Cases

### Chained Commands

```bash
npm install && rm -rf node_modules
```

**Security concern**: Matching only the first command allows bypassing deny rules.

**Approach**: Detect shell operators and check ALL commands in the chain:

```typescript
// Detect chained commands (&&, ||, ;, |, $(...), `...`)
private parseChainedCommands(command: string): string[] {
  // Split on shell operators while respecting quotes
  const shellOperators = /\s*(?:&&|\|\||;|\|)\s*/;
  const commands = command.split(shellOperators).filter(Boolean);

  // Also detect command substitution $(...) and backticks
  const substitutionPattern = /\$\([^)]+\)|`[^`]+`/g;
  const substitutions = command.match(substitutionPattern) ?? [];
  for (const sub of substitutions) {
    const inner = sub.slice(sub.startsWith('$(') ? 2 : 1, -1);
    commands.push(inner);
  }

  return commands;
}

// In check(): verify ALL commands in chain pass
checkBashCommand(fullCommand: string): PermissionDecision {
  const commands = this.parseChainedCommands(fullCommand);

  for (const cmd of commands) {
    const decision = this.checkSingleCommand('Bash', cmd.trim());
    if (decision.granted === false) {
      return decision;  // Any denied command blocks the whole chain
    }
    if (decision.granted === 'ask') {
      // For 'ask', we still need to prompt - but include the full chain context
      return { granted: 'ask', reason: 'no_matching_rule' };
    }
  }

  return { granted: true, reason: 'allow_rule' };
}
```

**Result**: `npm install && rm -rf /` is blocked because `rm -rf /` matches a deny rule, even though `npm install` is allowed.

### Path Traversal

```
Write to: /project/src/../../../etc/passwd
```

**Approach**: Resolve to canonical path before checking. Use `path.resolve()` and verify it's under the working directory.

### Glob Ambiguity

User allows `Write(src/**)`, agent writes to `./src/foo.ts` vs `/absolute/src/foo.ts`.

**Approach**: Always resolve relative to working directory. Pattern matching operates on the resolved relative path.

### Concurrent Permission Requests

Agent requests 3 Bash commands in parallel (tool calls in same turn).

**Approach**: Queue them. Show one prompt at a time. Or batch into single prompt:
```
Agent wants to run 3 commands:
1. npm install
2. npm run build
3. npm test

[Allow all] [Allow 1,2] [Deny all] [Decide individually]
```

**Recommendation**: Start simple (sequential prompts), add batching later if UX demands it.

---

## 10. TUI State Management

### Store Additions

```typescript
// packages/tui/src/store.ts

interface TuiState {
  // ... existing state

  // Permission state - use a QUEUE to handle concurrent requests
  // Multiple tool calls can request permissions simultaneously
  permissionQueue: PermissionRequest[];
}

// Actions
type TuiAction =
  | { type: 'PERMISSION_REQUEST'; request: PermissionRequest }
  | { type: 'PERMISSION_RESPONDED'; requestId: string }
  // ... existing actions

// Reducer
function reducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'PERMISSION_REQUEST':
      return {
        ...state,
        permissionQueue: [...state.permissionQueue, action.request],
      };
    case 'PERMISSION_RESPONDED':
      return {
        ...state,
        permissionQueue: state.permissionQueue.filter(
          (r) => r.requestId !== action.requestId
        ),
      };
    // ...
  }
}
```

### Event Handling

```typescript
// packages/tui/src/App.tsx

useEffect(() => {
  const unsubscribe = bridge.on('permission_request', (request) => {
    dispatch({ type: 'PERMISSION_REQUEST', request });
  });
  return unsubscribe;
}, []);

// Get the first pending permission (FIFO queue)
const currentPermission = state.permissionQueue[0] ?? null;

// Render - show one prompt at a time, queue others
{currentPermission && (
  <PermissionPrompt
    request={currentPermission}
    queueLength={state.permissionQueue.length}  // Show "1 of 3" if multiple
    onRespond={(response) => {
      bridge.sendPermissionResponse(response);
      dispatch({ type: 'PERMISSION_RESPONDED', requestId: currentPermission.requestId });
    }}
  />
)}
```

---

## 11. Testing Strategy

### Unit Tests

1. `PermissionChecker.check()` - pattern matching logic
2. `PermissionChecker.extractPattern()` - Bash first-two-words extraction
3. Config file loading and merging
4. Path resolution and traversal prevention

### Integration Tests

1. Full flow: Agent → permission request → TUI response → agent continues
2. `--dangerous` mode bypasses all checks
3. "Always allow" persists to config file
4. Session grants don't persist across restart

### E2E Tests

1. User allows Bash command, agent executes
2. User denies, agent receives error
3. Deny rule blocks even without prompt
4. Allow rule auto-approves without prompt

---

## 12. Migration / Rollout

1. **Phase 1**: Implement core permission checker with `--dangerous` default ON (no breaking change)
2. **Phase 2**: Add TUI components, test flow
3. **Phase 3**: Flip default to `--dangerous` OFF, permissions enforced
4. **Phase 4**: Add batching, UX refinements

---

## Summary

| Component | Location | Responsibility |
|-----------|----------|----------------|
| Types | `packages/types/src/permissions.ts` | Interfaces and types |
| Checker | `packages/harness-daemon/src/harness/permissions.ts` | Pattern matching, config loading, state |
| Hooks | `packages/harness-daemon/src/harness/harness.ts` | Integration point with agent |
| Bridge | `packages/harness-daemon/src/harness/bridge_gateway.ts` | TUI ↔ Harness communication |
| TUI | `packages/tui/src/components/PermissionPrompt.tsx` | User interface |
| Store | `packages/tui/src/store.ts` | TUI state management |
| Config | `.jesus/settings.json` | Persistent rules |
