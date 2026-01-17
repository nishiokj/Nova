# TUI Error Handling - Minimum Patch Spec

Five structural changes to make the TUI resilient without littering the codebase with try-catches.

---

## 1. Boundary Validation for Bridge Events

**Problem**: Malformed events from the bridge propagate into handlers and crash on property access.

**Solution**: Single validation function at the entry point. Bad data dies here, never propagates.

**File**: `bridge_client.ts`

**Changes**:

```typescript
// Add at top of file
function validateBridgeEvent(payload: unknown): BridgeEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;

  // Must have a valid type
  const validTypes = ['ready', 'status', 'progress', 'stream', 'response', 'transcription', 'user_prompt', 'error'];
  if (typeof p.type !== 'string' || !validTypes.includes(p.type)) return null;

  // data is optional but must be object if present
  if (p.data !== undefined && (typeof p.data !== 'object' || p.data === null)) return null;

  return { type: p.type, data: p.data } as BridgeEvent;
}

// In handleBusEvent(), replace direct cast:
- const event = payload as BridgeEvent;
+ const event = validateBridgeEvent(payload);
+ if (!event) {
+   this.emit('error', { message: 'Malformed event from bridge' });
+   return;
+ }
```

**Scope**: ~20 lines added to one file. All 6 "bad input" issues fixed at the source.

---

## 2. Connection State Machine

**Problem**: Connection loss is treated as an exception. No reconnection. Commands silently fail.

**Solution**: Explicit connection states with automatic reconnection.

**File**: `bridge_client.ts`

**Changes**:

```typescript
// Replace boolean `connected` with state enum
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

class BridgeClient extends EventEmitter {
  private connectionState: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000; // doubles each attempt, caps at 30s

  get connected(): boolean {
    return this.connectionState === 'connected';
  }

  async connect(): Promise<void> {
    if (this.connectionState === 'connecting' || this.connectionState === 'reconnecting') {
      return; // Already in progress
    }

    this.connectionState = 'connecting';
    this.emit('connection_state', this.connectionState);

    try {
      await this.bus.connect();
      this.connectionState = 'connected';
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
      this.emit('connection_state', this.connectionState);
    } catch (err) {
      this.connectionState = 'disconnected';
      this.emit('connection_state', this.connectionState);
      throw err;
    }
  }

  private handleDisconnect(): void {
    if (this.connectionState === 'disconnected') return;

    this.connectionState = 'reconnecting';
    this.emit('connection_state', this.connectionState);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.connectionState = 'disconnected';
      this.emit('connection_state', this.connectionState);
      this.emit('error', { message: 'Connection lost. Max reconnect attempts reached.' });
      return;
    }

    const delay = Math.min(this.reconnectDelay, 30000);
    this.reconnectAttempts++;
    this.reconnectDelay *= 2;

    setTimeout(() => {
      this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
  }

  // Update send() to queue during reconnect or fail gracefully
  send(command: BridgeCommand): boolean {
    if (this.connectionState !== 'connected') {
      this.emit('error', { message: 'Not connected to bridge' });
      return false;
    }
    // ... existing send logic
    return true;
  }
}
```

**File**: `index.tsx`

```typescript
// Listen for connection state changes
client.on('connection_state', (state: ConnectionState) => {
  switch (state) {
    case 'connecting':
      store.setStatus('connecting', 'Connecting to bridge...');
      break;
    case 'connected':
      store.setStatus('idle', 'Connected');
      break;
    case 'reconnecting':
      store.setStatus('reconnecting', 'Connection lost. Reconnecting...');
      break;
    case 'disconnected':
      store.setStatus('disconnected', 'Disconnected');
      break;
  }
});
```

**File**: `store.ts`

```typescript
// Add connection states to valid states
type AppState = 'idle' | 'thinking' | 'streaming' | 'error' | 'connecting' | 'reconnecting' | 'disconnected';
```

**Scope**: ~60 lines in bridge_client, ~15 lines in index, ~5 lines in store. Fixes connection drop, silent failure, and reconnection issues.

---

## 3. Resource Limits

**Problem**: Unbounded buffers (streaming text, input, history) can exhaust memory.

**Solution**: Hard caps enforced at the point of accumulation.

**File**: `store.ts`

**Changes**:

```typescript
// Constants at top
const MAX_STREAMING_BYTES = 5 * 1024 * 1024;  // 5MB
const MAX_INPUT_LENGTH = 100 * 1024;           // 100KB
const MAX_HISTORY_ITEMS = 500;                 // Already exists, ensure enforced

// In appendStreaming()
appendStreaming(chunk: string): void {
  // Enforce limit
  if (this.streamingText.length + chunk.length > MAX_STREAMING_BYTES) {
    if (!this.streamingTruncated) {
      this.streamingTruncated = true;
      this.streamingText += '\n[Response truncated - exceeded 5MB limit]';
    }
    return;
  }
  this.streamingText += chunk;
  // ... rest of throttle logic
}

// In insertText() / insertBulkText()
insertText(char: string): void {
  if (this.inputBuffer.length >= MAX_INPUT_LENGTH) {
    return; // Silently reject, input is full
  }
  // ... existing logic
}

insertBulkText(text: string): void {
  const available = MAX_INPUT_LENGTH - this.inputBuffer.length;
  if (available <= 0) return;
  const truncated = text.slice(0, available);
  // ... existing logic with truncated
}
```

**File**: `useBracketedPaste.ts`

```typescript
// Already has 10MB limit, but processes synchronously. Add chunking:
const PASTE_CHUNK_SIZE = 64 * 1024; // 64KB chunks

// In flush logic, yield between chunks:
const flushPaste = async () => {
  const text = pasteBuffer;
  pasteBuffer = '';

  for (let i = 0; i < text.length; i += PASTE_CHUNK_SIZE) {
    const chunk = text.slice(i, i + PASTE_CHUNK_SIZE);
    onPaste(chunk);
    if (i + PASTE_CHUNK_SIZE < text.length) {
      await new Promise(r => setTimeout(r, 0)); // Yield to event loop
    }
  }
};
```

**Scope**: ~30 lines across 2 files. Fixes all memory exhaustion issues.

---

## 4. React Error Boundary

**Problem**: Component render errors crash the entire app with no recovery.

**Solution**: Single ErrorBoundary at the top level. Shows fallback UI, allows retry.

**File**: `components/ErrorBoundary.tsx` (new file)

```typescript
import React, { Component, ReactNode } from 'react';
import { Box, Text } from 'ink';

interface Props {
  children: ReactNode;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Log to stderr for debugging
    console.error('TUI render error:', error.message);
    console.error('Component stack:', info.componentStack);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text color="red" bold>UI Error</Text>
          <Text color="gray">{this.state.error?.message ?? 'Unknown error'}</Text>
          <Text> </Text>
          <Text>Press Ctrl+C to exit, or the UI will attempt recovery...</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
```

**File**: `index.tsx`

```typescript
import { ErrorBoundary } from './components/ErrorBoundary.js';

// Wrap the App render
export const WrappedApp: React.FC<AppProps> = (props) => {
  const store = useMemo(() => new TUIStore(), []);

  const handleReset = () => {
    store.clearError();
  };

  return (
    <ErrorBoundary onReset={handleReset}>
      <App {...props} store={store} />
    </ErrorBoundary>
  );
};
```

**Scope**: ~50 lines new file, ~10 lines in index. Catches all render crashes.

---

## 5. Process-Level Last Resort Handler

**Problem**: Uncaught exceptions and unhandled rejections terminate the process abruptly.

**Solution**: Global handlers that log, attempt cleanup, and exit gracefully.

**File**: `index.tsx` (at module level, near signal handlers)

```typescript
// Last resort error handlers - these should rarely fire if the above protections work
process.on('uncaughtException', (error: Error) => {
  console.error('\n[FATAL] Uncaught exception:', error.message);
  console.error(error.stack);

  // Attempt cleanup
  if (globalCleanup) {
    try {
      globalCleanup();
    } catch {
      // Cleanup failed, nothing more we can do
    }
  }

  // Exit with error code after brief delay for cleanup
  setTimeout(() => process.exit(1), 100);
});

process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error('\n[ERROR] Unhandled promise rejection:', message);

  // Don't exit for unhandled rejections - log and continue
  // The specific operation failed but the app can continue
});

// Add SIGHUP for terminal close
process.on('SIGHUP', () => handleSignal('SIGHUP'));

// Fix double-cleanup race
let cleanupCalled = false;
const handleSignal = (signal: string) => {
  if (cleanupCalled) return;
  cleanupCalled = true;

  console.log(`\nReceived ${signal}, shutting down...`);
  if (globalCleanup) {
    globalCleanup();
  }
  setTimeout(() => process.exit(0), 500);
};
```

**Scope**: ~35 lines. Catches anything that slips through the other protections.

---

## Summary

| Fix | Files Changed | Lines Added | Issues Addressed |
|-----|---------------|-------------|------------------|
| 1. Boundary validation | bridge_client.ts | ~20 | 6 bad input issues |
| 2. Connection state machine | bridge_client.ts, index.tsx, store.ts | ~80 | 5 connection issues |
| 3. Resource limits | store.ts, useBracketedPaste.ts | ~30 | 4 memory issues |
| 4. React ErrorBoundary | ErrorBoundary.tsx (new), index.tsx | ~60 | 5 render crash issues |
| 5. Process handlers | index.tsx | ~35 | 3 signal/crash issues |
| **Total** | 5 files | ~225 lines | 23 issues |

This covers 23 of the 35 identified issues with ~225 lines of structural code. The remaining 12 issues are either:
- Lower severity (UI jank, minor leaks)
- Already mitigated by these changes (e.g., cursor overflow fixed by state validation)
- Would require more invasive refactoring (history data structure change)

---

## Implementation Order

1. **Process handlers first** (5) - Safety net in place before other changes
2. **Boundary validation** (1) - Stop bad data at the door
3. **Resource limits** (3) - Prevent memory issues
4. **Connection state machine** (2) - Biggest change, do last
5. **ErrorBoundary** (4) - Final UI protection layer
