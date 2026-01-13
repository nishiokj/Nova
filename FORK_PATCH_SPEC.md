# /fork - Minimum Patch Spec

## Overview

Fork creates a clone of the current TUI session with duplicated context, allowing two independent sessions to continue from the same point.

## Hotpath Summary

### Session Lifecycle
```
TUI init → BridgeGateway.handleInit() → generateSessionKey() → ConnectionState.sessionKey
         → harness.createReadyEvent() → sessionChannel subscription
```

### Context Lifecycle
```
run() → getOrCreateContext(sessionKey)
      → 1. Check contextWindows Map (in-memory cache)
      → 2. Hydrate from GraphD if miss: contextGet() → ContextWindow.deserialize()
      → 3. Create fresh if not in GraphD
      → [execution]
      → persistContext() → contextSave() to GraphD
```

### Key Storage Locations
| Data | Location | Key |
|------|----------|-----|
| Session metadata | `sessions` table (SQLite) | `session_key` |
| Context window | `context_snapshots` table | `session_key` |
| In-memory context | `harness.contextWindows` Map | `sessionKey` |
| Messages | `conversation_messages` table | `session_key` |

---

## Minimum Patch

### 1. GraphD Store: `packages/graphd/src/store.ts`

Add `forkSession()` method that atomically:

```typescript
forkSession(
  sourceSessionKey: string,
  targetSessionKey: string,
  clientType?: string
): { success: boolean; error?: string }
```

**Operations:**
1. Get source session from `sessions` table
2. Insert new session record with `targetSessionKey`, same `working_dir`, fresh `created_at`
3. Get latest context snapshot for source session
4. Insert copy with `targetSessionKey` and `snapshot_version = 1`
5. Copy conversation messages (re-index)

### 2. GraphD Manager: `packages/graphd/src/manager.ts`

Add `sessionFork()` method:

```typescript
sessionFork(
  sourceSessionKey: string,
  targetSessionKey?: string  // auto-generate if not provided
): { success: boolean; newSessionKey?: string; error?: string }
```

### 3. BridgeGateway: `apps/harness-daemon/src/harness/bridge_gateway.ts`

Add command handler for `session_fork`:

```typescript
case 'session_fork':
  this.handleSessionFork(connectionId, command.data, state);
  return;
```

**Handler:**
```typescript
private handleSessionFork(
  connectionId: string,
  data: Record<string, unknown> | undefined,
  state: ConnectionState
): void {
  const sourceSessionKey = state.sessionKey;
  if (!sourceSessionKey) {
    this.sendError(connectionId, 'No active session to fork');
    return;
  }

  // Generate new session key
  const newSessionKey = generateSessionKey();

  // Fork via GraphD
  const result = this.harness.forkSession(sourceSessionKey, newSessionKey);

  this.sendEvent(connectionId, {
    type: 'response',
    data: {
      success: result.success,
      metadata: {
        kind: 'session_fork',
        payload: {
          sourceSessionKey,
          newSessionKey: result.success ? newSessionKey : undefined,
          error: result.error,
        },
      },
    },
  });
}
```

### 4. Harness: `apps/harness-daemon/src/harness/harness.ts`

Add `forkSession()` method to `HarnessLike` interface and implementation:

```typescript
forkSession(sourceSessionKey: string, targetSessionKey: string): { success: boolean; error?: string } {
  if (!this.graphd || !this.graphdStarted) {
    return { success: false, error: 'GraphD not available' };
  }

  // Fork in GraphD
  const result = this.graphd.sessionFork(sourceSessionKey, targetSessionKey);

  if (result.success) {
    // Pre-populate in-memory cache with cloned context
    const sourceContext = this.contextWindows.get(sourceSessionKey);
    if (sourceContext) {
      const clonedSnapshot = sourceContext.serialize();
      clonedSnapshot.sessionKey = targetSessionKey;
      const clonedContext = ContextWindow.deserialize(clonedSnapshot);
      this.contextWindows.set(targetSessionKey, clonedContext);
    }
  }

  return result;
}
```

### 5. BridgeClient: `apps/tui/bridge_client.ts`

Add `sessionFork()` method for TUI to call:

```typescript
async sessionFork(): Promise<{
  success: boolean;
  newSessionKey?: string;
  error?: string;
}> {
  return this.sendAuthCommand('session_fork', {});
}
```

### 6. TUI Commands: `apps/tui/commands.ts`

Register the command:

```typescript
export const SLASH_COMMANDS = [
  // ... existing
  "/fork",
];

export const HELP_LINES: string[] = [
  "Commands:",
  // ... existing
  "  /fork           Fork session to new terminal",
  // ...
];
```

### 7. TUI Handler: `apps/tui/index.tsx`

Add case in `handleSlashCommand`:

```typescript
case "/fork":
  void handleFork();
  return;
```

Add handler function:

```typescript
const handleFork = async () => {
  store.addMessage("system", "Forking session...");

  const result = await bridgeClient.sessionFork();

  if (!result.success) {
    store.addMessage("system", `Fork failed: ${result.error}`);
    return;
  }

  const spawnResult = spawnForkedSession(result.newSessionKey!, workingDir);

  if (spawnResult.autoSpawned) {
    store.addMessage("system", `✓ ${spawnResult.message}`);
  } else {
    // Show fallback UI with command
    store.setForkMessage(spawnResult);
  }
};
```

---

## Data Flow

```
User: /fork
     │
     ▼
TUI sends { type: 'session_fork' } on bridge_command
     │
     ▼
BridgeGateway.handleSessionFork()
  │
  ├─► generateSessionKey() → newSessionKey
  │
  ├─► harness.forkSession(sourceKey, newKey)
  │     │
  │     ├─► graphd.sessionFork()
  │     │     ├─► store.forkSession()
  │     │     │     ├─► Copy session record
  │     │     │     ├─► Copy context_snapshot
  │     │     │     └─► Copy conversation_messages
  │     │     └─► Return { success, newSessionKey }
  │     │
  │     └─► Clone in-memory contextWindows entry
  │
  └─► Send response with newSessionKey
     │
     ▼
TUI receives newSessionKey
     │
     ▼
Launch new terminal: jesus-tui --session {newSessionKey}
     │
     ▼
New TUI connects with { type: 'init', session_key: newSessionKey }
     │
     ▼
BridgeGateway.handleInit() → uses existing session
     │
     ▼
getOrCreateContext() → hydrates from GraphD (already populated)
```

---

## File Changes Summary

| File | Change Type | LOC Estimate |
|------|-------------|--------------|
| `packages/graphd/src/store.ts` | Add `forkSession()` | ~40 |
| `packages/graphd/src/manager.ts` | Add `sessionFork()` | ~15 |
| `apps/harness-daemon/src/harness/bridge_gateway.ts` | Add handler | ~25 |
| `apps/harness-daemon/src/harness/harness.ts` | Add `forkSession()` | ~20 |
| `apps/tui/bridge_client.ts` | Add `sessionFork()` | ~10 |
| `apps/tui/commands.ts` | Add `/fork` to list + help | ~3 |
| `apps/tui/index.tsx` | Add `handleFork()` + case | ~25 |
| `apps/tui/src/utils/fork-spawn.ts` (new) | tmux + clipboard fallback | ~60 |
| `apps/tui/components/ForkMessage.tsx` (new) | Fallback UI component | ~40 |

**Total: ~238 lines of new code**

---

## Edge Cases

1. **Source session not in GraphD**: Fail with clear error
2. **Source session has no context snapshot**: Create empty context for fork
3. **Daemon restart between fork and new TUI connect**: OK - all state in GraphD
4. **Multiple forks from same session**: Each gets unique key, all share same parent context
5. **Fork during active run**: Fork current persisted state, not in-flight mutations

---

## Terminal/Pane Spawning Strategy

Two modes: **tmux** (automatic) and **fallback** (manual with helper).

### Detection

```typescript
function isInTmux(): boolean {
  return !!process.env.TMUX;
}
```

### tmux Mode

If user is in tmux, spawn automatically:

```typescript
import { execSync } from 'child_process';

function forkInTmux(sessionKey: string, workingDir: string, layout: 'split' | 'window' = 'split') {
  const cmd = `jesus --session ${sessionKey}`;

  if (layout === 'split') {
    // Horizontal split - new pane appears to the right
    execSync(`tmux split-window -h -c "${workingDir}" "${cmd}"`);
  } else {
    // New window in same tmux session
    execSync(`tmux new-window -c "${workingDir}" "${cmd}"`);
  }
}
```

### Fallback Mode (non-tmux users)

Make it dead simple - copy full command to clipboard and show clear instructions:

```typescript
import { execSync } from 'child_process';

interface ForkFallbackResult {
  command: string;
  copied: boolean;
}

function forkFallback(sessionKey: string, workingDir: string): ForkFallbackResult {
  const command = `cd "${workingDir}" && jesus --session ${sessionKey}`;

  // Try to copy to clipboard
  let copied = false;
  try {
    if (process.platform === 'darwin') {
      execSync(`printf '%s' "${command}" | pbcopy`, { stdio: 'pipe' });
      copied = true;
    } else if (process.platform === 'linux') {
      // Try xclip first, then xsel
      try {
        execSync(`printf '%s' "${command}" | xclip -selection clipboard`, { stdio: 'pipe' });
        copied = true;
      } catch {
        try {
          execSync(`printf '%s' "${command}" | xsel --clipboard`, { stdio: 'pipe' });
          copied = true;
        } catch {
          // No clipboard tool available
        }
      }
    }
    // Windows: could use clip.exe but WSL users likely have tmux
  } catch {
    // Clipboard failed, not critical
  }

  return { command, copied };
}
```

### TUI Display for Fallback

When fork succeeds but we can't auto-spawn, show a helpful message in the TUI:

```
┌─────────────────────────────────────────────────────────────┐
│  Fork created successfully!                                 │
│                                                             │
│  Open a new terminal and run:                               │
│                                                             │
│    jesus --session tui_1704067200_a1b2c3d4                  │
│                                                             │
│  ✓ Command copied to clipboard                              │
│                                                             │
│  TIP: Run jesus inside tmux for automatic fork spawning    │
└─────────────────────────────────────────────────────────────┘
```

### Implementation

```typescript
// apps/tui/src/utils/fork-spawn.ts

export interface ForkSpawnResult {
  success: boolean;
  autoSpawned: boolean;
  sessionKey: string;
  message: string;
  command?: string;  // Only set if manual action needed
}

export function spawnForkedSession(
  sessionKey: string,
  workingDir: string
): ForkSpawnResult {

  // Try tmux first
  if (process.env.TMUX) {
    try {
      const cmd = `jesus --session ${sessionKey}`;
      execSync(`tmux split-window -h -c "${workingDir}" "${cmd}"`, { stdio: 'pipe' });
      return {
        success: true,
        autoSpawned: true,
        sessionKey,
        message: 'Forked in new tmux pane',
      };
    } catch (err) {
      // tmux command failed, fall through to manual
    }
  }

  // Fallback: clipboard + instructions
  const { command, copied } = forkFallback(sessionKey, workingDir);

  return {
    success: true,
    autoSpawned: false,
    sessionKey,
    message: copied
      ? 'Fork created - command copied to clipboard'
      : 'Fork created - run command in new terminal',
    command,
  };
}
```

### File Changes for Terminal Spawning

| File | Change |
|------|--------|
| `apps/tui/src/utils/fork-spawn.ts` (new) | tmux + fallback logic (~60 LOC) |
| `apps/tui/commands.ts` | Add `/fork` command handler |
| `apps/tui/components/ForkMessage.tsx` (new) | Display component for fallback (~40 LOC) |

---

## Out of Scope for MVP

- Fork from dashboard UI (web)
- Fork with partial context (selective history)
- Named forks / fork aliases
- Fork tree visualization
- Cross-machine forking

---

## Testing

1. Fork idle session → verify new session appears in GraphD
2. Fork after sending messages → verify messages copied
3. Fork → send different messages to each → verify independence
4. Fork → restart daemon → verify both sessions resume correctly
5. Fork during run → verify fork captures pre-run state
