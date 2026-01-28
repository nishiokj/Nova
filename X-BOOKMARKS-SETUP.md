# X Bookmarks Digest Setup

## ✅ Implementation Complete

The Daily X Bookmarks Digest derived task has been successfully implemented and created!

### What Was Created

1. **Script**: `packages/agent-memory/scripts/derive-x-bookmarks.ts`
   - Uses agent-browser skill with your X.com auth state
   - Fetches bookmarks from x.com/i/bookmarks
   - Researches each bookmark (follows links, web search)
   - Generates high-signal markdown analysis
   - Creates action items
   - Sends summary to Telegram

2. **Derived Task**: `x-bookmarks-digest` (ID: 01KG0TGDQDWZ6QDWDRAPPZK5Z8)
   - Mode: recurring
   - Interval: 86400000ms (24 hours)
   - Status: enabled
   - Next run: Currently set to default time

### Schedule for 8pm Central Time Daily

Run this SQL in your PostgreSQL database to set the daily schedule:

```sql
-- Schedule x-bookmarks-digest to run daily at 8pm Central Time
UPDATE derived_tasks
SET next_run_at = (
  CASE
    WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::time < '20:00'::time
    THEN (CURRENT_DATE AT TIME ZONE 'America/Chicago')::timestamp + INTERVAL '20 hours'
    ELSE ((CURRENT_DATE + INTERVAL '1 day') AT TIME ZONE 'America/Chicago')::timestamp + INTERVAL '20 hours'
  END AT TIME ZONE 'America/Chicago' AT TIME ZONE 'UTC'
)
WHERE name = 'x-bookmarks-digest';

-- Verify the schedule
SELECT name, next_run_at, interval_ms, enabled
FROM derived_tasks
WHERE name = 'x-bookmarks-digest';
```

### How to Run the SQL

**Option 1: Using DATABASE_URL directly**
```bash
psql "$DATABASE_URL" -f /tmp/schedule-x-bookmarks.sql
```

**Option 2: Using your PostgreSQL client**
- Connect to your database
- Paste the SQL above
- Execute and verify the result

### Testing the Task

Run immediately to test:

```bash
bun run packages/agent-memory/scripts/derived-cli.ts run 01KG0TGDQDWZ6QDWDRAPPZK5Z8
```

### Verify the Setup

List all derived tasks:

```bash
bun run packages/agent-memory/scripts/derived-cli.ts list
```

Look for:
```
x-bookmarks-digest [enabled]
  Next run: 2026-01-27T02:00:00.000Z  # Should be 8pm CST (UTC-6)
```

### What the Task Does

1. **Connects to Harness** at 127.0.0.1:9555
2. **Loads X auth state** from `auth-states/x-auth.json`
3. **Uses agent-browser skill** to visit x.com/i/bookmarks
4. **Extracts today's bookmarks** (created in Central Time)
5. **Researches each bookmark**:
   - Reads tweet content and replies
   - Clicks through linked articles/resources
   - Searches web for context if needed
6. **Generates markdown** at `data/x-bookmarks-digest/YYYY-MM-DD.md`:
   - High-signal analysis (why it matters)
   - Practical applications (how to use it)
   - Key insights (non-trivial, not obvious)
   - Action items tied to specific bookmarks
   - Quick summary of the day's themes
7. **Sends to Telegram** via configured bot

### Output Format Example

```markdown
# X Bookmarks Digest — 2026-01-27

## Bookmarks

### [New LLM Research from Anthropic](https://x.com/username/status/...)
**Author:** @username
**Why it matters:** Demonstrates novel approach to context window compression that reduces inference costs by 40%
**How to use it:** Implement the byte-pair encoding strategy in our RAG pipeline
**Key insight:** The trade-off between compression ratio and semantic fidelity is non-linear — optimal at ~70% compression
**Research notes:** Anthropic's technical blog explains they trained custom tokenizers specifically for code, not general text

---

## Action Items

- [ ] Implement byte-pair compression in RAG pipeline — based on Anthropic's paper
- [ ] Benchmark compression ratio vs retrieval accuracy on our corpus
- [ ] Schedule follow-up tweet with our findings

## Quick Summary

Today's bookmarks cluster around LLM infrastructure optimizations, with Anthropic's compression research being the most actionable. Other bookmarks reference related work from OpenAI and Meta.
```

### Configuration Options

The task supports these configuration options (set via metadata):

| Option | Default | Description |
|---------|----------|-------------|
| `sessionKey` | x-bookmarks-digest | Harness session name for state persistence |
| `harnessHost` | 127.0.0.1 | Harness daemon host |
| `harnessPort` | 9555 | Harness daemon port |
| `outputDir` | data/x-bookmarks-digest | Output directory for markdown files |
| `authStatePath` | auth-states/x-auth.json | Path to X.com auth state |
| `responseTimeoutMs` | 600000 | Timeout for harness responses (10 min) |
| `maxBookmarks` | 20 | Maximum bookmarks to process per run |
| `telegramChatId` | From env | Telegram chat ID for notifications |

### Environment Variables Required

- `DATABASE_URL` - PostgreSQL connection string
- `TELEGRAM_BOT_TOKEN` - Telegram bot token for notifications
- `TELEGRAM_ALLOWED_USERS` - Comma-separated list of allowed user IDs
- `HARNESS_HOST` - Harness daemon host (default: 127.0.0.1)
- `HARNESS_PORT` - Harness daemon port (default: 9555)

### Troubleshooting

**Auth state not found?**
```bash
# Run the auth setup script
./multi-site-auth-setup.sh
```

**Harness connection failed?**
```bash
# Make sure harness-daemon is running
bun run packages/harness-daemon/scripts/daemon.ts
```

**Telegram not receiving messages?**
- Check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USERS` are set
- Verify telegramChatId in task metadata matches your user ID
- Check bot has permission to send messages

**No bookmarks processed?**
- Check if you actually bookmarked anything today
- Verify Central Time timezone conversion is correct
- Review harness logs for agent-browser errors

### Monitor Task Execution

View task logs:

```bash
bun run packages/agent-memory/scripts/derived-cli.ts logs 01KG0TGDQDWZ6QDWDRAPPZK5Z8
```

### Next Steps

1. ✅ Run the SQL above to schedule for 8pm Central Time
2. ✅ Ensure sync daemon is running: `bun run scripts/sync-daemon.ts`
3. ✅ Test with manual run to verify everything works
4. ✅ Wait for 8pm Central Time to see first automated run

The task will automatically run daily at 8pm Central Time, process your bookmarks, and send the digest to Telegram! 🎉
