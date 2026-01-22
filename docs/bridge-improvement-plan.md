# Bridge Client & Gateway Improvements

## Overview
Analysis of `packages/tui/bridge_client.ts` and `packages/harness-daemon/src/harness/bridge_gateway.ts` revealed several architectural and code quality issues.

---

## BridgeClient (packages/tui/bridge_client.ts)

### 🔴 Critical Issues

#### 1. Memory Leak in `sendAuthCommand`
**Problem:** Event handlers aren't cleaned up on successful resolution, and timeouts aren't cleared.

```typescript
// Current code - LEAKS
private sendAuthCommand<T>(type: string, data: Record<string, unknown>): Promise<T> {
  return new Promise((resolve) => {
    const handler = (event: BridgeEvent) => {
      if (event.type === 'response' && metadata?.kind === type) {
        this.off('event', handler); // Only called on success
        resolve(...);
      }
    };
    this.on('event', handler);

    setTimeout(() => {
      this.off('event', handler); // Only called on timeout
      resolve({ success: false, error: 'timeout' });
    }, 30000);
  });
}
```

**Fix:** Use `AbortController` pattern or track pending requests properly.

```typescript
private pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  timestamp: number;
}>();

private sendAuthCommand<T>(type: string, data: Record<string, unknown>): Promise<T> {
  const requestId = `${type}_${generateRequestId()}`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      this.pendingRequests.delete(requestId);
      reject(new Error('Request timeout'));
    }, 30000);

    this.pendingRequests.set(requestId, { resolve, reject, timeout, timestamp: Date.now() });

    // Send command with requestId in metadata
    this.send({ type, data: { ...data, _requestId: requestId } });
  });
}

// Updated handler to match by requestId
private handleBusEvent(payload: unknown): void {
  const event = validateBridgeEvent(payload);
  if (!event) return;

  if (event.type === 'response') {
    const metadata = event.data?.metadata as { kind?: string; _requestId?: string } | undefined;
    const requestId = metadata?._requestId;

    if (requestId && this.pendingRequests.has(requestId)) {
      const pending = this.pendingRequests.get(requestId)!;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(requestId);
      pending.resolve(metadata.payload ?? { success: false });
    }
  }

  this.emit("event", event);
}
```

#### 2. Race Conditions in Auth Commands
**Problem:** Multiple concurrent auth commands of the same type interfere with each other.

**Fix:** The requestId-based approach above solves this by correlating responses to specific requests.

#### 3. Reconnect Delay Never Reset
**Problem:** `reconnectDelay` accumulates across reconnection attempts, even after success.

```typescript
// Current - only reset on initial connect
async connect(): Promise<void> {
  // ...
  this.reconnectAttempts = 0;
  this.reconnectDelay = 1000; // ✅ Reset here
}

// But NOT reset after successful reconnection
this.connect().catch(() => {
  this.connectionState = 'reconnecting';
  this.scheduleReconnect(); // ❌ reconnectDelay doubles again
});
```

**Fix:** Reset delay after successful reconnection:

```typescript
this.connect().catch(() => {
  this.connectionState = 'reconnecting';
  this.emit('connection_state', this.connectionState);
  this.scheduleReconnect();
}).then(() => {
  // Reset after successful reconnection
  if (this.connectionState === 'connected') {
    this.reconnectAttempts = 0;
    this.reconnectDelay = 1000;
  }
});
```

### 🟡 Moderate Issues

#### 4. Poor Error Visibility
**Problem:** `send()` returns `false` without context.

```typescript
send(command: BridgeCommand): boolean {
  if (this.connectionState !== 'connected') {
    this.emit("error", { message: "Not connected to bridge" }); // Side effect only
    return false; // No details about WHY
  }
  // ...
}
```

**Fix:** Use a Result type or throw:

```typescript
type SendResult =
  | { success: true }
  | { success: false; reason: 'not_connected' | 'invalid_command' };

send(command: BridgeCommand): SendResult {
  if (this.connectionState !== 'connected') {
    this.emit("error", { message: "Not connected to bridge" });
    return { success: false, reason: 'not_connected' };
  }
  return { success: true };
}
```

#### 5. Type Safety
**Problem:** Loose type assertions without validation.

```typescript
const data = { ...(command.data ?? {}) } as Record<string, unknown>;
```

**Fix:** Use runtime validation libraries (zod, io-ts) or at least guard clauses.

---

## BridgeGateway (packages/harness-daemon/src/harness/bridge_gateway.ts)

### 🔴 Critical Issues

#### 1. Massive Monolith - 700+ Lines
**Problem:** Single file handles auth, skills, hooks, models, sessions, context, Ralph loop.

**Fix:** Split into focused modules:

```
packages/harness-daemon/src/harness/
├── bridge_gateway.ts           # Core routing only (100-150 lines)
├── handlers/
│   ├── auth_handler.ts         # Auth commands
│   ├── skills_handler.ts       # Skills CRUD
│   ├── hooks_handler.ts        # Hooks CRUD
│   ├── models_handler.ts       # Model selection & hidden models
│   ├── session_handler.ts      # Session lifecycle (init, fork, close, list)
│   ├── context_handler.ts      # Context compaction
│   └── ralph_handler.ts        # Ralph loop functionality
├── types.ts                    # Shared types for handlers
└── utils/
    └── command_router.ts       # Command → handler mapping
```

**New BridgeGateway Structure:**

```typescript
// bridge_gateway.ts - Core routing only
import { CommandRouter } from './utils/command_router.js';
import { AuthHandler } from './handlers/auth_handler.js';
import { SkillsHandler } from './handlers/skills_handler.js';
import { HooksHandler } from './handlers/hooks_handler.js';
import { ModelsHandler } from './handlers/models_handler.js';
import { SessionHandler } from './handlers/session_handler.js';
import { ContextHandler } from './handlers/context_handler.js';
import { RalphHandler } from './handlers/ralph_handler.js';

export class BridgeGateway {
  private readonly router: CommandRouter;
  private readonly authHandler: AuthHandler;
  private readonly skillsHandler: SkillsHandler;
  private readonly hooksHandler: HooksHandler;
  private readonly modelsHandler: ModelsHandler;
  private readonly sessionHandler: SessionHandler;
  private readonly contextHandler: ContextHandler;
  private readonly ralphHandler: RalphHandler;

  constructor(bus: BusServer, harness: HarnessLike, workingDir: string, authService?: AuthService | null) {
    // Initialize handlers with dependencies
    this.authHandler = new AuthHandler(authService, this.harness);
    this.skillsHandler = new SkillsHandler(this.skillsDir);
    this.hooksHandler = new HooksHandler(this.hooksDir);
    this.modelsHandler = new ModelsHandler(this.harness, this.workingDir);
    this.sessionHandler = new SessionHandler(this.harness, this.workingDir);
    this.contextHandler = new ContextHandler(this.harness);
    this.ralphHandler = new RalphHandler(this.harness);

    // Register routes
    this.router = new CommandRouter();
    this.router.register('auth_start', this.authHandler.handleStart.bind(this.authHandler));
    this.router.register('auth_poll', this.authHandler.handlePoll.bind(this.authHandler));
    this.router.register('skills_list', this.skillsHandler.handleList.bind(this.skillsHandler));
    // ... and so on
  }

  async handlePublish(connectionId: string, channel: string, payload: unknown): Promise<void> {
    if (channel !== BRIDGE_COMMAND_CHANNEL) return;

    const command = this.validateCommand(payload);
    if (!command) {
      this.sendError(connectionId, 'Invalid bridge command payload');
      return;
    }

    const state = this.getOrCreateConnectionState(connectionId);

    try {
      await this.router.execute(command.type, connectionId, command.data, state);
    } catch (error) {
      this.sendEvent(connectionId, createErrorEvent(error instanceof Error ? error.message : String(error), false));
    }
  }
}
```

**Command Router Implementation:**

```typescript
// utils/command_router.ts
type HandlerFn = (connectionId: string, data: Record<string, unknown> | undefined, state: ConnectionState) => Promise<void> | void;

export class CommandRouter {
  private handlers = new Map<string, HandlerFn>();

  register(commandType: string, handler: HandlerFn): void {
    this.handlers.set(commandType, handler);
  }

  async execute(commandType: string, connectionId: string, data: Record<string, unknown> | undefined, state: ConnectionState): Promise<void> {
    const handler = this.handlers.get(commandType);
    if (!handler) {
      throw new Error(`Unknown command type: ${commandType}`);
    }
    await handler(connectionId, data, state);
  }
}
```

#### 2. Unmaintainable Switch Statement
**Problem:** 30+ cases in one switch - adding a command requires modifying the switch.

**Fix:** The CommandRouter pattern above eliminates this.

#### 3. Truncated File
**Problem:** Ralph Loop handlers are missing (file truncated at line 600+).

**Fix:** Implement missing handlers or move to separate module.

### 🟡 Moderate Issues

#### 4. Data Mutation
**Problem:** Modifying command object in `handleSendText`.

```typescript
// Current - mutates command object
if (command.type === "send_text") {
  const data = { ...(command.data ?? {}) } as Record<string, unknown>;
  data.client_request_id = requestId;
  command = { ...command, data }; // Creates new object, but confusing
}
```

**Fix:** Be explicit about immutability:

```typescript
const data = command.data ?? {};
const enrichedData = {
  ...data,
  client_request_id: data.client_request_id || generateRequestId(),
};
const enrichedCommand: BridgeCommand = { type: 'send_text', data: enrichedData };
```

#### 5. Duplicate Model Changed Events
**Problem:** `handleInit` emits `model_changed` twice for agent types.

```typescript
// First emission
const allSelections = this.harness.getAllSessionSelectedModels?.(sessionKey) ?? new Map();
for (const agentType of agentTypes) {
  const selection = allSelections.get(agentType) ?? null;
  this.sendEvent(connectionId, { type: 'model_changed', data: { agentType, ...selection } });
}

// But this is AFTER we already did it above
```

**Fix:** Consolidate to single emission pass.

#### 6. Complex GraphD Interactions
**Problem:** GraphD calls scattered throughout - inconsistent patterns.

**Fix:** Create a `GraphDSessionManager` abstraction:

```typescript
// handlers/session_manager.ts
export class GraphDSessionManager {
  constructor(private graphd: GraphDManager) {}

  async createSession(sessionKey: string, workingDir: string): Promise<void> {
    await this.graphd.sessionTouch(sessionKey, workingDir);
    await this.graphd.sessionUpdateStatus(sessionKey, 'active');
  }

  async deactivateSession(sessionKey: string): Promise<void> {
    await this.graphd.sessionUpdateStatus(sessionKey, 'inactive');
  }

  async restoreSession(sessionKey: string): Promise<void> {
    await this.graphd.sessionUpdateStatus(sessionKey, 'active');
  }

  async updateModelSelection(sessionKey: string, agentType: string, selection: ModelSelection): Promise<void> {
    const globalSelections = this.graphd.getUserPreference<Record<string, ModelSelection>>('user_prefs:model_selections') ?? {};
    const updatedSelections = { ...globalSelections, [agentType]: selection };

    await this.graphd.sessionUpdateMetadata(sessionKey, { model_selections: updatedSelections });
    await this.graphd.setUserPreference('user_prefs:model_selections', updatedSelections);
  }

  // ... other GraphD operations
}
```

---

## Implementation Priority

### Phase 1: Critical Fixes (High Impact, Low Risk)
1. ✅ Fix memory leak in `sendAuthCommand` - BridgeClient
2. ✅ Fix reconnect delay reset bug - BridgeClient
3. ✅ Complete truncated Ralph Loop handlers - BridgeGateway

### Phase 2: Architecture Improvements (High Impact, Medium Risk)
4. 📦 Split BridgeGateway into handlers
5. 📦 Implement CommandRouter pattern
6. 📦 Create GraphDSessionManager abstraction

### Phase 3: Code Quality Improvements (Medium Impact, Low Risk)
7. 🔧 Improve error visibility in `send()`
8. 🔧 Remove duplicate model_changed emissions
9. 🔧 Fix data mutation patterns
10. 🔧 Add proper type guards/validation

---

## Testing Strategy

1. **Unit Tests for Handlers**: Each handler should be testable independently
2. **Integration Tests for Router**: Test command routing logic
3. **Reconnection Scenarios**: Test reconnect behavior under various conditions
4. **Concurrent Requests**: Test multiple simultaneous auth commands
5. **Memory Leak Tests**: Verify event handlers are cleaned up

---

## Migration Plan

1. Create new handler modules
2. Move handler implementations one at a time
3. Register with CommandRouter
4. Remove old switch statement cases
5. Delete old file when all handlers migrated
6. Update tests to use new structure
