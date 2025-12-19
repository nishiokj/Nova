
    import subprocess
    import sys
    import importlib

    def test_import_tui_module():
        # Import in a subprocess to catch import-time crashes or interactive blocking behavior
        cmd = [sys.executable, "-c", "import importlib; importlib.import_module('tui.simple_tui')"]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        assert res.returncode == 0, f"Import failed (rc={res.returncode})
stdout:
{res.stdout}
stderr:
{res.stderr}"

    def test_has_main_callable():
        # Import in-process and ensure a main entrypoint exists and is callable
        m = importlib.import_module('tui.simple_tui')
        assert hasattr(m, 'main'), 'tui.simple_tui should expose a main callable'
        assert callable(getattr(m, 'main'))
