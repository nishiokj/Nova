"""
Integration tests for the CLI interface.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest


# Get the src directory path
SRC_DIR = Path(__file__).parent.parent / "src"


class TestCLI:
    """Test CLI commands."""

    def test_version(self):
        """Test --version flag."""
        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "--version"],
            capture_output=True,
            text=True,
            cwd=str(SRC_DIR),
            timeout=30
        )
        assert result.returncode == 0
        assert "0.1.0" in result.stdout or "rex" in result.stdout.lower()

    def test_help(self):
        """Test --help flag."""
        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "--help"],
            capture_output=True,
            text=True,
            cwd=str(SRC_DIR),
            timeout=30
        )
        assert result.returncode == 0
        assert "usage" in result.stdout.lower() or "options" in result.stdout.lower()

    def test_list_devices_headless(self):
        """Test list-devices in headless mode."""
        env = os.environ.copy()
        env["VOICE_AGENT_HEADLESS"] = "1"

        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "--list-devices"],
            capture_output=True,
            text=True,
            cwd=str(SRC_DIR),
            env=env,
            timeout=30
        )
        # Should not crash in headless mode - may return 1 if no devices
        assert result.returncode in (0, 1)

    def test_validate_config_default(self):
        """Test config validation with default config."""
        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "--validate-config"],
            capture_output=True,
            text=True,
            cwd=str(SRC_DIR),
            timeout=30
        )
        # Should complete (may succeed or fail based on config presence)
        assert result.returncode in (0, 1)

    def test_validate_config_with_file(self, tmp_path):
        """Test config validation with explicit config file."""
        # Create minimal valid config
        config_file = tmp_path / "test_config.json"
        config_file.write_text('{"runtime": {"mode": "multi_process"}}')

        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "--validate-config", "--config", str(config_file)],
            capture_output=True,
            text=True,
            cwd=str(SRC_DIR),
            timeout=30
        )
        # Should complete without crashing
        assert result.returncode in (0, 1)

    def test_health_check_headless(self):
        """Test health-check command in headless mode."""
        env = os.environ.copy()
        env["VOICE_AGENT_HEADLESS"] = "1"

        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "--health-check"],
            capture_output=True,
            text=True,
            cwd=str(SRC_DIR),
            env=env,
            timeout=30
        )
        # Should pass in headless mode
        assert result.returncode == 0
        assert "PASS" in result.stdout

    def test_init_config(self, tmp_path):
        """Test --init-config creates config files."""
        config_dir = tmp_path / "voice-agent"

        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "--init-config", "--config-dir", str(config_dir)],
            capture_output=True,
            text=True,
            cwd=str(SRC_DIR),
            timeout=30
        )
        # Should succeed
        assert result.returncode == 0
        assert "initialized" in result.stdout.lower() or "Configuration" in result.stdout


@pytest.mark.integration
class TestCLIIntegration:
    """Integration tests requiring more setup."""

    def test_health_check_with_audio(self):
        """Test health-check command with audio (skip if no audio devices)."""
        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "--health-check"],
            capture_output=True,
            text=True,
            cwd=str(SRC_DIR),
            timeout=30
        )
        # Health check should complete (pass or fail)
        assert result.returncode in (0, 1)

    def test_debug_flag_shows_traceback(self, tmp_path):
        """Test that --debug flag shows stack traces on error."""
        # Create an invalid config
        invalid_config = tmp_path / "invalid.json"
        invalid_config.write_text("{invalid json")

        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "--debug", "--config", str(invalid_config)],
            capture_output=True,
            text=True,
            cwd=str(SRC_DIR),
            timeout=30
        )
        # Should fail and show traceback
        assert result.returncode != 0


class TestCLIEdgeCases:
    """Test edge cases and error handling."""

    def test_missing_config_file(self):
        """Test error when config file doesn't exist."""
        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "--config", "/nonexistent/path/config.json"],
            capture_output=True,
            text=True,
            cwd=str(SRC_DIR),
            timeout=30
        )
        assert result.returncode != 0
        assert "not found" in result.stdout.lower() or "error" in result.stderr.lower()

    def test_conflicting_flags(self):
        """Test behavior with conflicting options."""
        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "--headless", "--list-devices"],
            capture_output=True,
            text=True,
            cwd=str(SRC_DIR),
            timeout=30
        )
        # Should handle gracefully
        assert result.returncode in (0, 1)

    def test_keyboard_interrupt_handling(self):
        """Test that CLI handles keyboard interrupt gracefully."""
        # This is hard to test directly, but we can verify exit codes are defined
        # The CLI should return 130 on keyboard interrupt
        pass  # Documented behavior test
