# Metarepo

Deployable HTTP service for repo-aware structural analysis, review, artifact persistence, and mutation execution.

Local v1 is intentionally unauthenticated. Run it on your machine and treat the process environment as the bootstrap boundary.

## Product lifecycle

Metarepo has three shipped surfaces:

- server: durable state, health checks, workflow APIs, and scorekeeping artifacts
- client CLI: installed into repos so agents can call stable commands from any checkout
- skill package: instructions that tell a coding agent how to drive the red/blue loop

The agent is the product interface. The CLI is the tool contract the agent uses.

## Packaging

The package is `packages/apps/metarepo` and exposes the `metarepo` CLI. The repo-root `./metarepo` wrapper is the development entrypoint and auto-loads `/.env.metarepo` when present.

Build and validate from the repo root:

```bash
./metarepo build
./metarepo lint
./metarepo test
```

The distributable skill lives at:

```text
packages/apps/metarepo/skills/red-blue-team/SKILL.md
```

## Installation

Start the server first, then install the client and skill into each repository under test.

```bash
./metarepo serve
```

From the target repo:

```bash
/path/to/agent/metarepo install all
.metarepo/bin/metarepo add --client
.metarepo/bin/metarepo doctor
```

Install pieces separately when needed:

```bash
/path/to/agent/metarepo install client
/path/to/agent/metarepo install skill
```

Client placement:

- `.metarepo/bin/metarepo` is the repo-local CLI wrapper for agents and humans.
- `.metarepo/client.json` stores the repo binding.
- `.agents/red-blue-team/SKILL.md` is the repo-local agent skill copy.

Re-run install commands with `--force` to replace existing local wrappers or skill files.

## Server deployment

Local single-user deployment:

```bash
METAREPO_DATABASE_URL=postgres://localhost/metarepo \
METAREPO_WORKDIR=/tmp/metarepo \
METAREPO_SECRET_MASTER_KEY="$(openssl rand -hex 32)" \
HOST=127.0.0.1 \
PORT=8080 \
./metarepo serve
```

Shared deployment is possible but not product-hardened yet. Before exposing beyond localhost, add authentication, authorization, TLS, tenant isolation, and a policy for which clients can record scorekeeping artifacts.

Minimum runtime dependencies:

- Bun
- Git
- Postgres with permission to create/drop temporary graph databases
- the repo-under-test toolchain on the client side, for example Cargo for Rust or Bun/npm for TypeScript

Server-side graph workflows may also need the language/tooling required by the entity graph indexer. Claim-first blue defense and local red evaluation intentionally run through the client repo so they can use whatever toolchain the target repo already has.

## CLI contract

Help is available at any depth:

```bash
metarepo --help
metarepo blue --help
metarepo red evaluate --help
```

Schema commands are stable contracts for agents:

```bash
metarepo claims schema
metarepo blue schema
metarepo red schema
metarepo referee schema
```

Preflight the full local lifecycle:

```bash
metarepo doctor
```

`doctor` reports server health, repo binding, installed client/skill paths, and detected repo toolchains such as Cargo or npm.

CLI errors print stable codes:

```text
metarepo[METAREPO_REPO_NOT_CONFIGURED]: No metarepo repo configured for this directory. Run `metarepo add` first.
```

Set `METAREPO_JSON_ERRORS=1` for machine-readable stderr:

```json
{"ok":false,"code":"METAREPO_REPO_NOT_CONFIGURED","error":"No metarepo repo configured for this directory. Run `metarepo add` first."}
```

Current codes:

- `METAREPO_USAGE`
- `METAREPO_UNKNOWN_COMMAND`
- `METAREPO_SERVER_UNAVAILABLE`
- `METAREPO_REPO_NOT_CONFIGURED`
- `METAREPO_REQUEST_FAILED`
- `METAREPO_VALIDATION`
- `METAREPO_INTERNAL`

## Runtime model

`metarepo` persists:
- repos
- runs
- artifacts
- event ledger entries
- bugs
- env profiles
- secret refs

`metarepo` does not persist the entity graph as a live source of truth.

For each graph-backed workflow run it:
1. resolves a concrete repo source root
2. creates a disposable graph database
3. builds the graph from the repo filesystem
4. executes the requested workflow
5. persists the outputs as artifacts
6. destroys the disposable graph database

## Required env vars

- `METAREPO_DATABASE_URL`: Postgres URL for the dedicated `metarepo` durable database. The connected role must also have permission to create and drop ephemeral graph databases.
- `METAREPO_WORKDIR`: Parent directory for temporary checkouts, worktrees, and copies.
- `METAREPO_SECRET_MASTER_KEY`: Master key used to encrypt/decrypt repo workflow secrets stored in `metarepo.secret_refs`.

## Optional env vars

- `PORT` (default `8080`)
- `HOST` (default `127.0.0.1`)
- `GIT_BIN` (default `git`)
- `REQUEST_TIMEOUT_MS` (default `900000`)

## Run locally

Create a dedicated durable database once:

```bash
createdb metarepo
```

Copy [/.env.metarepo.example](/Users/jevinnishioka/Desktop/jesus/.env.metarepo.example) to `/.env.metarepo` and edit it if needed.

Then from repository root:

```bash
./metarepo serve
```

The wrapper auto-loads `/.env.metarepo` if it exists, then falls back to `/.env`.

## Bootstrap Boundary

`metarepo` has an explicit application bootstrap boundary outside the database.

These values must come from the local shell, `.env`, CI, or your process manager:

- `METAREPO_DATABASE_URL`
- `METAREPO_WORKDIR`
- `METAREPO_SECRET_MASTER_KEY`

Repo-under-test secrets do not belong here. Those go into repo-scoped secret refs and env profiles inside `metarepo`.

## Local Onboarding

Start the service in one terminal:

```bash
./metarepo serve
```

Then from a repo checkout:

```bash
./metarepo add
./metarepo secrets add --file .env
./metarepo graph index
./metarepo graph gaps src/orders
./metarepo red targets recent
```

What those do:

- `add` registers the current repo and stores local CLI context so later commands do not need `--repo`.
- `secrets add --file .env` imports each dotenv entry as a repo secret ref, creates or updates the repo's default env profile, and binds those env vars for workflow execution.
- `graph ...` commands resolve the configured repo for the current directory, re-register it idempotently, rebuild the graph, and return typed structural context.
- `red ...` commands expose target ranking, dossiers, and deterministic mutation/referee execution. They do not replace the agent's reasoning loop.

Recommended local split:

- `agent-memory` keeps its own database
- `metarepo` uses a separate durable database like `metarepo`
- both can still live on the same Postgres instance if you want operational simplicity

## Health

```bash
curl http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/readyz
```

## API

### Resources

- `POST /repos`
- `GET /repos/:id`
- `PATCH /repos/:id`
- `GET /repos/:id/artifacts`
- `GET /repos/:id/bugs`
- `POST /repos/:id/bugs`
- `GET /repos/:id/claims`
- `POST /repos/:id/claims`
- `POST /repos/:id/blue-defenses`
- `POST /repos/:id/env-profiles`
- `POST /repos/:id/secret-refs`
- `GET /runs/:id`
- `GET /runs/:id/artifacts`
- `GET /artifacts/:id`

### RPC workflows

- `POST /rpc/graph.boundaries`
- `POST /rpc/graph.deps`
- `POST /rpc/graph.tree`
- `POST /rpc/graph.env`
- `POST /rpc/graph.readiness`
- `POST /rpc/graph.gaps`
- `POST /rpc/graph.index`
- `POST /rpc/test.recent_paths`
- `POST /rpc/test.smells`
- `POST /rpc/review.run`
- `POST /rpc/blue.assign-claim`
- `POST /rpc/red.targets`
- `POST /rpc/red.dossier`
- `POST /rpc/red.mutate`
- `POST /rpc/red.mutate.record`
- `POST /rpc/referee.run`

Example:

```bash
REPO_ID="$(curl -sS http://127.0.0.1:8080/repos \
  -H 'content-type: application/json' \
  -d "{\"name\":\"$(basename "$PWD")\",\"source\":{\"kind\":\"local\",\"rootPath\":\"$PWD\"}}" \
  | jq -r '.id')"

curl -sS http://127.0.0.1:8080/rpc/graph.index \
  -H 'content-type: application/json' \
  -d "{\"repoId\":\"$REPO_ID\",\"filepath\":\"src/orders\",\"maxDepth\":3,\"requestedBy\":\"manual\"}"
```

## Notes

- Local repos are read directly from their filesystem root on every run.
- Managed git repos are checked out into temporary owned directories per run.
- Mutation and referee workflows always use isolated temp source roots.
- On restart, unfinished runs are marked failed and any tracked temp resources are cleaned up.
- Secret refs are encrypted server-side with `METAREPO_SECRET_MASTER_KEY` and decrypted only in memory when constructing workflow child-process env.
- `metarepo` is a query/persistence backend for agents. It does not autonomously perform the blue-team or red-team reasoning loops.
