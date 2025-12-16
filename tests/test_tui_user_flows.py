import importlib
import sys
import time
import signal
import subprocess
import pytest


def _entrypoint_wrapper_code():
    # This helper is embedded as a heredoc in the subprocess invocation below.
    return r"""
import importlib
import sys
import time

try:
    mod = importlib.import_module('TUI')
except Exception as e:
    print('IMPORT_ERROR:' + repr(e))
    sys.exit(3)

# Try common entrypoint names. If one exists and is callable, call it.
for name in ('main', 'run', 'start'):
    fn = getattr(mod, name, None)
    if callable(fn):
        try:
            fn()
        except SystemExit:
            # normal exit
            sys.exit(0)
        except Exception as e:
            print('ENTRY_EXCEPTION:' + repr(e))
            sys.exit(2)

# If nothing was callable, sleep for a while so the test process can exercise shutdown.
time.sleep(10)
"""


@pytest.mark.importorskip('TUI')
def test_tui_importable():
    """TUI package should import without raising exceptions."""
    importlib.import_module('TUI')


@pytest.mark.importorskip('TUI')
def test_tui_start_and_exit_via_sigint():
    """Start the TUI entrypoint in a subprocess, send SIGINT, and ensure it exits cleanly.

    This exercises startup and graceful shutdown handling paths without assuming a specific
    entrypoint implementation. If the module provides main/run/start it will be invoked.
    """
    code = _entrypoint_wrapper_code()
    # Launch a short-lived subprocess that runs the wrapper code.
    proc = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        # Give it a moment to start
        time.sleep(1)
        # Send SIGINT to request graceful shutdown
        proc.send_signal(signal.SIGINT)
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        pytest.fail('TUI did not exit after SIGINT')

    out = proc.stdout.read().decode('utf-8', errors='replace') if proc.stdout is not None else ''

    # If the subprocess printed import or entry exceptions, fail with that output to help debugging.
    assert 'IMPORT_ERROR:' not in out, f'Import failed in subprocess: {out}'
    assert 'ENTRY_EXCEPTION:' not in out, f'Entrypoint raised in subprocess: {out}'


@pytest.mark.importorskip('TUI')
def test_tui_handles_closed_stdin():
    """Ensure the TUI process does not crash when stdin is closed immediately.

    Some TUI implementations read from stdin on startup; this test closes stdin to simulate a
    non-interactive environment (e.g. running under a service or with redirected streams).
    """
    code = _entrypoint_wrapper_code()
    proc = subprocess.Popen([sys.executable, '-c', code], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        # If it didn't exit quickly, try to terminate politely then kill.
        proc.send_signal(signal.SIGINT)
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            pytest.fail('TUI did not exit after closing stdin and SIGINT')

    out = proc.stdout.read().decode('utf-8', errors='replace') if proc.stdout is not None else ''
    assert 'IMPORT_ERROR:' not in out, f'Import failed in subprocess: {out}'
    assert 'ENTRY_EXCEPTION:' not in out, f'Entrypoint raised in subprocess: {out}'
