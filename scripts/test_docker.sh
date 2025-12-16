#!/bin/bash
# Docker Build and Validation Script for Voice Agent System

set -e  # Exit on error

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
IMAGE_NAME="voice-agent"
IMAGE_TAG="test"
FULL_IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"

echo "=================================================="
echo "Docker Build and Validation Script"
echo "=================================================="
echo ""

# Step 1: Build Docker image
echo -e "${YELLOW}[1/6] Building Docker image...${NC}"
if docker build -f Dockerfile -t "${FULL_IMAGE}" .; then
    echo -e "${GREEN}✓ Docker build successful${NC}"
else
    echo -e "${RED}✗ Docker build failed${NC}"
    exit 1
fi
echo ""

# Step 2: Test --version command
echo -e "${YELLOW}[2/6] Testing --version command...${NC}"
if docker run --rm "${FULL_IMAGE}" voice-agent --version; then
    echo -e "${GREEN}✓ Version command works${NC}"
else
    echo -e "${RED}✗ Version command failed${NC}"
    exit 1
fi
echo ""

# Step 3: Test --help command
echo -e "${YELLOW}[3/6] Testing --help command...${NC}"
if docker run --rm "${FULL_IMAGE}" voice-agent --help > /dev/null; then
    echo -e "${GREEN}✓ Help command works${NC}"
else
    echo -e "${RED}✗ Help command failed${NC}"
    exit 1
fi
echo ""

# Step 4: Test config validation
echo -e "${YELLOW}[4/6] Testing config validation...${NC}"
if docker run --rm \
    -v "$(pwd)/config:/config:ro" \
    "${FULL_IMAGE}" \
    voice-agent --validate-config --config /config/app_config.json; then
    echo -e "${GREEN}✓ Config validation works${NC}"
else
    echo -e "${RED}✗ Config validation failed${NC}"
    echo -e "${YELLOW}Note: This may fail if config has errors. Check manually.${NC}"
fi
echo ""

# Step 5: Test health check (may fail without audio devices)
echo -e "${YELLOW}[5/6] Testing health check...${NC}"
if docker run --rm "${FULL_IMAGE}" voice-agent --health-check; then
    echo -e "${GREEN}✓ Health check passed (audio devices available in container)${NC}"
else
    echo -e "${YELLOW}⚠ Health check failed (expected without --device /dev/snd)${NC}"
    echo -e "${YELLOW}  This is normal when testing without audio device passthrough${NC}"
fi
echo ""

# Step 6: Test image size and layers
echo -e "${YELLOW}[6/6] Checking image details...${NC}"
IMAGE_SIZE=$(docker images "${FULL_IMAGE}" --format "{{.Size}}")
echo "Image size: ${IMAGE_SIZE}"

# Check for common issues
echo ""
echo "Checking for common issues:"

# Check if tini is present (required for signal handling)
if docker run --rm "${FULL_IMAGE}" which tini > /dev/null 2>&1; then
    echo -e "${GREEN}✓ tini installed (signal handling)${NC}"
else
    echo -e "${RED}✗ tini not found${NC}"
fi

# Check if PyAudio can be imported
if docker run --rm "${FULL_IMAGE}" python -c "import pyaudio" 2>/dev/null; then
    echo -e "${GREEN}✓ PyAudio importable${NC}"
else
    echo -e "${RED}✗ PyAudio import failed${NC}"
fi

# Check if faster-whisper can be imported
if docker run --rm "${FULL_IMAGE}" python -c "import faster_whisper" 2>/dev/null; then
    echo -e "${GREEN}✓ faster-whisper importable${NC}"
else
    echo -e "${RED}✗ faster-whisper import failed${NC}"
fi

# Summary
echo ""
echo "=================================================="
echo -e "${GREEN}Docker validation complete!${NC}"
echo "=================================================="
echo ""
echo "Image built: ${FULL_IMAGE}"
echo "Image size: ${IMAGE_SIZE}"
echo ""
echo "Next steps:"
echo "  1. Test with audio devices:"
echo "     docker run -it --rm --device /dev/snd:/dev/snd ${FULL_IMAGE}"
echo ""
echo "  2. Run with docker-compose:"
echo "     docker-compose up voice-agent"
echo ""
echo "  3. Tag for deployment:"
echo "     docker tag ${FULL_IMAGE} ${IMAGE_NAME}:v0.1.0"
echo ""
