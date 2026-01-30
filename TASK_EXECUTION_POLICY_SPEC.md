# Task Execution Policy Spec

This spec defines execution policies for derived tasks and jobs. Goals:
- Prevent wasted resources (API credits, compute)
- Enable intelligent retry behavior
- Provide cost control and rate limiting
- Maintain backwards compatibility with existing tasks

## 1. Replay Policy (P0)

### Problem
Nothing prevents re-running a completed task that already consumed API credits or performed irreversible side effects.

### Schema Addition
```sql
ALTER TABLE derived_tasks ADD COLUMN replay_policy TEXT DEFAULT 'always';
ALTER TABLE derived_tasks ADD COLUMN idempotent INTEGER DEFAULT 1;
ALTER TABLE derived_tasks ADD COLUMN cooldown_ms INTEGER;
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `replay_policy` | enum | `'always'` | When task can be re-run |
| `idempotent` | boolean | `true` | Whether re-running produces same result |
| `cooldown_ms` | integer | `null` | Min time between successful runs |

### Replay Policy Values

| Value | Behavior |
|-------|----------|
| `'always'` | Can be triggered anytime (default, backwards-compatible) |
| `'on_failure'` | Only re-run if last execution failed |
| `'once'` | Never re-run after first successful completion |
| `'cooldown'` | Respect `cooldown_ms` between successful runs |

### Runtime Behavior

In `POST /derived/tasks/:id/run`:

```typescript
async function canReplay(task: DerivedTask): Promise<{ allowed: boolean; reason?: string }> {
  if (task.replay_policy === 'always') {
    return { allowed: true }
  }

  const lastJob = await derivedJobRepo.findLastCompleted(task.id)

  if (!lastJob) {
    return { allowed: true } // never run, allow
  }

  switch (task.replay_policy) {
    case 'once':
      return { allowed: false, reason: 'Task already completed successfully' }

    case 'on_failure':
      if (lastJob.status === 'completed') {
        return { allowed: false, reason: 'Last run succeeded, replay_policy=on_failure' }
      }
      return { allowed: true }

    case 'cooldown':
      const elapsed = Date.now() - lastJob.completed_at.getTime()
      if (elapsed < task.cooldown_ms) {
        const remaining = task.cooldown_ms - elapsed
        return { allowed: false, reason: `Cooldown: ${remaining}ms remaining` }
      }
      return { allowed: true }
  }
}
```

### Override

Add `force: true` to bypass replay policy (for admin/debug use):

```typescript
POST /derived/tasks/:id/run
{ "force": true }
```

Log when force is used for audit trail.

---

## 2. Failure Classification (P0)

### Problem
All failures treated equally. Permanent failures (bad config) retry pointlessly. Rate limits aren't respected.

### Schema Addition
```sql
ALTER TABLE derived_jobs ADD COLUMN failure_class TEXT;
ALTER TABLE derived_jobs ADD COLUMN retry_after INTEGER; -- ms
```

### Failure Classes

| Class | Behavior | Example |
|-------|----------|---------|
| `'transient'` | Retry immediately with standard backoff | Network timeout |
| `'rate_limited'` | Respect `retry_after`, then retry | 429 response |
| `'resource'` | Pause task until resource restored | Out of API credits |
| `'permanent'` | No retry, open circuit immediately | Invalid API key, bad config |
| `'unknown'` | Default behavior (standard retry) | Unclassified errors |

### Script Return Contract

Scripts can classify their failures:

```typescript
// In derived task script
export async function run(ctx: DerivedTaskContext): Promise<DerivedTaskResult> {
  try {
    const response = await fetch(...)
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '60') * 1000
      return {
        error: 'Rate limited by API',
        failureClass: 'rate_limited',
        retryAfter,
      }
    }
    if (response.status === 401) {
      return {
        error: 'Invalid API key',
        failureClass: 'permanent',
      }
    }
    // ... success path
  } catch (err) {
    if (err.code === 'ECONNRESET') {
      return { error: err.message, failureClass: 'transient' }
    }
    return { error: err.message } // defaults to 'unknown'
  }
}
```

### Runtime Behavior

In job executor:

```typescript
function handleJobFailure(job: DerivedJob, result: DerivedTaskResult) {
  const failureClass = result.failureClass || 'unknown'

  switch (failureClass) {
    case 'permanent':
      // No retry, immediately open circuit
      await derivedTaskRepo.recordFailure(job.task_id, result.error, { openCircuit: true })
      await derivedJobRepo.markFailed(job.id, result.error, 'permanent')
      break

    case 'rate_limited':
      // Schedule retry after specified delay
      const retryAt = new Date(Date.now() + (result.retryAfter || 60000))
      await derivedJobRepo.scheduleRetry(job.id, retryAt)
      break

    case 'resource':
      // Pause the task entirely until manual intervention
      await derivedTaskRepo.update(job.task_id, { enabled: false, paused_reason: result.error })
      await derivedJobRepo.markFailed(job.id, result.error, 'resource')
      break

    case 'transient':
    case 'unknown':
    default:
      // Standard exponential backoff retry
      if (job.retry_count < task.max_retries) {
        const backoff = computeBackoff(job.retry_count + 1)
        await derivedJobRepo.scheduleRetry(job.id, new Date(Date.now() + backoff))
      } else {
        await derivedTaskRepo.recordFailure(job.task_id, result.error)
        await derivedJobRepo.markFailed(job.id, result.error, failureClass)
      }
  }
}
```

---

## 3. Resource Budgeting (P1)

### Problem
No rate limiting per task. No way to cap API spend. Multiple tasks can stampede a shared API.

### Schema Additions

```sql
-- Per-task rate limit
ALTER TABLE derived_tasks ADD COLUMN rate_limit_max INTEGER;      -- max runs
ALTER TABLE derived_tasks ADD COLUMN rate_limit_window_ms INTEGER; -- per window

-- Resource pool assignment
ALTER TABLE derived_tasks ADD COLUMN resource_pool TEXT;

-- Global resource pools config
CREATE TABLE resource_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  max_concurrent INTEGER DEFAULT 10,
  requests_per_minute INTEGER,
  daily_budget_cents INTEGER,
  current_spend_cents INTEGER DEFAULT 0,
  budget_reset_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### Per-Task Rate Limiting

```typescript
interface RateLimit {
  max: number       // max executions
  windowMs: number  // time window
}

// Example: max 10 runs per hour
{ rate_limit_max: 10, rate_limit_window_ms: 3600000 }
```

### Enforcement

Before scheduling a job:

```typescript
async function checkRateLimit(task: DerivedTask): Promise<{ allowed: boolean; retryAfter?: number }> {
  if (!task.rate_limit_max) return { allowed: true }

  const windowStart = new Date(Date.now() - task.rate_limit_window_ms)
  const recentJobs = await derivedJobRepo.countSince(task.id, windowStart)

  if (recentJobs >= task.rate_limit_max) {
    // Find oldest job in window, calculate when it exits
    const oldestInWindow = await derivedJobRepo.findOldestInWindow(task.id, windowStart)
    const retryAfter = oldestInWindow.created_at.getTime() + task.rate_limit_window_ms - Date.now()
    return { allowed: false, retryAfter }
  }

  return { allowed: true }
}
```

### Resource Pools

Tasks can declare which resource pool they consume:

```typescript
// Task config
{ resource_pool: 'openai' }

// Pool config
{
  name: 'openai',
  max_concurrent: 5,        // max parallel requests
  requests_per_minute: 60,  // RPM cap
  daily_budget_cents: 1000, // $10/day cap
}
```

Pool enforcement happens at job dequeue time:

```typescript
async function acquireResource(poolId: string): Promise<{ acquired: boolean; retryAfter?: number }> {
  const pool = await resourcePoolRepo.findById(poolId)
  if (!pool) return { acquired: true } // no pool = no limit

  // Check concurrent limit
  const running = await derivedJobRepo.countRunningByPool(poolId)
  if (running >= pool.max_concurrent) {
    return { acquired: false, retryAfter: 1000 } // retry in 1s
  }

  // Check RPM
  const lastMinute = new Date(Date.now() - 60000)
  const rpm = await derivedJobRepo.countCompletedSince(poolId, lastMinute)
  if (pool.requests_per_minute && rpm >= pool.requests_per_minute) {
    return { acquired: false, retryAfter: 5000 }
  }

  // Check budget
  if (pool.daily_budget_cents && pool.current_spend_cents >= pool.daily_budget_cents) {
    return { acquired: false, retryAfter: null } // wait for budget reset
  }

  return { acquired: true }
}
```

### Cost Reporting

Scripts can report cost:

```typescript
return {
  success: true,
  cost_cents: 15, // report API cost
}
```

Executor accumulates to pool:

```typescript
if (result.cost_cents && task.resource_pool) {
  await resourcePoolRepo.addSpend(task.resource_pool, result.cost_cents)
}
```

---

## 4. Timeout Policy (P1)

### Problem
Hardcoded 12s timeout. No per-task configuration. No heartbeat enforcement.

### Schema Addition

```sql
ALTER TABLE derived_tasks ADD COLUMN timeout_ms INTEGER DEFAULT 30000;
ALTER TABLE derived_tasks ADD COLUMN heartbeat_interval_ms INTEGER;
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeout_ms` | integer | `30000` | Max execution time |
| `heartbeat_interval_ms` | integer | `null` | If set, script must checkpoint within this interval |

### Heartbeat Contract

If `heartbeat_interval_ms` is set, scripts must call `ctx.checkpoint()` regularly:

```typescript
export async function run(ctx: DerivedTaskContext) {
  for (const item of items) {
    await processItem(item)
    await ctx.checkpoint({ processed: item.id }) // heartbeat + save progress
  }
}
```

Executor enforces:

```typescript
class TimeoutEnforcer {
  private lastHeartbeat = Date.now()

  checkpoint(metadata?: object) {
    this.lastHeartbeat = Date.now()
    // persist metadata for crash recovery
  }

  check(task: DerivedTask): boolean {
    const now = Date.now()

    // Overall timeout
    if (now - this.startTime > task.timeout_ms) {
      return false // kill
    }

    // Heartbeat timeout
    if (task.heartbeat_interval_ms) {
      if (now - this.lastHeartbeat > task.heartbeat_interval_ms) {
        return false // kill
      }
    }

    return true
  }
}
```

---

## 5. Defaults & Migration

### Defaults (Backwards Compatible)

| Field | Default | Rationale |
|-------|---------|-----------|
| `replay_policy` | `'always'` | Existing behavior |
| `idempotent` | `true` | Assume safe unless declared |
| `cooldown_ms` | `null` | No cooldown |
| `timeout_ms` | `30000` | 30s reasonable default |
| `heartbeat_interval_ms` | `null` | No heartbeat required |
| `rate_limit_max` | `null` | No rate limit |
| `resource_pool` | `null` | No pool |

### Migration

```sql
-- 024_task_execution_policies.sql

ALTER TABLE derived_tasks ADD COLUMN replay_policy TEXT DEFAULT 'always';
ALTER TABLE derived_tasks ADD COLUMN idempotent INTEGER DEFAULT 1;
ALTER TABLE derived_tasks ADD COLUMN cooldown_ms INTEGER;
ALTER TABLE derived_tasks ADD COLUMN timeout_ms INTEGER DEFAULT 30000;
ALTER TABLE derived_tasks ADD COLUMN heartbeat_interval_ms INTEGER;
ALTER TABLE derived_tasks ADD COLUMN rate_limit_max INTEGER;
ALTER TABLE derived_tasks ADD COLUMN rate_limit_window_ms INTEGER;
ALTER TABLE derived_tasks ADD COLUMN resource_pool TEXT;

ALTER TABLE derived_jobs ADD COLUMN failure_class TEXT;
ALTER TABLE derived_jobs ADD COLUMN retry_after INTEGER;
ALTER TABLE derived_jobs ADD COLUMN cost_cents INTEGER;

CREATE TABLE IF NOT EXISTS resource_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  max_concurrent INTEGER DEFAULT 10,
  requests_per_minute INTEGER,
  daily_budget_cents INTEGER,
  current_spend_cents INTEGER DEFAULT 0,
  budget_reset_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_derived_tasks_resource_pool ON derived_tasks(resource_pool);
CREATE INDEX IF NOT EXISTS idx_derived_jobs_failure_class ON derived_jobs(failure_class);
```

---

## 6. API Changes

### Create Task

```typescript
POST /derived/tasks
{
  "name": "sync-github-issues",
  "scriptPath": "./scripts/sync-github.ts",
  "mode": "recurring",
  "intervalMs": 3600000,

  // New policy fields
  "replayPolicy": "cooldown",
  "cooldownMs": 1800000,        // 30 min between runs
  "idempotent": true,
  "timeoutMs": 60000,           // 1 min timeout
  "heartbeatIntervalMs": 10000, // must checkpoint every 10s
  "rateLimitMax": 100,
  "rateLimitWindowMs": 86400000, // 100 runs per day
  "resourcePool": "github"
}
```

### Run Task Response

```typescript
POST /derived/tasks/:id/run

// Success
{ "task": {...}, "job": {...} }

// Blocked by policy
{
  "error": "rate_limited",
  "message": "Rate limit exceeded (100/day)",
  "retryAfter": 3600000
}

// Blocked by replay policy
{
  "error": "replay_blocked",
  "message": "Task already completed successfully, replay_policy=once"
}
```

### Script Result Contract

```typescript
interface DerivedTaskResult {
  // Existing
  success?: boolean
  error?: string
  metadata?: Record<string, unknown>

  // New
  failureClass?: 'transient' | 'rate_limited' | 'resource' | 'permanent' | 'unknown'
  retryAfter?: number    // ms, hint for scheduler
  cost_cents?: number    // for budget tracking
}
```

---

## 7. Observability

### Metrics to Add

```typescript
// Task-level
derived_task_runs_total{task, status, failure_class}
derived_task_duration_ms{task}
derived_task_cost_cents{task, pool}

// Pool-level
resource_pool_concurrent{pool}
resource_pool_rpm{pool}
resource_pool_spend_cents{pool}
resource_pool_budget_remaining_cents{pool}
```

### Audit Log

Log policy enforcement decisions:

```typescript
{
  timestamp: '2026-01-30T...',
  task_id: 'abc123',
  action: 'run_blocked',
  reason: 'replay_policy',
  details: { policy: 'once', last_success: '2026-01-29T...' }
}
```

---

## 8. Summary

| Policy | Field(s) | Default | Location |
|--------|----------|---------|----------|
| Replay | `replay_policy`, `cooldown_ms` | `'always'`, `null` | `derived_tasks` |
| Idempotency | `idempotent` | `true` | `derived_tasks` |
| Failure Class | `failure_class`, `retry_after` | `'unknown'`, `null` | `derived_jobs` |
| Timeout | `timeout_ms`, `heartbeat_interval_ms` | `30000`, `null` | `derived_tasks` |
| Rate Limit | `rate_limit_max`, `rate_limit_window_ms` | `null`, `null` | `derived_tasks` |
| Resource Pool | `resource_pool` | `null` | `derived_tasks` |
| Cost | `cost_cents` | `null` | `derived_jobs` |
