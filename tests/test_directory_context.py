#!/usr/bin/env python3
"""
Test script to verify that the agent properly understands its working directory
and can perform file operations relative to where it was started.
"""

import os
import sys
import tempfile
import shutil

# Add harness to path
sys.path.insert(0, os.path.dirname(__file__))

from harness.agent.tool_registry import ToolRegistry
from util.config import ToolConfig

def test_working_directory_context():
    """Test that tool registry maintains proper working directory context"""

    # Create a temporary directory structure
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create test directory structure
        test_dir = os.path.join(tmpdir, "test_workspace")
        os.makedirs(test_dir)

        # Create some test files
        with open(os.path.join(test_dir, "file1.txt"), "w") as f:
            f.write("Hello from file1")

        subdir = os.path.join(test_dir, "subdir")
        os.makedirs(subdir)
        with open(os.path.join(subdir, "file2.txt"), "w") as f:
            f.write("Hello from file2")

        # Initialize tool registry with test directory as working directory
        print(f"Creating ToolRegistry with working_dir: {test_dir}")

        # Create config with all tools enabled
        config = ToolConfig()
        config.enabled_tools = [
            "fast_answer", "web_fetch", "bash_execute",
            "python_execute", "file_read", "file_write", "search_filesystem",
            "calculator", "get_current_time", "get_working_directory", "list_files"
        ]

        registry = ToolRegistry(
            config=config,
            default_working_dir=test_dir
        )

        print("\n" + "="*60)
        print("TEST 1: get_working_directory tool")
        print("="*60)
        result = registry.execute("get_working_directory")
        print(f"Result: {result.output}")
        assert result.is_success, f"get_working_directory failed: {result.error}"
        assert result.output == test_dir, f"Expected {test_dir}, got {result.output}"
        print("✓ PASSED: Working directory is correct")

        print("\n" + "="*60)
        print("TEST 2: list_files in current directory")
        print("="*60)
        result = registry.execute("list_files", path=".")
        print(f"Result:\n{result.output}")
        assert result.is_success, f"list_files failed: {result.error}"
        assert "file1.txt" in result.output, "file1.txt not found in listing"
        assert "subdir/" in result.output, "subdir/ not found in listing"
        print("✓ PASSED: list_files shows correct contents")

        print("\n" + "="*60)
        print("TEST 3: file_read with relative path")
        print("="*60)
        result = registry.execute("file_read", path="file1.txt")
        print(f"Result: {result.output}")
        assert result.is_success, f"file_read failed: {result.error}"
        assert "Hello from file1" in result.output, "File content incorrect"
        print("✓ PASSED: file_read with relative path works")

        print("\n" + "="*60)
        print("TEST 4: file_read with relative subdirectory path")
        print("="*60)
        result = registry.execute("file_read", path="subdir/file2.txt")
        print(f"Result: {result.output}")
        assert result.is_success, f"file_read failed: {result.error}"
        assert "Hello from file2" in result.output, "File content incorrect"
        print("✓ PASSED: file_read with relative subdirectory path works")

        print("\n" + "="*60)
        print("TEST 5: file_write with relative path")
        print("="*60)
        result = registry.execute("file_write", path="newfile.txt", content="Created by test")
        print(f"Result: {result.output}")
        assert result.is_success, f"file_write failed: {result.error}"

        # Verify it was created in the right place
        expected_path = os.path.join(test_dir, "newfile.txt")
        assert os.path.exists(expected_path), f"File not created at {expected_path}"
        with open(expected_path, "r") as f:
            content = f.read()
        assert content == "Created by test", f"File content incorrect: {content}"
        print("✓ PASSED: file_write creates file in correct location")

        print("\n" + "="*60)
        print("TEST 6: bash_execute runs in correct directory")
        print("="*60)
        result = registry.execute("bash_execute", command="pwd")
        print(f"Result: {result.output}")
        assert result.is_success, f"bash_execute failed: {result.error}"
        # The output should contain the test_dir path
        assert test_dir in result.output, f"bash pwd output doesn't match: {result.output}"
        print("✓ PASSED: bash_execute runs in correct directory")

        print("\n" + "="*60)
        print("TEST 7: bash_execute can see relative files")
        print("="*60)
        result = registry.execute("bash_execute", command="ls -la")
        print(f"Result:\n{result.output}")
        assert result.is_success, f"bash_execute failed: {result.error}"
        assert "file1.txt" in result.output, "file1.txt not found in bash ls output"
        assert "newfile.txt" in result.output, "newfile.txt not found in bash ls output"
        print("✓ PASSED: bash ls shows files in working directory")

        print("\n" + "="*60)
        print("TEST 8: Context manager temporarily changes directory")
        print("="*60)

        # Create a different directory
        other_dir = os.path.join(tmpdir, "other_workspace")
        os.makedirs(other_dir)
        with open(os.path.join(other_dir, "other_file.txt"), "w") as f:
            f.write("In other workspace")

        # Use context manager to temporarily switch
        with registry.with_working_dir(other_dir):
            result = registry.execute("get_working_directory")
            print(f"Inside context: {result.output}")
            assert result.output == other_dir, f"Context didn't change directory"

            result = registry.execute("list_files", path=".")
            assert "other_file.txt" in result.output, "Can't see other workspace files"

        # Outside context, should be back to original
        result = registry.execute("get_working_directory")
        print(f"Outside context: {result.output}")
        assert result.output == test_dir, f"Context didn't restore directory"
        print("✓ PASSED: Context manager works correctly")

        print("\n" + "="*60)
        print("ALL TESTS PASSED! ✓")
        print("="*60)
        print("\nThe agent now has proper directory context awareness:")
        print("1. It knows its current working directory")
        print("2. All relative paths are resolved against the calling directory")
        print("3. Bash commands run in the correct directory")
        print("4. Context can be temporarily changed per-request")

if __name__ == "__main__":
    test_working_directory_context()
