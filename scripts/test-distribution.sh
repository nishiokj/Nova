#!/bin/bash
# Test script to verify working directory handling in distributed mode
#
# This simulates:
# 1. Starting daemon from one location
# 2. Running TUI from a different location
# 3. Verifying tools execute in TUI's directory, not daemon's

set -e

echo "=== Nova Distribution Test ==="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test directories
TEST_DIR_1="/tmp/nova-test-project-a"
TEST_DIR_2="/tmp/nova-test-project-b"
DAEMON_DIR="/tmp/nova-daemon-location"

# Cleanup and setup
echo "Setting up test directories..."
rm -rf "$TEST_DIR_1" "$TEST_DIR_2" "$DAEMON_DIR"
mkdir -p "$TEST_DIR_1" "$TEST_DIR_2" "$DAEMON_DIR"

# Create marker files in each test directory
echo "project-a-marker" > "$TEST_DIR_1/marker.txt"
echo "project-b-marker" > "$TEST_DIR_2/marker.txt"
echo "daemon-marker" > "$DAEMON_DIR/marker.txt"

echo -e "${GREEN}Created test directories:${NC}"
echo "  - Project A: $TEST_DIR_1"
echo "  - Project B: $TEST_DIR_2"
echo "  - Daemon:    $DAEMON_DIR"
echo ""

# Kill any existing daemon
echo "Stopping any existing daemon..."
pkill -f "nova-daemon" 2>/dev/null || true
pkill -f "harness-daemon" 2>/dev/null || true
sleep 1

# Start daemon from DAEMON_DIR (not either project directory)
echo "Starting daemon from $DAEMON_DIR..."
cd "$DAEMON_DIR"
nova-daemon &
DAEMON_PID=$!
sleep 2

# Verify daemon is running
if ! kill -0 $DAEMON_PID 2>/dev/null; then
    echo -e "${RED}Failed to start daemon${NC}"
    exit 1
fi
echo -e "${GREEN}Daemon started (PID: $DAEMON_PID)${NC}"
echo ""

# Test function
test_working_dir() {
    local project_dir="$1"
    local expected_marker="$2"

    echo "Testing from $project_dir..."
    cd "$project_dir"

    # The TUI should send working_dir: process.cwd() with each request
    # When tools execute, they should run in $project_dir, not $DAEMON_DIR
    echo "  Current directory: $(pwd)"
    echo "  Expected marker: $expected_marker"

    # In a real test, you'd run the TUI and execute a command like:
    # "read marker.txt" and verify it returns the correct marker
    echo ""
}

echo "=== Test Scenarios ==="
echo ""

test_working_dir "$TEST_DIR_1" "project-a-marker"
test_working_dir "$TEST_DIR_2" "project-b-marker"

echo "=== Summary ==="
echo ""
echo "The daemon is running from: $DAEMON_DIR"
echo "But TUI sessions should execute tools relative to their own cwd."
echo ""
echo "To manually test:"
echo "  1. Open terminal 1: cd $TEST_DIR_1 && nova"
echo "  2. Open terminal 2: cd $TEST_DIR_2 && nova"
echo "  3. In each TUI, run: Read marker.txt"
echo "  4. Verify each returns the correct marker for its directory"
echo ""

# Cleanup
echo "Stopping daemon..."
kill $DAEMON_PID 2>/dev/null || true

echo -e "${GREEN}Test setup complete!${NC}"
