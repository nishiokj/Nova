#!/bin/bash

# Audio Processor Docker Container Start Script
# This script starts the audio-vad-processor Docker container with all necessary arguments

set -euo pipefail

# Configuration
CONTAINER_NAME="audio-vad-processor"
COMPOSE_FILE="docker-compose.yml"

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

# Check if Docker is running
check_docker() {
    if ! docker info >/dev/null 2>&1; then
        log_error "Docker is not running. Please start Docker and try again."
        exit 1
    fi
}

# Check if docker-compose file exists
check_compose_file() {
    if [ ! -f "$COMPOSE_FILE" ]; then
        log_error "docker-compose.yml not found in current directory"
        exit 1
    fi
}

# Check if container is already running
check_container_status() {
    if docker ps -q -f name="$CONTAINER_NAME" | grep -q .; then
        log_warning "Container '$CONTAINER_NAME' is already running"
        log_info "Use './stop-audio-processor.sh' to stop it first, or './restart-audio-processor.sh' to restart"
        
        # Show container status
        echo -e "\nCurrent container status:"
        docker ps -f name="$CONTAINER_NAME" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
        exit 0
    fi
}

# Check audio devices
check_audio_devices() {
    log_info "Checking audio devices..."
    
    if [ ! -d "/dev/snd" ]; then
        log_warning "No audio devices found at /dev/snd"
        log_info "Audio processing may not work properly"
    else
        log_info "Audio devices found:"
        ls -la /dev/snd/
    fi
}

# Create necessary directories
create_directories() {
    log_info "Creating necessary directories..."
    
    mkdir -p logs
    mkdir -p config
    
    # Ensure config file exists
    if [ ! -f "config/audio_config.json" ]; then
        log_info "Creating default audio configuration..."
        # Config is already present in the workspace
    fi
}

# Build and start the container
start_container() {
    log_info "Building and starting audio processor container..."
    
    # Build the image first
    log_info "Building Docker image..."
    docker-compose build
    
    # Start the container
    log_info "Starting container '$CONTAINER_NAME'..."
    docker-compose up -d
    
    # Wait a moment for container to initialize
    sleep 3
    
    # Check if container started successfully
    if docker ps -q -f name="$CONTAINER_NAME" | grep -q .; then
        log_success "Container '$CONTAINER_NAME' started successfully!"
        
        # Show container status
        echo -e "\nContainer status:"
        docker ps -f name="$CONTAINER_NAME" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
        
        # Show recent logs
        echo -e "\nRecent logs (last 20 lines):"
        docker logs "$CONTAINER_NAME" --tail 20
        
    else
        log_error "Failed to start container '$CONTAINER_NAME'"
        echo -e "\nContainer logs:"
        docker logs "$CONTAINER_NAME" 2>/dev/null || echo "No logs available"
        exit 1
    fi
}

# Show usage instructions
show_usage() {
    echo -e "\n${BLUE}Usage Instructions:${NC}"
    echo "  View live logs:     docker logs -f $CONTAINER_NAME"
    echo "  Stop container:     ./stop-audio-processor.sh"
    echo "  Restart container:  ./restart-audio-processor.sh"
    echo "  Container shell:    docker exec -it $CONTAINER_NAME /bin/bash"
    echo "  List audio devices: docker exec $CONTAINER_NAME python audio.py --list-devices"
}

# Main execution
main() {
    log_info "Starting Audio Processor Docker Container..."
    
    check_docker
    check_compose_file
    check_container_status
    check_audio_devices
    create_directories
    start_container
    show_usage
    
    log_success "Audio processor is now running!"
    echo -e "\nTo view live logs: ${GREEN}docker logs -f $CONTAINER_NAME${NC}"
}

# Execute main function
main "$@"