# Optimization Suggestions for `harness.ts`

## 1. Memory Leak: Subscription Cleanup

**Issue**: Lines 613 and 1107 call `unsubscribe()` inside a `queueMicrotask` finally block. If an error occurs before the microtask fires, subscriptions may leak.

**Fix**: Ensure cleanup runs synchronously for critical paths:

```typescript
// In run() and route() methods
finally {
  // Critical cleanup - run synchronously
  unsubscribe();
  
  // Non-critical async cleanup
  queueMicrotask(async () => {
    try {
      await this.persistContext(contextWindow);
      const subscriber = this.graphdSubscribers.get(sessionKey);
      subscriber?.flush();
      if (this.graphd?.graphdStarted) {
        this.graphd.setActive(false).catch(() => {});
      }
    } catch (error) {
      this.logger.warning('Async cleanup failed', { error: String(error) });
    } finally {
      eventQueue.finish();
    }
  });
}
```

## 2. Map Growth: ContextWindows Never Evicted

**Issue**: `this.contextWindows` (line 215) is a Map that grows indefinitely. Each session creates a new ContextWindow that's never removed.

**Fix**: Add LRU eviction or explicit cleanup:

```typescript
private contextWindows = new LRUCache<string, ContextWindow>({
  max: 100, // Keep last 100 sessions
  ttl: 1000 * 60 * 60 * 24, // 24 hour TTL
});

// Or in shutdown():
async shutdown(): Promise<void> {
  this.contextWindows.clear();
  // ... other cleanup
}
```

## 3. Logging Performance: Excessive String Operations

**Issue**: 44 logger calls with string concatenation and JSON.stringify happen even at log levels that may be disabled. Lines 231-239 log API keys on every init.

**Fix**: Use lazy evaluation for expensive operations:

```typescript
// Instead of:
this.logger.info('Initial API key from config', {
  provider,
  keyPrefix: key.slice(0, 8),
  keyLength: key.length,
});

// Use:
if (this.logger.debugEnabled?.()) {
  this.logger.debug('Initial API key from config', {
    provider,
    keyPrefix: key.slice(0, 8),
    keyLength: key.length,
  });
}
```

## 4. Redundant GraphD Checks

**Issue**: `this.graphd && this.graphdStarted` checked 10+ times throughout the file. Creates cognitive noise and minor overhead.

**Fix**: Add a helper method:

```typescript
private isGraphDReady(): boolean {
  return !!(this.graphd && this.graphdStarted);
}

// Usage:
if (this.isGraphDReady()) {
  this.graphd!.sessionTouch(sessionKey, workingDir);
}
```

## 5. AsyncEventQueue: Unbounded Memory Growth

**Issue**: If consumers are slow, `this.queue` (line 143) can grow indefinitely. In high-throughput scenarios, this could cause OOM.

**Fix**: Add backpressure with max queue size:

```typescript
class AsyncEventQueue {
  private queue: BridgeEvent[] = [];
  private readonly MAX_QUEUE_SIZE = 1000;

  push(event: BridgeEvent): void {
    if (this.done) return;
    
    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      this.queue.shift(); // Drop oldest
      // Or: throw new Error('Queue full');
    }
    // ... rest of push logic
  }
}
```

## 6. File Logger: No Flush on Shutdown

**Issue**: The file logger (line 176) buffers writes but has no explicit flush mechanism. If the process crashes, recent logs are lost.

**Fix**: Add explicit cleanup:

```typescript
interface HarnessLogger {
  // ... existing methods
  flush?(): Promise<void> | void;
}

function createFileLogger(logDir: string = 'logs'): HarnessLogger {
  // ... existing code
  
  return {
    // ... existing methods
    async flush() {
      flush();
      return new Promise((resolve, reject) => {
        stream.end((err) => err ? reject(err) : resolve());
      });
    },
  };
}
```

## 7. Tool Registry Validation: O(n²) Complexity

**Issue**: Line 67-76 iterates all agent configs and all tools for each, creating nested loops that scale poorly.

**Fix**: Use Set lookups:

```typescript
function buildAgentRegistry(config: FullHarnessConfig): AgentRegistry {
  const agentConfigs = /* ... */;
  const registry = new AgentRegistry(agentConfigs);

  // Pre-compute available tools as Set
  const builtinTools = new Set(['Read', 'Write', /* ... */]);
  const registeredAgentTypes = new Set(agentConfigs.map(c => c.config.type));
  
  // Single pass validation
  for (const agentConf of agentConfigs) {
    for (const tool of agentConf.config.tools) {
      if (!builtinTools.has(tool) && !registeredAgentTypes.has(tool.toLowerCase())) {
        console.warn(`[harness] Agent '${agentConf.config.type}' references unavailable tool '${tool}'`);
      }
    }
  }
  
  return registry;
}
```

## 8. Missing Shutdown Method

**Issue**: No explicit cleanup of resources (EventBus, GraphD, subscribers, file streams). Resources may not be released properly.

**Fix**: Add comprehensive shutdown:

```typescript
async shutdown(): Promise<void> {
  this.isShutdown = true;
  
  // Close all GraphD subscribers
  for (const [sessionKey, subscriber] of this.graphdSubscribers) {
    try {
      subscriber.close();
    } catch (error) {
      this.logger.warning('Failed to close subscriber', { sessionKey, error: String(error) });
    }
  }
  this.graphdSubscribers.clear();
  
  // Stop GraphD
  if (this.graphd?.graphdStarted) {
    await this.graphd.stop();
  }
  
  // Flush logger
  await this.logger.flush?.();
  
  // Clear caches
  this.contextWindows.clear();
  this.pausedState.clear();
}
```

## Priority Summary

1. **High**: Fix subscription cleanup (memory leak)
2. **High**: Add context window eviction (memory leak)
3. **Medium**: Add shutdown method (resource cleanup)
4. **Medium**: Optimize logging performance
5. **Low**: Add backpressure to event queue
6. **Low**: Helper methods for code clarity