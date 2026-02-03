# Derived Tasks

Derived tasks are automated jobs that process your data and generate insights on a schedule.

## Available Tasks

### Daily X Bookmarks Digest

Fetches your X.com bookmarks for the day, analyzes each one, researches linked content, and sends you a high-signal summary with action items.

**Location:** `scripts/derive-x-bookmarks.ts`

**Features:**
- Visits x.com using your saved auth state (`auth-states/x-auth.json`)
- Retrieves bookmarks created today
- Researches each bookmark (on X.com, web, or via linked content)
- Generates concise, high-signal analysis (no slop, no trivial info)
- Creates action items based on content
- Sends summary to Telegram

**Setup:**
1. Ensure X auth state exists: `auth-states/x-auth.json`
2. Run via CLI: `bun run scripts/derived-cli.ts create x-bookmarks-digest scripts/derive-x-bookmarks.ts --mode recurring --interval-ms 86400000`
3. Set schedule to 8pm Central Time (your local timezone)

**Output:**
- Markdown file: `data/x-bookmarks-digest/YYYY-MM-DD.md`
- Telegram notification with summary and action items

### Daily Conversation Digest

Analyzes your conversations across platforms (iMessage, Gmail, Telegram, coding sessions) to extract signal - what you're working on, recurring patterns, themes, and decisions.

**Location:** `scripts/derive-daily-digest.ts`

**Features:**
- Queries today's canonical conversations
- Feeds to harness agent incrementally
- Maintains signal map across runs (persistent session)
- Extracts active threads, recurring work, themes, decisions
- Sends daily synthesis to Telegram

**Setup:**
```bash
bun run scripts/derived-cli.ts create daily-digest scripts/derive-daily-digest.ts --mode recurring --interval-ms 86400000
```

## CLI Usage

### Create a Task

```bash
bun run scripts/derived-cli.ts create <name> <script-path> [options]
```

**Options:**
- `--mode <once|recurring|event>` - Task mode (default: once)
- `--interval-ms <ms>` - Interval for recurring mode
- `--priority <number>` - Job priority (default: 0)
- `--metadata <json>` - Metadata to attach to task/job
- `--label <text>` - Short human-readable label
- `--purpose <text>` - One-line task purpose
- `--sanity-policy <json>` - Sanity policy JSON for this task

### Examples

**Create once-off task:**
```bash
bun run scripts/derived-cli.ts create x-bookmarks-digest scripts/derive-x-bookmarks.ts --mode once
```

**Create recurring task (daily at 8pm Central):**
```bash
bun run scripts/derived-cli.ts create x-bookmarks-digest scripts/derive-x-bookmarks.ts \
  --mode recurring \
  --interval-ms 86400000 \
  --metadata '{"schedule":"20:00 CST","telegramChatId":123456789}'
```

**Create recurring task (every hour):**
```bash
bun run scripts/derived-cli.ts create aggregate-stats scripts/aggregate-stats.ts \
  --mode recurring \
  --interval-ms 3600000
```

### List Tasks

```bash
bun run scripts/derived-cli.ts list
```

### Run Task Immediately

```bash
bun run scripts/derived-cli.ts run <task-id>
```

### View Task Logs

```bash
bun run scripts/derived-cli.ts logs <task-id>
```

### View Run Reports (sanity + samples)

```bash
bun run scripts/derived-cli.ts report <task-id> --report-limit 10
```

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string (required)
- `TELEGRAM_BOT_TOKEN` - Bot token for notifications
- `TELEGRAM_ALLOWED_USERS` - Comma-separated list of allowed user IDs
- `HARNESS_HOST` - Harness daemon host (default: 127.0.0.1)
- `HARNESS_PORT` - Harness daemon port (default: 9555)

## Task Script Structure

Derived task scripts must export a `run()` function:

```typescript
import type { DerivedRunContext, DerivedRunResult } from '../src/derived/runner.js'

export async function run(ctx: DerivedRunContext): Promise<DerivedRunResult> {
  const { sql, task, logger, report } = ctx
  
  // Your logic here

  // Optional: report counts + samples for sanity checks
  report.setInputCount(10)
  report.setOutputCount(8)
  report.setModelVersion('gemini-2.5-flash-lite')
  report.addSample({ label: 'sample', value: 'Example output' })
  
  return {
    metadata: {
      // Task-specific metadata
    }
  }
}
```

**Context provides:**
- `sql` - Database query interface
- `task` - Task record with metadata
- `logger` - Logging interface
- `report` - Run reporter for metrics/samples (used by sanity policy + run logs)

## Scheduling Recurring Tasks

To schedule a task for a specific local time:

1. Calculate the interval in milliseconds (daily = 86400000)
2. Set the initial `next_run_at` in the database to your desired start time
3. The sync daemon will update `next_run_at` automatically after each run

**Example: Schedule for 8pm Central Time daily:**

```sql
-- First run at 8pm CST today
UPDATE derived_tasks 
SET next_run_at = (DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Chicago') 
                 + INTERVAL '20 hours')
WHERE name = 'x-bookmarks-digest';

-- Set interval to 24 hours
UPDATE derived_tasks 
SET interval_ms = 86400000
WHERE name = 'x-bookmarks-digest';
```

The sync daemon will automatically adjust `next_run_at` by adding `interval_ms` after each successful run.

## Troubleshooting

**Task not running?**
- Check sync daemon is running: `bun run scripts/sync-daemon.ts`
- Verify task is enabled: `bun run scripts/derived-cli.ts list`
- Check next_run_at: Query `SELECT * FROM derived_tasks WHERE name = 'x-bookmarks-digest'`

**Harness connection failed?**
- Ensure harness-daemon is running
- Check HARNESS_HOST and HARNESS_PORT settings
- Verify no firewall blocking connection

**Telegram not receiving notifications?**
- Check TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USERS are set
- Verify telegramChatId in task metadata matches your user ID
- Check bot permissions (can send messages to your chat)

## Architecture

```
derived-cli.ts
    ↓ (creates task in DB)
derived_tasks table
    ↓ (scheduled by sync daemon)
job_queue table
    ↓ (picked up by MicroQueue worker)
derived:run job
    ↓ (executes script)
derive-x-bookmarks.ts / derive-daily-digest.ts
    ↓ (communicates via HarnessClient)
harness-daemon
    ↓ (uses agent-browser skill)
x.com / web scraping
    ↓ (sends output)
Telegram connector → Your phone
```
