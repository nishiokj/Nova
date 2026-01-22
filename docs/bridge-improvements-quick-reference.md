# Bridge Improvements - Quick Reference Guide

## 🎯 Top 3 Fixes (Do These First)

### 1. Memory Leak Fix - BridgeClient
**File:** `packages/tui/bridge_client.ts`
**Lines:** `sendAuthCommand()` method

```typescript
// Add request tracking
private pendingRequests = new Map<string, PendingRequest>();

// Rewrite sendAuthCommand to use correlation IDs
private sendAuthCommand<T>(type: BridgeCommandType, data: Record<string, unknown>): Promise<T> {
  const requestId = generateRequestId();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      this.pendingRequests.delete(requestId);
      reject(new Error('Request timeout'));
    }, 30000);

    this.pendingRequests.set(requestId, { resolve, reject, timeout, commandType: type });

    this.send({ type, data: { ...data, _requestId: requestId } });
  });
}

// Update handleBusEvent to match by requestId
if (metadata?._requestId && this.pendingRequests.has(metadata._requestId)) {
  const pending = this.pendingRequests.get(metadata._requestId)!;
  clearTimeout(pending.timeout);
  this.pendingRequests.delete(metadata._requestId);
  pending.resolve(metadata.payload ?? { success: false });
}
```

**See:** `docs/bridge-client-memory-leak-fix.md`

---

### 2. Reconnect Delay Reset - BridgeClient
**File:** `packages/tui/bridge_client.ts`
**Lines:** `scheduleReconnect()` method

```typescript
// Add this after the connect() call in scheduleReconnect
this.connect()
  .then(() => {
    // ✅ Reset delay after successful reconnection
    if (this.connectionState === 'connected') {
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
    }
  })
  .catch(() => {
    this.connectionState = 'reconnecting';
    this.emit('connection_state', this.connectionState);
    this.scheduleReconnect();
  });
```

---

### 3. Complete Truncated Ralph Loop Handlers
**File:** `packages/harness-daemon/src/harness/bridge_gateway.ts`
**Lines:** Missing ~100 lines at the end

```typescript
// Add these methods at the end of BridgeGateway class

private handleRalphLoopStart(
  connectionId: string,
  data: Record<string, unknown> | undefined,
  state: ConnectionState
): void {
  // Implementation needed - check orchestrator package for reference
  // Similar to handleSendText but with Ralph stop hook
}

private handleRalphLoopCancel(connectionId: string, state: ConnectionState): void {
  if (!state.ralphLoop) {
    this.sendError(connectionId, 'No active Ralph loop to cancel');
    return;
  }

  state.ralphLoop.cancelled = true;
  this.sendAuthResponse(connectionId, 'ralph_loop_cancel', {
    success: true,
    message: 'Ralph loop cancelled',
  });
}
```

**Check:** `packages/orchestrator/src/` for Ralph loop implementation patterns

---

## 📋 All Issues at a Glance

| Issue | File | Priority | Effort | Status |
|-------|------|----------|--------|--------|
| Memory leak | `bridge_client.ts` | 🔴 Critical | 2-3 hrs | Not started |
| Monolith | `bridge_gateway.ts` | 🔴 Critical | 8-12 hrs | Not started |
| Truncated file | `bridge_gateway.ts` | 🔴 Critical | 2-4 hrs | Not started |
| Reconnect delay | `bridge_client.ts` | 🟡 Moderate | 15 min | Not started |
| Error visibility | `bridge_client.ts` | 🟡 Moderate | 1 hr | Not started |
| Data mutation | `bridge_gateway.ts` | 🟡 Moderate | 30 min | Not started |
| Duplicate events | `bridge_gateway.ts` | 🟡 Moderate | 15 min | Not started |

---

## 🔧 Code Snippets by File

### BridgeClient (`packages/tui/bridge_client.ts`)

#### Memory Leak Fix
Add to class properties:
```typescript
private pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  timestamp: number;
  commandType: BridgeCommandType;
}>();
```

Replace `sendAuthCommand`:
```typescript
private sendAuthCommand<T extends Record<string, unknown>>(
  type: BridgeCommandType,
  data: Record<string, unknown>
): Promise<T> {
  const requestId = generateRequestId();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request timeout: ${type} (${requestId})`));
      }
    }, 30000);

    this.pendingRequests.set(requestId, {
      resolve,
      reject,
      timeout,
      timestamp: Date.now(),
      commandType: type,
    });

    this.send({
      type,
      data: { ...data, _requestId: requestId },
    });
  });
}
```

Update `handleBusEvent`:
```typescript
if (event.type === "response") {
  const responseData = event.data as ResponseData;
  const requestId = typeof responseData.request_id === "string" ? responseData.request_id : "";

  // Clean up active runs
  if (requestId && this.activeRuns.has(requestId)) {
    this.activeRuns.delete(requestId);
    this.bus.unsubscribe(runChannel(requestId));
  }

  // NEW: Check for pending auth request correlation
  const metadata = responseData?.metadata as {
    kind?: string;
    _requestId?: string;
    payload?: unknown;
  } | undefined;

  if (metadata?._requestId && this.pendingRequests.has(metadata._requestId)) {
    const pending = this.pendingRequests.get(metadata._requestId)!;
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(metadata._requestId);
    pending.resolve(metadata.payload ?? { success: false });
  }
}
```

Update `close()` method:
```typescript
close(): void {
  // Cancel any pending reconnection
  if (this.reconnectTimer) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  // Reject all pending requests
  for (const [requestId, pending] of this.pendingRequests.entries()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('Connection closed'));
  }
  this.pendingRequests.clear();

  this.connectionState = 'disconnected';
  this.sessionKey = null;
  this.activeRuns.clear();
  this.bus.close();
  this.emit('connection_state', this.connectionState);
}
```

#### Reconnect Delay Fix
```typescript
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

  this.reconnectTimer = setTimeout(() => {
    this.reconnectTimer = null;
    this.connect()
      .then(() => {
        // ✅ Reset delay after successful reconnection
        if (this.connectionState === 'connected') {
          this.reconnectAttempts = 0;
          this.reconnectDelay = 1000;
        }
      })
      .catch(() => {
        this.connectionState = 'reconnecting';
        this.emit('connection_state', this.connectionState);
        this.scheduleReconnect();
      });
  }, delay);
}
```

---

### BridgeGateway (`packages/harness-daemon/src/harness/bridge_gateway.ts`)

#### Duplicate Model Changed Events Fix
In `handleInit()` method, remove duplicate emission:

```typescript
// Keep only ONE of these emission blocks

// Option 1: Emit selections after loading
if (graphd) {
  this.hydrateSessionModelSelections(sessionKey);
  const allSelections = this.harness.getAllSessionSelectedModels?.(sessionKey) ?? new Map();
  const agentTypes = ['standard', 'explorer', 'coding'];
  for (const agentType of agentTypes) {
    const selection = allSelections.get(agentType) ?? null;
    this.sendEvent(connectionId, {
      type: 'model_changed',
      data: {
        agentType,
        selectedModel: selection?.model ?? null,
        selectedProvider: selection?.provider ?? null,
        provider: selection?.provider ?? null,
        model: selection?.model ?? null,
        reasoning: selection?.reasoning ?? null,
      },
    }, sessionChannel(sessionKey));
  }
} else {
  // Emit null selections for all agent types
  const agentTypes = ['standard', 'explorer', 'coding'];
  for (const agentType of agentTypes) {
    this.sendEvent(connectionId, {
      type: 'model_changed',
      data: {
        agentType,
        selectedModel: null,
        selectedProvider: null,
        provider: null,
        model: null,
        reasoning: null,
      },
    }, sessionChannel(sessionKey));
  }
}
```

Remove the duplicate emission earlier in the method.

---

## 📚 Documentation Index

| Document | Purpose | Lines |
|----------|---------|-------|
| `bridge-improvements-summary.md` | Executive summary with priorities | 269 |
| `bridge-improvement-plan.md` | Comprehensive analysis of all issues | 398 |
| `bridge-client-memory-leak-fix.md` | Detailed memory leak fix with tests | 333 |
| `bridge-gateway-refactoring-plan.md` | Complete refactoring strategy | 746 |
| `bridge-improvements-quick-reference.md` | This file - code snippets at a glance | - |

---

## 🚀 Getting Started

### Quick Wins (< 1 hour)
1. Reconnect delay fix (15 min)
2. Duplicate events removal (15 min)
3. Data mutation fixes (30 min)

### Critical Fixes (2-3 hours)
1. Memory leak fix (2-3 hours)

### Major Refactoring (8-12 hours)
1. BridgeGateway handler extraction

---

## ✅ Checklist

- [ ] Fix memory leak in BridgeClient
- [ ] Reset reconnect delay after successful reconnection
- [ ] Complete truncated Ralph Loop handlers
- [ ] Remove duplicate model_changed events
- [ ] Fix data mutation patterns
- [ ] Improve error visibility in `send()`
- [ ] Add proper type guards/validation
- [ ] Extract handlers from BridgeGateway
- [ ] Implement CommandRouter pattern
- [ ] Add comprehensive tests
- [ ] Update documentation

---

## 📞 Need Help?

- **Memory leak details:** `docs/bridge-client-memory-leak-fix.md`
- **Refactoring guide:** `docs/bridge-gateway-refactoring-plan.md`
- **Full analysis:** `docs/bridge-improvement-plan.md`
- **Executive summary:** `docs/bridge-improvements-summary.md`
