# nova

Multi-agent runtime with a terminal UI, background daemon, and headless execution mode.

## Quickstart

### Prerequisites

- Bun installed
- At least one LLM provider key

### 1) Install

```bash
bun install
```

For local monorepo development, this installs all workspace dependencies.

### 2) Start the app

```bash
bun run start
```

This starts the daemon (if needed) and opens the TUI.

### 3) Configure provider keys

Inside the TUI:

- Run `/providers` to add API keys.
- Run `/models` to confirm model selection.

### 4) First prompt

Type your goal in the TUI and press Enter.

## Common Workflows

```bash
bun run start                  # daemon + TUI
bun run start:split            # daemon only (foreground)
bun run start:tui              # TUI only (attach to running daemon)
bun run start:graphd           # GraphD only

bun run build                  # build packages + apps
bun run build:plugins          # build optional plugin packages
bun run lint                   # workspace type/lint checks
bun test                       # test suite (vitest)
bun run smoke:interprocess     # basic interprocess smoke test
```

## Installation Boundary (Core vs Plugins)

The distributed `nova` package is core-only by default.

- Included: `packages/core/*`, `packages/infra/*`, `packages/apps/launcher`, `packages/apps/tui`
- Excluded: `packages/plugins/*` and plugin-specific transitive dependencies

Plugin-backed capabilities are opt-in and should be installed only when needed.

- Memory + entity graph integration: requires `memory` when `memory.enabled` and/or `entity_graph.enabled` are enabled.
- Semantic compiler workflows: require `semantic-compiler` when those workflows are enabled.
- The `memory` plugin bundles and wires `agent-memory`, `memory-injector`, `entity-graph`, and `postgres`.

Plugin install examples:

```bash
bun add memory
bun add semantic-compiler
```

For this monorepo, plugin artifacts are built explicitly:

```bash
bun run build:plugins
```

When optional modules are missing, the daemon logs a clear install hint and continues without that feature.

## Headless / CI Usage

Run a single task without the interactive TUI:

```bash
export OPENAI_API_KEY=your-key

bun run packages/apps/launcher/index.ts run \
  --input "Summarize this repository's architecture in 5 bullets" \
  --provider openai \
  --model <model-id> \
  --provider-env openai=OPENAI_API_KEY
```

`--provider-env` reads a key from an environment variable and registers it before execution.

## Repo Map

- `packages/core`: runtime primitives, orchestrator, tools, agent core
- `packages/infra`: daemon, GraphD, event bus, harness client
- `packages/apps`: launcher, TUI, dashboard apps
- `packages/plugins`: optional subsystems (`memory` bundle, semantic compiler, and internal plugin modules)
- `config`: default runtime/app config
- `docs`: architecture, specs, runbooks, setup notes
- `tests`: integration and unit tests

## Notes

- `bun run start:tui` expects the daemon to already be running.
- Provider keys are managed via `/providers` in the TUI or `--provider-env` for headless runs.
- `memory.enabled` is `false` by default in `config/defaults.json`; enabling it without the `memory` plugin only disables memory features (non-fatal).
- Entity graph requires `entity_graph.database_url` (or `ENTITY_GRAPH_DATABASE_URL` / `DATABASE_URL`) when `entity_graph.enabled` is true.
- Memory retrieval and trace persistence require the memory daemon URL (`memory.base_url` / `MEMORY_DAEMON_URL`) and its backing database/service.
- Ports default to `127.0.0.1:9555` for the daemon event bus; override via `EVENT_BUS_HOST`/`EVENT_BUS_PORT`.

## Deep Dives

- Architecture diagram: `docs/architecture/ARCHITECTURE_DIAGRAM.md`
- Control plane design: `docs/architecture/CONTROL_PLANE_DESIGN.md`
- System architecture spec: `docs/specs/SYSTEM_ARCHITECTURE.md`
- Deployable runbooks: `docs/runbooks/README.md`
- Setup/auth references: `docs/setup/`

## License

MIT
