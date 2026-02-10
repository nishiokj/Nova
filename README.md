# rex

A config-driven, multi-tier agent system with composable agent primitives, DAG-based task orchestration, and multi-provider LLM support.

## Features

- **Pure Agent Primitives**: Agents are composable functions with clear contracts
- **Multi-Tier Routing**: Automatic task complexity classification (simple/standard/complex)
- **DAG-Based Orchestration**: WorkItem dependency graphs with parallel execution
- **Multi-Provider LLM**: OpenAI, Anthropic, and Gemini adapters with circuit breaker resilience
- **Built-in Tools**: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch
- **Structured Output**: JSON schema validation for agent responses
- **Config-Driven**: Agent models, budgets, and tool access defined in JSON
- **Ink TUI**: React-based terminal interface

## Quick Start

```bash
# 1. Clone and setup
git clone <repository-url>
cd rex

# 2. Install dependencies (uses bun workspaces)
bun install

# 3. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 4. Run the CLI
bun run packages/launcher/index.ts
```

## Project Structure

```
packages/
  launcher/          # CLI entry point
  harness-daemon/    # Harness runtime + TCP bus entrypoint
  tui/               # Ink-based React terminal UI
  dashboard/         # Web dashboard (React/Vite)
  dashboard-compact/ # Compact web dashboard
  agent/             # Agent primitives
  agent-memory/      # Memory and knowledge graph
  orchestrator/      # DAG-based task orchestration
  llm/               # Multi-provider LLM adapters
  tools/             # Built-in tool implementations
  context/           # Context window management
  comms-bus/         # JSONL/TCP bus + EventBus
  graphd/            # SQLite persistence layer
  types/             # Shared TypeScript types
  shared/            # Shared utilities
  work/              # WorkItem definitions
  protocol/          # Communication protocol types
  harness-client/    # Harness client library
  entity-graph/      # Entity relationship graph
  decision-watcher/  # Decision tracking
  semantic-compiler/ # Semantic invariant compiler (VP + verification planning)
  memory-injector/   # Memory injection utilities

scripts/             # Shell and utility scripts
config/              # Configuration files
  harness_config.json    # Agent LLM models, budgets, tools
  behavioral_rules.md    # Agent behavioral constraints
  skills/                # Custom skill definitions
  hooks/                 # Hook definitions
docs/                # Documentation & specs
  architecture/      # Architecture diagrams and design docs
  specs/             # Implementation specifications
  analysis/          # Analysis and state documents
  setup/             # Setup and authentication guides
  archive/           # Archived research and completed specs
tests/               # Integration tests
```

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

See `.env.example` for all available environment variables:

```bash
# Required - at least one LLM provider
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...

# Optional - for agent memory features
DATABASE_URL=postgresql://...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
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
# Install all dependencies
bun install

# Run the CLI
bun run packages/launcher/index.ts

# Run TUI directly
bun run packages/tui/index.tsx

# Run harness daemon (bus server)
bun run packages/harness-daemon/src/index.ts

# Run GraphD (standalone datastore process)
bun run packages/graphd/src/graphd.ts

# Run control-plane server (HTTP API + dashboard)
bun run packages/control-plane/src/control-plane.ts

# Recommended split startup order:
# 1) bun run start:graphd
# 2) bun run packages/harness-daemon/src/index.ts
# 3) bun run packages/control-plane/src/control-plane.ts

# Type check all packages
bun run --filter '*' tsc --noEmit
```

## Stealth Browser Authentication

For browser automation with persistent authentication:

```bash
# Login to multiple sites once with stealth settings
./scripts/multi-site-auth-stealth.sh

# Use saved authentication states
./scripts/multi-site-auth-usage.sh [site] [action] [args...]

# Examples:
./scripts/multi-site-auth-usage.sh x open https://x.com
./scripts/multi-site-auth-usage.sh github snapshot -i
```

See [docs/setup/STEALTH-BROWSER-GUIDE.md](docs/setup/STEALTH-BROWSER-GUIDE.md) for full details.

**Important:** Never commit `auth-states/` directory - it contains sensitive authentication cookies!

## Documentation

- [Architecture Diagram](docs/architecture/ARCHITECTURE_DIAGRAM.md)
- [Control Plane Design](docs/architecture/CONTROL_PLANE_DESIGN.md)
- [Setup Guides](docs/setup/)
- [Behavioral Rules](config/behavioral_rules.md)

## License

MIT
