# TUI Modularization Plan

## Current State Analysis

### Overview
The TUI (`packages/tui/`) is partially well-modularized but has significant monolithic issues.

### Well-Modularized Components ✅
- **Store** (`store.ts` - 900+ lines): Clean state management class with:
  - Batching support for efficient re-renders
  - History caching to prevent unnecessary text wrapping
  - Resource limits (MAX_STREAMING_BYTES, MAX_INPUT_LENGTH)
  - Separate domains: input, history, questions, models, sessions, usage, Ralph Loop
  
- **BridgeClient** (`bridge_client.ts` - 300+ lines): TCP client with:
  - Connection state machine (`disconnected | connecting | connected | reconnecting`)
  - Automatic reconnection with exponential backoff
  - Auth command methods (OAuth, providers, session management)
  - Runtime validation of bridge events

- **InputBuffer** (`buffer.ts` - 268 lines): Text input management with:
  - Multi-line editing support
  - Cursor movement (up/down/left/right)
  - Bulk insert optimization for large pastes
  - Input limit enforcement (100KB)

- **FileCache** (`file_cache.ts` - 180 lines): File system caching for autocomplete:
  - Background refresh every 5 seconds
  - Fuzzy matching for file suggestions
  - Configurable ignore patterns

- **UILogger** (`logger.ts` - 104 lines): Logging with redaction:
  - Transcript logging (user/voice/system)
  - Configurable redaction
  - File stream management

- **Commands** (`commands.ts`): Slash command parsing and help text

- **Components**: 10+ React components in `components/`:
  - `ProvidersView` - Provider API key management
  - `SessionsView` - Session selection UI
  - `UsageView` - Usage analytics display
  - `QuestionPrompt` - Agent question flows
  - `ResponsePane` - Diff rendering for responses
  - `ErrorBoundary` - Error handling wrapper
  - `MultiSelect`, `SingleSelect`, `TextInputField` - Form components

- **Utils**: Text wrapping, paste handling, markdown rendering, fork spawning

- **Hooks**: `useBracketedPaste`, `useMouse` (in root directory)

### The Problem: `index.tsx` (~2000 lines) Contains Too Much ❌

#### 1. Event Handlers (~400 lines)
```typescript
handleReady(data)
handleStatus(data)
handleProgress(data)
handleStream(data)
handleResponse(data)
handleTranscription(data)
handleUserPrompt(data)
handleProviderKeyRequired(data)
handleModelChanged(data)
handleError(data)
handleSkillsPayload(payload, content)
handleHooksPayload(payload, content)
```

**Issues:**
- Each handler directly calls `store.batch()` and multiple store methods
- Business logic mixed with state updates
- No separation between protocol parsing and domain logic
- Complex nested conditionals (especially in `handleResponse`)

#### 2. Keyboard Input Handling (~400 lines in `useInput`)
```typescript
useInput((input, key) => {
  // 400+ lines of nested conditionals handling:
  // - Global shortcuts (Ctrl+C, F1)
  // - Help mode
  // - UI mode switching (skills, hooks, usage, providers, response, theme, models, sessions)
  // - Question mode navigation
  // - Text editing (navigation, deletion, paste)
  // - Autocomplete navigation
  // - Leader-key shortcuts (Esc then M, Esc then R)
  // - Voice recording
  // - Ralph Loop commands
  // - Fork operations
})
```

**Issues:**
- All keyboard logic in one massive callback
- Mode-specific key handling scattered throughout
- Deeply nested conditionals (6+ levels in some paths)
- Difficult to add new keyboard shortcuts or modes
- No clear separation between:
  - Global shortcuts
  - Mode-specific handlers
  - Text editing operations
  - Navigation operations

#### 3. Slash Command Handlers (~200 lines)
```typescript
handleConfig()
handleModels(arg)
handleProviders(arg)
handleSkillsCommand(arg)
handleHooksCommand(arg)
handleTheme(arg)
handleSessions(arg)
handleUsage(arg)
handleFork()
handleDelete(arg)
handleCompact()
handlePlan(arg)
handleRalphLoop(arg)
handleVoice(arg)
handleClear()
handleExit()
```

**Issues:**
- All command handlers mixed in `useInput` logic
- No central registry or dispatch pattern
- Command parsing happens inline
- Difficult to add new commands

#### 4. Business Logic (~200 lines)
```typescript
parseRalphArgs(arg)                    // ~60 lines - Ralph Loop argument parsing
resolveGraphdUrl()                     // Environment variable resolution
resolveBusConfig()                     // Environment variable resolution
fetchWithTimeout()                     // Fetch wrapper with timeout
fetchGraphdSessions()                  // GraphD API calls
deleteGraphdSession()                  // GraphD API calls
fetchUsageData()                       // Complex usage computation
```

**Issues:**
- GraphD API calls directly in component
- Complex data transformation logic inline
- No separation between API and business logic
- Environment variable handling scattered

#### 5. Voice State Management (~100 lines)
```typescript
const voiceStateRef = useRef({
  recording: false,
  repeatConfirmed: false,
  startAt: 0,
  lastSpaceAt: 0,
  manualStopMode: false,
  interval: null,
});
// Voice start/stop logic mixed in useInput
```

**Issues:**
- Complex state machine hidden in a ref
- Voice start/stop logic scattered
- No clear voice mode lifecycle

#### 6. UI Mode Management
```typescript
// Mode switching logic scattered throughout:
// - useInput: switching between chat, skills, hooks, providers, theme, models, sessions, usage, response, question
// - Event handlers: switching to skills/hooks mode on response
// - Store methods: store.setUIMode()
// - Component rendering: switch on snapshot.uiMode
```

**Issues:**
- No clear state machine for mode transitions
- Mode-specific state mixed in Store
- No validation of valid mode transitions
- Side effects on mode change scattered

---

## Architectural Proposal

### Option A: Custom React Hooks Pattern
Extract logic into custom hooks that can be reused:

```typescript
// useBridgeEvents.ts
export function useBridgeEvents(
  client: BridgeClient,
  store: Store,
  logger: UILogger
) {
  // All event handling logic here
}

// useKeyboardInput.ts
export function useKeyboardInput(
  store: Store,
  fileCache: FileCache,
  handlers: CommandHandlers
) {
  // All keyboard logic here
}

// useCommands.ts
export function useCommands(
  store: Store,
  client: BridgeClient,
  // ...
) {
  // Slash command registry and handlers
}

// useVoice.ts
export function useVoice(
  store: Store,
  client: BridgeClient
) {
  // Voice state machine and lifecycle
}

// useGraphD.ts
export function useGraphD() {
  // GraphD API calls
  return {
    fetchSessions,
    deleteSession,
    fetchUsage,
  };
}
```

**Pros:**
- Leverages React patterns
- Clean separation of concerns
- Easy to test with hooks testing library
- Stateful logic (refs, effects) stays in hooks

**Cons:**
- Still requires passing many dependencies
- Doesn't fully address business logic separation

---

### Option B: Service Layer Pattern
Extract logic into service classes:

```typescript
// services/EventService.ts
export class EventService {
  constructor(
    private store: Store,
    private logger: UILogger
  ) {}
  
  handleReady(data: ReadyData) { /* ... */ }
  handleStatus(data: StatusData) { /* ... */ }
  // All event handlers
}

// services/CommandService.ts
export class CommandService {
  private handlers = new Map<string, CommandHandler>();
  
  register(name: string, handler: CommandHandler) { /* ... */ }
  execute(command: string, arg?: string) { /* ... */ }
}

// services/KeyboardService.ts
export class KeyboardService {
  private modeHandlers = new Map<UIMode, KeyHandler>();
  
  registerMode(mode: UIMode, handler: KeyHandler) { /* ... */ }
  handleInput(input: string, key: Key) { /* ... */ }
}

// services/VoiceService.ts
export class VoiceService {
  private state: VoiceState = { /* ... */ };
  
  startRecording() { /* ... */ }
  stopRecording() { /* ... */ }
}

// services/GraphDService.ts
export class GraphDService {
  fetchSessions(): Promise<GraphDSession[]>
  deleteSession(key: string): Promise<boolean>
  fetchUsage(): Promise<UsageData>
}
```

**Pros:**
- Clear business logic layer
- Easy to mock for testing
- Service classes can be reused outside React

**Cons:**
- More boilerplate
- Need to bridge between services and React components

---

### Option C: Pure Function Organization
Extract logic into pure functions organized by domain:

```typescript
// eventHandlers/ready.ts
export function handleReady(data: ReadyData, store: Store) { /* ... */ }

// eventHandlers/response.ts
export function handleResponse(data: ResponseData, store: Store) { /* ... */ }

// commands/ralph.ts
export function parseRalphArgs(arg: string): RalphArgs | null { /* ... */ }
export function handleRalphLoop(arg: string, store: Store, client: BridgeClient) { /* ... */ }

// commands/models.ts
export function handleModels(arg: string, store: Store, client: BridgeClient) { /* ... */ }

// keyboard/globalShortcuts.ts
export function handleGlobalShortcut(input: string, key: Key): ShortcutAction | null { /* ... */ }

// keyboard/navigation.ts
export function handleNavigation(key: Key, store: Store): boolean { /* ... */ }

// keyboard/textEditing.ts
export function handleTextEdit(input: string, key: Key, store: Store): boolean { /* ... */ }

// keyboard/modeHandlers.ts
export function handleChatMode(input: string, key: Key, context: KeyboardContext): boolean { /* ... */ }
export function handleQuestionMode(input: string, key: Key, context: KeyboardContext): boolean { /* ... */ }
// ... one per mode

// api/graphd.ts
export async function fetchSessions(): Promise<GraphDSession[]> { /* ... */ }
export async function deleteSession(key: string): Promise<boolean> { /* ... */ }
export async function fetchUsage(): Promise<UsageData> { /* ... */ }
```

**Pros:**
- Maximum testability (pure functions)
- Clear separation of domains
- Easy to understand data flow
- No hidden state

**Cons:**
- Need to pass many parameters
- Stateful logic (like voice) still needs another approach

---

### Option D: Hybrid Approach (Recommended)

Combine the best of all patterns:

```typescript
// ==================== Event Handling ====================
// hooks/useBridgeEvents.ts
export function useBridgeEvents(client: BridgeClient, store: Store, logger: UILogger) {
  // Pure event handlers for protocol parsing
  const handleReady = useCallback((data: ReadyData) => {
    // Protocol parsing and business logic separation
    handleReadyProtocol(data, store);
    handleReadySideEffects(data, client, store);
  }, [store, client]);

  // Register all handlers
  useEffect(() => {
    client.on('ready', handleReady);
    // ...
  }, []);
}

// eventHandlers/ready.ts
export function handleReadyProtocol(data: ReadyData, store: Store) {
  // Pure protocol parsing logic
  if (data.session_key) store.setSessionKey(data.session_key);
  if (data.capabilities) {
    store.setCapabilities({
      voiceAvailable: data.capabilities.voice_available,
      streamingSupported: data.capabilities.streaming_supported,
    });
  }
}

// ==================== Commands ====================
// commands/registry.ts
export const COMMAND_HANDLERS = {
  '/help': handleHelp,
  '/config': handleConfig,
  '/models': handleModels,
  '/providers': handleProviders,
  '/skills': handleSkills,
  '/hooks': handleHooks,
  '/theme': handleTheme,
  '/sessions': handleSessions,
  '/usage': handleUsage,
  '/fork': handleFork,
  '/delete': handleDelete,
  '/compact': handleCompact,
  '/plan': handlePlan,
  '/ralph-loop': handleRalphLoop,
  '/voice': handleVoice,
  '/clear': handleClear,
  '/exit': handleExit,
} as const;

// commands/ralph.ts
export function handleRalphLoop(arg: string, context: CommandContext) {
  const parsed = parseRalphArgs(arg);
  if (!parsed) {
    context.store.addMessage('system', 'Invalid Ralph Loop arguments');
    return;
  }
  startRalphLoop(parsed, context);
}

// ==================== Keyboard ====================
// keyboard/dispatcher.ts
export class KeyboardDispatcher {
  constructor(
    private store: Store,
    private commandExecutor: CommandExecutor,
    private modeHandlers: Map<UIMode, KeyHandler>
  ) {}
  
  handleInput(input: string, key: Key): boolean {
    // Check global shortcuts first
    const globalAction = handleGlobalShortcut(input, key);
    if (globalAction) {
      globalAction.execute();
      return true;
    }
    
    // Delegate to mode handler
    const mode = this.store.getSnapshot().uiMode;
    const handler = this.modeHandlers.get(mode);
    return handler?.handle(input, key, this.context) ?? false;
  }
}

// keyboard/modes/chat.ts
export class ChatModeHandler implements KeyHandler {
  handle(input: string, key: Key, context: KeyboardContext): boolean {
    // Text editing
    if (handleTextEdit(input, key, context.store)) return true;
    
    // Navigation
    if (handleNavigation(key, context.store)) return true;
    
    // Autocomplete
    if (handleAutocomplete(key, context.store)) return true;
    
    // Send message
    if (key.return && !key.shift) {
      context.commandExecutor.executeSendMessage();
      return true;
    }
    
    return false;
  }
}

// ==================== Services for Stateful Logic ====================
// services/VoiceService.ts
export class VoiceService {
  private state: VoiceState = {
    recording: false,
    repeatConfirmed: false,
    startAt: 0,
    lastSpaceAt: 0,
    manualStopMode: false,
    interval: null,
  };
  
  startRecording(client: BridgeClient) {
    this.state.recording = true;
    this.state.startAt = Date.now();
    client.send({ type: 'voice_start' });
  }
  
  stopRecording(client: BridgeClient) {
    this.state.recording = false;
    if (this.state.interval) {
      clearInterval(this.state.interval);
      this.state.interval = null;
    }
    client.send({ type: 'voice_stop' });
  }
}

// services/GraphDService.ts
export class GraphDService {
  async fetchSessions(): Promise<GraphDSession[]> {
    const url = this.resolveGraphdUrl();
    const response = await fetchWithTimeout(`${url}/export?table=sessions`);
    const payload = await response.json();
    return this.parseSessions(payload);
  }
  
  async fetchUsage(): Promise<UsageData> {
    const [sessions, messages] = await Promise.all([
      this.fetchSessions(),
      this.fetchMessages(),
    ]);
    return this.computeUsageStats(sessions, messages);
  }
}
```

---

## Detailed Implementation Plan

### Phase 1: Extract Business Logic (Services)

**Goal**: Remove all business logic from `index.tsx`

**New Files:**
```
packages/tui/services/
├── VoiceService.ts           # Voice state machine
├── GraphDService.ts          # GraphD API calls
└── index.ts                 # Re-export services
```

**Changes:**
- `VoiceService`: Extract all voice-related state and logic
- `GraphDService`: Extract `fetchGraphdSessions`, `deleteGraphdSession`, `fetchUsageData`, `fetchWithTimeout`, `resolveGraphdUrl`, `resolveBusConfig`
- Update `index.tsx` to use services

**Touch Points:**
- `index.tsx`: Replace inline voice logic with `VoiceService`
- `index.tsx`: Replace GraphD calls with `GraphDService`

---

### Phase 2: Extract Event Handlers

**Goal**: Separate protocol parsing from state updates

**New Files:**
```
packages/tui/eventHandlers/
├── index.ts                 # Registry
├── ready.ts                 # handleReady logic
├── status.ts                # handleStatus logic
├── progress.ts              # handleProgress logic
├── stream.ts                # handleStream logic
├── response.ts              # handleResponse logic
├── transcription.ts         # handleTranscription logic
├── userPrompt.ts            # handleUserPrompt logic
├── providerKeyRequired.ts   # handleProviderKeyRequired logic
├── modelChanged.ts          # handleModelChanged logic
├── error.ts                 # handleError logic
├── skillsPayload.ts         # handleSkillsPayload logic
└── hooksPayload.ts          # handleHooksPayload logic
```

**Changes:**
- Each file exports a pure function: `handle(data: DataType, store: Store, deps: Deps)`
- Create `useBridgeEvents` hook to connect handlers to BridgeClient
- Update `index.tsx` to use `useBridgeEvents`

**Touch Points:**
- `index.tsx`: Replace all event handlers with `useBridgeEvents`

---

### Phase 3: Extract Command System

**Goal**: Create a clean command registry and handler system

**New Files:**
```
packages/tui/commands/
├── registry.ts              # Command registry
├── types.ts                 # Command types
├── handlers/
│   ├── help.ts
│   ├── config.ts
│   ├── models.ts
│   ├── providers.ts
│   ├── skills.ts
│   ├── hooks.ts
│   ├── theme.ts
│   ├── sessions.ts
│   ├── usage.ts
│   ├── fork.ts
│   ├── delete.ts
│   ├── compact.ts
│   ├── plan.ts
│   ├── ralph.ts
│   ├── voice.ts
│   ├── clear.ts
│   └── exit.ts
├── parsers/
│   ├── ralph.ts             # parseRalphArgs
│   └── common.ts
└── index.ts                 # Re-exports
```

**Changes:**
- Create `CommandExecutor` class
- Move all command handlers to individual files
- Update `index.tsx` to use `CommandExecutor`

**Touch Points:**
- `index.tsx`: Replace inline command handling with `CommandExecutor`
- `commands.ts`: Keep `SLASH_COMMANDS` and `parseSlashCommand` (move to `parsers/common.ts`)

---

### Phase 4: Extract Keyboard System

**Goal**: Create a structured keyboard dispatch system

**New Files:**
```
packages/tui/keyboard/
├── dispatcher.ts            # KeyboardDispatcher class
├── types.ts                 # Keyboard types
├── globalShortcuts.ts       # Global shortcut handling
├── textEditing.ts           # Text editing operations
├── navigation.ts            # Navigation operations
├── modes/
│   ├── chat.ts              # Chat mode key handler
│   ├── question.ts           # Question mode key handler
│   ├── providers.ts         # Providers mode key handler
│   ├── theme.ts             # Theme mode key handler
│   ├── models.ts            # Models mode key handler
│   ├── sessions.ts          # Sessions mode key handler
│   ├── usage.ts             # Usage mode key handler
│   ├── response.ts          # Response mode key handler
│   └── index.ts             # Registry of mode handlers
└── index.ts                 # Re-exports
```

**Changes:**
- Create `KeyboardDispatcher` class with mode-specific handlers
- Extract text editing logic to `textEditing.ts`
- Extract navigation logic to `navigation.ts`
- Extract global shortcuts to `globalShortcuts.ts`
- Update `index.tsx` to use `KeyboardDispatcher`

**Touch Points:**
- `index.tsx`: Replace entire `useInput` with `KeyboardDispatcher`

---

### Phase 5: Extract UI Mode Management

**Goal**: Create a clear state machine for UI modes

**New Files:**
```
packages/tui/modes/
├── types.ts                 # Mode types and transitions
├── ModeManager.ts           # Mode state machine
├── transitions.ts           # Valid transitions
└── index.ts                 # Re-exports
```

**Changes:**
- Create `ModeManager` class to manage mode transitions
- Define valid transitions (e.g., `chat → question` is valid, `question → providers` is not)
- Add side effects for mode changes (e.g., focus management)
- Update `index.tsx` to use `ModeManager`

**Touch Points:**
- `index.tsx`: Use `ModeManager` instead of direct `store.setUIMode()` calls
- `store.ts`: Keep `setUIMode()` but validate through `ModeManager`

---

## File Structure After Refactoring

```
packages/tui/
├── index.tsx                # Main component (reduced to ~200 lines)
├── main.ts                  # Entry point
├── store.ts                 # State management (unchanged)
├── bridge_client.ts         # Bridge client (unchanged)
├── buffer.ts                # Input buffer (unchanged)
├── file_cache.ts            # File cache (unchanged)
├── logger.ts                # Logger (unchanged)
├── theme.ts                 # Theme system (unchanged)
├── useMouse.ts              # Mouse hook (unchanged)
├── types.ts                 # Shared types
├── commands.ts              # Moved to commands/parsers/common.ts
├── diff.tsx                 # Diff utilities (unchanged)
├── protocol/                # Protocol types (unchanged)
│   └── index.ts
├── components/              # React components (unchanged)
│   ├── AuthGate.tsx
│   ├── Divider.tsx
│   ├── ErrorBoundary.tsx
│   ├── MultiSelect.tsx
│   ├── ProvidersView.tsx
│   ├── QuestionPrompt.tsx
│   ├── ResponsePane.tsx
│   ├── SessionsView.tsx
│   ├── SingleSelect.tsx
│   ├── TextInputField.tsx
│   ├── UsageView.tsx
│   └── index.ts
├── hooks/                   # React hooks (expanded)
│   ├── useBridgeEvents.ts   # NEW: Event handling hook
│   ├── useCommands.ts       # NEW: Command execution hook
│   ├── useKeyboard.ts       # NEW: Keyboard dispatch hook
│   ├── useBracketedPaste.ts
│   └── index.ts
├── services/                # NEW: Business logic services
│   ├── VoiceService.ts
│   ├── GraphDService.ts
│   └── index.ts
├── eventHandlers/           # NEW: Event handlers (pure functions)
│   ├── index.ts
│   ├── ready.ts
│   ├── status.ts
│   ├── progress.ts
│   ├── stream.ts
│   ├── response.ts
│   ├── transcription.ts
│   ├── userPrompt.ts
│   ├── providerKeyRequired.ts
│   ├── modelChanged.ts
│   ├── error.ts
│   ├── skillsPayload.ts
│   └── hooksPayload.ts
├── commands/                # NEW: Command system
│   ├── registry.ts
│   ├── types.ts
│   ├── handlers/
│   │   ├── help.ts
│   │   ├── config.ts
│   │   ├── models.ts
│   │   ├── providers.ts
│   │   ├── skills.ts
│   │   ├── hooks.ts
│   │   ├── theme.ts
│   │   ├── sessions.ts
│   │   ├── usage.ts
│   │   ├── fork.ts
│   │   ├── delete.ts
│   │   ├── compact.ts
│   │   ├── plan.ts
│   │   ├── ralph.ts
│   │   ├── voice.ts
│   │   ├── clear.ts
│   │   └── exit.ts
│   ├── parsers/
│   │   ├── ralph.ts
│   │   └── common.ts
│   └── index.ts
├── keyboard/                # NEW: Keyboard system
│   ├── dispatcher.ts
│   ├── types.ts
│   ├── globalShortcuts.ts
│   ├── textEditing.ts
│   ├── navigation.ts
│   ├── modes/
│   │   ├── chat.ts
│   │   ├── question.ts
│   │   ├── providers.ts
│   │   ├── theme.ts
│   │   ├── models.ts
│   │   ├── sessions.ts
│   │   ├── usage.ts
│   │   ├── response.ts
│   │   └── index.ts
│   └── index.ts
├── modes/                   # NEW: UI mode management
│   ├── types.ts
│   ├── ModeManager.ts
│   ├── transitions.ts
│   └── index.ts
└── utils/                   # Utilities (unchanged)
    ├── index.ts
    ├── textWrap.ts
    ├── paste.ts
    ├── markdown.ts
    ├── fork-spawn.ts
    └── session.ts
```

---

## Key Invariants to Maintain

1. **Store API remains unchanged** - No breaking changes to Store class methods
2. **BridgeClient API remains unchanged** - No breaking changes to BridgeClient class methods
3. **Component APIs remain unchanged** - No breaking changes to existing components
4. **Exact backward compatibility** - All existing behaviors must be preserved
5. **No performance regression** - Store batching and caching optimizations must remain

---

## Questions for Implementation

Before proceeding with implementation, please clarify:

### 1. Primary Goal (select one)
- [ ] A: Better developer experience - easier to navigate and understand
- [ ] B: Testability - ability to unit test business logic
- [ ] C: Extensibility - easier to add new features/modes
- [ ] D: All of the above equally

### 2. Architectural Approach (select one)
- [ ] A: Extract to custom React hooks (`useBridgeEvents`, `useKeyboardInput`, `useCommands`)
- [ ] B: Extract to service layer classes (`EventService`, `CommandService`, `KeyboardService`)
- [ ] C: Extract to pure functions organized by domain (`eventHandlers/`, `commands/`, `keyboard/`)
- [ ] D: Hybrid approach (recommended in this document)

### 3. Invariants to Maintain
- [ ] Must keep `Store` class as-is (no refactoring)? (Yes/No)
- [ ] Must keep `BridgeClient` API unchanged? (Yes/No)
- [ ] Must maintain exact backward compatibility with existing behavior? (Yes/No)

### 4. Scope Boundaries
**Which should we modularize?** (select all that apply)
- [ ] Event handlers
- [ ] Keyboard input handling
- [ ] Slash command system
- [ ] Business logic (GraphD, usage, session management)
- [ ] UI mode management

**Which should we NOT touch?**
- [ ] Store class
- [ ] BridgeClient
- [ ] Existing components
- [ ] Existing utils/hooks

### 5. Priority Areas to Improve (rank 1-5, 1=highest)
- [ ] Event handling (currently tightly coupled to Store)
- [ ] Keyboard input (navigation + text editing mixed)
- [ ] Command system (slash commands scattered in useInput)
- [ ] Business logic (fetching, computation, parsing)
- [ ] UI mode management (transition logic)

---

## Next Steps

1. **Answer the questions above** to provide architectural direction
2. **Review and approve the plan** - suggest modifications if needed
3. **Begin Phase 1** - Extract business logic to services
4. **Test incrementally** - After each phase, run the TUI to verify behavior
5. **Add tests** - Once modules are extracted, add unit tests for pure functions
6. **Document** - Update README.md with new architecture
