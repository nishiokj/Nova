# PR Review Service

Central GitHub webhook service that runs PR review jobs in one worker image.

## What it does

1. Receives `pull_request` webhooks.
2. Checks out PR code in an ephemeral workspace.
3. Runs deterministic review via `scripts/pr-review-ci.ts`.
4. Posts/updates sticky PR comment through GitHub API.

The service is stateless; each job uses a temporary checkout directory and removes it after execution.
Each job also resets `entity_graph.*` tables before scanning so review state is rebuilt from that PR workspace.

Concurrency note: this reset strategy assumes one worker process per database. If you scale horizontally,
use per-worker or per-job databases to avoid collisions.

## Required env vars

- `ENTITY_GRAPH_DATABASE_URL` (or `DATABASE_URL`): Postgres URL for entity graph tables.
- `GITHUB_WEBHOOK_SECRET`: Webhook signature secret (recommended).
- One GitHub auth mode:
  - `GITHUB_TOKEN` (or local GitHub CLI auth via `gh auth login`), or
  - `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` (GitHub App mode).

## Optional env vars

- `PORT` (default `8080`)
- `GITHUB_API_URL` (default `https://api.github.com`)
- `WORKSPACE_PARENT_DIR` (default system temp dir)
- `REQUEST_TIMEOUT_MS` (default `900000`)
- `PR_REVIEW_SCRIPT_PATH` (default `<repo>/scripts/pr-review-ci.ts`)
- `BUN_BIN` (default `bun`)
- `GIT_BIN` (default `git`)

## Run locally

```bash
bun run --cwd packages/apps/pr-review-service start
```

From repository root, convenience commands:

```bash
bun run pr-review:local
bun run pr-review:service:local
```

Health endpoint:

```bash
curl http://127.0.0.1:8080/healthz
```

## Deploy independently from monorepo

This service can be deployed independently while staying in this monorepo.

1. Image pipeline: `.github/workflows/pr-review-service-deploy.yml`
2. Triggered automatically when PR review service code (or its review logic deps) changes.
3. Publishes image to:
   - `ghcr.io/<github-owner>/<repo>-pr-review-service:latest` (on default branch)
   - `ghcr.io/<github-owner>/<repo>-pr-review-service:sha-<commit>`

You can also run the pipeline manually from GitHub Actions via `workflow_dispatch`.

Example runtime:

```bash
docker run --rm -p 8080:8080 \
  -e ENTITY_GRAPH_DATABASE_URL='postgres://postgres:postgres@host.docker.internal:5432/agent_memory' \
  -e GITHUB_WEBHOOK_SECRET='your-webhook-secret' \
  -e GITHUB_APP_ID='123456' \
  -e GITHUB_APP_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----' \
  ghcr.io/<github-owner>/<repo>-pr-review-service:latest
```
