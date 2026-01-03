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
            "Read", "Write", "Edit", "Bash", "Glob", "Grep",
            "python_execute"
        ]

        registry = ToolRegistry(
            config=config,
            default_working_dir=test_dir
        )

        print("\n" + "="*60)
        print("TEST 1: Glob in current directory")
        print("="*60)
        result = registry.execute("Glob", cwd=test_dir, pattern="*")
        print(f"Result:\n{result.output}")
        assert result.is_success, f"Glob failed: {result.error}"
        assert "file1.txt" in result.output, "file1.txt not found in glob results"
        assert "subdir/" in result.output, "subdir/ not found in glob results"
        print("✓ PASSED: Glob shows correct contents")

        print("\n" + "="*60)
        print("TEST 2: Read with relative path")
        print("="*60)
        result = registry.execute("Read", cwd=test_dir, path="file1.txt")
        print(f"Result: {result.output}")
        assert result.is_success, f"Read failed: {result.error}"
        assert "Hello from file1" in result.output, "File content incorrect"
        print("✓ PASSED: Read with relative path works")

        print("\n" + "="*60)
        print("TEST 3: Read with relative subdirectory path")
        print("="*60)
        result = registry.execute("Read", cwd=test_dir, path="subdir/file2.txt")
        print(f"Result: {result.output}")
        assert result.is_success, f"Read failed: {result.error}"
        assert "Hello from file2" in result.output, "File content incorrect"
        print("✓ PASSED: Read with relative subdirectory path works")

        print("\n" + "="*60)
        print("TEST 4: Write with relative path")
        print("="*60)
        result = registry.execute("Write", cwd=test_dir, path="newfile.txt", content="Created by test")
        print(f"Result: {result.output}")
        assert result.is_success, f"Write failed: {result.error}"

        # Verify it was created in the right place
        expected_path = os.path.join(test_dir, "newfile.txt")
        assert os.path.exists(expected_path), f"File not created at {expected_path}"
        with open(expected_path, "r") as f:
            content = f.read()
        assert content == "Created by test", f"File content incorrect: {content}"
        print("✓ PASSED: Write creates file in correct location")

        print("\n" + "="*60)
        print("TEST 5: Edit updates file contents")
        print("="*60)
        result = registry.execute(
            "Edit",
            cwd=test_dir,
            path="newfile.txt",
            old_string="Created by test",
            new_string="Updated by test"
        )
        print(f"Result: {result.output}")
        assert result.is_success, f"Edit failed: {result.error}"
        with open(expected_path, "r") as f:
            content = f.read()
        assert content == "Updated by test", f"Edit did not update content: {content}"
        print("✓ PASSED: Edit updates file correctly")

        print("\n" + "="*60)
        print("TEST 6: Bash runs in correct directory")
        print("="*60)
        result = registry.execute("Bash", cwd=test_dir, command="pwd")
        print(f"Result: {result.output}")
        assert result.is_success, f"Bash failed: {result.error}"
        assert test_dir in result.output, f"Bash pwd output doesn't match: {result.output}"
        print("✓ PASSED: Bash runs in correct directory")

        print("\n" + "="*60)
        print("TEST 7: Bash can see relative files")
        print("="*60)
        result = registry.execute("Bash", cwd=test_dir, command="ls -la")
        print(f"Result:\n{result.output}")
        assert result.is_success, f"Bash failed: {result.error}"
        assert "file1.txt" in result.output, "file1.txt not found in Bash ls output"
        assert "newfile.txt" in result.output, "newfile.txt not found in Bash ls output"
        print("✓ PASSED: Bash ls shows files in working directory")

        print("\n" + "="*60)
        print("ALL TESTS PASSED! ✓")
        print("="*60)
        print("\nThe agent now has proper directory context awareness:")
        print("1. All relative paths are resolved against the provided cwd")
        print("2. Read/Write/Edit operate within cwd")
        print("3. Bash commands run in the correct directory")

if __name__ == "__main__":
    test_working_directory_context()
