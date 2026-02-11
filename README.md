# rex

A config-driven, multi-tier agent system with composable agent primitives, DAG-based orchestration, async oversight, and multi-provider LLM support.

## Quick Start

```bash
# Install dependencies (bun workspaces)
bun install

# Store API keys in GraphD
rex providers set openai sk-...
rex providers set anthropic sk-ant-...

# Run (launches daemon + control-plane + TUI)
bun run start
```

Alternatively, run the daemon in one terminal and attach the TUI separately:

```bash
bun run start:split          # daemon + control-plane (foreground)
bun run start:tui            # TUI in another terminal
```

## Architecture

```
┌──────────┐
│   User   │
└────┬─────┘
     │
     ▼
┌──────────┐     ┌────────────────┐     ┌─────────────┐
│ Launcher │────▶│ Daemon (9555)  │────▶│ GraphD(9444)│
└──────────┘     └───────┬────────┘     └─────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
    ┌──────────┐  ┌──────────────┐  ┌──────────────┐
    │ TUI(Ink) │  │Control-Plane │  │  Watcher /   │
    │          │  │   (9445)     │  │  Planner     │
    └──────────┘  └──────┬───────┘  └──────────────┘
                         ▼
                  ┌──────────────┐
                  │  Cockpit UI  │
                  └──────────────┘
```

**Daemon** is the central process — it owns agent execution, session state, the orchestrator, hook system, permissions, and the WebSocket bus. **GraphD** is a standalone SQLite datastore for sessions, API keys, config, and escalations. **Control-Plane** exposes an HTTP API for the Cockpit dashboard and session management.

### Agent Execution Flow

```
Harness.run(goal)
  │
  ├─ RoutingAgent → tier classification
  │
  ├─ [simple] → Agent.run() → single LLM call
  │
  └─ [standard|complex] → Orchestrator.execute()
       ├─ ExplorerAgent → system context
       ├─ PlannerAgent → WorkItem DAG
       └─ Execute DAG → parallel agent dispatch
```

### Async Mode

In async mode, the **Watcher** agent provides oversight: it auto-answers PromptUser questions from a curated decision database, performs quality gates on agent output, and raises **Escalations** to the Cockpit when it cannot resolve a decision autonomously. The **Planner** agent produces structured work breakdowns.

Escalation lifecycle: `pending → acknowledged → resolved | dismissed`

## Project Structure

```
packages/
  core/                  # Runtime primitives and contracts
    types/               #   Type definitions (zod schemas)
    shared/              #   Common utilities
    protocol/            #   Orchestrator state, hooks, decisions (discriminated unions)
    work/                #   WorkItem DAG and knowledge management
    llm/                 #   Multi-provider LLM adapters + circuit breaker
    context/             #   ContextWindow (RAM or write-through disk)
    tools/               #   Tool registry and builtins
    agent/               #   Core agent execution primitive
    orchestrator/        #   DAG-based orchestration, hook system, state machine

  infra/                 # Runtime infrastructure
    comms-bus/           #   WebSocket event bus (daemon ↔ TUI)
    harness-client/      #   Client library for daemon connection
    harness-daemon/      #   Main daemon: sessions, agents, permissions, hooks
    graphd/              #   Standalone SQLite datastore
    control-plane/       #   HTTP API + Cockpit dashboard proxy
    decision-watcher/    #   Async oversight (watcher agent, decision DB, escalations)

  plugins/               # Optional subsystems
    agent-memory/        #   PostgreSQL + pgvector memory with connector SDK
    entity-graph/        #   Tree-sitter code entity extraction
    memory-injector/     #   Stateless retrieval layer for context injection
    semantic-compiler/   #   Semantic invariant compiler → verification programs

  external/              # Vendored dependencies
    prompt-protocol/     #   Schema-agnostic prompt protocol

  apps/                  # User-facing clients
    launcher/            #   Unified CLI entry point (starts daemon + TUI)
    tui/                 #   Ink (React) terminal interface
    dashboard/           #   Vite + React GraphD explorer
    dashboard-compact/   #   Minimal dashboard variant
    dashboard-control/   #   Cockpit UI (escalations, session oversight)

config/
  defaults.json          # Default harness config (agents, budgets, tools, ports)
  behavioral_rules.md    # Agent behavioral constraints
  skills/                # Custom skill definitions
  hooks/                 # Hook definitions
scripts/                 # Shell and utility scripts
docs/                    # Architecture, specs, runbooks, setup guides
tests/                   # Integration tests
```

## Agent Types

| Agent | Role | Tools | Budget |
|-------|------|-------|--------|
| **routing** | Tier classification | None | 1 iter |
| **simple** | Direct response | None | 1 iter |
| **explorer** | Codebase discovery | Read, Glob, Grep, Bash | 8 iter, 60 calls |
| **standard** | Default execution | Read, Write, Edit, Glob, Grep, Bash, Skill, PromptUser, coding, explorer, WebSearch | 50 iter, 225 calls |
| **coding** | Deep coding (reasoning) | Read, Write, Edit, Glob, Grep, Bash, Skill, PromptUser, explorer | 50 iter, 250 calls |
| **context_compactor** | Context summarization | None | 3 iter |
| **debugger** | Debug analysis | Read, Write, Edit, Glob, Grep, Bash, Skill, PromptUser | 15 iter, 45 calls |
| **web_crawler** | Web research | WebFetch, WebSearch | 15 iter, 23 calls |
| **watcher** | Async oversight | Read, Glob, Grep, Bash | 20 iter, 40 calls |
| **planner** | Async work planning | Read, Glob, Grep, PromptUser | 15 iter, 60 calls |

Model roles are mapped per agent: `fast` (routing, simple, compactor, web_crawler), `standard` (explorer, standard, watcher, planner, debugger), `reasoning` (coding).

## Configuration

### config/defaults.json

Central configuration for all agent types, tools, services, and runtime behavior. User overrides go in `~/.rex/config.json`.

API keys are stored in GraphD (not env vars): `rex providers set <provider> <key>`

### Environment Variables

```bash
# Required for agent-memory plugin
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_memory

# OAuth (optional — for connector SDK)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Optional integrations
TELEGRAM_BOT_TOKEN=
BROWSER_USE_API_KEY=
```

LLM provider keys are **not** stored in `.env` — they live in GraphD.

## Development

```bash
bun install                    # Install all workspace deps
bun run start                  # Full stack (daemon + control-plane + TUI)
bun run start:split            # Daemon + control-plane only
bun run start:tui              # TUI only (connects to running daemon)
bun run start:graphd           # GraphD standalone

bun run build                  # Build all packages + apps
bun run clean                  # Clean all build artifacts
bun run lint                   # Typecheck all packages
```

## Key Design Principles

- **Agents are pure functions**: receive `ContextWindow` by value, mutate locally
- **Event callback pattern**: no direct EventBus coupling
- **Single entry point**: `agent.run({ context, workItem })`
- **Discriminated unions**: exhaustive handling enforced by TypeScript
- **Write-through disk**: RAM is authoritative, mutations trigger atomic disk writes (tmp + rename)
- **Session IS the Workflow**: no separate Workflow entity
- **Escalation is the only new stateful entity**: the single coordination primitive between async agents and human oversight

## License

MIT
