#!/bin/bash

# Docker startup script for audio processing with macOS host compatibility

set -e

echo "Starting audio processor with Docker compatibility..."

# Check if we're in a Docker environment
if [ -f "/.dockerenv" ]; then
    echo "Detected Docker environment"
    
    # Create dummy audio device directories if they don't exist
    if [ ! -d "/dev/snd" ]; then
        echo "Creating dummy /dev/snd directory..."
        mkdir -p /dev/snd
        # Create dummy audio device files
        touch /dev/snd/controlC0
        touch /dev/snd/pcmC0D0p
        touch /dev/snd/pcmC0D0c
        chmod 666 /dev/snd/*
    fi
    
    # Check available audio devices
    echo "Checking for available audio devices..."
    ls -la /dev/snd/ || echo "No /dev/snd directory found"
    
    # Try to list ALSA cards
    echo "Checking ALSA cards..."
    cat /proc/asound/cards 2>/dev/null || echo "No ALSA cards found in /proc/asound/cards"
    
    # Try to list audio devices with arecord
    echo "Checking audio recording devices..."
    arecord -l 2>/dev/null || echo "No recording devices found with arecord"
    
    # Set up minimal ALSA configuration
    echo "Setting up ALSA configuration..."
    cat > /etc/asound.conf << EOF
# Minimal ALSA configuration for Docker
pcm.!default {
    type null
}
ctl.!default {
    type null
}
EOF

    # Set environment variables for audio
    export ALSA_PCM_CARD=0
    export ALSA_PCM_DEVICE=0
    export PULSE_RUNTIME_PATH=/run/user/1000/pulse
    
    echo "Audio environment setup complete"
else
    echo "Not in Docker environment, skipping Docker-specific setup"
fi

# Start the audio processor
echo "Starting audio processor..."
exec "$@"