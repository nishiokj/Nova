# Voice Agent System - Production Docker Image
# Single-container architecture with multi-process support
# Supports cross-platform development (Linux primary, macOS/Windows documented)

FROM python:3.11-slim

# Prevent Python from buffering stdout/stderr (better for container logs)
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_SYSTEM_PYTHON=1 \
    UV_COMPILE_BYTECODE=1

# Install system dependencies for audio processing
# Build dependencies (gcc, etc.) needed for compiling Python packages
# Runtime dependencies for audio
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Build tools (needed for PyAudio, webrtcvad compilation)
    gcc \
    g++ \
    make \
    python3-dev \
    # Audio libraries (runtime + development headers)
    portaudio19-dev \
    ffmpeg \
    espeak \
    alsa-utils \
    pulseaudio-utils \
    # Process management
    tini \
    # For downloading uv
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv - the fast Python package installer
# https://github.com/astral-sh/uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Set working directory
WORKDIR /app

# Copy Python dependencies first (layer caching optimization)
COPY requirements.txt .

# Install Python dependencies using uv (much faster than pip)
# Note: Build tools (gcc, g++, make, python3-dev) are needed for compilation
# We filter out macOS-specific packages (pyobjc*) that can't install on Linux
# This also removes indented comment lines that reference pyobjc
RUN grep -vE "^pyobjc|^    #   pyobjc" requirements.txt > requirements-docker.txt && \
    uv pip install --system -r requirements-docker.txt && \
    rm requirements-docker.txt

# Copy application code
COPY . .

# Install voice-agent package in editable mode without dependencies
# This creates the 'voice-agent' CLI command
# We use --no-deps because dependencies are already installed above (excluding macOS-only packages)
RUN uv pip install --system --no-deps -e .

# Optional: Remove build dependencies to reduce image size
# Uncomment if you want a smaller image (~200MB savings)
# RUN apt-get purge -y --auto-remove gcc g++ make python3-dev \
#     && rm -rf /var/lib/apt/lists/*

# Create non-root user with audio group membership
# UID 1000 matches typical Linux user for easier volume permissions
RUN useradd -m -u 1000 -G audio voiceagent && \
    chown -R voiceagent:voiceagent /app

# Create directories for runtime data
RUN mkdir -p /app/logs /app/.cache/whisper && \
    chown -R voiceagent:voiceagent /app/logs /app/.cache/whisper

# Switch to non-root user for security
USER voiceagent

# Health check: Verify audio devices accessible (unless running headless)
# Returns 0 if headless OR at least one audio device found, 1 otherwise.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os; headless=os.getenv('VOICE_AGENT_HEADLESS','').strip().lower() in {'1','true','yes','y','on'}; import pyaudio; pa=pyaudio.PyAudio(); count=pa.get_device_count(); pa.terminate(); exit(0 if headless or count>0 else 1)" || exit 1

# Use tini as init system for proper signal handling
# This ensures SIGTERM/SIGINT are properly forwarded to the application
ENTRYPOINT ["tini", "--", "/app/docker/entrypoint.sh"]

# Default command: Run voice-agent with config from mounted volume
# Override with docker run ... voice-agent --help, etc.
CMD ["voice-agent", "--config", "/config/app_config.json"]
