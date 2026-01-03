"""
File state tracker for deterministic per-turn evidence.

Captures:
1. Git diff per turn
2. File snapshots (before/after)
3. File operations detection
4. Working directory state

Addresses: "Final state/files created" in reports will be wrong today
"""

import os
import hashlib
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple
from datetime import datetime
from dataclasses import dataclass

from .eval_models import (
    FileSnapshot,
    FileOperation,
    TurnFileState
)


class FileStateTracker:
    """
    Tracks file system state changes during agent execution.

    Usage:
        tracker = FileStateTracker(workspace_path)
        tracker.capture_initial_state()

        # ... agent executes turn 1 ...

        state1 = tracker.capture_turn_state(turn_number=1)

        # ... agent executes turn 2 ...

        state2 = tracker.capture_turn_state(turn_number=2)
    """

    def __init__(self, workspace_path: str, track_patterns: Optional[List[str]] = None):
        """
        Args:
            workspace_path: Root directory to track
            track_patterns: File patterns to track (default: all non-git files)
        """
        self.workspace_path = Path(workspace_path).resolve()
        self.track_patterns = track_patterns or ["*"]

        # State tracking
        self._initial_state: Dict[str, FileSnapshot] = {}
        self._last_state: Dict[str, FileSnapshot] = {}
        self._file_operations: List[FileOperation] = []

        # Git tracking
        self._last_commit: Optional[str] = None
        self._initial_commit: Optional[str] = None

        # Turn tracking
        self._current_turn = 0

    def capture_initial_state(self) -> Dict[str, FileSnapshot]:
        """
        Capture initial workspace state before any agent execution.
        Should be called once at scenario start.
        """
        self._initial_state = self._snapshot_workspace()
        self._last_state = self._initial_state.copy()
        self._initial_commit = self._get_git_commit()
        self._last_commit = self._initial_commit
        return self._initial_state

    def capture_turn_state(
        self,
        turn_number: int,
        tool_calls: Optional[List[Dict]] = None,
        previous_commit: Optional[str] = None
    ) -> TurnFileState:
        """
        Capture file state after a turn completes.

        Args:
            turn_number: Current turn number
            tool_calls: List of tool calls from this turn (for operation detection)
            previous_commit: Git commit hash from after the previous turn's commit.
                           If provided, this is used as the baseline for per-turn diffs.
                           This fixes the accumulation bug where diffs showed all changes
                           from initial state instead of per-turn changes.

        Returns:
            TurnFileState with git diff, snapshots, and detected operations
        """
        self._current_turn = turn_number

        # CRITICAL: Update _last_commit if caller provides the post-commit hash
        # This ensures per-turn diffs compare against the previous turn's committed state,
        # not the initial state (which was the bug before this fix)
        if previous_commit:
            self._last_commit = previous_commit

        # Capture current state
        current_state = self._snapshot_workspace()

        # Generate git diff (now correctly per-turn if previous_commit was provided)
        git_diff = self._get_git_diff_since_last()
        git_status = self._get_git_status()

        # Detect file operations
        operations = self._detect_operations(
            before=self._last_state,
            after=current_state,
            tool_calls=tool_calls
        )

        # Build TurnFileState
        turn_state = TurnFileState(
            git_diff=git_diff,
            git_status=git_status,
            operations=operations,
            files_before=self._last_state.copy(),
            files_after=current_state.copy(),
            working_dir=str(self.workspace_path),
            directory_listing=self._get_directory_listing()
        )

        # Update tracking state for next turn
        self._last_state = current_state
        self._file_operations.extend(operations)

        # Note: We don't update _last_commit here anymore since we get it from the caller
        # This prevents the race condition where we'd read HEAD before the commit happened

        return turn_state

    def get_all_operations(self) -> List[FileOperation]:
        """Get all file operations across all turns."""
        return self._file_operations.copy()

    def reset(self):
        """Reset tracker state (for new scenario)."""
        self._initial_state = {}
        self._last_state = {}
        self._file_operations = []
        self._last_commit = None
        self._initial_commit = None
        self._current_turn = 0

    # ========================================================================
    # Private methods
    # ========================================================================

    def _snapshot_workspace(self) -> Dict[str, FileSnapshot]:
        """Create snapshots of all tracked files."""
        snapshots = {}

        for file_path in self._get_tracked_files():
            snapshot = self._snapshot_file(file_path)
            if snapshot:
                rel_path = str(file_path.relative_to(self.workspace_path))
                snapshots[rel_path] = snapshot

        return snapshots

    def _snapshot_file(self, file_path: Path) -> Optional[FileSnapshot]:
        """Create a snapshot of a single file."""
        try:
            if not file_path.exists():
                return FileSnapshot(
                    path=str(file_path.relative_to(self.workspace_path)),
                    content="",
                    size_bytes=0,
                    sha256="",
                    exists=False,
                    modified_at=""
                )

            # Read content and calculate hash
            try:
                # Try reading as text
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                # Hash the text content
                sha256 = hashlib.sha256(content.encode('utf-8')).hexdigest()
            except UnicodeDecodeError:
                # Binary file - hash the actual bytes
                with open(file_path, 'rb') as f:
                    binary_content = f.read()
                    sha256 = hashlib.sha256(binary_content).hexdigest()
                # Store placeholder in content field
                content = f"<binary file, {file_path.stat().st_size} bytes, sha256:{sha256[:16]}>"

            # Get metadata
            stat = file_path.stat()
            modified_at = datetime.fromtimestamp(stat.st_mtime).isoformat()

            return FileSnapshot(
                path=str(file_path.relative_to(self.workspace_path)),
                content=content,
                size_bytes=stat.st_size,
                sha256=sha256,
                exists=True,
                modified_at=modified_at
            )
        except Exception as e:
            # Log but don't fail
            print(f"Warning: Could not snapshot {file_path}: {e}")
            return None

    def _get_tracked_files(self) -> List[Path]:
        """Get list of files to track."""
        files = []

        # Walk workspace
        for root, dirs, filenames in os.walk(self.workspace_path):
            # Skip .git directory
            dirs[:] = [d for d in dirs if d != '.git']

            root_path = Path(root)
            for filename in filenames:
                file_path = root_path / filename

                # Apply filters
                if self._should_track(file_path):
                    files.append(file_path)

        return files

    def _should_track(self, file_path: Path) -> bool:
        """Check if file should be tracked."""
        # Skip hidden files
        if file_path.name.startswith('.'):
            return False

        # Skip common build/cache directories
        skip_dirs = {'__pycache__', 'node_modules', '.venv', 'venv', '.tox'}
        if any(skip in file_path.parts for skip in skip_dirs):
            return False

        return True

    def _detect_operations(
        self,
        before: Dict[str, FileSnapshot],
        after: Dict[str, FileSnapshot],
        tool_calls: Optional[List[Dict]] = None
    ) -> List[FileOperation]:
        """
        Detect file operations by comparing before/after state.
        Enriches with tool call information if available.
        """
        operations = []

        # Map tool calls by file path if available
        tool_map: Dict[str, List[Dict]] = {}
        if tool_calls:
            for tool_call in tool_calls:
                paths = self._extract_paths_from_tool_call(tool_call)
                for path in paths:
                    if path not in tool_map:
                        tool_map[path] = []
                    tool_map[path].append(tool_call)

        # Detect creates and modifies
        for path, after_snap in after.items():
            before_snap = before.get(path)

            if not before_snap or not before_snap.exists:
                # File was created
                tool_calls_for_path = tool_map.get(path, [])
                tool_name = tool_calls_for_path[0].get('tool_name', 'unknown') if tool_calls_for_path else 'unknown'

                operations.append(FileOperation(
                    operation="create",
                    path=path,
                    tool_name=tool_name,
                    step_number=self._current_turn,
                    before_snapshot=before_snap,
                    after_snapshot=after_snap
                ))
            elif before_snap.sha256 != after_snap.sha256:
                # File was modified
                tool_calls_for_path = tool_map.get(path, [])
                tool_name = tool_calls_for_path[0].get('tool_name', 'unknown') if tool_calls_for_path else 'unknown'

                operations.append(FileOperation(
                    operation="modify",
                    path=path,
                    tool_name=tool_name,
                    step_number=self._current_turn,
                    before_snapshot=before_snap,
                    after_snapshot=after_snap
                ))

        # Detect deletes
        for path, before_snap in before.items():
            if path not in after or not after[path].exists:
                tool_calls_for_path = tool_map.get(path, [])
                tool_name = tool_calls_for_path[0].get('tool_name', 'unknown') if tool_calls_for_path else 'unknown'

                operations.append(FileOperation(
                    operation="delete",
                    path=path,
                    tool_name=tool_name,
                    step_number=self._current_turn,
                    before_snapshot=before_snap,
                    after_snapshot=None
                ))

        # Add read operations from tool calls
        if tool_calls:
            for tool_call in tool_calls:
                if self._is_read_operation(tool_call):
                    paths = self._extract_paths_from_tool_call(tool_call)
                    for path in paths:
                        if path in after:  # File exists
                            operations.append(FileOperation(
                                operation="read",
                                path=path,
                                tool_name=tool_call.get('tool_name', 'unknown'),
                                step_number=self._current_turn,
                                before_snapshot=after[path],
                                after_snapshot=after[path]
                            ))

        return operations

    def _extract_paths_from_tool_call(self, tool_call: Dict) -> List[str]:
        """Extract file paths from tool call arguments."""
        paths = []
        args = tool_call.get('arguments', {})

        # Common parameter names for file paths
        path_params = ['path', 'file_path', 'filename', 'file', 'output_path', 'input_path']

        for param in path_params:
            if param in args:
                path = args[param]
                if path and isinstance(path, str):
                    # Convert to relative path if needed
                    try:
                        abs_path = Path(path).resolve()
                        if abs_path.is_relative_to(self.workspace_path):
                            rel_path = str(abs_path.relative_to(self.workspace_path))
                            paths.append(rel_path)
                    except (ValueError, OSError):
                        # If path is already relative or invalid, use as-is
                        paths.append(path)

        return paths

    def _is_read_operation(self, tool_call: Dict) -> bool:
        """Check if tool call is a read operation."""
        tool_name = tool_call.get('tool_name', '').lower()
        read_tools = {'read', 'read_file', 'cat', 'grep', 'search', 'glob'}
        return any(read_tool in tool_name for read_tool in read_tools)

    def _get_git_diff_since_last(self) -> str:
        """Get git diff since last commit (per-turn, not accumulated)."""
        try:
            # If we have a last commit, diff against it
            # Otherwise, show all uncommitted changes
            if self._last_commit:
                # Compare current working directory to last tracked commit
                result = subprocess.run(
                    ['git', 'diff', '--no-color', self._last_commit],
                    cwd=self.workspace_path,
                    capture_output=True,
                    text=True,
                    timeout=10
                )
            else:
                # No previous commit, show all changes from HEAD
                result = subprocess.run(
                    ['git', 'diff', '--no-color'],
                    cwd=self.workspace_path,
                    capture_output=True,
                    text=True,
                    timeout=10
                )
            return result.stdout if result.returncode == 0 else ""
        except Exception as e:
            return f"Error getting git diff: {e}"

    def _get_git_status(self) -> str:
        """Get git status."""
        try:
            result = subprocess.run(
                ['git', 'status', '--short'],
                cwd=self.workspace_path,
                capture_output=True,
                text=True,
                timeout=10
            )
            return result.stdout if result.returncode == 0 else ""
        except Exception as e:
            return f"Error getting git status: {e}"

    def _get_git_commit(self) -> Optional[str]:
        """Get current git commit hash."""
        try:
            result = subprocess.run(
                ['git', 'rev-parse', 'HEAD'],
                cwd=self.workspace_path,
                capture_output=True,
                text=True,
                timeout=10
            )
            return result.stdout.strip() if result.returncode == 0 else None
        except Exception:
            return None

    def _get_directory_listing(self) -> List[str]:
        """Get sorted list of all tracked files."""
        files = self._get_tracked_files()
        return sorted([str(f.relative_to(self.workspace_path)) for f in files])
