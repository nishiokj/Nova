# Closed-Loop System Issues Spec

**Date:** 2026-01-29
**Audited by:** Jimmy (Personal Assistant Agent)

This document catalogs issues discovered during a system audit focused on achieving closed-loop autonomy. Issues are tagged by severity and category.

---

## Critical Issues

### 1. [BUG][FIXED] Data Corruption in canonical_message Table

**Status:** FIXED
**File:** `packages/agent-memory/src/db/repositories/canonical-entity.ts:254,277`

**Problem:**
All 49,230 records in `canonical_message` have corrupted data:
- 43,178 records: `data` stored as JSON **string** (double-serialized)
- 6,052 records: `data` stored as JSON **array** (also double-serialized)
- 0 records: properly stored as JSON **object**

**Root Cause:**
```typescript
// Before (BUG):
${JSON.stringify(data)}::jsonb  // Double-serializes: object → string → jsonb string

// After (FIXED):
${sql.json(data as Parameters<typeof sql.json>[0])}  // Proper jsonb insertion
```

**Impact:**
- 21% of messages (10,378) have empty `display_text`
- All queries against `data->>'field'` return NULL
- Search, analytics, and memory injection are broken
- Workaround code in `derive_preferences.ts:677` patches over this

**Fix Applied:** Changed to `sql.json()` in both `create()` and `update()` methods.

**Migration Required:** Existing data needs to be fixed:
```sql
-- Unwrap double-serialized strings
UPDATE canonical_message
SET data = (data #>> '{}')::jsonb
WHERE jsonb_typeof(data) = 'string';

-- Unwrap double-serialized arrays (take first element)
UPDATE canonical_message
SET data = (data->0 #>> '{}')::jsonb
WHERE jsonb_typeof(data) = 'array';
```

---

### 2. [BUG][FIXED] Failed Sync Jobs Not Alerting

**Status:** FIXED
**Location:** `scripts/watchdog.ts`

**Problem:**
22 failed jobs exist without any notification:
- Obsidian vault not found errors
- rex_sessions connector not registered
- claude_sessions path errors

**Fix Applied:**
Integrated job health checking into watchdog's default autonomous behavior:
- Default run now checks both daemon health AND sync job health
- Queries `sync_jobs` table for failures in lookback period (default: 24h)
- Calculates failure rate with configurable threshold (default: 10%)
- Sends Telegram notification on job failures when `--notify` is set
- Job failures alert independently of daemon health (don't trigger restart)

**Behavior:**
```
# Autonomous mode: checks everything, restarts daemon if needed, alerts on job failures
bun run scripts/watchdog.ts --notify

# Check-only mode: exits 0 if all healthy, 1 if any issues
bun run scripts/watchdog.ts check
```

**Note:** Failed jobs themselves still need root cause fixes:
- Obsidian vault path misconfigured
- rex_sessions connector not registered
- claude_sessions path validation error

---

### 3. [BUG][FIXED] Missing Source Timestamp in Schema

**Status:** FIXED
**Location:** `canonical_message`, `canonical_conversation`, `canonical_event`, `canonical_notification`, `canonical_issue` schemas

**Problem:**
No `source_timestamp` column existed. The `created_at` column stores ingestion time, not when the event actually occurred.

**Fix Applied:**
1. Created migration `021_source_timestamp.sql` that:
   - Adds indexed `source_timestamp` column to all canonical tables
   - Backfills from JSONB data (`sent_at`, `triggered_at`, `start_at`, `started_at`)
2. Updated `TransformOutput` type to accept `sourceTimestamp`
3. Updated `CanonicalEntityRepository.create()` to accept `sourceTimestamp` option
4. Updated `TransformExecutor` to pass through `sourceTimestamp`

**Migration Required:**
```bash
psql $DATABASE_URL -f packages/agent-memory/src/db/migrations/021_source_timestamp.sql
```

**New Schema:**
```sql
created_at       -- When record was inserted (ingestion time)
updated_at       -- When record was last modified
source_timestamp -- When event actually occurred (indexed for time queries)
```

**Data Shows:**
- Messages have `data->>'sent_at'` in JSONB but it's not indexed
- `created_at` is misleading for queries like "show messages from yesterday"
- Cannot efficiently query by actual event time

**Recommendation:**
1. Add `source_timestamp TIMESTAMP WITH TIME ZONE` column
2. Index it for time-range queries
3. Populate from `data->>'sent_at'` during canonicalization
4. Use for all temporal queries

---

## High Priority Issues

### 4. [DX] Memory Injection System Weaknesses

**Location:** `packages/agent/src/memory-integration.test.ts`, Agent class

**Documented Issues (from test file):**

1. **Empty Query Generation:** No objective + no messages = empty query sent to memory API
2. **File Content Leaks:** File contents included in memory query (security issue)
3. **Artifact Leaks:** Artifact signatures leak into memory queries
4. **Unicode Truncation:** 500-char limit may split multi-byte characters
5. **Silent Failures:** Memory injection errors swallowed with empty catch block
6. **Iteration 0 Only:** Memory only injected on first iteration, becomes stale

**Impact:**
- Memory search receives empty/garbage queries
- Sensitive file content may be sent to memory API
- No visibility into memory injection failures
- Stale memory on long-running tasks

**Recommendation:**
1. Add minimum query length check (skip if < 10 chars)
2. Filter out file_content and artifacts from query building
3. Use proper Unicode-aware truncation
4. Log memory injection errors (don't swallow)
5. Consider re-injection on major context changes

---

### 5. [MISSING] Quality/Success Measurement at Iteration Level

**Problem:**
No mechanism to measure:
- Quality of agent responses at iteration level
- Success rate of task completion
- User satisfaction signals
- Regression detection

**Current State:**
- Dashboard shows token usage and execution metrics
- No success/quality metrics
- No iteration-level scoring
- No feedback loop for improvement

**Recommendation:**
1. Add `outcome` field to iteration records (success/failure/partial)
2. Track tool success rates per iteration
3. Implement user feedback capture (thumbs up/down on iterations)
4. Create derived task to compute quality trends
5. Alert on quality regression

---

### 6. [BUG] Empty display_text for Tool-Only Messages

**Severity:** Medium (root cause fixed, but design issue remains)
**Location:** `packages/agent-memory/src/connectors/coding-sessions/transforms.ts`

**Problem:**
Assistant messages with only tool calls have `body_text: ""` because `extractTextContent()` returns empty string for tool_use blocks.

**Current Behavior:**
```typescript
// Tool-only message produces:
body_text: "",
displayText: ""  // .slice(0, 200) of empty string
```

**Recommendation:**
1. For tool-only messages, generate synthetic display_text:
   ```
   [Tool calls: Read, Edit, Bash]
   ```
2. Include tool names in searchable text
3. Consider storing tool calls separately from text content

---

## Medium Priority Issues

### 7. [SLOP] Naming Inconsistency in Scripts

**Location:** `packages/agent-memory/scripts/`

**Problem:**
```
derive_preferences.ts      # Underscore
derive-preferences.test.ts # Hyphen (test file for above?)
derive-daily-digest.ts     # Hyphen
derive-x-bookmarks.ts      # Hyphen
```

**Recommendation:**
Standardize on hyphens (matches rest of codebase).

---

### 8. [SLOP] Dead/Unused Code Indicators

**Location:** Various

**Found:**
```typescript
// packages/graphd/src/manager.ts:491
derived: { callers: [] }, // TODO: implement derived edge cache

// packages/graphd/src/manager.ts:507
// TODO: implement impact engine

// packages/graphd/src/manager.ts:519
// TODO: implement ripgrep search
```

**Recommendation:**
Either implement or remove these TODO stubs. Empty implementations suggest abandoned features.

---

### 9. [CONFIG] Obsidian Connector Misconfigured

**Evidence:**
```
Failed to fetch page after 3 attempts: Obsidian vault not found at /Users/jevinnishioka/Documents/ObsidianVault
```

**Recommendation:**
1. Fix vault path in connector config
2. Add path validation on connector registration
3. Disable connector if vault doesn't exist

---

### 10. [BUG] rex_sessions Connector Not Registered

**Evidence:**
```
No connector registered for: rex_sessions
```

**Recommendation:**
1. Register rex_sessions connector
2. Add validation that sync tasks reference registered connectors
3. Prevent task creation for unregistered connectors

---

## Low Priority Issues

### 11. [DX] Watchdog Default Staleness Too High

**Location:** `scripts/watchdog.ts:39`

**Current:** 120 minutes (2 hours)

**Issue:**
2-hour staleness threshold may miss issues during normal operation. A daemon that hasn't logged in 2 hours during an active session is definitely broken.

**Recommendation:**
Consider adaptive staleness based on activity:
- Active session: 15 minutes
- Idle/async: 2 hours

---

### 12. [DOCS] Sync API CLI vs SQL CLI Confusion

**Location:** `config/skills/personal-assistant/SKILL.md`

**Problem:**
Documentation had to add extensive clarification that Sync API CLI manages pipelines, not data access. This suggests the naming/API is confusing.

**Recommendation:**
1. Rename `sync-api-cli` to `pipeline-cli` or `connector-cli`
2. Make SQL CLI more prominent for data access

---

## Summary Statistics

| Category | Count |
|----------|-------|
| Critical | 3 |
| High | 3 |
| Medium | 4 |
| Low | 2 |
| **Total** | **12** |

| Status | Count |
|--------|-------|
| Fixed | 3 |
| Needs Fix | 9 |

---

## Next Steps

1. **Immediate:** Run pending migrations:
   ```bash
   # Fix corrupted canonical_message data
   psql $DATABASE_URL -f packages/agent-memory/scripts/migrate-fix-canonical-data.sql

   # Add source_timestamp column
   psql $DATABASE_URL -f packages/agent-memory/src/db/migrations/021_source_timestamp.sql
   ```
2. **Short-term:** Fix root causes of failed sync jobs:
   - Fix Obsidian vault path or disable connector
   - Register rex_sessions connector
   - Fix claude_sessions path validation
3. **Medium-term:** Add quality/success metrics at iteration level
4. **Long-term:** Improve memory injection system robustness
