# rex

A config-driven, multi-tier agent system with composable agent primitives, DAG-based task orchestration, and multi-provider LLM support.

## Features

- **Pure Agent Primitives**: Agents are composable functions with clear contracts
- **Multi-Tier Routing**: Automatic task complexity classification (simple/standard/complex)
- **DAG-Based Orchestration**: WorkItem dependency graphs with parallel execution
- **Multi-Provider LLM**: OpenAI and Anthropic adapters with circuit breaker resilience
- **Built-in Tools**: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch
- **Structured Output**: JSON schema validation for agent responses
- **Config-Driven**: Agent models, budgets, and tool access defined in JSON
- **Ink TUI**: React-based terminal interface

## Architecture

```
Harness
  |
  +-- RoutingAgent(goal) --> tier classification
  |
  +-- [simple] --> Agent.run(context, workItem) --> response
  |                No orchestration, single LLM call
  |
  +-- [standard|complex] --> Orchestrator.execute(context, goal)
                              |
                              +-- ExplorerAgent --> system context
                              +-- RuntimeScriptAgent --> WorkItem DAG
                              +-- Execute DAG --> parallel agent dispatch
```

**Key Principles:**
- Agents receive `ContextWindow` by value and mutate locally
- Event callback pattern (no direct EventBus coupling)
- Single entry point: `agent.run({ context, workItem })`
- Tool access controlled via config per agent type

## Agent Types

| Agent | Purpose | Tools | Budget |
|-------|---------|-------|--------|
| **routing** | Tier classification | None | 1 iteration |
| **simple** | Direct response | None | 1 iteration |
| **explorer** | Codebase discovery | Read, Glob, Grep, Bash | 2 iterations, 20 tool calls |
| **runtime_script** | WorkItem DAG generation | explorer (sub-agent) | 2 iterations, 15 tool calls |
| **standard** | Bounded execution | Read, Write, Edit, Glob, Grep, Bash | 10 iterations, 15 tool calls |
| **complex** | Full orchestration | All + standard (sub-agent) | 15 iterations, 50 tool calls |
| **context_compactor** | Context summarization | None | 2 iterations |
| **debugger** | Debug execution | Read, Write, Edit, Glob, Grep, Bash | 10 iterations, 15 tool calls |
| **web_crawler** | Web research | WebFetch, WebSearch | 10 iterations, 15 tool calls |

## Quick Start

```bash
# 1. Clone and setup
git clone <repository-url>
cd rex

# 2. Install dependencies
cd packages/agent-core && npm install
cd ../comms-bus && npm install
cd ../graphd && npm install
cd ../../apps/harness-daemon && npm install
cd ../tui && bun install

# 3. Build
cd ../../packages/agent-core && npm run build
cd ../comms-bus && npm run build
cd ../graphd && npm run build
cd ../../apps/harness-daemon && npm run build
cd ../tui && bun run build

# 4. Configure
cp .env.example .env
# Add your API keys:
#   OPENAI_API_KEY=sk-...
#   ANTHROPIC_API_KEY=sk-ant-...

# 5. Run the harness daemon
cd apps/harness-daemon && bun run start

# 6. Run the TUI
cd ../tui && bun run start
```

## Project Structure

```
apps/
  harness-daemon/  # Harness runtime + TCP bus entrypoint
  tui/             # Ink-based React terminal UI
  dashboard/       # Web dashboard (React)

packages/
  agent-core/      # Pure agent primitive + orchestration + tools + types
  comms-bus/       # JSONL/TCP bus + in-process EventBus
  graphd/          # SQLite persistence layer

src/              # Python services, communication, RL helpers
config/            # Configuration files
  harness_config.json    # Agent LLM models, budgets, tools
  behavioral_rules.md    # Agent behavioral constraints
  skills/                # Custom skill definitions
  hooks/                 # Hook definitions
docs/              # Documentation & specs
```

## Configuration

### harness_config.json

Central configuration for all agent types:

```json
{
  "agents": {
    "standard": {
      "llm": {
        "provider": "openai",
        "model": "gpt-5-mini",
        "max_tokens": 16000,
        "temperature": 0.7
      },
      "budget": {
        "max_iterations": 10,
        "max_tool_calls": 15,
        "max_duration_ms": 120000
      },
      "tools": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
      "output_schema": { ... }
    }
  },
  "tools": {
    "bash_timeout_ms": 30000,
    "max_output_length": 10000
  },
  "graphd": {
    "enabled": true,
    "db_path": ".graphd/graphd.db"
  },
  "context": {
    "max_tokens": 200000
  }
}
```

### Environment Variables

```bash
# Required - at least one
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Optional
LOG_LEVEL=INFO
LOG_DIR=logs
```

## Built-in Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| **Bash** | Shell command execution | `command`, `cwd`, `timeout_ms` |
| **Read** | File content reading | `path`, `cwd` |
| **Write** | File creation/overwrite | `path`, `content`, `cwd` |
| **Edit** | Targeted file editing | `path`, `edits[]`, `cwd` |
| **Glob** | File pattern matching | `pattern`, `cwd` |
| **Grep** | Content search with regex | `pattern`, `path`, `cwd` |
| **WebFetch** | URL content fetching | `url` |
| **WebSearch** | Web search queries | `query` |

## Development

```bash
# Build agent core
cd packages/agent-core
npm run build

# Type check
npm run lint

# Clean build artifacts
npm run clean

# Build TUI
cd ../../apps/tui
bun run build

# Run TUI in dev mode
bun run dev

# Run harness daemon (bus server)
cd ../harness-daemon
bun run start
```

## TUI Protocol (JSONL)

The TUI communicates with the harness daemon via JSON Lines over TCP.
Set `EVENT_BUS_HOST` and `EVENT_BUS_PORT` for both the daemon and TUI
to point at the same bus endpoint (defaults: `127.0.0.1:9555`).

**Commands (UI -> Bridge):**
- `init` - Initialize session
- `send_text` - Send user message
- `get_config` - Get configuration
- `get_status` - Get runtime status

**Events (Bridge -> UI):**
- `ready` - Session initialized
- `status` - State change (idle/recording/transcribing/sending/streaming)
- `progress` - Execution progress
- `stream` - Response streaming
- `response` - Final response
- `error` - Error notification

## Documentation

- [Agent Refactor Specification](docs/AGENT_REFACTOR_SPEC.md) - Architecture details
- [Behavioral Rules](config/behavioral_rules.md) - Agent constraints

## License

MIT
