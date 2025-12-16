#!/bin/bash
# Voice Agent System - Docker Entrypoint Script
# Performs pre-flight checks and handles graceful shutdown

set -e  # Exit on error

# Color codes for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Signal handling for graceful shutdown
_term() {
    log_info "Caught termination signal (SIGTERM/SIGINT)"
    if [ -n "$child" ]; then
        log_info "Forwarding signal to voice-agent process (PID: $child)"
        kill -TERM "$child" 2>/dev/null || true
        wait "$child" 2>/dev/null || true
    fi
    exit 0
}

trap _term SIGTERM SIGINT SIGHUP

log_info "Voice Agent System - Container Initialization"
log_info "=============================================="

# Pre-flight check 1: Validate audio devices
log_info "Checking audio device accessibility..."
if ! python3 -c "import pyaudio; pa = pyaudio.PyAudio(); count = pa.get_device_count(); pa.terminate(); print(f'Found {count} audio device(s)'); exit(0 if count > 0 else 1)" 2>&1; then
    log_error "No audio devices found!"
    log_error "Ensure you passed through audio devices:"
    log_error "  Linux:   --device /dev/snd:/dev/snd"
    log_error "  macOS:   Audio passthrough not well supported - use native installation"
    log_error "  Windows: Use WSL2 with PulseAudio configuration"
    exit 1
fi
log_info "✓ Audio devices accessible"

# Pre-flight check 2: Validate API keys
log_info "Checking API key configuration..."
if [ -z "$OPENAI_API_KEY" ] && [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$GOOGLE_API_KEY" ]; then
    log_warn "No API keys found in environment!"
    log_warn "Set at least one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY"
    log_warn "Agent will fail when trying to make LLM calls"
else
    if [ -n "$OPENAI_API_KEY" ]; then
        log_info "✓ OPENAI_API_KEY configured"
    fi
    if [ -n "$ANTHROPIC_API_KEY" ]; then
        log_info "✓ ANTHROPIC_API_KEY configured"
    fi
    if [ -n "$GOOGLE_API_KEY" ]; then
        log_info "✓ GOOGLE_API_KEY configured"
    fi
fi

# Pre-flight check 3: Validate configuration file
CONFIG_PATH="${CONFIG_PATH:-/config/app_config.json}"
if [ ! -z "$1" ] && [[ "$1" == voice-agent ]] && [[ "$*" == *"--config"* ]]; then
    # Extract config path from command-line arguments
    for i in "$@"; do
        if [[ "$prev" == "--config" ]]; then
            CONFIG_PATH="$i"
            break
        fi
        prev="$i"
    done
fi

log_info "Checking configuration file: $CONFIG_PATH"
if [ ! -f "$CONFIG_PATH" ] && [[ "$*" != *"--help"* ]] && [[ "$*" != *"--version"* ]] && [[ "$*" != *"--init-config"* ]] && [[ "$*" != *"--list-devices"* ]]; then
    log_error "Configuration file not found: $CONFIG_PATH"
    log_error "Mount config directory: -v \$(pwd)/config:/config:ro"
    log_error "Or use --init-config to create default configuration"
    exit 1
elif [ -f "$CONFIG_PATH" ]; then
    log_info "✓ Configuration file found"
fi

# Pre-flight check 4: Validate log directory is writable
LOG_DIR="${LOG_DIR:-/app/logs}"
if [ ! -d "$LOG_DIR" ]; then
    log_warn "Log directory does not exist, creating: $LOG_DIR"
    mkdir -p "$LOG_DIR" || log_error "Failed to create log directory"
fi
if [ ! -w "$LOG_DIR" ]; then
    log_error "Log directory not writable: $LOG_DIR"
    exit 1
fi
log_info "✓ Log directory writable: $LOG_DIR"

# Display environment configuration
log_info "Environment Configuration:"
log_info "  Python Version: $(python3 --version)"
log_info "  Working Directory: $(pwd)"
log_info "  Log Directory: $LOG_DIR"
log_info "  User: $(whoami) (UID: $(id -u))"
log_info "  Audio Groups: $(groups | grep -o audio || echo 'none')"

# Display runtime overrides if set
if [ -n "$STT_MODEL" ] || [ -n "$STT_DEVICE" ] || [ -n "$LOG_LEVEL" ]; then
    log_info "Configuration Overrides (from environment):"
    [ -n "$STT_MODEL" ] && log_info "  STT_MODEL: $STT_MODEL"
    [ -n "$STT_DEVICE" ] && log_info "  STT_DEVICE: $STT_DEVICE"
    [ -n "$LOG_LEVEL" ] && log_info "  LOG_LEVEL: $LOG_LEVEL"
    [ -n "$AUDIO_DEVICE_INDEX" ] && log_info "  AUDIO_DEVICE_INDEX: $AUDIO_DEVICE_INDEX"
fi

log_info "=============================================="
log_info "Starting Voice Agent: $*"
log_info "=============================================="

# Execute the command and capture PID for signal handling
exec "$@" &
child=$!

# Wait for the child process
wait "$child"
exit_code=$?

log_info "Voice Agent exited with code: $exit_code"
exit $exit_code
