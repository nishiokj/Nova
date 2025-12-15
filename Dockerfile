# Voice Agent System - Production Docker Image
# Single-container architecture with multi-process support
# Supports cross-platform development (Linux primary, macOS/Windows documented)

FROM python:3.11-slim

# Prevent Python from buffering stdout/stderr (better for container logs)
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Install system dependencies for audio processing
# - portaudio19-dev: Required for PyAudio (microphone access)
# - ffmpeg: Audio format conversion for pydub
# - espeak: Text-to-speech backend for pyttsx3
# - alsa-utils: ALSA audio tools for device management
# - pulseaudio-utils: PulseAudio client for audio passthrough
# - tini: Proper init system for signal handling
RUN apt-get update && apt-get install -y --no-install-recommends \
    portaudio19-dev \
    ffmpeg \
    espeak \
    alsa-utils \
    pulseaudio-utils \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy Python dependencies first (layer caching optimization)
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Install voice-agent package in editable mode
# This creates the 'voice-agent' CLI command
RUN pip install --no-cache-dir -e .

# Create non-root user with audio group membership
# UID 1000 matches typical Linux user for easier volume permissions
RUN useradd -m -u 1000 -G audio voiceagent && \
    chown -R voiceagent:voiceagent /app

# Create directories for runtime data
RUN mkdir -p /app/logs /app/.cache/whisper && \
    chown -R voiceagent:voiceagent /app/logs /app/.cache/whisper

# Switch to non-root user for security
USER voiceagent

# Health check: Verify audio devices accessible
# Returns 0 if at least one audio device found, 1 otherwise
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import pyaudio; pa = pyaudio.PyAudio(); count = pa.get_device_count(); pa.terminate(); exit(0 if count > 0 else 1)" || exit 1

# Use tini as init system for proper signal handling
# This ensures SIGTERM/SIGINT are properly forwarded to the application
ENTRYPOINT ["tini", "--", "/app/docker/entrypoint.sh"]

# Default command: Run voice-agent with config from mounted volume
# Override with docker run ... voice-agent --help, etc.
CMD ["voice-agent", "--config", "/config/app_config.json"]
