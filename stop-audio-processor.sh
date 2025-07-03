#!/bin/bash

# Audio Processor Docker Container Stop Script
# This script stops the audio-vad-processor Docker container gracefully

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

# Check if container is running
check_container_status() {
    if ! docker ps -q -f name="$CONTAINER_NAME" | grep -q .; then
        log_warning "Container '$CONTAINER_NAME' is not running"
        
        # Check if container exists but is stopped
        if docker ps -a -q -f name="$CONTAINER_NAME" | grep -q .; then
            log_info "Container exists but is already stopped"
            echo -e "\nContainer status:"
            docker ps -a -f name="$CONTAINER_NAME" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
        else
            log_info "Container '$CONTAINER_NAME' does not exist"
        fi
        exit 0
    fi
}

# Show final logs before stopping
show_final_logs() {
    log_info "Showing final logs (last 10 lines)..."
    docker logs "$CONTAINER_NAME" --tail 10 2>/dev/null || log_warning "Could not retrieve logs"
}

# Stop the container gracefully
stop_container() {
    log_info "Stopping audio processor container..."
    
    # Show logs before stopping
    show_final_logs
    
    # Stop using docker-compose (graceful shutdown)
    log_info "Sending graceful shutdown signal..."
    docker-compose down
    
    # Wait a moment for graceful shutdown
    sleep 2
    
    # Check if container stopped
    if ! docker ps -q -f name="$CONTAINER_NAME" | grep -q .; then
        log_success "Container '$CONTAINER_NAME' stopped successfully!"
    else
        log_warning "Container did not stop gracefully, forcing shutdown..."
        docker kill "$CONTAINER_NAME" 2>/dev/null || true
        docker rm "$CONTAINER_NAME" 2>/dev/null || true
        
        if ! docker ps -q -f name="$CONTAINER_NAME" | grep -q .; then
            log_success "Container '$CONTAINER_NAME' forcefully stopped!"
        else
            log_error "Failed to stop container '$CONTAINER_NAME'"
            exit 1
        fi
    fi
}

# Clean up resources (optional)
cleanup_resources() {
    log_info "Cleaning up resources..."
    
    # Remove stopped containers (optional)
    if [ "${1:-}" = "--cleanup" ]; then
        log_info "Removing stopped containers..."
        docker container prune -f >/dev/null 2>&1 || true
        
        log_info "Removing unused networks..."
        docker network prune -f >/dev/null 2>&1 || true
        
        log_success "Cleanup completed!"
    fi
}

# Show usage instructions
show_usage() {
    echo -e "\n${BLUE}Usage Instructions:${NC}"
    echo "  Start container:    ./start-audio-processor.sh"
    echo "  Restart container:  ./restart-audio-processor.sh"
    echo "  View logs:          docker logs $CONTAINER_NAME"
    echo "  Remove container:   docker rm $CONTAINER_NAME"
    echo "  Full cleanup:       ./stop-audio-processor.sh --cleanup"
}

# Main execution
main() {
    log_info "Stopping Audio Processor Docker Container..."
    
    check_docker
    check_compose_file
    check_container_status
    stop_container
    cleanup_resources "$@"
    show_usage
    
    log_success "Audio processor has been stopped!"
}

# Execute main function
main "$@"