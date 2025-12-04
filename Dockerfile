FROM python:3.11-slim

# Install system dependencies for audio processing with better ALSA support
RUN apt-get update && apt-get install -y \
    portaudio19-dev \
    python3-dev \
    gcc \
    g++ \
    libasound2-dev \
    libasound2-plugins \
    alsa-utils \
    pulseaudio \
    pulseaudio-utils \
    flac \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY audio.py .
COPY docker-startup.sh .
RUN chmod +x docker-startup.sh

# Create directory for logs
RUN mkdir -p /app/logs

# Create ALSA configuration for Docker
RUN echo "pcm.!default { type pulse }" > /etc/asound.conf && \
    echo "ctl.!default { type pulse }" >> /etc/asound.conf

# Create a dummy ALSA card configuration to prevent errors
RUN mkdir -p /usr/share/alsa/cards && \
    echo "# Dummy card configuration" > /usr/share/alsa/cards/aliases.conf

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV AUDIO_LOG_LEVEL=INFO
ENV PULSE_RUNTIME_PATH=/run/user/1000/pulse

# Expose audio devices to container
# This requires running with --device /dev/snd:/dev/snd or similar

# Default command
CMD ["./docker-startup.sh", "python", "audio.py"]