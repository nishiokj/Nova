# BridgeClient Memory Leak Fix - Detailed Implementation

## The Problem

The `sendAuthCommand` method has a memory leak that causes event handlers to accumulate over time.

### Current Code (Buggy)

```typescript
private sendAuthCommand<T extends Record<string, unknown>>(
  type: BridgeCommandType,
  data: Record<string, unknown>
): Promise<T> {
  return new Promise((resolve) => {
    const handler = (event: BridgeEvent) => {
      if (event.type === 'response') {
        const responseData = event.data as ResponseData;
        const metadata = responseData?.metadata as { kind?: string; payload?: unknown } | undefined;
        if (metadata?.kind === type) {
          this.off('event', handler); // ✅ Handler removed on SUCCESS
          resolve((metadata.payload ?? { success: false }) as T);
        }
      }
    };

    this.on('event', handler);

    // Timeout after 30 seconds
    setTimeout(() => {
      this.off('event', handler); // ✅ Handler removed on TIMEOUT
      resolve({ success: false, error: 'Request timeout' } as unknown as T);
    }, 30000);

    this.send({ type, data });
  });
}
```

### Why This Leaks

1. **Multiple concurrent requests**: If you call `authStart()` and `authPoll()` simultaneously, both handlers listen to ALL 'response' events
2. **No correlation**: Handlers match only by `metadata.kind === type`, not by request ID
3. **Response could match wrong handler**: An `auth_poll` response could resolve an `auth_start` promise if they both have the same `type` value
4. **Race conditions**: If a response arrives before the timeout is set, the timeout still fires later (though `off()` prevents double-resolution)

---

## Solution: Request Correlation Pattern

### Step 1: Add Request Tracking State

```typescript
export class BridgeClient extends EventEmitter {
  // ... existing properties

  private pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
    timestamp: number;
    commandType: BridgeCommandType;
  }>();
```

### Step 2: Generate Correlation IDs

```typescript
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
```

### Step 3: Rewrite `sendAuthCommand` with Correlation

```typescript
private sendAuthCommand<T extends Record<string, unknown>>(
  type: BridgeCommandType,
  data: Record<string, unknown>
): Promise<T> {
  const requestId = generateRequestId();
  const timestamp = Date.now();

  return new Promise((resolve, reject) => {
    // Set up timeout
    const timeout = setTimeout(() => {
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request timeout: ${type} (${requestId})`));
      }
    }, 30000);

    // Register pending request
    this.pendingRequests.set(requestId, {
      resolve,
      reject,
      timeout,
      timestamp,
      commandType: type,
    });

    // Send command with correlation ID
    this.send({
      type,
      data: {
        ...data,
        _requestId: requestId, // Correlation ID
      },
    });
  });
}
```

### Step 4: Update `handleBusEvent` to Match by Request ID

```typescript
private handleBusEvent(payload: unknown): void {
  const event = validateBridgeEvent(payload);
  if (!event) {
    this.emit('error', { message: 'Malformed event from bridge' });
    return;
  }

  // Handle ready event
  if (event.type === "ready") {
    const data = (event.data ?? {}) as ReadyData;
    if (data.session_key && data.session_key !== this.sessionKey) {
      if (this.sessionKey) {
        this.bus.unsubscribe(sessionChannel(this.sessionKey));
      }
      this.sessionKey = data.session_key;
      this.bus.subscribe(sessionChannel(data.session_key));
    }
  }

  // Handle response events - check for correlation ID
  if (event.type === "response") {
    const responseData = event.data as ResponseData;

    // Clean up active runs (existing logic)
    const requestId = typeof responseData.request_id === "string" ? responseData.request_id : "";
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

      // Clear timeout and remove from pending
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(metadata._requestId);

      // Resolve the promise
      const payload = metadata.payload ?? { success: false };
      pending.resolve(payload as T);
    }
  }

  // Emit to listeners
  this.emit("event", event);
}
```

### Step 5: Update BridgeGateway to Echo Correlation IDs

```typescript
// In BridgeGateway's handlers, ensure responses include the correlation ID
private handleAuthStart(connectionId: string, data: Record<string, unknown> | undefined): void {
  // ... existing validation ...

  const requestId = data?._requestId as string | undefined;

  const result = this.authService.startAuth(deviceName);

  this.sendAuthResponse(connectionId, 'auth_start', {
    success: true,
    authUrl: result.authUrl,
    stateToken: result.stateToken,
  }, requestId); // Pass requestId through
}

// Update sendAuthResponse to include requestId
private sendAuthResponse(
  connectionId: string,
  kind: string,
  payload: Record<string, unknown>,
  requestId?: string
): void {
  this.sendEvent(connectionId, {
    type: 'response',
    data: {
      success: true,
      content: '',
      metadata: {
        kind,
        payload,
        _requestId: requestId, // Echo correlation ID
      },
    },
  });
}
```

---

## Additional Improvements

### Cleanup on Disconnect

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

### Reconnect Delay Fix

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
        // Connect failed, try again
        this.connectionState = 'reconnecting';
        this.emit('connection_state', this.connectionState);
        this.scheduleReconnect();
      });
  }, delay);
}
```

---

## Testing the Fix

### Test 1: Single Request

```typescript
// Should work as before
const result = await client.authPoll(stateToken);
assert(result.success === true);
```

### Test 2: Concurrent Requests

```typescript
// Should resolve correctly without interfering
const [result1, result2] = await Promise.all([
  client.authStart('device1'),
  client.authStart('device2'),
]);
assert(result1.authUrl !== result2.authUrl);
```

### Test 3: Timeout

```typescript
// Should reject after timeout
await expect(client.authPoll('invalid-token')).rejects.toThrow('Request timeout');
```

### Test 4: Connection Close

```typescript
// Should reject pending requests
const promise = client.authStart('device1');
client.close();
await expect(promise).rejects.toThrow('Connection closed');
```

### Test 5: No Memory Leak

```typescript
// Verify pending requests are cleaned up
const initialCount = client['pendingRequests'].size;
await client.authStart('device1');
assert(client['pendingRequests'].size === initialCount); // Should be cleaned up
```

---

## Benefits

1. ✅ **No memory leaks**: Each request creates exactly one handler, which is always cleaned up
2. ✅ **Request isolation**: Concurrent requests don't interfere with each other
3. ✅ **Better error handling**: Reject with timeout errors instead of resolving with error objects
4. ✅ **Debuggability**: Request IDs in logs help track request lifecycles
5. ✅ **Testability**: Easier to test individual request flows
