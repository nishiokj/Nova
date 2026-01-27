# Derived Tasks

Derived tasks are post-processing scripts that run on synced canonical data. They enable you to transform, analyze, or extract insights from the data after it has been synced and normalized.

## Architecture

```
Sync (Collect/Process) → Raw Envelopes → Canonical Entities
                                              ↓
                                      Derived Tasks (run on canonical data)
                                              ↓
                                      Derived Output
```

## Components

1. **Derived Script** - A TypeScript module that exports a `run()` function
2. **Derived Task** - Database record that defines when/how to run the script
3. **Derived Job** - Database record that tracks each execution
4. **DerivedEngine** - Queue-based worker that processes jobs

## Creating a Derived Task Script

A derived task script is a TypeScript module with the following interface:

```typescript
import type {
  DerivedRunContext,
  DerivedRunResult,
} from '../src/derived/runner.js'

export async function run(
  ctx: DerivedRunContext
): Promise<DerivedRunResult> {
  const { sql, task, job, logger } = ctx

  // 1. Read from database
  const data = await sql`SELECT * FROM canonical_entities LIMIT 100`

  // 2. Process/transform data
  const result = processData(data)

  // 3. Write back to database (optional)
  // await sql`INSERT INTO ...`

  // 4. Return result
  return {
    outputRef: `output_${job.id}`,
    metadata: { processed: result.length },
  }
}
```

### Context Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `sql` | `Sql` | Postgres database connection |
| `task` | `DerivedTask` | The task definition (name, mode, config) |
| `job` | `DerivedJob` | The current job execution tracking |
| `logger` | `Logger` | Logging utility with `info`, `warn`, `error`, `debug` |

### Result Format

```typescript
interface DerivedRunResult {
  outputRef?: string        // Reference to stored output (optional)
  metadata?: Record<string, unknown>  // Arbitrary metadata to store with job
}
```

## Registering a Derived Task

### Via CLI

```bash
# Create a once-off task
bun run scripts/derived-cli.ts create extract-preferences scripts/derive-preferences.ts --mode once

# Create a recurring task (every hour)
bun run scripts/derived-cli.ts create aggregate-stats scripts/derive-stats.ts --mode recurring --interval-ms 3600000

# List all tasks
bun run scripts/derived-cli.ts list
```

### Via HTTP API

```bash
# Create a task
curl -X POST http://localhost:3001/api/derived/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "extract-preferences",
    "scriptPath": "scripts/derive-preferences.ts",
    "mode": "once",
    "metadata": {
      "limit": 100
    }
  }'

# List tasks
curl http://localhost:3001/api/derived/tasks

# Run a task immediately
curl -X POST http://localhost:3001/api/derived/tasks/{id}/run \
  -H "Content-Type: application/json" \
  -d '{"priority": 10}'
```

## Running Derived Tasks

Derived tasks are processed by the **DerivedEngine**, which is part of the SyncDaemon.

### 1. Ensure SyncDaemon is Running

```bash
bun run packages/agent-memory/scripts/sync-daemon.ts
```

The DerivedEngine starts automatically and begins polling for pending jobs.

### 2. Trigger a Task

**Option A: Run immediately via API**
```bash
curl -X POST http://localhost:3001/api/derived/tasks/{id}/run
```

**Option B: Wait for scheduler (recurring/event tasks)**
The scheduler will automatically trigger tasks when their `next_run_at` time is reached.

### 3. Monitor Execution

```bash
# View job logs via CLI
bun run scripts/derived-cli.ts logs {task-id}

# Or via API
curl http://localhost:3001/api/derived/jobs?taskId={task-id}
```

## Task Modes

| Mode | Description |
|------|-------------|
| `once` | Runs once, then auto-disables |
| `recurring` | Runs repeatedly at `interval_ms` |
| `event` | Triggered manually via API |

## Examples

### Example 1: Entity Statistics (Simple)

See `scripts/derive-example.ts` - computes basic statistics about canonical entities.

```typescript
export async function run(ctx: DerivedRunContext): Promise<DerivedRunResult> {
  const { sql, logger } = ctx

  const stats = await sql`
    SELECT type, COUNT(*) as count
    FROM canonical_entities
    GROUP BY type
  `

  logger.info(`Found ${stats.length} entity types`)

  return { metadata: { stats } }
}
```

### Example 2: Preference Extraction (Complex)

See `scripts/derive-preferences.ts` - extracts user preferences using LLM:
1. Fetches raw envelopes from database
2. Parses conversation content
3. Chunks large conversations
4. Calls Gemini API to extract preferences
5. Deduplicates and returns results

## Accessing Script Configuration

Pass configuration via the `metadata` field when creating the task:

```bash
bun run scripts/derived-cli.ts create my-task scripts/my-script.ts \
  --metadata '{"limit": 500, "afterDate": "2025-01-01"}'
```

Then access in your script:

```typescript
export async function run(ctx: DerivedRunContext): Promise<DerivedRunResult> {
  const config = ctx.task.metadata as { limit?: number; afterDate?: string } | undefined

  const limit = config?.limit ?? 100
  const afterDate = config?.afterDate

  const data = await sql`
    SELECT * FROM canonical_entities
    WHERE created_at >= ${afterDate}
    LIMIT ${limit}
  `
  // ...
}
```

## Error Handling

Errors in your script will:
1. Be logged to the console
2. Be stored in the job's `last_error` field
3. Mark the job as `failed`
4. Trigger retry logic (if configured)

Throw errors for recoverable failures:

```typescript
export async function run(ctx: DerivedRunContext): Promise<DerivedRunResult> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not set')
  }
  // ...
}
```

## Best Practices

1. **Keep scripts idempotent** - Running the same script multiple times should be safe
2. **Use the logger** - Log progress and errors for debugging
3. **Return metadata** - Store useful summary information in the result
4. **Handle large datasets** - Use batching/pagination for large queries
5. **Document dependencies** - Note any required environment variables or APIs

## Troubleshooting

### Job stuck in `pending` status
- Verify SyncDaemon is running with DerivedEngine
- Check logs for queue processing errors

### Script not found
- Ensure `scriptPath` is relative to project root
- Verify file is a valid TypeScript module with `run()` export

### Environment variables not available
- Derived tasks run in the SyncDaemon process
- Set env vars before starting `sync-daemon.ts`

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/derived/tasks` | GET | List all tasks |
| `/api/derived/tasks` | POST | Create a task |
| `/api/derived/tasks/:id` | GET | Get task details |
| `/api/derived/tasks/:id/run` | POST | Run task immediately |
| `/api/derived/jobs` | GET | List jobs |
| `/api/derived/jobs/stats` | GET | Get queue stats |
