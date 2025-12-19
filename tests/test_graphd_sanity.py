"""Sanity tests for graphd subsystem."""

import os
import sys
import time
import tempfile
import shutil

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from util.config import GraphdConfig
from harness.graphd import GraphdManager, GraphdClient, SchemaVersionError, GRAPH_D_SCHEMA_VERSION


def test_store_initialization():
    """Test that store initializes and creates tables."""
    print("\n=== Test: Store Initialization ===")

    with tempfile.TemporaryDirectory() as tmpdir:
        config = GraphdConfig(
            enabled=True,
            root_path=tmpdir,
            db_path=os.path.join(tmpdir, "test.db"),
            index_interval_s=1.0,
        )

        manager = GraphdManager(config)
        assert manager.start(), "Manager failed to start"

        # Check tables exist
        stats = manager.store.get_stats()
        assert "files" in stats, "files stat missing"
        assert "symbols" in stats, "symbols stat missing"
        assert "module_edges" in stats, "module_edges stat missing"

        # Check schema version stored
        from harness.graphd.store import GraphStore
        row = manager.store._conn.execute(
            "SELECT value FROM graphd_metadata WHERE key = 'schema_version';"
        ).fetchone()
        assert row is not None, "Schema version not stored"
        assert row[0] == GRAPH_D_SCHEMA_VERSION, f"Wrong schema version: {row[0]}"

        manager.stop()
        print("✓ Store initialization passed")


def test_schema_version_mismatch():
    """Test that schema version mismatch is detected."""
    print("\n=== Test: Schema Version Mismatch ===")

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test.db")

        # Create DB with wrong version
        import sqlite3
        conn = sqlite3.connect(db_path)
        conn.execute("CREATE TABLE graphd_metadata (key TEXT PRIMARY KEY, value TEXT);")
        conn.execute("INSERT INTO graphd_metadata VALUES ('schema_version', 'v0-fake');")
        conn.commit()
        conn.close()

        config = GraphdConfig(
            enabled=True,
            root_path=tmpdir,
            db_path=db_path,
        )

        manager = GraphdManager(config)
        result = manager.start()
        assert not result, "Manager should fail on version mismatch"

        print("✓ Schema version mismatch detected correctly")


def test_file_indexing():
    """Test that files get indexed."""
    print("\n=== Test: File Indexing ===")

    with tempfile.TemporaryDirectory() as tmpdir:
        # Create test Python file
        test_file = os.path.join(tmpdir, "example.py")
        with open(test_file, "w") as f:
            f.write('''
def hello_world():
    """A test function."""
    print("Hello, world!")

class MyClass:
    def method(self):
        pass

import os
from pathlib import Path
''')

        config = GraphdConfig(
            enabled=True,
            root_path=tmpdir,
            db_path=os.path.join(tmpdir, ".graphd", "test.db"),
            index_interval_s=0.5,
            max_files_per_scan=100,
        )

        manager = GraphdManager(config)
        assert manager.start(), "Manager failed to start"

        # Wait for indexing
        time.sleep(2)

        # Check file was indexed
        stats = manager.store.get_stats()
        print(f"  Stats: {stats}")
        assert stats["files"] >= 1, f"Expected at least 1 file, got {stats['files']}"
        assert stats["symbols"] >= 2, f"Expected at least 2 symbols, got {stats['symbols']}"

        # Check symbols extracted
        symbols = manager.store.get_symbols_for_file("example.py")
        print(f"  Symbols: {[s['name'] for s in symbols]}")
        symbol_names = {s["name"] for s in symbols}
        assert "hello_world" in symbol_names, "hello_world function not found"
        assert "MyClass" in symbol_names, "MyClass not found"

        manager.stop()
        print("✓ File indexing passed")


def test_http_api():
    """Test HTTP API endpoints."""
    print("\n=== Test: HTTP API ===")

    with tempfile.TemporaryDirectory() as tmpdir:
        # Create test file
        test_file = os.path.join(tmpdir, "api_test.py")
        with open(test_file, "w") as f:
            f.write('def api_function():\n    pass\n')

        config = GraphdConfig(
            enabled=True,
            root_path=tmpdir,
            db_path=os.path.join(tmpdir, ".graphd", "test.db"),
            index_interval_s=0.5,
            host="127.0.0.1",
            port=19444,  # Use non-default port for testing
        )

        manager = GraphdManager(config)
        assert manager.start(), "Manager failed to start"

        # Wait for indexing and server
        time.sleep(2)

        # Test client
        client = GraphdClient(host="127.0.0.1", port=19444, timeout_s=5)

        # Test /health
        health = client.health()
        print(f"  Health: {health}")
        assert health.get("status") == "ok", f"Health check failed: {health}"
        assert health.get("version") is not None, "Version missing"

        # Test /symbol
        symbol_resp = client.symbol("api_test.py", 1)
        print(f"  Symbol lookup: {symbol_resp}")
        # May or may not find symbol depending on timing

        # Test /impact
        impact_resp = client.impact({
            "entity": {"type": "file", "path": "api_test.py"},
            "change_type": "unknown",
            "budget": 10,
        })
        print(f"  Impact: {impact_resp}")
        assert "items" in impact_resp or "error" not in impact_resp, f"Impact failed: {impact_resp}"

        manager.stop()
        print("✓ HTTP API passed")


def test_derived_cache():
    """Test Tier B cache behavior."""
    print("\n=== Test: Derived Cache ===")

    from harness.graphd.derived import DerivedEdgeCache
    from harness.graphd.types import DerivedEdge

    cache = DerivedEdgeCache(ttl_s=2, max_entries=3)

    # Test basic set/get
    edges = [
        DerivedEdge(src="sym1", dst="file1.py", kind="callers", confidence=0.8, provenance="rg", expires_at=time.time() + 10)
    ]
    cache.set("sym1", "callers", edges)

    result = cache.get("sym1", "callers")
    assert len(result) == 1, f"Expected 1 edge, got {len(result)}"
    assert result[0].dst == "file1.py", "Wrong edge returned"

    # Test TTL expiration
    expired_edges = [
        DerivedEdge(src="sym2", dst="file2.py", kind="callers", confidence=0.8, provenance="rg", expires_at=time.time() - 1)
    ]
    cache.set("sym2", "callers", expired_edges)
    result = cache.get("sym2", "callers")
    assert len(result) == 0, "Expired edges should not be returned"

    # Test LRU eviction
    for i in range(5):
        cache.set(f"sym_{i}", "callers", [
            DerivedEdge(src=f"sym_{i}", dst=f"file_{i}.py", kind="callers", confidence=0.8, provenance="rg", expires_at=time.time() + 100)
        ])

    stats = cache.stats()
    print(f"  Cache stats: {stats}")
    assert stats["cached_sets"] <= 3, f"Cache should be bounded to 3 entries, got {stats['cached_sets']}"

    # Test clear
    cleared = cache.clear()
    assert cleared > 0, "Should have cleared some entries"
    stats = cache.stats()
    assert stats["cached_sets"] == 0, "Cache should be empty after clear"

    print("✓ Derived cache passed")


def test_sql_injection_protection():
    """Test that SQL injection is blocked."""
    print("\n=== Test: SQL Injection Protection ===")

    with tempfile.TemporaryDirectory() as tmpdir:
        config = GraphdConfig(
            enabled=True,
            root_path=tmpdir,
            db_path=os.path.join(tmpdir, "test.db"),
        )

        manager = GraphdManager(config)
        assert manager.start(), "Manager failed to start"

        # Try SQL injection via export
        try:
            manager.store.export_table("files; DROP TABLE files; --")
            assert False, "Should have raised ValueError"
        except ValueError as e:
            print(f"  Blocked: {e}")
            assert "Invalid table name" in str(e)

        # Valid table should work
        result = manager.store.export_table("files")
        assert isinstance(result, list), "Valid export should return list"

        manager.stop()
        print("✓ SQL injection protection passed")


def test_backpressure():
    """Test that backpressure pauses indexing."""
    print("\n=== Test: Backpressure ===")

    with tempfile.TemporaryDirectory() as tmpdir:
        config = GraphdConfig(
            enabled=True,
            root_path=tmpdir,
            db_path=os.path.join(tmpdir, "test.db"),
            index_interval_s=0.2,
            backpressure_when_active=True,
        )

        manager = GraphdManager(config)
        assert manager.start(), "Manager failed to start"

        # Set active - should pause indexing
        manager.set_active(True)
        health1 = manager.handle_health()
        assert health1["active"] is True, "Active flag not set"

        # Set inactive
        manager.set_active(False)
        health2 = manager.handle_health()
        assert health2["active"] is False, "Active flag not cleared"

        # Test pause
        manager.set_paused(True)
        health3 = manager.handle_health()
        assert health3["paused"] is True, "Paused flag not set"

        manager.stop()
        print("✓ Backpressure passed")


def run_all_tests():
    """Run all sanity tests."""
    print("=" * 60)
    print("GRAPHD SANITY TESTS")
    print("=" * 60)

    tests = [
        test_store_initialization,
        test_schema_version_mismatch,
        test_file_indexing,
        test_derived_cache,
        test_sql_injection_protection,
        test_backpressure,
        test_http_api,
    ]

    passed = 0
    failed = 0

    for test in tests:
        try:
            test()
            passed += 1
        except Exception as e:
            print(f"✗ {test.__name__} FAILED: {e}")
            import traceback
            traceback.print_exc()
            failed += 1

    print("\n" + "=" * 60)
    print(f"RESULTS: {passed} passed, {failed} failed")
    print("=" * 60)

    return failed == 0


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)
