"""Robust TUI with event-driven architecture and proper state management.

This is a ground-up rewrite of SimpleTUI with:
- Explicit state machine (no ad-hoc flags)
- Thread-safe state container (single lock for all state)
- Event-driven rendering (dedicated render thread)
- Proper SIGWINCH handling
- Modular voice service
- Output buffering (single atomic write per frame)

Usage:
    python -m tui.robust_tui
"""

from __future__ import annotations

import logging
import os
import select
import signal
import sys
import termios
import threading
import time
import tty
from multiprocessing import Queue as MPQueue
from queue import Empty
from typing import Any, Dict, List, Optional

# Add src to path
PROJECT_ROOT = os.path.dirname(os.path.abspath(os.path.join(__file__, "..")))
SRC_DIR = os.path.join(PROJECT_ROOT, "src")
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

from app_config import AppConfig, load_app_config
from communication import EventBus, Mailbox
from communication.events import (
    AgentProgressEvent,
    AgentResponseCompleteEvent,
    EventType,
    StreamingChunkEvent,
    TranscriptionCompleteEvent,
)
from tui.autocomplete import FileCache
from tui.render_engine import RenderEngine, get_terminal_size
from tui.tui_state import TUIState, TUIStateManager
from tui.voice_service import VoiceInputHandler, VoiceService


class RawTerminal:
    """Context manager for raw terminal mode with non-blocking reads."""

    def __init__(self):
        self._fd = sys.stdin.fileno()
        self._old_settings = None

    def __enter__(self):
        self._old_settings = termios.tcgetattr(self._fd)
        tty.setraw(self._fd)
        return self

    def __exit__(self, *args):
        if self._old_settings:
            termios.tcsetattr(self._fd, termios.TCSADRAIN, self._old_settings)

    def read_char(self, timeout: float = 0.05) -> Optional[str]:
        """Read single character with timeout.

        Args:
            timeout: Timeout in seconds

        Returns:
            Character read, or None if timeout
        """
        ready, _, _ = select.select([self._fd], [], [], timeout)
        if ready:
            return sys.stdin.read(1)
        return None

    def read_escape_sequence(self) -> str:
        """Read remaining characters of escape sequence."""
        seq = ""
        for _ in range(5):  # Max escape sequence length
            ready, _, _ = select.select([self._fd], [], [], 0.01)
            if ready:
                seq += sys.stdin.read(1)
            else:
                break
        return seq


class RobustTUI:
    """Event-driven TUI with proper state management.

    This TUI uses:
    - TUIStateManager for thread-safe state
    - RenderEngine for event-driven rendering
    - VoiceService for modular PTT support
    - Explicit state machine for input handling
    """

    def __init__(self, config: AppConfig):
        self.config = config
        self.logger = logging.getLogger(__name__)

        # Core components
        self.state = TUIStateManager()
        self.renderer = RenderEngine(self.state)
        self.voice: Optional[VoiceService] = None
        self.voice_handler: Optional[VoiceInputHandler] = None

        # File autocomplete
        self.file_cache = FileCache(PROJECT_ROOT)

        # Backend integration
        self.event_bus: Optional[EventBus] = None
        self.response_mailbox: Optional[Mailbox] = None
        self.streaming_mailbox: Optional[Mailbox] = None
        self.transcription_mailbox: Optional[Mailbox] = None
        self.progress_mailbox: Optional[Mailbox] = None

        # Process management
        self.process_manager: Optional[Any] = None

        # Threads
        self._event_monitor_thread: Optional[threading.Thread] = None
        self._file_cache_thread: Optional[threading.Thread] = None

        # Shutdown flag
        self._shutdown_requested = False

        # Log directory (set during _configure_logging)
        self._log_dir: Optional[str] = None

        # Transcription timeout handling
        self._transcription_deadline: Optional[float] = None

    # ---------------------------------------------------------------- Lifecycle

    def run(self):
        """Main entry point."""
        try:
            self._configure_logging()
            self._setup()
            self._main_loop()
        except KeyboardInterrupt:
            pass
        except Exception as e:
            self.logger.exception(f"Fatal error: {e}")
        finally:
            self._shutdown()

    def _configure_logging(self):
        """Configure logging for TUI."""
        from tui.logging_config import configure_tui_logging

        # TUI logs go in tui/logs/
        tui_dir = os.path.dirname(os.path.abspath(__file__))
        self._log_dir = os.path.join(tui_dir, "logs")

        configure_tui_logging(
            log_dir=self._log_dir,
            level=logging.DEBUG,  # FULL LOGGING - capture all worker/wizard logs
            enable_console=False,
            enable_file=True,
        )

        # Suppress console handlers
        for handler in list(logging.root.handlers):
            if isinstance(handler, logging.StreamHandler) and handler.stream in (
                sys.stdout,
                sys.stderr,
            ):
                logging.root.removeHandler(handler)

    def _setup(self):
        """Initialize all components."""
        # Welcome message
        self.state.add_message("system", "Robust TUI starting...")
        self.renderer.render_once()

        # Build file cache
        self.state.add_message("system", "Indexing files for autocomplete...")
        self.renderer.render_once()
        self.file_cache.build_initial()

        # Setup event bus and mailboxes
        self.state.add_message("system", "Connecting to backend...")
        self.renderer.render_once()
        self._setup_event_bus()

        # Start backend workers (suppress stdout during startup)
        self._start_backend_workers()

        # Install resize handler
        self._install_resize_handler()

        # Start render thread
        self.renderer.start()

        # Start event monitor thread
        self._event_monitor_thread = threading.Thread(
            target=self._event_monitor_loop,
            daemon=True,
            name="EventMonitor",
        )
        self._event_monitor_thread.start()

        # Start file cache refresh thread
        self._file_cache_thread = threading.Thread(
            target=self._file_cache_refresh_loop,
            daemon=True,
            name="FileCacheRefresh",
        )
        self._file_cache_thread.start()

        self.state.add_message("system", "Type /help for commands or start chatting.")
        self.state.add_message("system", "Use /voice to enable voice mode.")

    def _setup_event_bus(self):
        """Setup event bus and mailboxes."""
        self.event_bus = EventBus()

        self.response_mailbox = Mailbox("robust_tui_responses", MPQueue())
        self.response_mailbox.subscribe_to(
            self.event_bus, EventType.AGENT_RESPONSE_COMPLETE
        )

        self.streaming_mailbox = Mailbox("robust_tui_streaming", MPQueue())
        self.streaming_mailbox.subscribe_to(self.event_bus, EventType.STREAMING_CHUNK)

        # Voice-only transcription mailbox (not subscribed to EventBus by default)
        # PTT worker delivers directly to this mailbox to avoid mixing with text requests.
        self.transcription_mailbox = Mailbox("robust_tui_transcription", MPQueue())

        # Progress events (from agent during execution)
        self.progress_mailbox = Mailbox("robust_tui_progress", MPQueue())
        self.progress_mailbox.subscribe_to(self.event_bus, EventType.AGENT_PROGRESS)

    def _start_backend_workers(self):
        """Start backend worker processes."""
        import multiprocessing as mp

        from communication.process_manager import ProcessManager
        from util.config import ServiceRepConfig
        from workers.console_tts_worker import ConsoleTTSWorker
        from workers.service_rep_worker import ServiceRepWorker

        if mp.get_start_method(allow_none=True) != "spawn":
            mp.set_start_method("spawn", force=True)

        os.environ["LOG_TO_CONSOLE"] = "false"
        os.environ["LOG_LEVEL"] = "WARNING"

        # Suppress stdout during worker startup
        original_stdout = sys.stdout.fileno()
        original_stderr = sys.stderr.fileno()
        saved_stdout = os.dup(original_stdout)
        saved_stderr = os.dup(original_stderr)
        devnull = os.open(os.devnull, os.O_WRONLY)

        os.dup2(devnull, original_stdout)
        os.dup2(devnull, original_stderr)

        try:
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
                    "log_dir": self._log_dir,
                },
            )

            self.process_manager.start()
            time.sleep(1.0)

        finally:
            os.dup2(saved_stdout, original_stdout)
            os.dup2(saved_stderr, original_stderr)
            os.close(devnull)
            os.close(saved_stdout)
            os.close(saved_stderr)

        self.state.add_message("system", "Backend ready.")

    def _install_resize_handler(self):
        """Install SIGWINCH handler for terminal resize."""
        try:
            from tui.ui_resize import install_resize_handler

            def on_resize(width: int, height: int):
                # Just signal render - renderer will get new size
                self.state.render_event.set()

            install_resize_handler(on_resize)
            self.logger.info("SIGWINCH handler installed")
        except Exception as e:
            self.logger.warning(f"Could not install resize handler: {e}")

    def _shutdown(self):
        """Clean shutdown."""
        self._shutdown_requested = True

        self.state.add_message("system", "Shutting down...")
        self.state.render_event.set()
        time.sleep(0.1)

        # Stop voice service
        if self.voice:
            self.voice.stop()

        # Stop render thread
        self.renderer.stop()

        # Stop event bus
        if self.event_bus:
            self.event_bus.shutdown()

        # Stop process manager
        if self.process_manager:
            self.process_manager.stop()

        # Show cursor
        sys.stdout.write("\033[?25h")
        sys.stdout.flush()

    # ---------------------------------------------------------------- Main Loop

    def _main_loop(self):
        """State-driven main loop."""
        while not self._shutdown_requested:
            current_state = self.state.get_state()

            try:
                if current_state == TUIState.IDLE:
                    self._handle_idle()
                elif current_state == TUIState.RECORDING:
                    self._handle_recording()
                elif current_state == TUIState.TRANSCRIBING:
                    self._handle_transcribing()
                elif current_state == TUIState.SENDING:
                    self._handle_sending()
                elif current_state == TUIState.STREAMING:
                    self._handle_streaming()
                elif current_state == TUIState.ERROR:
                    self._handle_error()

            except KeyboardInterrupt:
                self._shutdown_requested = True
            except EOFError:
                self._shutdown_requested = True

    def _handle_idle(self):
        """IDLE state: accept text input or voice trigger."""
        with RawTerminal() as term:
            char = term.read_char(timeout=0.05)

            if char is None:
                # No input, check for events
                return

            # Voice mode: space on empty buffer triggers recording
            # Handle the ENTIRE recording flow here to avoid raw terminal mode issues
            if (
                char == " "
                and self.voice
                and self.voice.is_active
                and not self.state.has_input()
            ):
                # Pause rendering to prevent terminal interference during PTT
                self.renderer.pause()

                try:
                    # Start recording and handle the full PTT flow in this context
                    self.voice.begin_recording()
                    self.state.transition(TUIState.RECORDING)

                    # Show recording indicator immediately
                    self._render_recording_indicator(recording=True)

                    # === RECORDING LOOP: Stay in raw mode for key release detection ===
                    # Key release detection has two phases:
                    # 1. INITIAL PHASE: Wait for first key repeat (proves key is held)
                    #    - macOS/Linux initial key repeat delay is 200-500ms
                    #    - We wait up to 700ms for the first repeat
                    #    - If no repeat arrives, assume very short press and end
                    # 2. REPEAT PHASE: Once repeat confirmed, use short timeout
                    #    - Key repeat fires every 30-50ms once started
                    #    - 3x 50ms timeouts = 150ms of silence = released

                    key_repeat_confirmed = False
                    consecutive_timeouts = 0
                    initial_timeout = 0.05  # 50ms poll during initial phase
                    initial_max_wait = 14   # 14 * 50ms = 700ms max wait for first repeat
                    repeat_timeout = 0.05   # 50ms poll during repeat phase
                    release_threshold = 3   # 3 * 50ms = 150ms of silence = released

                    while not self._shutdown_requested:
                        timeout = repeat_timeout if key_repeat_confirmed else initial_timeout
                        ready, _, _ = select.select([sys.stdin.fileno()], [], [], timeout)

                        if ready:
                            next_char = sys.stdin.read(1)
                            if next_char == " ":
                                # Space repeat detected - key is definitely held
                                key_repeat_confirmed = True
                                consecutive_timeouts = 0
                                # Update recording indicator with elapsed time
                                self._render_recording_indicator(recording=True)
                            # Any other key is ignored during recording
                        else:
                            # Timeout - no key activity
                            consecutive_timeouts += 1

                            if key_repeat_confirmed:
                                # In repeat phase: short silence means released
                                if consecutive_timeouts >= release_threshold:
                                    break
                            else:
                                # In initial phase: long silence means short press
                                if consecutive_timeouts >= initial_max_wait:
                                    # No repeat after 700ms - treat as short press
                                    break

                    # Clear recording indicator and show transcribing
                    self._render_recording_indicator(recording=False)

                    # End recording and transition to transcribing
                    self.voice.end_recording()
                    self._transcription_deadline = time.time() + 30.0
                    self.state.transition(TUIState.TRANSCRIBING)

                finally:
                    # Resume rendering
                    self.renderer.resume()

                return

            # Enter: submit input
            if char in ("\r", "\n"):
                if self.state.autocomplete_active:
                    # Accept autocomplete suggestion
                    self.state.accept_autocomplete()
                    return

                text = self.state.get_input().strip()
                if text:
                    self._submit_input(text)
                return

            # Escape sequences
            if char == "\x1b":
                seq = term.read_escape_sequence()
                self._handle_escape_sequence(seq)
                return

            # Control characters
            if char == "\x03":  # Ctrl+C
                raise KeyboardInterrupt
            if char == "\x04":  # Ctrl+D
                if not self.state.has_input():
                    raise EOFError
                return
            if char == "\x01":  # Ctrl+A
                self.state.move_cursor_to(0)
                return
            if char == "\x05":  # Ctrl+E
                self.state.move_cursor_to(len(self.state.get_input()))
                return
            if char == "\x15":  # Ctrl+U
                self.state.clear_input()
                return
            if char == "\x17":  # Ctrl+W
                self.state.delete_word_back()
                return

            # Backspace
            if char == "\x7f":
                self.state.backspace()
                self._update_autocomplete()
                return

            # Tab: accept autocomplete
            if char == "\t":
                if self.state.autocomplete_active:
                    self.state.accept_autocomplete()
                return

            # Regular character
            if char >= " ":
                self.state.insert_char(char)
                self._update_autocomplete()

    def _handle_escape_sequence(self, seq: str):
        """Handle escape sequence."""
        if seq == "[A":  # Up arrow
            self.state.select_autocomplete(-1)
        elif seq == "[B":  # Down arrow
            self.state.select_autocomplete(1)
        elif seq == "[D":  # Left arrow
            self.state.move_cursor(-1)
        elif seq == "[C":  # Right arrow
            self.state.move_cursor(1)
        elif seq == "[H":  # Home
            self.state.move_cursor_to(0)
        elif seq == "[F":  # End
            self.state.move_cursor_to(len(self.state.get_input()))
        elif seq == "[3~":  # Delete
            self.state.delete()
        else:
            # Unknown - dismiss autocomplete
            self.state.dismiss_autocomplete()

    def _handle_recording(self):
        """RECORDING state: fallback handler.

        Note: Recording is now handled inline in _handle_idle() to maintain
        the raw terminal context. This method serves as a fallback in case
        the state machine somehow ends up in RECORDING without the inline flow.
        """
        if not self.voice:
            self.state.transition(TUIState.IDLE)
            return

        # If we somehow got here, just end recording and move on
        self.logger.warning("_handle_recording called unexpectedly, ending recording")
        self.voice.end_recording()
        self._transcription_deadline = time.time() + 30.0
        self.state.transition(TUIState.TRANSCRIBING)

    def _handle_transcribing(self):
        """TRANSCRIBING state: wait for transcription result."""
        # Poll for transcription
        if self.voice:
            text = self.voice.poll_transcription(timeout=0.1)
            if text:
                # Put transcription in input buffer for editing
                self.state.set_input(text)
                self._transcription_deadline = None
                self.state.transition(TUIState.IDLE)
                return
        if self._transcription_deadline and time.time() > self._transcription_deadline:
            # Timeout: inform user, clear input, reset to IDLE
            self.state.add_message(
                "system",
                "Voice transcription timed out. Please try recording again.",
            )
            self.state.clear_input()
            self.state.set_status("Ready")
            self._transcription_deadline = None
            self.state.transition(TUIState.IDLE)
            return

        time.sleep(0.05)

    def _handle_sending(self):
        """SENDING state: wait for response to start."""
        # Just wait - event monitor handles transition to STREAMING
        time.sleep(0.05)

    def _handle_streaming(self):
        """STREAMING state: wait for response completion."""
        # Just wait - event monitor handles transition to IDLE
        time.sleep(0.05)

    def _handle_error(self):
        """ERROR state: wait for acknowledgment."""
        with RawTerminal() as term:
            char = term.read_char(timeout=0.1)
            if char:
                # Any key clears error
                self.state.clear_error()

    # ---------------------------------------------------------------- Input Processing

    def _submit_input(self, text: str):
        """Submit text input."""
        # Handle slash commands
        if text.startswith("/"):
            if self._handle_slash_command(text):
                self.state.clear_input()
                return

        # Add user message to conversation
        self.state.add_message("user", text)
        self.state.clear_input()

        # Send to backend
        request_count = self.state.increment_requests()
        request_id = f"robust_{request_count}_{int(time.time() * 1000) % 100000}"

        self.state.transition(TUIState.SENDING)

        if self.event_bus:
            self.event_bus.publish(
                TranscriptionCompleteEvent(
                    request_id=request_id,
                    text=text,
                    confidence=None,
                    duration_ms=0.0,
                )
            )

    def _update_autocomplete(self):
        """Update autocomplete suggestions based on input."""
        text = self.state.get_input()

        # Find @ trigger
        at_pos = text.rfind("@")
        if at_pos == -1:
            self.state.dismiss_autocomplete()
            return

        # Get partial path after @
        partial = text[at_pos + 1 :]

        # Don't autocomplete if there's a space after @
        if " " in partial:
            self.state.dismiss_autocomplete()
            return

        # Get matching files
        files = self.file_cache.get_files()
        suggestions = [f for f in files if partial.lower() in f.lower()]

        # Limit suggestions
        suggestions = suggestions[:50]

        if suggestions:
            self.state.set_autocomplete(suggestions)
        else:
            self.state.dismiss_autocomplete()

    # ---------------------------------------------------------------- Slash Commands

    def _handle_slash_command(self, cmd: str) -> bool:
        """Handle slash command. Returns True if handled."""
        parts = cmd.strip().split(maxsplit=1)
        command = parts[0].lower()

        if command == "/help":
            self.state.add_message("system", self._help_text())
            return True

        if command == "/config":
            self.state.add_message("system", self._config_text())
            return True

        if command == "/models":
            self.state.add_message("system", self._models_text())
            return True

        if command == "/compact":
            enabled = self.state.toggle_compact()
            self.state.add_message(
                "system", f"Compact mode {'enabled' if enabled else 'disabled'}."
            )
            return True

        if command == "/voice":
            self._toggle_voice_mode()
            return True

        if command == "/status":
            self.state.add_message("system", self._status_text())
            return True

        if command == "/up":
            lines = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 10
            self.state.scroll(lines)
            return True

        if command == "/down":
            lines = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 10
            self.state.scroll(-lines)
            return True

        if command == "/pageup":
            _, height = get_terminal_size()
            self.state.scroll(max(1, height - 10))
            return True

        if command == "/pagedown":
            _, height = get_terminal_size()
            self.state.scroll(-max(1, height - 10))
            return True

        if command == "/top":
            self.state.scroll_to_top()
            return True

        if command == "/bottom":
            self.state.scroll_to_bottom()
            return True

        if command == "/clear":
            self.state.clear_conversation()
            self.state.add_message("system", "Conversation cleared.")
            return True

        if command in ("/quit", "/exit"):
            self._shutdown_requested = True
            return True

        return False

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
            ("/clear", "Clear conversation history"),
            ("/quit", "Exit the TUI"),
        ]
        lines = ["Robust TUI - Commands", ""]
        for cmd, desc in commands:
            lines.append(f"{cmd.ljust(14)} {desc}")
        lines.extend(
            [
                "",
                "Input shortcuts:",
                "  Arrows     Move cursor / navigate autocomplete",
                "  Ctrl+A/E   Start/end of line",
                "  Ctrl+U     Clear line",
                "  Ctrl+W     Delete word",
                "  Tab        Accept autocomplete",
                "  @filename  Autocomplete file paths",
            ]
        )
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
        return "\n".join(
            [
                "LLM Models & API Keys",
                "",
                f"OpenAI    : {status(has_openai)}",
                f"Anthropic : {status(has_anthropic)}",
                f"Google    : {status(has_google)}",
            ]
        )

    def _status_text(self) -> str:
        """Return runtime status."""
        snapshot = self.state.snapshot()
        workers = (
            "Running" if self.process_manager else "Not started"
        )
        event_bus = "Connected" if self.event_bus else "Not connected"
        voice_status = "Active" if (self.voice and self.voice.is_active) else "Inactive"
        return "\n".join(
            [
                "System Status",
                "",
                f"State            : {snapshot.state.name}",
                f"Status           : {snapshot.status_message}",
                f"Requests sent    : {snapshot.request_count}",
                f"Compact mode     : {'ON' if snapshot.compact_mode else 'OFF'}",
                f"Voice mode       : {'ON' if snapshot.voice_mode else 'OFF'}",
                f"Voice service    : {voice_status}",
                f"Event bus        : {event_bus}",
                f"Workers          : {workers}",
            ]
        )

    # ---------------------------------------------------------------- Voice Mode

    def _toggle_voice_mode(self):
        """Toggle voice mode."""
        if self.voice and self.voice.is_active:
            # Disable voice mode
            self.voice.stop()
            self.voice = None
            self.state.set_voice_mode(False)
            self.state.add_message("system", "Voice mode disabled.")
        else:
            # Enable voice mode
            self._start_voice_service()

    def _start_voice_service(self):
        """Start voice service."""
        if not self.transcription_mailbox:
            self.state.add_message("system", "Cannot enable voice: mailbox not ready.")
            return

        self.voice = VoiceService(
            event_bus=self.event_bus,
            transcription_mailbox=self.transcription_mailbox,
            logger=self.logger,
        )

        # Setup callbacks
        self.voice.on_recording_start = lambda: self.state.set_status("Recording...")
        self.voice.on_recording_stop = lambda: self.state.set_status("Transcribing...")
        self.voice.on_transcription = lambda text: self._on_voice_transcription(text)
        self.voice.on_error = lambda msg: self.state.add_message("system", f"[Voice error: {msg}]")

        if self.voice.start():
            self.state.set_voice_mode(True)
            self.state.add_message(
                "system",
                "Voice mode enabled.\n\n"
                "Press and hold SPACE to record your message.\n"
                "Release SPACE to transcribe, then edit if needed.\n"
                "Press ENTER to send. Type /voice to disable.",
            )
        else:
            self.voice = None
            self.state.add_message(
                "system", "Failed to start voice mode. Check audio device availability."
            )

    def _on_voice_transcription(self, text: str):
        """Handle voice transcription result."""
        self.state.set_input(text)
        self.state.set_status("Ready")
        self._transcription_deadline = None
        self.state.transition(TUIState.IDLE)

    def _render_recording_indicator(self, recording: bool):
        """Render a simple recording indicator directly to terminal.

        This bypasses the render engine to avoid interference with
        raw terminal mode during PTT recording.
        """
        from tui.render_engine import ANSI, get_terminal_size

        width, height = get_terminal_size()

        # Position at bottom of screen (where status indicator would be)
        status_row = height - 1

        # Build the indicator line
        if recording:
            # Red pulsing recording indicator
            indicator = f"\033[1;31m  🎤  RECORDING - Hold SPACE, release to send\033[0m"
        else:
            # Yellow transcribing indicator
            indicator = f"\033[1;33m  ✍️   Transcribing...\033[0m"

        # Pad to full width to clear previous content
        # Note: emoji width is tricky, so we use generous padding
        visible_len = 45 if recording else 20
        padding = " " * max(0, width - visible_len)

        # Write directly to stdout
        output = (
            ANSI.HIDE_CURSOR
            + ANSI.move_to(status_row, 1)
            + ANSI.CLEAR_LINE
            + indicator
            + padding
        )
        sys.stdout.write(output)
        sys.stdout.flush()

    # ---------------------------------------------------------------- Event Monitor

    def _event_monitor_loop(self):
        """Background thread to monitor events."""
        while not self._shutdown_requested:
            try:
                # Process progress events (agent execution updates)
                if self.progress_mailbox:
                    self._process_progress_events()

                # Process streaming chunks
                if self.streaming_mailbox:
                    self._process_streaming_events()

                # Process response completion
                if self.response_mailbox:
                    self._process_response_events()

                # Process transcription (for voice mode - only when not in voice flow)
                if self.transcription_mailbox and self.state.get_state() == TUIState.TRANSCRIBING:
                    if self.voice:
                        self.voice.poll_transcription(timeout=0.01)

                time.sleep(0.02)

            except Exception as e:
                self.logger.error(f"Event monitor error: {e}")
                time.sleep(0.1)

    def _process_progress_events(self):
        """Process agent progress events."""
        try:
            while True:
                event = self.progress_mailbox.receive(timeout=0.01)
                if event is None:
                    break

                if isinstance(event, AgentProgressEvent):
                    # Update progress message in state
                    self.state.set_progress(event.message)

        except Empty:
            pass

    def _process_streaming_events(self):
        """Process streaming chunk events."""
        try:
            while True:
                event = self.streaming_mailbox.receive(timeout=0.01)
                if event is None:
                    break

                if isinstance(event, StreamingChunkEvent):
                    # Transition to streaming if we were sending
                    if self.state.get_state() == TUIState.SENDING:
                        self.state.transition(TUIState.STREAMING)

                    # Update streaming text
                    current_text = self.state.snapshot().streaming_text
                    if event.chunk:
                        new_text = current_text + event.chunk
                        self.state.update_streaming(
                            event.request_id,
                            new_text,
                            is_final=event.is_final,
                        )

                    # Handle final chunk
                    if event.is_final:
                        self.state.transition(TUIState.IDLE)

        except Empty:
            pass

    def _process_response_events(self):
        """Process agent response completion events."""
        try:
            event = self.response_mailbox.receive(timeout=0.01)
            if event and isinstance(event, AgentResponseCompleteEvent):
                # Clear progress message since response is complete
                self.state.clear_progress()

                # Finalize any pending streaming
                self.state.finalize_streaming()

                # If we got a response without streaming, add it
                if self.state.get_state() in (TUIState.SENDING, TUIState.STREAMING):
                    content = event.content or event.spoken_response or "[No response]"
                    meta = None
                    if event.duration_ms or event.tools_used:
                        meta_parts = []
                        if event.duration_ms:
                            meta_parts.append(f"Time: {event.duration_ms:.0f} ms")
                        if event.tools_used:
                            meta_parts.append(f"Tools: {', '.join(event.tools_used)}")
                        meta = " | ".join(meta_parts)

                    # Only add if not already added via streaming
                    if not self.state.snapshot().streaming_text:
                        entry = self.state.add_message("agent", content)
                        # TODO: Add meta support to conversation entries

                    self.state.transition(TUIState.IDLE)

        except Empty:
            pass

    def _file_cache_refresh_loop(self):
        """Background thread to refresh file cache."""
        while not self._shutdown_requested:
            time.sleep(10)
            if not self._shutdown_requested:
                self.file_cache.refresh_background()


def main() -> int:
    """Entry point for robust TUI."""
    try:
        config = load_app_config()
        config.runtime.headless = True
        tui = RobustTUI(config)
        tui.run()
        return 0
    except Exception as e:
        print(f"\n[Error: {e}]", file=sys.stderr)
        import traceback

        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
