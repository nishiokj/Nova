# TUI Store Refactor Specification

## Overview

This document outlines a comprehensive refactoring plan for `packages/tui/store.ts` to achieve **simplification**, **scalability**, and **extendability**. The current implementation is a monolithic 2000+ line class that manages all UI state, making it difficult to maintain, test, and extend.

## Current Issues

### 1. Monolithic Architecture
- Single `Store` class with 40+ private fields
- 100+ methods handling diverse concerns (chat, input, models, sessions, usage, etc.)
- No clear separation of responsibilities
- Difficult to reason about and test in isolation

### 2. Duplicated Patterns
- Multiple UI modes (models, sessions, usage) implement similar cursor/list logic
- Repeated `emit()` calls at the end of nearly every method
- Manual cloning in `getSnapshot()` for each field
- Similar selection management patterns across different domains

### 3. Tight Coupling
- UI mode transitions scattered throughout methods
- No clear state machine for mode transitions
- Direct manipulation of multiple related fields without invariants
- No clear boundaries between subsystems

### 4. Poor Extensibility
- Adding new UI modes requires modifying the central Store class
- No plugin/middleware system
- Hard to add cross-cutting concerns (logging, persistence, analytics)
- No hook system for lifecycle events

### 5. Performance Concerns
- Manual history pruning logic
- Streaming throttling mixed with business logic
- No lazy loading of expensive data
- Cache management manual and error-prone

## Proposed Architecture

### Phase 1: Modularization (Domain-Driven Sub-stores)

Decompose the monolithic `Store` into focused sub-stores, each managing a specific domain:

```
packages/tui/store/
├── index.ts              # Main Store orchestrator
├── core.ts              # Core infrastructure (Emitter, batching)
├── domains/
│   ├── history.ts       # Chat history, streaming, reasoning
│   ├── input.ts         # Input buffer, autocomplete
│   ├── question-flow.ts # Question flow state
│   ├── models.ts        # Model selection & management
│   ├── sessions.ts      # Session selection
│   ├── usage.ts         # Usage data & analytics
│   ├── ralph.ts         # Ralph loop state
│   ├── ui.ts            # UI mode, scroll, cursor, modals
│   └── capabilities.ts  # System capabilities
├── patterns/
│   ├── selection-manager.ts  # Generic list/cursor management
│   └── state-machine.ts      # UI mode state machine
└── middleware/
    └── types.ts         # Middleware interfaces
```

#### Domain Store Interface

Each domain store implements a common interface:

```typescript
interface DomainStore<TState = unknown> {
  /** Get domain state for snapshot */
  getState(): TState;
  
  /** Restore state (e.g., from persistence) */
  setState(state: TState): void;
  
  /** Get human-readable name for debugging */
  readonly name: string;
  
  /** Optional: domain-specific initialization */
  init?(ctx: StoreContext): void | Promise<void>;
  
  /** Optional: cleanup on store destruction */
  destroy?(): void | Promise<void>;
}
```

#### Selection Manager Pattern

Extract repeated cursor/list logic into a reusable class:

```typescript
class SelectionManager<T> {
  private items: T[] = [];
  private cursor: number = 0;
  private multiSelect: Set<number> = new Set();
  
  constructor(
    private config: {
      multiSelect?: boolean;
      wrapAround?: boolean;
    } = {}
  ) {}
  
  // Common operations
  setItems(items: T[]): void;
  moveCursor(delta: number): void;
  getSelectedItem(): T | null;
  getSelectedItems(): T[];
  setCursor(index: number): void;
  toggleSelection(index: number): void;
  clearSelection(): void;
  
  // For staging/transaction patterns
  stage(items: T[]): void;
  commit(): { added: T[], removed: T[], changed: T[] };
  rollback(): void;
}
```

Usage examples:

```typescript
// Models domain
this.modelManager = new SelectionManager<ModelEntry>();

// Sessions domain  
this.sessionManager = new SelectionManager<SessionEntry>();

// Usage domain
this.usageManager = new SelectionManager<UsageSessionSummary>();
```

#### State Machine for UI Modes

Replace scattered `uiMode` transitions with a formal state machine:

```typescript
type UIModeState = {
  mode: UIMode;
  data?: Record<string, unknown>;
  enterTimestamp: number;
};

type UIModeTransition = {
  from: UIMode | '*';
  to: UIMode;
  guard?: (current: UIModeState, target: UIMode) => boolean;
  action?: (current: UIModeState, target: UIMode) => void;
};

class UIModeStateMachine {
  private states: Map<UIMode, UIModeState> = new Map();
  private transitions: UIModeTransition[] = [
    { from: '*', to: 'chat', action: this.resetScrollToBottom },
    { from: 'chat', to: 'models', action: this.initModelsMode },
    { from: 'chat', to: 'sessions', action: this.initSessionsMode },
    { from: 'chat', to: 'usage', action: this.initUsageMode },
    { from: 'models', to: 'chat', action: this.cleanupModelsMode },
    { from: 'sessions', to: 'chat', action: this.cleanupSessionsMode },
    { from: 'usage', to: 'chat', action: this.cleanupUsageMode },
  ];
  
  transitionTo(targetMode: UIMode, data?: Record<string, unknown>): boolean;
  getCurrentMode(): UIMode;
  canTransitionTo(targetMode: UIMode): boolean;
}
```

### Phase 2: Core Infrastructure

#### Reactive Emitter System

Replace manual `emit()` calls with a reactive pattern:

**Option A: Proxy-based Auto-emit**

```typescript
function createReactiveStore<T extends object>(
  target: T,
  emitter: Emitter
): T {
  return new Proxy(target, {
    set(obj, prop, value) {
      const oldValue = (obj as any)[prop];
      const result = Reflect.set(obj, prop, value);
      
      // Emit if value changed and property is marked as reactive
      if (oldValue !== value && isReactiveProperty(prop)) {
        emitter.emit();
      }
      
      return result;
    }
  });
}
```

**Option B: Decorator-based**

```typescript
class HistoryStore {
  @reactive
  private history: MessageEntry[] = [];
  
  @reactive
  private streamingText = '';
  
  @reactive
  private scrollOffset = 0;
}
```

**Option C: Action-based (Redux-like)**

```typescript
type HistoryAction = 
  | { type: 'addMessage', payload: MessageEntry }
  | { type: 'appendStreaming', payload: string }
  | { type: 'finalizeStreaming' };

class HistoryStore {
  state: HistoryState;
  dispatch(action: HistoryAction): void {
    const prevState = this.state;
    this.state = this.reducer(prevState, action);
    this.emitter.emit(this.state, prevState);
  }
}
```

#### Improved Batching

Enhanced batch system with automatic commit tracking:

```typescript
class BatchManager {
  private depth = 0;
  private operations: BatchOp[] = [];
  
  batch<T>(fn: () => T): T {
    this.depth++;
    try {
      return fn();
    } finally {
      this.depth--;
      if (this.depth === 0 && this.operations.length > 0) {
        this.commit();
      }
    }
  }
  
  track<T>(domain: string, operation: string, fn: () => T): T {
    const op = { domain, operation, timestamp: Date.now() };
    this.operations.push(op);
    try {
      return fn();
    } catch (err) {
      this.operations.pop();
      throw err;
    }
  }
}
```

### Phase 3: Main Store Orchestrator

The new `Store` becomes a lightweight coordinator:

```typescript
class Store {
  // Core infrastructure
  private emitter: Emitter;
  private batchManager: BatchManager;
  private uiStateMachine: UIModeStateMachine;
  
  // Domain stores
  private domains: Map<string, DomainStore> = new Map();
  
  // Accessors for convenience (optional)
  readonly history: HistoryStore;
  readonly input: InputStore;
  readonly models: ModelsStore;
  readonly sessions: SessionsStore;
  readonly usage: UsageStore;
  readonly ui: UIStore;
  
  constructor(config: StoreConfig) {
    this.emitter = new Emitter();
    this.batchManager = new BatchManager(this.emitter);
    
    // Initialize domain stores
    this.domains.set('history', this.history = new HistoryStore(this.emitter));
    this.domains.set('input', this.input = new InputStore(this.emitter));
    // ... other domains
  }
  
  // Unified snapshot
  getSnapshot(): StoreSnapshot {
    return {
      ...this.history.getState(),
      ...this.input.getState(),
      ...this.models.getState(),
      // ... other domains
    };
  }
  
  // Subscribe to any state change
  subscribe(listener: () => void): () => void {
    return this.emitter.on(listener);
  }
  
  // Batch operations across domains
  batch<T>(fn: () => T): T {
    return this.batchManager.batch(fn);
  }
}
  
  // UI mode transitions (delegated to state machine)
  setUIMode(mode: UIMode, data?: Record<string, unknown>): boolean {
    return this.uiStateMachine.transitionTo(mode, data);
  }
}
```

### Phase 4: Middleware System

Enable cross-cutting concerns:

```typescript
type Middleware = (ctx: MiddlewareContext) => MiddlewareContext | Promise<MiddlewareContext>;

interface MiddlewareContext {
  store: Store;
  action: { domain: string; operation: string; payload: unknown };
  state: StoreSnapshot;
  prevState?: StoreSnapshot;
}

class Store {
  private middlewares: Middleware[] = [];
  
  use(middleware: Middleware): void {
    this.middlewares.push(middleware);
  }
  
  private async applyMiddleware(ctx: MiddlewareContext): Promise<MiddlewareContext> {
    let context = ctx;
    for (const middleware of this.middlewares) {
      context = await middleware(context);
    }
    return context;
  }
}

// Example middlewares:
const loggerMiddleware: Middleware = async (ctx) => {
  console.log(`[${ctx.action.domain}] ${ctx.action.operation}`);
  return ctx;
};

const persistenceMiddleware: Middleware = async (ctx) => {
  if (ctx.action.operation === 'addMessage') {
    await this.persistence.save(ctx.state);
  }
  return ctx;
};

const analyticsMiddleware: Middleware = async (ctx) => {
  if (ctx.action.domain === 'models' && ctx.action.operation === 'setModelSelection') {
    this.analytics.track('model_changed', ctx.action.payload);
  }
  return ctx;
};
```

### Phase 5: Event System for Decoupling

Replace direct cross-domain dependencies with events:

```typescript
class EventBus {
  private listeners: Map<string, Set<Function>> = new Map();
  
  on<E = unknown>(event: string, handler: (data: E) => void): () => void;
  emit<E = unknown>(event: string, data: E): void;
  off(event: string, handler: Function): void;
}

// Domain stores emit events instead of calling each other
class HistoryStore {
  addMessage(message: MessageEntry) {
    this.history.push(message);
    this.eventBus.emit('history:added', { message });
  }
}

class UIStore {
  constructor(eventBus: EventBus) {
    eventBus.on('history:added', ({ message }) => {
      this.scrollToBottom();
    });
  }
}
```

## Migration Strategy

### Step 1: Foundation (Week 1)
1. Create new directory structure under `packages/tui/store/`
2. Implement core infrastructure (`core.ts`): `Emitter`, `BatchManager`
3. Implement `SelectionManager<T>` pattern
4. Implement `UIModeStateMachine`
5. Add comprehensive tests for new infrastructure

### Step 2: Extract Domain Stores (Week 2-3)
1. Extract `HistoryStore` from existing code
2. Extract `InputStore` from existing code
3. Extract `UIStore` (uiMode, scroll, cursor, modals)
4. Update `Store` to use new domain stores
5. Maintain backward compatibility during transition
6. Add tests for each domain store

### Step 3: Migrate Remaining Domains (Week 3-4)
1. Extract `ModelsStore` using `SelectionManager`
2. Extract `SessionsStore` using `SelectionManager`
3. Extract `UsageStore` using `SelectionManager`
4. Extract `QuestionFlowStore`
5. Extract `RalphLoopStore`
6. Extract `CapabilitiesStore`

### Step 4: Implement Middleware (Week 4)
1. Define middleware types and interfaces
2. Implement middleware pipeline
3. Create example middlewares (logger, persistence, analytics)
4. Add documentation for custom middleware

### Step 5: Implement Event System (Week 5)
1. Implement `EventBus`
2. Refactor cross-domain calls to use events
3. Add event documentation
4. Test event-driven flows

### Step 6: Cleanup and Optimization (Week 6)
1. Remove old monolithic code
2. Optimize snapshot generation
3. Add TypeScript strict mode compliance
4. Update documentation
5. Performance testing and profiling

## Benefits

### Simplification
- **Reduced complexity**: Each domain store is 100-300 lines vs 2000+ monolith
- **Clear boundaries**: Easy to understand what each module does
- **Easier testing**: Mock individual domains instead of entire store
- **Better code navigation**: Smaller files with focused responsibilities

### Scalability
- **Lazy loading**: Domains can load expensive data on-demand
- **Better performance**: Targeted updates instead of full re-emits
- **Memory efficiency**: Dispose unused domains (e.g., usage analytics not always loaded)
- **Parallel operations**: Independent domains can operate concurrently

### Extendability
- **Plugin system**: Add new domains without modifying existing code
- **Middleware**: Add cross-cutting concerns without touching core logic
- **Event-driven**: New features can hook into existing flows
- **Configuration-driven**: UI modes and transitions can be configured

## Example: Adding a New Feature

### Before (Monolithic)
```typescript
// Add 20+ lines to Store class
private featureXList: FeatureXEntry[] = [];
private featureXCursor = 0;

setFeatureXList(items: FeatureXEntry[]): void {
  this.featureXList = items;
  this.featureXCursor = 0;
  this.emit();
}

moveFeatureXCursor(delta: number): void {
  // ... emit pattern repeated
}

getSelectedFeatureX(): FeatureXEntry | null {
  // ... more boilerplate
}

// Update StoreSnapshot interface
// Update getSnapshot() method
// Test entire Store class
```

### After (Modular)
```typescript
// Create new domain store (150 lines)
class FeatureXStore extends DomainStore<FeatureXState> {
  private selection = new SelectionManager<FeatureXEntry>();
  
  getState(): FeatureXState {
    return {
      items: this.selection.getItems(),
      cursor: this.selection.getCursor(),
    };
  }
}

// Register in main Store (1 line)
this.domains.set('featureX', new FeatureXStore(this.emitter));

// Optionally add middleware (5 lines)
this.use((ctx) => {
  if (ctx.action.domain === 'featureX') {
    // custom behavior
  }
  return ctx;
});

// Test FeatureXStore independently (easy!)
```

## Backward Compatibility

During migration, maintain a facade that exposes the old API:

```typescript
class Store {
  // New internal structure
  private domains: Map<string, DomainStore>;
  
  // Old API (deprecated but functional)
  setStreaming(requestId: string, text: string): void {
    console.warn('setStreaming deprecated, use history.setStreaming');
    this.history.setStreaming(requestId, text);
  }
  
  addMessage(role: Role, text: string, meta?: string, requestId?: string): void {
    console.warn('addMessage deprecated, use history.addMessage');
    this.history.addMessage(role, text, meta, requestId);
  }
}
```

## Performance Considerations

1. **Snapshot Optimization**
   - Lazy snapshot generation (only build what subscribers need)
   - Immutable state updates for efficient diffing
   - Optional selective subscription to specific domains

2. **Memory Management**
   - Automatic cleanup of unused domains
   - Weak references for event listeners
   - Configurable history limits per domain

3. **Emit Optimization**
   - Debounce rapid updates (e.g., streaming)
   - Dirty flag system to skip unnecessary emits
   - Priority queues for high-frequency events

## Testing Strategy

### Unit Tests
- Each domain store tested in isolation
- Mock dependencies (emitter, event bus)
- Test all state transitions and edge cases

### Integration Tests
- Test interactions between domains via events
- Test middleware pipeline
- Test UI mode state machine transitions

### Performance Tests
- Benchmark snapshot generation
- Test with large history (10k+ messages)
- Measure memory usage under load
- Profile emit frequency and throttling

## Documentation Requirements

1. **Architecture Overview**: Diagrams showing domain relationships
2. **Domain Store API**: Complete reference for each domain
3. **Migration Guide**: How to move from old to new API
4. **Extension Guide**: How to add new domains/middleware
5. **Event Reference**: All events and their payloads
6. **Performance Guide**: Best practices for large datasets

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking changes to TUI components | High | Facade pattern during transition |
| Performance regression | Medium | Extensive benchmarking; keep optimizations |
| Increased complexity during migration | Medium | Incremental steps; maintain tests |
| Learning curve for developers | Low | Comprehensive docs; pair programming |

## Success Metrics

- **Code organization**: Max 300 lines per file (excluding types)
- **Test coverage**: >90% for domain stores
- **Build time**: <5s (currently ~10s)
- **Memory usage**: <50MB with 1000 messages
- **Feature velocity**: New features in <4 hours vs >1 day

## Timeline Summary

| Week | Milestone |
|------|-----------|
| 1 | Foundation: Core infrastructure |
| 2-3 | Extract core domains (history, input, UI) |
| 3-4 | Extract remaining domains (models, sessions, usage, etc.) |
| 4 | Implement middleware system |
| 5 | Implement event system |
| 6 | Cleanup, optimization, documentation |

**Total: 6 weeks**

## Appendix: Code Examples

### Example 1: Complete HistoryStore

```typescript
interface HistoryState {
  entries: MessageEntry[];
  streamingText: string;
  streamingRequestId: string | null;
  reasoningText: string;
  reasoningRequestId: string | null;
  scrollOffset: number;
  newMessages: boolean;
}

class HistoryStore implements DomainStore<HistoryState> {
  readonly name = 'history';
  
  private entries: MessageEntry[] = [];
  private historyStart = 0;
  private maxHistory: number;
  
  private streamingText = '';
  private streamingRequestId: string | null = null;
  private streamingTruncated = false;
  
  private reasoningText = '';
  private reasoningRequestId: string | null = null;
  
  private scrollOffset = 0;
  private newMessages = false;
  
  private historyVersion = 0;
  private historyCache: HistoryCache | null = null;
  
  // Streaming throttle
  private streamingThrottleMs = 16;
  private lastStreamingEmit = 0;
  
  constructor(
    private emitter: Emitter,
    maxHistory = 500
  ) {
    this.maxHistory = maxHistory;
  }
  
  getState(): HistoryState {
    return {
      entries: this.entries.slice(this.historyStart),
      streamingText: this.streamingText,
      streamingRequestId: this.streamingRequestId,
      reasoningText: this.reasoningText,
      reasoningRequestId: this.reasoningRequestId,
      scrollOffset: this.scrollOffset,
      newMessages: this.newMessages,
    };
  }
  
  setState(state: HistoryState): void {
    this.entries = state.entries;
    this.streamingText = state.streamingText;
    this.streamingRequestId = state.streamingRequestId;
    this.reasoningText = state.reasoningText;
    this.reasoningRequestId = state.reasoningRequestId;
    this.scrollOffset = state.scrollOffset;
    this.newMessages = state.newMessages;
    this.historyVersion++;
    this.historyCache = null;
    this.emit();
  }
  
  // Core methods
  addMessage(role: Role, text: string, meta?: string, requestId?: string): void {
    const entry: MessageEntry = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      role,
      text,
      timestamp: Date.now(),
      meta,
      requestId,
    };
    
    this.entries.push(entry);
    this.pruneHistory();
    
    if (this.scrollOffset > 0) {
      this.newMessages = true;
    }
    
    this.historyVersion++;
    this.historyCache = null;
    this.emit();
    
    // Emit event for other domains
    this.emitter.emit('history:messageAdded', { entry });
  }
  
  // ... streaming methods, pruning, etc.
  
  private emit(): void {
    this.emitter.emit();
  }
}
```

### Example 2: Complete ModelsStore

```typescript
interface ModelsState {
  list: ModelEntry[];
  cursor: number;
  selections: Map<string, ModelSelection>;
  stagedSelections: Map<string, ModelSelection>;
  activeTab: string;
  deletePending: boolean;
}

type ModelSelection = {
  model: string;
  provider: string;
  reasoning?: string;
};

class ModelsStore implements DomainStore<ModelsState> {
  readonly name = 'models';
  
  private selectionManager = new SelectionManager<ModelEntry>();
  private selections = new Map<string, ModelSelection>();
  private stagedSelections = new Map<string, ModelSelection>();
  private activeTab = 'standard';
  private deletePending = false;
  
  constructor(private emitter: Emitter) {}
  
  getState(): ModelsState {
    return {
      list: this.selectionManager.getItems(),
      cursor: this.selectionManager.getCursor(),
      selections: new Map(this.selections),
      stagedSelections: new Map(this.stagedSelections),
      activeTab: this.activeTab,
      deletePending: this.deletePending,
    };
  }
  
  setState(state: ModelsState): void {
    this.selectionManager.setItems(state.list);
    this.selectionManager.setCursor(state.cursor);
    this.selections = new Map(state.selections);
    this.stagedSelections = new Map(state.stagedSelections);
    this.activeTab = state.activeTab;
    this.deletePending = state.deletePending;
    this.emit();
  }
  
  setList(models: ModelEntry[]): void {
    this.selectionManager.setItems(models);
    this.stagedSelections = new Map(this.selections);
    this.emit();
  }
  
  moveCursor(delta: number): void {
    this.selectionManager.moveCursor(delta);
    this.deletePending = false;
    this.emit();
  }
  
  stageCurrentModel(): ModelEntry | null {
    const model = this.selectionManager.getSelectedItem();
    if (model) {
      this.stagedSelections.set(this.activeTab, {
        model: model.id,
        provider: model.provider ?? '',
        reasoning: model.reasoning?.[0],
      });
      this.emit();
    }
    return model;
  }
  
  applyStaged(): Map<string, ModelSelection> {
    const changed = new Map<string, ModelSelection>();
    for (const [agentType, staged] of this.stagedSelections) {
      const current = this.selections.get(agentType);
      if (!current || 
          current.model !== staged.model || 
          current.provider !== staged.provider ||
          current.reasoning !== staged.reasoning) {
        changed.set(agentType, staged);
      }
    }
    
    this.selections = new Map(this.stagedSelections);
    this.emit();
    
    // Emit event for backend sync
    if (changed.size > 0) {
      this.emitter.emit('models:selectionsChanged', { changed });
    }
    
    return changed;
  }
  
  private emit(): void {
    this.emitter.emit();
  }
}
```

### Example 3: Usage in Main TUI Component

```typescript
// Before
class TUIComponent {
  constructor(private store: Store) {
    this.store.subscribe(() => this.render());
  }
  
  render() {
    const snapshot = this.store.getSnapshot();
    // Use snapshot.state, snapshot.modelsList, etc.
  }
}

// After (more granular control)
class TUIComponent {
  constructor(private store: Store) {
    // Subscribe to all changes (same as before)
    this.store.subscribe(() => this.render());
    
    // OR subscribe to specific domains
    this.store.history.subscribe(() => this.renderHistory());
    this.store.models.subscribe(() => this.renderModelsPanel());
  }
  
  render() {
    const history = this.store.history.getState();
    const models = this.store.models.getState();
    // Use specific domain states
  }
}
```

## Conclusion

This refactor transforms the TUI store from a monolithic maintenance burden into a modular, scalable foundation. The phased approach minimizes risk while delivering incremental benefits. Each phase produces working, tested code that can be used immediately.

The investment pays dividends in:
- **Developer velocity**: Faster feature development
- **Code quality**: Easier to understand, test, and maintain
- **Performance**: Optimized state management and updates
- **Future-proofing**: Easy to extend and adapt to new requirements

---

**Document Version**: 1.0  
**Last Updated**: 2026-01-20  
**Author**: TUI Store Refactor Team  
**Status**: Draft - Pending Review
