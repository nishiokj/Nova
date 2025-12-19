"""Input state management and raw terminal utilities.

This module provides:
1. RawTerminal - context manager for raw terminal mode
2. InputState - manages input buffer, cursor, and autocomplete state

All rendering is handled by SimpleTUI - this module only manages state.
"""

from __future__ import annotations

import sys
import termios
import tty
from typing import List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from tui.autocomplete import FileCache


class RawTerminal:
    """Context manager for raw terminal mode with character reading."""

    def __init__(self):
        self.fd: Optional[int] = None
        self.old_settings = None

    def __enter__(self) -> "RawTerminal":
        self.fd = sys.stdin.fileno()
        self.old_settings = termios.tcgetattr(self.fd)
        tty.setraw(self.fd)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        if self.old_settings is not None and self.fd is not None:
            # Restore terminal settings
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self.old_settings)
            # Flush any pending output
            sys.stdout.flush()

    def read_char(self) -> str:
        """Read a single character from stdin."""
        return sys.stdin.read(1)

    def read_escape_sequence(self) -> str:
        """Read the 2-character sequence after an ESC character."""
        return sys.stdin.read(2)


class InputState:
    """Manages input buffer, cursor position, and autocomplete state.

    This class is purely for state management - no rendering logic.
    SimpleTUI queries this state to render the input box.
    """

    def __init__(self, file_cache: "FileCache"):
        self.file_cache = file_cache

        # Input buffer and cursor
        self.buffer: List[str] = []
        self.cursor_pos: int = 0

        # Autocomplete state
        self.autocomplete_active: bool = False
        self.autocomplete_suggestions: List[str] = []
        self.autocomplete_selected: int = 0

        # Track if state changed (for render optimization)
        self._dirty: bool = True

    def reset(self) -> None:
        """Reset state for a new input session."""
        self.buffer = []
        self.cursor_pos = 0
        self.autocomplete_active = False
        self.autocomplete_suggestions = []
        self.autocomplete_selected = 0
        self._dirty = True

    def is_dirty(self) -> bool:
        """Check if state has changed since last render."""
        return self._dirty

    def mark_clean(self) -> None:
        """Mark state as rendered."""
        self._dirty = False

    def get_text(self) -> str:
        """Get current input text."""
        return "".join(self.buffer)

    def insert_char(self, char: str) -> None:
        """Insert a character at cursor position."""
        self.buffer.insert(self.cursor_pos, char)
        self.cursor_pos += 1
        self._update_autocomplete()
        self._dirty = True

    def backspace(self) -> bool:
        """Delete character before cursor. Returns True if deletion occurred."""
        if self.cursor_pos > 0:
            self.buffer.pop(self.cursor_pos - 1)
            self.cursor_pos -= 1
            self._update_autocomplete()
            self._dirty = True
            return True
        return False

    def delete(self) -> bool:
        """Delete character at cursor. Returns True if deletion occurred."""
        if self.cursor_pos < len(self.buffer):
            self.buffer.pop(self.cursor_pos)
            self._update_autocomplete()
            self._dirty = True
            return True
        return False

    def move_left(self) -> bool:
        """Move cursor left. Returns True if moved."""
        if self.cursor_pos > 0:
            self.cursor_pos -= 1
            self._update_autocomplete()
            self._dirty = True
            return True
        return False

    def move_right(self) -> bool:
        """Move cursor right. Returns True if moved."""
        if self.cursor_pos < len(self.buffer):
            self.cursor_pos += 1
            self._update_autocomplete()
            self._dirty = True
            return True
        return False

    def move_to_start(self) -> None:
        """Move cursor to start of line."""
        if self.cursor_pos != 0:
            self.cursor_pos = 0
            self._update_autocomplete()
            self._dirty = True

    def move_to_end(self) -> None:
        """Move cursor to end of line."""
        if self.cursor_pos != len(self.buffer):
            self.cursor_pos = len(self.buffer)
            self._update_autocomplete()
            self._dirty = True

    def clear_line(self) -> None:
        """Clear the entire input line."""
        if self.buffer:
            self.buffer = []
            self.cursor_pos = 0
            self._update_autocomplete()
            self._dirty = True

    def delete_word_back(self) -> None:
        """Delete the word before cursor (Ctrl+W behavior)."""
        if self.cursor_pos == 0:
            return

        # Skip trailing whitespace
        while self.cursor_pos > 0 and self.buffer[self.cursor_pos - 1].isspace():
            self.buffer.pop(self.cursor_pos - 1)
            self.cursor_pos -= 1

        # Delete until whitespace or start
        while self.cursor_pos > 0 and not self.buffer[self.cursor_pos - 1].isspace():
            self.buffer.pop(self.cursor_pos - 1)
            self.cursor_pos -= 1

        self._update_autocomplete()
        self._dirty = True

    def select_prev_suggestion(self) -> bool:
        """Select previous autocomplete suggestion. Returns True if selection changed."""
        if self.autocomplete_active and self.autocomplete_suggestions:
            if self.autocomplete_selected > 0:
                self.autocomplete_selected -= 1
                self._dirty = True
                return True
        return False

    def select_next_suggestion(self) -> bool:
        """Select next autocomplete suggestion. Returns True if selection changed."""
        if self.autocomplete_active and self.autocomplete_suggestions:
            max_idx = len(self.autocomplete_suggestions) - 1
            if self.autocomplete_selected < max_idx:
                self.autocomplete_selected += 1
                self._dirty = True
                return True
        return False

    def accept_suggestion(self) -> bool:
        """Accept current autocomplete suggestion. Returns True if accepted."""
        if not self.autocomplete_active or not self.autocomplete_suggestions:
            return False

        at_pos = self._find_at_symbol()
        if at_pos < 0:
            return False

        selected = self.autocomplete_suggestions[self.autocomplete_selected]
        replacement = f"./{selected} "

        # Remove from @ to cursor
        del self.buffer[at_pos:self.cursor_pos]

        # Insert replacement
        for i, char in enumerate(replacement):
            self.buffer.insert(at_pos + i, char)

        self.cursor_pos = at_pos + len(replacement)
        self.autocomplete_active = False
        self.autocomplete_suggestions = []
        self.autocomplete_selected = 0
        self._dirty = True
        return True

    def dismiss_autocomplete(self) -> None:
        """Dismiss autocomplete dropdown."""
        if self.autocomplete_active:
            self.autocomplete_active = False
            self.autocomplete_suggestions = []
            self.autocomplete_selected = 0
            self._dirty = True

    def _find_at_symbol(self) -> int:
        """Find position of @ symbol that triggers autocomplete.

        Returns position of @, or -1 if not found.
        The @ must be at start of input or after whitespace.
        """
        for i in range(self.cursor_pos - 1, -1, -1):
            if self.buffer[i] == "@":
                # Check if it's at word boundary
                if i == 0 or self.buffer[i - 1].isspace():
                    return i
            # Stop if we hit whitespace (no @ in this word)
            elif self.buffer[i].isspace():
                break
        return -1

    def _update_autocomplete(self) -> None:
        """Update autocomplete suggestions based on current input."""
        at_pos = self._find_at_symbol()

        if at_pos < 0:
            if self.autocomplete_active:
                self.autocomplete_active = False
                self.autocomplete_suggestions = []
                self.autocomplete_selected = 0
            return

        # Extract query after @
        query = "".join(self.buffer[at_pos + 1 : self.cursor_pos])

        # Need at least 1 character after @
        if len(query) >= 1:
            from tui.autocomplete import fuzzy_match

            files = self.file_cache.get_files()
            suggestions = fuzzy_match(query, files, limit=8)

            if suggestions:
                self.autocomplete_suggestions = suggestions
                # Keep selection in bounds
                self.autocomplete_selected = min(
                    self.autocomplete_selected, len(suggestions) - 1
                )
                self.autocomplete_active = True
            else:
                self.autocomplete_active = False
                self.autocomplete_suggestions = []
                self.autocomplete_selected = 0
        else:
            self.autocomplete_active = False
            self.autocomplete_suggestions = []
            self.autocomplete_selected = 0
