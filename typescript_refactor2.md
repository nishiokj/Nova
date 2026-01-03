# TypeScript Agent Integration & Event Bus Plan

This document defines how the new TypeScript agent (entry point `agent.run()`) will be wired into the system end-to-end, including the harness and communication/event protocol, and what replaces the Python `EventBus` and `EventBusProtocol`.

It focuses on:
- The **event contract** UIs (e.g., `tui-ts`, dashboard) rely on.
- The **TypeScript event bus abstraction** and implementation.
- The **Agent entry point** and harness wiring.
- The exact remaining steps to achieve an end-to-end working system.

---

## 1. Principles & Scope

1. The old Python `EventBus` (`src/communication/event_bus.py`) is a pure pub/sub router plus a legacy compatibility layer. Its key contract is captured in `EventBusProtocol`:
   - `publish(event: Event) -> None`
   - `subscribe(event_type: EventType, mailbox: Mailbox) -> None`
   - `shutdown() -> None`
   - `is_shutdown() -> bool`

2. The new TypeScript stack is **single-process and async**, so:
   - We **do not** need Python's multiprocessing constructs (`multiprocessing.Event`, `Queue`, `Mailbox`) or process IPC.
   - We **do** still need:
     - A clear **event protocol** describing what events exist and how UIs consume them.
     - A small **event bus abstraction** to decouple the agent core from UIs and to unify event emission.

3. The legacy `AgentRequest` / `AgentResult` / `BusMessage` types in `event_bus.py` are **explicitly legacy** for an old harness. For TypeScript we will define a **modern, canonical** request/response and event model, aligned with:
   - `dashboard/src/domain/models.ts`
   - `tui-ts/types.ts`

4. The TypeScript `agent.run()` entry point must:
   - Accept a well-defined **request payload** (text, tier, session, etc.).
   - Return both:
     - A **final result** (`Promise`), and
     - An **event stream handle** for streaming updates.


---

## 2. Target End-to-End Flow (From tui-ts to Agent and Back)

### 2.1 High-Level Diagram

```text
User (tui-ts)
  │
  │ 1. User enters prompt / command
  ▼
TUI Client (tui-ts)
  │ 2. Calls TS AgentHarness.run(request)
  ▼
AgentHarness (TS)
  │ 3. Constructs context, attaches EventBus instance, calls Agent.run()
  ▼
Agent (TS)
  │ 4. Planner → Wizard → Worker → Tools, emitting AgentEvents via EventBus
  ▼
EventBus (TS)
  │ 5. Routes events to subscribers (tui-ts, logger, GraphD writer, etc.)
  ▼
TUI Client (tui-ts)
  │ 6. Subscribes to per-request event stream, updates UI incrementally
  │ 7. Awaits final result to know when to stop streaming
  ▼
Final Render & Exit
```

### 2.2 Concrete Interfaces (Target)

#### 2.2.1 Agent Events

We standardize on a TypeScript `AgentEvent` model, reusing and unifying existing dashboard/tui types.

**Location**: `src/agent-ts/types/events.ts`

```ts
export type AgentEventType =
  | 'REQUEST_SUBMITTED'
  | 'PLAN_CREATED'
  | 'PLAN_STEP_STARTED'
  | 'PLAN_STEP_COMPLETED'
  | 'TOOL_CALL_STARTED'
  | 'TOOL_CALL_COMPLETED'
  | 'MODEL_OUTPUT_TOKEN'
  | 'MODEL_OUTPUT_COMPLETE'
  | 'AGENT_RESPONSE_COMPLETE'
  | 'ERROR'
  | 'SHUTDOWN';

export interface BaseAgentEvent {
  type: AgentEventType;
  requestId: string;          // correlates events to a single agent run
  sessionKey: string;         // session / conversation group
  timestamp: number;          // seconds since epoch (float compatible)
}

// Examples of concrete event payloads

export interface RequestSubmittedEvent extends BaseAgentEvent {
  type: 'REQUEST_SUBMITTED';
  inputText: string;
  tier: string;
}

export interface PlanCreatedEvent extends BaseAgentEvent {
  type: 'PLAN_CREATED';
  plan: Plan; // from plan.ts
}

export interface ModelOutputTokenEvent extends BaseAgentEvent {
  type: 'MODEL_OUTPUT_TOKEN';
  token: string;
}

export interface AgentResponseCompleteEvent extends BaseAgentEvent {
  type: 'AGENT_RESPONSE_COMPLETE';
  finalText: string;
  success: boolean;
  errorMessage?: string;
}

export type AgentEvent =
  | RequestSubmittedEvent
  | PlanCreatedEvent
  | ModelOutputTokenEvent
  | AgentResponseCompleteEvent
  // ...other specific variants
  | BaseAgentEvent; // fallback for generics
```


#### 2.2.2 Event Bus Protocol (TS)

**Location**: `src/agent-ts/communication/event_bus.ts`

```ts
import { EventEmitter } from 'events';
import { AgentEvent, AgentEventType } from '../types/events';

export interface EventBusProtocol {
  publish(event: AgentEvent): void;
  subscribe(
    type: AgentEventType,
    handler: (event: AgentEvent) => void,
  ): () => void; // returns unsubscribe
  shutdown(): void;
  isShutdown(): boolean;
}

export class EventBus implements EventBusProtocol {
  private emitter = new EventEmitter();
  private shutdownFlag = false;

  publish(event: AgentEvent): void {
    if (this.shutdownFlag) return;
    this.emitter.emit(event.type, event);
  }

  subscribe(type: AgentEventType, handler: (event: AgentEvent) => void): () => void {
    this.emitter.on(type, handler);
    return () => this.emitter.off(type, handler);
  }

  shutdown(): void {
    if (this.shutdownFlag) return;
    this.shutdownFlag = true;
    const shutdownEvent: AgentEvent = {
      type: 'SHUTDOWN',
      requestId: '',
      sessionKey: '',
      timestamp: Date.now() / 1000,
    };
    this.emitter.emit('SHUTDOWN', shutdownEvent);
  }

  isShutdown(): boolean {
    return this.shutdownFlag;
  }
}
```

**Notes**:
- We **keep** the logical `EventBusProtocol` abstraction (as in Python) but simplify the implementation to an in-process `EventEmitter`.
- We drop Mailbox and multiprocessing concerns; subscribers receive events via callbacks.
- For backpressure/streaming, UIs may wrap this in an async iterator (see below).


#### 2.2.3 Agent Entry Point: `Agent.run()` & Harness

**Location**: `src/agent-ts/agent/agent.ts`, `src/agent-ts/harness.ts`

```ts
// src/agent-ts/agent/types.ts
export interface AgentRunParams {
  requestId: string;
  inputText: string;
  tier: string;
  sessionKey: string;
  // Optional: previous messages, config overrides, etc.
}

export interface AgentRunResult {
  requestId: string;
  sessionKey: string;
  success: boolean;
  finalText: string;
  errorMessage?: string;
}

export interface AgentRunHandle {
  result: Promise<AgentRunResult>;
  events: AsyncIterableIterator<AgentEvent>; // per-request view
}
```

```ts
// src/agent-ts/agent/agent.ts
import { EventBusProtocol } from '../communication/event_bus';
import { AgentRunParams, AgentRunHandle, AgentRunResult } from './types';

export class Agent {
  constructor(
    private readonly eventBus: EventBusProtocol,
    // planner, wizard, worker, graph, llm, tools, etc.
  ) {}

  run(params: AgentRunParams): AgentRunHandle {
    const { requestId, sessionKey } = params;

    // Create a per-request async iterator over events
    const eventQueue: AgentEvent[] = [];
    let done = false;
    const iterator: AsyncIterableIterator<AgentEvent> = {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        while (!eventQueue.length) {
          if (done) return { done: true, value: undefined as any };
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const value = eventQueue.shift()!;
        return { done: false, value };
      },
    } as any;

    const unsubscribe = this.eventBus.subscribe(
      // In practice we subscribe to all types and filter by requestId
      // so better to expose a `subscribeAll` or use a wrapper.
      // For now, assume a helper layer does this filtering.
      'AGENT_RESPONSE_COMPLETE',
      () => {
        // the run will manage done flag when it sees final event for this request
      },
    );

    const resultPromise: Promise<AgentRunResult> = (async () => {
      // emit REQUEST_SUBMITTED, then orchestrate with planner/wizard/worker
      // publishing events via this.eventBus
      // resolve when AGENT_RESPONSE_COMPLETE for this requestId is produced
      return {
        requestId,
        sessionKey,
        success: true,
        finalText: '',
      };
    })().finally(() => {
      done = true;
      unsubscribe();
    });

    return {
      result: resultPromise,
      events: iterator,
    };
  }
}
```

```ts
// src/agent-ts/harness.ts
import { Agent } from './agent/agent';
import { EventBus } from './communication/event_bus';
import { AgentRunParams, AgentRunHandle } from './agent/types';

export class AgentHarness {
  private readonly eventBus = new EventBus();
  private readonly agent: Agent;

  constructor(/* config, graph, llm, tools, etc. */) {
    this.agent = new Agent(this.eventBus /*, other deps */);
  }

  run(params: AgentRunParams): AgentRunHandle {
    return this.agent.run(params);
  }

  getEventBus() {
    return this.eventBus;
  }
}
```


#### 2.2.4 TUI Integration (tui-ts)

**Location**: `tui-ts/client.ts` (or equivalent root)

```ts
// Pseudocode
import { AgentHarness } from '../src/agent-ts/harness';

const harness = new AgentHarness(/* config */);

async function handleUserInput(inputText: string, tier: string, sessionKey: string) {
  const requestId = generateRequestId();

  const { result, events } = harness.run({
    requestId,
    inputText,
    tier,
    sessionKey,
  });

  // Stream events into TUI
  (async () => {
    for await (const ev of events) {
      if (ev.requestId !== requestId) continue; // if not already filtered
      renderEventInTui(ev);
    }
  })();

  // Await final result
  const final = await result;
  renderFinalResponse(final);
}
```

This replaces the existing Python bridge + event bus IPC. `tui-ts` talks directly to the in-process TS agent via function calls and async iterators.


---

## 3. Do We Still Need an Event Bus Abstraction?

**Short answer**: Yes, as a *logical abstraction*, but not as a heavy process-bound system.

### 3.1 Why We Keep an EventBusProtocol in TS

1. **Decoupling**: Wizard, Worker, Planner, Tools, and Synthesis should not know about TUI or dashboard specifics. They just emit `AgentEvent`s to a bus.
2. **Multiple consumers**: In the future we may have:
   - TUI (live streaming)
   - Dashboard (live streaming or polling + snapshots from GraphD)
   - Logging / telemetry
   - Tests that assert on emitted events
3. **Testability**: We can stub the bus in unit tests to capture and assert on events.
4. **Future evolution**: If we later need to expose events over WebSocket or across processes again, we can simply add another EventBus implementation that wraps the in-process bus.

### 3.2 What We Remove vs. Replace

- Remove:
  - Python `EventBus` implementation, Mailboxes, multiprocessing.Event.
  - Legacy `AgentRequest`, `AgentResult`, `BusMessage`, `MessageType` as they were only for old harness compatibility.

- Replace with TS:
  - A *simple* `EventBus` (`EventEmitter`-based) implementing `EventBusProtocol`.
  - A clear, typed `AgentEvent` model used across agent core, TUI, and dashboard.


---

## 4. Detailed Remaining Work Items

This section is the actionable to-do list to get to a full working end-to-end TS system from `tui-ts` user request through `agent.run()`.

### 4.1 Event Types & Protocol (TS)

**Goal**: Define the canonical Agent event protocol in TS and reconcile it with existing dashboard/tui types.

1. **Inventory existing TS event models**
   - [ ] Read `dashboard/src/domain/models.ts` and list all event-related types.
   - [ ] Read `tui-ts/types.ts` and `tui-ts/client.ts` to understand current event expectations.

2. **Define unified Agent events**
   - [ ] Create `src/agent-ts/types/events.ts` containing:
     - [ ] `AgentEventType` enum/string union.
     - [ ] `BaseAgentEvent` and per-type interfaces (`PlanCreatedEvent`, `ToolCallCompletedEvent`, etc.).
   - [ ] Ensure JSON representation matches what the dashboard expects (field names, timestamp units, etc.).

3. **Document protocol**
   - [ ] In `src/agent-ts/docs/agent_protocol.md` (or in this file), document:
     - [ ] Each event type, when it is emitted, and which component emits it.
     - [ ] Fields and their semantics.
     - [ ] Stability guarantees (public vs internal-only events).


### 4.2 TypeScript EventBus Implementation

**Goal**: Implement a minimal but robust EventBus in TS.

1. **Create `EventBusProtocol` & `EventBus`**
   - [ ] Add `src/agent-ts/communication/event_bus.ts` with the interface and `EventBus` class as described above.
   - [ ] Add tests for:
     - [ ] Basic publish/subscribe.
     - [ ] Multiple subscribers per event type.
     - [ ] `shutdown()` stops new events and emits `SHUTDOWN`.

2. **Optional: convenience APIs**
   - [ ] Consider adding `subscribeAll(handler)` or `createPerRequestStream(requestId)` helper to simplify per-request subscriptions.


### 4.3 Agent Entry Point & Harness Wiring

**Goal**: Expose a stable `Agent.run()` / `AgentHarness.run()` API and wire all internal components.

1. **Define run types**
   - [ ] In `src/agent-ts/agent/types.ts`, define:
     - [ ] `AgentRunParams` (requestId, inputText, tier, sessionKey, etc.).
     - [ ] `AgentRunResult` (requestId, success, finalText, errorMessage, etc.).
     - [ ] `AgentRunHandle` (`{ result: Promise<AgentRunResult>, events: AsyncIterable<AgentEvent> }`).

2. **Implement `Agent`**
   - [ ] Implement `Agent` in `src/agent-ts/agent/agent.ts` that:
     - [ ] Accepts `EventBusProtocol`, planner, wizard, worker, graph client, and LLM adapter in its constructor.
     - [ ] Exposes `run(params: AgentRunParams): AgentRunHandle`.
     - [ ] Emits `REQUEST_SUBMITTED` immediately.
     - [ ] Invokes planner to create a plan, wizard/worker to execute it.
     - [ ] Emits `AGENT_RESPONSE_COMPLETE` when done.
     - [ ] Resolves the `result` promise when the response-complete event for that `requestId` is emitted.

3. **Per-request event stream**
   - [ ] Implement a helper that, given `EventBus` and `requestId`, returns an `AsyncIterable<AgentEvent>` filtered by `requestId`.
   - [ ] Use this helper in `Agent.run()` to construct the `events` stream in `AgentRunHandle`.

4. **Implement `AgentHarness`**
   - [ ] In `src/agent-ts/harness.ts`:
     - [ ] Construct `EventBus`.
     - [ ] Construct `GraphD` client.
     - [ ] Construct `LLMAdapter`.
     - [ ] Construct `ToolRegistry` and builtin tools.
     - [ ] Construct `Worker`, `Wizard`, `Planner`, `Agent`.
     - [ ] Expose `run(params: AgentRunParams): AgentRunHandle` delegating to `Agent.run()`.
     - [ ] Optionally expose `getEventBus()` for external observers like dashboard.


### 4.4 Wizard/Worker Event Emission Hookup

**Goal**: Ensure the TS wizard/worker emit proper `AgentEvent`s through the EventBus.

1. **Wizard**
   - [ ] In `src/agent-ts/wizard/wizard.ts`:
     - [ ] Inject `EventBusProtocol`.
     - [ ] On starting plan execution, emit `PLAN_CREATED`.
     - [ ] Before each step, emit `PLAN_STEP_STARTED`.
     - [ ] After each step, emit `PLAN_STEP_COMPLETED`.
     - [ ] On termination (success or failure), emit `AGENT_RESPONSE_COMPLETE`.

2. **Worker**
   - [ ] In `src/agent-ts/wizard/worker.ts`:
     - [ ] On tool call start/end, emit `TOOL_CALL_STARTED` / `TOOL_CALL_COMPLETED`.
     - [ ] On model streaming, emit `MODEL_OUTPUT_TOKEN` and `MODEL_OUTPUT_COMPLETE` events.

3. **GraphD Event Persistence (if required)**
   - [ ] Decide whether GraphD should store raw events or derived state.
   - [ ] If storing events, add a subscriber to `EventBus` that writes them to GraphD with `requestId` and `sessionKey`.


### 4.5 TUI Integration Changes (tui-ts)

**Goal**: Replace Python bridge + bus with direct TS AgentHarness integration.

1. **Identify current integration**
   - [ ] Read `tui-ts/client.ts` (or equivalent) to see how it currently speaks to Python (likely via `bridge.py` / stdin/stdout).

2. **Introduce AgentHarness usage**
   - [ ] Import `AgentHarness` from `src/agent-ts/harness`.
   - [ ] Instantiate it during TUI initialization.

3. **Wire user input to `run()`**
   - [ ] On user submit, generate `requestId` and `sessionKey`.
   - [ ] Call `harness.run({ requestId, inputText, tier, sessionKey })`.
   - [ ] Start an async task that iterates over `events` and updates the TUI view.
   - [ ] Await `result` to close the stream and finalize the UI.

4. **Remove Python bridge usages**
   - [ ] Delete or stub out `tui-ts/bridge.py` references.
   - [ ] Ensure there is no remaining dependency on `src/communication/event_bus.py` from TUI.


### 4.6 Dashboard Integration (Optional but Recommended)

**Goal**: Ensure the dashboard still works (or is upgraded) with the new TS agent.

1. **GraphD compatibility**
   - [ ] Confirm the TS `GraphD` HTTP API and schema match what the dashboard expects.

2. **Live events (if needed)**
   - [ ] If the dashboard needs live events, consider:
     - [ ] Exposing a WebSocket endpoint that subscribes to the EventBus and streams `AgentEvent`s.
     - [ ] Or relying on polling + persisted summaries only.


### 4.7 Cleanup & Deletion of Old Python Components

After the TS agent and harness are fully wired and tested:

1. **Delete Python EventBus & related IPC**
   - [ ] Remove `src/communication/event_bus.py`.
   - [ ] Remove `src/communication/event_bus_protocol.py`.
   - [ ] Remove `src/communication/process_manager.py` (if unused).
   - [ ] Remove `tui-ts/bridge.py`.

2. **Remove Python agent code**
   - [ ] Remove `src/harness/agent/` once all equivalent TS modules exist and tests pass.
   - [ ] Remove `src/harness/graphd/` when TS GraphD is stable.

3. **Update docs and references**
   - [ ] Update `TYPESCRIPT_REFACTOR.md` to point to this document and mark Python EventBus as deprecated/removed.


---

## 5. Answers to Specific Concerns

### 5.1 "Does TypeScript's event-driven nature mean we don't need the event bus anymore?"

No. TypeScript provides convenient primitives (EventEmitter, async iterators), but:
- We **still need** a clearly defined **event protocol** (what events exist, their fields, and semantics).
- We **benefit from** a minimal `EventBusProtocol` abstraction to decouple the core agent logic from specific UIs and to allow multiple consumers.

What we **do not need** is:
- The Python-specific multiprocessing EventBus implementation.
- Mailboxes, multiprocessing.Event, or Queue-based IPC.

### 5.2 "How will UIs (e.g., tui-ts) communicate?"

- UIs will communicate **in-process** with the TS agent via:
  - A function call to `AgentHarness.run()` with a well-typed request.
  - An async iterable stream of `AgentEvent`s returned in the `AgentRunHandle`.
- `tui-ts` will consume this event stream directly to render incremental updates, and await the final `AgentRunResult` to know when the run is complete.

This is cleaner and simpler than the current Python bridge and event bus IPC while preserving the decoupled, event-driven architecture.
