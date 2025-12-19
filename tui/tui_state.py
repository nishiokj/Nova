"""Thread-safe state management for the robust TUI.

This module provides:
- TUIState enum for explicit state machine
- StateSnapshot dataclass for immutable render data
- TUIStateManager for thread-safe state operations

All state mutations happen through the manager, which:
1. Validates state transitions
2. Protects all data with a single RLock
3. Signals render events when state changes
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Dict, List, Optional, Set, Tuple


class TUIState(Enum):
    """Explicit TUI states for the state machine."""

    IDLE = auto()           # Ready for text input
    RECORDING = auto()      # PTT active (holding space)
    TRANSCRIBING = auto()   # Voice -> text in progress
    SENDING = auto()        # Request submitted to backend
    STREAMING = auto()      # Receiving response chunks
    ERROR = auto()          # Error state (recoverable)


# Valid state transitions
VALID_TRANSITIONS: Dict[TUIState, Set[TUIState]] = {
    TUIState.IDLE: {TUIState.RECORDING, TUIState.SENDING, TUIState.ERROR},
    TUIState.RECORDING: {TUIState.TRANSCRIBING, TUIState.IDLE, TUIState.ERROR},
    TUIState.TRANSCRIBING: {TUIState.IDLE, TUIState.ERROR},
    TUIState.SENDING: {TUIState.STREAMING, TUIState.IDLE, TUIState.ERROR},
    TUIState.STREAMING: {TUIState.IDLE, TUIState.ERROR},
    TUIState.ERROR: {TUIState.IDLE},
}


@dataclass(frozen=True)
class ConversationEntry:
    """Immutable conversation entry for display."""

    role: str           # "user", "agent", "system", "status"
    text: str           # Message content
    timestamp: float    # Unix timestamp
    pending: bool = False  # Whether this is a pending/in-progress entry
    meta: Optional[str] = None  # Optional metadata (duration, tools used)


@dataclass(frozen=True)
class StateSnapshot:
    """Immutable snapshot of TUI state for rendering.

    The render engine takes a snapshot and renders from it,
    ensuring consistent state even if mutations happen during render.
    """

    state: TUIState
    status_message: str

    # Input state
    input_buffer: str
    cursor_pos: int
    autocomplete_active: bool
    autocomplete_suggestions: Tuple[str, ...]
    autocomplete_selected: int

    # Conversation history
    conversation: Tuple[ConversationEntry, ...]
    streaming_text: str
    streaming_cursor: str  # e.g., "▌" for streaming indicator

    # Scroll state
    scroll_offset: int
    user_scrolled: bool

    # Display options
    compact_mode: bool
    voice_mode: bool

    # Metrics
    request_count: int

    # Progress (from AgentProgressEvent)
    progress_message: str = ""


class TUIStateManager:
    """Thread-safe state container with observer pattern.

    All state is protected by a single RLock. State changes signal
    the render event so the render thread can wake up.

    Usage:
        state = TUIStateManager()

        # Read state (snapshot for rendering)
        snapshot = state.snapshot()

        # Mutate state (always through methods)
        state.insert_char("a")
        state.transition(TUIState.SENDING)

        # Wait for render signal
        state.render_event.wait()
    """

    def __init__(self):
        # Single lock protects ALL state
        self._lock = threading.RLock()

        # Render signaling
        self._render_event = threading.Event()

        # State machine
        self._state: TUIState = TUIState.IDLE
        self._status_message: str = "Ready"
        self._error_message: Optional[str] = None

        # Input state
        self._input_buffer: List[str] = []
        self._cursor_pos: int = 0
        self._autocomplete_active: bool = False
        self._autocomplete_suggestions: List[str] = []
        self._autocomplete_selected: int = 0

        # Conversation history
        self._conversation: List[ConversationEntry] = []
        self._streaming_text: str = ""
        self._streaming_request_id: Optional[str] = None

        # Scroll state
        self._scroll_offset: int = 0
        self._user_scrolled: bool = False

        # Display options
        self._compact_mode: bool = False
        self._voice_mode: bool = False

        # Metrics
        self._request_count: int = 0

        # Progress (from AgentProgressEvent)
        self._progress_message: str = ""

    # ---------------------------------------------------------------- Properties

    @property
    def render_event(self) -> threading.Event:
        """Event signaled when render is needed."""
        return self._render_event

    def get_state(self) -> TUIState:
        """Get current state (thread-safe)."""
        with self._lock:
            return self._state

    def get_status(self) -> str:
        """Get current status message (thread-safe)."""
        with self._lock:
            return self._status_message

    def has_input(self) -> bool:
        """Check if input buffer has content (thread-safe)."""
        with self._lock:
            return len(self._input_buffer) > 0

    @property
    def autocomplete_active(self) -> bool:
        """Expose whether autocomplete dropdown is active."""
        with self._lock:
            return self._autocomplete_active

    def get_input(self) -> str:
        """Get current input text (thread-safe)."""
        with self._lock:
            return "".join(self._input_buffer)

    # ---------------------------------------------------------------- State Machine

    def transition(self, new_state: TUIState, status: Optional[str] = None) -> bool:
        """Attempt state transition.

        Args:
            new_state: Target state
            status: Optional status message to set

        Returns:
            True if transition succeeded, False if invalid
        """
        with self._lock:
            if new_state not in VALID_TRANSITIONS.get(self._state, set()):
                return False

            self._state = new_state

            # Set default status messages for each state
            if status:
                self._status_message = status
            else:
                self._status_message = {
                    TUIState.IDLE: "Ready",
                    TUIState.RECORDING: "Recording...",
                    TUIState.TRANSCRIBING: "Transcribing...",
                    TUIState.SENDING: "Sending...",
                    TUIState.STREAMING: "Receiving response...",
                    TUIState.ERROR: self._error_message or "Error",
                }.get(new_state, "Ready")

            self._render_event.set()
            return True

    def set_error(self, message: str) -> bool:
        """Transition to error state with message."""
        with self._lock:
            self._error_message = message
            return self.transition(TUIState.ERROR, status=message)

    def clear_error(self) -> bool:
        """Clear error and return to IDLE."""
        with self._lock:
            self._error_message = None
            return self.transition(TUIState.IDLE)

    def set_status(self, message: str):
        """Update status message without changing state."""
        with self._lock:
            self._status_message = message
            self._render_event.set()

    # ---------------------------------------------------------------- Progress

    def set_progress(self, message: str):
        """Set progress message from AgentProgressEvent."""
        with self._lock:
            self._progress_message = message
            self._render_event.set()

    def clear_progress(self):
        """Clear progress message."""
        with self._lock:
            self._progress_message = ""
            self._render_event.set()

    # ---------------------------------------------------------------- Input Buffer

    def insert_char(self, char: str):
        """Insert character at cursor position."""
        with self._lock:
            self._input_buffer.insert(self._cursor_pos, char)
            self._cursor_pos += 1
            self._render_event.set()

    def backspace(self) -> bool:
        """Delete character before cursor. Returns True if deleted."""
        with self._lock:
            if self._cursor_pos > 0:
                self._cursor_pos -= 1
                self._input_buffer.pop(self._cursor_pos)
                self._render_event.set()
                return True
            return False

    def delete(self) -> bool:
        """Delete character at cursor. Returns True if deleted."""
        with self._lock:
            if self._cursor_pos < len(self._input_buffer):
                self._input_buffer.pop(self._cursor_pos)
                self._render_event.set()
                return True
            return False

    def move_cursor(self, delta: int):
        """Move cursor by delta positions."""
        with self._lock:
            new_pos = self._cursor_pos + delta
            self._cursor_pos = max(0, min(new_pos, len(self._input_buffer)))
            self._render_event.set()

    def move_cursor_to(self, position: int):
        """Move cursor to absolute position."""
        with self._lock:
            self._cursor_pos = max(0, min(position, len(self._input_buffer)))
            self._render_event.set()

    def clear_input(self):
        """Clear input buffer and reset cursor."""
        with self._lock:
            self._input_buffer.clear()
            self._cursor_pos = 0
            self._autocomplete_active = False
            self._autocomplete_suggestions.clear()
            self._autocomplete_selected = 0
            self._render_event.set()

    def set_input(self, text: str):
        """Replace input buffer with text (e.g., from transcription)."""
        with self._lock:
            self._input_buffer = list(text)
            self._cursor_pos = len(self._input_buffer)
            self._render_event.set()

    def delete_word_back(self):
        """Delete word before cursor (Ctrl+W)."""
        with self._lock:
            if self._cursor_pos == 0:
                return

            # Skip trailing whitespace
            while self._cursor_pos > 0 and self._input_buffer[self._cursor_pos - 1] == " ":
                self._cursor_pos -= 1
                self._input_buffer.pop(self._cursor_pos)

            # Delete word characters
            while self._cursor_pos > 0 and self._input_buffer[self._cursor_pos - 1] != " ":
                self._cursor_pos -= 1
                self._input_buffer.pop(self._cursor_pos)

            self._render_event.set()

    # ---------------------------------------------------------------- Autocomplete

    def set_autocomplete(self, suggestions: List[str]):
        """Set autocomplete suggestions."""
        with self._lock:
            self._autocomplete_suggestions = suggestions.copy()
            self._autocomplete_active = len(suggestions) > 0
            self._autocomplete_selected = 0
            self._render_event.set()

    def dismiss_autocomplete(self):
        """Dismiss autocomplete dropdown."""
        with self._lock:
            self._autocomplete_active = False
            self._autocomplete_suggestions.clear()
            self._autocomplete_selected = 0
            self._render_event.set()

    def select_autocomplete(self, delta: int):
        """Move autocomplete selection by delta."""
        with self._lock:
            if not self._autocomplete_active:
                return
            n = len(self._autocomplete_suggestions)
            if n > 0:
                self._autocomplete_selected = (self._autocomplete_selected + delta) % n
                self._render_event.set()

    def accept_autocomplete(self) -> bool:
        """Accept selected autocomplete suggestion. Returns True if accepted."""
        with self._lock:
            if not self._autocomplete_active or not self._autocomplete_suggestions:
                return False

            suggestion = self._autocomplete_suggestions[self._autocomplete_selected]

            # Find the @ that triggered autocomplete and replace from there
            at_pos = None
            for i in range(self._cursor_pos - 1, -1, -1):
                if self._input_buffer[i] == "@":
                    at_pos = i
                    break

            if at_pos is not None:
                # Remove from @ to cursor
                del self._input_buffer[at_pos:self._cursor_pos]
                # Insert @suggestion
                new_text = "@" + suggestion
                for j, c in enumerate(new_text):
                    self._input_buffer.insert(at_pos + j, c)
                self._cursor_pos = at_pos + len(new_text)

            self._autocomplete_active = False
            self._autocomplete_suggestions.clear()
            self._autocomplete_selected = 0
            self._render_event.set()
            return True

    # ---------------------------------------------------------------- Conversation

    def add_message(self, role: str, text: str, pending: bool = False) -> ConversationEntry:
        """Add message to conversation history."""
        with self._lock:
            entry = ConversationEntry(
                role=role,
                text=text.strip() if text else "",
                timestamp=time.time(),
                pending=pending,
            )
            self._conversation.append(entry)

            # Auto-scroll to bottom when new message arrives (unless user scrolled)
            if not self._user_scrolled:
                self._scroll_offset = 0

            self._render_event.set()
            return entry

    def update_streaming(self, request_id: str, text: str, is_final: bool = False):
        """Update streaming response text."""
        with self._lock:
            if self._streaming_request_id != request_id:
                # New streaming response - start fresh
                self._streaming_request_id = request_id
                self._streaming_text = ""

            self._streaming_text = text

            if is_final:
                # Add completed response to conversation
                self._conversation.append(ConversationEntry(
                    role="agent",
                    text=text,
                    timestamp=time.time(),
                    pending=False,
                ))
                self._streaming_text = ""
                self._streaming_request_id = None

            self._render_event.set()

    def finalize_streaming(self, meta: Optional[str] = None):
        """Finalize streaming response and add to conversation."""
        with self._lock:
            if self._streaming_text:
                entry = ConversationEntry(
                    role="agent",
                    text=self._streaming_text,
                    timestamp=time.time(),
                    pending=False,
                    meta=meta,
                )
                self._conversation.append(entry)
                self._streaming_text = ""
                self._streaming_request_id = None
                self._render_event.set()

    def clear_conversation(self):
        """Clear conversation history."""
        with self._lock:
            self._conversation.clear()
            self._streaming_text = ""
            self._streaming_request_id = None
            self._scroll_offset = 0
            self._user_scrolled = False
            self._render_event.set()

    # ---------------------------------------------------------------- Scroll

    def scroll(self, delta: int):
        """Scroll by delta lines. Positive = up, negative = down."""
        with self._lock:
            self._scroll_offset = max(0, self._scroll_offset + delta)
            if delta > 0:
                self._user_scrolled = True
            elif self._scroll_offset == 0:
                self._user_scrolled = False
            self._render_event.set()

    def scroll_to_bottom(self):
        """Scroll to bottom and clear user_scrolled flag."""
        with self._lock:
            self._scroll_offset = 0
            self._user_scrolled = False
            self._render_event.set()

    def scroll_to_top(self):
        """Scroll to top (large offset that will be clamped)."""
        with self._lock:
            self._scroll_offset = 999999
            self._user_scrolled = True
            self._render_event.set()

    def clamp_scroll(self, max_scroll: int):
        """Clamp scroll offset to valid range (called by renderer)."""
        with self._lock:
            self._scroll_offset = max(0, min(self._scroll_offset, max_scroll))

    # ---------------------------------------------------------------- Options

    def toggle_compact(self) -> bool:
        """Toggle compact mode. Returns new value."""
        with self._lock:
            self._compact_mode = not self._compact_mode
            self._render_event.set()
            return self._compact_mode

    def toggle_voice(self) -> bool:
        """Toggle voice mode. Returns new value."""
        with self._lock:
            self._voice_mode = not self._voice_mode
            self._render_event.set()
            return self._voice_mode

    def set_voice_mode(self, enabled: bool):
        """Set voice mode explicitly."""
        with self._lock:
            self._voice_mode = enabled
            self._render_event.set()

    # ---------------------------------------------------------------- Metrics

    def increment_requests(self) -> int:
        """Increment request count. Returns new count."""
        with self._lock:
            self._request_count += 1
            return self._request_count

    # ---------------------------------------------------------------- Snapshot

    def snapshot(self) -> StateSnapshot:
        """Return immutable snapshot for rendering.

        This is the ONLY way the render engine should access state.
        Taking a snapshot is atomic (under lock), then rendering
        happens without holding the lock.
        """
        with self._lock:
            return StateSnapshot(
                state=self._state,
                status_message=self._status_message,
                input_buffer="".join(self._input_buffer),
                cursor_pos=self._cursor_pos,
                autocomplete_active=self._autocomplete_active,
                autocomplete_suggestions=tuple(self._autocomplete_suggestions),
                autocomplete_selected=self._autocomplete_selected,
                conversation=tuple(self._conversation),
                streaming_text=self._streaming_text,
                streaming_cursor="▌" if self._streaming_text else "",
                scroll_offset=self._scroll_offset,
                user_scrolled=self._user_scrolled,
                compact_mode=self._compact_mode,
                voice_mode=self._voice_mode,
                request_count=self._request_count,
                progress_message=self._progress_message,
            )
