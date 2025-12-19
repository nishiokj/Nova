"""Event-driven render engine for the robust TUI.

This module provides:
- ANSI escape sequence helpers
- Output buffering for atomic screen updates
- Dedicated render thread that wakes on events

Key design principles:
1. Render from immutable StateSnapshot (no locks during render)
2. Build entire frame into StringIO buffer before write
3. Single atomic write + flush (reduces flicker)
4. Render thread sleeps until signaled (no polling)
"""

from __future__ import annotations

import io
import os
import shutil
import sys
import textwrap
import threading
from typing import TYPE_CHECKING, Callable, List, Optional, Tuple

if TYPE_CHECKING:
    from tui.tui_state import StateSnapshot, TUIState, TUIStateManager


class ANSI:
    """ANSI escape sequences for terminal control."""

    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"

    # Colors
    BLACK = "\033[30m"
    RED = "\033[31m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    BLUE = "\033[34m"
    MAGENTA = "\033[35m"
    CYAN = "\033[36m"
    WHITE = "\033[37m"

    # Bright colors
    BRIGHT_BLACK = "\033[90m"
    BRIGHT_RED = "\033[91m"
    BRIGHT_GREEN = "\033[92m"
    BRIGHT_YELLOW = "\033[93m"
    BRIGHT_BLUE = "\033[94m"
    BRIGHT_MAGENTA = "\033[95m"
    BRIGHT_CYAN = "\033[96m"
    BRIGHT_WHITE = "\033[97m"

    # Background colors
    BG_GREEN = "\033[42m"
    BG_BRIGHT_BLACK = "\033[100m"

    # Cursor control
    HIDE_CURSOR = "\033[?25l"
    SHOW_CURSOR = "\033[?25h"
    CLEAR_SCREEN = "\033[2J"
    CLEAR_LINE = "\033[2K"
    CLEAR_TO_END = "\033[J"

    @staticmethod
    def move_to(row: int, col: int) -> str:
        """Move cursor to absolute position (1-indexed)."""
        return f"\033[{row};{col}H"

    @staticmethod
    def supports_color() -> bool:
        """Check if terminal supports colors."""
        return (
            hasattr(sys.stdout, "isatty")
            and sys.stdout.isatty()
            and os.getenv("TERM") != "dumb"
        )


def get_terminal_size() -> Tuple[int, int]:
    """Return terminal size (columns, rows)."""
    try:
        size = shutil.get_terminal_size()
        return size.columns, size.lines
    except Exception:
        return 80, 24


class RenderEngine:
    """Dedicated render thread with output buffering.

    The render engine:
    1. Sleeps until render_event is signaled
    2. Takes atomic snapshot of state
    3. Builds frame into StringIO buffer
    4. Writes buffer to stdout in single operation
    5. Repeats

    Usage:
        state = TUIStateManager()
        renderer = RenderEngine(state)
        renderer.start()
        # ... later ...
        renderer.stop()
    """

    def __init__(self, state_manager: "TUIStateManager"):
        self._state = state_manager
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._use_colors = ANSI.supports_color()

        # Layout constants
        self._header_height = 5
        self._min_width = 40
        self._min_height = 10

        # Pause mechanism for PTT recording
        self._paused = False
        self._pause_lock = threading.Lock()

    def start(self):
        """Start the render thread."""
        if self._thread is not None:
            return

        self._running = True
        self._thread = threading.Thread(
            target=self._render_loop,
            daemon=True,
            name="RenderEngine",
        )
        self._thread.start()

    def stop(self):
        """Stop the render thread."""
        self._running = False
        # Signal to wake up if sleeping
        self._state.render_event.set()
        if self._thread:
            self._thread.join(timeout=1.0)
            self._thread = None

    def pause(self):
        """Pause rendering (used during PTT recording to avoid terminal interference)."""
        with self._pause_lock:
            self._paused = True

    def resume(self):
        """Resume rendering after pause."""
        with self._pause_lock:
            self._paused = False
        # Trigger immediate re-render after resuming
        self._state.render_event.set()

    def is_paused(self) -> bool:
        """Check if rendering is paused."""
        with self._pause_lock:
            return self._paused

    def _render_loop(self):
        """Main render loop - runs in dedicated thread."""
        while self._running:
            # Wait for signal OR timeout (100ms for cursor blink, etc.)
            self._state.render_event.wait(timeout=0.1)
            self._state.render_event.clear()

            if not self._running:
                break

            # Skip rendering when paused (during PTT recording)
            if self.is_paused():
                continue

            try:
                # Take atomic snapshot
                snapshot = self._state.snapshot()

                # Build frame into buffer
                output = self._build_frame(snapshot)

                # Single atomic write
                sys.stdout.write(output)
                sys.stdout.flush()

            except Exception:
                # Render errors shouldn't crash the thread
                pass

    def render_once(self):
        """Render immediately (for initial draw before thread starts)."""
        snapshot = self._state.snapshot()
        output = self._build_frame(snapshot)
        sys.stdout.write(output)
        sys.stdout.flush()

    # ---------------------------------------------------------------- Frame Building

    def _build_frame(self, snapshot: "StateSnapshot") -> str:
        """Build entire frame as string for single write."""
        buffer = io.StringIO()

        width, height = get_terminal_size()
        width = max(self._min_width, width)
        height = max(self._min_height, height)

        # Calculate layout
        from tui.tui_state import TUIState

        # Input box height depends on state and content
        show_input = snapshot.state in (TUIState.IDLE, TUIState.TRANSCRIBING)
        if show_input:
            prompt = "> "
            input_content = prompt + snapshot.input_buffer
            input_lines = max(1, (len(input_content) + width - 1) // width)
            input_box_height = input_lines + 2  # borders
        else:
            input_box_height = 3  # status indicator

        # Autocomplete dropdown
        autocomplete_height = 0
        if show_input and snapshot.autocomplete_active:
            autocomplete_height = min(8, len(snapshot.autocomplete_suggestions)) + 2

        # Build header first so we know its real height
        header_lines = self._build_header(snapshot, width, "")
        header_height = len(header_lines)

        # Spacer between header and content
        spacer_height = 1

        # Available height for conversation (viewport between header and input/footer)
        content_height = height - header_height - spacer_height - input_box_height - autocomplete_height
        if content_height < 1:
            content_height = 1

        # Build history lines limited to content_height
        history_lines, total_history_lines = self._build_history_lines(
            snapshot, width, content_height
        )

        # Clamp scroll offset
        max_scroll = max(0, total_history_lines - content_height)
        if snapshot.scroll_offset > max_scroll:
            self._state.clamp_scroll(max_scroll)

        # Build scroll info
        scroll_info = ""
        if total_history_lines > content_height:
            if snapshot.scroll_offset > 0:
                scroll_info = f"Scroll: {snapshot.scroll_offset} lines up"
            else:
                scroll_info = "At bottom"
        # Rebuild header to include scroll info now that we have it
        header_lines = self._build_header(snapshot, width, scroll_info)
        header_height = len(header_lines)

        # Start rendering
        buffer.write(ANSI.HIDE_CURSOR)
        buffer.write(ANSI.CLEAR_SCREEN)
        buffer.write(ANSI.move_to(1, 1))

        # Header
        current_row = 1
        for line in header_lines:
            buffer.write(ANSI.move_to(current_row, 1))
            buffer.write(line)
            current_row += 1

        # Spacer
        buffer.write(ANSI.move_to(current_row, 1))
        buffer.write(ANSI.CLEAR_LINE)
        current_row += spacer_height

        # Content (conversation)
        content_start_row = current_row
        for line in history_lines:
            buffer.write(ANSI.move_to(current_row, 1))
            buffer.write(line)
            current_row += 1

        # Fill remaining conversation area
        while current_row < content_start_row + content_height:
            buffer.write(ANSI.move_to(current_row, 1))
            buffer.write(ANSI.CLEAR_LINE)
            current_row += 1

        # Determine footer (input/status) start anchored to bottom
        footer_start_row = height - (input_box_height + autocomplete_height) + 1
        if footer_start_row < current_row:
            footer_start_row = current_row

        # Clear any space between content and footer to avoid artifacts
        fill_row = current_row
        while fill_row < footer_start_row:
            buffer.write(ANSI.move_to(fill_row, 1))
            buffer.write(ANSI.CLEAR_LINE)
            fill_row += 1

        # Input box or status indicator anchored at bottom
        if show_input:
            cursor_row, cursor_col = self._build_input_box(
                buffer, footer_start_row, width, snapshot
            )

            # Autocomplete dropdown directly under input box
            if snapshot.autocomplete_active:
                self._build_autocomplete(
                    buffer, footer_start_row + input_box_height, width, snapshot
                )
        else:
            cursor_row, cursor_col = self._build_status_indicator(
                buffer, footer_start_row, width, snapshot
            )

        # Position cursor and show it
        buffer.write(ANSI.move_to(cursor_row, cursor_col))
        buffer.write(ANSI.SHOW_CURSOR)

        return buffer.getvalue()

    def _color(self, text: str, color: str) -> str:
        """Apply color if colors are supported."""
        if self._use_colors:
            return f"{color}{text}{ANSI.RESET}"
        return text

    def _build_header(
        self,
        snapshot: "StateSnapshot",
        width: int,
        scroll_info: str,
    ) -> List[str]:
        """Build header lines."""
        lines: List[str] = []

        title = "Voice Agent - Robust TUI"
        lines.append("")
        lines.append(self._color(title.center(width), ANSI.BRIGHT_CYAN + ANSI.BOLD))

        # Show progress message in header if available during SENDING/STREAMING
        if snapshot.progress_message:
            status_text = f"Status: {snapshot.progress_message}"
        else:
            status_text = f"Status: {snapshot.status_message}"
        if snapshot.compact_mode:
            status_text += " | Compact: ON"
        if snapshot.voice_mode:
            status_text += " | Mode: VOICE"

        meta = f"Requests: {snapshot.request_count}"
        if scroll_info:
            meta += f" | {scroll_info}"

        lines.append("")
        lines.append(self._color(f"{status_text} | {meta}", ANSI.DIM))
        lines.append(self._color("─" * width, ANSI.BRIGHT_BLACK))

        return lines

    def _build_history_lines(
        self,
        snapshot: "StateSnapshot",
        width: int,
        max_lines: int,
    ) -> Tuple[List[str], int]:
        """Build conversation history lines with scrolling.

        Returns: (visible_lines, total_lines)
        """
        all_lines: List[str] = []

        for entry in snapshot.conversation:
            all_lines.extend(self._format_entry(entry, width))

        # Add streaming response if active
        if snapshot.streaming_text:
            streaming_entry_lines = self._format_streaming(
                snapshot.streaming_text + snapshot.streaming_cursor,
                width,
            )
            all_lines.extend(streaming_entry_lines)

        # Remove trailing spacer
        if all_lines and not all_lines[-1].strip():
            all_lines.pop()

        total_lines = len(all_lines)

        # Apply scrolling
        if total_lines > max_lines:
            end_idx = total_lines - snapshot.scroll_offset
            start_idx = max(0, end_idx - max_lines)
            display_lines = all_lines[start_idx:end_idx]
        else:
            display_lines = all_lines

        return display_lines, total_lines

    def _format_entry(self, entry, width: int) -> List[str]:
        """Format a conversation entry into display lines."""
        from tui.tui_state import ConversationEntry

        role = entry.role
        text = entry.text or "(empty)"
        if entry.meta:
            text = f"{text}\n\n{entry.meta}"

        titles = {
            "user": "You",
            "agent": "Agent",
            "system": "System",
            "status": "Status",
        }
        colors = {
            "user": ANSI.BRIGHT_GREEN,
            "agent": ANSI.BRIGHT_BLUE,
            "system": ANSI.BRIGHT_MAGENTA,
            "status": ANSI.BRIGHT_YELLOW,
        }

        box = self._draw_box(text, width, title=titles.get(role, role.title()))
        color = colors.get(role)

        if color:
            lines = [self._color(line, color) for line in box.splitlines()]
        else:
            lines = box.splitlines()

        lines.append("")  # Spacer
        return lines

    def _format_streaming(self, text: str, width: int) -> List[str]:
        """Format streaming response with cursor."""
        box = self._draw_box(text, width, title="Agent")
        lines = [self._color(line, ANSI.BRIGHT_BLUE) for line in box.splitlines()]
        lines.append("")
        return lines

    def _draw_box(self, text: str, width: int, title: str = "") -> str:
        """Draw a box around text."""
        width = max(20, width)

        top_left, top_right = "╭", "╮"
        bottom_left, bottom_right = "╰", "╯"
        horizontal, vertical = "─", "│"

        lines: List[str] = []

        # Top border
        if title:
            title_text = f" {title} "
            left_border = horizontal * 2
            available = max(0, (width - 2) - len(left_border) - len(title_text))
            right_border = horizontal * available
            lines.append(f"{top_left}{left_border}{title_text}{right_border}{top_right}")
        else:
            lines.append(f"{top_left}{horizontal * (width - 2)}{top_right}")

        # Content with wrapping
        max_content_width = width - 4
        for raw_line in text.split("\n"):
            if len(raw_line) <= max_content_width:
                padding = max(0, max_content_width - len(raw_line))
                lines.append(f"{vertical} {raw_line}{' ' * padding} {vertical}")
            else:
                wrapped = textwrap.wrap(
                    raw_line,
                    width=max_content_width,
                    break_long_words=True,
                    break_on_hyphens=False,
                )
                if not wrapped:
                    lines.append(f"{vertical} {' ' * max_content_width} {vertical}")
                else:
                    for wrapped_line in wrapped:
                        padding = max(0, max_content_width - len(wrapped_line))
                        lines.append(f"{vertical} {wrapped_line}{' ' * padding} {vertical}")

        # Bottom border
        lines.append(f"{bottom_left}{horizontal * (width - 2)}{bottom_right}")
        return "\n".join(lines)

    def _build_input_box(
        self,
        buffer: io.StringIO,
        start_row: int,
        width: int,
        snapshot: "StateSnapshot",
    ) -> Tuple[int, int]:
        """Build input box. Returns (cursor_row, cursor_col)."""
        prompt = "> "
        content = prompt + snapshot.input_buffer
        content_lines = max(1, (len(content) + width - 1) // width)

        # Top border
        buffer.write(ANSI.move_to(start_row, 1))
        buffer.write(self._color("─" * width, ANSI.BRIGHT_GREEN))

        # Content line(s)
        content_row = start_row + 1
        for line_idx in range(content_lines):
            buffer.write(ANSI.move_to(content_row + line_idx, 1))
            start_char = line_idx * width
            end_char = start_char + width
            line_content = content[start_char:end_char]
            padded = line_content + " " * (width - len(line_content))
            buffer.write(self._color(padded, ANSI.GREEN))

        # Bottom border
        bottom_row = content_row + content_lines
        buffer.write(ANSI.move_to(bottom_row, 1))
        buffer.write(self._color("─" * width, ANSI.BRIGHT_GREEN))

        # Calculate cursor position
        cursor_content_pos = len(prompt) + snapshot.cursor_pos
        cursor_line_offset = cursor_content_pos // width
        cursor_col = (cursor_content_pos % width) + 1

        cursor_row = content_row + cursor_line_offset

        return cursor_row, cursor_col

    def _build_status_indicator(
        self,
        buffer: io.StringIO,
        start_row: int,
        width: int,
        snapshot: "StateSnapshot",
    ) -> Tuple[int, int]:
        """Build status indicator when input is disabled. Returns (cursor_row, cursor_col)."""
        from tui.tui_state import TUIState

        # Status icons based on state
        icons = {
            TUIState.RECORDING: ("🎤", ANSI.BRIGHT_RED),
            TUIState.TRANSCRIBING: ("✍️ ", ANSI.BRIGHT_YELLOW),
            TUIState.SENDING: ("⏳", ANSI.BRIGHT_CYAN),
            TUIState.STREAMING: ("📥", ANSI.BRIGHT_BLUE),
            TUIState.ERROR: ("❌", ANSI.BRIGHT_RED),
        }
        icon, color = icons.get(snapshot.state, ("●", ANSI.BRIGHT_YELLOW))

        # Show progress message if available, otherwise fall back to status message
        if snapshot.progress_message:
            display_status = snapshot.progress_message
        else:
            display_status = snapshot.status_message or "Please wait..."

        # Top border
        buffer.write(ANSI.move_to(start_row, 1))
        buffer.write(self._color("─" * width, ANSI.BRIGHT_BLACK))

        # Status content
        content_row = start_row + 1
        buffer.write(ANSI.move_to(content_row, 1))
        status_line = f"  {icon}  {display_status}"
        padded = status_line + " " * max(0, width - len(status_line) - 1)
        buffer.write(self._color(padded[:width], color + ANSI.BOLD))

        # Bottom border
        bottom_row = content_row + 1
        buffer.write(ANSI.move_to(bottom_row, 1))
        buffer.write(self._color("─" * width, ANSI.BRIGHT_BLACK))

        return content_row, min(len(status_line) + 1, width)

    def _build_autocomplete(
        self,
        buffer: io.StringIO,
        start_row: int,
        width: int,
        snapshot: "StateSnapshot",
    ):
        """Build autocomplete dropdown."""
        suggestions = snapshot.autocomplete_suggestions
        selected = snapshot.autocomplete_selected

        if not suggestions:
            return

        max_display = min(8, len(suggestions))
        dropdown_width = min(60, width - 4)

        current_row = start_row

        # Top border
        buffer.write(ANSI.move_to(current_row, 1))
        buffer.write(self._color(f"╭{'─' * (dropdown_width - 2)}╮", ANSI.BRIGHT_BLACK))
        current_row += 1

        # Suggestions
        for i, suggestion in enumerate(suggestions[:max_display]):
            buffer.write(ANSI.move_to(current_row, 1))

            display_text = suggestion
            if len(display_text) > dropdown_width - 4:
                display_text = "..." + display_text[-(dropdown_width - 7):]

            if i == selected:
                inner = f" {display_text:<{dropdown_width - 4}} "
                buffer.write(
                    self._color("│", ANSI.BRIGHT_BLACK)
                    + self._color(inner, ANSI.BG_GREEN + ANSI.BOLD)
                    + self._color("│", ANSI.BRIGHT_BLACK)
                )
            else:
                inner = f" {display_text:<{dropdown_width - 4}} "
                buffer.write(
                    self._color("│", ANSI.BRIGHT_BLACK)
                    + inner
                    + self._color("│", ANSI.BRIGHT_BLACK)
                )
            current_row += 1

        # Bottom border
        buffer.write(ANSI.move_to(current_row, 1))
        buffer.write(self._color(f"╰{'─' * (dropdown_width - 2)}╯", ANSI.BRIGHT_BLACK))
