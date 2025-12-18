#!/usr/bin/env python3
"""
Script to query graphd via HTTP API.

Usage:
    python scripts/query_graphd.py health
    python scripts/query_graphd.py symbol src/harness/agent/planner.py 63
    python scripts/query_graphd.py impact src/harness/agent/planner.py
    python scripts/query_graphd.py search "create_plan"
    python scripts/query_graphd.py context SYMBOL_ID
    python scripts/query_graphd.py imports src/harness/agent/agent.py
    python scripts/query_graphd.py callers src/harness/agent/planner.py 63
    python scripts/query_graphd.py stats
"""

import sys
import json
import argparse
from typing import Optional

# Add src to path
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from harness.graphd.client import GraphdClient


def print_json(data, indent=2):
    """Pretty print JSON data."""
    print(json.dumps(data, indent=indent))


def cmd_health(client: GraphdClient):
    """Check graphd health status."""
    print("=== Graphd Health Check ===")
    health = client.health()
    print_json(health)

    if health.get("status") == "ok":
        print("\n✓ Graphd is running and healthy")
        stats = health.get("stats", {})
        print(f"  Files indexed: {stats.get('files', 0)}")
        print(f"  Symbols: {stats.get('symbols', 0)}")
        print(f"  Module edges: {stats.get('module_edges', 0)}")

        cache = health.get("cache", {})
        print(f"\n  Cache stats:")
        print(f"    Cached sets: {cache.get('cached_sets', 0)}")
        print(f"    Cached edges: {cache.get('cached_edges', 0)}")
        print(f"    TTL: {cache.get('ttl_s', 0)}s")
    else:
        print("\n✗ Graphd is not healthy")
        if "error" in health:
            print(f"  Error: {health['error']}")


def cmd_symbol(client: GraphdClient, path: str, line: int):
    """Look up symbol at file:line."""
    print(f"=== Symbol Lookup: {path}:{line} ===")
    result = client.symbol(path, line)
    print_json(result)

    if "symbol" in result:
        sym = result["symbol"]
        print(f"\n✓ Found symbol: {sym.get('name')}")
        print(f"  Kind: {sym.get('kind')}")
        print(f"  Qualname: {sym.get('qualname')}")
        print(f"  Signature: {sym.get('sig')}")
        print(f"  Span: lines {sym.get('span_start')}-{sym.get('span_end')}")
        print(f"  ID: {sym.get('id')}")
    elif "error" in result:
        print(f"\n✗ Error: {result['error']}")


def cmd_impact(client: GraphdClient, path: str, change_type: str = "unknown", budget: int = 20):
    """Analyze impact of changes to a file."""
    print(f"=== Impact Analysis: {path} ({change_type}) ===")
    result = client.impact({
        "entity": {"type": "file", "path": path},
        "change_type": change_type,
        "budget": budget
    })
    print_json(result)

    items = result.get("items", [])
    if items:
        print(f"\n✓ Found {len(items)} impact items:")
        for item in items[:10]:  # Show first 10
            print(f"  - {item.get('kind')}: {item.get('target')}")
            if item.get("context"):
                print(f"    Context: {item['context'][:80]}...")
        if len(items) > 10:
            print(f"  ... and {len(items) - 10} more")
    else:
        print("\n✓ No impact items found")


def cmd_search(client: GraphdClient, pattern: str, path: Optional[str] = None, max_results: int = 20):
    """Search for symbols matching a pattern."""
    print(f"=== Search: '{pattern}' ===")
    payload = {
        "pattern": pattern,
        "max_results": max_results
    }
    if path:
        payload["path"] = path

    result = client.search(payload)
    print_json(result)

    items = result.get("items", [])
    if items:
        print(f"\n✓ Found {len(items)} matches:")
        for item in items:
            print(f"  - {item.get('path')}:{item.get('line')}")
            if item.get("snippet"):
                print(f"    {item['snippet'].strip()}")
    else:
        print("\n✓ No matches found")


def cmd_context(client: GraphdClient, symbol_id: str, depth: int = 1):
    """Get context around a symbol."""
    print(f"=== Context: {symbol_id} (depth={depth}) ===")
    result = client.context(symbol_id, depth)
    print_json(result)

    if "module_edges" in result:
        edges = result["module_edges"]
        imports = edges.get("imports", [])
        imported_by = edges.get("imported_by", [])

        print(f"\n✓ Module relationships:")
        if imports:
            print(f"  Imports ({len(imports)}):")
            for imp in imports[:5]:
                print(f"    → {imp.get('dst_path')}")
            if len(imports) > 5:
                print(f"    ... and {len(imports) - 5} more")

        if imported_by:
            print(f"  Imported by ({len(imported_by)}):")
            for imp in imported_by[:5]:
                print(f"    ← {imp.get('src_path')}")
            if len(imported_by) > 5:
                print(f"    ... and {len(imported_by) - 5} more")


def cmd_imports(client: GraphdClient, path: str):
    """Get modules imported by a file."""
    print(f"=== Imports: {path} ===")

    # First get symbol for the file
    symbol_resp = client.symbol(path, 1)
    if "symbol" not in symbol_resp:
        print(f"✗ File not indexed: {path}")
        return

    symbol_id = symbol_resp["symbol"]["id"]

    # Get context which includes module edges
    result = client.context(symbol_id, depth=1)
    print_json(result)

    imports = result.get("module_edges", {}).get("imports", [])
    if imports:
        print(f"\n✓ {path} imports {len(imports)} modules:")
        for imp in imports:
            print(f"  → {imp.get('dst_path')}")
            if imp.get("names"):
                print(f"    Imports: {', '.join(imp['names'][:5])}")
    else:
        print(f"\n✓ No imports found for {path}")


def cmd_callers(client: GraphdClient, path: str, line: int, budget: int = 10):
    """Find who calls a specific symbol (uses Tier B cache)."""
    print(f"=== Find Callers: {path}:{line} ===")

    # First lookup the symbol
    symbol_resp = client.symbol(path, line)
    if "symbol" not in symbol_resp:
        print(f"✗ Symbol not found at {path}:{line}")
        return

    symbol = symbol_resp["symbol"]
    print(f"Symbol: {symbol.get('name')} ({symbol.get('kind')})\n")

    # Get impact analysis (triggers cache lookup/build)
    impact_resp = client.impact({
        "entity": {
            "type": "symbol",
            "symbol_id": symbol["id"],
            "path": path,
            "line": line
        },
        "change_type": "sig_change",
        "budget": budget
    })

    print_json(impact_resp)

    # Extract caller paths
    items = impact_resp.get("items", [])
    callers = [item for item in items if item.get("kind") == "callers"]

    if callers:
        print(f"\n✓ Found {len(callers)} callers:")
        for caller in callers:
            print(f"  ← {caller.get('target')}")
            if caller.get("context"):
                print(f"    {caller['context'][:80].strip()}...")
    else:
        print("\n✓ No callers found (may not be in cache yet)")


def cmd_stats(client: GraphdClient):
    """Show graphd statistics."""
    print("=== Graphd Statistics ===")
    health = client.health()

    print(f"Status: {health.get('status')}")
    print(f"Version: {health.get('version')}")
    print(f"Schema: {health.get('schema_version')}")
    print(f"Root: {health.get('root')}")
    print(f"DB: {health.get('db_path')}")
    print(f"Active: {health.get('active')}")
    print(f"Paused: {health.get('paused')}")

    stats = health.get("stats", {})
    print(f"\nIndexed content:")
    print(f"  Files: {stats.get('files', 0)}")
    print(f"  Symbols: {stats.get('symbols', 0)}")
    print(f"  Module edges: {stats.get('module_edges', 0)}")
    print(f"  Exports: {stats.get('exports', 0)}")

    cache = health.get("cache", {})
    print(f"\nTier B Cache (Derived Edges):")
    print(f"  Cached sets: {cache.get('cached_sets', 0)}")
    print(f"  Cached edges: {cache.get('cached_edges', 0)}")
    print(f"  Max entries: {cache.get('max_entries', 0)}")
    print(f"  TTL: {cache.get('ttl_s', 0)}s")

    last_index = health.get("last_index", {})
    if last_index:
        print(f"\nLast index cycle:")
        print(f"  Updated files: {last_index.get('updated_files', 0)}")
        print(f"  Removed files: {last_index.get('removed_files', 0)}")
        print(f"  Errors: {last_index.get('errors', 0)}")


def main():
    parser = argparse.ArgumentParser(
        description="Query graphd HTTP API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument("--host", default="127.0.0.1", help="Graphd host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=9444, help="Graphd port (default: 9444)")
    parser.add_argument("--timeout", type=int, default=5, help="Request timeout in seconds (default: 5)")

    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # Health check
    subparsers.add_parser("health", help="Check graphd health")

    # Symbol lookup
    symbol_parser = subparsers.add_parser("symbol", help="Look up symbol at file:line")
    symbol_parser.add_argument("path", help="File path")
    symbol_parser.add_argument("line", type=int, help="Line number")

    # Impact analysis
    impact_parser = subparsers.add_parser("impact", help="Analyze impact of changes")
    impact_parser.add_argument("path", help="File path")
    impact_parser.add_argument("--change-type", default="unknown",
                              choices=["sig_change", "rename", "move", "unknown"],
                              help="Type of change")
    impact_parser.add_argument("--budget", type=int, default=20, help="Max results")

    # Search
    search_parser = subparsers.add_parser("search", help="Search for symbols")
    search_parser.add_argument("pattern", help="Search pattern (regex)")
    search_parser.add_argument("--path", help="Restrict search to path")
    search_parser.add_argument("--max-results", type=int, default=20, help="Max results")

    # Context
    context_parser = subparsers.add_parser("context", help="Get symbol context")
    context_parser.add_argument("symbol_id", help="Symbol ID")
    context_parser.add_argument("--depth", type=int, default=1, help="Context depth")

    # Imports
    imports_parser = subparsers.add_parser("imports", help="Get file imports")
    imports_parser.add_argument("path", help="File path")

    # Callers
    callers_parser = subparsers.add_parser("callers", help="Find who calls a symbol")
    callers_parser.add_argument("path", help="File path")
    callers_parser.add_argument("line", type=int, help="Line number")
    callers_parser.add_argument("--budget", type=int, default=10, help="Max results")

    # Stats
    subparsers.add_parser("stats", help="Show graphd statistics")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    # Create client
    client = GraphdClient(host=args.host, port=args.port, timeout_s=args.timeout)

    # Route to command
    try:
        if args.command == "health":
            cmd_health(client)
        elif args.command == "symbol":
            cmd_symbol(client, args.path, args.line)
        elif args.command == "impact":
            cmd_impact(client, args.path, args.change_type, args.budget)
        elif args.command == "search":
            cmd_search(client, args.pattern, getattr(args, "path", None), args.max_results)
        elif args.command == "context":
            cmd_context(client, args.symbol_id, args.depth)
        elif args.command == "imports":
            cmd_imports(client, args.path)
        elif args.command == "callers":
            cmd_callers(client, args.path, args.line, args.budget)
        elif args.command == "stats":
            cmd_stats(client)
        else:
            print(f"Unknown command: {args.command}")
            return 1

        return 0

    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
