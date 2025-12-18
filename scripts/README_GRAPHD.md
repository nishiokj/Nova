# Graphd Query Scripts

Scripts for querying the graphd code intelligence daemon via HTTP API.

## Scripts

### 1. `start_graphd.py` - Start Graphd Daemon

Starts the graphd daemon standalone for testing.

```bash
python scripts/start_graphd.py
```

**Output:**
```
Starting graphd on 127.0.0.1:9444...
  Root: /Users/jevinnishioka/Desktop/jesus
  DB: .graphd/graphd.db
✓ Graphd started successfully!

Graphd is running. Press Ctrl+C to stop.
```

### 2. `query_graphd.py` - CLI Query Tool

Command-line interface for querying graphd.

#### Commands

**Health Check:**
```bash
python scripts/query_graphd.py health
```

**Symbol Lookup** (find symbol at file:line):
```bash
python scripts/query_graphd.py symbol src/harness/agent/planner.py 63
```

**Impact Analysis** (find what imports a file):
```bash
python scripts/query_graphd.py impact src/harness/agent/executor.py --budget 15
```

**Search** (find symbols matching pattern):
```bash
python scripts/query_graphd.py search "create_plan" --max-results 10
```

**Find Callers** (uses Tier B cache):
```bash
python scripts/query_graphd.py callers src/harness/agent/planner.py 63 --budget 10
```

**Get Imports** (Tier A - fast):
```bash
python scripts/query_graphd.py imports src/harness/agent/agent.py
```

**Statistics:**
```bash
python scripts/query_graphd.py stats
```

### 3. `graphd_examples.py` - Example Code

Demonstrates how to use graphd programmatically in Python.

```bash
python scripts/graphd_examples.py
```

Shows examples of:
- Health checking
- Symbol lookup
- Impact analysis
- Programmatic usage patterns

## Graphd API Endpoints

The graphd HTTP server exposes these endpoints:

### `/health` - Health Check
```python
from harness.graphd.client import GraphdClient

client = GraphdClient(host="127.0.0.1", port=9444)
health = client.health()
# Returns: {"status": "ok", "stats": {...}, "cache": {...}}
```

### `/symbol` - Symbol Lookup (Tier A)
```python
# Look up what symbol is at file:line
result = client.symbol("src/harness/agent/planner.py", 63)
# Returns: {"symbol": {"id": "...", "name": "...", "kind": "function", ...}}
```

### `/impact` - Impact Analysis (Tier A + B)
```python
# Find what files import/depend on a file
result = client.impact({
    "entity": {"type": "file", "path": "src/harness/agent/executor.py"},
    "change_type": "unknown",
    "budget": 20
})
# Returns: {"items": [{"kind": "imports", "target": "...", ...}, ...]}
```

### `/search` - Symbol Search (ripgrep)
```python
# Search for symbols using ripgrep
result = client.search({
    "pattern": r"class\s+\w+",
    "path": "src/harness/agent",
    "max_results": 20
})
# Returns: {"items": [{"path": "...", "line": 10, "snippet": "..."}, ...]}
```

### `/context` - Symbol Context (Tier A)
```python
# Get imports/exports around a symbol
result = client.context(symbol_id, depth=1)
# Returns: {"module_edges": {"imports": [...], "imported_by": [...]}}
```

## Common Use Cases

### Find All Files That Import a Module

```python
from harness.graphd.client import GraphdClient

client = GraphdClient(host="127.0.0.1", port=9444)

# Analyze impact of changing executor.py
result = client.impact({
    "entity": {"type": "file", "path": "src/harness/agent/executor.py"},
    "change_type": "sig_change",
    "budget": 50
})

importers = [item for item in result["items"] if item["kind"] == "imports"]
print(f"Found {len(importers)} files that import executor.py:")
for imp in importers:
    print(f"  - {imp['target']}")
```

### Look Up Symbol Definition

```python
from harness.graphd.client import GraphdClient

client = GraphdClient(host="127.0.0.1", port=9444)

# Find what symbol is at line 63 of planner.py
result = client.symbol("src/harness/agent/planner.py", 63)

if "symbol" in result:
    sym = result["symbol"]
    print(f"Symbol: {sym['name']}")
    print(f"Kind: {sym['kind']}")
    print(f"Signature: {sym['sig']}")
    print(f"Lines: {sym['span_start']}-{sym['span_end']}")
```

### Find Who Calls a Function (Tier B Cache)

```python
from harness.graphd.client import GraphdClient

client = GraphdClient(host="127.0.0.1", port=9444)

# Find who calls the function at planner.py:100
symbol_resp = client.symbol("src/harness/agent/planner.py", 100)

if "symbol" in symbol_resp:
    symbol_id = symbol_resp["symbol"]["id"]

    # Get callers using impact analysis (triggers cache)
    impact_resp = client.impact({
        "entity": {
            "type": "symbol",
            "symbol_id": symbol_id,
            "path": "src/harness/agent/planner.py",
            "line": 100
        },
        "change_type": "sig_change",
        "budget": 20
    })

    callers = [item for item in impact_resp["items"] if item["kind"] == "callers"]
    print(f"Found {len(callers)} callers:")
    for caller in callers:
        print(f"  - {caller['target']}")
```

## Graphd Architecture

### Tier A - Persistent Storage (SQLite)
- **Files**: All indexed files
- **Symbols**: Functions, classes, variables extracted via AST parsing
- **Module Edges**: Import/export relationships (exact)
- **Exports**: Public symbols exported by modules

**Characteristics:**
- ✅ Fast: Direct DB queries
- ✅ Exact: Based on AST parsing
- ✅ Persistent: Survives restarts

### Tier B - Derived Edge Cache (In-Memory)
- **Callers**: Who calls this symbol (heuristic via ripgrep)
- **Callees**: What this symbol calls (heuristic via ripgrep)

**Characteristics:**
- ⚡ Very fast: In-memory cache
- 🔍 Heuristic: Based on ripgrep text search
- ⏱️ Ephemeral: TTL-based expiration (default 600s)
- 🔄 On-demand: Built when first requested

## Current Stats

```
Files indexed: 614
Symbols: 2695
Module edges: 182
```

## Configuration

Graphd settings in `config/harness_config.json`:

```json
{
  "graphd": {
    "enabled": true,
    "enable_tools": true,
    "host": "127.0.0.1",
    "port": 9444,
    "derived_ttl_s": 600,
    "derived_max_entries": 1000
  }
}
```

## Notes

- Graphd must be running for these scripts to work
- Start with `python scripts/start_graphd.py` or start the full harness
- The server indexes the entire project on startup
- Cache is populated on-demand as queries are made
- Search requires ripgrep (`rg`) to be installed
