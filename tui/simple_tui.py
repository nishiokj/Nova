"""Simple, lightweight TUI for the voice agent that keeps input anchored.

This version focuses on keeping the green input box pinned to the bottom of
the terminal while streaming output is rendered above it. Conversation history
is stored in-memory so the whole screen can be re-rendered to preserve layout.
"""

from __future__ import annotations

import os
import sys
import time
import threading
import readline
import shutil
from typing import Dict, List, Optional, Tuple
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
)


# Terminal colors and formatting
class Colors:
    """ANSI color codes for terminal output."""

    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"

    # Regular colors
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


def get_terminal_width() -> int:
    """Compatibility helper for legacy helpers."""
    width, _ = get_terminal_size()
    return width


def clear_screen():
    """Clear the terminal screen."""
    os.system("clear" if os.name != "nt" else "cls")


def draw_box(text: str, width: Optional[int] = None, title: str = "") -> str:
    """Draw a box around text with optional title."""
    if width is None:
        width = get_terminal_width()

    # Guard against extremely small widths
    width = max(20, width)

    # Box drawing characters
    top_left = "╭"
    top_right = "╮"
    bottom_left = "╰"
    bottom_right = "╯"
    horizontal = "─"
    vertical = "│"

    lines: List[str] = []

    if title:
        title_text = f" {title} "
        title_len = len(title_text)
        left_border = horizontal * 2
        # Keep total width consistent with non-titled boxes
        available = max(0, (width - 2) - len(left_border) - title_len)
        right_border = horizontal * available
        lines.append(f"{top_left}{left_border}{title_text}{right_border}{top_right}")
    else:
        lines.append(f"{top_left}{horizontal * (width - 2)}{top_right}")

    for raw_line in text.split("\n"):
        content = raw_line[: width - 4]
        padding = max(0, width - 4 - len(content))
        lines.append(f"{vertical} {content}{' ' * padding} {vertical}")

    lines.append(f"{bottom_left}{horizontal * (width - 2)}{bottom_right}")
    return "\n".join(lines)


class SimpleTUI:
    """Lightweight TUI that integrates with backend event bus."""

    def __init__(self, config: AppConfig):
        self.config = config
        self.running = False
        self.request_count = 0

        # Status tracking
        self.status = "Ready"
        self.current_request_id: Optional[str] = None
        self.last_response = ""

        # Event bus integration
        self.event_bus: Optional[EventBus] = None
        self.response_mailbox: Optional[Mailbox] = None
        self.tts_mailbox: Optional[Mailbox] = None

        # Conversation display
        self._conversation: List[Dict[str, str]] = []
        self._conversation_lock = threading.Lock()
        self._status_stack: List[Dict[str, str]] = []
        self._response_event = threading.Event()
        self._input_bottom_border: Optional[str] = None

        # UI mode
        self.compact = False
        self.use_colors = Colors.supports_color()

        # Scrolling support
        self.scroll_offset = 0  # Lines to scroll up from bottom

        # Configure readline for better input editing
        self._setup_readline()

    # ------------------------------------------------------------------ UI utils
    def _setup_readline(self):
        """Configure readline for better input editing."""
        readline.parse_and_bind("tab: complete")
        readline.set_history_length(1000)
        readline.parse_and_bind("set editing-mode emacs")

    def _color(self, text: str, color: str) -> str:
        """Apply color to text if colors are supported."""
        if self.use_colors:
            return f"{color}{text}{Colors.RESET}"
        return text

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
        # Auto-scroll to bottom when new message arrives (unless user is scrolling)
        # Only reset if not actively scrolling
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

    def _build_header_lines(self, width: int, scroll_info: str = "") -> List[str]:
        """Return lines that form the header."""
        lines: List[str] = []
        title = "Voice Agent - Text Interface"
        lines.append("")
        lines.append(self._color(title.center(width), Colors.BRIGHT_CYAN + Colors.BOLD))

        status_text = f"Status: {self.status}"
        if self.compact:
            status_text += " | Compact: ON"

        meta = f"Requests: {self.request_count}"
        if scroll_info:
            meta += f" | {scroll_info}"

        lines.append("")
        lines.append(self._color(f"{status_text} | {meta}", Colors.DIM))
        lines.append(self._color("─" * width, Colors.BRIGHT_BLACK))
        return lines

    def _format_entry(self, entry: Dict[str, str], width: int) -> List[str]:
        """Format a single conversation entry into printable lines."""
        role = entry["role"]
        text = entry["text"] or "(empty)"

        titles = {
            "user": "You",
            "agent": "Agent",
            "system": "System",
            "status": "Status",
        }
        colors = {
            "user": Colors.BRIGHT_GREEN,
            "agent": Colors.BRIGHT_BLUE,
            "system": Colors.BRIGHT_MAGENTA,
            "status": Colors.BRIGHT_YELLOW,
        }

        box = draw_box(text, width, title=titles.get(role, role.title()))
        color = colors.get(role)

        if color:
            lines = [self._color(line, color) for line in box.splitlines()]
        else:
            lines = box.splitlines()

        lines.append("")  # spacer between entries
        return lines

    def _build_history_lines(self, width: int, max_lines: int) -> Tuple[List[str], int, int]:
        """Collect the last entries that fit within the available lines.

        Returns:
            Tuple of (lines to display, total lines available, current offset)
        """
        with self._conversation_lock:
            entries = list(self._conversation)

        all_lines: List[str] = []
        for entry in entries:
            all_lines.extend(self._format_entry(entry, width))

        # Remove trailing spacer if present
        if all_lines and not all_lines[-1].strip():
            all_lines.pop()

        total_lines = len(all_lines)

        # Clamp scroll offset to valid range
        max_scroll = max(0, total_lines - max_lines)
        self.scroll_offset = max(0, min(self.scroll_offset, max_scroll))

        # Apply scrolling - show lines from (end - max_lines - offset) to (end - offset)
        if total_lines > max_lines:
            end_idx = total_lines - self.scroll_offset
            start_idx = max(0, end_idx - max_lines)
            display_lines = all_lines[start_idx:end_idx]
        else:
            display_lines = all_lines

        return display_lines, total_lines, self.scroll_offset

    def _draw_input_box(
        self,
        width: int,
        prompt_text: str,
        interactive: bool,
        placeholder: str = "",
    ):
        """Render the input box and optionally prepare it for user typing."""
        top = self._color("╭" + "─" * (width - 2) + "╮", Colors.BRIGHT_GREEN)
        print(top)

        prompt_line = f"│ {prompt_text}"
        prompt_padding = max(0, width - len(prompt_line) - 1)
        prompt_render = f"{prompt_line}{' ' * prompt_padding}│"
        print(self._color(prompt_render, Colors.BRIGHT_GREEN))

        if interactive:
            prefix = self._color("│ ", Colors.BRIGHT_GREEN)
            print(prefix, end="", flush=True)
            self._input_bottom_border = self._color(
                "╰" + "─" * (width - 2) + "╯", Colors.BRIGHT_GREEN
            )
        else:
            placeholder_text = placeholder or ""
            content = placeholder_text[: width - 4]
            padding = max(0, width - 4 - len(content))
            middle = f"│ {content}{' ' * padding} │"
            print(self._color(middle, Colors.BRIGHT_GREEN))
            bottom = self._color("╰" + "─" * (width - 2) + "╯", Colors.BRIGHT_GREEN)
            print(bottom)
            self._input_bottom_border = None

    def _finish_input_box(self):
        """Draw the closing border after user input completes."""
        if self._input_bottom_border:
            print(self._input_bottom_border)
            self._input_bottom_border = None

    def _render_screen(
        self,
        prompt_text: str,
        interactive: bool,
        placeholder: str = "",
    ):
        """Clear the screen and re-render header, history, and the input box."""
        width, height = get_terminal_size()

        # Calculate available space for history
        input_height = 4  # top border, prompt, middle/bottom
        header_height = 5  # Will be calculated after building header
        content_height = max(2, height - header_height - input_height - 1)

        # Build history with scroll support
        history_lines, total_lines, current_offset = self._build_history_lines(width, content_height)

        # Build scroll info for header
        scroll_info = ""
        if total_lines > content_height:
            if current_offset > 0:
                scroll_info = f"↑ Scroll: {current_offset} lines up"
            else:
                scroll_info = "↓ At bottom"

        header_lines = self._build_header_lines(width, scroll_info)

        clear_screen()
        for line in header_lines:
            print(line)
        print()

        for line in history_lines:
            print(line)

        remaining = content_height - len(history_lines)
        for _ in range(max(0, remaining)):
            print()

        self._draw_input_box(width, prompt_text, interactive, placeholder)

    # ---------------------------------------------------------- Backend wiring
    def _setup_event_bus(self):
        """Setup event bus and mailboxes for backend integration."""
        from multiprocessing import Queue as MPQueue

        self.event_bus = EventBus()

        # Subscribe to agent responses
        self.response_mailbox = Mailbox("tui_responses", MPQueue())
        self.response_mailbox.subscribe_to(self.event_bus, EventType.AGENT_RESPONSE_COMPLETE)

        # Subscribe to TTS events for status updates
        self.tts_mailbox = Mailbox("tui_tts", MPQueue())
        self.tts_mailbox.subscribe_to(self.event_bus, EventType.TTS_REQUESTED)

    def _start_backend_workers(self):
        """Start backend workers in TUI-compatible mode."""
        import multiprocessing as mp
        from app.process_manager import ProcessManager
        from workers.console_tts_worker import ConsoleTTSWorker
        from workers.service_rep_worker import ServiceRepWorker
        from util.config import ServiceRepConfig

        if mp.get_start_method(allow_none=True) != "spawn":
            mp.set_start_method("spawn", force=True)

        # Set environment variables to suppress worker logging
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
            },
        )

        self.process_manager.start()
        time.sleep(1.0)

    def _handle_agent_response(self, event: AgentResponseCompleteEvent):
        """Store agent response for rendering and signal completion."""
        response_lines = event.spoken_response or ""
        if not response_lines.strip():
            response_lines = "[No response]"

        if not self.compact and (event.tools_used or event.duration_ms):
            meta = []
            if event.duration_ms:
                meta.append(f"⏱  {event.duration_ms:.0f} ms")
            if event.tools_used:
                meta.append(f"🔧 {', '.join(event.tools_used)}")
            if meta:
                response_lines += "\n\n" + " | ".join(meta)

        self.last_response = response_lines
        self.current_request_id = None
        self.status = "Ready"

        self._pop_status()
        self._add_message("agent", response_lines)
        self._response_event.set()

    def _monitor_events(self):
        """Background thread to monitor events and update status."""
        while self.running:
            try:
                if self.response_mailbox:
                    try:
                        event = self.response_mailbox.receive(timeout=0.1)
                    except Empty:
                        event = None

                    if event and isinstance(event, AgentResponseCompleteEvent):
                        self._handle_agent_response(event)

                if self.tts_mailbox:
                    try:
                        _event = self.tts_mailbox.receive(timeout=0.1)
                        if _event and isinstance(_event, TTSRequestedEvent):
                            pass
                    except Empty:
                        pass

            except Exception as exc:
                self._add_message("system", f"[Event monitor error: {exc}]")
                time.sleep(0.2)

            time.sleep(0.05)

    # ------------------------------------------------------------- UI commands
    def _help_text(self) -> str:
        """Return help text for slash commands."""
        commands = [
            ("/help", "Show this help message"),
            ("/config", "Display current configuration summary"),
            ("/models", "View API key status and model hints"),
            ("/compact", "Toggle compact output mode"),
            ("/status", "Show system status"),
            ("/up [N]", "Scroll up N lines (default: 10)"),
            ("/down [N]", "Scroll down N lines (default: 10)"),
            ("/pageup", "Scroll up one page"),
            ("/pagedown", "Scroll down one page"),
            ("/top", "Scroll to top of history"),
            ("/bottom", "Scroll to bottom of history"),
            ("/quit", "Exit the TUI"),
        ]
        lines = ["Voice Agent TUI - Commands", ""]
        for cmd, desc in commands:
            lines.append(f"{cmd.ljust(14)} {desc}")
        lines.append("")
        lines.extend(
            [
                "Input shortcuts:",
                "  ↑/↓  Navigate command history",
                "  Ctrl+A/E  Start/end of line",
                "  Tab  Completion where available",
            ]
        )
        return "\n".join(lines)

    def _config_text(self) -> str:
        """Return configuration summary as plain text."""
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
        """Return API key/model info text."""
        has_openai = bool(os.getenv("OPENAI_API_KEY"))
        has_anthropic = bool(os.getenv("ANTHROPIC_API_KEY"))
        has_google = bool(os.getenv("GOOGLE_API_KEY"))
        status = lambda ok: "✓ Configured" if ok else "✗ Not configured"
        lines = [
            "LLM Models & API Keys",
            "",
            f"OpenAI    : {status(has_openai)}",
            f"Anthropic : {status(has_anthropic)}",
            f"Google    : {status(has_google)}",
            "",
            "To update models, edit the harness tier config:",
            f"  {self.config.harness.config_path}",
        ]
        return "\n".join(lines)

    def _status_text(self) -> str:
        """Return current runtime status."""
        workers = (
            "Running"
            if hasattr(self, "process_manager") and self.process_manager
            else "Not started"
        )
        event_bus = "Connected" if self.event_bus else "Not connected"
        lines = [
            "System Status",
            "",
            f"Status           : {self.status}",
            f"Requests sent    : {self.request_count}",
            f"Compact mode     : {'ON' if self.compact else 'OFF'}",
            f"Event bus        : {event_bus}",
            f"Workers          : {workers}",
        ]
        return "\n".join(lines)

    def _handle_slash_command(self, cmd: str) -> bool:
        """Handle slash commands locally. Returns True if handled."""
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
            mode = "enabled" if self.compact else "disabled"
            self._add_message("system", f"Compact mode {mode}.")
            return True
        if command == "/status":
            self._add_message("system", self._status_text())
            return True
        if command == "/up":
            # Scroll up by N lines (default 10)
            lines = 10
            if len(parts) > 1:
                try:
                    lines = int(parts[1])
                except ValueError:
                    lines = 10
            self.scroll_offset += lines
            return True
        if command == "/down":
            # Scroll down by N lines (default 10)
            lines = 10
            if len(parts) > 1:
                try:
                    lines = int(parts[1])
                except ValueError:
                    lines = 10
            self.scroll_offset = max(0, self.scroll_offset - lines)
            return True
        if command == "/pageup":
            # Scroll up by one page (terminal height)
            _, height = get_terminal_size()
            page_size = max(1, height - 10)  # Approximate content area
            self.scroll_offset += page_size
            return True
        if command == "/pagedown":
            # Scroll down by one page
            _, height = get_terminal_size()
            page_size = max(1, height - 10)
            self.scroll_offset = max(0, self.scroll_offset - page_size)
            return True
        if command == "/top":
            # Scroll to the very top
            self.scroll_offset = 999999  # Will be clamped by render logic
            return True
        if command == "/bottom":
            # Scroll to the bottom
            self.scroll_offset = 0
            return True
        if command in ["/quit", "/exit"]:
            self.running = False
            self._add_message("system", "Shutting down...")
            return True
        return False

    # -------------------------------------------------------------- I/O helpers
    def _suppress_console_logging(self):
        """Suppress console logging to keep TUI clean."""
        import logging

        os.makedirs("logs", exist_ok=True)

        logging.basicConfig(
            level=logging.WARNING,
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            handlers=[logging.FileHandler("logs/tui.log", mode="a")],
            force=True,
        )

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

    def _get_input(self) -> str:
        """Render the UI and wait for user input."""
        self._render_screen("Enter message", interactive=True)
        try:
            text = input().strip()
        except EOFError:
            self.running = False
            text = ""
        except KeyboardInterrupt:
            self.running = False
            text = ""
        finally:
            self._finish_input_box()
        return text

    def _send_message(self, text: str):
        """Send text message to agent harness."""
        self.request_count += 1
        request_id = f"tui_{self.request_count}_{int(time.time() * 1000) % 100000}"
        self.current_request_id = request_id
        self.status = "Processing..."
        self._push_status("⏳ Processing request...")

        if self.event_bus is None:
            raise RuntimeError("Event bus not initialized")

        self.event_bus.publish(
            TranscriptionCompleteEvent(
                request_id=request_id,
                text=text,
                confidence=None,
                duration_ms=0.0,
            )
        )

    def _wait_for_response(self):
        """Block until the agent response arrives or the TUI stops."""
        while self.running:
            if self._response_event.wait(timeout=0.1):
                self._response_event.clear()
                break

    # ---------------------------------------------------------------- Main loop
    def run(self):
        """Main TUI loop."""
        self._suppress_console_logging()
        self._add_message("system", "Type /help for commands or start chatting.")
        self._render_screen("Starting...", interactive=False, placeholder="Loading...")

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

        self._add_message("system", "✓ Backend ready.")
        self._render_screen("Enter message", interactive=False, placeholder="Ready.")

        self.running = True
        monitor_thread = threading.Thread(
            target=self._monitor_events, daemon=True, name="EventMonitor"
        )
        monitor_thread.start()

        try:
            while self.running:
                text = self._get_input()

                if not self.running:
                    break

                if not text:
                    continue

                if text.startswith("/"):
                    handled = self._handle_slash_command(text)
                    if handled:
                        if not self.running:
                            break
                        continue

                self._add_message("user", text)
                self._render_screen(
                    "Waiting for agent response...",
                    interactive=False,
                    placeholder="Processing...",
                )

                try:
                    self._response_event.clear()
                    self._send_message(text)
                    self._wait_for_response()
                except Exception as exc:
                    self._pop_status()
                    self._add_message("system", f"[Error sending message: {exc}]")
                    self.status = "Error"

        finally:
            self._shutdown()

    def _shutdown(self):
        """Clean shutdown."""
        self.running = False
        self._add_message("system", "✓ Goodbye!")
        self._render_screen("Shutting down...", interactive=False, placeholder="")

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
