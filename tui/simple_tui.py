"""Simple, lightweight TUI for voice agent.

Integrates directly with the backend's event bus pattern to provide:
- Text input (bypasses audio processing)
- Real-time status indicators (thinking/processing)
- Slash commands (/config, /models, /help, /compact)
- Clean, minimal interface

Architecture:
- Subscribes to backend EventBus for status updates
- Publishes TranscriptionCompleteEvent for text input
- Handles slash commands locally
- Shows lightweight status similar to Claude Code
"""

from __future__ import annotations

import os
import sys
import time
import threading
import readline
import shutil
from typing import Optional
from queue import Queue, Empty
from io import StringIO
from contextlib import redirect_stdout, redirect_stderr

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
            hasattr(sys.stdout, 'isatty') and
            sys.stdout.isatty() and
            os.getenv('TERM') != 'dumb'
        )


def get_terminal_width() -> int:
    """Get current terminal width."""
    try:
        return shutil.get_terminal_size().columns
    except Exception:
        return 80


def clear_screen():
    """Clear the terminal screen."""
    os.system('clear' if os.name != 'nt' else 'cls')


def draw_box(text: str, width: Optional[int] = None, title: str = "") -> str:
    """Draw a box around text with optional title.

    Args:
        text: Content to put in the box
        width: Box width (auto-detected if None)
        title: Optional title for the box

    Returns:
        String with box drawn around content
    """
    if width is None:
        width = get_terminal_width()

    # Box drawing characters
    top_left = "╭"
    top_right = "╮"
    bottom_left = "╰"
    bottom_right = "╯"
    horizontal = "─"
    vertical = "│"

    # Build box
    lines = []

    # Top border with optional title
    if title:
        title_text = f" {title} "
        title_len = len(title_text)
        left_border = horizontal * 2
        right_border = horizontal * (width - 4 - title_len - 2)
        lines.append(f"{top_left}{left_border}{title_text}{right_border}{top_right}")
    else:
        lines.append(f"{top_left}{horizontal * (width - 2)}{top_right}")

    # Content
    for line in text.split('\n'):
        # Truncate or pad line to fit
        content = line[:width - 4]
        padding = width - 4 - len(content)
        lines.append(f"{vertical} {content}{' ' * padding} {vertical}")

    # Bottom border
    lines.append(f"{bottom_left}{horizontal * (width - 2)}{bottom_right}")

    return '\n'.join(lines)


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

        # Compact mode
        self.compact = False

        # Color support
        self.use_colors = Colors.supports_color()

        # Configure readline for better input editing
        self._setup_readline()

    def _setup_readline(self):
        """Configure readline for better input editing."""
        # Enable tab completion
        readline.parse_and_bind('tab: complete')
        # Set up history
        readline.set_history_length(1000)
        # Enable emacs-style editing (ctrl-a, ctrl-e, etc.)
        readline.parse_and_bind('set editing-mode emacs')

    def _color(self, text: str, color: str) -> str:
        """Apply color to text if colors are supported."""
        if self.use_colors:
            return f"{color}{text}{Colors.RESET}"
        return text

    def _print_header(self):
        """Print TUI header."""
        clear_screen()
        width = get_terminal_width()

        # Title
        title = "Voice Agent - Text Interface"
        title_color = self._color(title, Colors.BRIGHT_CYAN + Colors.BOLD)
        print(f"\n{title_color.center(width + len(title_color) - len(title))}\n")

        # Status bar
        status_text = f"Status: {self.status}"
        if self.compact:
            status_text += " | Compact: ON"
        requests_text = f"Requests: {self.request_count}"

        status_line = f"{status_text} | {requests_text}"
        status_color = self._color(status_line, Colors.DIM)
        print(f"{status_color}\n")
        print(self._color("─" * width, Colors.BRIGHT_BLACK))

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
        from app.process_manager import ProcessManager
        from workers.console_tts_worker import ConsoleTTSWorker
        from workers.service_rep_worker import ServiceRepWorker
        from util.config import ServiceRepConfig

        # Set environment variables to suppress worker logging
        # This will be inherited by child processes
        os.environ['LOG_TO_CONSOLE'] = 'false'
        os.environ['LOG_LEVEL'] = 'WARNING'

        # Create process manager
        self.process_manager = ProcessManager(
            event_bus=self.event_bus,
            check_interval=self.config.runtime.health_check_interval_s
        )

        # Register console TTS worker (no audio output)
        self.process_manager.register_worker(
            worker_id="tts",
            worker_class=ConsoleTTSWorker,
            subscribe_to=[EventType.TTS_REQUESTED],
            worker_kwargs={}
        )

        # Register service rep worker (agent harness)
        service_rep_config = ServiceRepConfig(
            enabled=True,
            llm_config=None
        )
        self.process_manager.register_worker(
            worker_id="service_rep",
            worker_class=ServiceRepWorker,
            subscribe_to=[EventType.TRANSCRIPTION_COMPLETE],
            worker_kwargs={
                "event_bus": self.event_bus,
                "service_rep_config": service_rep_config,
                "harness_config_path": self.config.harness.config_path
            }
        )

        # Start workers
        self.process_manager.start()
        time.sleep(1.0)  # Let workers initialize

    def _monitor_events(self):
        """Background thread to monitor events and update status."""
        while self.running:
            try:
                # Check for agent responses
                if self.response_mailbox:
                    try:
                        event = self.response_mailbox.receive(timeout=0.1)
                        if event and isinstance(event, AgentResponseCompleteEvent):
                            self.status = "Ready"
                            self.last_response = event.spoken_response
                            self.current_request_id = None
                            self._display_response(event)
                    except Empty:
                        pass

                # Check for TTS events (for status updates)
                if self.tts_mailbox:
                    try:
                        event = self.tts_mailbox.receive(timeout=0.1)
                        if event and isinstance(event, TTSRequestedEvent):
                            # Just acknowledge we got it
                            pass
                    except Empty:
                        pass

            except Exception as e:
                print(f"\n[Error monitoring events: {e}]", file=sys.stderr)

            time.sleep(0.1)

    def _display_response(self, event: AgentResponseCompleteEvent):
        """Display agent response in compact or full mode."""
        width = get_terminal_width()

        if self.compact:
            # Compact mode: just the response
            print(f"\n{event.spoken_response}\n")
        else:
            # Full mode: with metadata and nice formatting
            print()
            print(self._color("╭" + "─" * (width - 2) + "╮", Colors.BRIGHT_BLUE))

            # Response content
            response_lines = event.spoken_response.split('\n')
            for line in response_lines:
                # Word wrap if needed
                if len(line) <= width - 4:
                    padding = width - 4 - len(line)
                    border = self._color("│", Colors.BRIGHT_BLUE)
                    print(f"{border} {line}{' ' * padding} {border}")
                else:
                    # Simple word wrap
                    words = line.split()
                    current_line = ""
                    for word in words:
                        if len(current_line) + len(word) + 1 <= width - 4:
                            current_line += (word + " ")
                        else:
                            padding = width - 4 - len(current_line)
                            border = self._color("│", Colors.BRIGHT_BLUE)
                            print(f"{border} {current_line}{' ' * padding} {border}")
                            current_line = word + " "
                    if current_line:
                        padding = width - 4 - len(current_line)
                        border = self._color("│", Colors.BRIGHT_BLUE)
                        print(f"{border} {current_line}{' ' * padding} {border}")

            # Metadata footer
            if event.tools_used or event.duration_ms:
                print(self._color("├" + "─" * (width - 2) + "┤", Colors.BRIGHT_BLUE))
                metadata = []
                if event.duration_ms:
                    metadata.append(f"⏱  {event.duration_ms:.0f}ms")
                if event.tools_used:
                    metadata.append(f"🔧 {', '.join(event.tools_used)}")

                meta_text = " | ".join(metadata)
                meta_color = self._color(meta_text, Colors.DIM)
                padding = width - 4 - len(meta_text)
                border = self._color("│", Colors.BRIGHT_BLUE)
                print(f"{border} {meta_color}{' ' * padding} {border}")

            print(self._color("╰" + "─" * (width - 2) + "╯", Colors.BRIGHT_BLUE))
            print()

    def _handle_slash_command(self, cmd: str) -> bool:
        """Handle slash commands locally. Returns True if handled."""
        parts = cmd.strip().split(maxsplit=1)
        command = parts[0].lower()
        args = parts[1] if len(parts) > 1 else ""

        if command == "/help":
            self._show_help()
            return True

        elif command == "/config":
            self._show_config()
            return True

        elif command == "/models":
            self._show_models()
            return True

        elif command == "/compact":
            self.compact = not self.compact
            print(f"\n[Compact mode: {'ON' if self.compact else 'OFF'}]\n")
            return True

        elif command == "/status":
            self._show_status()
            return True

        elif command in ["/quit", "/exit"]:
            self.running = False
            return True

        return False

    def _show_help(self):
        """Display help information."""
        width = get_terminal_width()
        print()
        print(self._color("╭" + "─" * (width - 2) + "╮", Colors.BRIGHT_MAGENTA))

        title = "Voice Agent TUI - Commands"
        padding = width - 4 - len(title)
        border = self._color("│", Colors.BRIGHT_MAGENTA)
        print(f"{border} {self._color(title, Colors.BOLD)}{' ' * padding} {border}")

        print(self._color("├" + "─" * (width - 2) + "┤", Colors.BRIGHT_MAGENTA))

        # Commands
        commands = [
            ("/help", "Show this help message"),
            ("/config", "Display current configuration"),
            ("/models", "View/select LLM models and API keys"),
            ("/compact", "Toggle compact output mode"),
            ("/status", "Show system status"),
            ("/quit", "Exit the TUI"),
        ]

        for cmd, desc in commands:
            cmd_colored = self._color(cmd.ljust(12), Colors.BRIGHT_YELLOW)
            line = f"{cmd_colored} {desc}"
            # Calculate actual display length without color codes
            display_len = 12 + 1 + len(desc)
            padding = width - 4 - display_len
            print(f"{border} {line}{' ' * padding} {border}")

        print(self._color("├" + "─" * (width - 2) + "┤", Colors.BRIGHT_MAGENTA))

        # Input features
        features_title = self._color("Input Features:", Colors.BOLD)
        padding = width - 4 - len("Input Features:")
        print(f"{border} {features_title}{' ' * padding} {border}")

        features = [
            "↑/↓ arrows   Navigate command history",
            "Backspace    Delete characters (cursor moves properly)",
            "Ctrl+A/E     Move to start/end of line",
            "Tab          Auto-completion (where available)",
        ]

        for feat in features:
            padding = width - 4 - len(feat)
            print(f"{border} {feat}{' ' * padding} {border}")

        print(self._color("╰" + "─" * (width - 2) + "╯", Colors.BRIGHT_MAGENTA))
        print()

    def _show_config(self):
        """Display current configuration."""
        width = get_terminal_width()
        print()
        print(self._color("╭" + "─" * (width - 2) + "╮", Colors.BRIGHT_CYAN))

        title = "Current Configuration"
        padding = width - 4 - len(title)
        border = self._color("│", Colors.BRIGHT_CYAN)
        print(f"{border} {self._color(title, Colors.BOLD)}{' ' * padding} {border}")

        print(self._color("├" + "─" * (width - 2) + "┤", Colors.BRIGHT_CYAN))

        # Config items
        config_items = [
            ("Runtime Mode", self.config.runtime.mode.value),
            ("Log Level", self.config.logging.level),
            ("Log Directory", self.config.logging.log_dir),
            ("", ""),  # Spacer
            ("STT Engine", self.config.stt.engine),
            ("STT Model", self.config.stt.model_size),
            ("STT Device", self.config.stt.device),
            ("", ""),  # Spacer
            ("TTS Engine", self.config.tts.engine),
            ("TTS Voice", self.config.tts.voice or 'default'),
            ("TTS Rate", f"{self.config.tts.rate} wpm"),
            ("", ""),  # Spacer
            ("Harness Config", self.config.harness.config_path),
        ]

        for key, value in config_items:
            if not key:  # Spacer line
                print(f"{border}{' ' * (width - 2)}{border}")
            else:
                key_colored = self._color(key.ljust(20), Colors.BRIGHT_YELLOW)
                line = f"{key_colored} {value}"
                display_len = 20 + 1 + len(value)
                padding = width - 4 - display_len
                print(f"{border} {line}{' ' * padding} {border}")

        print(self._color("├" + "─" * (width - 2) + "┤", Colors.BRIGHT_CYAN))

        # Footer
        footer = "Edit config/app_config.json or use environment variables to modify"
        footer_colored = self._color(footer, Colors.DIM)
        padding = width - 4 - len(footer)
        print(f"{border} {footer_colored}{' ' * padding} {border}")

        print(self._color("╰" + "─" * (width - 2) + "╯", Colors.BRIGHT_CYAN))
        print()

    def _show_models(self):
        """Display model configuration and allow selection."""
        width = get_terminal_width()
        print()
        print(self._color("╭" + "─" * (width - 2) + "╮", Colors.BRIGHT_YELLOW))

        title = "LLM Models & API Keys"
        padding = width - 4 - len(title)
        border = self._color("│", Colors.BRIGHT_YELLOW)
        print(f"{border} {self._color(title, Colors.BOLD)}{' ' * padding} {border}")

        print(self._color("├" + "─" * (width - 2) + "┤", Colors.BRIGHT_YELLOW))

        # Check which API keys are configured
        import os
        has_openai = bool(os.getenv("OPENAI_API_KEY"))
        has_anthropic = bool(os.getenv("ANTHROPIC_API_KEY"))
        has_google = bool(os.getenv("GOOGLE_API_KEY"))

        # API key status
        api_keys = [
            ("OpenAI", has_openai),
            ("Anthropic", has_anthropic),
            ("Google", has_google),
        ]

        for provider, configured in api_keys:
            status = self._color("✓ Configured", Colors.GREEN) if configured else self._color("✗ Not configured", Colors.RED)
            provider_colored = self._color(provider.ljust(15), Colors.BRIGHT_CYAN)
            line = f"{provider_colored} {status}"
            # Calculate display length
            display_len = 15 + 1 + (len("✓ Configured") if configured else len("✗ Not configured"))
            padding = width - 4 - display_len
            print(f"{border} {line}{' ' * padding} {border}")

        print(self._color("├" + "─" * (width - 2) + "┤", Colors.BRIGHT_YELLOW))

        # Instructions
        instructions = [
            "",
            "To configure API keys:",
            "  1. Edit ~/.config/voice-agent/.env",
            "  2. Add: OPENAI_API_KEY=sk-...",
            "  3. Or: ANTHROPIC_API_KEY=sk-ant-...",
            "  4. Or: GOOGLE_API_KEY=...",
            "",
            "To change models:",
            f"  Edit {self.config.harness.config_path}",
            "  Modify the 'model' field in each tier configuration",
        ]

        for inst in instructions:
            inst_colored = self._color(inst, Colors.DIM) if inst else inst
            display_len = len(inst)
            padding = width - 4 - display_len
            print(f"{border} {inst_colored}{' ' * padding} {border}")

        print(self._color("╰" + "─" * (width - 2) + "╯", Colors.BRIGHT_YELLOW))
        print()

    def _show_status(self):
        """Display current system status."""
        width = get_terminal_width()
        print()
        print(self._color("╭" + "─" * (width - 2) + "╮", Colors.BRIGHT_GREEN))

        title = "System Status"
        padding = width - 4 - len(title)
        border = self._color("│", Colors.BRIGHT_GREEN)
        print(f"{border} {self._color(title, Colors.BOLD)}{' ' * padding} {border}")

        print(self._color("├" + "─" * (width - 2) + "┤", Colors.BRIGHT_GREEN))

        # Status items
        status_items = [
            ("Status", self.status),
            ("Requests sent", str(self.request_count)),
            ("Compact mode", "ON" if self.compact else "OFF"),
            ("Event bus", self._color("Connected", Colors.GREEN) if self.event_bus else self._color("Not connected", Colors.RED)),
            ("Workers", self._color("Running", Colors.GREEN) if hasattr(self, 'process_manager') and self.process_manager else self._color("Not started", Colors.RED)),
        ]

        for key, value in status_items:
            key_colored = self._color(key.ljust(20), Colors.BRIGHT_CYAN)
            # Strip color codes for length calculation
            value_str = str(value)
            if "\033[" in value_str:
                # Has color codes, use raw string length
                display_value = value
                value_len = len(value_str.split("\033[")[0]) + len(value_str.split("m")[-1].split("\033[")[0])
            else:
                display_value = value
                value_len = len(value)

            line = f"{key_colored} {display_value}"
            display_len = 20 + 1 + value_len
            padding_val = width - 4 - display_len
            print(f"{border} {line}{' ' * padding_val} {border}")

        print(self._color("╰" + "─" * (width - 2) + "╯", Colors.BRIGHT_GREEN))
        print()

    def _send_message(self, text: str):
        """Send text message to agent harness."""
        self.request_count += 1
        request_id = f"tui_{self.request_count}_{int(time.time() * 1000) % 100000}"
        self.current_request_id = request_id
        self.status = "Processing..."

        # Show lightweight status indicator
        if not self.compact:
            thinking = self._color("⏳ Thinking...", Colors.YELLOW)
            print(f"\n{thinking}\n")

        # Publish transcription event (bypassing audio/STT)
        self.event_bus.publish(TranscriptionCompleteEvent(
            request_id=request_id,
            text=text,
            confidence=None,
            duration_ms=0.0
        ))

    def _get_input(self) -> str:
        """Get input from user with nice formatting."""
        width = get_terminal_width()

        # Draw top border and prompt
        print()
        print(self._color("╭" + "─" * (width - 2) + "╮", Colors.BRIGHT_GREEN))

        # Prompt with color
        prompt_text = "Enter message"
        if self.status == "Processing...":
            prompt_text += " (processing...)"

        prompt_color = self._color(f"│ {prompt_text}", Colors.BRIGHT_GREEN)
        padding = width - len(f"│ {prompt_text}") - 2
        print(f"{prompt_color}{' ' * padding} {self._color('│', Colors.BRIGHT_GREEN)}")

        # Middle line for input
        print(self._color("│ ", Colors.BRIGHT_GREEN), end='')

        # Input - readline enabled, inside the box
        try:
            text = input().strip()
            # Draw bottom border after input
            print(self._color("╰" + "─" * (width - 2) + "╯", Colors.BRIGHT_GREEN))
            return text
        except (EOFError, KeyboardInterrupt):
            print()
            print(self._color("╰" + "─" * (width - 2) + "╯", Colors.BRIGHT_GREEN))
            return ""

    def _suppress_console_logging(self):
        """Suppress console logging to keep TUI clean."""
        import logging

        # Create logs directory
        os.makedirs("logs", exist_ok=True)

        # Configure logging before any modules use it
        # This will affect all loggers in the application
        logging.basicConfig(
            level=logging.WARNING,  # Only warnings and above
            format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
            handlers=[
                # Only log to file, not console
                logging.FileHandler("logs/tui.log", mode='a')
            ],
            force=True  # Override any existing configuration
        )

        # Also suppress any existing console handlers from all loggers
        root_logger = logging.getLogger()
        for handler in list(root_logger.handlers):
            if isinstance(handler, logging.StreamHandler) and handler.stream in (sys.stdout, sys.stderr):
                root_logger.removeHandler(handler)

        # Set all named loggers to WARNING level as well
        for logger_name in logging.root.manager.loggerDict:
            logger = logging.getLogger(logger_name)
            logger.setLevel(logging.WARNING)
            # Remove console handlers from all loggers
            for handler in list(logger.handlers):
                if isinstance(handler, logging.StreamHandler) and handler.stream in (sys.stdout, sys.stderr):
                    logger.removeHandler(handler)

    def run(self):
        """Main TUI loop."""
        # Suppress console logging to keep TUI clean
        self._suppress_console_logging()

        # Print initial header
        self._print_header()

        width = get_terminal_width()
        welcome_msg = "Type /help for commands, or enter text to chat with the agent"
        help_hint = self._color("Tip: Use ↑/↓ arrows for command history, Ctrl+C to exit", Colors.DIM)
        print(f"\n{welcome_msg}")
        print(f"{help_hint}\n")
        print(self._color("─" * width, Colors.BRIGHT_BLACK) + "\n")

        # Setup backend - need to capture stdout/stderr during initialization
        print(self._color("⚙  Initializing backend...", Colors.CYAN))
        sys.stdout.flush()
        sys.stderr.flush()

        # Save original stdout/stderr
        original_stdout = sys.stdout.fileno()
        original_stderr = sys.stderr.fileno()
        saved_stdout = os.dup(original_stdout)
        saved_stderr = os.dup(original_stderr)

        # Open /dev/null
        devnull = os.open(os.devnull, os.O_WRONLY)

        # Redirect worker output to /dev/null during initialization
        os.dup2(devnull, original_stdout)
        os.dup2(devnull, original_stderr)

        try:
            self._setup_event_bus()
            self._start_backend_workers()
        finally:
            # Restore stdout/stderr
            os.dup2(saved_stdout, original_stdout)
            os.dup2(saved_stderr, original_stderr)
            os.close(devnull)
            os.close(saved_stdout)
            os.close(saved_stderr)

        print(self._color("✓ Backend ready\n", Colors.GREEN))

        # Start event monitoring thread
        self.running = True
        monitor_thread = threading.Thread(
            target=self._monitor_events,
            daemon=True,
            name="EventMonitor"
        )
        monitor_thread.start()

        # Main input loop
        try:
            while self.running:
                try:
                    # Get input with nice box
                    text = self._get_input()

                    if not text:
                        continue

                    # Handle slash commands
                    if text.startswith("/"):
                        if self._handle_slash_command(text):
                            if not self.running:
                                break
                            continue

                    # Send to agent
                    self._send_message(text)

                except EOFError:
                    print(f"\n{self._color('[EOF received, exiting...]', Colors.YELLOW)}")
                    break
                except KeyboardInterrupt:
                    print(f"\n\n{self._color('[Interrupted by user]', Colors.YELLOW)}")
                    break

        finally:
            self._shutdown()

    def _shutdown(self):
        """Clean shutdown."""
        print(f"\n{self._color('⏹  Shutting down...', Colors.YELLOW)}")
        self.running = False

        if self.event_bus:
            self.event_bus.shutdown()

        if hasattr(self, 'process_manager') and self.process_manager:
            self.process_manager.stop()

        print(f"{self._color('✓ Goodbye!', Colors.GREEN)}\n")


def main(argv: Optional[list[str]] = None) -> int:
    """Entry point for simple TUI."""
    try:
        # Load config
        config = load_app_config()

        # Force headless mode for TUI
        config.runtime.headless = True

        # Create and run TUI
        tui = SimpleTUI(config)
        tui.run()

        return 0

    except Exception as e:
        print(f"\n[Error: {e}]", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
