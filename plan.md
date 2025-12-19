# Graphd Implementation Analysis

## Executive Summary

The graphd implementation is well-structured and follows the design document closely. However, there are **several critical bugs** and a few architectural concerns that should be addressed before enabling it in production.

---

## 1. Critical Bugs

### BUG 1: Dead Code in Indexer - Files Never Indexed (CRITICAL)

**Location:** `src/harness/graphd/indexer.py:128-168`

The indexer's `scan_once()` has a logic error where most of the indexing code is unreachable:

```python
try:
    stat = os.stat(abs_path)
except OSError:
    continue

    mtime = stat.st_mtime  # DEAD CODE - after continue
    existing = self._state.get(rel_path)
    # ... all indexing logic is dead
```

The `continue` after `except OSError` means **everything after line 134 is unreachable**. Files are collected but never actually indexed. This is a catastrophic bug - the entire Tier A store will remain empty.

**Fix:** The `continue` should only be in the except block. The code from `mtime = stat.st_mtime` onward should be at the same indentation level as the try/except.

### BUG 2: SQL Injection in `export_table()` (SECURITY)

**Location:** `src/harness/graphd/store.py:264`

```python
def export_table(self, table: str) -> List[Dict[str, Any]]:
    with self._lock:
        rows = self._conn.execute(f"SELECT * FROM {table};").fetchall()
```

Direct string interpolation of the `table` parameter allows SQL injection. While the manager validates table names against a whitelist in `handle_export()`, this method is public and could be called directly.

**Fix:** Validate table name against allowed set within `export_table()` itself.

### BUG 3: Resource Limits Applied in Wrong Thread

**Location:** `src/harness/graphd/manager.py:233-246`

`_apply_resource_limits()` is called in the main thread during `start()`, but the index loop and HTTP server run in daemon threads. `os.nice()` and `resource.setrlimit()` only affect the **calling thread/process**, not child threads.

**Fix:** Move resource limit application to the beginning of `_index_loop()` and the server thread, or use per-thread resource limiting if needed.

### BUG 4: Missing Thread Safety in Server Handler

**Location:** `src/harness/graphd/server.py:30-31`

```python
class GraphdRequestHandler(BaseHTTPRequestHandler):
    manager = None  # Class attribute shared across all handler instances
```

The class attribute `manager` is set via `Handler.manager = manager` in `_handler_factory()`. While this works, `ThreadingHTTPServer` creates a new handler instance per request. The handler class attribute approach is fine, but the factory pattern creates a new class each time `_handler_factory()` is called (though it's only called once in `start()`).

**Concern:** Not a bug per se, but the pattern is fragile. If `_handler_factory()` were called multiple times, each would create a different Handler class.

### BUG 5: TTL Check Race Condition

**Location:** `src/harness/graphd/derived.py:28-37`

The cache's `get()` method reads and potentially deletes entries inside the lock, but `set()` overwrites without checking if the entry was just expired. This is minor but could cause stale data to persist:

```python
def get(self, src: str, kind: str) -> List[DerivedEdge]:
    now = time.time()
    with self._lock:
        items = self._edges.get((src, kind), [])
        fresh = [e for e in items if e.expires_at > now]
        if fresh:
            self._edges[(src, kind)] = fresh  # Modifies in place
        else:
            self._edges.pop((src, kind), None)
        return fresh
```

Not critical, but the mutation during read is unusual.

---

## 2. Separation of Concerns

### Well Separated

- **store.py**: Pure SQLite persistence, no business logic
- **types.py**: Data structures only, no behavior
- **derived.py**: Tier B cache and search, isolated from Tier A
- **client.py**: HTTP client, no knowledge of server internals
- **languages.py**: Plugin architecture for language-specific parsing
- **utils.py/constants.py**: Shared utilities, no cross-dependencies

### Concerns

- **manager.py**: Acts as both orchestrator AND request handler logic. The `handle_*` methods should potentially move to a separate `handlers.py` for cleaner separation.
- **indexer.py** couples file walking with symbol extraction. Could benefit from separating the file discovery from the processing.

### Architecture Alignment

The implementation follows the design document's two-tier architecture:
- Tier A (SQLite): files, symbols, module_edges, exports, run_artifacts
- Tier B (in-memory): DerivedEdgeCache with TTL

Good: The separation allows Tier A to remain stable while Tier B can be rebuilt on demand.

---

## 3. Resource Usage

### CPU

- Index loop runs every `index_interval_s` (default 5s)
- Processes up to `max_files_per_scan` (default 500) per cycle
- `nice_level` can deprioritize (but bug above means it doesn't work)
- ripgrep search has 10s timeout

### Memory

- `max_memory_mb` via `RLIMIT_AS` (but bug means it's not applied to daemon threads)
- Derived cache grows unbounded (no max size) - only TTL eviction
- SQLite uses WAL mode (good for concurrent reads)
- All symbol definitions for all files loaded into symbols table

### Disk

- SQLite database at `.graphd/graphd.db`
- WAL mode means `.graphd/graphd.db-wal` and `.graphd/graphd.db-shm` files
- No size limit on database

### Network

- HTTP server binds to `127.0.0.1:9444` (localhost only - good)
- Client timeout is 2s default

### Design Doc Compliance

The design specifies:
- nice/ionice ✓ (but not applied correctly)
- CPU quota ✗ (not implemented)
- max RAM ✓ (but not applied correctly)
- debounce ✓
- idle-only refinement ✓
- never spawn LSP unless opted in ✓ (no LSP support at all yet)

---

## 4. Hot Path Analysis

### Agent Execution Hot Path

```
AgentHarness.process()
    -> graphd.set_active(True)      # Signal to graphd
    -> agent.run()
        -> tool_registry.execute()  # Tools MAY call graphd
    -> graphd.set_active(False)
```

**Graphd on the hot path:**

1. **set_active()** - O(1), just sets a flag
2. **Graphd tools** (if enabled) - HTTP calls with 2s timeout

**Graphd off the hot path:**

1. **Index loop** - Runs in background thread, skips when agent is active (backpressure)
2. **HTTP server** - Runs in background thread
3. **Idle refinement** - Only runs when agent is NOT active

**Impact Assessment:**

- When `backpressure_when_active=True` (default), graphd does nothing during agent execution except respond to queries
- If graphd tools are enabled and called, adds 1-10ms per call plus HTTP overhead
- The daemon doesn't block the hot path - it yields via `set_active()`

---

## 5. Integration Points

### Runtime Startup (`runtime.py:148-165`)

```python
if resolved_config.graphd and resolved_config.graphd.enabled:
    graphd_manager = GraphdManager(resolved_config.graphd, logger)
    if graphd_manager.start():
        graphd_client = GraphdClient(...)
```

Good: Fails gracefully if graphd startup fails.

### Harness Backpressure (`harness.py:202-214`)

```python
try:
    if self.graphd:
        self.graphd.set_active(True)
    # ... agent execution ...
finally:
    if self.graphd:
        self.graphd.set_active(False)
```

Good: Uses try/finally to ensure active flag is always cleared.

### Tool Registry (`tool_registry.py:1191-1278`)

Registers 6 graphd tools when client is available and `enable_tools=True`:
- `graphd_health`
- `graphd_symbol`
- `graphd_context`
- `graphd_impact`
- `graphd_search`
- `graphd_export`

Good: Tools are gated behind both `graphd_client` existence AND `graphd_tools_enabled` flag.

### Missing Integration

1. **No artifact recording integration** - The agent doesn't call `record_artifact()` after test failures or typecheck errors
2. **No microloop integration** - The design mentions microloop invariant checkers calling `/impact`, but no microloop code uses graphd yet

---

## 6. Maintenance Considerations

### Schema Versioning

`GRAPH_D_SCHEMA_VERSION = "v1"` exists but is:
- Not stored in the database
- Not checked on startup
- No migration path

**Risk:** Schema changes will require manual database deletion.

### Database Lifecycle

- Database created at first startup
- No automatic cleanup of stale data
- No compaction/vacuum scheduled
- `remove_file()` cleans up individual files, but orphaned edges could accumulate

### Symbol ID Stability

Symbol IDs are hashes of `path:kind:name:span_start:span_end`. This means:
- Adding a line above a function changes its ID
- Renaming changes the ID
- Moving to another file changes the ID

This is intentional (design says "stable ids for symbols") but means:
- Cached derived edges become orphaned when functions move
- Client code holding symbol IDs must refresh after edits

---

## 7. Writing/Updating

### Read-Only Guarantee

Design specifies graphd is "read-only with respect to the repo". Implementation:
- No file writes (only `.graphd/` directory)
- No environment mutation
- ripgrep runs with `capture_output=True` (no stdout pollution)

### Database Writes

Writes happen:
1. `upsert_file()` - on file mtime change
2. `replace_symbols()` - on file content change
3. `replace_module_edges()` - on file content change
4. `replace_exports()` - on file content change
5. `upsert_bundle()` - atomic version of above
6. `remove_file()` - when file deleted
7. `record_run_artifact()` - when test/lint results recorded

All writes are:
- Inside `with self._lock:` (thread-safe)
- Using `self._conn.commit()` (durable)
- WAL mode (concurrent read-safe)

---

## 8. Configuration & Logging

### Configuration

`GraphdConfig` dataclass with sensible defaults:
- `enabled: bool = False` - Off by default
- `enable_tools: bool = False` - Tools off by default
- All timeouts configurable
- Backpressure enabled by default

### Logging

Uses project's `StructuredLogger`:
- `system_init("graphd", "ready", ...)` on startup
- `error(...)` on failures
- No debug logging for index cycles (could be noisy)

**Missing:**
- No metrics emission
- No health check logging
- No periodic stats logging

---

## 9. Recommendations

### Must Fix (Critical)

1. **Fix the indexer dead code bug** - Files are not being indexed at all
2. **Fix resource limits thread issue** - Move to daemon threads
3. **Add table name validation in `export_table()`**

### Should Fix (Important)

4. Store schema version in database and check on startup
5. Add cache size limit to DerivedEdgeCache
6. Add periodic stats logging for observability
7. Add `vacuum` command or scheduled compaction

### Nice to Have

8. Move `handle_*` methods to separate handlers module
9. Add LSP integration hook (as per design)
10. Integrate artifact recording with test runner
11. Add graceful shutdown (wait for in-flight requests)

---

## 10. Verdict

**The implementation is architecturally sound but has a critical bug that prevents it from functioning.** The indexer's dead code means Tier A will never be populated, making the entire system useless until fixed.

Once the critical bugs are fixed:
- Safe to enable with `backpressure_when_active=True`
- Tools should remain disabled until proven stable
- Monitor database size growth
- Consider enabling only for large codebases where impact analysis provides value
