# Nova

Nova is a model-agnostic agent runtime that manages long context, provides tracing, tools and event streaming. Has RAG-based memory system, a trace viewer and cron job scheduler as additional plugins. Nova allows you to host the stateful server separately, which allows you to build clients that do not need to manage context windows over long-running sessions. They can just connect via API or CLI with the HarnessClient. 

## Quickstart

**Requirements:** [Bun](https://bun.sh) + at least one LLM provider API key.

```bash
git clone <repo>
cd nova
bun install
bun run start
```

`bun run start` launches Nova's daemon and opens the TUI. Inside the TUI:

1. Run `/providers` — add your API key (Anthropic, OpenAI, Gemini, etc.)
2. Run `/models` — pick a model
3. Type a prompt and press Enter


## Commands

From a workspace checkout:

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

From an installed package, use the `nova` binary:

```bash
nova                       # daemon + TUI
nova --daemon-only         # daemon only (foreground)
nova --restart             # restart daemon, then open TUI
nova run --help            # headless CLI usage
```

## Headless / CI

Run a single task without the TUI:

```bash
export ANTHROPIC_API_KEY=your-key

nova run \
  --input "Summarize this repo in 5 bullets" \
  --provider anthropic \
  --model claude-sonnet-4-5 \
  --provider-env anthropic=ANTHROPIC_API_KEY
```

From a checkout without installing the package binary, the same command is:

```bash
bun run packages/apps/launcher/index.ts run \
  --input "Summarize this repo in 5 bullets" \
  --provider anthropic \
  --model claude-sonnet-4-5 \
  --provider-env anthropic=ANTHROPIC_API_KEY
```

## Private service usage

Run the daemon as a private service:

```bash
NOVA_SERVICE_TOKEN=replace-me \
bun run packages/infra/harness-daemon/src/index.ts \
  --host 0.0.0.0 \
  --port 9555 \
  --idle-timeout 0
```

Connect from another TypeScript project:

```ts
import { HarnessClient } from '@nova/client';

const nova = new HarnessClient({
  host: '127.0.0.1',
  port: 9555,
  authToken: process.env.NOVA_SERVICE_TOKEN,
});

await nova.connect();
console.log(await nova.health());
console.log(await nova.readiness());

await nova.initSession({ workingDir: process.cwd() });
const response = await nova.runToCompletion({
  text: 'Summarize this repository in 5 bullets.',
  workingDir: process.cwd(),
});
console.log(response.content);

nova.close();
```

Connect from Python:

```python
from nova_client import NovaClient

nova = NovaClient("127.0.0.1", 9555, auth_token="replace-me")
nova.connect()
print(nova.health())
print(nova.readiness())

nova.init_session(working_dir="/workspace/app")
response = nova.run_to_completion(
    "Summarize this repository in 5 bullets.",
    working_dir="/workspace/app",
)
print(response.get("content"))

nova.close()
```

Build and run the service image:

```bash
bun run --cwd packages/infra/harness-daemon build
docker build -f Dockerfile.nova-service -t nova-service:local .
docker run --rm -p 9555:9555 \
  -e NOVA_SERVICE_TOKEN=replace-me \
  nova-service:local
```

The service image runs the built daemon artifact. It does not install the whole monorepo inside the container.

## Plugins (optional)

The distributed `nova` package ships core only. Plugins are opt-in:

```bash
bun add memory           # memory + entity graph (requires Postgres)
```

Enable in `config/defaults.json`:

```json
{ "memory": { "enabled": true }, "entity_graph": { "enabled": true } }
```

## Distribution surfaces

Nova ships as separate surfaces:

- `nova` — the app/runtime package: CLI, daemon, TUI, built runtime packages, and default config
- `@nova/protocol` — the language-neutral wire contract: bus messages, bridge commands/events, RPC types, validators, and conformance fixtures
- `@nova/client` — the TypeScript client for private Nova services
- `nova-client` — the Python client for private Nova services

The root app package does not ship local `.agent` state, `.lab` artifacts, bundled skills, or the SDK package trees.

## Repo layout

```
packages/core/      — runtime primitives, orchestrator, tools, agent core
packages/infra/     — daemon, GraphD, event bus, TypeScript client
packages/clients/   — language-specific service clients
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
- Set `NOVA_SERVICE_TOKEN` for private service deployments; clients pass it as `authToken`.

## License

MIT
