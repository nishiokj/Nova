"""
Configuration discovery module for Voice Agent System.

Implements XDG Base Directory Specification for config file discovery
and provides utilities for initializing user configuration directories.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path
from typing import Optional

# Default config filenames
DEFAULT_APP_CONFIG = "app_config.json"
DEFAULT_HARNESS_CONFIG = "harness_config.json"
DEFAULT_ENV_FILE = ".env"


def get_xdg_config_home() -> Path:
    """
    Get XDG_CONFIG_HOME directory.

    Returns ~/.config by default, or value of XDG_CONFIG_HOME env var.
    """
    xdg_config = os.getenv("XDG_CONFIG_HOME")
    if xdg_config:
        return Path(xdg_config)
    return Path.home() / ".config"


def get_user_config_dir() -> Path:
    """Get the user's voice-agent config directory."""
    return get_xdg_config_home() / "voice-agent"


def find_config_file(
    explicit_path: Optional[str] = None,
    config_dir: Optional[str] = None,
    filename: str = DEFAULT_APP_CONFIG,
) -> Path:
    """
    Find configuration file using XDG standards.

    Search order:
    1. Explicit path provided via --config flag (highest priority)
    2. Custom config directory + filename (--config-dir)
    3. $XDG_CONFIG_HOME/voice-agent/filename
    4. ~/.config/voice-agent/filename
    5. ./config/filename (development default)
    6. Bundled package templates (fallback)

    Args:
        explicit_path: Explicit config file path from --config flag
        config_dir: Custom config directory from --config-dir flag
        filename: Config filename to search for

    Returns:
        Path to configuration file

    Raises:
        FileNotFoundError: If no configuration file found in search paths
    """
    search_paths: list[Path] = []

    # 1. Explicit path (highest priority)
    if explicit_path:
        explicit = Path(explicit_path)
        if explicit.exists():
            return explicit
        # If explicit path doesn't exist, still return it so error message is clear
        raise FileNotFoundError(
            f"Configuration file not found: {explicit_path}\n"
            f"Specified via --config flag but file does not exist."
        )

    # 2. Custom config directory
    if config_dir:
        custom_dir = Path(config_dir)
        search_paths.append(custom_dir / filename)

    # 3. XDG_CONFIG_HOME/voice-agent
    xdg_config = get_xdg_config_home() / "voice-agent" / filename
    search_paths.append(xdg_config)

    # 4. ~/.config/voice-agent (in case XDG_CONFIG_HOME not set)
    user_config = Path.home() / ".config" / "voice-agent" / filename
    if user_config != xdg_config:  # Avoid duplicates
        search_paths.append(user_config)

    # 5. ./config (development default)
    dev_config = Path.cwd() / "config" / filename
    search_paths.append(dev_config)

    # 6. Bundled package templates
    try:
        # Check if installed as package
        if hasattr(sys, "prefix"):
            package_config = Path(sys.prefix) / "config" / filename
            search_paths.append(package_config)

        # Check src/config (editable install)
        src_config = Path(__file__).parent.parent / "config" / filename
        search_paths.append(src_config)
    except Exception:
        pass  # Skip if package not installed

    # Search all paths
    for path in search_paths:
        if path.exists():
            return path.resolve()

    # Not found - provide helpful error message
    search_paths_str = "\n  - ".join(str(p) for p in search_paths[:5])  # Show first 5
    raise FileNotFoundError(
        f"Configuration file '{filename}' not found.\n\n"
        f"Searched locations:\n  - {search_paths_str}\n\n"
        f"To fix this:\n"
        f"1. Run: voice-agent --init-config\n"
        f"   (Creates {get_user_config_dir() / filename})\n\n"
        f"2. Or specify explicit path: voice-agent --config /path/to/config.json\n\n"
        f"3. Or run from repo root: cd /path/to/repo && voice-agent"
    )


def init_user_config(config_dir: Optional[str] = None) -> Path:
    """
    Initialize user configuration directory with templates.

    Creates:
    - ~/.config/voice-agent/app_config.json
    - ~/.config/voice-agent/harness_config.json
    - ~/.config/voice-agent/.env (template)

    Args:
        config_dir: Custom config directory (default: XDG_CONFIG_HOME/voice-agent)

    Returns:
        Path to created config directory
    """
    # Determine target directory
    if config_dir:
        target_dir = Path(config_dir)
    else:
        target_dir = get_user_config_dir()

    # Create directory if it doesn't exist
    target_dir.mkdir(parents=True, exist_ok=True)

    # Source templates (try multiple locations)
    template_sources = [
        Path.cwd() / "config",  # Development repo
        Path(__file__).parent.parent / "config",  # Installed package (src/config)
    ]

    source_dir = None
    for source in template_sources:
        if source.exists():
            source_dir = source
            break

    if not source_dir:
        raise FileNotFoundError(
            "Could not find configuration templates. "
            "Ensure you're running from the repository root or have installed the package."
        )

    # Copy config files
    files_to_copy = [
        (DEFAULT_APP_CONFIG, "app_config.json"),
        (DEFAULT_HARNESS_CONFIG, "harness_config.json"),
    ]

    for filename, dest_name in files_to_copy:
        src_file = source_dir / filename
        dest_file = target_dir / dest_name

        if dest_file.exists():
            print(f"  ⚠ Skipping {dest_name} (already exists)")
        elif src_file.exists():
            shutil.copy2(src_file, dest_file)
            print(f"  ✓ Created {dest_file}")
        else:
            print(f"  ⚠ Template not found: {src_file}")

    # Create .env template
    env_file = target_dir / DEFAULT_ENV_FILE
    if env_file.exists():
        print(f"  ⚠ Skipping .env (already exists)")
    else:
        env_template = """# Voice Agent System - Environment Configuration
# Copy this file to .env and fill in your API keys

# ============= LLM API Keys (at least one required) =============
OPENAI_API_KEY=your-openai-key-here
ANTHROPIC_API_KEY=your-anthropic-key-here
GOOGLE_API_KEY=your-google-key-here

# ============= Logging =============
LOG_LEVEL=INFO
LOG_DIR=logs

# ============= Configuration Overrides (optional) =============
# Uncomment to override values in app_config.json

# STT Configuration
#STT_MODEL=base.en
#STT_DEVICE=auto
#STT_COMPUTE_TYPE=auto

# Audio Configuration
#AUDIO_DEVICE_INDEX=0
#AUDIO_SAMPLE_RATE=32000

# Harness Configuration
#HARNESS_CONFIG_PATH={harness_config}
""".format(harness_config=str(target_dir / DEFAULT_HARNESS_CONFIG))

        env_file.write_text(env_template)
        print(f"  ✓ Created {env_file}")

    return target_dir


def find_harness_config(
    app_config_dir: Optional[Path] = None,
    explicit_path: Optional[str] = None,
) -> Path:
    """
    Find harness configuration file.

    Args:
        app_config_dir: Directory where app_config.json was found
        explicit_path: Explicit path from config or env var

    Returns:
        Path to harness_config.json

    Raises:
        FileNotFoundError: If harness config not found
    """
    if explicit_path:
        path = Path(explicit_path)
        if path.exists():
            return path
        raise FileNotFoundError(f"Harness config not found: {explicit_path}")

    # If app_config_dir provided, look there first
    if app_config_dir:
        candidate = app_config_dir / DEFAULT_HARNESS_CONFIG
        if candidate.exists():
            return candidate

    # Fall back to standard discovery
    return find_config_file(filename=DEFAULT_HARNESS_CONFIG)
