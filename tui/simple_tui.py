"""Simple, lightweight TUI for the voice agent with robust input handling.

This version uses a unified rendering approach where SimpleTUI owns all screen
rendering, including the input box. The input handler only manages state.
All rendering uses absolute cursor positioning to avoid coordinate mismatches.
"""

from __future__ import annotations

import os
import sys
import time
import logging
import threading
import shutil
import textwrap
from typing import Any, Dict, List, Optional, Tuple
from queue import Empty

# Add src to path
PROJECT_ROOT = os.path.dirname(os.path.abspath(os.path.join(__file__, "..")))
SRC_DIR = os.path.join(PROJECT_ROOT, "src")
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

from app_config import AppConfig, load_app_config
from communication import EventBus, Mailbox
from communication.events import (
    EventType,
    TranscriptionCompleteEvent,
    AgentResponseCompleteEvent,
    TTSRequestedEvent,
    StreamingChunkEvent,
)
from tui.autocomplete import FileCache
from tui.input_handler import RawTerminal, InputState
from tui.logging_config import configure_tui_logging, get_tui_log_dir


# ANSI escape codes for terminal control
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


class SimpleTUI:
    """Lightweight TUI that integrates with backend event bus.

    This class owns ALL rendering - the input handler only manages state.
    All rendering uses absolute cursor positioning for correctness.
    """

    def __init__(self, config: AppConfig):
        self.config = config
        self.running = False
        self.request_count = 0
        self.logger = logging.getLogger(__name__)

        # Status tracking
        self.status = "Ready"
        self.current_request_id: Optional[str] = None
        self.last_response = ""

        # Event bus integration
        self.event_bus: Optional[EventBus] = None
        self.response_mailbox: Optional[Mailbox] = None
        self.tts_mailbox: Optional[Mailbox] = None
        self.streaming_mailbox: Optional[Mailbox] = None
        self.transcription_mailbox: Optional[Mailbox] = None

        # Streaming state
        self._streaming_response = ""
        self._streaming_request_id: Optional[str] = None
        self._streaming_entry: Optional[Dict[str, str]] = None
        self._last_finalized_request_id: Optional[str] = None

        # Conversation display
        self._conversation: List[Dict[str, str]] = []
        self._conversation_lock = threading.Lock()
        self._status_stack: List[Dict[str, str]] = []
        self._response_event = threading.Event()

        # UI settings
        self.compact = False
        self.use_colors = ANSI.supports_color()
        self.scroll_offset = 0
        self.voice_mode = False

        # Voice/PTT support
        self.recording_event: Optional[threading.Event] = None
        self.ptt_worker_process: Optional[Any] = None
        self.is_recording = False

        # File autocomplete and input state
        self.file_cache = FileCache(PROJECT_ROOT)
        self.input_state = InputState(self.file_cache)

        # Render lock to prevent concurrent screen updates
        self._render_lock = threading.Lock()

    # ------------------------------------------------------------------ Colors
    def _color(self, text: str, color: str) -> str:
        """Apply color to text if colors are supported."""
        if self.use_colors:
            return f"{color}{text}{ANSI.RESET}"
        return text

    # --------------------------------------------------------- Conversation mgmt
    def _add_message(self, role: str, text: str, pending: bool = False) -> Dict[str, str]:
        """Append a conversation entry that will be rendered on refresh."""
        entry = {
            "role": role,
            "text": text.strip("\n") if text else "",
            "pending": "1" if pending else "0",
            "ts": f"{time.time():.6f}",
        }
        with self._conversation_lock:
            self._conversation.append(entry)
        # Auto-scroll to bottom when new message arrives
        if self.scroll_offset == 0 or role in ["agent", "user"]:
            self.scroll_offset = 0
        return entry

    def _push_status(self, text: str):
        """Push a temporary status entry that can later be removed."""
        entry = self._add_message("status", text, pending=True)
        self._status_stack.append(entry)

    def _pop_status(self):
        """Remove the most recent temporary status entry if it exists."""
        if not self._status_stack:
            return
        entry = self._status_stack.pop()
        with self._conversation_lock:
            try:
                self._conversation.remove(entry)
            except ValueError:
                pass

    # --------------------------------------------------------- Screen rendering
    def _write(self, text: str) -> None:
        """Write text to stdout."""
        sys.stdout.write(text)

    def _flush(self) -> None:
        """Flush stdout."""
        sys.stdout.flush()

    def _render_full_screen(
        self,
        show_input_box: bool = True,
        status_message: str = "",
    ) -> Tuple[int, int]:
        """Render the entire screen from scratch using absolute positioning.

        Returns (cursor_row, cursor_col) where cursor should be placed.
        All positions are 1-indexed for ANSI compatibility.
        """
        with self._render_lock:
            width, height = get_terminal_size()
            width = max(40, width)
            height = max(10, height)

            # Calculate layout
            header_height = 5

            # Calculate input box height (may span multiple lines)
            prompt = "> "
            if show_input_box:
                input_text = self.input_state.get_text()
                input_content = prompt + input_text
                input_content_lines = max(1, (len(input_content) + width - 1) // width)
                input_box_height = input_content_lines + 2  # +2 for borders
            else:
                # Status indicator takes 3 lines (top border, content, bottom border)
                input_box_height = 3
                input_content_lines = 0

            # Autocomplete dropdown height
            autocomplete_height = 0
            if show_input_box and self.input_state.autocomplete_active:
                autocomplete_height = min(8, len(self.input_state.autocomplete_suggestions)) + 2

            # Available height for conversation history
            content_height = max(1, height - header_height - input_box_height - autocomplete_height)

            # Build scroll info
            scroll_info = ""
            history_lines, total_history_lines, _ = self._build_history_lines(width, content_height)
            if total_history_lines > content_height:
                if self.scroll_offset > 0:
                    scroll_info = f"Scroll: {self.scroll_offset} lines up"
                else:
                    scroll_info = "At bottom"

            # Start rendering - hide cursor, clear entire screen, move to top-left
            self._write(ANSI.HIDE_CURSOR)
            self._write(ANSI.CLEAR_SCREEN)  # Clear entire screen first
            self._write(ANSI.move_to(1, 1))  # Then move to top-left

            current_row = 1

            # Render header
            header_lines = self._build_header_lines(width, scroll_info, status_message)
            for line in header_lines:
                self._write(ANSI.move_to(current_row, 1))
                # Truncate line to width (accounting for ANSI codes is tricky, so just write it)
                self._write(line)
                current_row += 1

            # Blank line after header
            self._write(ANSI.move_to(current_row, 1))
            current_row += 1

            # Render history
            for line in history_lines:
                self._write(ANSI.move_to(current_row, 1))
                self._write(line)
                current_row += 1

            # Fill remaining content area with blanks
            while current_row <= header_height + content_height:
                self._write(ANSI.move_to(current_row, 1))
                self._write(ANSI.CLEAR_LINE)
                current_row += 1

            # Render input box or status indicator
            if show_input_box:
                cursor_row, cursor_col = self._render_input_box(
                    current_row, width, prompt, input_content_lines
                )
                current_row += input_box_height

                # Render autocomplete dropdown
                if self.input_state.autocomplete_active:
                    self._render_autocomplete(current_row, width)
            else:
                # No input box - show status indicator instead
                cursor_row, cursor_col = self._render_status_indicator(
                    current_row, width, status_message
                )

            # Position cursor and show it
            self._write(ANSI.move_to(cursor_row, cursor_col))
            self._write(ANSI.SHOW_CURSOR)
            self._flush()

            return cursor_row, cursor_col

    def _build_header_lines(
        self, width: int, scroll_info: str = "", status_message: str = ""
    ) -> List[str]:
        """Build header lines."""
        lines: List[str] = []

        title = "Voice Agent - Text Interface"
        lines.append("")
        lines.append(self._color(title.center(width), ANSI.BRIGHT_CYAN + ANSI.BOLD))

        status_text = f"Status: {status_message or self.status}"
        if self.compact:
            status_text += " | Compact: ON"
        if self.voice_mode:
            status_text += " | Mode: VOICE"

        meta = f"Requests: {self.request_count}"
        if scroll_info:
            meta += f" | {scroll_info}"

        lines.append("")
        lines.append(self._color(f"{status_text} | {meta}", ANSI.DIM))
        lines.append(self._color("─" * width, ANSI.BRIGHT_BLACK))

        return lines

    def _build_history_lines(self, width: int, max_lines: int) -> Tuple[List[str], int, int]:
        """Build conversation history lines with scrolling support.

        Returns: (visible_lines, total_lines, current_offset)
        """
        with self._conversation_lock:
            entries = list(self._conversation)

        all_lines: List[str] = []
        for entry in entries:
            all_lines.extend(self._format_entry(entry, width))

        # Remove trailing spacer
        if all_lines and not all_lines[-1].strip():
            all_lines.pop()

        total_lines = len(all_lines)

        # Clamp scroll offset
        max_scroll = max(0, total_lines - max_lines)
        self.scroll_offset = max(0, min(self.scroll_offset, max_scroll))

        # Apply scrolling
        if total_lines > max_lines:
            end_idx = total_lines - self.scroll_offset
            start_idx = max(0, end_idx - max_lines)
            display_lines = all_lines[start_idx:end_idx]
        else:
            display_lines = all_lines

        return display_lines, total_lines, self.scroll_offset

    def _format_entry(self, entry: Dict[str, str], width: int) -> List[str]:
        """Format a conversation entry into display lines."""
        role = entry["role"]
        text = entry["text"] or "(empty)"

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
                    # Empty after wrap (e.g., all whitespace)
                    lines.append(f"{vertical} {' ' * max_content_width} {vertical}")
                else:
                    for wrapped_line in wrapped:
                        padding = max(0, max_content_width - len(wrapped_line))
                        lines.append(f"{vertical} {wrapped_line}{' ' * padding} {vertical}")

        # Bottom border
        lines.append(f"{bottom_left}{horizontal * (width - 2)}{bottom_right}")
        return "\n".join(lines)

    def _render_input_box(
        self, start_row: int, width: int, prompt: str, content_lines: int
    ) -> Tuple[int, int]:
        """Render the input box at a specific row.

        Returns (cursor_row, cursor_col) for where the text cursor should be.
        """
        input_text = self.input_state.get_text()
        cursor_pos = self.input_state.cursor_pos

        # Top border
        self._write(ANSI.move_to(start_row, 1))
        top_border = "─" * width
        self._write(self._color(top_border, ANSI.BRIGHT_GREEN))

        # Content line(s)
        content = prompt + input_text
        content_row = start_row + 1

        # Render content with proper line wrapping
        for line_idx in range(content_lines):
            self._write(ANSI.move_to(content_row + line_idx, 1))
            start_char = line_idx * width
            end_char = start_char + width
            line_content = content[start_char:end_char]
            # Pad to full width to clear any previous content
            padded = line_content + " " * (width - len(line_content))
            self._write(self._color(padded, ANSI.GREEN))

        # Bottom border
        bottom_row = content_row + content_lines
        self._write(ANSI.move_to(bottom_row, 1))
        bottom_border = "─" * width
        self._write(self._color(bottom_border, ANSI.BRIGHT_GREEN))

        # Calculate cursor position within the input
        cursor_content_pos = len(prompt) + cursor_pos
        cursor_line_offset = cursor_content_pos // width
        cursor_col = (cursor_content_pos % width) + 1  # +1 for 1-indexed

        cursor_row = content_row + cursor_line_offset

        return cursor_row, cursor_col

    def _render_status_indicator(
        self, start_row: int, width: int, status_message: str
    ) -> Tuple[int, int]:
        """Render a status indicator box when input is disabled.

        Shows visual feedback during processing/waiting states.
        Returns (cursor_row, cursor_col) for cursor placement.
        """
        # Status indicator icons based on state
        if "Recording" in status_message:
            icon = "🎤"
            color = ANSI.BRIGHT_RED
        elif "Transcribing" in status_message:
            icon = "✍️ "
            color = ANSI.BRIGHT_YELLOW
        elif "Processing" in status_message or "Sending" in status_message:
            icon = "⏳"
            color = ANSI.BRIGHT_CYAN
        elif "Receiving" in status_message:
            icon = "📥"
            color = ANSI.BRIGHT_BLUE
        elif "Ready" in status_message:
            icon = "✓"
            color = ANSI.BRIGHT_GREEN
        else:
            icon = "●"
            color = ANSI.BRIGHT_YELLOW

        display_status = status_message or "Please wait..."

        # Top border
        self._write(ANSI.move_to(start_row, 1))
        top_border = "─" * width
        self._write(self._color(top_border, ANSI.BRIGHT_BLACK))

        # Status content line
        content_row = start_row + 1
        self._write(ANSI.move_to(content_row, 1))
        status_line = f"  {icon}  {display_status}"
        # Pad to full width
        padded = status_line + " " * max(0, width - len(status_line) - 1)
        self._write(self._color(padded[:width], color + ANSI.BOLD))

        # Bottom border
        bottom_row = content_row + 1
        self._write(ANSI.move_to(bottom_row, 1))
        bottom_border = "─" * width
        self._write(self._color(bottom_border, ANSI.BRIGHT_BLACK))

        # Position cursor at end of status line (hidden but valid position)
        cursor_row = content_row
        cursor_col = min(len(status_line) + 1, width)

        return cursor_row, cursor_col

    def _render_autocomplete(self, start_row: int, width: int) -> None:
        """Render autocomplete dropdown at a specific row."""
        suggestions = self.input_state.autocomplete_suggestions
        selected = self.input_state.autocomplete_selected

        if not suggestions:
            return

        max_display = min(8, len(suggestions))
        dropdown_width = min(60, width - 4)

        current_row = start_row

        # Top border
        self._write(ANSI.move_to(current_row, 1))
        self._write(self._color(f"╭{'─' * (dropdown_width - 2)}╮", ANSI.BRIGHT_BLACK))
        current_row += 1

        # Suggestions
        for i, suggestion in enumerate(suggestions[:max_display]):
            self._write(ANSI.move_to(current_row, 1))

            display_text = suggestion
            if len(display_text) > dropdown_width - 4:
                display_text = "..." + display_text[-(dropdown_width - 7):]

            if i == selected:
                # Highlighted
                inner = f" {display_text:<{dropdown_width - 4}} "
                self._write(
                    self._color("│", ANSI.BRIGHT_BLACK)
                    + self._color(inner, ANSI.BG_GREEN + ANSI.BOLD)
                    + self._color("│", ANSI.BRIGHT_BLACK)
                )
            else:
                inner = f" {display_text:<{dropdown_width - 4}} "
                self._write(
                    self._color("│", ANSI.BRIGHT_BLACK)
                    + inner
                    + self._color("│", ANSI.BRIGHT_BLACK)
                )
            current_row += 1

        # Bottom border
        self._write(ANSI.move_to(current_row, 1))
        self._write(self._color(f"╰{'─' * (dropdown_width - 2)}╯", ANSI.BRIGHT_BLACK))

    # ---------------------------------------------------------------- Input loop
    def _get_input(self) -> str:
        """Get user input with full-screen rendering.

        SimpleTUI owns all rendering. The input loop reads characters and
        updates InputState, then re-renders the full screen.
        """
        # In voice mode, use voice input handler
        if self.voice_mode:
            return self._get_voice_input()

        # Reset input state for new session
        self.input_state.reset()

        # Initial render with input box
        self._render_full_screen(show_input_box=True)

        with RawTerminal() as term:
            while True:
                char = term.read_char()

                # Enter - submit or accept autocomplete
                if char in ("\r", "\n"):
                    if self.input_state.autocomplete_active:
                        if self.input_state.accept_suggestion():
                            self._render_full_screen(show_input_box=True)
                            continue
                    # Submit
                    break

                # Escape sequences (arrow keys, etc.)
                elif char == "\x1b":
                    seq = term.read_escape_sequence()

                    if seq == "[A":  # Up arrow
                        self.input_state.select_prev_suggestion()
                    elif seq == "[B":  # Down arrow
                        self.input_state.select_next_suggestion()
                    elif seq == "[D":  # Left arrow
                        self.input_state.move_left()
                    elif seq == "[C":  # Right arrow
                        self.input_state.move_right()
                    elif seq == "[H":  # Home
                        self.input_state.move_to_start()
                    elif seq == "[F":  # End
                        self.input_state.move_to_end()
                    elif seq == "[3":  # Delete key (needs one more char)
                        extra = term.read_char()
                        if extra == "~":
                            self.input_state.delete()
                    else:
                        # Unknown escape - dismiss autocomplete
                        self.input_state.dismiss_autocomplete()

                    self._render_full_screen(show_input_box=True)

                # Backspace
                elif char == "\x7f":
                    self.input_state.backspace()
                    self._render_full_screen(show_input_box=True)

                # Ctrl+C
                elif char == "\x03":
                    raise KeyboardInterrupt

                # Ctrl+D (EOF on empty line)
                elif char == "\x04":
                    if len(self.input_state.buffer) == 0:
                        raise EOFError

                # Ctrl+A (start of line)
                elif char == "\x01":
                    self.input_state.move_to_start()
                    self._render_full_screen(show_input_box=True)

                # Ctrl+E (end of line)
                elif char == "\x05":
                    self.input_state.move_to_end()
                    self._render_full_screen(show_input_box=True)

                # Ctrl+U (clear line)
                elif char == "\x15":
                    self.input_state.clear_line()
                    self._render_full_screen(show_input_box=True)

                # Ctrl+W (delete word)
                elif char == "\x17":
                    self.input_state.delete_word_back()
                    self._render_full_screen(show_input_box=True)

                # Tab - accept autocomplete
                elif char == "\t":
                    if self.input_state.autocomplete_active:
                        self.input_state.accept_suggestion()
                    self._render_full_screen(show_input_box=True)

                # Regular printable character
                elif char >= " ":
                    self.input_state.insert_char(char)
                    self._render_full_screen(show_input_box=True)

        # Return the input text (subsequent _render_full_screen() handles cursor)
        return self.input_state.get_text().strip()

    def _get_voice_input(self) -> Optional[str]:
        """Handle voice (push-to-talk) input.

        Flow:
        1. Display voice mode prompt with input buffer
        2. Wait for SPACE press to start recording (only when buffer is empty)
        3. While SPACE is held, record audio (block ALL other keys)
        4. When SPACE is released, stop recording and wait for transcription
        5. Put transcribed text in input buffer for user to edit/confirm
        6. Return the final text when user presses ENTER

        Returns:
            - str: The text to send (either typed or transcribed+edited)
            - "": Empty string if no input
        """
        import termios
        import tty
        import select
        from queue import Empty

        # Reset input state to ensure clean slate (prevents text mode state from interfering)
        self.input_state.reset()

        def render_voice_box(status_text: str = ""):
            """Render the voice input box with current buffer."""
            prompt = "Hold SPACE to talk, type /quit to exit voice mode"
            buffer_text = self.input_state.get_text()

            # Re-render full screen (header + history) then overlay voice box
            base_status = status_text or self.status or "Voice Mode"
            self._render_full_screen(show_input_box=False, status_message=base_status)

            width, height = get_terminal_size()

            dropdown_height = 0
            if self.input_state.autocomplete_active:
                dropdown_height = min(8, len(self.input_state.autocomplete_suggestions)) + 2

            content = " > " + buffer_text
            content_lines = max(1, (len(content) + width - 1) // width)

            box_height = content_lines + 3  # top border + prompt + content + bottom
            box_row = max(1, height - dropdown_height - box_height + 1)

            self._write(ANSI.move_to(box_row, 1))
            self._write(self._color("─" * width, ANSI.BRIGHT_GREEN))

            self._write(ANSI.move_to(box_row + 1, 1))
            if status_text:
                display_prompt = f" {status_text}"
            else:
                display_prompt = f" {prompt}"
            display_prompt = display_prompt + " " * max(0, width - len(display_prompt))
            color = ANSI.BRIGHT_RED + ANSI.BOLD if status_text else ANSI.GREEN
            self._write(self._color(display_prompt[:width], color))

            self._write(ANSI.move_to(box_row + 2, 1))
            for line_idx in range(content_lines):
                start = line_idx * width
                end = start + width
                line = content[start:end]
                line = line + " " * max(0, width - len(line))
                self._write(self._color(line[:width], ANSI.GREEN))
                if line_idx < content_lines - 1:
                    self._write(ANSI.move_to(box_row + 2 + line_idx + 1, 1))

            bottom_row = box_row + 2 + content_lines
            self._write(ANSI.move_to(bottom_row, 1))
            self._write(self._color("─" * width, ANSI.BRIGHT_GREEN))

            # Render autocomplete dropdown (reuse text-mode renderer)
            dropdown_row = bottom_row + 1
            if self.input_state.autocomplete_active:
                dropdown_height = min(8, len(self.input_state.autocomplete_suggestions)) + 2
                dropdown_row = min(dropdown_row, max(1, height - dropdown_height + 1))
                self._render_autocomplete(dropdown_row, width)

            # Position cursor in input area
            cursor_content_pos = 3 + self.input_state.cursor_pos  # " > " prefix
            cursor_row = box_row + 2 + (cursor_content_pos // width)
            cursor_col = (cursor_content_pos % width) + 1
            self._write(ANSI.move_to(cursor_row, cursor_col))
            self._write(ANSI.SHOW_CURSOR)
            self._flush()

        # Initial render
        self._render_full_screen(show_input_box=False, status_message="Voice Mode")
        render_voice_box()

        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)

        try:
            tty.setraw(fd)

            while self.running:
                # ALWAYS check for transcription events first, before keyboard input
                # This ensures transcription results are processed even if user presses Enter quickly
                if self.transcription_mailbox:
                    try:
                        event = self.transcription_mailbox.receive(timeout=0.01)
                        if event and isinstance(event, TranscriptionCompleteEvent):
                            if event.request_id and event.request_id.startswith("ptt_"):
                                if event.text:
                                    # Put transcribed text into buffer
                                    self.input_state.buffer = list(event.text)
                                    self.input_state.cursor_pos = len(event.text)
                                    self.input_state._update_autocomplete()
                                    self.input_state._dirty = True
                                    self.status = "Ready"
                                    render_voice_box()
                                else:
                                    render_voice_box("[Voice unclear - try again]")
                                    time.sleep(1.0)
                                    render_voice_box()
                            # Consume non-ptt events (e.g., "tui_" events from previous sends)
                            # so they don't pile up in the mailbox
                    except Empty:
                        pass

                # Use select with timeout to check for keyboard input
                ready, _, _ = select.select([fd], [], [], 0.1)

                if not ready:
                    # No keyboard input - just continue the loop
                    continue

                char = sys.stdin.read(1)

                # SPACE key for PTT (only if buffer is empty)
                if char == " " and not self.input_state.buffer:
                    if self.recording_event:
                        # === START RECORDING ===
                        self.is_recording = True
                        self.recording_event.set()
                        self.status = "Recording..."
                        render_voice_box("[RECORDING...] Release SPACE to stop")

                        # === RECORDING LOOP: Block ALL keys except monitor for SPACE release ===
                        # Key release detection: count consecutive timeouts
                        # Key repeat typically fires every 30-50ms, so 3x 40ms timeouts = ~120ms of silence = released
                        consecutive_timeouts = 0
                        RELEASE_THRESHOLD = 3  # Number of consecutive timeouts to detect release

                        while self.running:
                            ready, _, _ = select.select([fd], [], [], 0.04)  # 40ms timeout
                            if ready:
                                # Key pressed - read and discard (block all keys during recording)
                                next_char = sys.stdin.read(1)
                                if next_char == " ":
                                    # SPACE repeat - still held, reset timeout counter
                                    consecutive_timeouts = 0
                                # Any other key is ignored (blocked during recording)
                            else:
                                # Timeout - no key activity
                                consecutive_timeouts += 1
                                if consecutive_timeouts >= RELEASE_THRESHOLD:
                                    # SPACE was released (no input for ~120ms)
                                    break

                        # === STOP RECORDING ===
                        self.recording_event.clear()
                        self.is_recording = False
                        self.status = "Transcribing..."
                        render_voice_box("[Transcribing...]")

                        # Don't return - stay in the loop and wait for transcription event
                        # The transcription will arrive via event bus and be caught above
                        continue

                # Ignore SPACE if buffer has content (treat as regular space char below)
                # This prevents accidental PTT when editing transcription

                # Enter key - submit buffer
                if char == "\r" or char == "\n":
                    if self.input_state.autocomplete_active:
                        # When dropdown is open, Enter only accepts the suggestion (never submit)
                        if self.input_state.accept_suggestion():
                            render_voice_box()
                        else:
                            # Keep dropdown open; don't submit while it's visible
                            render_voice_box()
                        continue
                    return self.input_state.get_text()

                # Escape sequences (arrows/home/end)
                elif char == "\x1b":
                    seq = sys.stdin.read(2)
                    if seq == "[A":  # Up
                        self.input_state.select_prev_suggestion()
                    elif seq == "[B":  # Down
                        self.input_state.select_next_suggestion()
                    elif seq == "[D":  # Left
                        self.input_state.move_left()
                    elif seq == "[C":  # Right
                        self.input_state.move_right()
                    elif seq == "[H":  # Home
                        self.input_state.move_to_start()
                    elif seq == "[F":  # End
                        self.input_state.move_to_end()
                    else:
                        self.input_state.dismiss_autocomplete()
                    render_voice_box()

                # Backspace
                elif char == "\x7f":
                    if self.input_state.backspace():
                        render_voice_box()

                # Ctrl+C
                elif char == "\x03":
                    raise KeyboardInterrupt

                # Ctrl+D
                elif char == "\x04":
                    if not self.input_state.buffer:
                        raise EOFError

                # Ctrl+U (clear line)
                elif char == "\x15":
                    self.input_state.clear_line()
                    render_voice_box()

                # Regular printable character (including SPACE when buffer has content)
                elif char >= " ":
                    if char == "\t":
                        # Tab should only accept suggestion; never insert literal tab
                        if self.input_state.autocomplete_active and self.input_state.accept_suggestion():
                            render_voice_box()
                            continue
                        # If dropdown isn't active, ignore tab (no-op) to avoid messing layout
                        continue
                    else:
                        self.input_state.insert_char(char)
                    render_voice_box()

        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)

        return ""

    # ---------------------------------------------------------- Backend wiring
    def _setup_event_bus(self):
        """Setup event bus and mailboxes for backend integration."""
        from multiprocessing import Queue as MPQueue

        self.event_bus = EventBus()

        self.response_mailbox = Mailbox("tui_responses", MPQueue())
        self.response_mailbox.subscribe_to(self.event_bus, EventType.AGENT_RESPONSE_COMPLETE)

        self.tts_mailbox = Mailbox("tui_tts", MPQueue())
        self.tts_mailbox.subscribe_to(self.event_bus, EventType.TTS_REQUESTED)

        self.streaming_mailbox = Mailbox("tui_streaming", MPQueue())
        self.streaming_mailbox.subscribe_to(self.event_bus, EventType.STREAMING_CHUNK)

        self.transcription_mailbox = Mailbox("tui_transcription", MPQueue())
        self.transcription_mailbox.subscribe_to(self.event_bus, EventType.TRANSCRIPTION_COMPLETE)

    def _start_backend_workers(self):
        """Start backend workers in TUI-compatible mode.

        Passes the TUI's log_dir to workers so all logs are co-located
        in tui/logs/ (requests.jsonl, health.jsonl, llm_requests.log, etc.)
        """
        import multiprocessing as mp
        from communication.process_manager import ProcessManager
        from workers.console_tts_worker import ConsoleTTSWorker
        from workers.service_rep_worker import ServiceRepWorker
        from util.config import ServiceRepConfig

        if mp.get_start_method(allow_none=True) != "spawn":
            mp.set_start_method("spawn", force=True)

        os.environ["LOG_TO_CONSOLE"] = "false"
        os.environ["LOG_LEVEL"] = "WARNING"

        self.process_manager = ProcessManager(
            event_bus=self.event_bus,
            check_interval=self.config.runtime.health_check_interval_s,
        )

        self.process_manager.register_worker(
            worker_id="tts",
            worker_class=ConsoleTTSWorker,
            subscribe_to=[EventType.TTS_REQUESTED],
            worker_kwargs={},
        )

        service_rep_config = ServiceRepConfig(enabled=True, llm_config=None)
        self.process_manager.register_worker(
            worker_id="service_rep",
            worker_class=ServiceRepWorker,
            subscribe_to=[EventType.TRANSCRIPTION_COMPLETE],
            worker_kwargs={
                "event_bus": self.event_bus,
                "service_rep_config": service_rep_config,
                "harness_config_path": self.config.harness.config_path,
                "log_dir": self._log_dir,  # Pass TUI's log directory to worker
            },
        )

        self.process_manager.start()
        time.sleep(1.0)

    def _handle_streaming_chunk(self, event: StreamingChunkEvent):
        """Handle a streaming chunk event."""
        request_id = event.request_id

        if self._streaming_request_id != request_id:
            self.logger.info(f"New streaming response: request_id={request_id}")
            self._streaming_request_id = request_id
            self._streaming_response = ""
            self._pop_status()
            self._streaming_entry = self._add_message("agent", "▌", pending=True)
            self.status = "Receiving response..."

        if event.chunk:
            self._streaming_response += event.chunk
            self.logger.debug(f"Streaming chunk: len={len(event.chunk)}, total={len(self._streaming_response)}")

            if self._streaming_entry:
                with self._conversation_lock:
                    for entry in self._conversation:
                        if entry.get("ts") == self._streaming_entry.get("ts"):
                            entry["text"] = self._streaming_response + "▌"
                            break

        if event.is_final:
            self.logger.info(f"Streaming complete: request_id={request_id}, total_len={len(self._streaming_response)}")
            if self._streaming_entry:
                with self._conversation_lock:
                    for entry in self._conversation:
                        if entry.get("ts") == self._streaming_entry.get("ts"):
                            entry["text"] = self._streaming_response
                            entry["pending"] = "0"
                            break
            self._streaming_entry = None
            self.last_response = self._streaming_response
            self.current_request_id = None
            self.status = "Ready"
            self._last_finalized_request_id = request_id
            self._streaming_request_id = None
            self._streaming_response = ""
            self._response_event.set()

    def _handle_agent_response(self, event: AgentResponseCompleteEvent):
        """Handle agent response completion."""
        if self._last_finalized_request_id == event.request_id:
            return

        if self._streaming_request_id == event.request_id and self._streaming_response:
            response_lines = self._streaming_response
            if self._streaming_entry:
                with self._conversation_lock:
                    for entry in self._conversation:
                        if entry.get("ts") == self._streaming_entry.get("ts"):
                            entry["pending"] = "0"
                            break
            self._streaming_entry = None
        else:
            response_lines = event.content or event.spoken_response or ""
            if not response_lines.strip():
                response_lines = "[No response]"
            self._pop_status()
            self._add_message("agent", response_lines)

        if not self.compact and (event.tools_used or event.duration_ms):
            meta = []
            if event.duration_ms:
                meta.append(f"Time: {event.duration_ms:.0f} ms")
            if event.tools_used:
                meta.append(f"Tools: {', '.join(event.tools_used)}")
            if meta:
                with self._conversation_lock:
                    for entry in reversed(self._conversation):
                        if entry.get("role") == "agent":
                            entry["text"] = entry["text"] + "\n\n" + " | ".join(meta)
                            break

        self.last_response = response_lines
        self.current_request_id = None
        self.status = "Ready"
        self._last_finalized_request_id = event.request_id
        self._streaming_request_id = None
        self._streaming_response = ""
        self._response_event.set()

    def _handle_transcription(self, event: TranscriptionCompleteEvent):
        """Handle transcription completion from voice input."""
        # Only process PTT transcriptions (request_id starts with "ptt_")
        # Skip "tui_" events - those are our own messages sent via _send_message()
        if not (event.request_id and event.request_id.startswith("ptt_")):
            return

        # Pop the "Transcribing..." status (only for actual PTT transcriptions)
        self._pop_status()

        # Fill the input buffer for manual review instead of auto-sending
        if event.text:
            self.input_state.buffer = list(event.text)
            self.input_state.cursor_pos = len(event.text)
            self.input_state._update_autocomplete()
            self.input_state._dirty = True
            self.status = "Ready"
            self._render_full_screen(show_input_box=True, status_message="Voice transcription ready")
        else:
            self._add_message("system", "[Voice input was empty or unclear]")
            self.status = "Ready"

    def _monitor_events(self):
        """Background thread to monitor events."""
        while self.running:
            try:
                # Process streaming chunks
                if self.streaming_mailbox:
                    try:
                        while True:
                            event = self.streaming_mailbox.receive(timeout=0.01)
                            if event is None:
                                break
                            if isinstance(event, StreamingChunkEvent):
                                self._handle_streaming_chunk(event)
                    except Empty:
                        pass

                # Process responses
                if self.response_mailbox:
                    try:
                        event = self.response_mailbox.receive(timeout=0.05)
                        if event and isinstance(event, AgentResponseCompleteEvent):
                            self._handle_agent_response(event)
                    except Empty:
                        pass

                # Process TTS events
                if self.tts_mailbox:
                    try:
                        self.tts_mailbox.receive(timeout=0.01)
                    except Empty:
                        pass

                # Process transcription events (voice input)
                # Skip when voice mode is active - _get_voice_input() handles PTT events directly
                if self.transcription_mailbox and not self.voice_mode:
                    try:
                        event = self.transcription_mailbox.receive(timeout=0.01)
                        if event and isinstance(event, TranscriptionCompleteEvent):
                            self._handle_transcription(event)
                    except Empty:
                        pass

            except Exception as exc:
                self._add_message("system", f"[Event monitor error: {exc}]")
                time.sleep(0.2)

            time.sleep(0.02)

    # ------------------------------------------------------------ Slash commands
    def _help_text(self) -> str:
        """Return help text."""
        commands = [
            ("/help", "Show this help message"),
            ("/config", "Display current configuration"),
            ("/models", "View API key status"),
            ("/compact", "Toggle compact mode"),
            ("/voice", "Toggle voice (push-to-talk) mode"),
            ("/status", "Show system status"),
            ("/up [N]", "Scroll up N lines (default: 10)"),
            ("/down [N]", "Scroll down N lines (default: 10)"),
            ("/pageup", "Scroll up one page"),
            ("/pagedown", "Scroll down one page"),
            ("/top", "Scroll to top"),
            ("/bottom", "Scroll to bottom"),
            ("/quit", "Exit the TUI"),
        ]
        lines = ["Voice Agent TUI - Commands", ""]
        for cmd, desc in commands:
            lines.append(f"{cmd.ljust(14)} {desc}")
        lines.extend([
            "",
            "Input shortcuts:",
            "  Arrows     Move cursor / navigate autocomplete",
            "  Ctrl+A/E   Start/end of line",
            "  Ctrl+U     Clear line",
            "  Ctrl+W     Delete word",
            "  Tab        Accept autocomplete",
            "  @filename  Autocomplete file paths",
        ])
        return "\n".join(lines)

    def _config_text(self) -> str:
        """Return configuration summary."""
        cfg = self.config
        rows = [
            ("Runtime Mode", cfg.runtime.mode.value),
            ("Log Level", cfg.logging.level),
            ("Log Directory", cfg.logging.log_dir),
            ("STT Engine", cfg.stt.engine),
            ("STT Model", cfg.stt.model_size),
            ("STT Device", cfg.stt.device),
            ("TTS Engine", cfg.tts.engine),
            ("TTS Voice", cfg.tts.voice or "default"),
            ("TTS Rate", f"{cfg.tts.rate} wpm"),
            ("Harness Config", cfg.harness.config_path),
        ]
        width = max(len(key) for key, _ in rows)
        lines = ["Current Configuration", ""]
        for key, value in rows:
            lines.append(f"{key.ljust(width)} : {value}")
        return "\n".join(lines)

    def _models_text(self) -> str:
        """Return API key/model info."""
        has_openai = bool(os.getenv("OPENAI_API_KEY"))
        has_anthropic = bool(os.getenv("ANTHROPIC_API_KEY"))
        has_google = bool(os.getenv("GOOGLE_API_KEY"))
        status = lambda ok: "Configured" if ok else "Not configured"
        return "\n".join([
            "LLM Models & API Keys",
            "",
            f"OpenAI    : {status(has_openai)}",
            f"Anthropic : {status(has_anthropic)}",
            f"Google    : {status(has_google)}",
        ])

    def _status_text(self) -> str:
        """Return runtime status."""
        workers = (
            "Running"
            if hasattr(self, "process_manager") and self.process_manager
            else "Not started"
        )
        event_bus = "Connected" if self.event_bus else "Not connected"
        return "\n".join([
            "System Status",
            "",
            f"Status           : {self.status}",
            f"Requests sent    : {self.request_count}",
            f"Compact mode     : {'ON' if self.compact else 'OFF'}",
            f"Voice mode       : {'ON' if self.voice_mode else 'OFF'}",
            f"Event bus        : {event_bus}",
            f"Workers          : {workers}",
        ])

    def _handle_slash_command(self, cmd: str) -> bool:
        """Handle slash commands. Returns True if handled."""
        parts = cmd.strip().split(maxsplit=1)
        command = parts[0].lower()

        if command == "/help":
            self._add_message("system", self._help_text())
            return True
        if command == "/config":
            self._add_message("system", self._config_text())
            return True
        if command == "/models":
            self._add_message("system", self._models_text())
            return True
        if command == "/compact":
            self.compact = not self.compact
            self._add_message("system", f"Compact mode {'enabled' if self.compact else 'disabled'}.")
            return True
        if command == "/voice":
            self._toggle_voice_mode()
            return True
        if command == "/status":
            self._add_message("system", self._status_text())
            return True
        if command == "/up":
            lines = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 10
            self.scroll_offset += lines
            return True
        if command == "/down":
            lines = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 10
            self.scroll_offset = max(0, self.scroll_offset - lines)
            return True
        if command == "/pageup":
            _, height = get_terminal_size()
            self.scroll_offset += max(1, height - 10)
            return True
        if command == "/pagedown":
            _, height = get_terminal_size()
            self.scroll_offset = max(0, self.scroll_offset - max(1, height - 10))
            return True
        if command == "/top":
            self.scroll_offset = 999999
            return True
        if command == "/bottom":
            self.scroll_offset = 0
            return True
        if command in ["/quit", "/exit"]:
            self.running = False
            self._add_message("system", "Shutting down...")
            return True

        return False

    # --------------------------------------------------------- Voice mode / PTT
    def _toggle_voice_mode(self):
        """Toggle between text and voice (push-to-talk) input modes."""
        self.voice_mode = not self.voice_mode

        if self.voice_mode:
            if self._start_ptt_worker():
                self._add_message(
                    "system",
                    "Voice mode enabled.\n\n"
                    "Press and hold SPACE to record your message.\n"
                    "Release SPACE to transcribe, then edit if needed.\n"
                    "Press ENTER to send. Type /quit to exit voice mode.",
                )
            else:
                self.voice_mode = False
                self._add_message(
                    "system",
                    "Failed to start voice mode. Check audio device availability.",
                )
        else:
            self._stop_ptt_worker()
            self._add_message("system", "Voice mode disabled. Text input enabled.")

    def _start_ptt_worker(self) -> bool:
        """Start the push-to-talk audio worker process."""
        try:
            if self.recording_event is None:
                self.recording_event = threading.Event()

            from workers.ptt_audio_worker import PushToTalkAudioWorker

            worker = PushToTalkAudioWorker(
                event_bus=self.event_bus,
                recording_event=self.recording_event,
                target_mailbox=self.transcription_mailbox,
            )

            worker_thread = threading.Thread(
                target=worker.run, daemon=True, name="PTTAudioWorker"
            )
            worker_thread.start()

            self.ptt_worker_process = worker
            self.logger.info("PTT worker started")
            return True

        except Exception as e:
            self.logger.error(f"Failed to start PTT worker: {e}")
            return False

    def _stop_ptt_worker(self):
        """Stop the push-to-talk audio worker."""
        if self.ptt_worker_process:
            try:
                self.ptt_worker_process.stop()
                self.ptt_worker_process = None
                self.logger.info("PTT worker stopped")
            except Exception as e:
                self.logger.error(f"Error stopping PTT worker: {e}")

        if self.recording_event:
            self.recording_event.clear()

    # -------------------------------------------------------------- Messaging
    def _send_message(self, text: str):
        """Send text message to agent."""
        self.request_count += 1
        request_id = f"tui_{self.request_count}_{int(time.time() * 1000) % 100000}"
        self.current_request_id = request_id
        self.status = "Processing..."
        self._push_status("Processing request...")

        if self.event_bus is None:
            raise RuntimeError("Event bus not initialized")

        self.logger.info(f"Sending message: request_id={request_id}, text_len={len(text)}, voice_mode={self.voice_mode}")

        self.event_bus.publish(
            TranscriptionCompleteEvent(
                request_id=request_id,
                text=text,
                confidence=None,
                duration_ms=0.0,
            )
        )

    def _wait_for_response(self, timeout_seconds: float = 0):
        """Wait for agent response, re-rendering during streaming or new messages.

        Args:
            timeout_seconds: Maximum time to wait for response (0 = no timeout)
        """
        last_streaming_len = 0
        last_conversation_len = len(self._conversation)
        start_time = time.time()

        while self.running:
            # Check for timeout (0 = disabled)
            if timeout_seconds > 0 and time.time() - start_time > timeout_seconds:
                self._add_message("system", "[Error: Response timeout after {:.0f}s]".format(timeout_seconds))
                self.status = "Timeout"
                break

            if self._response_event.is_set():
                self._response_event.clear()
                break

            needs_render = False
            status_message = self.status

            # Check for streaming updates
            current_streaming_len = len(self._streaming_response)
            if current_streaming_len > last_streaming_len:
                last_streaming_len = current_streaming_len
                needs_render = True
                status_message = "Receiving response..."

            # Check for new conversation entries (e.g., transcription arrived)
            current_conversation_len = len(self._conversation)
            if current_conversation_len > last_conversation_len:
                last_conversation_len = current_conversation_len
                needs_render = True

            if needs_render:
                self._render_full_screen(
                    show_input_box=False,
                    status_message=status_message,
                )

            time.sleep(0.05)

        # After response (or timeout), reset input state
        # The next _get_input() call will handle rendering appropriately for text/voice mode
        if self.running:
            self.input_state.reset()
            # In voice mode, _get_voice_input() handles its own rendering
            # In text mode, _get_input() will render the input box
            if not self.voice_mode:
                self._render_full_screen(show_input_box=True, status_message=self.status)

    def _refresh_file_cache_loop(self):
        """Background thread to refresh file cache."""
        while self.running:
            time.sleep(10)
            if self.running:
                self.file_cache.refresh_background()

    # ---------------------------------------------------------- Logging setup
    def _configure_logging(self) -> str:
        """Configure TUI logging with proper folder structure.

        All logs are co-located in tui/logs/ - the application's own log directory.
        This log_dir is passed to backend workers so all components log to the same place.

        Creates:
            tui/logs/
            ├── tui.log           # Main TUI application log (via logging_config)
            ├── errors/
            │   └── errors.log    # Full stack traces with timestamps (via logging_config)
            ├── requests.jsonl    # Request lifecycle tracking (via StructuredLogger)
            ├── health.jsonl      # System health metrics (via StructuredLogger)
            ├── prompts.jsonl     # Full prompts stored by ID (via StructuredLogger)
            ├── llm_requests.log  # LLM context logging (via AgentLogger)
            └── agent_execution.jsonl  # Agent execution traces (via AgentExecutionLogger)

        Returns:
            The log directory path (stored in self._log_dir for passing to workers)
        """
        # TUI logs go in tui/logs/ (co-located with the application)
        tui_dir = os.path.dirname(os.path.abspath(__file__))
        log_dir = os.path.join(tui_dir, "logs")

        # Configure TUI logging with the proper directory
        configure_tui_logging(
            log_dir=log_dir,
            level=logging.WARNING,  # Keep TUI quiet
            enable_console=False,   # Don't pollute TUI display
            enable_file=True
        )

        # Suppress console handlers from all loggers to keep TUI clean
        root_logger = logging.getLogger()
        for handler in list(root_logger.handlers):
            if isinstance(handler, logging.StreamHandler) and handler.stream in (
                sys.stdout,
                sys.stderr,
            ):
                root_logger.removeHandler(handler)

        for logger_name in logging.root.manager.loggerDict:
            logger = logging.getLogger(logger_name)
            logger.setLevel(logging.WARNING)
            for handler in list(logger.handlers):
                if isinstance(handler, logging.StreamHandler) and handler.stream in (
                    sys.stdout,
                    sys.stderr,
                ):
                    logger.removeHandler(handler)

        return log_dir

    # ---------------------------------------------------------------- Main loop
    def run(self):
        """Main TUI loop."""
        # Configure logging first - returns the log directory for later use
        self._log_dir = self._configure_logging()
        self._add_message("system", "Type /help for commands or start chatting.")

        # Build file cache
        self._add_message("system", "Indexing files for autocomplete...")
        self._render_full_screen(show_input_box=False, status_message="Indexing...")
        self.file_cache.build_initial()

        self._render_full_screen(show_input_box=False, status_message="Loading...")

        # Suppress stdout during backend startup
        original_stdout = sys.stdout.fileno()
        original_stderr = sys.stderr.fileno()
        saved_stdout = os.dup(original_stdout)
        saved_stderr = os.dup(original_stderr)
        devnull = os.open(os.devnull, os.O_WRONLY)

        os.dup2(devnull, original_stdout)
        os.dup2(devnull, original_stderr)

        try:
            self._setup_event_bus()
            self._start_backend_workers()
        finally:
            os.dup2(saved_stdout, original_stdout)
            os.dup2(saved_stderr, original_stderr)
            os.close(devnull)
            os.close(saved_stdout)
            os.close(saved_stderr)

        self._add_message("system", "Backend ready.")
        self._render_full_screen(show_input_box=False, status_message="Ready")

        self.running = True

        # Start background threads
        monitor_thread = threading.Thread(
            target=self._monitor_events, daemon=True, name="EventMonitor"
        )
        monitor_thread.start()

        refresh_thread = threading.Thread(
            target=self._refresh_file_cache_loop, daemon=True, name="FileCacheRefresh"
        )
        refresh_thread.start()

        try:
            while self.running:
                try:
                    text = self._get_input()
                except EOFError:
                    self.running = False
                    break
                except KeyboardInterrupt:
                    self.running = False
                    break

                if not self.running:
                    break

                # Empty string means no input - just continue
                if not text:
                    continue

                # Handle slash commands
                if text.startswith("/"):
                    handled = self._handle_slash_command(text)
                    if handled:
                        if not self.running:
                            break
                        continue

                # Regular message - show it was sent
                self._add_message("user", text)
                self.status = "Sending..."
                self._render_full_screen(
                    show_input_box=False,
                    status_message="Sending message...",
                )

                try:
                    self._response_event.clear()
                    self._send_message(text)
                    # Update status after sending
                    self.status = "Processing..."
                    self._render_full_screen(
                        show_input_box=False,
                        status_message="Processing request...",
                    )
                    self._wait_for_response()
                except Exception as exc:
                    self._pop_status()
                    self._add_message("system", f"[Error: {exc}]")
                    self.status = "Error"
                    self._render_full_screen(show_input_box=False, status_message="Error occurred")

        finally:
            self._shutdown()

    def _shutdown(self):
        """Clean shutdown."""
        self.running = False
        self._add_message("system", "Goodbye!")
        self._render_full_screen(show_input_box=False, status_message="Shutting down...")

        # Stop PTT worker if running
        if self.voice_mode:
            self._stop_ptt_worker()

        if self.event_bus:
            self.event_bus.shutdown()

        if hasattr(self, "process_manager") and self.process_manager:
            self.process_manager.stop()


def main(argv: Optional[List[str]] = None) -> int:
    """Entry point for simple TUI."""
    try:
        config = load_app_config()
        config.runtime.headless = True
        tui = SimpleTUI(config)
        tui.run()
        return 0
    except Exception as exc:
        print(f"\n[Error: {exc}]", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
