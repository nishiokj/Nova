#!/usr/bin/env python3
"""
Simple examples of querying graphd programmatically.

Run this script to see various graphd queries in action.
"""

import sys
import os
import json

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from harness.graphd.client import GraphdClient


def example_health_check():
    """Example: Check if graphd is healthy."""
    print("\n" + "="*60)
    print("EXAMPLE 1: Health Check")
    print("="*60)

    client = GraphdClient(host="127.0.0.1", port=9444, timeout_s=5)
    health = client.health()

    print(f"Status: {health.get('status')}")
    if health.get('status') == 'ok':
        stats = health.get('stats', {})
        print(f"Files indexed: {stats.get('files')}")
        print(f"Symbols: {stats.get('symbols')}")
        print(f"Module edges: {stats.get('module_edges')}")
    else:
        print(f"Error: {health.get('error')}")


def example_symbol_lookup():
    """Example: Look up a symbol at a specific file:line."""
    print("\n" + "="*60)
    print("EXAMPLE 2: Symbol Lookup")
    print("="*60)

    client = GraphdClient(host="127.0.0.1", port=9444, timeout_s=5)

    # Look up what symbol is at planner.py line 63
    path = "src/harness/agent/planner.py"
    line = 63

    result = client.symbol(path, line)

    if "symbol" in result:
        sym = result["symbol"]
        print(f"Found symbol at {path}:{line}")
        print(f"  Name: {sym.get('name')}")
        print(f"  Kind: {sym.get('kind')}")
        print(f"  Signature: {sym.get('sig')}")
        print(f"  Symbol ID: {sym.get('id')}")
    else:
        print(f"No symbol found: {result.get('error')}")


def example_impact_analysis():
    """Example: Find what files import/depend on a file."""
    print("\n" + "="*60)
    print("EXAMPLE 3: Impact Analysis")
    print("="*60)

    client = GraphdClient(host="127.0.0.1", port=9444, timeout_s=5)

    # Find what imports executor.py
    path = "src/harness/agent/executor.py"

    result = client.impact({
        "entity": {"type": "file", "path": path},
        "change_type": "unknown",
        "budget": 10
    })

    items = result.get("items", [])
    print(f"Impact analysis for {path}:")
    print(f"Found {len(items)} files that import it:")

    for item in items:
        print(f"  - {item.get('target')} ({item.get('kind')})")


def example_find_all_classes():
    """Example: Find all class definitions in a directory."""
    print("\n" + "="*60)
    print("EXAMPLE 4: Find All Classes in Agent Directory")
    print("="*60)

    client = GraphdClient(host="127.0.0.1", port=9444, timeout_s=5)

    # This would use search endpoint if ripgrep is working
    # For now, we can query the database directly or use other endpoints

    # Example of what the call would look like:
    result = client.search({
        "pattern": r"^class\s+\w+",
        "path": "src/harness/agent",
        "max_results": 20
    })

    items = result.get("items", [])
    if items:
        print(f"Found {len(items)} class definitions:")
        for item in items:
            print(f"  - {item.get('path')}:{item.get('line')}")
    else:
        print("Search returned no results (ripgrep may need configuration)")


def example_context_query():
    """Example: Get context around a symbol (imports/exports)."""
    print("\n" + "="*60)
    print("EXAMPLE 5: Symbol Context")
    print("="*60)

    client = GraphdClient(host="127.0.0.1", port=9444, timeout_s=5)

    # First find a symbol - try a few lines to find one
    symbol_resp = None
    for line in [10, 20, 30, 40, 50, 70, 80]:
        try:
            symbol_resp = client.symbol("src/harness/agent/executor.py", line)
            if symbol_resp and isinstance(symbol_resp, dict) and "symbol" in symbol_resp:
                break
        except:
            continue

    if symbol_resp and isinstance(symbol_resp, dict) and "symbol" in symbol_resp:
        symbol_id = symbol_resp.get("symbol", {}).get("id")
        print(f"Getting context for symbol: {symbol_resp['symbol'].get('name')}")

        # Get context with depth=1
        context = client.context(symbol_id, depth=1)

        module_edges = context.get("module_edges", {})
        imports = module_edges.get("imports", [])
        imported_by = module_edges.get("imported_by", [])

        print(f"\nThis file imports {len(imports)} modules:")
        for imp in imports[:5]:
            print(f"  → {imp.get('dst_path')}")

        print(f"\nThis file is imported by {len(imported_by)} modules:")
        for imp in imported_by[:5]:
            print(f"  ← {imp.get('src_path')}")
    else:
        print("Could not find symbol in executor.py")


def example_programmatic_usage():
    """Example: How to use graphd in your own code."""
    print("\n" + "="*60)
    print("EXAMPLE 6: Programmatic Usage Pattern")
    print("="*60)

    # Create client
    client = GraphdClient(host="127.0.0.1", port=9444, timeout_s=5)

    # Example workflow: Find all files that depend on a change
    changed_file = "src/harness/agent/microloop.py"

    print(f"\nWorkflow: Analyzing dependencies for {changed_file}")
    print("-" * 60)

    # Step 1: Get impact analysis for the file
    impact_resp = client.impact({
        "entity": {"type": "file", "path": changed_file},
        "change_type": "sig_change",
        "budget": 20
    })

    # Step 2: Process results
    items = impact_resp.get("items", [])
    importers = [item for item in items if item.get("kind") == "imports"]

    print(f"\nFound {len(importers)} files that import {changed_file}:")
    for imp in importers:
        print(f"  ✓ {imp.get('target')}")

    print(f"\nThese files might need testing/review if you changed {changed_file}")


def main():
    """Run all examples."""
    print("\n" + "🔍 " * 20)
    print("GRAPHD API QUERY EXAMPLES")
    print("🔍 " * 20)

    try:
        example_health_check()
        example_symbol_lookup()
        example_impact_analysis()
        example_find_all_classes()
        # example_context_query()  # Skip - needs debugging
        example_programmatic_usage()

        print("\n" + "="*60)
        print("✅ All examples completed!")
        print("="*60)
        print("\nTo use in your own code:")
        print("  from harness.graphd.client import GraphdClient")
        print("  client = GraphdClient(host='127.0.0.1', port=9444)")
        print("  result = client.health()")
        print("\n")

    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
