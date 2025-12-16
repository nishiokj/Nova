# Environment & Cross-Machine Setup Guide

This guide expands on `scripts/setup_env.sh` and documents the minimum steps needed to run the Voice Agent System on common developer environments.

## 1. System requirements
- Python 3.11 (matching the version pinned in CI) with `python3-venv` support
- Node.js 20.x for the front-end preview
- PortAudio development headers (PyAudio), FFmpeg (pydub), and a working microphone device
- For GPU-based Whisper inference, install CUDA 12.x + cuBLAS/cuDNN drivers or use Metal Performance Shaders on Apple Silicon (set `AppConfig.stt.device="auto"`)

## 2. OS-specific steps
### macOS (Intel & Apple Silicon)
1. Install [Homebrew](https://brew.sh/)
2. `brew install python@3.11 portaudio ffmpeg node`
3. Grant microphone permissions to the terminal/IDE that will run `voice-agent` (`System Settings → Privacy & Security → Microphone`).
4. Run `./scripts/setup_env.sh` (uses Homebrew packages above) and `npm --prefix front-end install`.

### Ubuntu/Debian Linux
1. `sudo apt-get update`
2. `sudo apt-get install python3.11 python3.11-venv portaudio19-dev ffmpeg build-essential nodejs npm`
3. If multiple audio devices exist, use `pavucontrol` or `alsamixer` to select the microphone.
4. Execute `./scripts/setup_env.sh` to create `.venv`, then `source .venv/bin/activate`.

### Windows 11/10
1. Install Python 3.11 from the Windows Store or python.org (ensure "Add to PATH" is checked).
2. Install the [PortAudio binaries](https://github.com/intxcc/pyaudio_portaudio/releases) and add the `.lib`/`.dll` directory to `PATH` before installing `pyaudio`.
3. Install FFmpeg and add its `bin/` folder to `PATH`.
4. Use PowerShell:
   ```powershell
   py -3.11 -m venv .venv
   .\.venv\Scripts\activate
   pip install --upgrade pip pip-tools
   pip-sync requirements-test.txt
   npm install --prefix front-end
   ```
5. Allow microphone access under `Settings → Privacy & security → Microphone`.

> **Tip:** On Windows, running the backend inside WSL2 often yields better `portaudio` support—bind your microphone device through PulseAudio (`sudo apt install pulseaudio`) and run the UI in the host OS.

## 3. Environment variables & secrets
- Duplicate `.env.example` (create one if needed) and populate API keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.
- Load them via `direnv`, `dotenv`, or your process supervisor before invoking `voice-agent`.
- Never commit live keys; use secret managers (1Password, Vault, AWS Secrets Manager) for production deployments.

## 4. Dependency locking workflow
1. Edit `requirements.in` or `requirements-test.in` to add/remove dependencies.
2. Rebuild locks:
   ```bash
   pip-compile --output-file=requirements.txt requirements.in
   pip-compile --output-file=requirements-test.txt requirements-test.in
   ```
3. Synchronize the virtual environment with `pip-sync requirements-test.txt`.
4. For the UI, run `npm ci` to consume the committed `package-lock.json`.

## 5. Packaging & distribution checklist
- Run `python -m build` to produce wheels/sdists for distribution; CI already validates this path.
- Upload artifacts to your internal PyPI/registry and install via `pip install voice-agent-system==VERSION`.
- Include the `config/*.json` templates in release archives so operators can copy them without editing in-place.

## 6. Sanity checks before running on a new machine
- `python -m sounddevice` or `python - <<<'import pyaudio'` to confirm PortAudio loads
- `pip list | grep voice-agent-system` to confirm wheel installation (if not running from source)
- `pytest -m "unit and not requires_network"` to ensure harness utilities behave on the platform
- `npm --prefix front-end run start` to confirm front-end assets load

Keep this document updated when adding new platform requirements (e.g., GPU acceleration, Docker images, or virtualization guidance).
