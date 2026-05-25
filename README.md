# Nova

Model agnostic filesystem tool-usage agent with terminal UI. Built on Bun.


## Quickstart

**Requirements:** [Bun](https://bun.sh) + at least one LLM provider API key.

```bash
git clone <repo>
cd nova
bun install
bun run start
```

`bun run start` launches the daemon and opens the TUI. Inside the TUI:

1. Run `/providers` — add your API key (Anthropic, OpenAI, Gemini, etc.)
2. Run `/models` — pick a model
3. Type a prompt and press Enter

That's it.

## Commands

```bash
bun run start              # daemon + TUI (normal use)
bun run start:split        # daemon only (foreground)
bun run start:tui          # TUI only (attach to running daemon)
bun run start:graphd       # GraphD only

bun run build              # build all packages
bun run build:plugins      # build optional plugins
bun run lint               # type + lint checks
bun test                   # run tests (vitest)
```

## Headless / CI

Run a single task without the TUI:

```bash
export ANTHROPIC_API_KEY=your-key

bun run packages/apps/launcher/index.ts run \
  --input "Summarize this repo in 5 bullets" \
  --provider anthropic \
  --model claude-sonnet-4-5 \
  --provider-env anthropic=ANTHROPIC_API_KEY
```

## Plugins (optional)

The distributed `nova` package ships core only. Plugins are opt-in:

```bash
bun add memory           # memory + entity graph (requires Postgres)
```

Enable in `config/defaults.json`:

```json
{ "memory": { "enabled": true }, "entity_graph": { "enabled": true } }
```

## Repo layout

```
packages/core/      — runtime primitives, orchestrator, tools, agent core
packages/infra/     — daemon, GraphD, event bus, harness client
packages/apps/      — launcher (headless), TUI, dashboard
packages/plugins/   — optional: memory bundle, semantic compiler
config/             — default runtime/app config
docs/               — architecture, specs, runbooks
tests/              — integration and unit tests
```

## Gotchas

- `bun run start:tui` requires the daemon to already be running — use `bun run start` instead.
- `memory.enabled` and `entity_graph.enabled` are `false` by default. Enabling them without the `memory` plugin is a no-op (non-fatal).
- Entity graph requires `entity_graph.database_url` (or `ENTITY_GRAPH_DATABASE_URL`) when enabled.
- Daemon event bus binds to `127.0.0.1:9555` by default; override with `EVENT_BUS_HOST` / `EVENT_BUS_PORT`.

## License

MIT
