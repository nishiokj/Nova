TUI — Usage, Troubleshooting, and Contributing
=============================================

Overview
--------
This package contains a collection of small, robust helpers and a tolerant package-level
entrypoint to make text-based user interfaces (TUIs) easier to run reliably across a
variety of execution environments (interactive shells, services, CI, etc.).

What this update provides
- A package-level entrypoint (TUI.main / TUI.run / TUI.start) that safely invokes
  candidate modules (main, usability, screens) and handles errors without crashing.
- Robust logging configuration (structured JSON output, optional rotating file logs).
- Graceful shutdown helpers that persist small state and restore terminal state.
- Signal handlers for terminal resize (SIGWINCH) and safe utilities for printing and
  truncating Unicode strings.
- Configuration loader that merges defaults, config files, and environment variables.

Quick usage
-----------
Import and run the package entrypoint in Python:

    python -c "import TUI; TUI.main()"

Or from a running Python program:

    import TUI

    # Calls the package-level main (safe, tolerant wrapper)
    TUI.main()

The package will attempt to call a callable named main, run, or start in the
following candidate modules (if present): TUI.main, TUI.usability, TUI.screens.
If none are present, the package enters a polite idle state that responds to
SIGINT/SIGTERM (useful for testing and supervised environments).

Configuration
-------------
Config is handled by TUI.config and uses a conservative, dependency-free JSON format.
Defaults are provided; they are merged (lowest -> highest priority) with a config file
and environment variables.

Config file locations (checked in order):
- $XDG_CONFIG_HOME/tui/config.json
- ~/.config/tui/config.json

Environment variable overrides:
- TUI_LOG_LEVEL (e.g. DEBUG, INFO)
- TUI_COLOR ("auto", "always", "never")
- TUI_ENABLE_FILE_LOGGING (1/0, true/false)
- TUI_KEYBINDINGS (JSON string mapping action -> key)

Programmatic helpers:
- import TUI.config; TUI.config.get('log_level')
- TUI.config.apply_cli_args(namespace_or_dict)
- TUI.config.save(path)

Logging
-------
Use TUI.logging_config for structured logs. By default it configures a JSON
console formatter on stderr and will add a rotating file handler when running
non-interactively. The file location follows XDG conventions and defaults to
~/.local/share/tui/tui.log (or the current working directory if creation fails).

To control logging programmatically:

    from TUI import logging_config
    logging_config.configure_logging(level=logging.DEBUG, enable_file=True)

Troubleshooting
---------------
- "TUI ERROR: Could not import 'TUI.main'..." — indicates a problem while importing a
  candidate module. Check the stack printed to stderr and fix the import error.
- TUI appears to hang after startup — the package is tolerant and may enter an
  idle state if no entrypoint is found or an entrypoint raised an exception. Use
  SIGINT (Ctrl-C) to trigger shutdown and review stderr logs for error traces.
- Where are logs? By default, interactive runs log to stderr. When running
  non-interactively, file logging is enabled and the log file path is included
  in the startup JSON log entry if creation succeeded.
- State persistence: TUI.shutdown saves small JSON state to an XDG-friendly path
  (default: $XDG_STATE_HOME/tui/state.json or ~/.local/share/tui/state.json). If
  saving or loading fails, the failure is written to stderr but ignored to avoid
  taking down the TUI.

Known limitations
-----------------
- Character truncation and width handling are conservative. We do not attempt
  grapheme-cluster-aware truncation (this would require an external library).
- There is no package __main__.py provided; running `python -m TUI` will not work
  out-of-the-box. Use the documented python -c or import approach, or add a
  small __main__.py that calls TUI.main if you prefer module execution.
- The resize handler schedules callbacks in background threads to avoid doing
  heavy work inside signal handlers. Callbacks should be safe to call from a
  background thread.
- Attempted terminal restoration is best-effort; complex terminal states from
  external programs may not be fully recovered.

Contributing
------------
We welcome improvements. Please follow these guidelines:

- Tests: Add unit tests under tests/ for new behavior. The repository already
  contains tests exercising import and signal handling. Run tests with pytest.

- Style: Keep code dependency-free when possible for portability. Follow the
  existing code style (clear docstrings, defensive programming for I/O and
  signal interactions).

- Logging & Errors: Avoid writing opaque tokens that tests use to detect errors
  (e.g. avoid emitting literal markers like IMPORT_ERROR:). Use structured
  logging or concise stderr messages.

- New Entry Points: If you add a new top-level entry module (for example,
  TUI.cli), prefer exposing a main()/run()/start() function so the package
  wrapper can invoke it automatically.

- Terminal code: Prefer defensive, best-effort approaches when interacting with
  terminal APIs (curses, stty). Ensure code does not raise on import in basic
  non-interactive environments.

- Pull requests: Include a brief description of the change, tests, and any
  manual steps to verify interactive behavior (if applicable).

Maintainers
-----------
This README documents the current TUI helpers and their intended usage. If you
have questions before contributing, open an issue or start a discussion in the
project's issue tracker.

License and attribution
------------------------
Follow the repository's license. This module aims to be small, permissive, and
safe for embedding in larger applications.
