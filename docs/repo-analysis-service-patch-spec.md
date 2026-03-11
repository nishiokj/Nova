# Repo Analysis Service — Patch Spec

## Problem

We currently have the right backend pieces in the wrong shape.

- `entity-graph` and `test-health` already provide the structural query layer we want.
- `pr-review-service` is already a deployable HTTP service that depends on the same backend.
- Blue-team currently assumes repo-local scripts and a repo-local CLI.
- PR review currently resets shared `entity_graph.*` tables before each run, which makes the backend single-worker and collision-prone.
- The webhook listener is product-specific ingress, not the correct service boundary.

The result is duplicated runtime assumptions and a service boundary that is too narrow.

## Patch Goal

Replace the current webhook-oriented PR review service with a single deployable HTTP service that:

1. owns repo/workspace checkout and graph build
2. exposes the existing structural query surface over HTTP
3. exposes PR review as one API on top of the same backend
4. isolates backend state per workspace so concurrent use does not collide
5. reuses the existing query and review layers as directly as possible

## Non-Goals

This patch should stay small.

It does **not** need:
- a second graph runtime
- a new query engine
- a queue system
- webhook handling
- GitHub comment publishing
- broad schema rewrites across `entity-graph` SQL
- long-lived persisted job state

## Design Principles

1. **One backend, many entrypoints**
   PR review and blue-team queries use the same service.

2. **Reuse the existing query layer**
   Keep `TestHealthModule`, `EntityGraph`, `buildFullGraph`, and `reviewDiff` as the core logic.

3. **Isolate with database-per-workspace**
   Do not parameterize every SQL query with a schema name. Keep the existing `entity_graph` schema name and isolate by using a separate database per workspace.

4. **HTTP surface is thin**
   The service should be a small transport layer over existing library calls, not a second implementation of the same logic.

5. **No product-specific ingress**
   The service computes analysis results. External callers decide whether that came from a webhook, a local agent, a CI job, or a manual request.

## Proposed Runtime Boundary

Use the existing `packages/apps/pr-review-service` package as the service shell, but repurpose it into a generic repo-analysis service.

This keeps the existing Docker/deployment path and avoids creating a second deployable app.

Short-term simplification:
- keep the current package path to reduce churn
- change its HTTP API and responsibility
- remove webhook parsing and sticky-comment behavior

Renaming the package can happen later.

## Workspace Model

The service manages isolated workspaces.

Each workspace has:
- `id`
- `rootPath`
- `registryPath | null`
- `databaseUrl`
- `ownedCheckout: boolean`
- `createdAt`

Two workspace sources are enough for this patch:

1. **Local workspace**
   Caller provides a local repo root path.

2. **Git workspace**
   Service creates a temp checkout from a remote clone URL and ref/SHA inputs.

For this patch, in-memory workspace metadata is acceptable. If the service restarts, callers can recreate workspaces.

## Backend Isolation

### Why database-per-workspace

Current queries hardcode the `entity_graph` schema name. Changing all queries to support dynamic schemas would create unnecessary patch size.

Using one Postgres database per workspace avoids that:
- existing DDL stays valid
- existing query SQL stays valid
- `buildFullGraph()` stays valid
- `EntityGraph.reviewDiff()` stays valid
- test-health queries stay valid

### Required behavior

When a workspace is created:
1. allocate a unique database name
2. create the database
3. connect using that workspace database URL
4. run `SCHEMA_DDL`
5. build the graph for that workspace

When a workspace is deleted:
1. close active connections
2. drop the workspace database
3. delete temp checkout if the service owns it

This removes the current global `TRUNCATE entity_graph.*` behavior entirely.

## HTTP API

All responses are JSON. Reuse existing result types where possible.

### Health

- `GET /healthz`
- `GET /readyz`

Return basic service health.

### Workspace Lifecycle

- `POST /workspaces/local`

Request:

```json
{
  "rootPath": "/abs/path/to/repo",
  "registryPath": "/abs/path/to/test-health.yaml"
}
```

- `POST /workspaces/git`

Request:

```json
{
  "cloneUrl": "https://github.com/org/repo.git",
  "ref": "main"
}
```

Optional fields can include `baseSha`, `headSha`, or auth material if needed by the caller path.

- `DELETE /workspaces/:id`

Deletes workspace DB and owned checkout.

- `POST /workspaces/:id/rebuild`

Rebuilds the graph from the workspace filesystem.

### Query Surface

These routes should be thin wrappers around the existing query layer:

- `GET /workspaces/:id/boundaries?filepath=...`
- `GET /workspaces/:id/deps?entityId=...`
- `GET /workspaces/:id/tree?entityId=...&maxDepth=...`
- `GET /workspaces/:id/env?entityId=...`
- `GET /workspaces/:id/gaps?filepath=...`
- `GET /workspaces/:id/index?filepath=...&maxDepth=...`

Return the existing JSON result shapes from:
- `BoundaryInfo[]`
- `ReadinessVerdict`
- `CallTreeNode[]`
- `GapReport`
- `ProjectIndex`

### PR Review

- `POST /workspaces/:id/pr-review`

Request:

```json
{
  "baseSha": "abc123",
  "headSha": "def456",
  "maxDepth": 2
}
```

Behavior:
1. compute the diff inside the workspace
2. call existing PR review logic against the workspace database
3. return both JSON review output and rendered markdown

Response:

```json
{
  "review": {},
  "markdown": "..."
}
```

No GitHub comment publishing in this service.

## Code Reuse Plan

### Keep as-is

- `packages/plugins/entity-graph/src/queries.ts`
- `packages/plugins/entity-graph/src/test-health.ts`
- `packages/plugins/entity-graph/src/index.ts`
- `packages/plugins/entity-graph/src/pipeline.ts`
- `packages/plugins/entity-graph/src/pr-review/review.ts`

### Extract and reuse

Extract the reusable PR review logic from `scripts/pr-review-ci.ts`:
- `buildDiff()`
- `runReview()`
- `formatReviewMarkdown()`

Move that code into a shared module callable by the service.

The service should call library code directly, not shell out to `bun run scripts/pr-review-ci.ts`.

### Delete or stop using

- webhook signature verification path
- webhook event parsing path
- sticky PR comment publishing path
- global `resetEntityGraphTables()` behavior
- serialized webhook queue behavior

## Service Config

Keep config minimal.

Required:
- `PORT`
- `ENTITY_GRAPH_ADMIN_DATABASE_URL`
- `WORKSPACE_PARENT_DIR`

Optional:
- `GIT_BIN`
- `REQUEST_TIMEOUT_MS`

Notes:
- `ENTITY_GRAPH_ADMIN_DATABASE_URL` must have permission to create and drop databases
- workspace-specific database URLs are derived from that base connection

## File-Level Patch Shape

### Mutate existing service package

Update:
- `packages/apps/pr-review-service/src/index.ts`
- `packages/apps/pr-review-service/src/config.ts`
- `packages/apps/pr-review-service/src/types.ts`
- `packages/apps/pr-review-service/README.md`

Add:
- `packages/apps/pr-review-service/src/workspace_manager.ts`
- `packages/apps/pr-review-service/src/database_manager.ts`
- `packages/apps/pr-review-service/src/analysis_routes.ts`
- `packages/apps/pr-review-service/src/pr_review.ts`

Delete or retire:
- webhook-specific request handling in `src/index.ts`
- GitHub webhook parsing flow in `src/github.ts` if no longer needed
- queue-based job wrapper in `src/runner.ts`

### Shared extraction

Add a shared PR review library module, either under:
- `packages/plugins/entity-graph/src/pr-review/service.ts`

or, if you want zero package API churn:
- `packages/apps/pr-review-service/src/pr_review_core.ts`

Prefer the first option if the logic should be callable outside this service.

## Request Flow

### Blue-team / generic query flow

1. caller creates local workspace
2. service allocates disposable DB
3. service builds graph
4. caller hits `boundaries`, `deps`, `tree`, `env`, `gaps`, `index`

### PR review flow

1. caller creates git workspace or local workspace
2. service builds graph in that workspace DB
3. caller hits `POST /workspaces/:id/pr-review`
4. service returns review JSON + markdown
5. external caller decides whether to post to GitHub

## Acceptance Criteria

1. The service can analyze two workspaces concurrently without DB collisions.
2. The service exposes `boundaries`, `deps`, `tree`, `env`, `gaps`, and `index` over HTTP using the existing backend logic.
3. PR review no longer truncates shared `entity_graph.*` tables.
4. PR review no longer depends on webhook delivery or sticky-comment publishing.
5. The service can be used by blue-team without repo-local `bun run .../cli.ts` assumptions.
6. The service still supports the existing PR review computation path and returns the same review payload class.

## Minimal Migration Sequence

1. Extract reusable PR review library functions out of `scripts/pr-review-ci.ts`
2. Add workspace DB lifecycle management
3. Add workspace create/delete/rebuild endpoints
4. Add HTTP wrappers for test-health query endpoints
5. Add PR review endpoint on top of the same workspace backend
6. Remove webhook-specific ingress from the service
7. Update blue-team to prefer the service endpoint over repo-local CLI

## Explicit Simplicity Tradeoffs

These choices are intentional:

- in-memory workspace registry instead of persistent job metadata
- synchronous HTTP request handling instead of queue orchestration
- database-per-workspace instead of schema-parameterized SQL
- reusing the existing service package instead of creating a second daemon

This patch is meant to create the correct backend boundary with the fewest moving parts.
