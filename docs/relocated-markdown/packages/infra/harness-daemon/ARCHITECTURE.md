# Harness Daemon Architecture

## Overview

The harness-daemon is a **dumb agent execution engine** that exposes a WebSocket interface. It knows nothing about HTTP, webhooks, or specific integrations like Telegram. External systems connect via `harness-client`.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           harness-daemon                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  src/index.ts (entrypoint)                                                  │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ HarnessDaemon                                                        │   │
│  │                                                                      │   │
│  │   Creates + Starts:                                                  │   │
│  │   ┌──────────────┐   ┌────────────────┐   ┌──────────────────┐      │   │
│  │   │ AgentHarness │   │ BusServer      │   │ BridgeGateway    │      │   │
│  │   │              │   │ (WS:9555)      │   │                  │      │   │
│  │   └──────┬───────┘   └───────┬────────┘   └────────┬─────────┘      │   │
│  │          │                   │                     │                │   │
│  └──────────┼───────────────────┼─────────────────────┼────────────────┘   │
│             │                   │                     │                     │
│             ▼                   ▼                     ▼                     │
│  ┌──────────────────┐   ┌─────────────────┐   ┌─────────────────────────┐  │
│  │ AgentHarness     │   │ BusServer       │   │ BridgeGateway           │  │
│  │                  │   │                 │   │                         │  │
│  │ • Orchestrator   │   │ • WebSocket     │   │ Commands:               │  │
│  │ • Agent          │◄──┤ • Pub/Sub       │◄──┤ • init                  │  │
│  │ • ToolRegistry   │   │ • Channels      │   │ • send_text             │  │
│  │ • ContextWindow  │   │                 │   │ • user_prompt_response  │  │
│  │ • GraphD         │   │ Channels:       │   │ • get_config            │  │
│  │ • EventBus  ─────┼──►│ • session:*     │   │ • skills_*              │  │
│  │ • SessionStore   │   │ • run:*         │   │ • hooks_*               │  │
│  │ • PermissionChk  │   │ • bridge:cmd    │   │ • providers_*           │  │
│  │                  │   │                 │   │ • session_*             │  │
│  └──────────────────┘   └────────┬────────┘   │ • set_model             │  │
│                                  │            │ • async_*               │  │
│                                  │            │ • permission_response   │  │
│                                  │            │ • shutdown              │  │
│                                  │            └─────────────────────────┘  │
│                                  │                                         │
└──────────────────────────────────┼─────────────────────────────────────────┘
                                   │
                                   │ WS:9555
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
                    ▼                             ▼
            ┌───────────────┐             ┌───────────────┐
            │ TUI Client    │             │ harness-client│
            │ (packages/apps/tui)│             │ (for external │
            │               │             │  integrations)│
            └───────────────┘             └───────────────┘
```

## Components

### HarnessDaemon (`daemon.ts`)
Entry point that creates and orchestrates:
- `AgentHarness` - the agent execution engine
- `BusServer` - WebSocket pub/sub server
- `BridgeGateway` - command router

### AgentHarness (`harness.ts`)
The actual agent execution engine:
- `Orchestrator` - manages agent loops and tool execution
- `Agent` - LLM interaction layer
- `ToolRegistry` - available tools
- `ContextWindow` - conversation context management
- `GraphD` - session persistence
- `EventBus` - internal event pub/sub
- `SessionStore` - session state management
- `PermissionChecker` - tool permission validation

### BusServer (`comms-bus` package)
WebSocket server on port 9555:
- Accepts client connections
- Pub/sub channel system (`session:*`, `run:*`, `bridge:cmd`)
- Forwards commands to BridgeGateway
- Publishes events back to subscribed clients

### BridgeGateway (`bridge_gateway.ts`)
Routes commands from the bus to the harness:
- `init` - initialize session
- `send_text` - run agent with text input
- `user_prompt_response` - answer permission/clarification prompts
- `get_config` - retrieve configuration
- `skills_*` - skill CRUD operations
- `hooks_*` - hook CRUD operations
- `providers_*` - provider management
- `session_*` - session management
- `set_model` / `get_model` - model selection
- `async_*` - autonomous async session control
- `permission_response` - handle permission requests
- `shutdown` - graceful shutdown

## Protocol

All communication uses framed JSON messages over WebSocket. Clients send commands, subscribe to channels, and receive events.

### Example Flow

```
Client                          BusServer                    BridgeGateway/Harness
   │                                │                                │
   │─── subscribe("session:abc") ──►│                                │
   │─── subscribe("run:req123") ───►│                                │
   │                                │                                │
   │─── publish("bridge:cmd", ─────►│─── handlePublish() ───────────►│
   │      {type:"init",             │                                │
   │       data:{session_key:"abc"}}│                                │
   │                                │                                │
   │◄── event on "session:abc" ─────│◄── createReadyEvent() ─────────│
   │                                │                                │
   │─── publish("bridge:cmd", ─────►│─── handlePublish() ───────────►│
   │      {type:"send_text",        │                                │
   │       data:{text:"Hello"}})    │                                │
   │                                │                                │
   │◄── events on "run:req123" ─────│◄── EventBus emissions ─────────│
   │    (stream, status, response)  │                                │
```

## External Integration Pattern

For integrations like Telegram, the harness-daemon needs **no changes**. External systems use `harness-client`:

```
Telegram Webhook
       │
       ▼ (HTTP)
┌──────────────────┐
│ agent-memory     │
│ (Sync Daemon)    │
│                  │
│ • HttpServer     │  ◄── receives webhooks
│ • TelegramConnector  ◄── formats messages
│ • HarnessClient ─┼──► WS:9555 ──► harness-daemon
│                  │
└──────────────────┘
```

The harness is a dumb execution engine. All integration-specific logic (Telegram types, API calls, message formatting) belongs in the integration layer.
