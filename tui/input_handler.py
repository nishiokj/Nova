"""Raw terminal input handler with file autocomplete support.

Provides character-by-character input handling with inline dropdown
autocomplete for @filename references.
"""

from __future__ import annotations

import sys
import termios
import tty
import shutil
from typing import List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from tui.autocomplete import FileCache

# ANSI escape codes for cursor control and rendering
class ANSI:
    """ANSI escape sequences for terminal control."""

    SAVE_CURSOR = "\033[s"
    RESTORE_CURSOR = "\033[u"
    CLEAR_LINE = "\033[2K"
    CLEAR_TO_END = "\033[0J"

    # Colors (reuse from simple_tui.py Colors class)
    RESET = "\033[0m"
    BOLD = "\033[1m"
    GREEN = "\033[32m"
    BRIGHT_BLACK = "\033[90m"
    BRIGHT_GREEN = "\033[92m"
    BG_GREEN = "\033[42m"
    BG_BRIGHT_BLACK = "\033[100m"

    @staticmethod
    def move_to(row: int, col: int) -> str:
        """Move cursor to specific position."""
        return f"\033[{row};{col}H"

    @staticmethod
    def move_right(n: int) -> str:
        """Move cursor right by n columns."""
        return f"\033[{n}C"

    @staticmethod
    def move_left(n: int) -> str:
        """Move cursor left by n columns."""
        return f"\033[{n}D"


class RawInputHandler:
    """Handles raw terminal input with autocomplete support."""

    def __init__(self, file_cache: FileCache, tui):
        """Initialize input handler.

        Args:
            file_cache: FileCache instance for file suggestions
            tui: Reference to SimpleTUI instance (for rendering context)
        """
        self.file_cache = file_cache
        self.tui = tui
        self.autocomplete_active = False
        self.autocomplete_suggestions: List[str] = []
        self.autocomplete_selected = 0
        self.dropdown_row = 0  # Track where dropdown is rendered
        self.last_cursor_line = 0  # Track which terminal line the cursor is on

    def read_input_with_autocomplete(self) -> str:
        """Read user input with autocomplete support.

        Returns:
            Complete input string with any autocomplete replacements

        Raises:
            EOFError: On Ctrl+D
            KeyboardInterrupt: On Ctrl+C
        """
        # Enter raw terminal mode
        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)

        try:
            tty.setraw(fd)
            return self._read_input_loop()
        finally:
            # Always restore terminal settings
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)

    def _read_input_loop(self) -> str:
        """Main character-by-character input loop."""
        buffer: List[str] = []
        cursor_pos = 0

        # Reset cursor tracking for new input
        self.last_cursor_line = 0

        # Get terminal dimensions
        width, height = shutil.get_terminal_size()

        # Calculate input box position (bottom of screen)
        self.dropdown_row = height - 3  # Leave room for input box

        while True:
            # Read one character
            char = sys.stdin.read(1)

            # Handle Enter key
            if char == '\r' or char == '\n':
                if self.autocomplete_active and self.autocomplete_suggestions:
                    # Insert selected suggestion
                    cursor_pos = self._insert_selected_file(buffer, cursor_pos)
                    self._clear_autocomplete_dropdown()
                    self.autocomplete_active = False
                    self._render_input_line(buffer, cursor_pos)
                    continue
                else:
                    # Submit input
                    self._clear_autocomplete_dropdown()
                    sys.stdout.write('\r\n')
                    sys.stdout.flush()
                    break

            # Handle Escape sequences (arrow keys, etc.)
            elif char == '\x1b':
                seq = sys.stdin.read(2)

                if seq == '[A':  # Up arrow
                    if self.autocomplete_active and len(self.autocomplete_suggestions) > 0:
                        self.autocomplete_selected = max(0, self.autocomplete_selected - 1)
                        self._render_autocomplete_dropdown()

                elif seq == '[B':  # Down arrow
                    if self.autocomplete_active and len(self.autocomplete_suggestions) > 0:
                        max_idx = len(self.autocomplete_suggestions) - 1
                        self.autocomplete_selected = min(max_idx, self.autocomplete_selected + 1)
                        self._render_autocomplete_dropdown()

                elif seq == '[D':  # Left arrow
                    if cursor_pos > 0:
                        cursor_pos -= 1
                        self._check_autocomplete_trigger(buffer, cursor_pos)
                        self._render_input_line(buffer, cursor_pos)

                elif seq == '[C':  # Right arrow
                    if cursor_pos < len(buffer):
                        cursor_pos += 1
                        self._check_autocomplete_trigger(buffer, cursor_pos)
                        self._render_input_line(buffer, cursor_pos)

                else:
                    # Escape key pressed (just [)
                    if self.autocomplete_active:
                        self._clear_autocomplete_dropdown()
                        self.autocomplete_active = False

            # Handle Backspace
            elif char == '\x7f':
                if cursor_pos > 0:
                    buffer.pop(cursor_pos - 1)
                    cursor_pos -= 1
                    self._check_autocomplete_trigger(buffer, cursor_pos)
                    self._render_input_line(buffer, cursor_pos)

            # Handle Ctrl+C
            elif char == '\x03':
                self._clear_autocomplete_dropdown()
                raise KeyboardInterrupt

            # Handle Ctrl+D (EOF)
            elif char == '\x04':
                if len(buffer) == 0:
                    self._clear_autocomplete_dropdown()
                    raise EOFError

            # Handle Tab (also selects autocomplete)
            elif char == '\t':
                if self.autocomplete_active and self.autocomplete_suggestions:
                    cursor_pos = self._insert_selected_file(buffer, cursor_pos)
                    self._clear_autocomplete_dropdown()
                    self.autocomplete_active = False
                    self._render_input_line(buffer, cursor_pos)

            # Regular character
            elif char >= ' ' or char == '\t':
                buffer.insert(cursor_pos, char)
                cursor_pos += 1
                self._check_autocomplete_trigger(buffer, cursor_pos)
                self._render_input_line(buffer, cursor_pos)

        return ''.join(buffer)

    def _check_autocomplete_trigger(self, buffer: List[str], cursor_pos: int) -> None:
        """Check if autocomplete should be triggered.

        Args:
            buffer: Current input buffer
            cursor_pos: Current cursor position
        """
        # Find last @ symbol before cursor
        at_pos = self._find_last_at_symbol(buffer, cursor_pos)

        if at_pos < 0:
            # No @ found, hide dropdown
            if self.autocomplete_active:
                self._clear_autocomplete_dropdown()
                self.autocomplete_active = False
            return

        # Extract query after @
        query = ''.join(buffer[at_pos + 1:cursor_pos])

        # Trigger: @ + at least 1 character
        if len(query) >= 1:
            from tui.autocomplete import fuzzy_match

            files = self.file_cache.get_files()
            self.autocomplete_suggestions = fuzzy_match(query, files, limit=8)
            self.autocomplete_selected = 0

            if self.autocomplete_suggestions:
                self.autocomplete_active = True
                self._render_autocomplete_dropdown()
            else:
                if self.autocomplete_active:
                    self._clear_autocomplete_dropdown()
                    self.autocomplete_active = False
        else:
            if self.autocomplete_active:
                self._clear_autocomplete_dropdown()
                self.autocomplete_active = False

    def _find_last_at_symbol(self, buffer: List[str], cursor_pos: int) -> int:
        """Find position of last @ symbol before cursor at word boundary.

        Args:
            buffer: Input buffer
            cursor_pos: Current cursor position

        Returns:
            Position of @ symbol, or -1 if not found
        """
        for i in range(cursor_pos - 1, -1, -1):
            if buffer[i] == '@':
                # Check if it's at word boundary (start or after whitespace)
                if i == 0 or buffer[i - 1].isspace():
                    return i
        return -1

    def _insert_selected_file(self, buffer: List[str], cursor_pos: int) -> int:
        """Replace @query with selected file path and return new cursor position.

        Args:
            buffer: Input buffer (modified in-place)
            cursor_pos: Current cursor position

        Returns:
            New cursor position (after the inserted path + space)
        """
        at_pos = self._find_last_at_symbol(buffer, cursor_pos)
        if at_pos < 0:
            return cursor_pos

        selected = self.autocomplete_suggestions[self.autocomplete_selected]
        replacement = f"./{selected} "  # Add space after path

        # Remove from @ to cursor
        del buffer[at_pos:cursor_pos]

        # Insert replacement
        for i, char in enumerate(replacement):
            buffer.insert(at_pos + i, char)

        # Return position after the replacement (including the space)
        return at_pos + len(replacement)

    def _find_cursor_after_replacement(self, buffer: List[str], old_cursor_pos: int) -> int:
        """Calculate cursor position after file path insertion.

        Args:
            buffer: Input buffer
            old_cursor_pos: Old cursor position

        Returns:
            New cursor position
        """
        at_pos = -1
        for i in range(len(buffer)):
            if i + 1 < len(buffer) and buffer[i] == '.' and buffer[i + 1] == '/':
                # Found start of our replacement
                # Find end of path
                j = i + 2
                while j < len(buffer) and not buffer[j].isspace():
                    j += 1
                return j

        # Fallback: end of buffer
        return len(buffer)

    def _render_input_line(self, buffer: List[str], cursor_pos: int) -> None:
        """Render current input line.

        Args:
            buffer: Input buffer
            cursor_pos: Current cursor position
        """
        # Calculate how many terminal lines the current input occupies
        width, _ = shutil.get_terminal_size()
        line = ''.join(buffer)
        prompt_len = 2  # "> "
        total_content_len = prompt_len + len(line)
        lines_occupied = (total_content_len + width - 1) // width  # Ceiling division

        # First, move up to line 0 from wherever we are
        # The cursor is at self.last_cursor_line from the previous render
        if self.last_cursor_line > 0:
            sys.stdout.write(f'\x1b[{self.last_cursor_line}A')
        sys.stdout.write('\r')

        # Now clear all occupied lines
        for i in range(lines_occupied):
            sys.stdout.write(ANSI.CLEAR_LINE)
            if i < lines_occupied - 1:
                sys.stdout.write('\n')

        # Move back to start
        if lines_occupied > 1:
            # Move up to the first line
            sys.stdout.write(f'\x1b[{lines_occupied - 1}A')
        sys.stdout.write('\r')

        # Render prompt and input
        sys.stdout.write(f"{ANSI.GREEN}> {ANSI.RESET}{line}")

        # Calculate where cursor ended up after writing the line
        end_content_pos = prompt_len + len(line)
        end_line = end_content_pos // width

        # Calculate where cursor should be positioned
        cursor_content_pos = prompt_len + cursor_pos
        cursor_line = cursor_content_pos // width
        cursor_col = cursor_content_pos % width

        # Move cursor from end position to target position
        # First, move up to the first line
        if end_line > 0:
            sys.stdout.write(f'\x1b[{end_line}A')
        sys.stdout.write('\r')

        # Then move to target position
        if cursor_line > 0:
            sys.stdout.write(f'\x1b[{cursor_line}B')  # Move down cursor_line lines
        if cursor_col > 0:
            sys.stdout.write(ANSI.move_right(cursor_col))

        # Store cursor position for next render
        self.last_cursor_line = cursor_line

        sys.stdout.flush()

    def _render_autocomplete_dropdown(self) -> None:
        """Render autocomplete dropdown below cursor."""
        if not self.autocomplete_suggestions:
            return

        # Save cursor position
        sys.stdout.write(ANSI.SAVE_CURSOR)

        # Get terminal dimensions
        width, _ = shutil.get_terminal_size()

        # Calculate dropdown dimensions
        max_display = min(8, len(self.autocomplete_suggestions))
        dropdown_width = min(60, width - 4)

        # Move below current line
        sys.stdout.write('\r\n')

        # Top border
        sys.stdout.write(f"{ANSI.BRIGHT_BLACK}╭{'─' * (dropdown_width - 2)}╮{ANSI.RESET}\r\n")

        # Render suggestions
        for i, suggestion in enumerate(self.autocomplete_suggestions[:max_display]):
            # Truncate if too long
            display_text = suggestion
            if len(display_text) > dropdown_width - 4:
                display_text = '...' + display_text[-(dropdown_width - 7):]

            if i == self.autocomplete_selected:
                # Highlight selected item
                sys.stdout.write(
                    f"{ANSI.BRIGHT_BLACK}│{ANSI.RESET}"
                    f"{ANSI.BG_GREEN}{ANSI.BOLD} {display_text:<{dropdown_width - 4}} {ANSI.RESET}"
                    f"{ANSI.BRIGHT_BLACK}│{ANSI.RESET}\r\n"
                )
            else:
                sys.stdout.write(
                    f"{ANSI.BRIGHT_BLACK}│{ANSI.RESET}"
                    f" {display_text:<{dropdown_width - 4}} "
                    f"{ANSI.BRIGHT_BLACK}│{ANSI.RESET}\r\n"
                )

        # Bottom border
        sys.stdout.write(f"{ANSI.BRIGHT_BLACK}╰{'─' * (dropdown_width - 2)}╯{ANSI.RESET}")

        # Restore cursor
        sys.stdout.write(ANSI.RESTORE_CURSOR)
        sys.stdout.flush()

    def _clear_autocomplete_dropdown(self) -> None:
        """Clear the autocomplete dropdown."""
        if not self.autocomplete_active:
            return

        # Save cursor
        sys.stdout.write(ANSI.SAVE_CURSOR)

        # Get terminal dimensions
        width, _ = shutil.get_terminal_size()

        # Calculate how many lines to clear
        max_display = min(8, len(self.autocomplete_suggestions))
        lines_to_clear = max_display + 2  # +2 for borders

        # Clear each line
        for i in range(lines_to_clear):
            sys.stdout.write('\r\n')
            sys.stdout.write(ANSI.CLEAR_LINE)

        # Restore cursor
        sys.stdout.write(ANSI.RESTORE_CURSOR)
        sys.stdout.flush()
