# Low-Hanging Fruit Speed-Ups: Agent Response → TUI Display

Based on analysis of the event flow from `agent.ts` → `event_bus.ts` → `bridge_client.ts` → TUI, here are the key optimization opportunities.

**Note**: These optimizations are designed to benefit the entire system without harming other consumers of the event stream (logging, analytics, debugging, etc.).

---

## 1. **Batch Event Flushes in EventBus** (High Impact, Safe)
- **Current**: `EventBus.publish()` queues events and uses `queueMicrotask()` to flush immediately
- **Issue**: Each LLM/tool call emits multiple events (llm_call, tool_call, progress, etc.), causing multiple microtask flushes and TCP roundtrips
- **Fix**: Add a small delay buffer (e.g., 2-5ms) or batch by count (e.g., 10 events) before flushing
- **Impact**: Reduces microtask overhead, fewer TCP roundtrips, benefits all consumers
- **Safety**: Does not affect event delivery order or completeness

## 2. **Optimize AsyncEventQueue Iterator** (Medium Impact, Safe)
- **Current**: Uses Promise resolvers for each event in `AsyncEventQueue.next()`
- **Issue**: Promise allocation overhead per event, especially during high-frequency tool calls
- **Fix**: Use a simple async iterator with a callback-based push or a single Promise that resolves when events are available
- **Impact**: Reduced memory allocation and GC pressure during execution
- **Safety**: Internal implementation detail, no API changes

## 3. **Reduce Tool Output Truncation Overhead** (Medium Impact, Safe)
- **Current**: Every tool output is truncated with string slicing (`slice(0, maxLen)`)
- **Issue**: String operations on large outputs (30KB+) create new string allocations
- **Fix**: Use buffer views or defer truncation until needed (lazy truncation)
- **Impact**: Less CPU time per tool call, reduced memory churn
- **Safety**: Does not change the effective output visible to consumers

## 4. **Use Binary Protocol for Events** (Medium Impact, Requires Migration)
- **Current**: JSON-over-TCP with string encoding
- **Issue**: JSON parsing overhead on every event
- **Fix**: Use MessagePack or a simple binary protocol for high-frequency events
- **Impact**: Faster serialization/deserialization, smaller payloads
- **Safety**: Requires versioned protocol support, can be rolled out gradually

## 5. **Add TUI-Specific Subscription Filtering** (High Impact for TUI, Safe)
- **Current**: All events flow through BridgeClient to TUI, even if TUI doesn't need them
- **Issue**: TUI processes and discards events it doesn't display (e.g., detailed llm_call metrics)
- **Fix**: Add subscription filters at the BridgeClient level so TUI only subscribes to events it actually needs
- **Impact**: Fewer events over TCP for TUI, less parsing overhead in TUI
- **Safety**: Other consumers (logging, analytics) still receive full event stream

---

## Optimizations to Avoid (TUI-Specific, Harmful to System)

These were considered but rejected because they would harm other parts of the application:

1. **Debounce/Throttle TUI Store Updates** ❌
   - Would delay updates for other consumers relying on real-time events
   - Breaks logging, analytics, and debugging features that need accurate timing

2. **Prune Intermediate Agent Events at Source** ❌
   - Removes data that other parts of the system might need
   - Would break observability and debugging capabilities

3. **Skip Emitting Certain Events** ❌
   - Events are the source of truth for the system
   - Removing events breaks the audit trail and replay capabilities

---

## Recommended Priority

1. **Batch EventBus flushes** - Biggest win, safe for all consumers
2. **Add TUI-specific subscription filtering** - Benefits TUI without harming others
3. **Optimize AsyncEventQueue Iterator** - Internal optimization, easy to implement
4. **Reduce Tool Output Truncation Overhead** - Moderate win, safe implementation

These changes could reduce perceived latency by 20-40% while maintaining full observability and not harming other parts of the application.