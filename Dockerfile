FROM python:3.9-slim

# Install system dependencies for audio processing on Raspberry Pi
RUN apt-get update && apt-get install -y \
    portaudio19-dev \
    python3-dev \
    gcc \
    g++ \
    libasound2-dev \
    alsa-utils \
    flac \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY audio.py .

# Create directory for logs
RUN mkdir -p /app/logs

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV AUDIO_LOG_LEVEL=INFO

# Expose audio devices to container
# This requires running with --device /dev/snd:/dev/snd or similar

# Default command
CMD ["python", "audio.py"]