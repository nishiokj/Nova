# ID Generation and Uniqueness

## Problem

When running the agent directly (not through harness), `req_id` was being reused across multiple requests, causing:
- ❌ Overwrites in `/logs/reconstructed/` folder
- ❌ Inability to distinguish between different user requests
- ❌ Confusion in logging (same req_id for multiple episodes)

## Solution

**Fixed**: Agent now generates unique `req_id` for each run if the logger doesn't already have one.

## ID Hierarchy

```
session_id (per process lifetime)
    │
    ├─> req_id (per user request)
    │     │
    │     └─> exec_id (per execution attempt)
    │           │
    │           └─> step_id (per plan step)
```

### ID Formats

| ID Type | Format | Example | Scope |
|---------|--------|---------|-------|
| `session_id` | `{uuid8}` | `3a5c7ea6` | Process lifetime |
| `req_id` | `{session_id}-{counter:04d}` | `3a5c7ea6-0001` | User request |
| `exec_id` | `{req_id}-exec-{counter:04d}` | `3a5c7ea6-0001-exec-0001` | Execution attempt |
| `plan_id` | `{exec_id}-plan` | `3a5c7ea6-0001-exec-0001-plan` | Execution plan |
| `step_id` | `{exec_id}-step-{step_num}` | `3a5c7ea6-0001-exec-0001-step-1` | Individual step |

## When IDs Are Generated

### Session ID (Once per process)

```python
# harness/logger.py __init__
self._session_id = str(uuid.uuid4())[:8]
```

**Lifecycle**: Created when logger is initialized, persists for process lifetime.

### Request ID (Once per user request)

**Via Harness (Automatic):**
```python
# harness/harness.py - process_request()
request_id = self.logger.new_request()  # Generates: {session_id}-{counter}
```

**Direct Agent Call (Fixed - Now Automatic):**
```python
# harness/agent.py - run()
if self.logger.request_id is None:
    req_id = self.logger.new_request()  # ✅ Generates new ID
else:
    req_id = self.logger.request_id    # Uses existing
```

**Lifecycle**: One per user request. If calling agent directly multiple times, each call gets a new `req_id`.

### Execution ID (Once per execution attempt)

```python
# harness/agent_execution_logger.py
exec_id = self.exec_logger.new_execution_id(req_id)
# Generates: {req_id}-exec-{counter}
```

**Lifecycle**: One per agent execution. Multiple executions for same request would get different `exec_id`s.

**Use Case**: Retries, different tiers, or re-attempts of same user request.

### Plan ID (Derived)

```python
plan_id = f"{exec_id}-plan"
```

**Lifecycle**: One per execution plan.

### Step ID (Derived)

```python
step_id = f"{exec_id}-step-{step_num}"
```

**Lifecycle**: One per plan step.

## File Naming

### Execution Logs

```
logs/agent_execution.jsonl
├─ Entries indexed by: req_id, exec_id, step_id
└─ Query pattern: grep '"exec_id": "abc-123-exec-0001"'
```

### RL Training Logs

```
logs/rl_training.jsonl
├─ Entries indexed by: req_id, exec_id
└─ Query pattern: grep '"exec_id": "abc-123-exec-0001"'
```

### Reconstructed Episodes

```
logs/reconstructed/
├─ {exec_id}_full.json        ✅ Uses exec_id (UNIQUE)
└─ 3a5c7ea6-0001-exec-0001_full.json
```

**Why `exec_id`?**
- ✅ Always unique (even for same req_id)
- ✅ One file per execution
- ✅ No overwrites

## Example Flow

### Scenario: User makes 2 requests via agent directly

```python
from harness.agent import Agent

agent = Agent(...)

# Request 1
response1 = agent.run("Create test1.txt")
# Generated IDs:
# req_id: 3a5c7ea6-0001
# exec_id: 3a5c7ea6-0001-exec-0001
# File: logs/reconstructed/3a5c7ea6-0001-exec-0001_full.json

# Request 2
response2 = agent.run("Create test2.txt")
# Generated IDs:
# req_id: 3a5c7ea6-0002  ✅ NEW (auto-incremented)
# exec_id: 3a5c7ea6-0002-exec-0001
# File: logs/reconstructed/3a5c7ea6-0002-exec-0001_full.json  ✅ Different file!
```

### Scenario: User makes 2 requests via harness

```python
from harness.harness import Harness

harness = Harness(...)

# Request 1
response1 = harness.process_request("Create test1.txt")
# req_id: 3a5c7ea6-0001 (harness calls logger.new_request())
# exec_id: 3a5c7ea6-0001-exec-0001

# Request 2
response2 = harness.process_request("Create test2.txt")
# req_id: 3a5c7ea6-0002 (harness calls logger.new_request() again)
# exec_id: 3a5c7ea6-0002-exec-0001
```

## Uniqueness Guarantees

| ID | Unique Within | Guaranteed By |
|----|---------------|---------------|
| `session_id` | All processes (globally unique UUID) | `uuid.uuid4()` |
| `req_id` | Session | Counter + session_id |
| `exec_id` | Request | Counter + req_id |
| `step_id` | Execution | step_num + exec_id |

## Querying by ID

### Find all logs for a request

```bash
# All executions for a request
grep '"req_id": "3a5c7ea6-0001"' logs/agent_execution.jsonl

# Specific execution
grep '"exec_id": "3a5c7ea6-0001-exec-0001"' logs/agent_execution.jsonl
```

### Reconstruct specific execution

```python
from harness.rl_reconstructor import EpisodeReconstructor

reconstructor = EpisodeReconstructor()

# Reconstruct by exec_id (always unique)
episode = reconstructor.reconstruct("3a5c7ea6-0001-exec-0001")
```

## Common Issues (Now Fixed)

### ❌ Before Fix: Overwrites in reconstructed folder

```python
agent = Agent(...)

# Request 1
agent.run("Create test1.txt")
# File: logs/reconstructed/no-req-exec-0001_full.json

# Request 2
agent.run("Create test2.txt")
# File: logs/reconstructed/no-req-exec-0002_full.json  ❌ OVERWRITES!
```

**Problem**: `req_id` was "no-req", so `exec_id` counter kept incrementing but req_id stayed same.

### ✅ After Fix: Unique files

```python
agent = Agent(...)

# Request 1
agent.run("Create test1.txt")
# req_id: 3a5c7ea6-0001
# exec_id: 3a5c7ea6-0001-exec-0001
# File: logs/reconstructed/3a5c7ea6-0001-exec-0001_full.json

# Request 2
agent.run("Create test2.txt")
# req_id: 3a5c7ea6-0002  ✅ NEW!
# exec_id: 3a5c7ea6-0002-exec-0001
# File: logs/reconstructed/3a5c7ea6-0002-exec-0001_full.json  ✅ UNIQUE!
```

## Best Practices

### 1. Always use exec_id for unique identification

```python
# ✅ Good - exec_id is always unique
filename = f"{exec_id}_full.json"

# ❌ Bad - req_id might be reused
filename = f"{req_id}_full.json"
```

### 2. Query by exec_id for specific episode

```python
# ✅ Good - one execution
episode = reconstructor.reconstruct(exec_id)

# ❌ Bad - might get multiple executions
episodes = query_by_req_id(req_id)  # Which execution?
```

### 3. Use req_id for grouping related executions

```python
# ✅ Good - group all retries of same request
all_executions = query_jsonl(req_id=req_id)
# Returns: exec-0001, exec-0002, etc. (all attempts)
```

## Summary

✅ **Fixed**: Agent now auto-generates unique `req_id` per run
✅ **Unique**: `exec_id` used for filenames (no overwrites)
✅ **Hierarchical**: session → request → execution → step
✅ **Queryable**: All logs indexed by these IDs
✅ **Scalable**: Counter-based, handles millions of requests

**No more overwrites in `/logs/reconstructed/`!** 🎉
