#!/usr/bin/env bash
set -euo pipefail

VENV_PATH=${VENV_PATH:-.venv}
PYTHON_BIN=${PYTHON_BIN:-python3.11}
INSTALL_FRONTEND=${INSTALL_FRONTEND:-true}

info() { printf '\n[setup] %s\n' "$1"; }

info "Ensuring system dependencies are available"
if [[ "$OSTYPE" == "darwin"* ]]; then
  if command -v brew >/dev/null 2>&1; then
    brew install portaudio ffmpeg || true
  else
    echo "Homebrew is not installed. Install it from https://brew.sh/ for audio deps." >&2
  fi
elif [[ "$OSTYPE" == "linux"* ]]; then
  sudo apt-get update && sudo apt-get install -y python3-venv portaudio19-dev ffmpeg
else
  echo "Windows users should install PortAudio + FFmpeg manually before continuing." >&2
fi

info "Creating virtual environment at ${VENV_PATH}"
if [[ ! -d "$VENV_PATH" ]]; then
  "$PYTHON_BIN" -m venv "$VENV_PATH"
fi
source "$VENV_PATH/bin/activate"

info "Updating pip + pip-tools"
pip install --upgrade pip
pip install pip-tools

info "Syncing Python dependencies from requirements-test.txt"
pip-sync requirements-test.txt

if [[ "$INSTALL_FRONTEND" == "true" && -d front-end ]]; then
  if command -v npm >/dev/null 2>&1; then
    info "Installing front-end dependencies"
    (cd front-end && npm install)
  else
    echo "npm not found; skipping front-end install" >&2
  fi
fi

info "Environment ready. Activate it via 'source ${VENV_PATH}/bin/activate'"
