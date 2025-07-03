#!/bin/bash

# Audio Processor Docker Container Restart Script
# This script restarts the audio-vad-processor Docker container

set -euo pipefail

# Configuration
CONTAINER_NAME="audio-vad-processor"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Main execution
main() {
    log_info "Restarting Audio Processor Docker Container..."
    
    # Check if scripts exist
    if [ ! -f "./stop-audio-processor.sh" ] || [ ! -f "./start-audio-processor.sh" ]; then
        log_error "Required scripts not found. Please ensure stop-audio-processor.sh and start-audio-processor.sh exist."
        exit 1
    fi
    
    # Make scripts executable
    chmod +x ./stop-audio-processor.sh
    chmod +x ./start-audio-processor.sh
    
    # Stop the container
    log_info "Step 1: Stopping container..."
    ./stop-audio-processor.sh
    
    # Wait a moment between stop and start
    log_info "Waiting 3 seconds before restart..."
    sleep 3
    
    # Start the container
    log_info "Step 2: Starting container..."
    ./start-audio-processor.sh
    
    log_success "Audio processor restart completed!"
}

# Execute main function
main "$@"
